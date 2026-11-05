---
title: 隧道、WebSocket 与帧拦截
description: 以 socket-mgr 为中心，串起连接上下文、双向流拼接、ws-parser 帧处理与 TCP 抓包。
---

# 隧道、WebSocket 与帧拦截

上一篇看到 CONNECT 的两条分支最后都汇成一对双向字节流；WebSocket 的 upgrade 同样如此，只是多了 101 应答与帧结构。本篇把这两类流量放到同一个模块下理解：`lib/socket-mgr.js` 名字容易被当成连接池，实际上它是「连接上下文 + 双向流 + 帧处理中心」。读完你能说清一条连接何时被直接对拼、何时被插入双 Transform，以及帧脚本、暂停状态与心跳各自落在哪一段代码上。

![socket-mgr 的连接上下文与帧处理中心](/diagrams/socket-mgr.svg)
*图注：每条连接以 reqId 登记到 conns，按是否需要抓帧选择纯对拼或双 Transform 管道。*

## socket-mgr 不是连接池

`lib/socket-mgr.js:10` 只有一个 `var conns = {}`，`:19-21` 导出的初始化函数也仅保存 `proxy` 引用。它不复用、不排队、不预建连接，而是按 `reqId` 登记每条活跃连接的上下文：`getContext` 把 `req` / `res`、双向状态、帧收发器组装成一个 `ctx` 存进 `conns[reqId]`，`handleClose`（`:23-53`）在两侧 socket 任一关闭时取出该 `ctx` 执行 `clearup()`，并靠 `_hasClosed` 标志确保「两侧都关掉」才算真正结束。

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

## 帧解析、脚本与流控

帧层面的能力依赖 `ws-parser`（`package.json:64`）。`lib/socket-mgr.js:291-301` 的 `getReceiver` / `getSender` 分别调用 `wsParser.getReceiver` 与 `wsParser.getSender`，把裸字节流翻译成 WebSocket 帧事件；`:325` 起的 `handleWsSend` / `handleWsReceive` 再把帧送进 `frameCtx` 过滤。

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

`PAUSE_STATUS` / `IGNORE_STATUS` 由 `setConnStatus`（`:63-84`）实现：暂停时挂起帧、等待 UI 放行，忽略时丢弃当前分块并回调，两者都是可恢复的状态机而非销毁连接；`getStatus`（`:55-61`）只在状态真正变化时才返回新值，避免重复触发。`INTERVAL = 22 * 1000` 驱动 `:366-375` 与 `:498-502` 的 PING / PONG 心跳，每 22 秒写一次控制帧，`clearTimer`（`:284-289`）在状态既不暂停也不忽略时把定时器清掉。

`MAX_PAYLOAD` 取自 `util.MAX_FRAME_PAYLOAD`（`lib/util/index.js:4012`，1MB），`:219-221` 的 `getBinary` 会把超长帧截断；`MAX_COMPOSE_FRAME_COUNT = 5` 则限制一次最多拼接 5 个分片（`:348`、`:478`、`:616`、`:948`），防止恶意分片把内存撑爆。`handleWsSend`（`:325`）与 `handleWsReceive` 在每帧经过时调用 `execHandleFrame`、累计 `status.data`，再由 `cleanCacheFrames`（`:835`）清理已消费的帧缓存——这些上限共同把「可交互的帧调试」约束在可控的内存预算内。

## 任意端口的 TCP 抓包

不解密分支里，任意端口的 CONNECT 都被记成 `tunnel://host:port`（`lib/tunnel.js:75`），并携带 `reqSocket.fullUrl = tunnelUrl`、`reqSocket.inspectFrames = inspect`（`:650-651`）。`inspect` 来自 `:312-313` 的 `util.isInspect(enable)`（对应 `enable://inspect`）或 `util.isCustomParser(req)`，也就是只要用户显式要求检视，纯字节流也会进入 `socketMgr.handleConnect` 的抓帧路径。

对非 WebSocket 的裸 TCP 流，`ws-parser` 并不适用，因此插件可以声明 `x-whistle-frame-parser` 头提供自定义帧解析器（该头名见 `lib/plugins/compat.js:52`，在 `lib/tunnel.js:476` 与 `lib/https/index.js:665` 被消费后删除）。`lib/socket-mgr.js:768` 取出 `customParser` 后，`:802-803` 的分支会 `removePending(reqId)` 并进入 `getFrameCtx`，让插件按自己的分隔符切帧，再把帧送往 UI。这也解释了为什么 `conns[reqId]` 要按 `reqId` 而非按协议登记：同一套上下文既要承载 WebSocket 帧，也要承载插件自定义的 TCP 帧。

## 小结

- `lib/socket-mgr.js` 是按 `conns[reqId]` 组织的连接上下文与帧处理中心，`handleClose` 确保两侧都关闭才收尾。
- `handleConnect` 无需抓帧时 `req.pipe(res).pipe(req)`，需抓帧时构建双 Transform 与 `pipeStream` 插件管道。
- upgrade 经 `util.getFullUrl` 生成 ws/wss，本地构造 101 时自算 `Sec-WebSocket-Accept`，`handleFrames` 把连接交给 `socketMgr`。
- `ws-parser` 负责收发器，`frameScript` 过滤单帧，pause/ignore 状态机、22 秒心跳、1MB 截断与 5 帧拼接上限共同约束资源。
- 任意端口 CONNECT 记为 `tunnel://host:port`，`enable://inspect` 与 `x-whistle-frame-parser` 让插件按帧解析裸 TCP。

## 下一步

[《抓包数据的采集与上报》](/core/capture-data)：连接与帧都已就位，最后看这些数据如何被采样、缓存，并以短轮询送到界面。
