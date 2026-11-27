---
title: 抓包数据的采集与上报
description: 拆解旁路采样、大小阈值、有界缓存与 gzip 短轮询，说明数据对象原地更新的取舍。
---

# 抓包数据的采集与上报

前三篇把请求、隧道与 [帧](/concepts/05-capture) 都送到了内核，而 [《隧道、WebSocket 与帧拦截》](/core/tunnel-websocket) 把每帧、每条会话都归到 `reqId` 名下之后，留下一个未解问题：这些数据究竟怎样被采下来、暂存在内存里，又怎么送到界面。本篇回答的正是「用户最终在界面上看到的那些数据从哪来」。关键结论有两个：采集是**旁路**的，覆盖流的 `write` / `end` 只做采样、不阻塞转发；上报是 **gzip 压缩的 HTTP JSON 短轮询**，不是 [SSE](/concepts/02-http) 也不是 WebSocket。读完你能说清一个 body 为何会被丢弃、缓存如何瘦身，以及「UI 与内核读同一个对象」带来的便利与风险。

::: tip 先修知识
本篇承接 [《一次 HTTP 代理请求的旅程》](/core/http-request)（前置 09）、[《CONNECT 判定与 TLS 解密》](/core/connect-mitm)（前置 10）与 [《隧道、WebSocket 与帧拦截》](/core/tunnel-websocket)（前置 11）：需要你已经理解 09 的 16 步 Express 主干里 `data` 对象在 `rules → req → data → res` 之间被构造并广播、10 的「解密与不解密都汇入双向流」、以及 11 的「连接与帧按 `reqId` 归并，`frameScript` / 状态机 / 帧缓存都在 `socket-mgr` 里」。若对 Stream、`pipe`、背压与 `write` / `end` 的语义不熟悉，可先读 [《概念精解 · Node 运行时与内核骨架》](/concepts/04-runtime)；对 SSE 与分帧可查 [《概念精解 · HTTP 报文与连接语义》](/concepts/02-http)；对抓包、inspector、`reqId`、帧与帧缓存可查 [《概念精解 · 抓包数据面与帧》](/concepts/05-capture)；对 `MAX_PAYLOAD_SIZE` 那条「为求值而预读」的规则配置可查 [《概念精解 · 规则 DSL 全景》](/concepts/06-rules)；想按时间顺序看一次请求的完整贯通可读 [《概念精解 · 综合贯通：一次 HTTPS 请求里的全部概念》](/concepts/09-walkthrough)。

不需要预先读过源码，但知道 `data` 对象从 09 起就与内核共用同一个引用会更轻松；成对辨析可查 [《易混淆概念辨析》](/concepts/08-confusions)，忘记名词查 [《全量术语索引》](/concepts/glossary)。

给不熟源码的读者补三个基本词：「采样」是转发时顺手记一份副本、不额外等数据；「有界缓存」是给这份副本定的容量与淘汰规则，防止内存被大响应撑满；「短轮询」是界面每隔一小段时间主动来问一次「有没有新数据」，而不是服务端把数据推过来。本篇要回答的，正是这三者如何把内核里的一份 `data` 对象变成界面上的记录。
:::

![抓包数据从采集到上报的通道](/diagrams/capture-data.svg)
*图注：inspectors 旁路采样后写入有界缓存，界面以 gzip 短轮询经 cgi-bin 拉取。*

## 采集是旁路：inspectors 顺序与事件

`lib/inspectors/index.js:1-8` 固定了 `rules → req → data → res` 的顺序，`data` 夹在「请求改写」与「响应改写」之间，正好能在两侧流被包装之后、真正出站之前挂上采样钩子。`lib/inspectors/data.js:542-551` 的中间件本体只做两件事：调用 `emitDataEvents(req, res, this)`，再按 `req.rules.reqDelay` 延时 `next()`。

采样的核心手法是覆盖流的写入方法，而不是让数据改走一条旁路管道。`lib/inspectors/data.js:279-323` 保存原始 `stream.write` / `stream.end`，换成先累加长度、拼接 Buffer、再 `write.apply(this, arguments)` 的包装；响应侧 `:364-409` 完全对称。因此每个数据块仍被立即转发给下游，[抓包](/concepts/05-capture) 只是顺手记一份，链路上没有额外的等待点。

```js
// lib/inspectors/data.js:279-302（节选）
var write = stream.write;
var end = stream.end;
stream.write = function (chunk) {
  if (chunk) {
    reqData.size += chunk.length;
    reqBody = util.joinBuffer(reqBody, chunk);
    if (reqData.size > maxReqSize) {
      reqBody = false;
    }
  }
  return write.apply(this, arguments);
};
```

`lib/inspectors/data.js:55-185` 构造的 `data` 对象在 `:185` 以 `proxy.emit('request', reqEmitter, data)` 广播到事件总线；此前 `:59-61` 已用 `showPluginReq` 与 `isHide` 过滤掉不该记录的插件内部请求与隐藏请求。此后 `reqEmitter` 会在请求发出、响应到达、流结束或中断时分别抛出 `send`（`:430`）、`response`（`:439`）、`end`（`:405`）、`abort`（`:482`）四个事件。这里刻意分成两级：`proxy` 上的 `request` 只播一次用于登记会话，而 `reqEmitter` 是每条请求专属的发射器，负责后续状态迁移；否则所有监听者都要自己按 [`reqId`](/concepts/05-capture) 过滤，事件总线会被无关回调塞满。

`reqDelay` 在 `data.js:544-550` 生效，`resDelay` 则在 `lib/inspectors/res.js:1162-1173` 卡在回写之前，两者只影响时序、不影响采样结果。值得注意的是采样与规则改写共用同一份被 `PipeStream` 包装过的流：`data.js` 覆盖的是出站请求的 `write`，`res.js` 的 Transform 也在同一条链上，因此抓到的是改写后的字节，而非客户端原始报文——这与「界面所见即实际发出」的调试预期一致。

把「旁路」这句结论再展开一步：若采集另起一条管道，就得把同一份字节复制一遍、还得和改写链争用同一条流；改成覆盖写入方法，等价于在原有流水线上装一个只读取、不拦路的计数器。这样采集与转发天然并行，链路上不会多出一个等待点，也就不存在「为了抓包拖慢请求」这回事。

**为什么 `data` 要夹在 `req` 与 `res` 之间**：`rules → req → data → res` 这个顺序不是随便排的。把结论展开：`req` 先把请求侧改写以 Transform 形式注册到流上，`res` 才处理响应侧；`data` 卡在两者中间，正好在「两侧流已被包装、但还没真正出站」的时点挂上采样钩子。若把它挪到 `res` 之后，请求体早已发走、采样窗口就错过了；挪到 `req` 之前，流还没被包装、挂不上钩子。四个 [inspector](/concepts/05-capture) 共用同一条被包装过的流，是这里的关键前提。代价是顺序写死在 index 里、任何一环调整都要重看这段时序；边界是它只决定「何时挂」，`data` 本身不参与改写与转发决策。

**为什么采样覆盖 `write` / `end`，而不是让数据改走旁路管道**：包装后的 `write` 先累加长度、拼 Buffer，再 `write.apply(this, arguments)` 把原调用原样交回下游；`end` 时再统一解压与收尾。这里覆盖的是 [Stream](/concepts/04-runtime) 的写入方法，而不是新接一条 [pipe](/concepts/04-runtime) 管道——每个数据块都被立即转发，抓包只是顺手记一份。把这句展开：一旦另起管道，就得复制字节、协调两条流的结束时机，还可能与 gzip 解压重压缩的 Transform 打架；覆盖写入则完全不改变数据去向，只在旁边做记账。代价是所有写入都要过一层包装函数，边界是它只影响「被包装过」的出站流，未走 `init` 包装的流量不在这条路径上。

**为什么事件要分成 `proxy` 与 `reqEmitter` 两级**：`proxy.emit('request', reqEmitter, data)` 在事件总线上只播一次用于登记会话，之后 `send` / `response` / `end` / `abort` 都由这条请求专属的发射器抛出。把结论展开：若所有状态迁移都往全局总线上抛，每个监听者都得自己按 `reqId` 过滤无关回调，总线很快被塞满；分成两级，等于「登记」走广播、「状态」走专线。此前用 `showPluginReq` 与 `isHide` 过滤掉插件内部请求与隐藏请求，也是为了让登记的那一份名单干净。代价是监听者要同时认得两级发射器；边界是 `reqEmitter` 只服务当前这一次请求。

**为什么界面看到的是「改写后的字节」而不是原始报文**：采样与规则改写共用同一份被 `PipeStream` 包装过的流，`data.js` 覆盖的是出站请求的 `write`，`res.js` 的 Transform 也在同一条链上。把这句展开：改写以流式 Transform 挂在流上时，先流过的数据已经是被替换过的，采样点就在这之后，因此抓到的自然与实际发出的那一份一致。这与「界面所见即实际发出」的调试预期正好吻合。代价是想要「客户端原始报文」就得另找途径、本篇这套采集给不了；边界是它只保证「与出站一致」，不保证「与浏览器地址栏或原始输入一致」。

**输入 → 动作 → 输出**：输入是一对已包装好的 `req` / `res` 与 `req.rules`，动作是在 `data` 这一环覆盖写入方法做旁路采样、构造并广播 `data` 对象、由 `reqEmitter` 抛出四类状态迁移、按 `reqDelay` 延时 `next()`，输出是一份随请求推进不断补全的抓包记录，以及一条照常 `next()`、不因采集而停顿的转发链。

**代价与边界**：旁路换来「转发零等待」，代价是 `data` 对象在会话期常驻、字段随请求不断变化，界面读到的是同一个引用而非快照；边界是 `reqDelay` / `resDelay` 只改时序不改采样结果，二者分卡在回写前后、互不覆盖。把「延时」误当成「采集被推迟」，就会找错这段的作用点。

**打个比方**：`data` 这一环像快递传送带旁的扫码员——包裹（数据块）照原样往前走，他只顺手扫一下记进系统（采样），既不把包裹拿去另一条线（旁路管道），也不让传送带停下来等他（阻塞转发）；`reqDelay` 则像让下一站晚一点开工，并不影响已经扫过的记录。

**自己验证**：对照那段覆盖 `stream.write` 的代码，找到 `write.apply(this, arguments)` 这一行，问自己「原始写入有没有被拦下」；再数一数 `reqEmitter` 抛出的四个事件名，能答全，就理解了「一次登记、四次状态」的分级。

## 阈值表与超阈策略

抓包不可能无限制保存正文，一组常量划出了明确边界。

::: cols 34|18|48
| 常量 | 值 | 作用 |
|---|---|---|
| MAX_BODY_SIZE | 360KB | 默认 body 上限 |
| MAX_SIZE | 1MB | 非流式请求上限 |
| MAX_REQ_BODY_SIZE | 2MB | 流式请求体上限 |
| MAX_RES_BODY_SIZE | 2MB | 流式响应体上限 |
| BIG_DATA_SIZE | 16MB | bigData 模式上限 |
| MAX_PAYLOAD_SIZE | 256KB | 规则预读上限 |
| 帧 MAX_PAYLOAD | 1MB | 单帧截断 |
:::

```js
// lib/inspectors/data.js:7-14
var MAX_BODY_SIZE = 360 * 1024;
var MAX_SIZE = (config.strict ? 256 : 1024) * 1024;
var MAX_REQ_BODY_SIZE = (config.strict ? 256 : 2048) * 1024;
var MAX_RES_BODY_SIZE = (config.strict ? 256 : 2048) * 1024;
var BIG_DATA_SIZE = 1024 * 1024 * 16;
var LOCALHOST = '127.0.0.1';
var MAX_PAYLOAD = util.MAX_FRAME_PAYLOAD;
var SSE_SEP = Buffer.from('\n\n');
```

其中 `MAX_PAYLOAD_SIZE = 256KB` 来自 `lib/inspectors/rules.js:10`，用于规则预读；帧级 1MB 来自 `util.MAX_FRAME_PAYLOAD`（`lib/util/index.js:4012`），由 `lib/socket-mgr.js:219-221` 截断。超阈时的处理很克制：`data.js:291-296`、`:376-381` 直接把 `reqBody` / `resBody` 置为 `false`，放弃保存正文，但 `reqData.size`、`headers`、`statusCode`、时间字段等元信息照常保留。界面因此仍能看到「有一个 20MB 的响应」，只是 body 栏为空——这比让内存被大文件拖垮更划算。

还要注意这些值都随 `config.strict` 变化：严格模式下 `MAX_SIZE` 降到 256KB、两个 BODY 上限也降到 256KB，`checkBodySize`（`:37-45`）会二次裁剪超限 body。`unzipBody`（`:21-23`）先按 `content-encoding` 解压再采样，因此阈值约束的是明文长度而非压缩后的传输长度；`:305-320` 与 `:397-403` 在 `stream.end` 时统一做解压、`setUnzipSize` 与 `setRequestTime` / `setEndTime` 收尾，保证时间字段与正文长度一致。

SSE 是另一个特例。`data.js:98-135` 的 `parseFrame` 默认以 `\n\n`（`SSE_SEP`）切帧，`:331-355` 的 `handleResBody` 检测到 `content-type` 为 `text/event-stream` 时按帧解析而非整块缓冲，`:339-343` 还支持 `x-whistle-custom-frame-separator` 自定义分隔符。这样长连接上的事件流才能逐条呈现，而不必等到连接结束。

把「超阈就丢弃正文」这句结论再展开一步：真正要保住的是「这条会话存在、有多大、耗时多久」这类元信息，正文只是其中最占内存、也最可被牺牲的一部分。把 `reqBody` 置为 `false` 而不是删掉整条记录，等价于「留账单、不留货」——界面仍能看到「有一个 20MB 的响应」，只是 body 栏为空。理解了这个取舍，后面有界缓存的分级淘汰才不会读成「数据动不动就消失」。

**为什么阈值约束的是「明文长度」而不是「传输长度」**：`unzipBody` 先按 `content-encoding` 解压再采样，因此 360KB / 2MB 这些上限量的是解压后的明文，不是压缩后在网络上跑的字节数。把这句展开：gzip 之后一个 20MB 的正文可能只占几百 KB，若按传输长度算就永远触不到阈值，内存却早已被解压后的明文撑满；按明文计量，才与「缓存里实际存了多少」对齐。代价是每个响应都要多一次解压，边界是它只影响采样侧的计量，转发给客户端的仍是压缩字节。

**为什么超阈只把 `reqBody` / `resBody` 置为 `false`，元信息照常保留**：`reqData.size`、`headers`、`statusCode`、时间字段都不依赖正文内容，即便 body 被放弃也照常累计。把结论展开：调试时最常问的是「有没有这条请求、状态是多少、花了多久、响应多大」，这些都能从元信息回答；为一个可能几十 MB 的正文牺牲整条记录，反而让排障失去线索。代价是界面上 body 栏会是空的，无法回看内容；边界是「丢弃」只发生在采样缓存里，真实字节仍被转发给客户端，没有任何一个数据块被拦下。

**为什么 `config.strict` 会把几个上限一起压到 256KB**：严格模式下 `MAX_SIZE` 与两个 BODY 上限都降到 256KB，`checkBodySize` 还会二次裁剪超限 body。把这句展开：调试场景默认要尽量多留内容方便回看，而资源受限或批量运行的环境更在意内存水位，于是用同一个开关把「能存多少」整体收紧，而不是逐项手调。代价是严格模式下更容易看到空 body 栏；边界是它只改阈值，不改「超阈保留元信息」这条处理策略。

**为什么 SSE 要按 `\n\n` 分帧、而不是整块缓冲**：`parseFrame` 默认以 `SSE_SEP` 切帧，`handleResBody` 检测到 `content-type` 为 `text/event-stream` 时按帧解析，`x-whistle-custom-frame-separator` 还允许自定义分隔符。长连接上的事件流不会像普通响应那样「结束」——若等连接关闭才整块保存，界面上永远只能看到一片空白，直到连接断开才刷出全部内容。按分隔符逐条切，事件才能随到随现。代价是要为每种分隔符维护解析逻辑；边界是它只作用于 `text/event-stream` 这类流式响应，普通响应仍按整块缓冲处理。

**输入 → 动作 → 输出**：输入是流经包装流的请求 / 响应字节与 `content-encoding`、`content-type`，动作是先解压、按阈值累计明文长度、超阈则放弃正文只留元信息、SSE 按分隔符逐帧切、在 `stream.end` 统一补时间字段，输出是一份「大小受控、元信息完整、长连接可逐条呈现」的抓包记录。

**代价与边界**：这组常量把单次会话的内存占用封了顶，代价是超限内容不可回看、流式响应要多一层分帧；边界是它们约束的都是「为 [规则 DSL](/concepts/06-rules) 求值而预读」以及采集缓存这类观测用途，转发链上的字节不受影响。`MAX_PAYLOAD_SIZE = 256KB` 管的是规则预读、帧级 1MB 管的是单帧截断，两者名字相近却分属两处，别当成同一个数字。

**打个比方**：阈值表像仓库给每件货定的「最大入账体积」——超过就只登记品名、数量、到货时间（元信息），不把整箱货搬进货架（body）；SSE 则像传送带上一件件到的小包裹，按分隔符逐个扫码，不必等整批到齐才开箱。

**自己验证**：对照阈值表数一数 360KB / 1MB / 2MB / 16MB / 256KB 各自管什么，再问自己「一个 gzip 后 300KB、解压后 20MB 的响应会不会触发上限」；能答「按明文算、会触发」，就抓住了「解压后再采样」的用意。

## 有界缓存：不是 LRU

`lib/util/data-server.js:87-95` 的 `enable()` 只监听 `request` 与 `frame` 两个事件，写入的是一套**自实现的有界缓存**，源码里没有 LRU 结构：`ids[]` 保存有序 id，`reqData{}` 按 id 存对象，`framesCache[]` 存帧。

别把「不是 LRU」推广成全站结论：规则引擎的 `regUrlCache` / `hostCache`（`lib/rules/rules.js:64-65`）也只是普通对象，在规则文本解析函数末尾被整体重置为空（`:1804-1805`），靠「重建而非逐条淘汰」保证规则一变、旧匹配结果立即失效；`lru-cache` 在站内另有用处——模板与客户端证书（`lib/rules/index.js:20-21`）、证书缓存（`lib/https/ca.js:39-41`）、插件动态规则（`lib/plugins/index.js:46`），以及 `lib/https/index.js:33` 的 `tunnelTmplData`。两处不用 LRU 的原因并不相同：抓包缓存要按会话结束时间分级淘汰，URL 匹配缓存要的是整批失效而非「最近最少使用」。

```js
// lib/util/data-server.js:10-30（节选）
var CLEAR_INTERVAL = 6000;
var MAX_LENGTH = config.reqCacheSize;
var OVERFLOW_LENGTH = MAX_LENGTH * 3;
var PRESERVE_LEN = 360;
var COUNT = 100;
var ids = [];
var reqData = {};
var framesCache = [];
```

`reqCacheSize` 最小 600（`:10-12`）——CLI `-R`（`bin/whistle.js:174`、`docs/docs/cli.md:47`）标注的默认也是 600，两者一致。`proxy.getData` 单次最多返回 100 条（`COUNT`，`:26`，在 `:904` 钳制）；另有 `MAX_COUNT = 120`（`:34`）经 `formatApiOptions`（`:36-50`）限定对外 API（`getSessionsForApi` / `getFramesForApi`，`:818`、`:650`）的单次返回量，比 `COUNT` 大，别当作同一数字。

淘汰语义要按 `clearCache`（`:147-203`）逐段读，不能望文生义。它每 `CLEAR_INTERVAL = 6000` 毫秒跑一次：`ids.length <= MAX_LENGTH(600)` 时直接返回、一条不删（`:169-171`）；超过 600 后才按已结束会话的 `endTime` 清理，宽限为 `CACHE_TIME`（`:19`，2 分钟）。当 `len >= OVERFLOW_LENGTH(1800)` 时进入溢出分支，先算 `overflow = len - MAX_CACHE_SIZE`（`MAX_CACHE_SIZE = 1200`，`:23`）把最老的一批无条件淘汰，相当于先砍回 1200 条；再把 `preserveLen = len - PRESERVE_LEN`（`PRESERVE_LEN = 360`，`:24`）之后的尾部 360 条改用 `MAX_CACHE_TIME`（`:20`，6 分钟）宽限，其余仍按 2 分钟（`:176-188`）。命中淘汰的条目一律 `data.abort && data.abort(true)` 并 `delete reqData[id]`（`:193-194`），并非只在溢出时才调用。可见 `PRESERVE_LEN` 是「尾部宽限条数」而非「溢出后保留条数」；分级宽限是为了让近期会话多留一会儿供 UI 增量拉取，同时给零复制模型的常驻内存设一个硬上限。

[帧缓存](/concepts/05-capture) 另有瘦身策略。容易被混作 `reqCacheSize` 的 `frameCacheSize` 是另一路配置：CLI `-F`（`bin/whistle.js:175`、`docs/docs/cli.md:48`）标注默认 512，但 `lib/util/data-server.js:14-16` 在值小于 720 时强制设为 600，`:25` 的 `MAX_FRAMES_LENGTH` 因此实际也是 600 条——「官方 512 / 源码 600」的差异落在帧缓存上，不是请求缓存。`:103-106` 定义 `MAX_BUF_LEN1..4` 为 512 / 256 / 128 / 64KB，`:129-145` 的 `clearFrames` 按帧龄分级，把旧帧的 `bin` 逐步截断；`:156-157` 在帧数溢出时直接 `splice(0, overflow + 60)`。也就是说大帧不会永久占着内存，越旧留存越少。

```js
// lib/util/data-server.js:342-345
function handleFrame(data) {
  framesCache.push(data);
  framesMap[data.reqId] = data;
}
```

把「不是 LRU」这句结论再展开一步：LRU 解决的是「容量满了淘汰谁」，而抓包缓存要回答的是「会话结束后还留多久给界面增量拉取」。前者按访问时间、后者按结束时间，淘汰依据根本不同，硬套 LRU 反而会让刚结束、但界面还没来得及拉的会话被一次冷查询挤掉。理解了这个差别，下面那组「600 / 1800 / 1200 / 360」才不是一串随手定的数字。

**为什么用 `ids[]` + `reqData{}` + `framesCache[]` 三件套，而不是一个 LRU 对象**：`ids[]` 保存有序 id 决定淘汰顺序，`reqData{}` 按 id 存对象供按 id 直查，`framesCache` 单独存帧。把结论展开：会话要按结束时间分级淘汰（需要有序序列），又要 `getItem(id)` 按键立即取到（需要哈希），帧还要按帧龄单独瘦身（需要另一条队列）；一种结构同时满足这三件事并不划算，拆成三份各自最简单。代价是三处要手动保持一致、任何一处漏删都会留下悬空引用；边界是它只做「登记与淘汰」，不做「最近最少使用」的命中统计。

**为什么 `clearCache` 要分级宽限，而不是一到 600 就删**：`ids.length <= MAX_LENGTH(600)` 时直接返回、一条不删；超过 600 才按已结束会话的 `endTime` 清、宽限 2 分钟；到 1800 条溢出时先砍回 1200，再把尾部 360 条改用 6 分钟宽限，其余仍按 2 分钟。把这句展开：界面是短轮询增量拉取，刚结束的会话要多留一会儿才不会被「下一轮还没来就被删」；而一旦总量逼近硬上限，就必须无条件腾出空间，于是溢出分支先砍掉最老的一批、再给近期尾巴更长的宽限。代价是淘汰语义要逐段读、不能望文生义；边界是 `PRESERVE_LEN` 是「尾部宽限条数」而非「溢出后保留条数」，命中淘汰一律 `data.abort && data.abort(true)` 并 `delete reqData[id]`，并非只在溢出时才调。

**为什么 `regUrlCache` / `hostCache` 也不用 LRU，却和抓包缓存理由不同**：那两个是普通对象，在规则文本解析函数末尾被整体重置为空，靠「重建而非逐条淘汰」保证规则一变、旧匹配结果立即失效。把两句放一起看：抓包缓存要的是「按会话结束时间分级淘汰」，URL 匹配缓存要的是「整批失效」；二者都不需要「最近最少使用」，但一个靠定时清理、一个靠整体重置，路径完全不同。站内另有几处真正用 `lru-cache`（模板与客户端证书、证书缓存、插件动态规则、`tunnelTmplData`），别把「不是 LRU」推广成全站结论。代价是读代码时要按模块分别判断，边界是这里讨论的只是缓存策略、不涉及规则引擎的匹配逻辑。

**为什么 `frameCacheSize` 与 `reqCacheSize` 要分开看**：CLI `-F` 标注默认 512，但源码在值小于 720 时强制设为 600，`MAX_FRAMES_LENGTH` 因此实际也是 600 条；`-R` 的请求缓存默认同样是 600，两者一致纯属数值巧合、不是同一个配置。把这句展开：帧的数量级与单帧大小都和请求不同，`MAX_BUF_LEN1..4` 还按帧龄把旧帧的 `bin` 从 512 / 256 / 128 / 64KB 逐步截断，溢出时直接 `splice(0, overflow + 60)`；请求缓存则按会话条数淘汰。代价是「官方 512 / 源码 600」这个差异只落在帧缓存上，排障时若张冠李戴会白查一路；边界是大帧不会永久占着内存，越旧留存越少。

**输入 → 动作 → 输出**：输入是 `request` / `frame` 两个事件不断写入的会话与帧，动作是 `enable()` 把对象原地放进 `reqData[id]`、帧推进 `framesCache`、`clearCache` 每 6000 毫秒按结束时间分级淘汰、`clearFrames` 按帧龄截断旧帧的 `bin`，输出是一份「总量有硬上限、近期会话多留一会儿、旧帧逐步瘦身」的常驻缓存。

**代价与边界**：自实现换来「按会话语义淘汰」的精确，代价是没有 LRU 那种通用结构、三处状态要手工同步；边界是 `COUNT = 100`（`proxy.getData` 单次返回）与 `MAX_COUNT = 120`（对外 API 单次返回）也分属两处，别当作同一数字。把 `COUNT` 当成缓存总容量、或把 `MAX_COUNT` 当成 `clearCache` 的阈值，都会读错这段。

**打个比方**：这套缓存像图书馆的闭架书库——多数书（会话）按「还回来多久」分批下架，畅销新书（尾部 360 条）多留一阵；一旦书架爆满（1800 条），先把最老的一批无条件搬走腾到 1200，再慢慢处理其余；大开本（大帧）则随时间把附录一页页撕薄，越旧越省地方。它不按「谁最近被翻过」排，所以不是 LRU。

**自己验证**：对照 `clearCache` 的三段条件，问自己「正好 600 条时删不删、1800 条时先做什么」；再对照 `COUNT` / `MAX_COUNT` / `MAX_LENGTH` 三个数字各管什么，能分清，就不会把「单次拉取条数」当成「缓存容量」。

## 上报通道：gzip 短轮询与原地更新

界面取数走的是标准 HTTP 请求。`biz/webui/cgi-bin/get-data.js:28-60` 用 `util.sendGzip(req, res, {...})` 返回 gzip 压缩的 JSON（底层是 `zlib.gzip`，`lib/util/common.js:1477`），其中 `:60` 调用 `proxy.getData(...)`。前端 `biz/webui/htdocs/src/js/data-center.js:1157-1159` 依据 `hasNew` 决定下一次轮询：有数据 100 毫秒、无数据 900 毫秒。注意别把它与服务端 `lib/service/data-center.js:8` 的 `MAX_COUNT = 100` 混为一谈——后者在 `:99` 用 `slice(0, MAX_COUNT)` 裁剪上报历史列表，是条数上限；这里的 100 / 900 是轮询间隔（毫秒），两个同名文件语义毫无关系。

```js
// biz/webui/htdocs/src/js/data-center.js:1157-1159（节选）
cgi.getData(options, function (data) {
  var hasNewData = data && data.data && data.data.hasNew;
  setTimeout(load, hasNewData ? 100 : 900);
  // ... 后续更新界面
});
```

配套接口各司其职：`get-frames.js` 调 `proxy.getFrames(req.query)` 取帧并用 `socketMgr.exists` 判断连接是否仍活跃，`get-session.js` 按 id 列表批量 `proxy.getItem(id)` 补详情，`biz/webui/cgi-bin/socket/data.js` 用 `socketMgr.sendData(req.body)` 让 UI 反向注入帧。同一份 `get-data` 响应还捎带 `mrulesClientId` / `mrulesTime` 等修改戳（`get-data.js:41-44`），前端 `data-center.js:903` 的 `checkDataChanged` 据此决定是否重拉规则，这也是配置变更通知能搭上轮询便车的原因。`lib/util/perf.js` 另起一路，每 3 秒用 `procData` 统计请求数、QPS、内存与 CPU 并 `proxy.emit('perfDataChange', procData)`。中断能力由 `data.abort()`（`data.js:174-183`）与 `socketMgr.destroy()`（`lib/socket-mgr.js:849-857`）提供，`biz/webui/cgi-bin/abort.js:18-19` 同时调用二者，分别断开请求与帧连接。

最后强调最容易被忽略的设计取舍。`data-server.js:319-333` 的 `handleRequest` 把 `data` 对象**原地**写入 `reqData[id] = data`，随后 `:329-330` 直接给它补 `version` / `nodeVersion`；`getItem`（`:624-631`）与 `getList`（`:283-317`）也只在返回前就地 `toBase64String`。换言之，内核持续更新的对象与 UI 读到的是**同一个引用**，没有快照、没有逐次序列化拷贝。好处是零复制、增量字段天然可见；代价是这个对象在整个会话期常驻内存，任何字段膨胀都会直接抬高 RSS，且一处修改对所有消费者立即可见。理解这点，才能明白前面那些阈值与 `clearCache` 为什么不是可选优化，而是这套零复制模型的必要兜底。

把「零复制」这句结论再展开一步：`handleRequest` 把 `data` 原地写进 `reqData[id] = data`，随后直接给它补 `version` / `nodeVersion`；`getItem` / `getList` 也只在返回前就地 `toBase64String`。也就是说，内核持续更新的对象与 UI 读到的是同一个引用，没有快照、没有逐次序列化拷贝。正因为这样，前面那些阈值与 `clearCache` 才不是可选优化——它们是这套模型唯一的内存兜底：一份对象既不能被复制成多份、又要在会话期常驻，就只能在「存多少、留多久、超限怎么办」上设硬边界。

**为什么上报用短轮询，而不是 SSE 或 WebSocket 长连接推送**：界面取数走标准 HTTP 请求，`sendGzip` 返回压缩 JSON，前端依据 `hasNew` 决定下一次间隔——有数据 100 毫秒、无数据 900 毫秒。把结论展开：抓包是「界面想看时来拉」，并非服务端非推不可的实时流；带自适应间隔的短轮询在「有变化要快跟」与「没变化别空转」之间取了平衡，gzip 再压掉 JSON 体积，且不必为观测单独维护一条长连接。代价是界面上的记录天然有最多一个轮询间隔的延迟；边界是 SSE / WebSocket 在本篇另有用途——SSE 只用于响应体按 `text/event-stream` 分帧展示，WebSocket 帧走的是 11 的帧管道，二者都不是这条上报通道。

**为什么 `get-data` 响应还要捎带 `mrulesClientId` / `mrulesTime` 这类修改戳**：前端 `checkDataChanged` 据此决定是否重拉规则。把这句展开：既然界面每隔一小段就来问一次数据，顺手把「配置有没有变」也放在同一个响应里带回，就不必为规则变更再开一条通知通道——配置变更通知搭上了轮询的便车。代价是轮询响应里多几个与抓包无关的字段；边界是它只捎带「变没变」的戳，真正的规则内容仍由各自接口拉取。

**为什么 UI 与内核读同一个引用，既是便利也是风险**：便利是零复制、增量字段天然可见——内核刚补的 `statusCode`、时间字段，界面下一轮就看得见；风险是这个对象在整个会话期常驻内存，任何字段膨胀都会直接抬高 RSS，且一处修改对所有消费者立即可见，没有快照可回退。把这句展开：若有快照，每次状态迁移都要序列化一份、内存与 CPU 都翻倍；共用引用省下了这些，却把「别让字段无限长」的责任推给了阈值与淘汰策略。代价是排查「内存涨在哪」时要顺着 `data` 对象的字段找；边界是它只保证「可见性一致」，不保证「隔离性」。

**输入 → 动作 → 输出**：输入是常驻的 `reqData` / `framesCache` 与界面发来的 `get-data` 等 cgi 请求，动作是 `proxy.getData` 取出增量、`sendGzip` 压缩成 JSON、前端按 `hasNew` 定下一次间隔、帧 / 会话 / 注入帧各有独立 cgi 接口、`abort` 同时断开请求与帧连接，输出是界面看到的一份份会话与帧记录，以及一套「内核写、界面读同一份对象」的零复制通道。

**代价与边界**：短轮询省去长连接、却带来最多一个间隔的延迟；gzip 省带宽、却要服务端每次压缩。边界是两个同名 `data-center` 文件语义毫无关系——前端那份的 100 / 900 是毫秒级轮询间隔，服务端那份的 `MAX_COUNT = 100` 是 `slice(0, MAX_COUNT)` 的上报历史条数上限；把两者混为一谈，会以为「100」既是间隔又是容量。

**打个比方**：上报通道像前台与库房之间的对讲——前台每隔一小会儿问一句「有新东西吗」，有就快问、没有就慢问；库房不主动跑出来送（非推送），只把清单压成一沓薄纸（gzip）递过去。而 `data` 对象是库房里那本活页账，前台看到的就是账本原件、不是复印件，所以谁在上头多写一行、所有人都立刻看得到，也必须有人定期把旧页拆掉（阈值与淘汰）。

**自己验证**：对照 `get-data` 的轮询代码问自己「`hasNew` 为真时下一次是 100 还是 900 毫秒」；再顺着 `handleRequest` 把 `data` 写进 `reqData[id]` 那行，确认 `getItem` 返回前只做 `toBase64String`、没有拷贝，就能说清「零复制」到底省在哪、又险在哪。

## 常见误解

1. **容易以为上报走的是 SSE 或 WebSocket 推送，其实是 gzip 压缩的 HTTP JSON 短轮询**：`get-data` 用 `sendGzip` 返回压缩 JSON，前端按 `hasNew` 定 100 / 900 毫秒间隔；SSE 在本篇只用于响应体按 `text/event-stream` 分帧展示，WebSocket 帧走的是 11 的帧管道，对照见[《易混淆概念辨析》](/concepts/08-confusions)。
2. **容易以为超限的大响应会整条记录消失或被拦下不发，其实只是 body 栏为空**：超阈把 `reqBody` / `resBody` 置为 `false`，`size`、`headers`、`statusCode`、时间字段等元信息照常保留，真实字节仍被转发给客户端；界面仍能看到「有一个 20MB 的响应」。
3. **容易以为抓包缓存是 LRU，其实它是 `ids[]` + `reqData{}` + `framesCache` 的自实现有界结构**：它按会话结束时间分级淘汰、按帧龄截断，而不是「最近最少使用」；`regUrlCache` / `hostCache` 不用 LRU 是另一个理由（规则一变就整批重置），站内真正用 `lru-cache` 的在证书与插件侧。
4. **容易以为 `COUNT = 100` / `MAX_COUNT = 120` / 600 是同一个数，或把 `data` 对象当成快照**：`COUNT` 是 `proxy.getData` 单次返回上限、`MAX_COUNT` 是对外 API 单次返回上限、600 是 `reqCacheSize` 常规水位，三者各管一段；而 `data` 对象是内核与 UI 共用的同一引用，一处修改对所有消费者立即可见，没有逐次序列化拷贝。

## 小结

- 采集旁路于转发：`data.js:279-323` 覆盖 `write` / `end` 采样，`proxy.emit('request', reqEmitter, data)` 后由 `send` / `response` / `end` / `abort` 推进。
- 阈值覆盖 360KB、1MB、2MB、16MB、256KB 与 1MB 帧；超阈把 `reqBody` 置 `false`，保留元信息；SSE 按 `\n\n` 分帧。
- 缓存是自实现的有界结构（`ids[]` + `reqData{}` + `framesCache`）：≤600 不清理、>600 按 2 分钟淘汰、≥1800 先砍到 1200 且尾部 360 条享 6 分钟宽限，单次拉取 100 条，帧按 512/256/128/64KB 瘦身。
- 上报是 gzip 压缩的 HTTP JSON 短轮询，有数据 100ms、无数据 900ms；帧、会话、注入帧各有独立 cgi 接口。
- `data` 对象原地更新、UI 读同一引用，换来零复制，也带来内存与可见性风险。
- 本篇为 [《规则引擎：解析与匹配》](/modules/rules-engine) 准备了「数据面到此闭环」这个起点：正因请求、隧道、帧的采集与上报都已逐段厘清，13 才能转去回答一直被当作黑盒的那个问题——驱动前面所有改写的规则文本，究竟如何被解析并匹配到每一次请求。

## 下一步

[《规则引擎：解析与匹配》](/modules/rules-engine)：核心链路到此闭环，下一篇进入模块深潜，看规则文本如何被解析并匹配到每一次请求。 紧接着读它，是因为前面这条链路反复用到 `req.rules`、`reqDelay` / `resDelay`、`req*` / `res*`、`frameScript` 与 `MAX_PAYLOAD_SIZE` 这些规则产物，却始终只讲「被求值之后驱动了什么」、没讲「一行规则文本是怎么变成它们的」；13 正好补上编译期 → 请求期这两条泳道，把一直当黑盒的规则引擎拆开。
