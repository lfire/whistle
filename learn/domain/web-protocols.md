---
title: HTTP/2、WebSocket 与流量形态
description: 对比各协议的帧结构，说明 Whistle 的协议入口与 body 改写的真实代价。
---

把 TLS 拆开之后，代理拿到的「明文」并不都是同一种东西：HTTP/1.1 是一条顺序的请求/响应流，HTTP/2 是并发的多个 stream，WebSocket 升级后是一串帧，SSE 是不结束的响应流，TCP 隧道里甚至没有应用层语义。本节解释这些形态的差异，并对照 Whistle 各自的入口与处理文件。读完你能判断一条流量能不能改写、该在哪一层改写、以及改写要付什么代价。

::: tip 先修知识
熟悉 HTTP 请求/响应模型、状态码与常见头部；知道 `Content-Encoding` 与 `Transfer-Encoding` 的区别。前两篇的 CONNECT 与 MITM 结论会在这里反复用到。
:::

## 从持久连接到多路复用

### HTTP/1.1：持久连接、chunked、gzip

HTTP/1.1 允许一条 TCP 连接顺序承载多个请求（keep-alive），但**同一时刻只能有一个响应在途**，后面的必须排队，这就是队头阻塞。响应体长度有两种表达：已知长度用 `Content-Length`，边生成边发用 `Transfer-Encoding: chunked`；内容编码 `Content-Encoding: gzip` 则是把实体压缩后再传。注意两者影响的是不同层面：chunked 是传输分块，gzip 是内容变换，可以同时存在。

为什么会成为改写难点？因为 `Content-Length` 是字节数，一旦解压并替换了内容，原值就必然失效——这一点在后面的「改写 body 的代价」里会成为主线。

### HTTP/2：伪头、多路复用与 ALPN

HTTP/2 把报文拆成 HEADERS / DATA 帧，用 stream id 标识归属，多个 stream 可以在同一条连接上并发交错，从而消除应用层的队头阻塞。头部不再写 `GET /path HTTP/1.1` 这类起始行，而是用 `:method`、`:path`、`:authority`、`:scheme` 等伪头表示；这些以冒号开头的字段在降级到 HTTP/1.1 时必须被剔除或翻译成 `Host`。

协议的选择发生在 TLS 握手的 ALPN 阶段（前一篇提过 `lib/https/h2.js:10` 的 `SUPPORTED_PROTOS`）。Whistle 的入站侧用 `lib/https/h2.js:353-367` 的 `getServer` 创建 `http2.createSecureServer`，出站侧用 `lib/https/h2.js:247-258` 的 `http2.connect` 建连；另有 `getHttpServer`（`lib/https/h2.js:369-380`）以 `allowHTTP1: true` 处理明文 h2c。两类服务器通过 `lib/https/ca.js:609-611` 的固定端口 `42900` / `43900` 挂载，供 hagent 复用。

### SSE：单向长流

SSE（Server-Sent Events）仍是普通 HTTP 响应，`Content-Type: text/event-stream`，但服务器不结束响应，而是持续写出以空行分隔的 `data:` 事件块。它和 chunked 一样是「流式」，只是多了约定的分帧格式；抓包工具若不按事件边界切分，界面上会看到一坨粘在一起的字节。

## Upgrade、帧与 TCP 隧道

### 101 之后不再是 HTTP

WebSocket 以普通 HTTP 请求起手，带 `Upgrade: websocket` 与 `Connection: Upgrade`；服务器回 `101 Switching Protocols` 后，这条连接上跑的不再是请求/响应，而是双方随时可发的帧（文本、二进制、ping/pong、close）。因此代理不能再按「一个请求一个响应」去建模，必须换成「一条连接、双向帧序列」。

Whistle 在 `lib/upgrade.js:77-177` 的 `upgradeHandler` 里补齐客户端信息、判断是否属于插件 UI，再交给 `handleWebsocket`；`lib/https/index.js:81-87` 的 `handleFrames` 则在解密后的隧道里二选一：是 WebSocket 就走 `socketMgr.handleUpgrade`，否则按普通 CONNECT 隧道处理。

### 帧是 WebSocket 的改写单位

因为语义单位是帧，改写也必须逐帧进行。`lib/socket-mgr.js:291-301` 用 `wsParser.getReceiver` / `getSender` 构造收发器，把字节流解析成帧再编码回去；这也是插件能「拦截某一帧」的原因。相比之下，SSE 的分帧发生在抓包展示层：`lib/inspectors/data.js:331-345` 识别 `text/event-stream`、解析分隔符，并在 `lib/inspectors/data.js:348-350` 用 `parseFrame` 切出事件块。

### TCP 隧道没有应用层语义

若客户端发的既不是 HTTP 明文、也不是 TLS 握手，Whistle 就退回纯字节透传。此时没有方法、没有头部、没有 body，能做的只有按规则限速、改目标地址或记录流量大小——所谓「TCP 抓包」抓的是字节与元数据，不是结构化请求。

## Whistle 的协议入口与改写能力

把前两节落到代码上，可以得到一张入口对照表：

| 协议 | 入口事件 | 处理文件 | 能否改写 |
|---|---|---|---|
| HTTP/1.1 | `request` | `lib/init.js` | 头与 body 均可 |
| HTTPS | `connect` 后回流 | `lib/https/index.js` | 解密后同 HTTP |
| HTTP/2 (h2) | `connect` + ALPN | `lib/https/h2.js` | 降级为 h1 后改写 |
| h2c | 首包识别 | `lib/https/index.js` | 降级后改写 |
| WebSocket | `upgrade` | `lib/upgrade.js` | 逐帧改写 |
| SSE | `request` 响应流 | `lib/inspectors/data.js` | 按事件分帧抓包 |
| TCP 隧道 | `connect` | `lib/tunnel.js` | 仅字节，不改写 |

值得单独看 HTTP/2 的降级设计。`lib/https/index.js:1013-1100` 的 `toHttp1` 并不在 h2 层直接改写，而是把 `:authority` 转成 `Host`、剔除以 `:` 开头的伪头，再用普通 `http.request` 回灌主端口：

```js
// lib/https/index.js:1030-1043
var host = req.headers[':authority'];
var headers = req.headers;
if (host) {
  req.headers.host = host;
  var newHeaders = { host: host };
  Object.keys(headers).forEach(function (name) {
    if (name[0] !== ':') {
      newHeaders[name] = headers[name];
    }
  });
  headers = newHeaders;
} else {
  headers = formatRawHeaders(req);
}
```

为什么要绕这一圈？因为整套规则引擎、inspectors 与抓包都建立在 HTTP/1.1 的 `req` / `res` 对象上；把 h2 降级一次，所有既有能力就能复用，不必为每个协议重写一套中间件。代价是失去部分 h2 特性（多路复用、服务端推送），这是明确的功能取舍。

## 改写 body 的代价

「把响应里的字符串换掉」听起来简单，实现上是一整条 Transform 流水线。`lib/init.js:87-155` 的 `addTransforms` 给 `req` / `res` 挂上 `addTextTransform` / `addZipTransform`；`lib/inspectors/rules.js:73-119` 的 `getDecoder` 读到压缩体时先 `util.getUnzipStream` 解压，`lib/inspectors/rules.js:122-133` 的 `getEncoder` 再用 `util.getZipStream` 按协商出的编码压回去（`lib/util/index.js:1593-1605` 提供 gzip 等流）。也就是说，一次改写至少付出「解压 → 替换 → 压缩」两次编解码与一次全量缓冲。

随之而来两个必然后果：

- **必须删除 `Content-Length`**。`lib/init.js:106-112` 在需要 gunzip 时 `delete req.headers['content-length']`，`lib/init.js:150-154` 对响应做同样处理，`lib/inspectors/rules.js:106` 也再次兜底。长度未知后只能改用 chunked 或让 Node 重新计算。
- **必须设大小阈值**。`lib/inspectors/data.js:8-11` 定义 `MAX_SIZE`（默认 1 MB）、`MAX_REQ_BODY_SIZE` / `MAX_RES_BODY_SIZE`（默认 2 MB）与 `BIG_DATA_SIZE`（16 MB），`lib/inspectors/data.js:345` 据此决定抓包缓冲上限。为什么不全量缓存？因为代理是长驻进程，任意缓存大响应都会直接推高内存；超限就落盘或只记录元数据。

理解这两点，就能明白为什么流式协议（SSE、WebSocket 帧）通常只做「观察与逐帧替换」，而不做整段 body 重写——那会破坏流的实时性，也绕开了所有长度保护。

## 小结

- HTTP/1.1 顺序排队、HTTP/2 多路复用并用伪头，ALPN 在握手里决定协议。
- WebSocket 经 101 升级后以帧为单位，SSE 是不结束的事件流，TCP 隧道无应用层语义。
- 各协议分别落在 `request` / `connect` / `upgrade` 入口，能力从「头与 body」递减到「仅字节」。
- HTTP/2 先降级为 HTTP/1.1 再复用整套中间件，是复用优先于特性的设计取舍。
- body 改写要解压、替换、压缩并删除 `Content-Length`，且受抓包大小阈值约束。

## 下一步

下一篇是[《抓包调试的能力模型》](/domain/debugging-workflow)，把三篇领域知识收拢成调试工作流；若想直接看这些入口如何拼成整体，可跳到[《一张图看懂全局架构》](/architecture/overview)。
