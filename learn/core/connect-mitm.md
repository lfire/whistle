---
title: CONNECT 判定与 TLS 解密
description: 拆解 CONNECT 的解密判定、首包识别、SNI 证书签发与两段独立 TLS 的还原路径。
---

# CONNECT 判定与 TLS 解密

上一篇的 16 步链路处理的是「已经能读到明文」的请求；而 HTTPS 代理请求首先以 [CONNECT 隧道](/concepts/01-proxy) 的形式到达，代理看不到一个字节的正文。本篇回答两个问题：Whistle 凭什么决定拆开某条 CONNECT，以及拆开之后如何把 [TLS](/concepts/03-tls) 首包还原成上一篇那条 Express 链路。领域基础 03 已经把「两段独立握手」的模型与两个信任边界讲透，本篇不重复原理，只把那套模型落成可定位的分支；文中所有判定都落到 `lib/tunnel.js` 与 `lib/https/index.js` 的真实分支上，读完你能解释「为什么装了根证书也不一定解密」。

::: tip 先修知识
本篇承接 [《一次 HTTP 代理请求的旅程》](/core/http-request)（前置 09）与 [《HTTPS、证书链与中间人》](/domain/tls-mitm)（前置 03）：需要你已经理解 09 的 16 步 Express 主干（归一化 → 定规则 → 改写 → 采集 → 出站回写），以及 03 的 TLS 握手、证书链与信任锚、两段独立 TLS 的 MITM 模型、装根证书为何是前提、证书固定与双向认证为何会拒绝换证书。若对证书、SNI 与信任边界不熟悉，可先读 [《概念精解 · TLS、证书与信任》](/concepts/03-tls)；对 CONNECT 与隧道语义可回看 [《概念精解 · 代理与流量入口》](/concepts/01-proxy)；对抓包 `data` 对象、帧与 `reqId` 可查 [《概念精解 · 抓包数据面与帧》](/concepts/05-capture)；对规则与策略值的命中可查 [《概念精解 · 规则 DSL 全景》](/concepts/06-rules)；想按时间顺序看一次请求的完整贯通可读 [《概念精解 · 综合贯通：一次 HTTPS 请求里的全部概念》](/concepts/09-walkthrough)。

不需要预先读过源码，但要先接受 03 的结论「MITM 不是破解加密，而是让两侧各做一次独立握手」；成对辨析可查 [《易混淆概念辨析》](/concepts/08-confusions)，忘记名词查 [《全量术语索引》](/concepts/glossary)。
:::

![CONNECT 解密判定的信号与分支](/diagrams/connect-decision.svg)
*图注：策略头、规则开关、全局抓包、系统黑名单与自定义证书共同决定是否进入解密分支。*

## CONNECT 入口与 URL 归一

`lib/tunnel.js:38-44` 的 `tunnelProxy(server, proxy, type)` 在主 server 上注册 `connect` 事件，源码注释只有一句 `//ws, wss, https proxy`（`lib/tunnel.js:45`），点明这一入口同时承载 WebSocket 与 HTTPS 代理两类流量。`type` 为 1 / 2 时分别标记来自独立 HTTPS / HTTP 端口，主 server 则为 undefined。

```js
// lib/tunnel.js:44-45
server.on('connect', function (req, reqSocket) {
  //ws, wss, https proxy
```

紧接着 `:53-75` 把 CONNECT 行归一化。`util.setProtocol` 把 `req.url` 或 `Host` 补成带协议的 URL，`parseUrl` 解析后在 `:65` 对缺省端口补 `443`（`port || 443`），IPv6 地址还会被包上方括号；最后 `:75` 统一写成 `req.fullUrl = 'tunnel://' + options.host`。

```js
// lib/tunnel.js:75-76
tunnelUrl = req.fullUrl = 'tunnel://' + options.host;
proxy.emit('_request', tunnelUrl);
```

这个 `tunnel://host:port` 不是真实协议，而是内核给隧道流量用的伪 URL：后续的规则匹配、[抓包](/concepts/05-capture)展示、`socketMgr` 的帧归属都拿它当标识。同一段代码还分配 [`reqId`](/concepts/05-capture)（`:89`）、解析客户端 IP 与端口（`:81-86`）、把 `req.rules` 挂到 `reqSocket` 上，为后面的判定备好上下文。

之所以不直接沿用 `https://`，是因为 CONNECT 阶段代理只知道目标主机与端口，并不知道路径、方法乃至是否真的跑 HTTP；用独立协议前缀把「未知内容的字节管道」与「已知 URL 的请求」区分开，规则引擎才不会对一条隧道误判路径匹配。`:76` 紧接着 `proxy.emit('_request', tunnelUrl)`，正是让抓包侧在解密尚未开始前就先登记这条连接。

**为什么用 `tunnel://` 伪 URL，而不直接沿用 `https://`**：CONNECT 阶段代理只知道目标主机与端口，并不知道路径、方法乃至里面是否真的跑 HTTP。把结论展开成推理：若硬写成 `https://host`，规则引擎就会拿一条根本没有 URL 的字节管道去做路径匹配，命中结果全无意义；用一个独立协议前缀把「未知内容的字节管道」与「已知 URL 的请求」分开，后续匹配、展示与帧归属才有统一标识。代价是它只是内核内部的分类标签，不能被当作真实协议拿去发请求；边界是它只描述「连到了哪里」，不描述「里面是什么」。

**为什么上下文要在这时就挂齐**：归一化的同一段里就把编号、客户端 IP 与端口、`req.rules` 一并备好。把这句展开：隧道后续可能被拆成新的 `req` 对象、也可能一路透传到底，若等到解密或出站才补这些信息，早先登记的连接就与后面的请求对不上号；在入口一次性定形，抓包侧才能在解密尚未开始前就先登记这条连接。代价是这一段要同时干「归一」与「登记」两件事、职责偏重；边界是它只备料，不决定要不要解密。

**输入 → 动作 → 输出**：输入是 CONNECT 行里的 `host:port`，动作是补协议与缺省端口、拼出 `tunnel://` 伪 URL、分配编号并挂上客户端信息与规则上下文，输出是一条「内核认识得、但内容仍未知」的连接对象，以及一次发给抓包侧的登记事件。

**代价与边界**：`type` 为 1 / 2 时来自独立 HTTPS / HTTP 端口、主 server 则为 undefined，三者复用同一个处理器，好处是四类入口不必各写一套归一逻辑；代价是读代码时要先分清这条 CONNECT 来自哪个端口，边界是它只解决「怎么标记」，真正的解密判定要等下一节的五个信号。

**打个比方**：像给一只还没拆封的包裹先贴一张内部标签，写明「从哪来、编号多少、归谁管」，但标签上不写里面装了什么——因为此刻谁也还没打开它。

**自己验证**：对照那段把 `tunnelUrl` 赋值的代码，数一数它被写了几处、又 `emit` 给谁；再问自己「这段里有没有出现任何路径或方法」，答「没有」，就理解了为什么伪 URL 里只能有主机与端口。

## 解密判定：五个信号与策略头

判定集中在 `lib/tunnel.js:168-213` 的 `rules.resolveRulesFile` 回调里，由四个局部函数与一个总闸组成。`isDisabledProps()`（`:168-170`）检查 `disable.intercept` / `disable.https` / `disable.capture` 三个开关；`isDisableIntercept()`（`:171-178`）把它们与 `isICloudDB`、`useTunnelPolicy`、插件请求合并；`isCustomIntercept()`（`:179-187`）检查 `filter.https` / `filter.capture` / `filter.intercept` 以及策略头里的 `intercept` / `capture`；`isEnableIntercept()`（`:191-201`）则叠加全局开关与黑名单。

```js
// lib/tunnel.js:179-187
var isCustomIntercept = function () {
  return (
    filter.https ||
    filter.capture ||
    filter.intercept ||
    policy === 'intercept' ||
    policy === 'capture'
  );
};
```

全局开关与黑名单是最保守的一层。`tunnel.js:195` 先问 `rulesUtil.properties.isEnableCapture()`：未开启抓包时，只有 `existsCustomCert(hostname)` 命中自定义证书才继续；开启后，`:199-200` 用 `CRONET_RE`（`:26`）拦下 Cronet UA，用 `SYS_HOST_RE`（`:27`）放行 Apple、iCloud、Microsoft、Office365 等系统域名。这些客户端大量使用证书固定，换证书会整片失败，因此宁可看不到也不解密。此外 `:142` 单独把 `p22-ckdatabase.icloud.com` 标为 `isICloudDB`，`:151-155` 识别本地 Web UI 地址，二者都在 `:171-178` 里被列为一票否决项。

最终的 `isIntercept()`（`:202-213`）把这些信号收成三段：先看本地 UI 与常规拦截条件，再看 IP 直连是否配有自定义证书（`:207-209`），最后才在 `:210-212` 处理 Proxifier 场景——条件是 `(config.proxifier2 || (config.proxifier && isWebPort)) && !disable.proxifier`：即 `config.proxifier2` 为真，或 `config.proxifier` 为真且目标落在 Web 端口（`isWebPort`，见 `:188-189`）时，只要 `disable.proxifier` 未设置就放行解密。层层收窄的结构说明解密是例外而非常态：默认路径始终指向纯透传，每多开一个条件都要有明确理由。

策略头 `x-whistle-policy` 由 `config.WHISTLE_POLICY_HEADER`（`lib/config.js:67`）定义，`tunnel.js:144-148` 读取。

::: cols 22|38|40
| 值 | 语义 | 对判定的影响 |
|---|---|---|
| tunnel | 纯透传 | 关闭解密 |
| connect | 纯透传 | 关闭解密 |
| weakTunnel | 弱透传 | 默认透传可回退 |
| intercept | 强制解密 | 命中自定义拦截 |
| capture | 强制解密 | 命中自定义拦截 |
| 未设置 | 交由规则 | 看全局开关 |
:::

`tunnel` 与 `connect` 会令 `useTunnelPolicy` 为真，从而经 `isDisableIntercept()` 强制走纯透传；`weakTunnel` 默认也透传，但 `:203-204` 留了后门——只要 `isCustomIntercept()` 仍为真且未命中禁用属性，依然可以解密；`intercept` / `capture` 则直接把 `isCustomIntercept()` 顶成真。这个「默认值透传、显式值可覆盖」的设计，让插件与内部请求能精确控制每一条隧道。

**为什么默认指向纯透传、每开一个条件都要理由**：解密既贵又有风险，还要求客户端先信任本地根 CA，因此它是例外而非常态。把「层层收窄」展开成推理：先看有没有被显式禁用，再看有没有显式拦截要求，然后叠加全局抓包开关与证书固定黑名单，最后才处理特殊场景；每一层都能否决解密，只有全部通过才进入解密分支。若不这么收口，「开启抓包」就会把系统域名、Cronet 客户端这类大量使用证书固定的流量一并拆开，换证书会整片失败、设备直接断网——宁可看不到，也不能破坏连通性。`filter.https` / `filter.capture` / `filter.intercept` 这些开关、以及策略头里的取值，都属于 [规则 DSL](/concepts/06-rules) 在连接期被读取的那部分配置。

**为什么 `weakTunnel` 叫「弱」**：它默认也透传，但只要自定义拦截仍成立且未命中禁用属性，就留了回到解密的后门。把这句展开：`tunnel` / `connect` 是一票否决、没有商量余地，`weakTunnel` 只是把默认值设成透传、并不锁死；「弱」弱在可被覆盖，而不是「完全不解密」。代价是判定时要多查一次拦截条件，边界是这个后门只在显式要求时生效，日常仍按透传走。

**输入 → 动作 → 输出**：输入是归一化后的 `tunnel://` 连接、策略头与全局开关，动作是五个局部函数依次收窄、把禁用属性 / 自定义拦截 / 全局抓包 / 系统黑名单 / 自定义证书合成一个结论，输出是「进入解密」或「落到纯透传」二选一。

**代价与边界**：保守的代价是你明明开了抓包、却仍有些条目看不到明文，容易误判成「没抓到」；边界是这套判定只回答「要不要拆」，拆不拆得开还要看下一节的首包识别与证书签发。逐条的策略头让插件与内部请求能精确控制每一条隧道，代价是排障时必须按「策略头 → 全局开关 → 黑名单」的顺序逐一核对，少查一层就会找错原因。

**打个比方**：像一道道闸门组成的审批链，默认走免检通道；只有每一道都盖了章才转去开箱，任一处盖了「免检」就原样放行——多数流量走免检，是为了不让整条队伍停摆。

**为什么用逐条的策略头，而不是只留一个全局开关**：全局抓包开关只能回答「要不要看」，策略头却能回答「这一条要不要看」。把这句展开：插件与内部请求各有各的目的，同一时刻有的要解密、有的必须原样透传；若只有全局开关，就只能把所有 CONNECT 一刀切，要么误拆系统流量、要么该看的看不到。用内部头携带取值，既不必污染业务 URL、又能在连接被拆开之前就被内核读到。代价是策略值多了一套需要记住的语义，边界是它只影响当前这一条隧道，不会改写全局默认。

**自己验证**：对照那张三列表格，把五个值按「强制透传」「默认透传但可覆盖」「强制解密」「交由规则」分成四类；再问自己 `weakTunnel` 属于哪一类，能答「可覆盖」，就抓住了「弱」字的含义。

## 先回 200，再识别首包

判定命中后进入 `lib/tunnel.js:248-283`。`:264-280` 调用 `dispatch(reqSocket, next, !req.enable.socket && isWebPort)` 尝试解密，第三个参数以 `isWebPort`（`:188-189`，端口 80 / 443 或命中自定义拦截）为基础，还要排除 `enable.socket`；紧接着 `:281` 立刻 `util.setEstablished(reqSocket)`，由 `lib/util/index.js:369-375` 的常量 `ESTABLISHED_CTN`（`:369-372`）写出最简 `HTTP/1.1 200 Connection Established`，`:373-375` 的 `setEstablished` 只做一次 `socket.write`。注意顺序：200 不等待解密结果，先让客户端认为隧道已建立，首包识别在后台继续。

```js
// lib/tunnel.js:264-282（节选）
dispatch(
  reqSocket,
  function (chunk) {
    buf = chunk;
    rollBackTunnel = true;
    ensureLoadRules();
  },
  !req.enable.socket && isWebPort
);
util.setEstablished(reqSocket);
```

`next(chunk)` 这个回调是回退闸门：若首包无法解密，就把原始 chunk 存进 `buf`、置 `rollBackTunnel = true`、调用 `ensureLoadRules()`，最终在 `:287-301` 落到 `handleTunnel()` 纯透传。这里的「先应答、后识别」是个重要取舍：客户端在收到 200 后立刻开始发 ClientHello，代理必须在同一条 socket 上把已经读走的首包再喂回去，否则握手就缺了第一段。`:275` 把 chunk 存进 `buf`，正是为了在回退时由 `sendEstablished` 之后的管道原样重放。

`lib/https/index.js:1184` 的 `util.readOneChunk` 负责读第一个数据包，之后按三类分流：

- 明文 HTTP 命中 `HTTP_RE`（`:1117`），`:1215-1226` 在 `forHttps` 未启用、也没有禁用 `captureHttp` 时 `socket.resume()`，用 `server.emit('connection', socket)` 与 `socket.emit('data', addClientInfo(...))` 把首包灌回主 server，等于让明文请求重新走一遍 Express 链；反之（启用 `forHttps` 或禁用 `captureHttp`）则 `next(chunk)` 回退。
- 只有 h2c preface（命中 `HTTP2_RE`，`:1118`）或 TLS 握手记录（首字节 `0x16`，即十进制 22）才继续解密；`:1232` 用的是反向回退写法 `if (!isHttpH2 && chunk[0] != 22) return next(chunk)`——首字节不是 22 且不是 h2c preface 就一律回退，源码里并没有 `chunk[0] === 22` 的正面分支。
- 其余情况交给 `next(chunk)` 回退；`:1228-1229` 的 `isEnable('forHttp')` 与 `disable.captureHttps` 也会主动回退到纯透传。

```js
// lib/https/index.js:1231-1234
var isHttpH2 = HTTP2_RE.test(headersStr);
if (!isHttpH2 && chunk[0] != 22) {
  return next(chunk);
}
```

![两段独立 TLS 与中间明文桥](/diagrams/tls-mitm.svg)
*图注：入站用本地 CA 现签的叶证书握手，出站以普通客户端身份握手，中间是可被规则处理的明文。*

**为什么「先应答、后识别」**：CONNECT 的语义是「隧道已打通」，客户端只有拿到 200 才会开始发握手首包。把这句展开：若等解密结果出来再应答，客户端会一直阻塞在等 200 上；而先应答后识别，代理必须在同一条 socket 上把已经读走的首包原样喂回去，否则握手就缺了第一段。于是代码把首包存进 `buf`、把「是否回退」记在上下文里，正是为了让两条分支对客户端完全等价。代价是先发的 200 与「解密是否成功」无关，最容易被误读成业务成功码；边界是这个 200 只是最简状态行，不带任何业务头。

**为什么首包识别用「反向回退」写法**：分流那段是「首字节不是 22 且不是 h2c preface 就一律回退」，源码里并没有「首字节是 22 才继续」的正面分支。把结论展开：一条 CONNECT 里可能跑 TLS、明文 HTTP 或 h2c，回退是常态兜底，继续解密才是需要严格证明的少数分支；用反向写法，任何没被认出来的流量都自动落回纯透传，不会因为漏写一个分支而被误解密。代价是判定依赖「首字节」这种约定而非强校验；边界是它只识别「像不像握手」，真正能不能签出证书还要看域名能否取到、本地根 CA 是否就绪。

**为什么明文 HTTP 命中后要灌回主 server**：明文首包不走证书分支，而是用 `server.emit('connection')` 把它重新送回 HTTP 解析器，等于让这段请求再走一遍 Express 链。把这句展开：既然内容本来就是明文，就不必伪造证书、更不必另写一套转发；复用同一条主干，规则与改写逻辑完全一致。代价是这段字节要被「读走再灌回」一次，边界是它只在未强制走 HTTPS、且未禁用明文采集时才这么处理。

**输入 → 动作 → 输出**：输入是 CONNECT 应答之后读到的第一个数据包，动作是先回最简 200、再按明文 HTTP / h2c preface / TLS 首字节三类分流，输出是「继续解密」「灌回主 server 重走 Express」或「回退到纯透传」三种去向之一，且回退时首包被原样重放。

**代价与边界**：首包必须被缓冲一小段才能判定，且 `setEstablished` 与纯透传分支的 `sendEstablished` 是两种不同实现——前者只写最简 200，后者还要叠加响应规则；把两者当成同一个函数，会误以为透传分支也能套用响应改写。边界是判定命中只代表「值得试一试」，回退随时可能发生，解密失败并不等于断线。

**自己验证**：对照那段 `if (!isHttpH2 && chunk[0] != 22) return next(chunk)` 的代码，问自己「首字节是 22 时回退还是继续」；再对照回退那段把 `chunk` 存进 `buf` 的写法，确认「回退 = 原样重放」而不是丢弃连接。

## SNI、证书签发与内部 TLS server

确认是 TLS 后，`lib/https/index.js:1295` 用 `checkSNI(chunk)`（`:9` 引入 `sni` 包）从 ClientHello 取出域名，`:1319` 经 `getDomain(servername)` 归一，`:1327` 调 `loadCert` 判断是否已有可用证书，再由 `:1277-1291` 的 `handleRequest` 三选一：有 SNI 走 `getSNIServer`，h2c 走 `getHttp2Server`，其余走 `useNoSNIServer`（`:1269-1275`）。三者都在本机创建内部 TLS server，把解密后的明文交给 `handlers`。

```js
// lib/https/ca.js:616-624
var SNICallback = function (servername, cb) {
  var options = getOrCreateCert(servername);
  if (!options._ctx) {
    try {
      options._ctx = createSecureContext(options);
    } catch (e) {}
  }
  cb(null, options._ctx);
};
```

`lib/https/ca.js:616-624` 的 `SNICallback` 由 `getSNIServer`（`:702-713`）注入 TLS server：每次握手按 servername 调 `getOrCreateCert`（`:582-607`），用 `node-forge`（`package.json:54`、`ca.js:1`）现签叶证书并 `createSecureContext` 后回调。根 CA 在 `ca.js:580` 启动时就绪，私钥与证书存于 `ca.js:19-33` 的 `certs` 目录。

入站连接随后由 `lib/https/index.js:1251-1267` 的 `util.connect` 拨向内部 TLS server 端口，并用 `tunnelTmplData`（`:33`，LRU，max 3000）按 `localPort:remotePort` 保存隧道元数据，供后续请求还原客户端信息。

```js
// lib/https/index.js:1262-1265
var key = reqSocket.localPort + ':' + reqSocket.remotePort;
socket._w2TunnelKey = key;
tunnelTmplData.set(key, getTunnelData(socket, clientIp, clientPort, isHttpH2));
handlePipe();
```

明文请求最终在 `:1102-1111` 的 `handlers.request` 里回流：`addReqInfo(req)`（`:943-964`）从 `tunnelTmplData` 取回元数据，写入 `config.HTTPS_FIELD`（即 `x-whistle-https-request`，`lib/util/common.js:182`）与 `CLIENT_INFO_HEADER`，再由 `util.setTunnelHeaders`（`lib/util/index.js:3760-3787`）补齐 clientId、代理认证与隧道头，最后 `server.emit('request', req, res)` 打回主 server——至此与上一篇第 1 步完全合流。同一份 `handlers` 还带 `upgrade` 分支，把解密后的 WebSocket 交给主 server 的 `upgrade` 事件。H2 流量则由 `toHttp1`（`:1013-1100`）转成 HTTP/1.1，以 `options.port = config.port`（`:1049`）重新请求本机主端口，`h2Handlers.request = toHttp1`（`:1112-1115`）完成这层绑定。

```js
// lib/https/index.js:1102-1111
var handlers = {
  request: function (req, res) {
    addReqInfo(req);
    server.emit('request', req, res);
  },
  upgrade: function (req, socket) {
    addReqInfo(req);
    server.emit('upgrade', req, socket);
  }
};
```

两侧 TLS 是**互相独立的信任边界**，必须分开理解：入站伪造证书由本地 CA 现签，客户端是否信任完全取决于本机是否装了该根 CA，与源站证书无关；出站则是代理以普通客户端身份用 `(useHttps ? https : http).request` 或 `tls.connect` 连源站，校验的是源站证书，走 Node 原生校验。`lib/config.js:65` 默认 `config.rejectUnauthorized = false`，让自签名或[证书链](/concepts/03-tls)不全的源站也能连通，只有 `--mode safe`（`config.js:809-810`，等价于 `rejectUnauthorized`）才打开严格校验。也就是说：装了根 CA 只解决「客户端信任代理」，并不代表「代理信任源站」；关掉出站校验图的是兼容各种源站，代价是代理无法发现源站证书被替换。便利与安全的取舍被刻意留在出站这条边界上。

**为什么 [SNI](/concepts/03-tls) 只能从首包里取**：确认是 TLS 后，代理从 ClientHello 里取出客户端声明的目标域名，再据此归一、查缓存、选内部 TLS server。把这句展开：同一 IP 上可能托管多个站点，代理要签出「对得上号」的叶证书，就先得知道客户端要访问哪个名字；而握手里只有这个域名信息是明文带出的，其余内容都已加密，所以这一步紧跟在嗅探之后、没法提前。代价是客户端可以省略它、也可以与最终证书域名归并后不同，边界是取不到时只能走「无 SNI」的那条分支。

**为什么叶证书要「现签」而不是预生成**：`SNICallback` 每次握手按域名查缓存、未命中才现签并构造安全上下文。把结论展开：要代理的域名集合在运行前根本不可预知，预生成既猜不全、也白占空间；复用同一把根私钥、只换域名现签，再按域名缓存上下文，就把「每域名一次」的开销压到最低。代价是首次访问某域名会多一次签发，边界是它只解决入站握手，出站仍以普通客户端身份另行校验。

**为什么要用端口对把隧道元数据暂存**：明文回流到主 server 时是一个全新的 `req` 对象，原来的 CONNECT 上下文——客户端 IP、端口、是否 h2、策略开关——都不在了。把这句展开：以 `localPort:remotePort` 为键把元数据暂存在一份有容量上限的 LRU 里，回流时按图索骥还原，内部头才能补回「这原本是 HTTPS」与客户端信息；正因为握手紧随其后，这份缓存只需短期存在、不必长期保留。代价是键依赖端口对、且容量有限，边界是它只存连接元数据，不是 URL 匹配缓存。

**为什么明文要打回主 server，而不是直接转发**：入站用伪造证书握手、出站以普通客户端身份握手，中间这段可读写明文正是 [MITM](/concepts/03-tls) 换出来的全部价值，也是规则改写与抓包的前提。把结论展开：把它重新 `emit` 成 `request` 事件，HTTPS 与明文 HTTP 就能共用同一套 Express 链；前面所有复杂性——现签证书、内部 TLS server、还原内部头——只为还原出一对 `req` / `res`。代价是明文必须绕回主 server 重走一遍，并不存在「解密后直接转发」的捷径；边界是 H2 流量要多一层协议降级再回主端口。

**输入 → 动作 → 输出**：输入是 TLS 首包里的域名与暂存的隧道元数据，动作是现签叶证书、在本机建内部 TLS server 完成入站握手、补回内部头，输出是被还原成明文、并打回 Express 主链的 `req` / `res`。

**代价与边界**：每多一段握手就多一份延迟与失败面，遇到证书固定或双向认证这套模型直接失效、只能退回纯透传；边界是两段各管各的信任——入站客户端信不信任伪造叶证书，只取决于本地根 CA 装没装进信任库，出站代理默认不校验源站证书、只有 `--mode safe` 才打开校验。装根 CA 并不代表代理信任源站，便利与安全的取舍被刻意留在出站这条边界上。

**打个比方**：像一位同声传译坐在两间隔开的电话亭之间，对左边用自己的口音说、对右边用对方的口音说，两边都以为在直接通话；他之所以能听懂，是因为两通电话都是他分别拨出去的，而中间那句原话就是可被处理的明文。

**自己验证**：对照 `SNICallback` 那段代码，数一数「按域名查缓存 → 未命中现签 → 构造安全上下文 → 回调」几步；再对照 `handlers` 那段，确认明文是 `emit` 回主 server、而不是就地转发，就能说清「中间那段明文桥」到底架在哪里。

## 不解密分支：纯透传的完整路径

未命中解密，或首包回退，都落到 `lib/tunnel.js:304-573` 的 `handleTunnel()`。它记录隧道计数、构造 `reqEmitter` 与 `data` 抓包对象，再经 `getProxy` 解析上游。若配置了上游 SOCKS 或 HTTP 代理，`:501-545` 会按 `isSocks` 分别设置 `proxyPort` / `localDNS` / `auths` 或 `proxyPort` / `proxyAuth`，最后由 `:545` 的 `netMgr.connect(dstOptions, handleProxy)` 发出；`lib/service` 之外的数据通道由此建立。

没有上游代理时走 `tunnel()`（`:577-596`），核心只有一句 `net.connect`：

```js
// lib/tunnel.js:596
resSocket = net.connect(resData.port, ip, handleConnect);
```

连接就绪后，`reqSocket.inspectFrames = inspect`、`reqSocket.fullUrl = tunnelUrl`（`:650-651`）把隧道上下文挂到 socket 上，`sendEstablished`（`:729-826`）再写回 `HTTP/1.1 200 Connection Established`（`:777,784`）。它与解密分支先发的 `setEstablished` 是两种不同实现：前者还要叠加 `resHeaders`、`replaceStatus`、`responseFor` 等响应规则，后者只是最简 200。`:748-750` 的 `enableTunnelAck` 则配合 `:149-150` 的策略头，让客户端在透传前先确认一个字节，避免首包被过早消费。

`:758-762` 同样检查 `rollBackTunnel`，为真时 `reqSocket.resume()` 并直接回调，把首包原样接回纯透传管道。也正因两条分支最终都落到 `handleTunnel`，`enable://inspect` 之类的抓帧能力对「解密的隧道」与「不解密的隧道」才有一致的入口：区别只在于前者已经把 TLS 换成了明文，后者仍需按字节流处理。这把问题自然交给了下一篇的 `socket-mgr`。

**为什么两条分支最终都落到 `handleTunnel`**：未命中解密与首包回退，都收敛到同一段纯透传处理。把结论展开：把「是否解密」与「怎么搬字节」拆成两步，透传路径就不必关心前面判了几次、回退过没有，只管按目标地址建连并双向转发；`enable://inspect` 之类的抓帧能力也因此对「解密的隧道」与「不解密的隧道」有了一致入口。代价是排障时要先分清这条连接是「从没打算解密」还是「解密失败才回退」，边界是前者仍需按裸字节流处理、后者已经换成明文。

**为什么 `sendEstablished` 比 `setEstablished` 多做一层**：解密分支先发的 200 只是最简状态行，纯透传分支写回的 200 还要叠加 `resHeaders`、`replaceStatus`、`responseFor` 等响应规则。把这句展开：透传分支是客户端真正收到「隧道已就绪」的那一处，响应改写规则自然要在这里落地；而解密分支的 200 只是催促客户端尽快发首包的开关，后面还有的是机会改写，两者职责不同、不能合并成一个函数。代价是名称相近的两个实现最容易记混，边界是响应规则只对透传分支那次应答生效。

**为什么 `enableTunnelAck` 要先确认一个字节**：它让客户端在透传前先回一个字节，避免首包被过早消费。把这句展开：嗅探已经从 socket 上读走了一段数据，若不等这个确认就把后续字节接上，首包与握手数据可能错位；先对一次暗号，管道两端才对齐。代价是多一次往返，边界是它只在开启该选项的透传路径上出现。

**为什么 `reqSocket.resume()` 能让回退无缝**：回退时把首包原样接回纯透传管道，靠的是让这条 [Stream](/concepts/04-runtime) 从暂停态恢复流动。把这句展开：首包被读走后连接处于暂停，若不恢复、又不把存下的 `buf` 接回去，客户端会一直等不到该有的字节；`resume()` 加上原样重放，才保证「没解密成功」与「一开始就没打算解密」对客户端完全等价。代价是回退路径要同时管好「已读数据」与「是否回退」两份状态，边界是它降级为透传、并不会断开连接。

**输入 → 动作 → 输出**：输入是未解密或回退的 CONNECT 连接与目标地址，动作是记录隧道计数、构造抓包对象、解析上游、用 `net.connect` 连目标、写回 200 并双向对接，输出是一条只搬字节、看不到内容的 TCP 管道，以及一份仍可被 `enable://inspect` 观测的帧上下文。

**代价与边界**：纯透传的代价是代理看不到任何应用内容，规则改写与明文抓包一概不适用；边界是它并非「低级模式」，而是遇到证书固定、双向认证或显式要求透传时的正确档位。两条分支共享 `handleTunnel` 只是收口，并不抹平两者在可观测内容上的差别：一条已被换成明文、一条仍是裸字节，后续如何按编号归并正是下一篇要接手的事。

**打个比方**：`handleTunnel` 像货运站里那条「不拆箱、直接换车」的通道：解密分支会把箱子打开、按单据改好再封上，透传分支则连封条都不碰，只把箱子从进站的车搬到出站的车；两条通道共用同一个站台，所以站台上的监控对两者一视同仁，只是它数得出过了多少箱，却读不懂箱里装了什么。

**自己验证**：对照 `net.connect` 那句代码，数一数纯透传分支一共做了几件事（计数、抓包对象、上游、连目标、写 200）；再对照检查 `rollBackTunnel` 的那段，确认回退时是 `resume()` 加原样重放、而不是销毁连接，就能说清「回退不是失败断线」。

## 常见误解

1. **容易以为开启抓包就会拆开所有 CONNECT，其实 `isIntercept()` 层层收窄、默认指向纯透传**：`CRONET_RE` 会拦下 Cronet UA、`SYS_HOST_RE` 则放行一批系统域名，这些客户端大量使用证书固定，换证书会整片失败，宁可看不到也不能破坏连通性，对照见[《易混淆概念辨析》](/concepts/08-confusions)。
2. **容易以为 `chunk[0] != 22` 是「首字节是 22 才回退」，其实方向正好相反**：首字节不是 22 且不是 h2c preface 才回退，等于 22 与 h2c preface 的才继续往下走域名与证书分支；把方向读反，整条解密链都会跟着反。
3. **容易以为首包回退就是解密失败后丢弃连接，其实它降级为不解密的纯透传**：已读走的 chunk 被存进 `buf`、置 `rollBackTunnel` 后原样重放，客户端感受到的仍是同一条打通的隧道。
4. **容易以为 `setEstablished` 与 `sendEstablished` 是同一个函数，其实二者分属两条分支**：前者是解密尝试后立刻发出的最简 200、与解密成功无关，后者在纯透传分支还要叠加 `resHeaders` / `replaceStatus` 等响应规则；混为一谈会误以为透传分支也能套用同一套改写。

## 小结

- `connect` 事件由 `tunnel.js:38-44` 注册，URL 被归一为 `tunnel://host:port`，缺省端口补 443。
- `isIntercept()` 综合禁用属性、自定义拦截、全局抓包开关、系统黑名单与自定义证书；`x-whistle-policy` 的五个值决定是否强制透传或强制解密。
- 命中解密时先 `setEstablished` 回 200，`readOneChunk` 按明文 HTTP / H2 preface / 首字节 22 分流，失败即 `rollBackTunnel` 回退。
- SNI 驱动 `node-forge` 现签叶证书，内部 TLS server 把明文经 `server.emit('request')` 打回 Express；H2 由 `toHttp1` 转回主端口。
- 入站伪造证书、出站原生校验且默认 `rejectUnauthorized = false`；不解密分支由 `net.connect` 与 `sendEstablished` 完成纯透传。
- 本篇为 [《隧道、WebSocket 与帧拦截》](/core/tunnel-websocket) 准备了「解密与否都会汇入双向流」这个共同终点：正因为 `handleTunnel` 是两条分支的收口、`enable://inspect` 给了解密与不解密隧道一致的抓帧入口，11 才能接着问「这些连接上下文与帧由谁统一管理」。

## 下一步

[《隧道、WebSocket 与帧拦截》](/core/tunnel-websocket)：解密与否都会汇入双向流，下一篇看 `socket-mgr` 如何统一管理连接上下文与帧。 紧接着读它，是因为本篇把两条分支都收敛到 `handleTunnel`，却留下一个未解问题：无论隧道里是明文还是裸字节，连接上下文与帧该挂在哪、如何按编号归并；11 正好接手 `socket-mgr`，把这条「只剩字节在流动」的管道管起来。
