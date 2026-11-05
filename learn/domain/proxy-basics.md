---
title: 代理的形态与 CONNECT 隧道
description: 从请求行与 CONNECT 报文出发，解释 Whistle 四类入口与端口配置的由来。
---

代理工具的所有魔法，起点都是「客户端把请求发给了谁」。本节先区分正向、反向与隧道三种形态，讲清绝对 URI 请求行与 CONNECT 的语义差异，再对照 Whistle 的四个事件入口和端口配置。读完你能判断任意一条流量该落进 `request` 还是 `connect`，也知道 `sockets=256` 究竟限制的是什么。

::: tip 先修知识
了解 HTTP/1.1 报文结构（请求行、头部、实体）、TCP 连接与端口的基本概念。不需要读过 Whistle 源码，但知道 `http.createServer` 会触发哪些事件会更好。
:::

## 三种代理形态

三者最容易混淆的地方，是「代理替谁做事」。正向代理代表客户端去访问任意源站，客户端必须显式配置；反向代理代表源站接收请求，客户端以为自己就在访问真实站点；隧道代理则既不解析也不改写应用协议，只把一条 TCP 字节流从一个端点搬到另一个端点。

### 请求行为何有两种写法

普通直连时请求行是 origin-form：`GET /path HTTP/1.1`，主机信息放在 `Host` 头里。走 HTTP 正向代理时，请求行必须是绝对 URI：`GET http://example.com/path HTTP/1.1`。为什么？因为代理在同一条连接上可能服务于任意域名，只有把完整 URL 写进请求行，它才知道该把请求转发给谁；`Host` 头此时只是辅助，且可能被改写。

这个差异直接决定了实现：Whistle 收到 `request` 事件时，拿到的是已经带完整目标信息的请求，因此可以在中间件链里解析规则、改写头部和 body；而 CONNECT 请求行里只有 `host:port`，没有任何路径与方法可供改写。

### CONNECT 建立的是隧道，不是请求

HTTPS 流量不能沿用上面的转发方式：代理若想读明文，就必须先让客户端相信自己就是源站。客户端的做法是先发 `CONNECT example.com:443 HTTP/1.1`，请代理开一条到目标的 TCP 通路；代理回 `HTTP/1.1 200 Connection Established` 之后，这连接的语义就变了——后续字节不再由代理按 HTTP 解析，而是原样双向透传，客户端在这条隧道里跑 TLS 握手。

Whistle 把这个应答抽成了常量：`lib/util/index.js:369-375` 的 `ESTABLISHED_CTN` 与 `util.setEstablished(socket)`。注意「200」在这里不是业务成功码，而是「隧道已就绪」的开关；一旦发出，代理就退化为管道。也正因如此，纯透传模式下 Whistle 看不到 HTTPS 里的任何内容，抓 HTTPS 必须走后一篇要讲的中间人解密。

### SOCKS、PAC 与系统代理各管一段

SOCKS 工作在更低的层次：它协商的是目标地址与端口，不关心上层是 HTTP 还是别的东西，也不使用 HTTP 请求行。PAC 是一段决定「哪些流量走哪个代理」的 JavaScript，属于客户端的选路策略；系统代理则是操作系统级的全局开关。三者常一起出现，但职责完全不同：PAC / 系统代理决定流量去哪，SOCKS 或 HTTP 代理决定流量怎么被搬运。

![三种代理形态下的请求行与数据流向](/diagrams/proxy-modes.svg)
*图注：正向代理改写请求行并解析 HTTP，隧道代理只透传字节，反向代理对客户端隐藏源站。*

## Whistle 的四类入口

内核只创建一个 `http.Server`，却要同时接住普通请求、CONNECT、WebSocket 升级和畸形报文，办法就是把 Node.js 的四个事件分别挂到不同子系统（`lib/index.js:36-61`）：

```js
// lib/index.js:37-60
var app = express();
var server = _server || http.createServer();
var proxyEvents = new EventEmitter();
// ... middlewares 装配略 ...
server.on('clientError', handleClientError);   // 畸形报文
setupHttps(server, proxyEvents);               // HTTPS 子系统
tunnelProxy(server, proxyEvents);              // CONNECT
upgradeProxy(server);                         // Upgrade
initDataServer(proxyEvents);                  // 抓包缓存
```

### request 与 clientError

`request` 事件并不是在这里直接挂的，而是等 Web 子系统就绪后才注册：`lib/index.js:208-211` 中 `require('../biz/init')(proxyEvents, function () { server.on('request', app); ... })`。为什么延后？因为界面路由、插件 UI 需要先初始化，否则请求可能在规则与插件尚未就绪时就进来。`clientError` 则由 `lib/index.js:24-34` 的 `handleClientError` 统一回 400 或 431，避免头部溢出把进程带崩。

### connect 与 upgrade

CONNECT 由 `lib/tunnel.js:44` 的 `server.on('connect', ...)` 接手，这里是判定「透传还是解密」的总闸门。Upgrade 由 `lib/upgrade.js:179-181` 挂到 `server.on('upgrade')`，进入 `lib/upgrade.js:77-177` 的 `upgradeHandler`，把 WebSocket 交给连接管理器。四个事件共用同一个端口，是 Whistle 只需一个 `port` 就能同时服务 HTTP、HTTPS 与 WebSocket 的根本原因。

### SOCKS 如何复用主端口

SOCKS 并没有另写一套转发逻辑。`lib/index.js:151-207` 创建 socks server，每接受一个连接就向主端口发一个内部 CONNECT，再把两条 socket 对接：

```js
// lib/index.js:166-173
var client = http.request({
  method: 'CONNECT',
  agent: false,
  path: connPath,
  host: boundHost,
  port: config.port,
  headers: headers
});
```

`lib/index.js:182-193` 在 `connect` 事件里确认响应为 200（非 200 立即销毁），再用 `reqSock.pipe(socket).pipe(reqSock)` 完成双向转发。这个设计很值得记住：SOCKS、HTTP 代理、反向代理最终都汇流到同一条 CONNECT 处理链，差异只在「谁来写这第一个 CONNECT」。

## 端口与配置项

默认值来自 `package.json:4-9`，运行时由 `lib/config.js` 解析：

| 配置项 | 默认值 | 含义 | 源码位置 |
|---|---|---|---|
| `port` | `8899` | 主监听端口 | `lib/index.js:90-95` |
| `sockets` | `256` | 每域名 `maxSockets` 上限 | `lib/config.js:1035-1048` |
| `timeout` | `360000` | server 空闲超时（毫秒） | `lib/index.js:44-45` |
| `uiport` | 同 `port` | Web UI 端口 | `lib/config.js:495,955` |
| `httpPort` | 关闭 | 独立明文入口 | `lib/config.js:676-679` |
| `httpsPort` | 关闭 | 独立 TLS 入口 | `lib/config.js:681-684` |
| `socksPort` | 关闭 | SOCKS 入口 | `lib/config.js:671-674` |

最容易读错的是 `sockets`：它不是监听数量，也不是并发总量，而是交给 `http.Agent` 的 `maxSockets`，即**对每个目标域名**可复用的连接池上限（`lib/config.js:1039-1048`）。把它调大是为了减少高并发出站时的排队，与监听端口无关。`httpPort` / `httpsPort` 则是给「客户端只能说纯 HTTP 或纯 TLS」的场景用的额外入口，最终仍通过 `lib/index.js:96-123` 的 `createNormalServer` 回调到同一个 `app`。

## 上游代理与链式 CONNECT

企业网络里常有「必须经上级代理才能出网」的限制，Whistle 支持把自己挂到上游代理之后。`lib/config.js:169-203` 的 `getHttpsAgent` 用 `hagent` 的 `httpsOverHttp` / `httpOverHttp` agent（`lib/config.js:12`、`lib/config.js:191-196`）把出站请求包进上级代理的隧道；`lib/config.js:184-190` 把 `proxyHost`、`proxyPort` 等参数交给这个 agent。

更复杂的是二级 CONNECT：`lib/util/patch.js:100-159` 改写 `http.request`，当存在 `proxyTunnelPath` 时，先与上级代理完成一次 CONNECT 拿到 200，再在这条隧道里手写第二个 CONNECT 报文发给 Whistle 主端口（第 137 行 `common.getHttpMeta('CONNECT', tunnelPath, ...)`），必要时带上 `x-whistle-policy: intercept`（`lib/util/patch.js:133-136`）。为什么要两级？因为外层隧道只能保证「连得到 Whistle」，内层 CONNECT 才是让 Whistle 继续做解密与规则匹配的入口。

## 小结

- 正向代理用绝对 URI 请求行，反向代理隐藏源站，隧道代理只搬字节。
- CONNECT 的 200 是隧道就绪信号，之后代理不再解析应用协议。
- 一个 `http.Server` 挂 `request` / `connect` / `upgrade` / `clientError` 四类入口。
- SOCKS 被转换成对主端口的内部 CONNECT，复用同一条隧道链。
- `sockets=256` 是每域名连接池上限，不是监听数；上游与链式代理靠两级 CONNECT 实现。

## 下一步

[《HTTPS、证书链与中间人》](/domain/tls-mitm)：既然 CONNECT 默认看不到明文，Whistle 又是如何在装了根证书之后把 HTTPS 拆成两段 TLS 的。
