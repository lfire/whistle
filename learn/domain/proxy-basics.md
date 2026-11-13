---
title: 代理的形态与 CONNECT 隧道
description: 从请求行与 CONNECT 报文出发，解释 Whistle 四类入口与端口配置的由来。
---

# 代理的形态与 CONNECT 隧道

代理工具的所有魔法，起点都是「客户端把请求发给了谁」。本节先区分正向、反向与隧道三种形态，讲清[绝对 URI](/concepts/01-proxy) [请求行](/concepts/02-http)与 [CONNECT](/concepts/01-proxy) 的语义差异，再对照 Whistle 的四个事件入口和端口配置。读完你能判断任意一条流量该落进 `request` 还是 `connect`，也知道 `sockets=256` 究竟限制的是什么。 承接 01 给的代码地图，本篇把「一次请求进来先落到哪里」的悬念落到具体报文上：先弄清流量以什么形态进门，后面 03 才谈得上看不看得见明文。

::: tip 先修知识
本篇承接 [《站点导览与代码地图》](/guide/orientation)（前置 01），需要你已经理解 TCP 连接与端口、HTTP/1.1 报文结构（请求行、头部、实体），以及「代理 = 替客户端或源站转发流量」这个直觉。若对代理的几种形态、请求行的两种写法、隧道与选路策略不熟悉，可先读 [《概念精解 · 代理与流量入口》](/concepts/01-proxy)；对报文结构的展开可查 [《概念精解 · HTTP 报文与连接语义》](/concepts/02-http)；对内核事件可查 [《概念精解 · Node 运行时与内核骨架》](/concepts/04-runtime)。不要求预先读过 Whistle 源码，但知道 [`http.createServer`](/concepts/04-runtime) 会触发哪些事件会更好。

给完全没读过源码的读者补三个基本词：TCP 连接是两台机器之间一条可靠的字节管道，端口只是这条管道两端的编号，用来区分同一台机器上的不同服务；HTTP 请求是写在这条管道上的一段文本，开头说明要什么、后面才带上附加信息与实际内容；HTTPS 则是把这段文本先加密再送进管道，所以代理默认读不到内容、只能确定「有个连接连到了某个地址」。本篇要回答的，正是代理在看不到内容时如何先把这条管道接通。

全站阅读地图见 [《站点导览与代码地图》](/guide/orientation) 的「全站编排与编号」表：本篇是领域基础 02，承接 01 的地图；后面 03 讲加密与信任、04 讲各协议的帧、05 收拢成调试工作流，再往后才进入架构与核心链路。概念词典总入口是 [《概念精解：从名词到工程直觉》](/concepts/index)，忘记某个名词查 [《全量术语索引》](/concepts/glossary)。
:::

## 三种代理形态

三者最容易混淆的地方，是「代理替谁做事」。[正向代理](/concepts/01-proxy)代表客户端去访问任意源站，客户端必须显式配置；反向代理代表源站接收请求，客户端以为自己就在访问真实站点；隧道代理则既不解析也不改写应用协议，只把一条 TCP 字节流从一个端点搬到另一个端点。

### 请求行为何有两种写法

普通直连时请求行是 origin-form：`GET /path HTTP/1.1`，主机信息放在 `Host` 头里。走 HTTP 正向代理时，请求行必须是绝对 URI：`GET http://example.com/path HTTP/1.1`。为什么？因为代理在同一条连接上可能服务于任意域名，只有把完整 URL 写进请求行，它才知道该把请求转发给谁；`Host` 头此时只是辅助，且可能被改写。

这个差异直接决定了实现：Whistle 收到 `request` 事件时，拿到的是已经带完整目标信息的请求，因此可以在[中间件](/concepts/04-runtime)链里解析规则、改写头部和 body；而 CONNECT 请求行里只有 `host:port`，没有任何路径与方法可供改写。

两种请求行的归一化落在 `lib/util/common.js:1248-1285` 的 `getFullUrl(req)`：当 `hasProtocol(req.url)` 命中（`:1251`，即绝对 URI）时，先用 `parseUrl` 拆出协议与主机，把 `req.url` 改回 `/path` 形式、把主机名写进 `headers.host`（`:1259-1262`）；origin-form 分支则只保证 `req.url` 以 `/` 开头（`:1263-1268`）。最后 `:1284` 按 `req.isWs` / `req.isHttps` 拼回 `http(s)://` 或 `ws(s)://` 开头的完整 URL。于是下游中间件只需面对统一的 `req.url` + `Host`，规则匹配（`lib/rules/index.js:645` 取 `req.fullUrl || util.getFullUrl(req)`）读到的始终是拼好的完整 URL——这正是「绝对 URI 只出现在代理入口」的原因。

把归一化那段的结论再展开一步：之所以要把绝对 URI 在入口处就改回 `/path`、把主机名回填进 `headers.host`，是因为下游的规则匹配、插件与出站都只认一种 URL 表示；若让两种请求行一路并存，每个环节都得各解析一次，既容易出错也无法统一命中。

代价是每次请求都多一次解析与默认端口剥离，换来的是「绝对 URI 只出现在代理入口」这条清晰边界；这也解释了为什么 CONNECT 请求行里没有路径时，代理根本无从改写。

### CONNECT 建立的是隧道，不是请求

HTTPS 流量不能沿用上面的转发方式：代理若想读明文，就必须先让客户端相信自己就是源站。客户端的做法是先发 `CONNECT example.com:443 HTTP/1.1`，请代理开一条到目标的 TCP 通路；代理回 `HTTP/1.1 200 Connection Established` 之后，这连接的语义就变了——后续字节不再由代理按 HTTP 解析，而是原样双向透传，客户端在这条隧道里跑 TLS 握手。

Whistle 把这个应答抽成了常量：`lib/util/index.js:369-375` 的 `ESTABLISHED_CTN` 与 `util.setEstablished(socket)`；调用点在 `lib/tunnel.js:281`——纯透传分支（判定不解密）确认目标可达后对客户端 socket 写出这段固定字节串，客户端收到即开始在这条连接上发 TLS ClientHello。注意「200」在这里不是业务成功码，而是「隧道已就绪」的开关；一旦发出，代理就退化为管道。也正因如此，纯透传模式下 Whistle 看不到 HTTPS 里的任何内容，抓 HTTPS 必须走后一篇要讲的中间人解密。

把「200 是开关而非业务码」再推一步：`ESTABLISHED_CTN` 被写成固定常量、内容只有状态行、没有 body 也没有 `Content-Length`，是因为 CONNECT 之后字节流已经不属于 HTTP 语义，应答里多写任何一个字节都会被客户端当成隧道里的第一批加密数据。代价是这个 200 复用了 HTTP 状态码体系，最容易被误读成「请求成功」。

一个可自行核对的最小动作：数一数这段应答有没有实体、有没有长度头——答案是都没有，正好印证「代理已经退化成管道」。

### SOCKS、PAC 与系统代理各管一段

SOCKS 工作在更低的层次：它协商的是目标地址与端口，不关心上层是 HTTP 还是别的东西，也不使用 HTTP 请求行。PAC 是一段决定「哪些流量走哪个代理」的 JavaScript，属于客户端的选路策略；系统代理则是操作系统级的全局开关。三者常一起出现，但职责完全不同：PAC / 系统代理决定流量去哪，SOCKS 或 HTTP 代理决定流量怎么被搬运。

![三种代理形态下的请求行与数据流向](/diagrams/proxy-modes.svg)
*图注：正向代理改写请求行并解析 HTTP，隧道代理只透传字节，反向代理对客户端隐藏源站。*

**为什么这样设计**：三种形态按「代理替谁做事」区分，而不是按用了什么协议区分，因为真正决定后续能做什么的正是这个方向——正向代理代表客户端、必须显式配置，反向代理代表源站、对客户端隐藏后端，隧道代理谁也不代表、只搬字节。把「请求行为何有两种写法」的结论展开成推理：代理在同一条连接上可能服务任意域名，只有把完整 URL 写进请求行才知道转发给谁，`Host` 头此时只是辅助且可能被改写；于是绝对 URI 只出现在代理入口，归一化后下游只面对统一的 `req.url` + `Host`。

**CONNECT 为什么是隧道而不是请求**：HTTPS 不能沿用明文转发，客户端必须先要一条干净的 TCP 通路再在里面做加密握手；一旦 `HTTP/1.1 200 Connection Established` 发出，代理就退化为管道、不再解析应用协议。代价是纯透传模式下看不到任何内容，抓明文必须另走解密；把那个「200」记成隧道就绪的开关、而不是业务成功码，排查时才不会误判。

**SOCKS、PAC 与系统代理为什么各管一段**：SOCKS 在更低的层次只协商目标地址与端口，PAC 是客户端的选路脚本，系统代理是 OS 级全局开关；三者常一起出现却不同层——PAC / 系统代理决定「流量去哪」，SOCKS 或 HTTP 代理决定「流量怎么被搬运」。边界是：SOCKS 看不到 HTTP 语义，PAC 只看得到 URL，系统代理粒度最粗。

**打个比方**：正向代理像替你寄快递的前台、必须知道完整收件地址；反向代理像品牌总机、你拨的是对外号码却不知道转去了哪个分机；隧道代理则像把两根电话线直接焊起来的接线员，之后两边说什么一概不翻译。

**自己验证**：把 `GET /path HTTP/1.1` 与 `GET http://example.com/path HTTP/1.1` 两个请求行并排抄下来，数一数主机信息分别写在哪一处——不用任何工具就能确认「直连看 `Host`、代理看请求行」这条差异，也就能推出 CONNECT 请求行里只有 `host:port` 时为什么无从改写。

这三段合起来正好是「选路 → 进门 → 隧道」：先决定交给谁，再看以什么报文形态被接收，最后看 CONNECT 之后还读不读得懂。

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

把「延后注册 `request`」再展开一句：界面路由与插件 UI 先初始化，换来的是「请求进来时规则与插件一定已就绪」这个不变量；若不等它们就挂上，早期请求可能在没有任何规则的情况下被转发出去，排查时会看到无从解释的裸流量。

`clientError` 统一回 400 或 431 也是同一思路：把畸形报文收口在一个处理函数里，避免头部溢出这类边界把整个进程带崩——这是稳定性优先于「尽量多说一句错误信息」的取舍。

### connect 与 upgrade

CONNECT 由 `lib/tunnel.js:44` 的 `server.on('connect', ...)` 接手，这里是判定「透传还是解密」的总闸门。Upgrade 由 `lib/upgrade.js:179-181` 挂到 `server.on('upgrade')`，进入 `lib/upgrade.js:77-177` 的 `upgradeHandler`，把 WebSocket 交给连接管理器。四个事件共用同一个端口，是 Whistle 只需一个 `port` 就能同时服务 HTTP、HTTPS 与 WebSocket 的根本原因。

把「四个事件共用同一个端口」再展开一句：`connect` 与 `upgrade` 看似都在处理「非普通请求」，却分属两条不同的路——前者判「透传还是解密」，后者把 WebSocket 交给连接管理器。代价是两条路径都得自己补齐客户端信息，边界是：一旦走了 `connect` 的纯透传分支，代理就再也拿不到可供后续解析的 HTTP 语义。

这也预告了下一篇要解决的问题：想既保留这条连接、又读得到里面的内容，就必须换一种处理方式，而不是继续透传。

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

**为什么这样设计**：内核只创建一个 `http.Server`，却把 Node.js 的四个事件分别挂到不同子系统，是为了让普通请求、CONNECT、WebSocket 升级与畸形报文共用一个端口。把结论展开成推理：`request` 延后到 Web 子系统就绪才注册，是因为界面路由与插件 UI 要先初始化，否则请求可能在规则与插件没准备好时就进来；`clientError` 统一回 400 或 431，是避免头部溢出把进程带崩。

**代价与边界**：四类入口共用同一端口的代价，是每个事件的处理函数都必须自己判明上下文，不能再假设「来的一定是普通 HTTP」；`connect` 因此成了「透传还是解密」的总闸门，`upgrade` 得把 WebSocket 交给连接管理器。

**SOCKS 为什么复用主端口**：SOCKS 没有另写一套转发逻辑，而是每接受一个连接就向主端口发一个内部 CONNECT，确认 200 后用双向对接把两条 socket 接起来。好处是 SOCKS、HTTP 代理、反向代理最终汇流到同一条隧道链，差异只在「谁来写这第一个 CONNECT」；代价是排障时要意识到你看到的 CONNECT 可能来自内部翻译，而非客户端原始报文。

**打个比方**：一个 `http.Server` 像写字楼前台，`request` / `connect` / `upgrade` / `clientError` 是四个不同的接待窗口、共用一个大门牌号；SOCKS 则是隔壁那栋楼，先打内线电话到前台要一条通道，再把两条线接起来。

**自己验证**：对照那段装配代码，数一数 `server.on(...)` 共挂了几个事件、分别交给哪个子系统；再顺着 SOCKS 一节看它向主端口发出的 `method: 'CONNECT'`，就能确认「四类入口 + 一个端口」与「内部 CONNECT 汇流」是同一套设计的两面。

理解了这一点，下一篇谈「装根证书后把 CONNECT 拆开」时，你才知道要动的是 `connect` 这一条入口，而不是另起一个监听端口。

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

最容易读错的是 `sockets`：它不是监听数量，也不是并发总量，而是交给 `http.Agent` 的 `maxSockets`，即**对每个目标域名**可复用的连接池上限（`lib/config.js:1039-1048`）。把它调大是为了减少高并发出站时的排队，与监听端口无关。还要注意 `lib/config.js:1046-1048`：默认 `disableAgent = !newAgentConf && !useAgent` 为真，`config.httpAgent` / `httpsAgent` 会直接被置为 `false`，连接池根本不启用；只有显式传入 agent 配置或 `useAgent` 时才创建 `HttpAgent` / `HttpsAgent`。源码 `:1045` 的注释说明，这是为规避 Node 11 及以上版本缓存连接的问题。`httpPort` / `httpsPort` 则是给「客户端只能说纯 HTTP 或纯 TLS」的场景用的额外入口，最终仍通过 `lib/index.js:96-123` 的 `createNormalServer` 回调到同一个 `app`。

**为什么这样设计**：默认值来自包配置、运行时由 `lib/config.js` 解析，把「启动时定死」与「运行时可覆盖」分成两层，是为了让同一份二进制在不同环境里不必重新编译。单独看 `sockets`，它是交给 `http.Agent` 的每域名连接池上限，而不是监听数量或并发总量；把它调大是为减少高并发出站时的排队，与监听端口无关。

**代价与边界**：这里最反直觉的边界是——默认 `disableAgent` 为真时 `config.httpAgent` / `httpsAgent` 直接被置为 `false`，连接池根本不启用，只有显式传入 agent 配置或 `useAgent` 时才创建；这是为规避特定 Node 版本缓存连接的问题。`httpPort` / `httpsPort` 则是给「客户端只能说纯 HTTP 或纯 TLS」场景的额外入口，最终仍回调到同一个 `app`，并未另开一套转发。

**打个比方**：`port` 是店铺的门牌号，`sockets` 是后仓对每个供应商各留几个备货位——前者决定客人从哪进门，后者决定同时能向同一个供应商发几趟车；把两者混为一谈，就会以为「调大 sockets 能接更多客人」。

**自己验证**：在端口表里对照 `port`、`sockets`、`httpPort` 三行的「含义」列，问自己「它限制的是进门的人、还是出库的货车」；能答对，就不会再把 `sockets=256` 读成监听数。

把「独立入口最终仍回到同一条中间件链」记住，后面架构篇看四类入口如何拼成一个进程时，就不会误以为每种协议各有独立内核。

## 上游代理与链式 CONNECT

企业网络里常有「必须经上级代理才能出网」的限制，Whistle 支持把自己挂到上游代理之后。`lib/config.js:169-203` 的 `getHttpsAgent` 用 `hagent` 的 `httpsOverHttp` / `httpOverHttp` agent（`lib/config.js:12`、`lib/config.js:191-196`）把出站请求包进上级代理的隧道；`lib/config.js:184-190` 把 `proxyHost`、`proxyPort` 等参数交给这个 agent。

更复杂的是二级 CONNECT：`lib/util/patch.js:100-159` 改写 `http.request`，当存在 `proxyTunnelPath` 时，先与上级代理完成一次 CONNECT 拿到 200，再在这条隧道里手写第二个 CONNECT 报文发给 Whistle 主端口（第 137 行 `common.getHttpMeta('CONNECT', tunnelPath, ...)`），必要时带上 `x-whistle-policy: intercept`（`lib/util/patch.js:133-136`）。为什么要两级？因为外层隧道只能保证「连得到 Whistle」，内层 CONNECT 才是让 Whistle 继续做解密与规则匹配的入口。

**为什么这样设计**：企业网络常规定「必须经上级代理才能出网」，把自己挂到上游代理之后，Whistle 就不必绕开管控也能工作；把出站请求交给 `hagent` 的 agent，是为了让业务代码仍用同一套出站调用，不必为「走不走上级」分叉。

**二级 CONNECT 为什么要两级**：外层隧道只能保证「连得到 Whistle」，内层 CONNECT 才是让 Whistle 继续做解密与规则匹配的入口；少一层，请求就停在上级代理的隧道里、进不了主线。代价是链路上多一次握手、多一处分段，排障时要分清是本地规则没生效，还是上级代理拒绝了。

**打个比方**：像跨省快递的中转站——本地网点不跑完全程，把包裹交给区域中心再往外发；中转站之间怎么交接是它们自己的约定，但寄件人只填过一次单。

**自己验证**：顺着出站一节看 `proxyHost`、`proxyPort` 等参数交给 agent、再看二级 CONNECT 在隧道里手写第二个报文，确认「外层管连通、内层管进门」这两步没有合并成一步。

## 常见误解

1. **容易以为 CONNECT 的 200 是业务成功码，其实它只是「隧道已就绪」的开关**：一旦发出，代理就退化为管道、不再解析应用协议；里面加密握手与页面是否真正成功，要等隧道里的内层响应才知道，对照见[《易混淆概念辨析》](/concepts/08-confusions)。
2. **容易以为 `sockets=256` 限制的是监听数量或并发总量，其实它是每域名连接池上限**：它是交给 `http.Agent` 的 `maxSockets`，而且默认 `disableAgent` 为真时连接池根本不启用，只有显式传入 agent 配置或 `useAgent` 时才创建，与监听端口无关。
3. **容易以为 SOCKS 是另一套转发链路，其实它被翻译成对主端口的内部 CONNECT**：SOCKS、HTTP 代理、反向代理最终汇流到同一条 CONNECT 处理链，差别只在「谁来写这第一个 CONNECT」。
4. **容易以为绝对 URI 请求行会一路传到源站，其实它只出现在代理入口**：归一化会把请求行改回 `/path` 形式、把主机名写进 `headers.host`，下游中间件面对的是统一的 `req.url` + `Host`，规则匹配读到的始终是拼好的完整 URL。

## 小结

- 正向代理用绝对 URI 请求行，反向代理隐藏源站，隧道代理只搬字节。
- CONNECT 的 200 是隧道就绪信号，之后代理不再解析应用协议。
- 一个 `http.Server` 挂 `request` / `connect` / `upgrade` / `clientError` 四类入口。
- SOCKS 被转换成对主端口的内部 CONNECT，复用同一条隧道链。
- `sockets=256` 是每域名连接池上限，不是监听数；上游与链式代理靠两级 CONNECT 实现。
- 本篇为 [《HTTPS、证书链与中间人》](/domain/tls-mitm) 准备了「CONNECT 之后代理看不到明文」这个起点：正因隧道里跑的是加密字节，03 才需要讨论装根证书与两段加密连接。

## 下一步

[《HTTPS、证书链与中间人》](/domain/tls-mitm)：既然 CONNECT 默认看不到明文，Whistle 又是如何在装了根证书之后把 HTTPS 拆成两段 TLS 的。 紧接着读它，是因为本篇结尾停在「CONNECT 之后代理退化为管道、看不到明文」这个未解问题；03 正好回答如何把这条不透明的管道重新拆开。
