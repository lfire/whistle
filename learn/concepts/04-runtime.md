---
title: 第三层：Node 运行时与内核骨架
description: 把四类事件、Express 中间件、Stream 与 pipe、事件总线、进程模型与配置单例拆成对照源码的词典式词条。
---

# 第三层：Node 运行时与内核骨架

本层是「概念精解」的运行时篇，前置是 [第二层：TLS、证书与信任](/concepts/03-tls) 交付的那份解密后明文。这里把 Whistle 赖以运转的 Node 术语——`http.Server` 的四类事件、Express 中间件、Stream 与 `pipe`、事件总线、cluster 与 pfork、单例配置——逐个拆成可对照源码的卡片。读完你能说清「为什么 `lib/init.js` 不是启动文件」、`sockets=256` 到底限的是什么，也能把 [一张图看懂全局架构](/architecture/overview) 与 [一次 HTTP 代理请求的旅程](/core/http-request) 的名词全部对上号。

## 本层概念地图

这些词同样是一条装配链：先有 `http.Server` 把连接收进来，Express 中间件把请求塑形成 `req`/`res`，Stream 与 `pipe` 负责搬运字节，事件总线把各子系统挂到同一处，最后 cluster、pfork 与配置单例决定进程形态与状态归属。按这个顺序读，比按文件名猜职责稳得多。

::: cols 20|40|40
| 层次 | 词条群 | 主要源码落点 |
|---|---|---|
| 入口 | 四类事件、Express、socket | `index.js:36` |
| 请求塑形 | `req`/`res`、EventEmitter | `init.js:157` |
| 数据搬运 | Stream、Transform、pipe | `socket-mgr.js:773` |
| 装配与扩展 | 事件总线、hook | `config.js:85` |
| 缓存与推送 | LRU、有界缓存、短轮询 | `util/data-server.js:21` |
| 进程与状态 | cluster、pfork、单例配置 | `index.js:99` |
:::

表中落点是各层的粗略锚点，逐词的真实行号见下方卡片。想按启动顺序反查，可配合 [从 w2 start 到端口监听](/architecture/startup) 与 [进程模型与配置系统](/architecture/process-config)；想只查缩写含义，可跳到 [术语速查](/advanced/reference) 或 [概念索引](/concepts/index)。

## 一、入口与请求骨架

### http.Server 的四类事件（request / connect / upgrade / clientError）
> Node HTTP server 上标志四种连接形态的四类入口事件。

**打个比方**：像一栋大楼开四个门：普通访客走正门（request），要专线的走车道（connect），要换协议的走升降梯（upgrade），证件填错的被请到旁边的纠错窗（clientError）。四个门后面其实是同一套后台。

**在 Whistle 里**：`lib/index.js:208-211` 把 `request` 交给 Express app，`lib/index.js:59-60` 的 `tunnelProxy` / `upgradeProxy` 分别挂 `connect` 与 `upgrade`，`lib/index.js:53` 挂 `clientError`；四类事件共同汇聚到 `lib/https/index.js:1151` 的 socket 首包处理。

```js
// lib/index.js:24-34
function handleClientError(err, socket) {
  if (!socket.writable) {
    return socket.destroy(err);
  }
  var errCode = err && err.code;
  var statusCode = errCode === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
  var stack = util.getErrorStack(
    'clientError: Bad request' + (errCode ? ' (' + errCode + ')' : '')
  );
  socket.end('HTTP/1.1 ' + statusCode + ' Bad Request\r\n\r\n' + stack);
}
```

**为什么这样设计**：HTTP、CONNECT 隧道、WebSocket 升级、畸形报文本来就是四种不同形态，分事件挂接最贴近 Node 原生模型；代价是同一请求可能从多个入口进入，必须归一成统一的规则上下文。

**容易混淆**：`request` 不等于「所有请求」，HTTPS 解密后的明文是 `lib/https/index.js:1105` 再次 `emit('request')` 送回来的，见 [一次 HTTP 代理请求的旅程](/core/http-request)。

**工程中的样子**：`HPE_HEADER_OVERFLOW` 回 431、其余回 400，是排查畸形请求的第一站，见 [能力边界、风险与合规](/scenarios/boundaries)。

### Express app 与中间件（Express / Middleware）
> 用一串按顺序执行的函数处理请求的应用框架与处理单元。

**打个比方**：像一条装配流水线，每个工位只做一件事——登记、贴标签、改内容、发运——零件依次流过，谁都不必知道整条线怎么搭。加功能就是在线上插一个新工位。

**在 Whistle 里**：`lib/index.js:37` 建 `express()`，`lib/index.js:40-43` 拼出 `['./init', '../biz'] + inspectors + config.middlewares + handlers` 的链，`lib/index.js:50-51` 逐个 `bind(proxyEvents)` 后 `app.use`；顺序由 `lib/inspectors/index.js:1-7`（rules/req/data/res）与 `lib/handlers/index.js:1-7`（file-proxy/http-proxy/error-handler）给定。

**为什么这样设计**：把「解析规则 → 改写请求 → 采集数据 → 出站分发」固化成有序阶段，新增能力只改数组，不动内核；代价是顺序即语义，插错位置会改变规则命中结果。

**容易混淆**：中间件不等于插件 hook，前者在 Express 链内、后者是插件子进程的扩展点，见 [指令体系与分发链路](/modules/protocol-catalog)。

**工程中的样子**：`config.middlewares` 可从启动选项注入自定义中间件，见 [一次 HTTP 代理请求的旅程](/core/http-request)。

### req/res 对象（IncomingMessage / ServerResponse）
> 每次请求封装入站可读流与出站可写流的一对对象。

**打个比方**：像随货同行的两张流转单，一张记录「从哪来、写了什么」（req），一张记录「往哪去、回什么」（res）。各工位在这两张单上补字段，最后按 res 单发货。

**在 Whistle 里**：`lib/init.js:159-160` 用 `PipeStream.wrapSrc(req)` / `wrapDest(res)` 给原生对象套上可插拔管道，`lib/init.js:235-260` 定义 `res.response(_res)` 把源站响应写成最终响应，`lib/init.js:87-155` 再挂上文本与解压变换。

**为什么这样设计**：把原生对象包装成统一抽象，后面所有 inspector 只面对同一组字段与方法，不必关心请求是从明文 HTTP 还是解密后的 HTTPS 来的；代价是包装层增加了理解成本。

**容易混淆**：包装后的 `req` 不完全等同于原生 `IncomingMessage`，它多了 `addTextTransform`、`src` 等自定义方法，详见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：`res.response` 是规则改写响应体的最终出口，见 [一次 HTTP 代理请求的旅程](/core/http-request)。

### socket（net.Socket）
> 一条 TCP 连接在 Node 里的端点对象，承载原始字节。

**打个比方**：像一根接通的电话线，两端谁说话、说哪种语言，线本身都不管；它只负责把比特从这头搬到那头。上层再决定这根线跑 HTTP、TLS 还是 WebSocket。

**在 Whistle 里**：`lib/https/index.js:1151` 的入口直接收 `socket` 并读首包，`lib/tunnel.js:248-301` 先回 `200 Connection Established` 再嗅探，`lib/socket-mgr.js:773` 用 `req.pipe(res).pipe(req)` 把两条流对接成透明通道。

**为什么这样设计**：四类事件最终都落到字节层，代理的核心工作就是「读一段、判形态、再接回去」；代价是必须自己处理首包回退、错误销毁与半关闭。

**容易混淆**：socket 不是 HTTP 请求，一条 keep-alive socket 上可以跑很多个请求，见 [隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。

**工程中的样子**：`disable://capture` 让流量退回纯 socket 透传，见 [CONNECT 判定与 TLS 解密](/core/connect-mitm)。

### EventEmitter（事件发射器）
> Node 里「触发事件—订阅回调」的标准发布订阅基类。

**打个比方**：像楼道公告板，谁有事就贴一张告示（emit），关心这件事的人早留了联系方式（on），彼此不用认识，也不必互相等待。

**在 Whistle 里**：`lib/index.js:39` 用 `new EventEmitter()` 建出全局总线 `proxyEvents`，`lib/index.js:85-86` 用 `process.emit('whistleStarted', proxyEvents)` 广播启动完成，测试侧则以 `proxy.on('_request', ...)` 订阅请求事件。

**为什么这样设计**：让规则、插件、UI、统计等模块在互不 import 的情况下协同，装配时只需把总线传下去；代价是事件名散落各处，排查要靠检索而非类型检查。

**容易混淆**：EventEmitter 是「机制」，`proxyEvents` 是用它建出来的「那一个实例」，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：用 `proxy.on('tunnelRequest', cb)` 订阅隧道事件做回归断言，见 [CI、嵌入式集成与自动化回归](/scenarios/automation)。

### proxyEvents 事件总线（Proxy Event Bus）
> 进程内唯一的 EventEmitter，挂载各子系统并对外导出接口。

**打个比方**：像整栋楼的总机接线台，消防、供水、门禁都插在同一块板上，接线员（导出函数）把外部来电转给对应部门，部门之间也能通过它互相喊话。

**在 Whistle 里**：`lib/index.js:39` 创建，`:46-47` 挂上 `config` 与 `server`，`:54-61` 把插件、性能、socket 管理、HTTPS、导出接口、隧道、Upgrade、数据服务逐一 `set`/初始化，`:215-241` 的 `exportInterfaces` 再挂出 `rulesUtil`、`setShadowRules`、`setUIHost` 等。

**为什么这样设计**：一处装配、处处可达，嵌入式调用方拿到的回调参数就是这块总线，不必再全局查找；代价是它天然是单例，cluster 下每个 worker 各有自己一块。

**容易混淆**：它不是每条请求各自新建的 `reqEmitter`，后者是请求级、随请求销毁，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：`require('whistle')` 回调里的 `proxy` 就是它，见 [一张图看懂全局架构](/architecture/overview)。

### hook（Plugin Hook / 插件钩子）
> 插件在请求、响应、隧道各阶段可插入的命名扩展点。

**打个比方**：像流水线旁预留的外挂工位，平时空着，第三方带设备来就能接上，做质检或加工，不必改动主线的任何工位。

**在 Whistle 里**：`lib/config.js:85-108` 定义 `PLUGIN_HOOKS`，SNI、AUTH、HTTP、TUNNEL、REQ_READ、RES_WRITE 等二十余个名字都带 `uid` 后缀；插件经 `lib/plugins/index.js:620-670` 的 `p.fork` 在独立子进程里响应这些名字。

**为什么这样设计**：把第三方代码挡在内核之外，插件崩溃不拖垮代理；代价是跨进程通信与内部头传递带来额外复杂度。

**容易混淆**：hook 不是 Express 中间件，它走插件子进程与内部头，不在同一条链上，见 [插件系统](/modules/plugins)。

**工程中的样子**：`--no-global-plugins` 可在 CI 里把不确定的第三方 hook 全部挡掉，见 [CI、嵌入式集成与自动化回归](/scenarios/automation)。

## 二、流、缓冲与缓存

### Stream：Readable 与 Writable（可读流 / 可写流）
> Node 把数据当作连续流动的块来处理的两类抽象端点。

**打个比方**：像接在两端的两根水管，一根只出水（Readable），一根只进水（Writable）。你不必等整池水放完才开工，来一段处理一段。

**在 Whistle 里**：`req` 是可读流、`res` 是可写流，`lib/init.js:159-160` 对二者做包装，`lib/https/index.js:1191` 用 `reqSocket.pipe(socket).pipe(reqSocket)` 把两条流首尾相接。

**为什么这样设计**：请求体可能很大、也可能边收边发，流式处理让内存占用与报文大小解耦；代价是必须正确处理 `error`、`end`、`close`，否则容易泄漏连接。

**容易混淆**：Stream 不等于 Buffer，前者是「不断到来的序列」，后者是「一块已到手的字节」，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：大响应体流式回传不落盘，见 [抓包数据的采集与上报](/core/capture-data)。

### Transform（转换流 / Duplex）
> 既能读又能写、可在中途改写数据的流。

**打个比方**：像串在水管中间的过滤器，水从一头进、另一头出，顺手把杂质滤掉或做个记号，外形还是一根管子，接入方式不变。

**在 Whistle 里**：`lib/socket-mgr.js:776-777` 用 `util.createTransform()` 建 `reqTrans` / `resTrans`，`:838-843` 把请求与响应各串一条带 Transform 的链；`lib/init.js:90-143` 的 `addTextTransform` / `addZipTransform` 是它的可插拔用法。

```js
// lib/socket-mgr.js:838-843
pipeStream(req, reqRead)
.pipe(reqTrans)
.pipe(pipeStream(reqWrite, res, true));
pipeStream(res, resRead)
.pipe(resTrans)
.pipe(pipeStream(resWrite, req, true));
```

**为什么这样设计**：抓包要「看一遍」、改写要「改一遍」，两者都要在字节经过时介入又不能截断流，Transform 正好；代价是每多一层就多一次拷贝与延迟。

**容易混淆**：Transform 不是普通 `pipe`，它会在数据经过时执行回调，见 [隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。

**工程中的样子**：`resWrite`/`reqWrite` 阶段的帧抓取就挂在这两条链上，见 [抓包数据的采集与上报](/core/capture-data)。

### pipe 与背压（Pipe / Backpressure）
> 把可读流接到可写流、并据消费能力自动调节流速的机制。

**打个比方**：像用一台带浮球阀的水泵抽水，水箱满了阀就关小、泵就慢下来，绝不因为上游猛灌而把水箱撑爆。接管子的人不用自己盯水位。

**在 Whistle 里**：`lib/socket-mgr.js:773` 的 `req.pipe(res).pipe(req)` 把双向流对成环，`lib/https/index.js:1191` 把隧道两端对接；流速调节由 Node 流内部依据 `write()` 返回值完成。

**为什么这样设计**：客户端、代理、源站三方的带宽各不相同，自动背压避免快生产者淹没慢消费者；代价是手写双向环时一旦某侧 `destroy` 不及时，容易留下半开连接。

**容易混淆**：`pipe` 不是「把数据复制一份」，它搬运的是同一段流的引用关系，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：隧道透传阶段零解密零改写，全靠这一对 `pipe`，见 [CONNECT 判定与 TLS 解密](/core/connect-mitm)。

### PipeStream（可插拔管道流）
> 第三方 `pipestream` 提供的、支持动态插入多段变换的组合流。

**打个比方**：像带标准接口的组合水管，中途想加个过滤器或三通，直接拧一段进去即可，不必把整条管子拆开重接。

**在 Whistle 里**：`lib/init.js:1` 引入，`lib/init.js:159-160` 用 `wrapSrc` / `wrapDest` 包装 `req`/`res`，`lib/init.js:138` 新建实例，`:90-143` 通过 `add` / `addHead` / `addTail` 动态插入文本与解压变换。

**为什么这样设计**：规则可能在请求生命周期的任意时刻追加改写，普通 `pipe` 一旦接好就固定了，PipeStream 让「后加一段」成为可能；代价是它又是一层抽象，读代码要先认得 `src` / `dest` 语义。

**容易混淆**：它不是 Node 内置的 `pipe`，而是第三方库对 `pipe` 的封装，见 [一次 HTTP 代理请求的旅程](/core/http-request)。

**工程中的样子**：`res.addTextTransform(...)` 这类规则改写就靠它落地，见 [指令体系与分发链路](/modules/protocol-catalog)。

### Buffer（二进制缓冲区）
> Node 中存放一段原始字节、脱离字符编码的定长对象。

**打个比方**：像统一规格的货箱，里面装的是字节，不关心是文字、图片还是加密数据；贴不贴标签（编码）是上层的事。

**在 Whistle 里**：`lib/https/index.js:1139` 用 `Buffer.from(statusLine)` 构造隧道响应，`:1144` 用 `Buffer.concat` 拼接首包，`lib/https/index.js:1232` 直接读 `chunk[0]` 判断首字节是不是 TLS 记录。

**为什么这样设计**：代理层处理的是未解析的原始字节，首包嗅探、二进制拼接都必须绕开字符串编码；代价是长度与偏移要自己算，越界容易读到脏数据。

**容易混淆**：Buffer 不等于字符串，`.toString()` 只是按某种编码解释它，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：抓包请求/响应体以 Buffer 采集再截断上报，见 [抓包数据的采集与上报](/core/capture-data)。

### LRU 缓存（Least Recently Used Cache）
> 容量满时淘汰最久未使用条目的缓存结构。

**打个比方**：像容量固定的书架，新书没地方就抽走最久没人翻的那本；常翻的总是留在手边，不用自己记账。

**在 Whistle 里**：`lib/https/ca.js:39-41` 用 `lru-cache` 建 `cachePairs`（5120）、`certsCache`（256）、`remoteCerts`（1280）三级证书缓存，`lib/config.js:24` 用它存 httpsAgents（360）。

**为什么这样设计**：证书签发与 TLS 上下文很贵，按域名缓存能大幅减少重复生成；LRU 自动淘汰冷门域名，避免缓存无限膨胀，代价是命中率依赖访问局部性。

**容易混淆**：LRU 不等于自己写定长数组的有界缓存，前者按「最近使用」淘汰、后者按「溢出批量清理」，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：`getOrCreateCert` 先查缓存再签发（`lib/https/ca.js:582-607`），见 [证书体系的实现细节](/modules/certificates)。

### 有界缓存（Bounded Cache）
> 自己设上限与溢出阈值、到量即回收的定长数据结构。

**打个比方**：像只有固定格子的收件架，格子满了就把最旧一批整批清走，宁可丢旧的也保证架子不被压塌。它不关心哪格最近被碰过。

**在 Whistle 里**：`lib/util/data-server.js:21-26` 定义 `MAX_LENGTH`、`OVERFLOW_LENGTH = MAX_LENGTH * 3`、`COUNT = 100`，`:10-16` 把低于下限的配置校正为 600，`:34` 把单页夹到 `MAX_COUNT = 120`。

```js
// lib/util/data-server.js:21-26
var MAX_LENGTH = config.reqCacheSize;
var OVERFLOW_LENGTH = MAX_LENGTH * 3;
var MAX_CACHE_SIZE = MAX_LENGTH * 2;
var PRESERVE_LEN = 360;
var MAX_FRAMES_LENGTH = config.frameCacheSize;
var COUNT = 100;
```

**为什么这样设计**：抓包会话会随长时间运行无限增长，硬上限是让代理能整夜跑而不撑爆内存的兜底，不是性能优化；代价是超出部分会被丢弃、历史不能无限回看。

**容易混淆**：它不是 LRU，淘汰策略是「溢出批量清理」而非「淘汰最久未用」，见 [抓包数据的采集与上报](/core/capture-data)。

**工程中的样子**：长跑回归靠这些阈值兜底，见 [CI、嵌入式集成与自动化回归](/scenarios/automation)。

### 短轮询（Short Polling）
> 前端按固定间隔反复发起请求、每次拉走增量数据的模式。

**打个比方**：像每隔一会儿去信箱看一眼，有信就取、没有就回，间隔还会根据上次有没有信自动调快或调慢。它不占着线不走。

**在 Whistle 里**：`htdocs/src/js/data-center.js:1157-1159` 调 `cgi.getData`，按 `hasNewData` 把下一次间隔设为 100ms 或 900ms；服务端 `lib/util/data-server.js:26` 的 `COUNT = 100` 限住单次返回条数。

```js
// htdocs/src/js/data-center.js:1157-1159
cgi.getData(options, function (data) {
  var hasNewData = data && data.data && data.data.hasNew;
  setTimeout(load, hasNewData ? 100 : 900);
```

**为什么这样设计**：实现简单、穿透代理与防火墙、服务端无长连接状态，配合游标增量拉取足够撑起抓包列表；代价是有数据时的最多 100ms 延迟与空轮询的固定开销。

**容易混淆**：短轮询不是长连接、SSE 或 WebSocket，它每次都是独立的短请求，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：抓包列表「边跑边出新数据」就是它驱动的，见 [Web 管理界面](/modules/webui)。

## 三、进程与配置

### cluster（集群多 worker）
> Node 用多个 worker 进程分担同一监听端口的内建机制。

**打个比方**：像同一柜台开几个窗口，主进程只负责排班和盯着谁倒下了，真正办业务的是各窗口，来客不必知道后面有几个人。

**在 Whistle 里**：`index.js:199-213` 在 `cluster.isMaster` 时按 CPU 数或指定值 `forkWorker`，`index.js:165-172` 给每个 worker 的 `storage` 加后缀隔离数据，`index.js:99-141` 实现心跳与崩溃重拉。

**为什么这样设计**：单机多核利用与故障自愈兼得，主进程不处理业务、worker 崩了立刻补一个；代价是每个 worker 都有独立内存，缓存与状态不共享，且 `options.server` 与 cluster 互斥（`index.js:207`）。

**容易混淆**：cluster 不是 pfork，前者是 Node 内建的多 worker 端口共享，后者是拉起隔离插件子进程，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：`w2 start --cluster` 或启动选项 `cluster` 开启，见 [进程模型与配置系统](/architecture/process-config)。

### pfork（隔离子进程 fork）
> 第三方 `pfork` 模块拉起的、与代理主进程隔离的子进程。

**打个比方**：像把重活和来路不明的活外包给独立车间，车间出事故不会波及主楼，主楼只通过一张传递单与它通信。

**在 Whistle 里**：`lib/service/index.js:1` 引入，`lib/service/index.js:17-32` 拼出 fork 选项、`:47-85` 调 `fork(getOptions(), ...)` 起公共服务子进程；每个插件则由 `lib/plugins/index.js:633-647` 各自 `p.fork`。

**为什么这样设计**：第三方插件、DNS/网络探测等重活放进独立进程，崩溃与内存泄漏都不拖垮代理；代价是要靠 IPC 消息与内部端口通信，调试链路更长。

**容易混淆**：pfork 不是 cluster，它不共享监听端口，也不由 Node 的 cluster 调度，见 [插件系统](/modules/plugins)。

**工程中的样子**：官方文档明确建议「在独立子进程中运行 Whistle」，见 [CI、嵌入式集成与自动化回归](/scenarios/automation)。

### detached 守护进程（Detached Daemon）
> 脱离终端会话、在后台常驻的进程。

**打个比方**：像交班之后自己留下值班的人，关掉对讲机的那一方下班了，值班的人仍在楼里，登记本上还留着他的工号。

**在 Whistle 里**：`w2 start` 拉起后台实例，其 PID 与启动参数由 `bin/util.js:123-150` 落到 `~/.startingAppData` 下的配置文件，`bin/status.js` 读 `config.pid` 判断实例是否仍在运行。

**为什么这样设计**：关掉终端或 SSH 断开后代理仍要继续服务，守护化把生命周期从终端里摘出来；代价是 `stop` / `status` / `restart` 必须靠 PID 文件反查，且后台实例不自动装根证书、不改系统代理。

**容易混淆**：detached 进程不是你敲命令的那个 CLI 进程，CLI 只是拉起它然后退出，见 [从 w2 start 到端口监听](/architecture/startup)。

**工程中的样子**：`w2 run` 前台运行、`w2 start` 守护化，差别见 [能力边界、风险与合规](/scenarios/boundaries)。

### PID 文件（PID / Config File）
> 记录后台进程号与启动选项、供后续命令反查实例的文件。

**打个比方**：像值班登记本，写上「谁在值班、用什么参数上的岗」，下一班来查岗不用满楼找人，翻本子即可，还能顺手核对人还在不在。

**在 Whistle 里**：`bin/util.js:123-150` 定义 `getDataDir()`、`getConfigFile(storage)` 与 `readConfig(storage)`，`:152-171` 的 `readConfigList()` 遍历目录并只收 `config.pid && config.options` 齐全的条目；`bin/use.js` 与 `bin/status.js` 据此判断存活。

**为什么这样设计**：把「实例在哪、怎么起的」持久化，让 `stop` / `status` / `restart` 与启动时刻解耦；代价是进程被强杀后登记本可能残留，需要按 PID 复核。

**容易混淆**：PID 文件不是 `lib/config.js` 的运行时单例配置，前者是磁盘上的实例登记表，见 [进程模型与配置系统](/architecture/process-config)。

**工程中的样子**：`w2 status` 列出运行实例及其 PID，见 [从 w2 start 到端口监听](/architecture/startup)。

### 心跳/看门狗（Heartbeat / Watchdog）
> 定时报活、超时未报即判定失效并重启的机制。

**打个比方**：像值班人每隔一分钟报一次平安，超过十二分钟没声，班长就当他出事、立刻换一个人顶上，并重新登记。

**在 Whistle 里**：`index.js:14-16` 定义 `INTERVAL = 1000`、`MASTER_TIMEOUT = 12000`，`index.js:123-140` 收 worker 的 `'1'` 消息后起定时 `send('1')` 并设 `activeTimer` 看门狗，`:102-119` 的 `refork` 负责杀掉失联 worker 再拉起。

**为什么这样设计**：worker 可能卡死而非退出，仅监听 `exit` 不够，定时报活才能发现「活着但不干活」；代价是间隔与超时取值需要权衡，太短易误判、太长恢复慢。

**容易混淆**：心跳不是前端短轮询，前者是进程间存活性检测、后者是拉数据，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：cluster 模式下 worker 崩溃自动补位，见 [进程模型与配置系统](/architecture/process-config)。

### 单例配置（Config Singleton）
> 模块加载时一次性建好、全进程共享的那份 config 对象。

**打个比方**：像全楼共用的一本总账，谁改了哪页，别的部门翻到的都是改后的值，不会各自另立一本互相打架。

**在 Whistle 里**：`lib/config.js:16` 用 `extend(exports, pkgConf)` 直接把配置挂在 `module.exports` 上，`:39-58` 列出 `variableProperties` 可变项，`:85-108` 定义带 `uid` 的 `PLUGIN_HOOKS`；`index.js:173` 只调一次 `require('./lib/config').extend(options)`。

**为什么这样设计**：端口、目录、内部头、插件钩子必须全局一致，单例让任何模块 `require('../config')` 都拿到同一份；代价是启动后改动会影响所有引用方，多实例只能靠 `storage` 分目录而非多份 config。

**容易混淆**：单例配置不是「每次 require 新建一个对象」，CommonJS 模块缓存决定了它只初始化一次，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：`--config` 载入的文件在装配阶段覆盖同名项，见 [进程模型与配置系统](/architecture/process-config)。

### storage 隔离（Storage Isolation）
> 用独立子目录把多个实例的规则、值与证书分开存放。

**打个比方**：像给每个租户配一个带锁的储物柜，大家共用同一栋楼，但各自的家什不串门，退租时清自己的柜子即可。

**在 Whistle 里**：`lib/config.js:1067-1091` 由 `baseDir` 拼出 `custom_dirs/<storage>` 并生成 `rulesDir`、`valuesDir`、`propertiesDir`；`index.js:160-162` 给复用外部 Server 的实例加 `__custom_server_` 后缀，`index.js:165-172` 给 cluster worker 加 `__cluster_worker.N_` 后缀，`bin/util.js:137-140` 按 storage 命名配置文件。

**为什么这样设计**：一台机器常要跑多个互不干扰的实例（日常调试、CI、多租户），目录级隔离比端口隔离更彻底；代价是排查「改了没生效」时，必须先确认改动写进了当前实例那一份。

**容易混淆**：storage 隔离不是「换个端口就隔离」，端口不同但 storage 相同仍共用同一份数据，见 [CI、嵌入式集成与自动化回归](/scenarios/automation)。

**工程中的样子**：测试用 `storage: 'test_'` 开独立状态，见 [CI、嵌入式集成与自动化回归](/scenarios/automation)。

## 四、速览表：运行时工程词

以下词条不单独展开，读源码时用来对齐称呼；落点列给出 Whistle 中最接近的实现位置，个别词属通用 Node 概念，落点为其对应处理处。表内源码落点为省略 `lib/` 前缀的简写，正文一律用完整 `lib/xxx.js:行号`。

::: cols 16|30|30|24
| 名词 | 一句话 | 源码落点 | 易混淆 |
|---|---|---|---|
| 回调 vs Promise | 配置两者都支持 | `index.js:87` | 非同一机制 |
| Buffer.concat | 拼接多段字节 | `https/index.js:1144` | 非字符串拼接 |
| base64 | 二进制文本编码 | `https/index.js:1132` | 非加密 |
| gzip/zlib | 压缩与解压流 | `init.js:107` | 非字符编码 |
| 游标/增量拉取 | 按起点取新数据 | `util/data-server.js:26` | 非全量返回 |
| 轮询 vs 文件监听 | 定时拉与变更推 | `config.js:16` | 非同一触发 |
| keep-alive agent | 复用出站连接 | `config.js:1035` | 非监听端口 |
:::

::: cols 16|30|30|24
| 名词 | 一句话 | 源码落点 | 易混淆 |
|---|---|---|---|
| worker/IPC | 子进程消息通道 | `index.js:123` | 非 HTTP 请求 |
| 优雅退出 | 收 SIGTERM 收尾 | `index.js:184` | 非强杀 |
| `options.server` | 复用外部 Server | `index.js:150` | 与 cluster 互斥 |
| mode | 模式开关组合 | `config.js:809` | 非端口配置 |
| `whistleStarted` | 启动完成事件 | `index.js:85` | 非监听成功 |
| `exportInterfaces` | 挂出对外接口 | `index.js:215` | 非中间件 |
| uiMiddleware | 注入自定义中间件 | `index.js:42` | 非插件 hook |
:::

`lib/config.js:1035-1048` 把 `sockets` 换算成 `agentConfig.maxSockets`，并在 Node 11 以上默认 `disableAgent` 关掉连接缓存；`lib/index.js:85` 的 `whistleStarted` 由计数回调在所有端口监听完成后才发出，`lib/index.js:42` 的 `config.middlewares` 是外部注入自定义中间件的唯一入口。把这些短词与前面的卡片对照记，读 [一张图看懂全局架构](/architecture/overview) 时不会被相近缩写带偏。

## 与工程实际结合

**装配与启动分离。** 入口只导出一个纯函数，由调用方决定进程形态：`index.js:143-148` 是 `module.exports`，`:150-163` 处理复用外部 Server，`:173-175` 先 `config.extend(options)` 再交给 `require('./lib')`。

```js
// 来源：test/index.test.js:105-136、lib/index.js:215-241
const startWhistle = require('whistle');
const proxy = startWhistle({
  port: 18080, storage: 'ci_',
  rules: { Default: 'www.test.com file://({"ec":0})' }
}, () => {
  proxy.on('_request', (req) => console.log(req.fullUrl));
  proxy.setShadowRules('www.test.com file://({"ec":0})');
  console.log(proxy.getShadowRules());
});
```

回调拿到的 `proxy` 就是 `proxyEvents`（`lib/index.js:39`），`setShadowRules`、`getShadowRules` 来自 `lib/index.js:231-239`。内嵌模式没有 detached 守护进程、不自动装根证书、不改系统代理，与 `w2 start` 的环境准备责任完全不同；正因如此才适合在 CI 里一次起多个互不干扰的实例，跑完随测试进程一起退出。完整链路见 [CI、嵌入式集成与自动化回归](/scenarios/automation) 与 [装配与启动分离](/architecture/process-config)。

**四类事件落到同一条中间件链。**

```js
// lib/index.js:36-52（节选）
function proxy(callback, _server) {
  var app = express();
  var server = _server || http.createServer();
  var proxyEvents = new EventEmitter();
  var middlewares = ['./init', '../biz']
    .concat(require('./inspectors'))
    .concat(config.middlewares)
    .concat(require('./handlers'));
  server.timeout = config.timeout;
  server.requestTimeout = 0;
  proxyEvents.config = config;
  proxyEvents.server = server;
  app.disable('x-powered-by');
  middlewares.forEach(function (mw) {
    mw && app.use((typeof mw == 'string' ? require(mw) : mw).bind(proxyEvents));
  });
```

`bind(proxyEvents)` 让每个中间件里的 `this` 都指向同一块总线，这是「一处装配、处处可达」的具体落点。请求从这里进入后的十六步见 [一次 HTTP 代理请求的旅程](/core/http-request)。

**长跑与内存边界。** 抓包会话靠 `lib/util/data-server.js:21-34` 的硬上限兜底，前端靠 `htdocs/src/js/data-center.js:1157-1159` 的短轮询增量取走；cluster 与 pfork 分别解决多核利用与第三方代码隔离。把这些机制放回真实工程约束里看，见 [抓包数据的采集与上报](/core/capture-data)、[Web 管理界面](/modules/webui) 与 [能力边界、风险与合规](/scenarios/boundaries)。

## 常见误解

1. **`lib/init.js` 不是启动初始化，而是每请求中间件。** 它被 `lib/index.js:40` 放进 `middlewares` 数组、`lib/index.js:50-51` `app.use` 到 Express 链上，`lib/init.js:157` 导出的函数签名是 `(req, res, next)`。真正的启动装配在 `index.js:143-148` 与 `lib/index.js:36-61`，两者别混，见 [从 w2 start 到端口监听](/architecture/startup)。
2. **`sockets=256` 不是监听端口数，也不是并发上限。** 它是 `lib/config.js:1035-1048` 换算出的每域名 keep-alive 连接池 `maxSockets`；独立监听端口由 `lib/index.js:96-150` 的 `httpPort` / `httpsPort` 决定。Node 11 以上还会被 `lib/config.js:1046` 默认关掉 agent 缓存。
3. **`proxyEvents` ≠ 每条请求的 `reqEmitter`。** 前者是 `lib/index.js:39` 建的进程内单例总线，随进程存活；后者是请求级发射器，随请求销毁。测试里 `proxy.on('_request', ...)` 订的是总线事件，不是某条请求的私有通道，见 [易混淆辨析](/concepts/08-confusions)。
4. **pfork ≠ cluster，detached 进程 ≠ CLI 进程。** cluster 是 `index.js:199-213` 的多 worker 端口共享，pfork 是 `lib/service/index.js:47-85` 与 `lib/plugins/index.js:633` 的隔离子进程；`w2 start` 的 CLI 拉起 detached 后台实例后自身退出，`bin/util.js:123-150` 靠 PID 文件反查，见 [进程模型与配置系统](/architecture/process-config)。
5. **LRU ≠ 自实现有界缓存，短轮询 ≠ 长连接/SSE。** 前者是 `lib/https/ca.js:39-41` 按「最久未用」淘汰的 lru-cache 实例，后者是 `lib/util/data-server.js:21-26` 靠溢出阈值批量清理的定长结构；前端 `htdocs/src/js/data-center.js:1159` 每次都是独立短请求，不是 WebSocket 或 SSE，见 [抓包数据的采集与上报](/core/capture-data)。
6. **单例配置 ≠ 每次 require 新建。** `lib/config.js:16` 把配置直接 `extend` 到 `exports`，CommonJS 模块缓存保证全进程只有这一份；`storage` 隔离靠分目录（`lib/config.js:1067-1091`），不是靠多份 config 对象，见 [CI、嵌入式集成与自动化回归](/scenarios/automation)。

## 小结

- `http.Server` 的 request / connect / upgrade / clientError 四类事件把不同形态的连接归一进同一套后台，Express 中间件按固定顺序塑形 `req`/`res`。
- Stream、Transform、`pipe` 与 PipeStream 负责字节的搬运、改写与动态插入，`req.pipe(res).pipe(req)` 是隧道透传的最小形态。
- `proxyEvents` 是进程内单例事件总线，`exportInterfaces` 把操作入口挂到它上面；hook 走插件子进程，与中间件不在同一条链。
- 缓存分两类：LRU 按热度淘汰证书与 agent，有界缓存按溢出阈值兜住抓包会话；前端用短轮询增量取数据。
- cluster 管多 worker 与看门狗，pfork 管隔离插件，detached 与 PID 文件管后台生命周期，单例配置与 storage 隔离分别管状态共享与实例分家。
- 入口是纯函数：先装配配置，再由调用方决定守护化、内嵌或复用外部 Server，这是同一份内核能同时服务 `w2 start` 与 `require('whistle')` 的前提。

## 下一步

[《第四层：抓包数据的采集与上报》](/concepts/05-capture)：运行时骨架清楚了，下一篇看一次请求的字节怎样被采集、截断、缓存，再经约定式 CGI 与短轮询送到界面上，把 Stream 与有界缓存两条线索接起来。
