---
title: 隧道、WebSocket 与帧拦截
description: 以 socket-mgr 为中心，串起连接上下文、双向流拼接、ws-parser 帧处理与 TCP 抓包。
---

# 隧道、WebSocket 与帧拦截

上一篇看到 CONNECT 的两条分支最后都汇成一对双向字节流；WebSocket 的 [Upgrade](/concepts/02-http) 同样如此，只是多了 101 应答与帧结构。但 [《CONNECT 判定与 TLS 解密》](/core/connect-mitm) 把两条分支都收敛到 `handleTunnel` 之后，留下一个未解问题：无论隧道里是明文还是裸字节，连接上下文该挂在哪、帧又如何按编号归并。本篇回答的正是这个问题——它们统一交给 `lib/socket-mgr.js` 这个「连接上下文 + 双向流 + 帧处理中心」。读完你能说清一条连接何时被直接对拼、何时被插入双 Transform，以及帧脚本、暂停状态与心跳各自落在哪一段代码上。

::: tip 先修知识
本篇承接 [《CONNECT 判定与 TLS 解密》](/core/connect-mitm)（前置 10），并沿用 [《一次 HTTP 代理请求的旅程》](/core/http-request)（前置 09）的链路视角：需要你已经理解 10 的结论「解密与不解密两条分支最终都汇入 `handleTunnel`、`enable://inspect` 给两者一致的抓帧入口」，以及 09 里 `reqId` 早于一切改写与采集、抓包 `data` 对象与连接帧上下文指向同一个编号。若对 Stream、`pipe`、背压与 Transform 双向流的语义不熟悉，可先读 [《概念精解 · Node 运行时与内核骨架》](/concepts/04-runtime)；对 Upgrade、101 应答与 WebSocket 帧可查 [《概念精解 · HTTP 报文与连接语义》](/concepts/02-http)；对抓包、`reqId`、帧与帧缓存可查 [《概念精解 · 抓包数据面与帧》](/concepts/05-capture)；对驱动帧脚本的规则配置可查 [《概念精解 · 规则 DSL 全景》](/concepts/06-rules)；想按时间顺序看一次请求的完整贯通可读 [《概念精解 · 综合贯通：一次 HTTPS 请求里的全部概念》](/concepts/09-walkthrough)。不需要预先读过源码，但知道 `conns[reqId]` 里的 `reqId` 来自 09 / 10 那条链会更轻松；成对辨析可查 [《易混淆概念辨析》](/concepts/08-confusions)，忘记名词查 [《全量术语索引》](/concepts/glossary)。

给不熟源码的读者补三个基本词：一条连接是两端各一根字节管道，所谓「双向」就是两根管道各管一个方向；「上下文」是内核替这条连接记的一张便签，写着两侧状态、暂停标记、脚本，而不是连接本身；「帧」是把连续字节按协议切出的一个有边界的数据单元，管道本身只认字节、不认边界。本篇要回答的，正是这些便签与边界由谁统一管理、又在什么情况下才值得费力气去切帧。
:::

![socket-mgr 的连接上下文与帧处理中心](/diagrams/socket-mgr.svg)
*图注：每条连接以 reqId 登记到 conns，按是否需要抓帧选择纯对拼或双 Transform 管道。*

## socket-mgr 不是连接池

`lib/socket-mgr.js:10` 只有一个 `var conns = {}`，`:19-21` 导出的初始化函数也仅保存 `proxy` 引用。它不复用、不排队、不预建连接，而是按 [`reqId`](/concepts/05-capture) 登记每条活跃连接的上下文：`getContext` 把 `req` / `res`、双向状态、帧收发器组装成一个 `ctx` 存进 `conns[reqId]`，`handleClose`（`:28-53`）在两侧 socket 任一关闭时取出该 `ctx` 执行 `clearup()`，并靠 `_hasClosed` 标志确保「两侧都关掉」才算真正结束。

把它理解成连接池会带来一连串误判：这里没有空闲队列、没有复用阈值，也没有「取一个连接」的接口。`conns` 的键是 `reqId`，而 `reqId` 在 `lib/inspectors/rules.js:159` 或 `lib/tunnel.js:89` 分配，意味着它与「一次请求 / 一条隧道」一一对应；连接结束即由 `handleClose` 清理，生命周期完全跟随会话。之所以值得单独建上下文，是因为一条连接要同时承载两侧的流状态、暂停标记、帧脚本与插件管道，这些信息无法塞进裸 socket 而不互相污染。

真正的分发入口是 `handleConnect(req, res, isUpgrade)`（`:764-847`）。它先按 `isUpgrade` 决定事件名 `wsRequest` 或 `tunnelRequest`，再用 `isConn = isUpgrade || req.inspectFrames` 判断这条连接是否需要按帧处理。`handleClose`（`:28-53`）在注册时就已挂上：任一侧 `end` 触发回调，第二次触发才 `proxy.emit('frame', ...)` 抛出关闭帧，这个「两次才收尾」的判断正是 `:32-36` 的 `closed` 标志。

```js
// lib/socket-mgr.js:772-773
if (req.isPluginReq || (!isConn && !hasEvent)) {
  return req.pipe(res).pipe(req);
}
```

无需抓帧时走最短路径：两个 socket 直接 `req.pipe(res).pipe(req)` 首尾相接，内核只负责在关闭时记账。若只是有监听器但不必解析帧，`:788-790` 会插入两个空转换流，仍能转发但可顺手抛事件：

```js
// lib/socket-mgr.js:788-790
if (!isConn) {
  reqTrans._transform = resTrans._transform = handleTransform;
  return req.pipe(reqTrans).pipe(res).pipe(resTrans).pipe(req);
}
```

需要抓帧时，`:798-844` 先经 `pluginMgr.getTunnelPipe` 拿到插件读写管道，再由 `getFrameCtx`（`:657-665`）取帧脚本上下文，最后用 `:838-843` 拼出两条对称的 Transform 管道：客户端流向服务端经过 `reqTrans`，服务端流向客户端经过 `resTrans`，两端各挂一个 `pipeStream` 衔接插件端口。帧脚本与状态机都作用在这两个 Transform 上。

```js
// lib/socket-mgr.js:838-843
pipeStream(req, reqRead)
.pipe(reqTrans)
.pipe(pipeStream(reqWrite, res, true));
pipeStream(res, resRead)
.pipe(resTrans)
.pipe(pipeStream(resWrite, req, true));
```

::: cols 22|44|34
| 拼接方式 | 代码 | 位置 |
|---|---|---|
| 纯双向透传 | req.pipe(res).pipe(req) | socket-mgr.js:773 |
| 双 Transform | reqTrans / resTrans | socket-mgr.js:790 |
| 帧管道 | pipeStream 两路 | socket-mgr.js:838 |
| 本地 101 | socket.write(...) | https/index.js:800 |
:::

把「不是连接池」这句结论再展开一步：连接池的目标是省下重复握手，前提是连接能被复用；而这里每条隧道的目标、协议、加密状态都可能不同，复用会把上一条会话的帧脚本与暂停标记带过来，反而制造串台。于是 `conns` 选择的是「一次会话一条上下文、结束即清」，用一点常驻内存换来了状态互不污染。理解了这个前提，后面三档拼接才不会读成「三种连接池策略」。

**为什么用 `conns[reqId]` 这本字典，而不是按协议或按 socket 存**：把结论展开成推理——`reqId` 在 09 / 10 那条链上早于一切改写与采集就定下，抓包 `data` 对象、`socket-mgr` 的帧上下文与界面会话 id 都指向它；用它做键，等于让「这条连接此刻的全部状态」——两侧的 [Stream](/concepts/04-runtime) 状态、暂停标记、帧收发器、插件管道——收在一个对象里，彼此不串味。代价是每条连接都要常驻一个 `ctx` 直到两侧都关闭；边界是它只登记与清理，真正的转发决策在 `handleConnect`。

**为什么 `handleClose` 要「两侧都关掉」才算结束**：`end` 是单向事件，客户端写完、服务端可能还在回帧，反过来也一样；只凭一侧就 `clearup()`，会把仍在流动的半条连接连同它的 `ctx` 一起删掉，另一侧的帧便无处归并。用 `_hasClosed` 与 `closed` 做「第二次触发才收尾」，本质是给半关闭留缓冲：先到的一侧先记账，后到的一侧才真正抛关闭帧。代价是关闭帧事件要延迟到第二次 `end` 才发出，排查「界面为何迟迟不显示结束」时要想到这点；边界是这个判断只针对 socket 关闭，主动中断属于另一条清理路径。

**为什么分三档拼接，而不是一律走帧管道**：纯透传只做首尾相接、有监听器但不解析帧时插两个空转换流、真正要抓帧才搭对称双 Transform 加 `pipeStream`。这里用的正是 Node [pipe](/concepts/04-runtime) 的默认语义——把两条裸流接起来、背压交给 Stream 自己管；而解析一帧要过 `ws-parser`、跑脚本、维护状态机，成本高还会碰数据，若用户根本没开检视，就不该让每条隧道都付这份代价。让最常见的透明转发走最短路径，是典型的「快路径优先」。代价是三档分流条件都压在 `handleConnect` 一个入口，读代码要先分清 `isConn` / `hasEvent` / `isPluginReq` 各把流量拨到哪；边界是插件请求被直接短路到纯透传，不受帧脚本影响。

**输入 → 动作 → 输出**：输入是一条已判定交给 `socket-mgr` 的连接（`req` / `res`、是否 Upgrade、是否抓帧、是否插件请求），动作是按 `reqId` 取出或新建 `ctx`、由 `isConn` 选纯透传 / 空转换流 / 双 Transform 三档之一、注册 `handleClose`，输出是一对接好的双向流与一个挂在 `conns` 上的上下文；后续任一侧 `end`，由 `handleClose` 二次触发收尾并抛关闭帧。把那张三列表格从上往下读，就是「越往下、内核介入越深」。

**代价与边界**：纯透传档几乎零开销却也零观测，用户此时看不到任何帧；帧管道档能改写、丢弃、注入单帧，代价是每帧都要过脚本与状态机、还要受后面那些内存上限约束。三者共用 `reqId` 这个键，好处是无论哪一档，界面上的会话与帧都能归到同一条记录；边界是「连接池」在这里完全不成立——不复用、不排队、不预建，生命周期严格跟随会话。

**打个比方**：`socket-mgr` 不像游泳池的循环更衣柜（连接池），更像给每位客人临时开一个带隔间的储物柜（上下文），钥匙就是 `reqId`；客人从两扇门（两侧 socket）进出，只有两扇门都关上，服务员才来清柜。要不要在隔间里装监控（Transform），取决于这位客人有没有要求检视。

**自己验证**：对照那张拼接方式表格，问自己「没开抓帧时走哪一行、开了抓帧走哪一行」；再数一数 `handleClose` 里 `end` 触发几次才抛关闭帧，能答「两次」，就理解了为什么 `_hasClosed` 不是多余标志。

## upgrade 入口与 101 应答

WebSocket 的入口在 `lib/upgrade.js:179-181`：`module.exports` 给 server 注册 `upgrade` 事件。`upgradeHandler(req, socket)`（`:77-177`）先做通用的客户端信息、SNI 插件、转发属性处理，`:121-122` 置 `req.isWs = true` 并 `socket.fullUrl = util.getFullUrl(req)`；`util.getFullUrl` 在 `lib/util/common.js:1284` 依 `req.isWs` 与 `req.isHttps` 拼出 `ws://` 或 `wss://`。

`:125` 的 `getPluginNameByReq` 先判断这条 upgrade 是否属于某个插件界面：命中则 `:139-159` 用 `util.connect` 连到本地 `uiPort`，重放构造好的请求头后 `socket.pipe(resSocket).pipe(socket)`，不再进入帧处理；未命中才在 `:162-174` 清理协议相关头、挂上 `socket.getBuffer`，交给 `:175` 的 `handleWebsocket`。这条「先界面、后代理」的顺序与 `biz/index.js` 分流 UI 的思路一脉相承，保证管理流量不被用户规则与帧脚本干扰。

`lib/https/index.js:43-59` 的 `handleWebsocket` 补齐 method、reqId、客户端信息，解析规则后调 `resolveWebsocket`（`:89`）。后者负责拨号：`:542-557` 组装 `opts`（含 `servername`、客户端证书、安全选项），最终 `:557` 按 `isWss` 选择 `tls` 或 `net` 连接。

```js
// lib/https/index.js:557
reqSocket = (isWss ? tls : net).connect(opts, pipeData);
```

`pipeData` → `_pipeData`（`:771-772`）用 `hparser.parse` 解析源站回来的状态行，确认 `code == 101` 后写回客户端并把连接交给 `:164` 的 `handleFrames`。`lib/https/index.js:81-87` 的 `handleFrames` 是分流点：命中 `enable.websocket` 或 `util.isWebSocket(headers)` 就 `socketMgr.handleUpgrade`，否则 `socketMgr.handleConnect(..., true)`——这正是 WebSocket 与任意 TCP 隧道共用 `socket-mgr` 的接缝。

若源站没有响应、而是由规则直接构造 101，`:147-159` 会自己计算握手校验值：把 `Sec-WebSocket-Key` 拼上固定 GUID，取 SHA-1 的 base64 写入 `Sec-WebSocket-Accept`。

```js
// lib/https/index.js:153-156
if (key) {
  key += '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  resHeaders['Sec-WebSocket-Accept'] = crypto.createHash('sha1').update(key, 'binary').digest('base64');
}
```

把「先界面、后代理」这句结论再展开一步：管理界面自己也走同一个端口的 WebSocket，若不先把它挑出来，用户写的 `host` / `path` 规则与帧脚本就会作用到界面流量上，调试面板可能先把自己改坏。这与 09 里 `biz` 用一组正则挡住 Web UI 是同一条原则，只是落在 upgrade 这条入口上由 `getPluginNameByReq` 执行。

**为什么 upgrade 要先查「是不是插件界面」再决定要不要代理**：命中界面就直接连本地 `uiPort`、重放请求头后用双向对接收工，未命中才清理协议头、挂 `getBuffer`、交 `handleWebsocket`。把这句展开：管理流量必须与业务流量隔离，否则用户规则与帧脚本会改到界面自己的连接上；给界面一条旁路，调试面板才不会被自己写的规则误伤。代价是入口一开始要多查一次界面标识，边界是它只影响 upgrade 这一条路径，普通 HTTP 的界面分流由 `biz` 那段正则负责。

**为什么 `getFullUrl` 要按 `req.isWs` / `req.isHttps` 拼 `ws://` 或 `wss://`**：Upgrade 请求本身没有绝对路径，代理能拿到的只有目标主机与一次「协议切换」的意图。出站拨号要决定用 `tls` 还是 `net`，规则匹配与抓包展示又要一个统一标识，因此必须在入口就把意图归一成完整的 ws/wss URL；否则 `resolveWebsocket` 无从判断该不该加密，界面上只会显示成一个没有协议的地址。代价是这一步要同时读两个标志，边界是它只定「形态」，帧内容要等握手成功后才出现。

**为什么本地构造 101 时要自己算 `Sec-WebSocket-Accept`**：握手校验值是协议规定的——客户端的 `Sec-WebSocket-Key` 拼上固定 GUID、取 SHA-1 再做 base64，服务端回写 `Sec-WebSocket-Accept`，客户端才认为切换成功。当源站根本没响应、而由规则直接伪造 101 时，这段握手没经过真实服务端，代理就得把校验值补齐，否则客户端会直接断开、后续帧无从谈起。代价是这段逻辑与「正常转发源站 101」并存，排障时要先分清 101 是回的还是造的；边界是它只补握手头，不替用户生成任何业务帧。

**为什么 `handleFrames` 是 WebSocket 与任意 TCP 隧道的接缝**：它命中 `enable.websocket` 或 `util.isWebSocket(headers)` 就走 `handleUpgrade`，否则走 `handleConnect(..., true)`。把这句展开：两者到这一步都已是「一对双向字节流」，差别只在要不要按帧解析；把分流收在同一函数里，`socket-mgr` 就能用同一套 `conns[reqId]` 与三档拼接服务两种流量，而不必为隧道再写一份。代价是 `true`（表示 Upgrade）会一路影响 `isConn` 的判定，读代码时容易忽略它把流量拨到了帧管道；边界是它只决定「按不按帧」，不决定帧脚本内容。

**输入 → 动作 → 输出**：输入是一次 `upgrade` 事件（请求头、目标主机、是否命中插件界面、规则），动作是先分流界面、归一出 ws/wss、按 `isWss` 选 `tls` / `net` 拨号、解析或本地构造 101、再由 `handleFrames` 决定交给 `handleUpgrade` 还是 `handleConnect`，输出是一条握手完成、已登记到 `socket-mgr` 的双向连接，后续字节按帧管道或纯透传处理。

**代价与边界**：「先界面、后代理」保证管理流量不被规则误伤，代价是 upgrade 入口多一次界面判断；本地构造 101 让规则能凭空起一条 WebSocket，代价是校验值必须与协议一字不差。边界是这一整段只解决「怎么把连接接起来、交给谁」，帧长什么样、脚本怎么改，是下一节才回答的事。

**打个比方**：upgrade 像前台接到一通「请转接视频通话」的请求——先确认对方是不是找楼里的会议室（插件界面），是就直接接内线；不是才查号码簿（ws/wss）、拨外线，等到对方回一句「同意切换」（101）再把两条线焊到一起。若对方根本不在、由前台自己假装同意，就得按约定把那句暗号（`Sec-WebSocket-Accept`）一字不差地说出来。

**自己验证**：顺着「命中界面 → 连到 `uiPort`」与「未命中 → `handleWebsocket`」两条路各走一遍，问自己「界面流量会不会落到帧脚本上」；再对照本地 101 那段把 GUID 拼进 key 的代码，确认校验值是算出来的、不是随便填的。

## 帧解析、脚本与流控

[帧](/concepts/05-capture)层面的能力依赖 `ws-parser`（`package.json:64`）。`lib/socket-mgr.js:291-301` 的 `getReceiver` / `getSender` 分别调用 `wsParser.getReceiver` 与 `wsParser.getSender`，把裸字节流翻译成 [WebSocket 帧](/concepts/02-http)事件；`:325` 起的 `handleWsSend` / `handleWsReceive` 再把帧送进 `frameCtx` 过滤。

```js
// lib/socket-mgr.js:291-301
function getReceiver(ctx, fromServer) {
  try {
    return wsParser.getReceiver(ctx.res, fromServer, undefined, ctx.noDecompress);
  } catch (e) { }
}
function getSender(socket, toServer) {
  try {
    return wsParser.getSender(socket, toServer);
  } catch (e) { }
}
```

帧脚本由 `req.rules.frameScript` 驱动：`lib/socket-mgr.js:657-665` 调 `rules.getFrameScriptCtx`，`:303-323` 的 `execHandleFrame` 按方向选择 `handleSendToServerFrame` 或 `handleSendToClientFrame`，把脚本返回的文本转回 Buffer 并更新长度；`:624` 还会打上 `opts.frameScript = true` 标记。脚本因此能改写、丢弃或注入单帧，而不必理解 TCP 分片。

一组常量定义了这套机制的资源边界与交互状态：

```js
// lib/socket-mgr.js:8-17
var INTERVAL = 22 * 1000;
var conns = {};
var PING = Buffer.from('iQA=', 'base64');
var PONG = Buffer.from('ioAn6ubf', 'base64');
var PAUSE_STATUS = 1;
var IGNORE_STATUS = 2;
var MAX_COMPOSE_FRAME_COUNT = 5;
var MAX_PAYLOAD = util.MAX_FRAME_PAYLOAD;
```

`PAUSE_STATUS` / `IGNORE_STATUS` 由 `setConnStatus`（`:63-84`）实现：暂停时挂起帧、等待 UI 放行，忽略时丢弃当前分块并回调，两者都是可恢复的状态机而非销毁连接；`getStatus`（`:55-61`）只在状态真正变化时才返回新值，避免重复触发。`INTERVAL = 22 * 1000` 驱动两处心跳：`:366-375` 的 `reqReceiver.ping` 回写 PONG、`:496-505` 的 `resReceiver.ping` 回写 PING，二者都是先立即写一次控制帧，再用 `setInterval` 每 22 秒续写，且每次 tick 都调用 `clearTimer`。

这里有个反直觉点：`clearTimer`（`:284-289`）只在「既不 `pause` 也不 `ignore`」时才 `clearInterval` 并把 `status.timer` 置空，也就是**正常转发态会停掉心跳，暂停 / 忽略态反而保留**。原因是 UI 暂停或忽略期间业务帧被挂起或丢弃、socket 上没有真实数据流动，需要 PING / PONG 维持保活并让界面确认连接仍存活；一旦回到正常态，真实帧本身就在流动，额外控制帧纯属浪费，下一次 tick 便把定时器清掉。因此 22 秒是「挂起期间的续写间隔」，不是无条件恒定心跳。

`MAX_PAYLOAD` 取自 `util.MAX_FRAME_PAYLOAD`（`lib/util/index.js:4012`，1MB），`:219-221` 的 `getBinary` 会把超长帧截断；`MAX_COMPOSE_FRAME_COUNT = 5` 则限制一次最多拼接 5 个分片（`:348`、`:478`、`:616`、`:948`），防止恶意分片把内存撑爆。`handleWsSend`（`:325`）与 `handleWsReceive` 在每帧经过时调用 `execHandleFrame`、累计 `status.data`，再由 `cleanCacheFrames`（`:835`）清理已消费的[帧缓存](/concepts/05-capture)——这些上限共同把「可交互的帧调试」约束在可控的内存预算内。

把「22 秒心跳」这段再展开一步：它不是定时保活的常驻逻辑，而是被状态机反过来控制的一段补偿——只有真实数据停下时才有存在价值。把 `clearTimer` 的条件、`setConnStatus` 的暂停 / 忽略、以及 `INTERVAL` 驱动的两处 ping 放在一起读，才会看出「心跳有无」是状态的函数，而不是连接的属性。

**为什么帧脚本能改写单帧、却不必懂 TCP 分片**：`getReceiver` / `getSender` 先把裸字节流翻译成一帧一帧的事件，`execHandleFrame` 再按方向把帧送进 `frameCtx`。TCP 只保证字节顺序，一帧可能被拆成多个包、也可能几帧挤在一个包里；若让脚本直接面对字节，它得自己处理粘包与分片。把「切帧」交给 `ws-parser`、把「改帧」交给脚本，脚本只需对一帧文本返回新文本、长度由外层重写回，职责一下就干净了。这些脚本由 [规则 DSL](/concepts/06-rules) 里的 `frameScript` 驱动，属于规则在连接期作用到帧上的那一支。代价是每帧都要过一次解析与一次脚本调用，帧频高时开销明显；边界是它只作用于被解析成帧的连接，纯透传档的字节脚本根本看不到。

**为什么暂停 / 忽略是「可恢复状态」而不是销毁连接**：`setConnStatus` 在暂停时挂起帧、等 UI 放行，忽略时丢弃当前分块并回调，两者都留着 `ctx` 与 socket；`getStatus` 只在状态真正变化时才返回新值。帧调试的场景是「让界面看一眼、再决定放不放这一帧」，若一暂停就断线，用户就永远没法在一条真实连接上逐帧观察；用状态机而不是销毁，才能在同一会话里反复暂停、忽略、恢复。只在状态变化时触发，是为了避免每个数据块都重复跑一遍回调。代价是这些状态要在 `ctx` 里常驻、并与心跳逻辑互相牵制；边界是暂停只影响帧的流转，不改变连接本身是否存活。

**为什么正常转发态反而停掉心跳、暂停态才保留**：把 `clearTimer` 的条件展开——暂停或忽略时业务帧被挂起或丢弃，socket 上没有真实数据流动，若不主动写 PING / PONG，对端与界面都无法判断连接是否还活着，于是 `INTERVAL = 22 * 1000` 每 22 秒续写一次控制帧保活。一旦回到正常态，真实帧本身就在流动，再插控制帧纯属浪费、还可能干扰帧序，下一次 tick 就把定时器清掉。所以 22 秒是「挂起期间的续写间隔」，不是无条件恒定心跳。代价是若把 `clearTimer` 看成「清理垃圾的常态逻辑」，会把心跳有无完全理解反；边界是它只在帧管道档存在，纯透传连接没有这套定时器。

**为什么要用 1MB 截断与 5 帧拼接上限兜底**：`MAX_PAYLOAD` 把超长帧截断，`MAX_COMPOSE_FRAME_COUNT = 5` 限制一次最多拼 5 个分片，`handleWsSend` / `handleWsReceive` 累计 `status.data` 后由 `cleanCacheFrames` 清掉已消费的帧缓存。可交互的帧调试意味着内核要把帧暂存在内存里等 UI 读取，若不限长度、不限分片数、不及时清理，一个恶意超大帧或无穷分片就能把内存撑爆；用一组硬上限把「能看多久、能攒多少」封死，是用确定性换安全。代价是超限的帧会被截断、调试时可能看不到完整内容；边界是它们约束的是「观测用的缓存」，不是链路上转发的字节——转发出去的仍是原帧。

**输入 → 动作 → 输出**：输入是双向流上的裸字节与 `frameCtx` 里的脚本 / 状态，动作是 `ws-parser` 把字节切成一帧帧、`execHandleFrame` 按方向过滤、状态机决定放行 / 挂起 / 丢弃、心跳按状态续写或停止、超长与超量部分被截断清理，输出是送进 `frameCtx` 供界面消费的一帧帧数据，以及一份始终受常量约束的帧缓存。

**代价与边界**：帧脚本、状态机、心跳、缓存上限这一整套能力，都建立在「这条连接走了双 Transform 帧管道」的前提上——纯透传档完全不经过它们。代价是每帧多一层解析与脚本开销、每个 `ctx` 常驻一份状态与缓存；边界是暂停 / 忽略只改帧的流转、不改连接存亡，1MB 与 5 帧上限只砍观测缓存、不动真实转发。把这两层分开，才不会把「界面上帧被截断」误判成「数据没发出去」。

**打个比方**：帧管道像一条装了安检的传送带——`ws-parser` 把连续的行李（字节流）分成一件件（帧），脚本是安检员（可扣下、可替换、可放行），暂停键让传送带停住等指示，心跳是传送带静止时每隔一阵亮一下的「仍在工作」指示灯；一旦行李重新流动，灯就没必要再亮。1MB 与 5 帧上限是传送带旁货架的尺寸，防止有人一次塞进无限多的行李把仓库压塌。

**自己验证**：对照常量那段数一数 `PAUSE_STATUS` / `IGNORE_STATUS` / `INTERVAL` / `MAX_COMPOSE_FRAME_COUNT` 各管什么；再顺着 `clearTimer` 的「既不 pause 也不 ignore 才清」这个条件问自己「界面按下暂停时心跳是开还是关」，能答「开」，就抓住了那段反直觉设计的用意。

## 任意端口的 TCP 抓包

不解密分支里，任意端口的 CONNECT 都被记成 `tunnel://host:port`（`lib/tunnel.js:75`），并携带 `reqSocket.fullUrl = tunnelUrl`、`reqSocket.inspectFrames = inspect`（`:650-651`）。`inspect` 来自 `:312-313` 的 `util.isInspect(enable)`（对应 `enable://inspect`）或 `util.isCustomParser(req)`，也就是只要用户显式要求检视，纯字节流也会进入 `socketMgr.handleConnect` 的抓帧路径。

对非 WebSocket 的裸 TCP 流，`ws-parser` 并不适用，因此插件可以声明 `x-whistle-frame-parser` 头提供自定义帧解析器（该头名见 `lib/plugins/compat.js:52`，在 `lib/tunnel.js:476` 与 `lib/https/index.js:665` 被消费后删除）。`lib/socket-mgr.js:768` 取出 `customParser` 后，`:802-803` 的分支会 `removePending(reqId)` 并进入 `getFrameCtx`，让插件按自己的分隔符切帧，再把帧送往 UI。这也解释了为什么 `conns[reqId]` 要按 `reqId` 而非按协议登记：同一套上下文既要承载 WebSocket 帧，也要承载插件自定义的 TCP 帧。

把「按 `reqId` 而非按协议登记」这句再展开一步：它与开头「`socket-mgr` 不是连接池」是同一个决定的两面——既然上下文的生命周期跟随一次会话，键就只能是会话编号，不能是协议名或 socket 地址。协议名会撞车、socket 地址会在连接重建时变化，只有早于一切改写就定下的 `reqId` 稳定。

**为什么裸 TCP 流也能「按帧」检视**：`tunnel://host:port` 只是给不解密连接一个内部标识，`inspectFrames = inspect` 才是开关；`inspect` 来自 `util.isInspect(enable)`（对应 `enable://inspect`）或 `util.isCustomParser(req)`，只要用户显式要求检视，纯字节流也会进入 `socketMgr.handleConnect` 的抓帧路径。也就是说，[抓包](/concepts/05-capture) 并不以「是不是 WebSocket」为前提，而以「用户有没有要求看」为前提；解密与否只决定流里是明文还是密文，不决定要不要建帧上下文。代价是密文字节切出来的帧对界面未必可读，边界是它只提供观测入口，不承诺解释内容含义。

**为什么插件要自带 `x-whistle-frame-parser`**：`ws-parser` 只认 WebSocket 帧格式，遇到私有协议的裸 TCP 流就无从下手。让插件声明这个头提供自定义解析器，等于把「怎么切帧」交给最懂该协议的一方：插件按自己的分隔符把字节流切帧，再送进 UI。该头名在插件兼容层定义、在隧道与 HTTPS 两处被消费后删除，正是为了避免它一路带到源站、污染业务请求。代价是切帧规则依赖插件实现、质量参差不齐；边界是它只在用户开启检视且插件声明了解析器时才生效，普通透传连接不会走这条路径。

**为什么 `conns[reqId]` 要按 `reqId` 而不是按协议登记**：同一套上下文既要承载 WebSocket 帧，也要承载插件自定义的 TCP 帧。若键是协议名，同名协议的多条连接会互相覆盖，一条连接上两类帧混合的情况也无法表达；按 `reqId` 登记，则无论是哪种帧、来自哪条隧道，都归到那一次会话名下，界面才能把帧和会话对上号。这也回扣了 09 / 10 里「`reqId` 早于一切改写与采集」的结论——编号在前，帧上下文才挂得上来。代价是帧的类型信息得另存字段、不能从键上读出来；边界是它只解决归属，不解决解析。

**输入 → 动作 → 输出**：输入是一条不解密的 CONNECT 连接（目标 `tunnel://host:port`、是否 `enable://inspect`、插件是否声明自定义解析器），动作是把隧道上下文挂到 socket、按 `reqId` 建帧上下文、必要时 `removePending` 后进入 `getFrameCtx` 让插件切帧，输出是即便内容是裸字节也能被界面逐帧观测的一条通道。

**代价与边界**：这套设计把「解密隧道」与「不解密隧道」收进同一个观测入口，代价是排障时要先分清帧是 `ws-parser` 切的还是插件切的、内容是明文还是密文；边界是自定义解析器只影响「怎么分帧、怎么展示」，不会把不可解密的字节变成明文。

**自己验证**：对照「`inspectFrames` 从哪来」那段，问自己「没开 `enable://inspect` 也没自定义解析器时这条连接走哪条路径」；再对照「按 `reqId` 而非按协议登记」这句，确认一条 WebSocket 连接与一条裸 TCP 连接会拿到不同的键、而不是共用协议名。

## 常见误解

1. **容易以为 `socket-mgr` 是连接池，其实它是按 `reqId` 登记的连接上下文字典**：它不复用、不排队、不预建连接，`conns[reqId]` 的生命周期严格跟随会话，两侧都 `end` 才由 `handleClose` 清理；把它当连接池，会去找根本不存在的空闲队列与复用阈值，对照见[《易混淆概念辨析》](/concepts/08-confusions)。
2. **容易以为 22 秒是无条件恒定心跳，其实只有暂停 / 忽略态才保留**：`clearTimer` 在「既不 pause 也不 ignore」时反而 `clearInterval`，正常转发态靠真实帧流动保活、下一次 tick 就停掉控制帧；把方向读反，会误判界面暂停时连接是不是还活着。
3. **容易以为 1MB 截断与 5 帧拼接上限会丢掉真实数据，其实它们只砍观测用的帧缓存**：`getBinary` 截断、`cleanCacheFrames` 清理约束的都是送进 UI 的那份缓存，转发出去的仍是原帧；把「界面上帧被截断」当成「数据没发全」就找错了层。
4. **容易以为只有 WebSocket 才能抓帧，其实任意端口的裸 TCP 也能按帧检视**：`enable://inspect` 与 `x-whistle-frame-parser` 让插件自定义分隔符切帧，`conns[reqId]` 同时承载两类帧；区别只在 `ws-parser` 切还是插件切、内容是明文还是密文。

## 小结

- `lib/socket-mgr.js` 是按 `conns[reqId]` 组织的连接上下文与帧处理中心，`handleClose` 确保两侧都关闭才收尾。
- `handleConnect` 无需抓帧时 `req.pipe(res).pipe(req)`，需抓帧时构建双 Transform 与 `pipeStream` 插件管道。
- upgrade 经 `util.getFullUrl` 生成 ws/wss，本地构造 101 时自算 `Sec-WebSocket-Accept`，`handleFrames` 把连接交给 `socketMgr`。
- `ws-parser` 负责收发器，`frameScript` 过滤单帧，pause/ignore 状态机、暂停期 22 秒心跳（正常态停）、1MB 截断与 5 帧拼接上限共同约束资源。
- 任意端口 CONNECT 记为 `tunnel://host:port`，`enable://inspect` 与 `x-whistle-frame-parser` 让插件按帧解析裸 TCP。
- 本篇为 [《抓包数据的采集与上报》](/core/capture-data) 准备了「连接与帧都已就位」这个起点：正因 `socket-mgr` 把每帧、每条会话都归到 `reqId` 名下，12 才能接着问「这些被采样的数据如何被缓存、瘦身，并以短轮询送到界面」。

## 下一步

[《抓包数据的采集与上报》](/core/capture-data)：连接与帧都已就位，最后看这些数据如何被采样、缓存，并以短轮询送到界面。 紧接着读它，是因为本篇把「帧与连接上下文由谁管」讲清了，却留下一个未解问题：帧脚本放行的那些帧、以及被旁路采样的字节，最终以什么形式存在内存里、又怎么被界面拉走；12 正好接手 `data-server` 与 cgi 通道，把这条「从内核到界面」的最后一公里补上。
