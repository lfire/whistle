---
title: 一次 HTTP 代理请求的旅程
description: 用精确的 16 步链路，串起请求归一化、规则改写、抓包采集、出站与响应回写。
---

# 一次 HTTP 代理请求的旅程

前两篇分别讲清了服务如何监听、配置与进程如何就位。本篇进入全站最核心的一条链路：一个普通 HTTP 代理请求从进入 `request` 事件，到拿到源站响应并回写客户端，中间到底经过哪些模块。全文按 16 个可定位的步骤展开，并合并为七个讲解段；读完你应当能对着源码，把每一步的输入、输出与所在文件一一对应，也能说清请求改写与响应改写各自由哪些规则驱动。上一篇讲完「服务跑起来之后是什么形状」，却始终停在进程与配置的静态层面、没有让任何一个真实请求走过那条链；本篇先补上普通 HTTP 这一半，[CONNECT 隧道](/concepts/01-proxy) 里的 HTTPS 要到下一篇才拆得开。

::: tip 先修知识
先做 [第 0 站](/guide/quickstart)：本篇的每一步，就是你亲手发过的那条请求在内核里的走法。

若某个名词卡住，按主题回查 [概念精解总览](/concepts/index) 与 [《全量术语索引》](/concepts/glossary)；正文在术语首次出现处也给了对应链接。

不需要预先读过源码，但能分清「启动期只装配一次」与「请求期每请求都执行」就够了；成对辨析可查 [《易混淆概念辨析》](/concepts/08-confusions)，忘记名词查 [《全量术语索引》](/concepts/glossary)。
:::

![一次 HTTP 代理请求的 16 步链路](/diagrams/http-request.svg)
*图注：入口归一化后依次经过 init、biz、四个检查器（inspector：旁路记录数据的阶段）与三个处理器（handler：决定改写或短路的阶段），最终由出站请求与响应改写收口。*

## 链路全景：16 步与三段职责

[中间件](/concepts/04-runtime)顺序本身写在代码里：`lib/index.js:40-43` 把 `./init`、`../biz`、`require('./inspectors')`、`config.middlewares`、`require('./handlers')` 依次 `app.use`，并用 `bind(proxyEvents)` 让所有中间件的 `this` 指向同一个[事件总线](/concepts/04-runtime)。展开后，`lib/inspectors/index.js:1-8` 是 `rules → req → data → res`，`lib/handlers/index.js:1-7` 是 `file-proxy → http-proxy → error-handler`。把这条链按动作切细，就是下面 16 步：

1. `lib/index.js:209` 在 `biz/init` 完成后执行 `server.on('request', app)`，请求进入 Express。
2. `lib/init.js:159-160` 用 `PipeStream.wrapSrc(req)` / `wrapDest(res)` 把两侧包装成可插拔双向流。
3. `lib/init.js:161-162` 调用 `addTransforms` 与 `addErrorEvents`，挂上改写能力与错误兜底。
4. `lib/init.js:166-189` 解析客户端 IP、端口、clientId；`:235-260` 定义统一的 `res.response`。
5. `biz/index.js:34` 执行 `req.fullUrl = util.getFullUrl(req)`，把代理请求还原成完整 URL。
6. `biz/index.js:133-163` 分流 Web UI、插件界面与 weinre，其余请求 `next()` 继续。
7. `lib/inspectors/rules.js:159` 分配 `req.reqId = util.getReqId()`，作为全链路唯一标识。
8. `rules.js:29-45` 解析规则并以 `req.options = util.parseUrl(ruleUrl || req.fullUrl)` 确定出站目标。
9. `lib/inspectors/req.js:456-612` 按请求规则改写头部、方法与正文，并注册 Transform。
10. `lib/inspectors/data.js:55-185` 构造抓包 `data` 对象并 `proxy.emit('request', reqEmitter, data)`。
11. `data.js:542-551` 应用 `reqDelay` 后 `next()`，把控制权交给下一环。
12. `lib/inspectors/res.js:190-194` 定义 `req.request`；`:781` 定义 `res.response` 覆盖版。
13. `lib/handlers/file-proxy.js:233-248` 对本地文件协议短路，非文件协议 `next()`。
14. `lib/handlers/http-proxy.js:5-47` 判定协议并调用 `req.request(req.options)` 发起出站。
15. `lib/inspectors/res.js:641-644` 执行 `(useHttps ? https : http).request(options, res.response)`。
16. `res.js:648-669` 在 socket 连接后 `req.pipe(client)`；随后 `:781-1311` 完成响应改写、`res.src`（`:1173`）与 `res.writeHead`（`:1239`），异常由 `lib/handlers/error-handler.js:3-5` 兜底。

::: cols 16|26|28|30
| 阶段 | 文件 | 输入 | 输出 |
|---|---|---|---|
| 归一化 | lib/init.js | 原始 req/res | 可插拔双向流 |
| 分流 | biz/index.js | 原始 URL | fullUrl / next |
| 定规则 | rules.js | fullUrl | reqId / options |
| 改请求 | req.js | reqRules | Transform 链 |
| 采集 | data.js | req / res | data 对象 |
| 出站 | res.js | options | client 请求 |
| 改响应 | res.js | 源站响应 | 客户端响应 |
:::

从职责上看，16 步可归为三段：第 1-8 步把「代理请求」归一化成带规则上下文的 `req`，第 9-11 步在转发前完成改写与采集，第 12-16 步负责真正的出站与回写。三者串在同一条 Express 链上，靠 `next()` 逐段推进，任何一段都能用 `res.response(...)` 提前短路。

**为什么把 16 步压进一条 Express 链**：顺序即语义——`init` 先包装流、`biz` 还原 URL 并挡住管理流量、四个 [inspector](/concepts/05-capture) 依次完成规则求值、请求改写、抓包采集与响应改写、`handlers` 最后出站。把结论展开成推理：出站要用的 `req.options` 由规则阶段才定下来，抓包 `data` 对象又要早于改写与出站登记，若把这几步拆成彼此独立的模块各自处理，就得各自重复一遍 URL 还原与编号分配，顺序一旦错位，「改地址规则」或「请求归属」都会算错。串在同一条链上、靠 `next()` 逐段推进，等于用一处顺序换来了全链路对「同一个 `req`」的一致视图。

**输入 → 动作 → 输出**：输入是刚进门的原始 `req` / `res`，动作是三段依次把「代理请求」归一化、在转发前完成改写与采集、再出站与回写，输出是源站响应被改写后写回客户端，以及一份与转发并行、不阻塞它的抓包记录。把表格「输入 / 输出」两列竖着读一遍，就能看出前一行的输出正是后一行的输入。

**代价与边界**：链上任何一段不调 `next()` 就整条停住，好处是 `res.response(...)` 能在任意环节提前收口；代价是排障时必须顺着 `next()` 找断点，一个静默不 `next()` 的环节表现出来只是「请求挂住」，不会报错。边界是这条链只覆盖「已经能读到明文」的请求，进门时还读不到内容的流量得走另一条入口。

**打个比方**：像一条装配流水线，每个工位只做一道工序、把半成品传给下一工位；谁都可以按下急停（提前 `res.response`），但谁忘了按「传下去」（`next()`），后面所有工位就都空转。

**自己验证**：对照那张四列表格逐行问「这一行的输出，是不是下一行的输入」，再数一数 16 步清单里 `next()` 出现在哪几步；能答上「归一化 → 定规则 → 改写 / 采集 → 出站」这条次序，就理解了为什么顺序不能随意调换。

## 第一段：入口与归一化（第 1-7 步）

### 从 request 事件到 fullUrl

第 1 步的 `server.on('request', app)` 位置很关键：它写在 `lib/index.js:208-211` 的 `biz/init` 回调里，说明端口虽已监听，但应用要等初始化完成才接请求。进入应用后，`lib/init.js:157` 这个每请求中间件先做流包装与客户端信息解析（第 2-4 步），它给 `req` / `res` 装上的 `addTextTransform`、`addZipTransform`、`res.response` 等能力，是后面所有改写动作的支点。

第 5-6 步由 `biz/index.js` 承担。`util.getFullUrl(req)` 依据 `req.isHttps` 与 `Host` 还原出完整 URL，`biz/index.js:133-163` 再用一组正则识别 Web UI 路径、插件路径、`weinre` 与 `log` / `cgi` 内部应用：命中就 `util.transformReq` 转发到本地端口或直接交给 `transformUI`（`:150,:159`）渲染，未命中才 `next()` 进入规则链。把界面流量挡在用户规则之前，是为了避免管理请求被用户写的 `host` / `path` 规则误伤。

**为什么 `request` 要等初始化完成才挂**：端口那时已经在监听，但 `request` 事件被放进后台初始化的回调里才注册。把这句展开：界面路由、规则与插件要先就位，否则最早进来的那批请求会在没有任何规则的情况下被转发出去，排查时只会看到一段无从解释的裸流量；宁可让端口「通」而应用「暂时不接」，也不能让半成品状态被访问。代价是启动到真正可用之间有一段窗口，边界是这段窗口只影响 `request`，另外几类入口不受它约束。

**为什么界面流量要挡在用户规则之前**：`biz` 用一组正则先认出 Web UI、插件界面与内部应用，命中就本地转发或渲染，未命中才 `next()` 进规则链。若不先分流，用户写的一条 `host` 或 `path` 规则就可能把管理请求也劫持到别处，界面自己先打不开；把「先界面、后代理」固定成顺序，管理流量才不会被调试规则误伤。代价是这组正则本身成了一份需要维护的路径清单，边界是它只做路径级识别，不读正文、也不做规则求值。

**输入 → 动作 → 输出**：输入是 `request` 事件交来的原始 `req` / `res`，动作是包装成可插拔双向流、解析客户端信息、还原完整 URL 并分流界面流量，输出是一对「可被后续安全改写」的对象和一条 `next()` 通往规则链的通路。

**自己验证**：对照第 1 步与第 5、6 步，数一数「挂 `request` → 还原 `fullUrl` → 分流界面」的先后；再问自己如果界面路径没被正则挡住、它会不会落进 `host` 规则，就能确认这条分流顺序不是可有可无的。

**代价与边界**：把「还原 URL」与「分流界面」压在入口这一段，好处是下游所有环节只面对一种 URL 表示；代价是每次请求都多一次解析与正则匹配，且界面路径的判断必须先于用户规则，意味着用户写的规则再早也管不到管理流量。边界是它只做「路径级」的识别与归一化，不读正文、也不决定改写内容。

### 分配 reqId 与解析规则

第 7-8 步在 `lib/inspectors/rules.js` 完成。`rules.js:153-160` 先标记请求计数、分配 [`reqId`](/concepts/05-capture)、再次刷新 `fullUrl`，随后 `setupRules`（`:27-45`）依次 `resolveRules`、解析规则文件、合并插件规则、过滤弱规则，最后从 `req.rules.rule` 取出 `ruleUrl` 并落到 `req.options`。

```js
// lib/inspectors/rules.js:40-44
var ruleUrl = util.rule.getUrl(req.rules.rule);
if (ruleUrl !== req.fullUrl && util.isUrl(ruleUrl)) {
  ruleUrl = util.encodeNonLatin1Char(ruleUrl);
}
req.options = util.parseUrl(ruleUrl || req.fullUrl);
```

这一步是「代理」二字的落点：`req.options` 后续会被 `http.request` 直接当作目标地址，因此 `ruleUrl` 优先于 `fullUrl`，正是 `host` / `xhost` 等改地址规则生效的根源。`rules.js:10` 的 `MAX_PAYLOAD_SIZE = 256KB` 也在此阶段限制需要读取正文的场景，避免为解析规则而无限缓冲请求体；只有命中 `body` 过滤或存在 `reqReadPort`（pipe 插件读端口）时，`:200-209` 才走 `req.getPayload`，其中 `hasReqScript` 命中会把预算从 1 字节放大到不限（`:204` 的 `payloadSize = 0`），其余情况直接 `setupRules(req, next)` 放行。细看 `:202-209` 其实是三条路径：有 `body` 过滤时 `payloadSize` 取 256KB，预读正文供规则求值；只有 `reqReadPort` 而无正文过滤时，`:204` 把预算退化成 `0` 或 `1` 两个长度哨兵，仅够触发一次读取；两条路径都在 `getPayload` 回调里把解码结果写入 `req._reqBody`（`:207`）后再 `setupRules`。而没有任何过滤或读端口的普通请求根本不缓冲正文、直接 `setupRules`（`:211`）——`MAX_PAYLOAD_SIZE` 约束的只是「为规则求值而预读」这一条路径，不是全链路的请求体上限。

值得注意的是 `reqId` 的分配时机：它早于一切改写与采集，因此 `data.js` 构造的抓包对象、`socket-mgr` 的帧上下文、前端展示的会话 id 全都指向同一个值。若把这一步挪到出站之后，隧道与 WebSocket 的帧就无从归并到这次请求上。

**为什么 `ruleUrl` 优先于 `fullUrl`**：`req.options` 最后会被原生请求直接当作目标地址，所以「代理」二字的落点其实就在这一行赋值里。把结论展开成推理：浏览器地址栏里的 URL 先被还原成 `fullUrl`，但用户写的 `host` / `xhost` 等改地址规则会先算出 `ruleUrl`；若让 `fullUrl` 优先，这些规则无论怎么写都影响不到出站目标，代理就只是原样转发。让 `ruleUrl || req.fullUrl` 成为 `req.options` 的来源，正是「改地址规则能生效」的根源。这些 `host` / `xhost` 与后面成串的 `req*` / `res*`，都属于 [规则 DSL](/concepts/06-rules)；本篇不展开它们怎么写，只关心被求值之后分别驱动了哪些改写。

**为什么编号要早于一切改写与采集**：编号在规则阶段就分配，比构造抓包对象、注册改写流、发起出站都早。把这句展开：一次请求会先后经过多个模块，甚至被拆成不同的 `req` 对象，必须有一个在任何改写发生之前就定下的标识，抓包记录、连接帧上下文与界面上的会话 id 才能指向同一条请求。代价是它必须在最早的阶段一次性定形、之后不许改写；边界是它标识的是「一次请求」，不是一条 TCP 连接，同一连接上的多个请求各有各的编号。

**为什么 `MAX_PAYLOAD_SIZE` 只约束预读那一条路**：原文那段把三条路径拆开讲，结论是普通请求根本不缓冲正文、直接 `setupRules`。把推理补齐：只有规则里写了 `body` 过滤、或存在 pipe 插件读端口时，才需要先把正文读进内存供求值；此时用 256KB 封顶，是为了避免「为了匹配一条规则」而把整个大请求体无限缓冲。代价是命中 `body` 过滤的请求多一次缓冲与解码；边界是这个上限不是全链路的请求体上限，转发阶段仍按流处理、不受它约束。

**代价与边界**：这一段的取舍集中在「先求值、后放行」：规则文件解析、插件规则合并与弱规则过滤都收口在 `setupRules` 里，好处是下游只面对已经定好的 `req.rules`；代价是任何一处规则文件异常都会卡住 `next()`，边界是它只产出「要改什么」的描述，真正改不改、怎么改要等后面的 Transform 阶段。

**自己验证**：对照那段 `req.options = util.parseUrl(ruleUrl || req.fullUrl)` 的代码，问自己「`ruleUrl` 有值时 `fullUrl` 还起作用吗」；再对照 `MAX_PAYLOAD_SIZE` 那段，数一数哪几条路径才会走 `req.getPayload`，就能确认「256KB 不是全链路限制」。

**输入 → 动作 → 输出**：输入是归一化后的 `fullUrl` 与已加载的规则文件，动作是分配编号、`setupRules` 依次解析规则 / 合并插件规则 / 过滤弱规则、再按 `ruleUrl || req.fullUrl` 算出目标，输出是带 `req.rules` 与 `req.options` 的 `req`，供后面的改写与出站直接消费。把这三段对上号，就能解释「为什么改地址规则在这一步生效、而不是在出站时才被想起来」。

## 第二段：改写与采集（第 8-11 步）

### 请求改写由哪些规则驱动

第 9 步 `lib/inspectors/req.js:456-612` 把 `req.rules` 展开成一次具体的改写。它调用 `util.parseRuleJson` 批量求值 `reqHeaders`、`reqCookies`、`auth`、`params`、`reqCors`、`reqReplace`、`urlReplace`、`urlParams`，再叠加 `method`、`reqCharset`、`referer`、`ua`、`reqSpeed` 以及 `reqBody` / `reqPrepend` / `reqAppend`。也就是说，请求侧改写的驱动集合是 `req*` 与 `url*` 系列规则，外加少量无前缀的 `method` / `ua` / `referer`。

改写并非直接替换 Buffer，而是注册 Transform：`req.js:581` 的 `handleReplace` 产出 `ReplaceStringTransform` / `ReplacePatternTransform`，`:589-596` 用 `req.addZipTransform(new FileWriterTransform(...))` 挂上写文件流。这些 Transform 会在请求体真正流过时才执行，因此改写是流式的、与转发并行的。

**为什么是「注册 Transform」而不是「直接替换 Buffer」**：改写阶段只把替换器挂到流上，并不立刻动数据。把这句展开：请求体此刻可能还没到齐、甚至还没开始上传，若先把整段 Buffer 读进来再替换，就要么多一份内存拷贝、要么卡住转发等它收完；注册成 Transform 后，数据块边流过边被改写，改写与出站因此能并行，内存占用也只跟块大小有关。代价是「改了什么」要等 body 真正流过才看得到，排障时不能假设在注册那一刻就已生效；边界是它只对流经这条被包装过的流的正文有效，头部与方法这类不流经正文的部分由另外的规则直接改。

**输入 → 动作 → 输出**：输入是 `req.rules` 里求值好的 `req*` / `url*` 系列，动作是批量求值并往请求流上注册字符串、正则与写文件三类 Transform，输出是一条「带改写环节」的请求流，等正文经过时才产出改写后的字节。

**自己验证**：把本节列出的 `reqHeaders` / `reqReplace` / `urlReplace` 等规则名，与表格「改请求」一行的「输入 / 输出」两列对上号；再问自己「改写发生在注册时还是流过时」，能答「流过时」，就理解了为什么它不阻塞转发。

**代价与边界**：注册式改写的代价是效果滞后——规则命中只保证「环节已挂上」，若请求体始终没来、或中途被 `abort`，替换就根本不会发生；边界是它只作用于正文流，且依赖 `init` 那一步已经把流包装好，未走包装的流量挂不上这些 Transform。

### 采集对象与响应侧规则

第 10-11 步的 `lib/inspectors/data.js:55-185` 构造一个 `data` 对象，字段涵盖 `id`、`url`、请求与响应元信息、`rules` 以及 `abort` 方法，并在 `:185` 用 `proxy.emit('request', reqEmitter, data)` 把它广播到事件总线。[抓包](/concepts/05-capture)模块不自己收发请求，只订阅这份对象；后续请求发出、响应到达、流结束或中断时，又会由 `reqEmitter` 抛出 `send`（`:430`）、`response`（`:439`）、`end`（`:405`）或 `abort`（`:482`）事件。`data.js:542-551` 随后按 `req.rules.reqDelay` 决定延时多久再 `next()`，这个延时作用在「采集已订阅、改写已注册」之后，因此不会影响抓包对象的创建。

第 12 步的 `lib/inspectors/res.js:190` 定义 `req.request(options)`，`:781` 定义 `res.response(_res)`，二者构成出站与回写的一对入口。响应改写的驱动规则与请求侧对称，来自 `res.js:781-1311` 读取的 `resHeaders`、`resCookies`、`resBody`、`resPrepend`、`resAppend`、`resReplace`、`resCharset`、`resDelay`、`resSpeed`、`resCors`、`replaceStatus`，以及 `htmlBody` / `jsBody` / `cssBody` 按内容类型注入的三组规则。`res.js:1162-1173` 的 `resRules.resDelay` 与 `reqDelay` 遥相呼应，分别卡在回写前后。

**为什么 `reqDelay` 不影响抓包对象的创建**：延时被安排在「采集已订阅、改写已注册」之后才作用到 `next()`。把结论展开：`data` 对象在延时之前就已构造并广播，事件总线上的订阅者此刻已经挂好，后面 `send` / `response` / `end` / `abort` 这些状态迁移也照常由请求专属的发射器抛出；延时只是推迟把控制权交给下一环，并不改变「这条请求已被登记」这个事实。代价是 `reqDelay` 只能调时序、不能用来改变采集内容；边界是它作用在转发链上，与响应侧的 `resDelay` 分卡在回写前后，二者互不覆盖。

**为什么抓包只订阅、不自己收发请求**：`data` 对象被广播到事件总线后，抓包模块只接住这份对象，请求与响应仍由原来的链继续走。把这句展开：若让抓包自己去转发一遍，就得复制整条收发逻辑、还得和改写链争用同一个流；改成「旁路订阅」，采集与转发就并行、链路上不新增等待点。代价是界面看到的记录与内核持有的是同一份上下文，字段会随请求推进不断变化；边界是它只记录、不参与决策，改不改、发不发仍由改写与出站两段决定。

**为什么请求侧与响应侧规则要对称**：`req*` / `url*` 管进门前的改写，`res*` 与按内容类型注入的 `htmlBody` / `jsBody` / `cssBody` 管回写前的改写，两套命名一一对应。这样排是因为一次请求天然有「去」与「回」两个方向，任何一侧缺了对应能力，调试时就只能改半条链路；对称的代价是两边各要维护一份规则清单与 Transform 挂载点，边界是响应侧多一层「源站响应已到达」的前提，必须先读到首块才能决定怎么改。

**自己验证**：对照「请求改写由哪些规则驱动」与本节「响应改写的驱动规则」两处清单，把 `reqHeaders` 对 `resHeaders`、`reqBody` 对 `resBody`、`reqDelay` 对 `resDelay` 逐个数一遍；能凑成对，就记住了「一侧改写、另一侧对称」这条主线。

**输入 → 动作 → 输出**：输入是已构造的 `req` / `res` 与 `req.rules`，动作是构造 `data` 对象并广播、按 `reqDelay` 延时、订阅 `send` / `response` / `end` / `abort` 四类状态迁移，输出是一份随请求推进不断补全的抓包记录，以及一条继续 `next()` 的转发链。三段分开看，就不会把「延时」误当成「采集被推迟」。

## 第三段：出站与回写（第 12-16 步）

### 本地短路与协议分发

第 13 步 `lib/handlers/file-proxy.js:233-248` 先判断 `protoMgr.isFileProxy(protocol)`：不是文件协议就 `next()`；是 `locHref` 且能就地渲染则直接响应，否则把 `req.isWebProtocol` 置真、重置 `req.options` 再 `next()`。第 14 步 `lib/handlers/http-proxy.js:13-47` 用 `protoMgr.isWebProtocol` 判定，Web 协议交给 `handleReq`，插件协议则 `loadPlugin` 后把目标改写成 `127.0.0.1:<插件端口>` 再 `req.request(options)`。

```js
// lib/handlers/http-proxy.js:5-11
var handleReq = function (req, next) {
  if (req.isWebProtocol) {
    req.request(req.options);
  } else {
    next(new Error('Unsupported protocol ' + req.options.protocol));
  }
};
```

不支持的协议会以 `Error` 走 `next(err)`，最终落到 `lib/handlers/error-handler.js:3-5` 的 `res.response(util.wrapGatewayError(...))`，这就是整条链的兜底出口。

**为什么先判文件协议、再判 Web 协议**：文件协议若能在本地就地渲染就直接响应，不再往下走；不是文件协议才 `next()` 交给下一环，再按是否 Web 协议分给 `handleReq` 或插件。把这条次序展开：短路越靠前，越省掉后面一整串规则求值与出站开销；而把「本地能答的」和「必须出网的」先分开，后面的出站段就不必再判断协议从哪来。代价是每多一种协议都要在这两级判定里各补一个分支；边界是短路只针对「本地文件」这一类，其它协议仍要完整走完出站。

**为什么不支持的协议统一走 `next(err)`**：`handleReq` 的 `else` 分支不自己回错误，而是把 `Error` 交给 `next`，最后由兜底出口统一包装成网关错误响应。把结论展开：若每个分发点各写一份错误响应，状态码、响应头与日志格式就会散落各处；收口到一个出口，异常表现才一致。代价是排障时错误栈会经过好几层环节才落地，边界是它只兜住「协议不支持」这类可预期的失败，连接层异常另有事件兜底。

**输入 → 动作 → 输出**：输入是带着 `req.options` 与协议标记的请求，动作是先判文件协议短路、再判 Web 协议分发、必要时把目标改写成插件端口，输出是「本地直接响应」或「调用 `req.request` 发起出站」两种去向，外加一条统一错误出口。

**自己验证**：对照 `handleReq` 那段代码数一数 `if` / `else` 两支各做什么，再顺着「不支持的协议 → `next(err)` → 兜底出口」走一遍；能说清「为什么错误不在这里直接回」，就理解了这条收口设计。

**代价与边界**：两级短路越靠前越省开销，代价是协议分发的判定被摊在两个 handler 里，新增一种协议要同时确认「是不是文件协议」「是不是 Web 协议」两处；边界是短路只覆盖本地能直接应答的情形，凡是要出网的请求仍必须完整经历出站、连接与回写，不能因为前面少走了一步就省略后面的环节。

### 发起请求、连接与响应回写

第 15-16 步回到 `lib/inspectors/res.js`。`req.request` 内部先解析代理、客户端证书与 `useHttps`，随后 `:641-644` 发起原生请求，并把 `res.response` 作为响应回调注册。

```js
// lib/inspectors/res.js:641-644
var client = (useHttps ? https : http).request(
    options,
    res.response
  );
```

连接建立前不会盲目转发请求体：`:648-669` 监听 socket 的 `connect` 或 `secureConnect`，等连接就绪才调用 `pipeClient`。`lib/inspectors/res.js:65-77` 显示，无请求体时 `client.end()`，有请求体时才是 `req.pipe(client)`。

```js
// lib/inspectors/res.js:65-77
function pipeClient(req, client) {
  if (req._hasError) {
    client.destroy();
  } else if (req.noReqBody) {
    util.drain(req, function () {
      if (!req._hasError) {
        client.end();
      }
    });
  } else {
    req.pipe(client);
  }
}
```

源站响应到达后，`res.response` 在 `res.js:781-1311` 展开改写：先读取首块、合并响应规则，再用 `res.addTextTransform` / `res.addZipTransform` 注册替换与注入流，最后在 `:1173` 执行 `res.src(_res, null, firstChunk)`、在 `:1239` 执行 `res.writeHead(...)` 把状态行与头部写给客户端。至此一次请求闭环。

**为什么连接就绪才转发请求体**：出站请求先发起、但请求体要等 socket 的 `connect` 或 `secureConnect` 之后才 `req.pipe(client)`。把这句展开：连接还没建好时往套接字里写数据，轻则被丢弃、重则直接报错；`pipeClient` 因此专门判「有没有 body」——没有就 `client.end()` 收尾，有才把请求流接上去。这里用的正是 Node [pipe](/concepts/04-runtime) 的默认语义：下游写不动时会自动暂停上游、等它缓过来再继续，所以大请求体不会把内存撑爆。

**为什么先注册改写流、后 `writeHead`**：响应到达后先读首块、合并响应规则、挂上替换与注入流，最后才把状态行与头部写给客户端。把结论展开：头部一旦发出，状态码与响应头就再也无法被 `resHeaders` 之类的规则修改；把 `res.src` 与 `writeHead` 排成这个先后，是为了让状态、头部与正文在同一次改写里保持一致。代价是响应必须等首块到手才能开始回写，边界是这套顺序只对「走 `res.response` 覆盖版」的响应成立。

**输入 → 动作 → 输出**：输入是 `req.options` 指定的目标与一条已发起的原生请求，动作是待连接就绪后把请求体接上、收到源站响应后按 `res*` 规则改写，输出是状态行、头部与正文被写回客户端，异常则交给兜底出口。

**代价与边界**：把「发起」与「回写」拆成 `req.request` / `res.response` 一对入口，好处是状态码、重定向这类规则能在建连之前就短路返回；代价是请求体并非在调用那一刻一次性发出，超时、延时与背压都各有自己的作用时机。边界是这段只负责「把字节送达」，内容怎么改由前面注册的 Transform 决定。

**自己验证**：对照 `pipeClient` 那段代码数一数三个分支——出错、`noReqBody`、有请求体——各自怎么收尾；再问自己「连接没就绪时能不能先 pipe」，能答「不能」，就记住了这段时序。

## 流包装与解压改写链

最后单独看支撑上述改写的 `PipeStream`。它来自 `pipestream` 依赖（`package.json:58`），`lib/init.js:1` 引入，`lib/init.js:87-155` 的 `addTransforms` 用它搭出「解压 → 文本改写 → 重压缩」的三段管道。`req.addTextTransform` 先取 `util.getPipeIconvStream(req.headers)` 做编码转换，`req.addZipTransform` 则把 Transform 挂到 zip 层；响应侧 `res.addTextTransform`（`:136-143`）与 `res.addZipTransform`（`:131-135`）同理，只是多了一层 `res.on('src')` 监听。

```js
// lib/init.js:90-104
req.addTextTransform = function (transform) {
  if (!reqIconvPipeStream) {
    reqIconvPipeStream = util.getPipeIconvStream(req.headers);
    initReqZipTransform().add(reqIconvPipeStream);
  }
  reqIconvPipeStream.add(transform);
  return req;
};
req.addZipTransform = function (transform, head, tail) {
  initReqZipTransform()[head ? 'addHead' : tail ? 'addTail' : 'add'](
    transform
  );
  return req;
};
```

`content-length` 是这条链上必须处理的副作用。一旦正文被解压、改写、重压缩，长度必然变化，因此 `lib/init.js:106-112` 的 `initReqZipTransform` 直接 `delete req.headers['content-length']`，`lib/inspectors/res.js:1182` 与 `:1206` 也在设置 `content-encoding` 或判定 `hasResBody` 后删掉响应侧的 `content-length`，让 Node 改用分块传输。

```js
// lib/init.js:106-112
function initReqZipTransform() {
  if (!req._needGunzip) {
    delete req.headers['content-length'];
    req._needGunzip = true;
  }
  return req;
}
```

理解这一点很重要：抓包采集与规则改写都建立在「流被包装过」的前提上，`PipeStream` 提供的 `wrapSrc` / `wrapDest` 让后续任意模块都能以 `add` 方式插入 Transform，而不必关心底层是普通 HTTP、解密后的 HTTPS 还是 H2 转 HTTP/1 的流量。

**为什么是「解压 → 文本改写 → 重压缩」三段管道**：正文可能是压缩过的，规则又要按文本去替换，于是先解压、在明文文本上改写、再压回去。把结论展开：若不解压就替换，正则面对的是一串压缩字节、根本匹配不到；若只解压不压回，又和客户端声明的 `content-encoding` 对不上。三段串成一条管道，是为了让「按内容类型注入」与「按规则替换」对所有流量形态都一致。`PipeStream` 的 `wrapSrc` / `wrapDest` 把 `req` / `res` 包装成可插拔的双向 [Stream](/concepts/04-runtime)，后续模块才能用 `add` 往这条管道里挂环节，而不必各自另开一条流。

**为什么 `content-length` 要删掉而不是重算**：正文被解压、改写、重压缩后长度必然变化，源码选择直接删掉这个头、让 Node 改用分块传输。把这句展开：边流式改写边精确预知最终长度几乎不可能，硬填一个旧值会让客户端提前截断或一直等；交给分块传输，长度就由流自己结束时决定。代价是客户端拿不到「还剩多少字节」这个提前量，进度条一类的展示会失效；边界是只要正文被改写就会触发，未改写、长度未变的请求不受影响。

**代价与边界**：包装不是复制数据，但每个请求都要付一次包装与事件挂载的开销；换来的是任意模块都能以 `add` 方式插入 Transform，且不必关心底层是普通 HTTP、解密后的 HTTPS 还是 H2 转回的 HTTP/1。边界是这套能力只在「流被包装过」之后才成立——抓包采集与规则改写都建立在这个前提上，读第一篇链路时若跳过 `init` 那一步，后面所有 `addTextTransform` 都会变成没有来由的调用。

**打个比方**：`PipeStream` 像在水管上预留的一串标准接口，想加过滤器、加流量计，拧上一个接头即可，不必把整根管子换掉；代价是每接一个接头都多一点水阻，而且一旦拆掉 `content-length` 这块「刻度牌」，就只能靠水流自己报结束时才知道总量。

**自己验证**：对照 `initReqZipTransform` 那段代码，找到 `delete req.headers['content-length']` 这一行，问自己「为什么不重算一个新长度写回去」；再顺着 `req.addTextTransform` 的定义，看它是把 Transform 挂到已有的 `reqIconvPipeStream` 上、而不是新建一条流，就能确认「包装 + 插入」确实是同一套设计。

**输入 → 动作 → 输出**：输入是可能被压缩的请求 / 响应正文，动作是包装成双向流、按需挂上解压与重压缩环节、再插入文本改写 Transform，输出是长度已变化、因而改由分块传输承载的字节流。把这三段连起来，就能回答「为什么改写之后 `content-length` 对不上」——不是算错了，而是它已被有意删掉。

## 常见误解

1. **容易以为 16 步链路的第一步是一次新的进程初始化，其实 `lib/init.js` 是每个请求都会经过的 Express 中间件**：`init` 指「初始化本次请求的上下文」，不是初始化进程；把启动期与请求期混在一起，就会以为 Transform 能力只在开机时挂一次，对照见[《易混淆概念辨析》](/concepts/08-confusions)。
2. **容易以为 `req.options` 就是浏览器地址栏里的那个 URL，其实它由 `ruleUrl || req.fullUrl` 决定**：`host` / `xhost` 等改地址规则会先算出 `ruleUrl` 并覆盖出站目标，不读这一行赋值就会奇怪「规则明明写了却没改地址」。
3. **容易以为 `MAX_PAYLOAD_SIZE = 256KB` 是全链路的请求体上限，其实它只约束「为规则求值而预读」这一条路径**：只有命中 `body` 过滤或存在 pipe 插件读端口时才缓冲正文，普通请求直接 `setupRules` 放行，转发阶段仍按流处理。
4. **容易以为抓包采集与规则改写是两条各自独立的管道，其实二者挂在同一条被包装过的流上**：改写以 Transform 形式插入、采集旁路订阅同一份 `data`，因此采集与转发并行、链路上没有额外等待点，而不是另起一条转发链去复制一遍收发逻辑。

## 小结

- 16 步链路按「归一化 → 改写采集 → 出站回写」三段推进，顺序由 `lib/index.js:40-43` 与两个 index 固定。
- 请求改写由 `req*` / `url*` 规则驱动，响应改写由 `res*` / `html|js|cssBody` / `replaceStatus` 规则驱动，二者分别落在 `req.js` 与 `res.js`。
- 出站用 `(useHttps ? https : http).request`，连接就绪才 `req.pipe(client)`；响应经 `res.src` 与 `writeHead` 回写，异常由 `error-handler` 兜底。
- `PipeStream` 让改写以 Transform 形式流式插入，解压改写重压缩必须同步删除并重建 `content-length`。
- 抓包 `data` 对象在 `data.js` 构造后广播到事件总线，与改写链并行而不阻塞转发。
- 本篇为 [《CONNECT 判定与 TLS 解密》](/core/connect-mitm) 准备了「明文请求如何走完整条链」这张底图：正因为归一化、规则求值、改写、采集、出站都已逐段厘清，10 才只需回答「CONNECT 里的 TLS 如何被还原成第 1 步那样的明文请求」，而不必重讲一遍 Express 主干。

## 下一步

[《CONNECT 判定与 TLS 解密》](/core/connect-mitm)：普通 HTTP 走完了，下一篇看 CONNECT 隧道何时被拆开、TLS 首包如何被识别并还原成明文请求。 紧接着读它，是因为本篇 16 步默认「进门时已经能读到明文」，而 HTTPS 请求先以一条不透明的隧道到达、代理看不到一个字节正文；10 正好补上这段还原工作，把本篇第 1 步的 `request` 事件变成「解密之后才接得上」的下游。
