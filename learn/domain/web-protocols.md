---
title: HTTP/2、WebSocket 与流量形态
description: 对比各协议的帧结构，说明 Whistle 的协议入口与 body 改写的真实代价。
---

# HTTP/2、WebSocket 与流量形态

把 [TLS](/concepts/03-tls) 拆开之后，代理拿到的「明文」并不都是同一种东西：HTTP/1.1 是一条顺序的请求/响应流，HTTP/2 是并发的多个 stream，WebSocket 升级后是一串[帧](/concepts/05-capture)，[SSE](/concepts/02-http) 是不结束的响应流，TCP 隧道里甚至没有应用层语义。本节解释这些形态的差异，并对照 Whistle 各自的入口与处理文件。读完你能判断一条流量能不能改写、该在哪一层改写、以及改写要付什么代价。 承接 03 拆出的明文，本篇回答「这些明文各自是什么形状、能在哪一层动手」，读完进入 05 就能把三篇领域知识收拢成一套工作流。

::: tip 先修知识
本篇承接 [《HTTPS、证书链与中间人》](/domain/tls-mitm)（前置 03，再往前是 02 与 01 的地图），需要你已经熟悉 HTTP 请求/响应模型、状态码与常见头部，知道 `Content-Encoding` 与 `Transfer-Encoding` 的区别，并接受前两篇的结论：隧道默认只透传、装了根证书才能拆出明文。若对分块传输、内容编码、持久连接、协议升级与帧结构不熟悉，可先读 [《概念精解 · HTTP 报文与连接语义》](/concepts/02-http)；想回看握手期的协议协商可读 [《概念精解 · 证书与信任》](/concepts/03-tls)，想回看隧道与进门可读 [《概念精解 · 代理与流量入口》](/concepts/01-proxy)。

前两篇的 [CONNECT](/concepts/01-proxy) 与 [MITM](/concepts/03-tls) 结论会在这里反复用到。不要求预先读过 Whistle 源码。

给完全没读过源码的读者补三个基本词：TCP 是可靠搬运字节的管道；HTTP/1.1 是在这条管道上「一个请求、一个响应」顺序往返的文本；HTTPS 只是把这段文本加密后再送进 TCP。前两篇拆开加密之后，代理拿到的是「明文」，但明文不都长一个样：有的按顺序排队、有的并发多路、有的升级成一串帧、有的干脆没有应用层语义——本篇就是给这些形态分类，并说明每类能改写多少。

全站阅读地图见 [《站点导览与代码地图》](/guide/orientation) 的「全站编排与编号」表：本篇是领域基础 04，下一篇 05 用「能力模型」把 02–04 收拢成调试工作流，之后才进入架构篇与核心链路篇把这些入口拼成进程。概念词典总入口是 [《概念精解：从名词到工程直觉》](/concepts/index)，忘记名词查 [《全量术语索引》](/concepts/glossary)。
:::

## 从持久连接到多路复用

### HTTP/1.1：持久连接、chunked、gzip

HTTP/1.1 允许一条 TCP 连接顺序承载多个请求（keep-alive），但**同一时刻只能有一个响应在途**，后面的必须排队，这就是队头阻塞。响应体长度有两种表达：已知长度用 `Content-Length`，边生成边发用 `Transfer-Encoding: chunked`；内容编码 `Content-Encoding: gzip` 则是把实体压缩后再传。注意两者影响的是不同层面：chunked 是传输分块，gzip 是内容变换，可以同时存在。

为什么会成为改写难点？因为 `Content-Length` 是字节数，一旦解压并替换了内容，原值就必然失效——这一点在后面的「改写 body 的代价」里会成为主线。

把「同一时刻只能有一个响应在途」再展开一句：HTTP/1.1 复用连接省下了反复建连的开销，却因为没有给每个请求编号，服务器无法交错回送，慢响应会挡住后面所有请求——这就是队头阻塞。代价写得很清楚：连接是省了，并发没换来；要并发就得像 HTTP/2 那样引入 stream id。

这也是为什么 `Content-Length` 一旦失效不能含糊：字节数是客户端判断「这个响应结束了没」的依据，改了内容却留着旧值，连接就会错把下一段数据当成上一个响应的尾巴。

### HTTP/2：伪头、多路复用与 ALPN

HTTP/2 把报文拆成 HEADERS / DATA 帧，用 stream id 标识归属，多个 stream 可以在同一条连接上并发交错，从而消除应用层的队头阻塞。头部不再写 `GET /path HTTP/1.1` 这类起始行，而是用 `:method`、`:path`、`:authority`、`:scheme` 等[伪头](/concepts/02-http)表示；这些以冒号开头的字段在降级到 HTTP/1.1 时必须被剔除或翻译成 `Host`。反过来，出站重建 h2 请求也要造伪头：`lib/https/h2.js:276-278` 把 `options.path` / `method` / `headers.host` 写成 `:path` / `:method` / `:authority`，响应状态则从 `:301` 的 `:status` 读出——与入站降级（`lib/https/index.js:1030-1043`）恰好是相反方向。

协议的选择发生在 TLS 握手的 ALPN 阶段（前一篇提过 `lib/https/h2.js:10` 的 `SUPPORTED_PROTOS`）。`SUPPORTED_PROTOS` 不止是常量：`lib/https/h2.js:159,223` 把它作为 `ALPNProtocols` 写进出站 TLS 选项，客户端在 ClientHello 里声明 `h2` / `http/1.1`；入站是否启用 h2 则由 `lib/https/ca.js:714` 的 `options.allowHTTP1 = enableH2` 控制，它决定 `getServer` 走 `http2.createSecureServer`（`lib/https/h2.js:355`）还是普通 `https.createServer`（`:363`）。Whistle 的入站侧用 `lib/https/h2.js:353-367` 的 `getServer` 创建 `http2.createSecureServer`，出站侧用 `lib/https/h2.js:247-258` 的 `http2.connect` 建连；另有 `getHttpServer`（`lib/https/h2.js:369-380`）以 `allowHTTP1: true` 处理明文 h2c。两类服务器通过 `lib/https/ca.js:609-611` 的固定端口 `42900` / `43900` 挂载，供 hagent 复用。

把「ALPN 在握手里决定协议」再展开一句：`SUPPORTED_PROTOS` 既被写进出站 TLS 选项、又决定入站走 `http2.createSecureServer` 还是普通 `https.createServer`，说明协议选择不是建连之后再猜，而是握手里就谈定的。代价是入站与出站要分别维护两套服务器，靠固定端口挂给 hagent 复用。

伪头在入站降级时被剔除、出站重建时又被造出来，方向正好相反；把这一点记住，就不会把「降级」和「重建」当成同一个函数。

### SSE：单向长流

SSE（Server-Sent Events）仍是普通 HTTP 响应，`Content-Type: text/event-stream`，但服务器不结束响应，而是持续写出以空行分隔的 `data:` 事件块。它和 chunked 一样是「流式」，只是多了约定的分帧格式。Whistle 在[抓包](/concepts/05-capture)展示层用 `SSE_SEP = Buffer.from('\n\n')`（`lib/inspectors/data.js:14`）作分隔符：`lib/inspectors/data.js:337` 识别出 `text/event-stream` 后，`:348-349` 调用 `parseFrame`（定义在 `:98-126`，用 `buf.indexOf(SSE_SEP)` 循环切分并逐块 `emitFrame`）把累积的 `resBody` 切成一条条事件；若不按事件边界切分，界面上就会看到一坨粘在一起的字节。

**为什么这样设计**：HTTP/1.1 允许一条连接顺序承载多个请求，却规定同一时刻只能有一个响应在途，是为了在不引入流标识的前提下复用连接；代价就是队头阻塞——后面的请求必须排队。把「两种长度表达」的结论展开成推理：已知长度用 `Content-Length`、边生成边发用 `Transfer-Encoding: chunked`，前者是字节数、后者是传输分块；而 `Content-Encoding: gzip` 是内容变换，与前两者不在同一层，所以 chunked 与 gzip 可以同时存在。

**HTTP/2 为什么用伪头与多路复用**：把报文拆成 HEADERS / DATA 帧、用 stream id 标识归属，多个 stream 就能在同一条连接上并发交错，从而消除应用层的队头阻塞；头部改用 `:method`、`:path`、`:authority` 等伪头，是因为不再有起始行，降级到 HTTP/1.1 时又必须把这些以冒号开头的字段剔除或翻译成 `Host`。入站降级与出站重建恰好是相反方向，记住这一点，后面看降级设计就不会把两边弄反。

**SSE 为什么单独算一类**：它仍是普通 HTTP 响应，只是服务器不结束响应、持续写出以空行分隔的 `data:` 事件块；它和 chunked 一样是「流式」，只是多了约定的分帧格式。边界是：若不按事件边界切分，界面上只会看到一坨粘在一起的字节，所以展示层才要用分隔符把累积的响应体切成一条条事件。

**打个比方**：HTTP/1.1 像单车道收费站，一次只放行一辆、后面排队；HTTP/2 像多车道高速，各走各的道却共用同一条路；SSE 则像一直不挂断的广播，内容按段播报而不是一次性交付。

**自己验证**：把 `Content-Length`、`Transfer-Encoding: chunked`、`Content-Encoding: gzip` 这几个头部归一归类——哪些管长度、哪些管分块、哪些管内容变换；能分清，就懂了为什么「改了 body 就必须删 `Content-Length`」会在最后一节成为主线。

## Upgrade、帧与 TCP 隧道

### 101 之后不再是 HTTP

WebSocket 以普通 HTTP 请求起手，带 `Upgrade: websocket` 与 `Connection: Upgrade`；服务器回 `101 Switching Protocols` 后，这条连接上跑的不再是请求/响应，而是双方随时可发的帧（文本、二进制、ping/pong、close）。因此代理不能再按「一个请求一个响应」去建模，必须换成「一条连接、双向帧序列」。

Whistle 在 `lib/upgrade.js:77-177` 的 `upgradeHandler` 里补齐客户端信息、判断是否属于插件 UI，再交给 `handleWebsocket`；`lib/https/index.js:81-87` 的 `handleFrames` 则在解密后的隧道里二选一：是 WebSocket 就走 `socketMgr.handleUpgrade`，否则按普通 CONNECT 隧道处理。

把「101 之后不再是 HTTP」再展开一步：`101 Switching Protocols` 一旦发出，这条连接就从「请求/响应」切换成「双向帧序列」，代理若还按一个请求配一个响应去缓存，就会把后续帧错当成新的请求行。代价是必须为这条连接单独维护帧的收发状态，边界是原来那套按 Header 与状态码工作的改写逻辑到这里基本失效。

这也是为什么帧成了最小的改写单位：语义边界变了，能动手的粒度也只能跟着变。

### 帧是 WebSocket 的改写单位

因为语义单位是帧，改写也必须逐帧进行。`lib/socket-mgr.js:291-301` 用 `wsParser.getReceiver` / `getSender` 构造收发器，把字节流解析成帧再编码回去；这也是插件能「拦截某一帧」的原因。相比之下，SSE 的分帧发生在抓包展示层：`lib/inspectors/data.js:331-345` 识别 `text/event-stream`、解析分隔符，并在 `lib/inspectors/data.js:348-350` 用 `parseFrame` 切出事件块。

把「逐帧改写」再展开一步：收发器把字节流解析成帧、再编码回去，意味着插件能拦的是「一帧」而不是「一个请求」；代价是每帧都要过一次解析与编码，实时链路上的开销与改写粒度绑在一起。

SSE 的分帧只发生在展示层、并不改动转发出去的字节，所以「按事件分帧抓包」与「逐帧改写」是观察与干预两种不同能力——名字里都带「帧」，动手的位置却差了一层。

### TCP 隧道没有应用层语义

若客户端发的既不是 HTTP 明文、也不是 TLS 握手，Whistle 就退回纯字节透传。此时没有方法、没有头部、没有 body，能做的只有按规则限速、改目标地址或记录流量大小——所谓「TCP 抓包」抓的是字节与元数据，不是结构化请求。

**为什么这样设计**：WebSocket 以普通 HTTP 请求起手、服务器回 `101 Switching Protocols` 之后，这条连接上跑的不再是请求/响应，而是双方随时可发的帧；因此代理不能再按「一个请求一个响应」建模，必须换成「一条连接、双向帧序列」。把结论展开成推理：正因为语义单位变成了帧，改写也必须逐帧进行——收发器把字节流解析成帧再编码回去，插件才能「拦截某一帧」；这与 SSE 在展示层按 `data:` 边界切分是两种不同层次的分帧。

**TCP 隧道为什么没有应用层语义**：若客户端发的既不是 HTTP 明文、也不是 TLS 握手，代理就退回纯字节透传；此时没有方法、没有头部、没有 body，能做的只有按规则限速、改目标地址或记录流量大小。边界也由这句话定死：所谓「TCP 抓包」抓的是字节与元数据，不是结构化请求，任何按 Header 或路径去匹配的规则到这里都不成立。

**打个比方**：WebSocket 像接通后双方可随时插话的对讲机，帧是一句句话；SSE 像只由一方持续播报的喇叭；TCP 隧道则像一根只传电流的裸线，连「一句话」的边界都没有。

**自己验证**：对照「帧是 WebSocket 的改写单位」与「TCP 隧道没有应用层语义」两节的结论，看一种流量有没有可供 `Content-Length` 描述的整体——答案是没有，正好解释了它们为什么不做整段 body 重写。

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

**为什么这样设计**：把各协议落到一张入口对照表，是因为「能不能改写」取决于流量以什么形态进门，而不是取决于规则写得多复杂——从 HTTP/1.1 的「头与 body 均可」一路递减到 TCP 隧道的「仅字节」。单独看 HTTP/2 的降级：它不在 h2 层直接改写，而是把 `:authority` 转成 `Host`、剔除伪头，再用普通请求回灌主端口；把「为什么要绕这一圈」展开成推理就是，整套规则引擎、inspectors 与抓包都建立在 HTTP/1.1 的 `req` / `res` 对象上，降级一次即可复用，不必为每个协议重写一套中间件。

**代价与边界**：明确的功能取舍是失去部分 h2 特性（多路复用、服务端推送）；换成 h2 原生改写虽然保住特性，却要让所有中间件各实现一遍。边界是：降级只解决「复用」，不解决「保真」，所以关心 h2 特性的场景要另作权衡。

**打个比方**：降级像把多路复用的高速车流先引导回单车道收费站，验完、改完再放出去；好处是所有收费规则现成可用，代价是暂时跑不出高速的并排优势。

**自己验证**：顺着 `toHttp1` 那段代码数一数伪头怎么变成 `Host`、又被怎样剔除，再对照入口表里 h2 那行写的是「降级为 h1 后改写」；两处对上，就确认了「复用优先于特性」不是口号而是具体实现。

## 改写 body 的代价

「把响应里的字符串换掉」听起来简单，实现上是一整条 Transform 流水线。`lib/init.js:87-155` 的 `addTransforms` 给 `req` / `res` 挂上 `addTextTransform` / `addZipTransform`；`lib/inspectors/rules.js:73-120` 的 `getDecoder` 读到压缩体时先 `util.getUnzipStream` 解压，`lib/inspectors/rules.js:122-133` 的 `getEncoder` 再用 `util.getZipStream` 按协商出的编码压回去（`lib/util/index.js:1591-1602` 的 `getZipStream` 提供 gzip / br / deflate / zstd 流）。也就是说，一次改写至少付出「解压 → 替换 → 压缩」两次编解码与一次全量缓冲。

随之而来两个必然后果：

- **必须删除 `Content-Length`**。`lib/init.js:106-112` 在需要 gunzip 时 `delete req.headers['content-length']`，`lib/init.js:150-154` 对响应做同样处理，`lib/inspectors/rules.js:106` 也再次兜底。长度未知后只能改用 chunked 或让 Node 重新计算。
- **必须设大小阈值**。`lib/inspectors/data.js:8-11` 定义 `MAX_SIZE`（默认 1 MB）、`MAX_REQ_BODY_SIZE` / `MAX_RES_BODY_SIZE`（默认 2 MB）与 `BIG_DATA_SIZE`（16 MB），`lib/inspectors/data.js:345` 据此决定抓包缓冲上限。为什么不全量缓存？因为代理是长驻进程，任意缓存大响应都会直接推高内存；超限就落盘或只记录元数据。

理解这两点，就能明白为什么流式协议（SSE、WebSocket 帧）通常只做「观察与逐帧替换」，而不做整段 body 重写——那会破坏流的实时性，也绕开了所有长度保护。

**为什么这样设计**：「把响应里的字符串换掉」听起来简单，实现上却是一整条解压 → 替换 → 压缩的流水线：读到压缩体先解压、按协商出的编码再压回去，一次改写至少付出两次编解码与一次全量缓冲。把两个必然后果展开成推理：其一，`Content-Length` 记的是字节数，内容一换原值必然失效，只能删除后改用 chunked 或让 Node 重算；其二，代理是长驻进程，任意缓存大响应都会推高内存，所以必须设大小阈值，超限就落盘或只记录元数据。

**代价与边界**：代价是实时性与内存——整段缓冲意味着要等 body 收齐才能改，流式协议因此通常只做「观察与逐帧替换」，而不做整段重写：那会破坏实时性，也绕开了所有长度保护。边界是这套机制只适用于有明确首尾的普通响应，SSE 与 WebSocket 帧不在其列。

**打个比方**：整段改写像把一箱货先拆封、换掉内容、再按原样封箱，箱上写的重量（长度）自然得撕掉重贴；而流式协议像传送带上的散件，只能逐件看、逐件换，没法整箱重装。

**自己验证**：对照 `MAX_SIZE` 默认 1 MB、`MAX_REQ_BODY_SIZE` / `MAX_RES_BODY_SIZE` 默认 2 MB 与 `BIG_DATA_SIZE` 16 MB 三个阈值，问自己「一条超过阈值的响应会怎样」；能答出「不进全量缓冲、只留元数据或落盘」，就理解了阈值为什么是保护而不是限制。

把这两个后果记住，下一篇 05 谈「观察是其余六类能力的地基」时，你就会明白为什么采样要走旁路、缓存要有界。

## 常见误解

1. **容易以为 `Transfer-Encoding: chunked` 与 `Content-Encoding: gzip` 是一回事，其实一个管传输分块、一个管内容变换**：两者可以同时存在；也正因 `Content-Length` 记的是字节数，一旦解压并替换了内容原值就必然失效，必须删除。
2. **容易以为 HTTP/2 在 Whistle 里是全程按 h2 处理的，其实入站后先降级为 HTTP/1.1 再复用整套中间件**：因为规则引擎、inspectors 与抓包都建立在 HTTP/1.1 的 `req` / `res` 对象上，降级一次即可复用，代价是失去多路复用与服务端推送，对照见[《易混淆概念辨析》](/concepts/08-confusions)。
3. **容易以为 WebSocket 与 SSE 都是「流式」就能用同一种改写方式，其实二者的分帧层不同**：WebSocket 在连接层逐帧收发，SSE 的分帧发生在展示层按 `data:` 事件边界切分；流式协议通常只做观察与逐帧替换，不做整段 body 重写。
4. **容易以为「TCP 抓包」抓的是结构化请求，其实隧道里没有方法、头部与 body**：既不是 HTTP 明文也不是 TLS 握手时，代理只能按规则限速、改目标地址或记录流量大小，抓到的是字节与元数据。

## 小结

- HTTP/1.1 顺序排队、HTTP/2 多路复用并用伪头，ALPN 在握手里决定协议。
- WebSocket 经 101 升级后以帧为单位，SSE 是不结束的事件流，TCP 隧道无应用层语义。
- 各协议分别落在 `request` / `connect` / `upgrade` 入口，能力从「头与 body」递减到「仅字节」。
- HTTP/2 先降级为 HTTP/1.1 再复用整套中间件，是复用优先于特性的设计取舍。
- body 改写要解压、替换、压缩并删除 `Content-Length`，且受抓包大小阈值约束。
- 本篇为 [《抓包调试的能力模型》](/domain/debugging-workflow) 准备了各协议的入口与改写代价：知道哪些流量能整段改、哪些只能逐帧或仅字节，05 才能把它们归纳成七类能力。

## 下一步

下一篇是[《抓包调试的能力模型》](/domain/debugging-workflow)，把三篇领域知识收拢成调试工作流；若想直接看这些入口如何拼成整体，可跳到[《一张图看懂全局架构》](/architecture/overview)。 紧接着读 05，是因为 02–04 分别讲了进门、解密、形态，还缺一张「这些能力合起来能做什么」的总图；05 用能力模型收口，正好作为进入架构篇前的最后一块拼图。
