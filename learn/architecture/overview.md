---
title: 一张图看懂全局架构
description: 以全局图为主干，串起四类入口、中间件链、事件总线、进程模型与存储。
---

# 一张图看懂全局架构

前三篇分别解释了代理形态、TLS 中间人和协议流量，这些模型在代码里并不是三个独立系统，而是同一条主干上的不同切面。本节用一张图把「四类入口 → 中间件链 → 规则/改写/抓包 → 出站 → 事件总线 → 进程与存储」串起来，并给出精确到文件与行号的坐标。读完你应当能拿着这张图，独立定位任何一次请求经过的模块。

::: tip 先修知识
已完成第一层三篇，理解 `request` / `connect` / `upgrade` 的分工与 CONNECT 解密的前提；熟悉 Express 的 `app.use` 中间件模型会更轻松。
:::

![Whistle 全局架构主干](/diagrams/overview.svg)
*图注：四类入口汇入同一条中间件链，规则与抓包挂在事件总线上，出站后由独立进程与本地目录承载。*

## 一张图上的主干

图的左侧是**四类入口**：`request`（普通 HTTP 与解密后的 HTTPS）、`connect`（CONNECT 隧道）、`upgrade`（WebSocket）、`clientError`（畸形报文），全部挂在同一个 `http.Server` 上（`lib/index.js:36-61`）。为什么坚持单端口多事件？因为对客户端来说只有一个代理地址，配置 PAC 或系统代理时不必区分协议类型。

中部是**中间件链**：所有入口最终都被归一化成 Express 的 `req` / `res`，依次经过初始化、Web 界面路由、规则匹配、请求改写、数据采集、响应改写，最后交给 handlers 出站。右侧是**规则/改写/抓包**这组横切能力，它们不自己收发请求，而是通过事件总线订阅链路上的数据。最外层则是**进程与存储**：后台服务、插件、weinre 跑在独立子进程里，规则、值、属性与证书落在本地数据目录。

一句话概括这张图：Whistle 把「协议差异」消化在入口层，把「业务差异」消化在中间件链，把「可观测性」外挂到事件总线。三层解耦之后，新增一种协议通常只需补一个入口，新增一种调试能力通常只需挂一个监听器。

## 中间件链的精确顺序

顺序写在 `lib/index.js:40-52`，是理解全站最关键的一段代码：

```js
// lib/index.js:39-52
var proxyEvents = new EventEmitter();
var middlewares = ['./init', '../biz']
  .concat(require('./inspectors'))
  .concat(config.middlewares)
  .concat(require('./handlers'));
server.timeout = config.timeout;
server.requestTimeout = 0;
// ...
middlewares.forEach(function (mw) {
  mw && app.use((typeof mw == 'string' ? require(mw) : mw).bind(proxyEvents));
});
```

展开后依次是：`lib/init.js` → `biz/index.js` → inspectors（`rules` → `req` → `data` → `res`，见 `lib/inspectors/index.js:1-8`）→ `config.middlewares`（用户自定义）→ handlers（`file-proxy` → `http-proxy` → `error-handler`，见 `lib/handlers/index.js:1-7`）。每一个都用 `app.use(mw.bind(proxyEvents))` 注册，也就是说**所有中间件的 `this` 都指向同一个事件总线**。

为什么是这个顺序？`lib/init.js` 必须先给 `req` / `res` 挂上 Transform 能力（`lib/init.js:87-155`），后面的改写才有支点；`biz/index.js` 要抢在规则之前识别 Web UI 与插件界面请求，避免管理流量被用户规则误伤；inspectors 按「先定规则、再改请求、再采数据、最后改响应」推进，符合一次请求的生命周期；handlers 放在末尾，因为它是真正的出站动作，`error-handler` 兜底所有未被处理的异常。

各阶段的分工也值得记住：`lib/inspectors/rules.js` 负责解析并应用规则与编解码，中间两阶段处理请求与响应的具体内容，`lib/inspectors/data.js` 负责抓包缓冲；出站的 `lib/handlers/http-proxy.js` 发起到源站的请求，`lib/handlers/file-proxy.js` 处理本地文件与协议映射。

## 事件总线与抓包数据

`lib/index.js:39` 的 `proxyEvents = new EventEmitter()` 是内核总线。它有两个作用：一是作为 `this` 注入每个中间件，让分散的模块能互相发事件而不必互相 require；二是通过 `lib/index.js:215-241` 的 `exportInterfaces` 对外暴露 `rules`、`util`、`rulesUtil`、`httpsUtil`、`pluginMgr`、`logger`、`socketMgr`、`setAuth`、`setShadowRules` 等接口，插件与 Web 界面由此获得内核能力。

抓包就是这套机制的典型用法。链路各处把结构化数据 `proxy.emit('request', ...)`（`lib/tunnel.js:124,343`、`lib/https/index.js:254`）或 `proxy.emit('frame', ...)`（`lib/socket-mgr.js:44,118`）抛到总线上，`lib/util/data-server.js:87-95` 的 `enable()` 只做一件事：监听 `request` 与 `frame`，写入缓存并定时清理。为什么不让 inspectors 直接写界面？因为抓包数据既要给 Web UI，也要给插件和日志，事件广播比逐处回调更松耦合。

界面取数据用的是短轮询而非 WebSocket：`biz/webui/htdocs/src/js/data-center.js:88,446` 把地址拼成 `cgi-bin/get-data`，`biz/webui/htdocs/src/js/data-center.js:1157-1159` 依据 `hasNew` 决定下一次是 100 ms 还是 900 ms 再拉。有新数据就加快、空闲就放慢，这是在实时性与请求量之间取的折中。

## 进程三层与存储

进程模型分三层，理解它能避免把「启动」和「运行」混为一谈：

1. **CLI 进程**：`w2 start` 等命令由 `bin/whistle.js:3` 引入的 `starting` 托管，负责参数解析、状态查询与把业务进程转入后台。
2. **detached 业务进程**：真正运行 `index.js:1` / `lib/index.js:36` 的常驻进程，监听主端口；CLI 退出后它仍在。
3. **pfork 子进程**：后台服务、每个插件、weinre 各自独立，分别见 `lib/service/index.js:1,10`、`lib/plugins/index.js:2`、`biz/weinre/index.js:1`。为什么要隔离？插件是第三方代码，崩溃或内存泄漏不该带走代理主进程。

`--cluster` 是另一条正交的线：只有显式传入时，`index.js:200-211` 才用 `cluster.fork` 起多个 worker 分担端口（`bin/whistle.js:178` 定义该选项）。它解决的是多核利用，与 pfork 的「功能隔离」不是一回事，默认并不启用。

存储统一落在 `~/.WhistleAppData/.whistle/`：`lib/util/common.js:598-603` 给出默认根目录 `~/.WhistleAppData`，`lib/config.js:1068-1069` 拼上 `dataDirname`（`package.json:5` 中为 `.whistle`）。其下 `rules`、`values`、`properties` 由 `lib/config.js:148-150` 定义，`certs` 由 `lib/https/ca.js:19` 创建并存放根 CA 与叶证书。规则、值、属性、证书分别对应「配置」「素材」「开关」「信任」，拆开存放也便于备份与迁移。

## 读源码时该从哪个文件切入

带着问题找入口，比按目录顺序翻要快得多：

::: cols 22|28|28|22
| 想弄清什么 | 切入文件 | 关键锚点 | 顺延到 |
|---|---|---|---|
| 服务怎么起来 | `index.js` | `cluster.fork` | `lib/config.js` |
| 四类入口在哪 | `lib/index.js` | `server.on(...)` | `lib/tunnel.js` |
| 请求被谁加工 | `lib/index.js` | `middlewares` | `lib/inspectors/` |
| 规则如何生效 | `lib/inspectors/rules.js` | `getDecoder` | `lib/rules/` |
| 出站怎么发 | `lib/handlers/http-proxy.js` | `req.request` | `lib/util/` |
| 抓包数据在哪 | `lib/util/data-server.js` | `proxy.on('request')` | `data-center.js` |
| HTTPS 怎么拆 | `lib/https/index.js` | `readOneChunk` | `lib/https/ca.js` |
:::

## 小结

- 四类入口共用单端口，经归一化后汇入同一条 Express 中间件链。
- 链序为 `lib/init.js` → `biz/index.js` → inspectors 四阶段 → 自定义中间件 → handlers 三类，全部 `bind(proxyEvents)`。
- `proxyEvents` 是内核总线，`exportInterfaces` 把它包装成对插件与界面可用的接口。
- 抓包靠 `request` / `frame` 事件广播与 `cgi-bin/get-data` 的 100/900 ms 短轮询。
- 进程分 CLI、detached 业务进程、pfork 子进程三层，`--cluster` 才启用多 worker。

## 下一步

[《从 w2 start 到端口监听》](/architecture/startup)：沿着启动时序，把本节图中的每个方框落到真实的初始化代码上。
