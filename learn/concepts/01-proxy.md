---
title: 第一层：代理与流量入口
description: 用十张词条卡片讲清正向代理、PAC、上游代理、CONNECT、SOCKSv5 与 tunnel:// 伪 URL。
---

# 第一层：代理与流量入口

一切抓包与改写都始于一个朴素问题：客户端到底把请求交给了谁。本层是「概念精解」五层递进的第一层，前置概念只需要 TCP 连接、客户端与服务器、以及[代理的形态](/domain/proxy-basics)里的基本模型。读完你能判断任意一条流量该落进 `request` 还是 `connect`，说清系统代理、PAC 与上游代理各管哪一段，也明白为什么 CONNECT 的应答一发出，代理就从「看得懂 HTTP」退化成「只搬字节」。

## 本层概念地图

本层十条核心概念不是并列的，而是沿着「选路 → 进门 → 隧道」三段依次生效：先由系统代理或 PAC 决定流量去不去代理，再由请求行或 SOCKS 协商决定以什么形态被接收，最后看 CONNECT 之后是纯透传还是解密。

::: cols 24|36|40
| 环节 | 决定什么 | 对应词条 |
|---|---|---|
| 选路 | 流量是否交给代理、交给谁 | 系统代理、PAC、上游代理 |
| 进门 | 用哪种报文形态被接收 | 正反向代理、绝对 URI、SOCKS |
| 隧道 | 连接建立后是否还能读明文 | CONNECT、200、`tunnel://` |
:::

三段的接缝都在源码里：选路落在客户端与 `bin/proxy.js`，进门落在 `lib/index.js:36-61` 的四类入口，隧道判定落在 `lib/tunnel.js:168-213`。把这条链记住，再看[CONNECT 判定与 TLS 解密](/core/connect-mitm)时就不会把「隧道」和「解密」当成同一步。后续所有层——[HTTP 报文](/concepts/02-http)、[TLS 信任](/concepts/03-tls)、[规则匹配](/concepts/06-rules)——都建立在这三段已经分清楚的前提上。

## 核心词条

### 正向代理（Forward Proxy）

> 代表客户端去访问任意目标，客户端必须显式把流量交给它。

**打个比方**：像公司前台代寄快递。你把收件人写清楚交给前台，前台以自己的名义出门跑一趟，再把回件交回你手里；对外看是前台在寄件，对内发起人和收件人都没变。前台不问你要寄给谁之外的私事，但必须知道完整地址。

**在 Whistle 里**：`lib/index.js:209` 把 `request` 事件挂到 Express 应用 `app`，普通 HTTP 代理请求以「绝对 URI 请求行」进门；`lib/util/common.js:1248-1285` 的 `getFullUrl` 把它还原成完整 URL，之后的规则匹配与出站转发才认这个统一格式。`lib/index.js:36-61` 把四类入口装配到同一个 `http.Server` 上，是「一个端口服务多种协议」的根源。

```js
// lib/index.js:53-61 · 四类入口挂到同一个 server
server.on('clientError', handleClientError);
pluginMgr.setProxy(proxyEvents);
setupHttps(server, proxyEvents);
tunnelProxy(server, proxyEvents);   // CONNECT
upgradeProxy(server);               // Upgrade
initDataServer(proxyEvents);
```

**为什么这样设计**：代理要在同一条连接上服务任意域名，就必须让客户端把目标写全，代价是客户端必须感知并显式配置代理，做不到对应用透明。Whistle 把「还原 URL」集中在一个函数里，让规则、插件、出站都只面对同一种 URL 表示，避免每个环节各解析一次请求行。

**容易混淆**：与「反向代理」词条的差别在于「替谁做事」——正向代理代表客户端，反向代理代表源站；成对对照见[易混淆概念辨析](/concepts/08-confusions)。

**工程中的样子**：`www.example.com http://localhost:5173` 把整站流量交给本地 dev server，是[本地联调与环境切换](/scenarios/local-env)里最常用的一条规则；代理在这里替浏览器去访问目标，浏览器始终知道自己走了代理。

### 反向代理（Reverse Proxy）

> 代表源站接收请求，客户端以为自己就在访问真实站点。

**打个比方**：像品牌总机转接。你拨的是对外公布的号码，接线员把你转到内部某个分机，你全程不知道也不需要知道分机号；对客户端来说，总机就是这家公司本身。它隐藏的是后端，不是前端。

**在 Whistle 里**：纯反向代理形态对应客户端不配置代理、直接把域名指向代理主机，代理再按 `Host` 决定后端。`lib/index.js:96-150` 的 `createNormalServer` 为「客户端只能说纯 HTTP 或纯 TLS」的场景额外开了 `httpPort` 与 `httpsPort`，这些独立入口最终仍通过 `app.handle(req, res)` 回到同一条中间件链（`lib/index.js:106-109`），只是把 `req.isHttps` 先标好。

**为什么这样设计**：反向代理的价值是对客户端隐藏后端拓扑，适合网关与灰度；代价是代理必须预先知道域名到后端的映射，无法像正向代理那样服务任意 URL。Whistle 并未另写一套转发逻辑，而是复用同一个 `app`，让「隐藏源站」只是入口形态的差异，而不是又一条链路。

**容易混淆**：与正向代理相反，它不需要客户端配置代理；与「上游代理 / 链式代理」词条也不同，上游代理是「代理再去求助另一个代理」，反向代理是「代理假装自己是源站」。对照见[能力边界与风险](/scenarios/boundaries)。

**工程中的样子**：把某个域名解析到代理机、由规则决定后端地址，是[团队协作与配置即代码](/scenarios/collab-config)里常见的固定入口部署；调试时仍用同一个 Rules 面板，只是流量不再经过系统代理。

### 系统代理（System Proxy / OS-level Proxy）

> 操作系统级的全局开关，决定本机流量默认交给哪个代理地址。

**打个比方**：像小区的总门禁。所有住户出门都先经过这一个门，门卫按统一规则放行；你不必给每个应用单独交代，但也没法让某一家人绕过它——除非另开一张通行证。它管的是「出门这一下」，不管出了门之后走哪条路。

**在 Whistle 里**：`bin/proxy.js:2` 引入的 `set-global-proxy` 负责写入操作系统代理设置，`enableProxy` 与 `disableProxy` 分别对应开启与关闭（`bin/proxy.js:23-46`）；`w2 proxy 0` 这类命令走的就是这条路径。`bin/proxy.js:6` 的 `BYPASS_RE` 识别 `-x` / `--bypass` 参数，`bin/proxy.js:56-59` 再把紧随的值写进 `options.bypass`，让指定地址不走系统代理。

```bash
# 来源：docs/docs/cli.md、bin/proxy.js:2
w2 proxy 8899
w2 proxy 0
```

**为什么这样设计**：把「流量去哪」收敛到 OS 一处，能让不支持代理配置的桌面应用也被动接入，代价是粒度太粗——所有应用一视同仁，且只影响遵守系统设置的客户端。Whistle 因此同时提供 PAC、Proxifier 与规则级排除，用来补上「按域名分流」这一层。

**容易混淆**：系统代理只负责「交给谁」，PAC 才负责「哪些地址交给谁」；二者常被一起提起却完全不同，对照见[辨析篇](/concepts/08-confusions)。

**工程中的样子**：`w2 proxy 8899` 打开系统代理、手机 Wi-Fi 里手动填电脑 IP 与端口，是[真机、移动端与远程页面调试](/scenarios/mobile-remote)的第一步；这一步不通，后面装证书、写规则都没有意义。

### PAC（Proxy Auto-Config）

> 一段 JavaScript，按 URL 与域名动态决定请求走哪个代理或直连。

**打个比方**：像快递分拣员手里的派送表。同一个包裹，表里写着「本区自送」就直连，「外区转 A 站」就交给某个代理；表是文本，可以随时改，不必把每个收件人重新登记一遍。它只做决策，不负责搬运。

**在 Whistle 里**：PAC 是规则驱动的上游选路。`lib/rules/index.js:273` 用 `new Pac(pacUrl, dnsResolve)` 加载脚本，随后 `findWhistleProxyForURL` 把 `tunnel:` 还原成 `https:` 后查询（`lib/rules/index.js:276-283`），命中的结果再被解析成一条临时代理规则。也就是说 PAC 的输出仍然是「走哪个代理」，最终仍要落回 CONNECT 与出站逻辑。

**为什么这样设计**：把分流策略从「每台设备改配置」变成「托管一段脚本」，运维改一次即可全网生效；代价是多一跳脚本执行与缓存，且 PAC 的 `FindProxyForURL` 只认 URL，看不到请求头与 body。Whistle 把 PAC 结果编译成内部规则，使它与普通规则共用同一套匹配与出站路径。

**容易混淆**：PAC 是选路策略，不是代理协议本身；它常与系统代理搭配使用，但系统代理没有它也能工作。与[规则 DSL](/concepts/06-rules)的分工见[辨析篇](/concepts/08-confusions)。

**工程中的样子**：`* pac://{proxy.pac}` 把脚本交给规则托管，多设备按条件分流，见[真机、移动端与远程页面调试](/scenarios/mobile-remote)；脚本语法与取值方式见 `docs/docs/rules/pac.md`。

### 上游代理 / 链式代理（Upstream / Chained Proxy）

> Whistle 自己不出网，把请求再交给上一级代理转发。

**打个比方**：像跨省快递的中转站。本地网点不直接跑完全程，而是把包裹交给区域中心，由中心继续往外发；对寄件人来说只填过一次单，但包裹其实经过了两次交接。中转站之间怎么交接，是它们自己的约定。

**在 Whistle 里**：`lib/config.js:169-203` 的 `getHttpsAgent` 按 `httpsOverHttp` / `httpOverHttp` 构造 `hagent` agent（`lib/config.js:191-196`），把出站请求包进上级代理的隧道；`proxyHost`、`proxyPort`、`proxyTunnelPath` 等参数由 `lib/config.js:184-190` 传入。更复杂的二级 CONNECT 见 `lib/util/patch.js:100-159`：外层隧道保证「连得到」，内层 CONNECT 才让 Whistle 继续解密与匹配。

```js
// lib/config.js:184-196 · 上游代理 agent
options.proxy = {
  host: options.proxyHost, port: options.proxyPort,
  proxyTunnelPath: options.proxyTunnelPath
};
var agentName = options.isHttps ? 'httpsOverHttp' : 'httpOverHttp';
if (options.proxyServername) {
  options.proxy.servername = options.proxyServername;
  agentName += 's';
}
agent = new tunnel[agentName](options);
```

**为什么这样设计**：企业网络常规定「必须经上级代理才能出网」，链式代理让 Whistle 不必绕开管控也能工作；代价是链路上多一次握手、多一处分段，排障时要分清是本地规则没生效还是上级代理拒绝。把上级代理抽象成 agent，是为了让业务代码仍用同一套 `http.request` 出站。

**容易混淆**：上游代理仍在「代理替客户端跑腿」的框架内，与反向代理的「替源站接客」方向相反；「二级 CONNECT」是它的实现手段，不是另一种代理形态。边界讨论见[能力边界与风险](/scenarios/boundaries)。

**工程中的样子**：`www.example.com/api proxy://127.0.0.1:8080` 把命中接口的请求交给内网上游，见[本地联调与环境切换](/scenarios/local-env)；上级代理需要认证时再由 `proxyAuth` 补齐（`lib/config.js:182`）。

### HTTP 代理与绝对 URI 请求行（HTTP Proxy / absolute-form）

> 走 HTTP 正向代理时，请求行必须写成完整的 `http://host/path`。

**打个比方**：像信封上必须写全「省市区 + 门牌号」。直连时把门牌交给同一栋楼的传达室就够了，可一旦交给统一收发的邮局，它要服务全城地址，信封上不写全城市与街道，邮局就不知道该往哪送。

**在 Whistle 里**：`lib/util/common.js:1248-1285` 的 `getFullUrl` 用 `hasProtocol(req.url)` 区分两种请求行：带协议的是绝对 URI，拆出 `host` 与 `path` 后回填 `headers.host`（`lib/util/common.js:1251-1262`）；不带协议的是 origin-form，补一个前导斜杠即可（`lib/util/common.js:1263-1268`）。最后统一拼成 `http(s)://host/path` 供后续使用（`lib/util/common.js:1284`）。

```js
// lib/util/common.js:1248-1285 · getFullUrl 节选
function getFullUrl(req) {
  if (hasProtocol(req.url)) {          // 绝对 URI 请求行
    var options = parseUrl(req.url);
    req.url = options.path;            // 拆回 origin-form
  } else {
    req.url = req.url || '/';          // 普通直连
  }
  return (req.isHttps ? 'https' : 'http') + '://' + headers.host + req.url;
}
```

**为什么这样设计**：同一条代理连接可能服务于任意域名，只有把完整 URL 写进请求行，代理才知道转发目标；`Host` 头此时只是辅助且可能被改写。统一还原成完整 URL，让规则匹配只面对一种表示，代价是每次请求都要做一次解析与默认端口剥离（`lib/util/common.js:1241-1246`）。

**容易混淆**：origin-form 是直连写法，绝对 URI 是代理写法；CONNECT 请求行里只有 `host:port`，连路径都没有，三者形态完全不同。对照见[一次 HTTP 代理请求的旅程](/core/http-request)与[辨析篇](/concepts/08-confusions)。

**工程中的样子**：在[本地联调与环境切换](/scenarios/local-env)里写 `www.example.com/api 10.1.0.1:8080`，改的是还原之后的 `req.options`，而还原动作正发生在 `getFullUrl`；请求行的两种写法也决定了[核心链路](/core/http-request)里为什么先做 URL 归一。

### CONNECT（HTTP CONNECT Method）

> 请代理开一条到目标主机的 TCP 通路，此后不再按 HTTP 解析。

**打个比方**：像请接线员把两根电话线直接焊在一起。你说完「帮我接通某某号码」就退场，之后两边说什么、用什么语言，接线员一概不翻译也不记录，只保证线路通着。它建立的是通道，不是一次通话内容。

**在 Whistle 里**：`lib/tunnel.js:44` 的 `server.on('connect', ...)` 是总闸门，注释里写明它同时服务 `ws`、`wss`、`https proxy`；`lib/tunnel.js:53-56` 从 `req.url` 或 `Host` 取出目标，`lib/tunnel.js:65` 在没带端口时补默认 `443`，`lib/tunnel.js:75-76` 再改写成 `tunnel://` 伪 URL 并发出 `_request` 事件。是否解密则由 `lib/tunnel.js:168-213` 的 `isIntercept()` 判定。

```js
// lib/tunnel.js:44-76 · CONNECT 入口与伪 URL（节选）
server.on('connect', function (req, reqSocket) {
  var headers = req.headers;
  var tunnelUrl = util.setProtocol(
    util.isTunnelHost(req.url) ? req.url : headers.host, true);
  var options = parseUrl(tunnelUrl);
  options.port = options.port || 443;          // 默认 443
  tunnelUrl = req.fullUrl = 'tunnel://' + options.host;
  proxy.emit('_request', tunnelUrl);
});
```

**为什么这样设计**：HTTPS 不能沿用明文转发，客户端必须先要一条「干净的」TCP 通路再在里面跑 TLS，CONNECT 用最小的报文换来了协议无关性；代价是代理一旦答应，就失去了解析后续内容的能力，想抓明文只能另做中间人。Whistle 把「答应」与「是否解密」拆成两步，正是为了在这个岔路口保留选择权。

**容易混淆**：CONNECT 不是业务请求，也不是 Upgrade；它不返回业务数据，只返回隧道是否就绪。与 `Upgrade / 101` 的差别见[第二层](/concepts/02-http)与[辨析篇](/concepts/08-confusions)。

**工程中的样子**：抓包列表里那些只有域名和 `tunnel://` 的条目，就是 CONNECT 之后未解密的隧道；完整判定过程见[CONNECT 判定与 TLS 解密](/core/connect-mitm)，证书侧的排查见[HTTPS、证书与鉴权排障](/scenarios/https-trust)。

### `200 Connection Established`（Tunnel Established）

> 隧道已就绪的开关应答，不是业务请求成功的信号。

**打个比方**：像地铁闸机亮起绿灯。灯只表示「通道开了，可以往前走」，不代表你要去的店开门、也不代表货架上有货；走过去之后发生什么，闸机一概不知。把绿灯当成「办成事」是典型的误会。

**在 Whistle 里**：应答被抽成常量 `ESTABLISHED_CTN`，由 `setEstablished(socket)` 直接写回（`lib/util/index.js:369-375`）；内容只有状态行与 `Proxy-Agent`，没有 body、没有 `Content-Length`。调用点在 `lib/tunnel.js:281`：判定需要拦截、把 socket 交给 `dispatch` 之后才写回这个 200，客户端收到后才开始在隧道里发 TLS ClientHello。SOCKS 回连时 `lib/index.js:184-186` 也只检查 `res.statusCode != 200` 就销毁连接，非 200 一律视为隧道建立失败。

```js
// lib/util/index.js:369-375
var ESTABLISHED_CTN =
  'HTTP/1.1 200 Connection Established\r\nProxy-Agent: ' +
  config.appName + '\r\n\r\n';
exports.setEstablished = function (socket) {
  socket.write(ESTABLISHED_CTN);
};
```

**为什么这样设计**：CONNECT 之后字节流已经不属于 HTTP 语义，应答必须尽可能小、且不声明任何实体，否则客户端会把这些字节当成隧道里的第一批 TLS 数据。用固定常量而不是动态构造，既省一次拼装，也保证所有入口的应答完全一致；代价是这个 200 复用自 HTTP 状态码体系，容易被误读。

**容易混淆**：与业务状态码 200 毫无关系；业务成功与否要等隧道里的 TLS 握手与内层响应才知道。对照见[辨析篇](/concepts/08-confusions)。

**工程中的样子**：[HTTPS、证书与鉴权排障](/scenarios/https-trust)里「抓包只有隧道」的第一步，就是确认客户端确实收到了这个 200 并开始了 TLS 握手，而不是把 200 当成页面已加载。

### SOCKSv5（SOCKS Version 5）

> 在更低的层次协商目标地址与端口，不关心上层是什么协议。

**打个比方**：像只负责报地址的接线生。你告诉他「接到这个门牌」，他接好线就不管了，至于是打电话、发传真还是传数据，他既听不懂也不打听；比起会读信封内容的邮局，他更靠下、更通用，也更少管闲事。

**在 Whistle 里**：SOCKS 没有另写一套转发逻辑。`lib/index.js:151-207` 创建 socks server，每接受一个连接就向主端口发一个内部 CONNECT（`lib/index.js:166-173`），确认 200 后用 `reqSock.pipe(socket).pipe(reqSock)` 双向对接（`lib/index.js:187-193`）。`socksMode` 还会通过 `x-whistle-policy: weakTunnel` 影响后续判定（`lib/index.js:163-165`）。

```js
// lib/index.js:166-193 · SOCKS 翻译成内部 CONNECT
var client = http.request({
  method: 'CONNECT', agent: false,
  path: connPath, host: boundHost,
  port: config.port, headers: headers
});
client.on('connect', function (res, socket) {
  if (res.statusCode != 200) { return destroy(); }
  var reqSock = accept(true);
  reqSock.pipe(socket).pipe(reqSock);
});
client.end();
```

**为什么这样设计**：SOCKS 支持任意 TCP 协议且能传域名，适合不支持 HTTP 代理的应用；代价是它本身不携带 HTTP 语义，代理必须自己把它「翻译」成能复用现有链路的形态。Whistle 选择翻译成内部 CONNECT，于是 SOCKS、HTTP 代理、反向代理最终都汇流到同一条隧道处理链，只差「谁来写这第一个 CONNECT」。

**容易混淆**：SOCKS ≠ HTTP 代理，前者协商地址端口、后者解析请求行；SOCKS 也不等于隧道本身，它只是入口。对照见[辨析篇](/concepts/08-confusions)。

**工程中的样子**：`dl.example.com socks://127.0.0.1:1080` 把下载域名交给 SOCKSv5，见[真机、移动端与远程页面调试](/scenarios/mobile-remote)；规则默认端口 443 的约定来自 `docs/docs/rules/socks.md`，与 HTTP 代理默认 80（`docs/docs/rules/proxy.md`）不同。

### 隧道代理（`tunnel://` 伪 URL / Tunnel URL）

> Whistle 内部给 CONNECT 隧道统一起的伪协议 URL，只用于匹配与展示。

**打个比方**：像仓库给尚未拆封的包裹贴的内部编号。包裹里是什么还没打开，但编号已经能让它进入分拣、排队、上架的流程；编号不是内容，只是让系统先有一个可以处理的把手。

**在 Whistle 里**：`lib/tunnel.js:75` 把 CONNECT 目标改写成 `'tunnel://' + options.host` 并赋给 `req.fullUrl`，随后 `proxy.emit('_request', tunnelUrl)` 让它进入统一的请求事件流（`lib/tunnel.js:76`）。`lib/rules/index.js:277` 在查 PAC 时又把 `tunnel:` 还原成 `https:`，说明这个前缀是内部表示，最终仍要映射回真实协议。

**为什么这样设计**：规则匹配、抓包展示、插件分发都依赖一个统一的 URL 字段，可 CONNECT 请求里根本没有路径与方法；造一个伪 URL 就能让隧道请求复用整套规则与抓包管线，而不必为它另开一条分支。代价是任何消费 `fullUrl` 的地方都要知道 `tunnel:` 不是真实协议，必要时做还原。

**容易混淆**：`tunnel://` 不是客户端发来的协议，也不是 `https://`；它只是代理内部给「还没解密的连接」起的名字，与[CONNECT 判定](/core/connect-mitm)里的 MITM 是「表示」与「动作」的关系。对照见[辨析篇](/concepts/08-confusions)。

**工程中的样子**：抓包列表里隧道条目的 URL 一栏显示的就是它；按域名写规则能命中隧道，正是因为[CONNECT 判定与 TLS 解密](/core/connect-mitm)之前先有了这个可供匹配的 `fullUrl`。

## 次要词条速览

以下十条只对齐称呼，不展开原理；需要完整卡片时回看上面的核心词条，成对辨析去[辨析篇](/concepts/08-confusions)。

::: cols 20|30|28|22
| 名词 | 一句话 | 源码落点 | 易混淆 |
|---|---|---|---|
| 独立端口 | httpPort/httpsPort 直连入口 | `lib/index.js:96` | 与正向代理 |
| origin-form | `GET /path` 式请求行 | `lib/util/common.js:1263` | 与绝对 URI |
| HTTPS 代理 | 独立 TLS 监听入口 | `lib/index.js:124` | 与 CONNECT |
| Proxifier | 强制进程走代理的工具 | `lib/tunnel.js:210` | 与系统代理 |
| ZeroOmega | 浏览器代理切换扩展 | `lib/rules/index.js:273` | 与 PAC 脚本 |
| 二级 CONNECT | 隧道里再发一次 CONNECT | `lib/util/patch.js:100` | 与上游代理 |
| 代理认证 | 上游要求 Proxy-Authorization | `lib/config.js:182` | 与业务鉴权 |
| bypass | 系统代理排除名单 | `bin/proxy.js:6` | 与规则排除 |
| IPv6 地址 | 目标地址需加方括号 | `lib/tunnel.js:68` | 与域名 |
| 端口缺省 443 | CONNECT 未带端口时补齐 | `lib/tunnel.js:65` | 与默认 80 |
:::

速览表里的落点值得留意：`lib/tunnel.js:65` 的 `port || 443` 与 `docs/docs/rules/proxy.md` 里 HTTP 代理默认 80 是两套不同约定，写上游规则时不填端口，结果会差一个协议族。

## 与工程实际结合

现场往往同时用到本层的三段。设想公司网络规定「必须经上级代理出网」，而前端又要把线上域名的接口指到本机 dev server，手机还要能连进来抓包：系统代理负责把流量收进来，PAC 决定哪些域名走上级代理，规则决定哪些路径回本地，CONNECT 则承载所有 HTTPS 入口。完整配置见[本地联调与环境切换](/scenarios/local-env)，设备接入见[真机、移动端与远程页面调试](/scenarios/mobile-remote)，隧道之后发生什么见[CONNECT 判定与 TLS 解密](/core/connect-mitm)，形态对照回看[代理的形态与 CONNECT 隧道](/domain/proxy-basics)。

```txt
# 来源：docs/docs/rules/proxy.md、socks.md、pac.md
# 接口走内网上游 HTTP 代理
www.example.com/api proxy://127.0.0.1:8080
# 下载域名走 SOCKSv5 代理
dl.example.com socks://127.0.0.1:1080
# 其余按 PAC 脚本条件选路
* pac://{proxy.pac}
```

```bash
# 来源：docs/docs/cli.md、bin/proxy.js:2
w2 proxy 8899
w2 proxy 0
```

排查顺序也按三段来：先 `w2 proxy 8899` 确认系统代理生效，再看抓包里是否出现 CONNECT 与 `tunnel://` 条目，最后才判断是否需要 `enable://capture` 解密（`docs/docs/rules/enable.md`）。把入口问题和解密问题分开，能省掉大量「改了规则没反应」的来回。

## 常见误解

1. **代理 ≠ VPN**：代理是应用层的「替你转发某个请求」，VPN 在网络层把整台设备接进另一个网络；系统代理看起来像全局开关，但只影响遵守该设置的客户端与协议，见[能力边界与风险](/scenarios/boundaries)。
2. **CONNECT 200 ≠ 业务成功**：`200 Connection Established` 只表示隧道就绪（`lib/util/index.js:369-375`），业务成功要等隧道里的 TLS 握手与内层响应，见[HTTPS、证书与鉴权排障](/scenarios/https-trust)。
3. **SOCKS ≠ HTTP 代理**：SOCKS 协商地址与端口、不读请求行，HTTP 代理靠绝对 URI 请求行工作；Whistle 把 SOCKS 翻译成内部 CONNECT 才复用同一链路（`lib/index.js:151-207`），对照见[辨析篇](/concepts/08-confusions)。
4. **系统代理 ≠ PAC**：前者是 OS 级「交给谁」的开关（`bin/proxy.js:2`），后者是按 URL 决定「哪些交给谁」的脚本（`lib/rules/index.js:273`），二者常一起用却不同层。
5. **正向代理 ≠ 反向代理**：一个代表客户端、需要客户端配置，一个代表源站、对客户端隐藏后端；`lib/index.js:96-150` 的独立入口只是反向代理形态的一种落地，不代表两者实现不同。
6. **隧道 ≠ 解密**：CONNECT 之后的默认行为是纯字节透传，只有 `lib/tunnel.js:168-213` 判定命中才会转入 MITM，见[CONNECT 判定与 TLS 解密](/core/connect-mitm)。

## 小结

- 本层沿「选路 → 进门 → 隧道」三段展开，三段分别由客户端、请求行形态、CONNECT 判定负责。
- 一个 `http.Server` 挂 `request` / `connect` / `upgrade` / `clientError` 四类入口（`lib/index.js:36-61`），是单端口服务多协议的根源。
- 正向代理用绝对 URI 请求行，`getFullUrl` 统一还原成完整 URL（`lib/util/common.js:1248-1285`）。
- CONNECT 的 200 是隧道就绪开关（`lib/util/index.js:369-375`），之后默认看不到明文。
- SOCKSv5 被翻译成对主端口的内部 CONNECT（`lib/index.js:151-207`），与 HTTP 代理汇流到同一链路。
- `tunnel://` 是内部伪 URL（`lib/tunnel.js:75`），只为让隧道请求复用规则与抓包管线。

## 下一步

[《第一层：HTTP 报文与连接语义》](/concepts/02-http)：流量进门之后，讲清请求行、Header、Body、分块与压缩、Keep-Alive、HTTP/2 伪头、ALPN、Upgrade 与帧，看代理究竟能读懂多少、又能改写多少。
