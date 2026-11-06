---
title: 综合贯通：一次 HTTPS 请求里的全部概念
description: 把前八篇的名词按时间顺序串成一条 28 步链路，看清概念之间如何彼此咬合。
---

# 综合贯通：一次 HTTPS 请求里的全部概念

前八篇把代理、HTTP、TLS、运行时、抓包、规则、扩展里的名词逐个拆开讲过，但孤立地记住定义，仍不足以回答一个真实问题：当浏览器敲下回车，一次 HTTPS 请求到底按什么次序把这些概念一个个唤醒。本篇把整站的概念按时间顺序压进一条 28 步链路，分六个阶段串讲，每一步都回答四件事——这里出现哪些概念、源码具体做了什么、为什么必须落在这个位置、以及理解偏了会误判什么。读完之后你会看到，名词不是词典里静止的条目，而是一条链上彼此咬合的齿轮：任何一步错位，后面的判断都会跟着歪。建议把仓库并排打开，遇到 `lib/xxx.js:行号` 就跳过去看一眼再回来，这条链才真正立得住。

## 阶段一：隧道到达与判定

HTTPS 代理请求不会以 `GET /path` 开头，而是先来一条 `CONNECT host:443`。代理在这个阶段既看不到路径，也看不到正文，只能拿着「主机加端口」做判断：这是不是一条需要拆开的隧道、该给它编什么号、有没有外部策略要求强制透传。前五步就是把这个「只有地址的字节管道」登记成内核认识的对象，并决定要不要动它的加密层。

### 第 1 步 · connect 事件

**出现概念**：CONNECT 方法、隧道代理、正向代理、`server.on('connect')`、明文桥。

**源码**：`lib/tunnel.js:44` 在主 server 上注册 `connect` 事件，回调签名是 `function (req, reqSocket)`，紧邻的注释只有一句 `//ws, wss, https proxy`，点明这一个入口同时承载 HTTPS 代理与两类 WebSocket 流量。`req` 是解析后的 CONNECT 请求，`reqSocket` 是已经握到代理的裸 TCP 套接字。

**为什么**：Node 的 `http.Server` 把普通请求交给 `request` 事件，把 CONNECT 单独交给 `connect` 事件，因为后者没有请求体、也不该被当成 HTTP 报文解析。Whistle 必须在这里抢占第一现场，才能在客户端开始发 ClientHello 之前决定是解密还是透传。

**误解提示**：把 `connect` 当成「连接已建立」的通用通知会误判整个阶段；它其实是「客户端请求建立隧道」的方法名入口。独立 HTTPS / HTTP 端口由 `lib/index.js:111` 以 type 1 / 2 复用同一个处理器，主 server 不带 type，三者不要混为一条监听。

### 第 2 步 · `tunnel://` 伪 URL

**出现概念**：`tunnel://` 伪协议、URL 归一、`fullUrl`、`parseUrl`、缺省端口 443。

**源码**：`lib/tunnel.js:65` 对缺省端口补 `port || 443`，IPv6 地址额外包上方括号；`lib/tunnel.js:75` 统一写成 `tunnelUrl = req.fullUrl = 'tunnel://' + options.host`，随后 `:76` 立刻 `proxy.emit('_request', tunnelUrl)` 让抓包侧先登记这条连接。

**为什么**：CONNECT 阶段代理只知道目标主机与端口，并不知道路径、方法乃至里面是否真的跑 HTTP。用一个独立协议前缀把「未知内容的字节管道」与「已知 URL 的请求」区分开，规则引擎才不会对一条隧道去做路径匹配；`fullUrl` 又是后续规则匹配、抓包展示与帧归属共用的标识字段，必须在这里一次性定形。

**误解提示**：`tunnel://` 不是真实协议，也不能被 `http.request` 直接发出；把它当成 `https://` 的别名，会误以为此刻已经知道 URL 路径。它只是内核内部给隧道流量贴的分类标签。

### 第 3 步 · `reqId`

**出现概念**：`reqId`、会话唯一编号、`getReqId`、上下文挂载。

**源码**：`lib/tunnel.js:89` 执行 `req.reqId = reqSocket.reqId = util.getReqId(now)`，把同一个值同时挂到请求与套接字上；生成函数在 `lib/util/index.js:2649`。后续 `:83-86` 还把客户端 IP、端口、远端地址一并解析进 `req`。

**为什么**：一次 HTTPS 会话会横跨 CONNECT、TLS 握手、明文回流、出站与抓包多个阶段，甚至分属不同的 `req` 对象。必须有一个早于一切改写与采集的编号，才能让抓包 `data` 对象、`socket-mgr` 的帧上下文、前端的会话 id 指向同一条请求。放在这里，是因为再晚就赶不上隧道侧的登记。

**误解提示**：`reqId` 不是 TCP 连接 id，也不是 TLS 会话 id；一条 CONNECT 里可能承载多个 HTTP/2 流，但都归到这一个 `reqId`。把它当作「一次连接」来去重，会误删同连接上的多路请求。

### 第 4 步 · 策略头 `x-whistle-policy`

**出现概念**：内部头、`WHISTLE_POLICY_HEADER`、策略值 `tunnel` / `connect` / `weakTunnel` / `intercept` / `capture`。

**源码**：常量定义在 `lib/config.js:67`，值 `'x-whistle-policy'`；读取在 `lib/tunnel.js:144`，`:145-148` 把 `tunnel` / `connect` 折成 `useTunnelPolicy`，把 `weakTunnel` 单独标记。

**为什么**：插件、Composer 与内部转发需要逐条精确控制某条隧道是否解密，不能只靠全局开关。用内部头而不是查询参数，是因为它不污染业务 URL，且能在 CONNECT 阶段就被内核读到；带 `uid` 的同类头还能避免多实例串台。

**误解提示**：把 `weakTunnel` 等同于 `tunnel` 会读错回退逻辑——前者默认透传，但 `lib/tunnel.js:203-204` 留了后门，只要自定义拦截条件仍成立且未命中禁用属性，依然可以解密。它叫「弱」，弱在可被覆盖，而非「完全不解密」。

### 第 5 步 · `isIntercept()` 五信号

**出现概念**：解密判定、禁用属性、自定义拦截、全局抓包开关、系统黑名单、自定义证书、Proxifier。

**源码**：`lib/tunnel.js:168-213` 的 `rules.resolveRulesFile` 回调里，由 `isDisabledProps()`（`:168-170`）、`isDisableIntercept()`（`:171-178`）、`isCustomIntercept()`（`:179-187`）、`isEnableIntercept()`（`:191-201`）与总闸 `isIntercept()`（`:202-213`）组成。黑名单正则是 `lib/tunnel.js:26-27` 的 `CRONET_RE` 与 `SYS_HOST_RE`，在 `:199-200` 拦下 Cronet UA、放行 Apple、iCloud、Microsoft、Office365 等系统域名。

**为什么**：解密是昂贵且有风险的例外，默认必须指向纯透传。五路信号层层收窄：先看是否被显式禁用，再看是否有显式拦截要求，然后叠加全局开关与证书固定黑名单，最后才在 `:210-212` 处理 Proxifier 场景。每一层都要有明确理由，才能解释「装了根证书也不一定解密」。

**误解提示**：把「开启抓包」当成「所有 CONNECT 都拆」是最大误判。系统域名与 Cronet 客户端大量使用证书固定，换证书会整片失败，因此这里宁可看不到也不解密；`SYS_HOST_RE` 是放行名单而非拦截名单，方向读反会把结论彻底弄反。

## 阶段二：先应答、首包识别与回退

判定命中解密后，代理面对一个时序难题：客户端只在收到 `200 Connection Established` 之后才会发 ClientHello，而代理又必须读到第一个数据包才能确认里面到底是 TLS、明文 HTTP 还是 h2c。这一阶段的四步围绕「先应答、再嗅探、失败能原样退回」展开，是整条链最容易因顺序读反而出错的地方。

### 第 6 步 · `setEstablished` 先回 200

**出现概念**：`HTTP/1.1 200 Connection Established`、先应答后识别、`setEstablished`。

**源码**：`lib/tunnel.js:281` 在发起解密尝试之后立刻调用 `util.setEstablished(reqSocket)`，实现在 `lib/util/index.js:369-375`（`:369-372` 是常量 `ESTABLISHED_CTN`，`:373-375` 是 `setEstablished` 函数）；它写出的是最简 200，不带任何业务头。注意它与 `:729-826` 的 `sendEstablished` 是两种实现：后者用于纯透传分支，还要叠加 `resHeaders`、`replaceStatus` 等响应规则。

**为什么**：CONNECT 的语义是「隧道已打通」，客户端只有拿到 200 才会继续 TLS 握手。若等解密结果再应答，客户端会一直阻塞；而先应答后识别，代理必须在同一条 socket 上把已读走的首包再喂回去，否则握手就缺了第一段。

**误解提示**：200 不代表「解密成功」，它只代表「隧道建立」。把两处 `sendEstablished` / `setEstablished` 当成同一个函数，会误以为透传分支也能套用响应改写规则。

### 第 7 步 · 首包嗅探 `readOneChunk` 与反向写法

**出现概念**：首包嗅探、`HTTP_RE`、`HTTP2_RE`、ClientHello、ContentType 22、h2c preface。

**源码**：`lib/https/index.js:1184` 调 `util.readOneChunk` 读第一个数据包（实现在 `lib/util/index.js:3618`）；`lib/https/index.js:1117-1119` 定义 `HTTP_RE` 与 `HTTP2_RE`；`:1231-1232` 是分流关键：

```js
// lib/https/index.js:1231-1234
var isHttpH2 = HTTP2_RE.test(headersStr);
if (!isHttpH2 && chunk[0] != 22) {
  return next(chunk);
}
```

**为什么**：`CONNECT` 只承诺一条字节管道，里面可能跑 TLS、明文 HTTP 或 h2c。TLS 握手记录的首字节是 ContentType 22，h2c preface 以 `PRI * HTTP/2.0` 开头，明文 HTTP 则匹配 `HTTP_RE`。这里特意用反向写法——「不是 h2 且首字节不等于 22 就回退」——因为回退是常态兜底，继续解密才是需要严格证明的少数分支。

**误解提示**：把 `chunk[0] != 22` 读成「首字节是 22 才回退」会把整条链的方向弄反；源码是「不等于 22 就 `next(chunk)` 透传」，等于 22 与 h2 preface 才继续往下走 SNI 与证书分支。另外明文 HTTP 命中 `HTTP_RE` 后会在 `:1215-1226` 用 `server.emit('connection')` 灌回主 server，并不会进入证书签发。

### 第 8 步 · `rollBackTunnel` 回退

**出现概念**：回退闸门、`buf` 重放、`ensureLoadRules`、纯透传。

**源码**：`lib/tunnel.js:276-300` 是回退路径：`:275` 把首包存进 `buf`、`:276` 置 `rollBackTunnel = true`、`:277` 调 `ensureLoadRules()`，最终经 `:287-301` 落到 `handleTunnel()`；`:758-762` 再次检查该标志，为真时 `reqSocket.resume()` 并把首包原样接回透传管道。

**为什么**：嗅探已经从 socket 上读走了一段数据，回退时若不原样重放，后续握手或明文请求就少了第一个包。把「已读走的数据」与「是否回退」一起记在上下文里，是保证两条分支对客户端完全等价的关键。

**误解提示**：回退不是「解密失败后丢弃连接」，而是降级为不解密的纯透传。忽略这一点，会误以为首包识别失败就会断线，也会漏看 `enable://inspect` 对「解密隧道」与「不解密隧道」仍有一致的抓帧入口。

### 第 9 步 · SNI 提取

**出现概念**：SNI、ClientHello、`checkSNI`、servername、域名归一。

**源码**：`lib/https/index.js:1295` 执行 `useSNI = checkSNI(chunk)`，由 `:9` 引入的 `sni` 包从 ClientHello 里取出域名；`:1319` 经 `getDomain(servername)` 归一，`:1277-1291` 的 `handleRequest` 据此三选一：有 SNI 走 `getSNIServer`、h2c 走 `getHttp2Server`、其余走 `useNoSNIServer`。

**为什么**：同一 IP 上可能托管多个站点，代理必须知道客户端要访问哪个名字，才能签发对得上号的叶证书。SNI 是握手里唯一明文携带的域名信息，且只能在首包里取，因此紧跟在嗅探之后。

**误解提示**：SNI 不是证书里的 SAN，也不是 HTTP 的 `Host` 头；它是握手期客户端声明的目标名，可以被省略、也可以与最终证书域名经 `getDomain` 归并后不同。把三者混用，会误判「为什么给 `a.example.com` 签了 `*.example.com`」。

## 阶段三：证书签发与明文回流

确认是 TLS 且拿到域名后，代理要在本地凭空造出一段客户端愿意信任的加密连接，再把解密后的明文送回主 server。这五步把「证书体系」与「请求链路」焊接起来：前两步负责签与选，中间一步保存隧道元数据，后两步把明文以及客户端信息完整交还给 Express。

### 第 10 步 · 叶证书现签

**出现概念**：本地 CA、叶证书、`node-forge`、SAN、`KEY_SIZE`、有效期 36 天。

**源码**：`lib/https/ca.js:582-607` 的 `getOrCreateCert` 按 servername 查缓存，未命中则 `createSelfCert` 现签并写入 `cachePairs`。密钥长度由 `lib/https/ca.js:42` 的 `KEY_SIZE = 2048` 固定，有效期常量在 `lib/https/ca.js:48-49`（提前 7 天生效、36 天后过期）。

**为什么**：客户端信任的是已安装的根 CA，代理需要用这把根私钥为每个域名即时签一张叶证书，才能完成入站握手。现签而不是预生成，是因为域名集合不可预知；复用同一把根私钥、只换域名与 SAN，省去了为每个站点生成密钥对的开销。

**误解提示**：叶证书不是根证书，也不具备再签发能力（`cA: false`）。把 36 天当成根证书寿命会读错两套有效期：根证书走 `lib/https/ca.js:565-572` 的十年档，叶证书才用短档，这是为兼容浏览器对证书寿命的限制并给时钟偏差留缓冲。

### 第 11 步 · `SNICallback`

**出现概念**：`SNICallback`、`createSecureContext`、`_ctx` 缓存、内部 TLS server。

**源码**：`lib/https/ca.js:616-624` 定义回调，注入点在同文件 `:702-713` 的 `getSNIServer`：

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

**为什么**：TLS server 在每次握手时按 servername 索要安全上下文，回调正是把「现签证书」接到「正在进行的握手」上的钩子。`_ctx` 按域名缓存，避免每次握手都重建 `SecureContext`；两个内部 server 端口 42900 / 43900（`:610-611`）分别承载 HTTP/1 与 h2。

**误解提示**：`SNICallback` 不等于 `getOrCreateCert`；前者是握手回调，后者是签发函数，回调里还多做了一层 `SecureContext` 构造与缓存。把它当成「每次握手都重新签证书」，会高估证书体系的开销。

### 第 12 步 · 隧道元数据 LRU

**出现概念**：`tunnelTmplData`、LRU、`localPort:remotePort`、隧道元数据。

**源码**：`lib/https/index.js:33` 定义 `var tunnelTmplData = new LRU({ max: 3000, maxAge: 30000 })`；`:1264` 以 `reqSocket.localPort + ':' + reqSocket.remotePort` 为键写入 `getTunnelData(...)` 的结果。

**为什么**：明文回流到主 server 时是一个全新的 `req` 对象，原来的 CONNECT 上下文（客户端 IP、端口、SNI、是否 h2、策略开关）都不在了。用端口对做键把元数据暂存在 LRU 里，回流时才能按图索骥还原；设 30 秒过期是因握手紧随其后，不需要长期保留。

**误解提示**：这个 LRU 存的是隧道元数据，不是 URL 匹配缓存。规则引擎里的 `regUrlCache` / `hostCache` 是每次编译后清空的普通对象，两者用途完全不同；混为一谈会误判「规则改了没生效」的原因。

### 第 13 步 · 明文回流 `server.emit('request')`

**出现概念**：两段 TLS、明文桥、`handlers.request`、`addReqInfo`。

**源码**：`lib/https/index.js:1102-1109` 的 `handlers.request` 先 `addReqInfo(req)`，再 `server.emit('request', req, res)` 把明文请求打回主 server；同文件的 `handlers.upgrade` 处理解密后的 WebSocket。

```js
// lib/https/index.js:1102-1109
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

**为什么**：入站用伪造证书握手、出站以普通客户端身份握手，中间这段可读写明文才是规则改写与抓包的前提。把它重新注入 `request` 事件，HTTPS 与明文 HTTP 就能共用同一套 Express 链，前面所有复杂性只为还原出一对 `req` / `res`。

**误解提示**：不要以为存在一条「解密后直接转发」的捷径；明文必须绕回主 server 重走一遍中间件。H2 流量则由 `toHttp1`（`:1013-1100`）转成 HTTP/1.1 后以 `options.port = config.port`（`:1049`）重新请求本机主端口，路径与 HTTP/1 略有不同。

### 第 14 步 · 内部头 `HTTPS_FIELD` / `CLIENT_INFO_HEADER`

**出现概念**：`HTTPS_FIELD`、`CLIENT_INFO_HEADER`、`setTunnelHeaders`、`uid` 后缀。

**源码**：`lib/https/index.js:943-964` 的 `addReqInfo` 从 `tunnelTmplData` 取回元数据，在 `:954` 写 `config.CLIENT_INFO_HEADER`、`:962` 写 `config.HTTPS_FIELD`；常量定义在 `lib/config.js:69-70`。后者真实值 `x-whistle-https-request` 来自 `lib/util/common.js:182`。

**为什么**：回流后的请求必须带上「这原本是 HTTPS」与「客户端 IP / 端口是什么」两类信息，否则规则里的 `req.isHttps`、客户端 IP 过滤、抓包里的来源字段都会失真。`uid` 后缀让多实例并存时内部头不串台，是 `lib/config.js:63-108` 这批常量的共同约定。

**误解提示**：`HTTPS_FIELD` 是内部标记，不是 `Host` 或 `X-Forwarded-Proto`；它只在 `!req.isHttpH2` 时写入（`:961-964`）。把它当成对外标准头，会误判 h2 路径上为何看不到该字段。

## 阶段四：内核装配、分流与规则求值

明文一旦回到主 server，就进入所有 HTTP 流量共用的主干道。这五步把「一个裸请求」装配成「带规则上下文的 req」：先由 Express 与 `init` 中间件铺好可插拔的流，再由 `biz` 还原 URL 并挡住管理流量，最后把用户写的规则求值成 `req.rules`。

### 第 15 步 · Express app 与中间件链

**出现概念**：Express、`app.use`、`middlewares`、`bind(proxyEvents)`、`next()`。

**源码**：`lib/index.js:37-51` 构造 `var middlewares = ['./init', '../biz', require('./inspectors'), config.middlewares, require('./handlers')]`，`:50-51` 逐个 `app.use(...bind(proxyEvents))`；`lib/index.js:209` 在 `biz/init` 完成后才执行 `server.on('request', app)`。

**为什么**：把整条处理链表达成中间件数组，顺序即语义：`init` 包装流、`biz` 分流、四个 inspector 求值改写、handlers 出站。所有中间件 `this` 都绑定到同一个 `proxyEvents` 事件总线（`lib/index.js:39`），抓包、插件、规则才能借事件通信。端口虽已监听，应用却要等初始化完成才接请求，避免半成品状态被访问。

**误解提示**：`lib/init.js` 名字像启动初始化，实际是每请求中间件（`lib/init.js:157` 导出标准三参签名）。把它当成启动期代码，会找不到后续所有改写能力的挂载点。

### 第 16 步 · `PipeStream.wrapSrc` / `wrapDest`

**出现概念**：`PipeStream`、`wrapSrc` / `wrapDest`、可插拔双向流、Transform。

**源码**：`lib/init.js:157-162` 先 `PipeStream.wrapSrc(req)`、再 `wrapDest(res)`，随后 `addTransforms(req, res)` 与 `addErrorEvents(req, res)`；`addTextTransform` / `addZipTransform` 定义在 `lib/init.js:90-112`。

**为什么**：后续的请求改写、响应改写、gzip 解压重压缩、抓包采样，都要往同一条流上「插入」处理环节，而不是各自另开管道。包装之后任意模块都能以 `add` 方式挂 Transform，且不必关心底层是普通 HTTP、解密后的 HTTPS 还是 H2 转回的 HTTP/1。

**误解提示**：包装不是复制数据。`content-length` 会因解压改写重压缩而变化，所以 `lib/init.js:106-112` 直接删掉它、让 Node 改用分块传输；以为 body 原样透传，会解释不了为什么改写后长度对不上。

### 第 17 步 · `fullUrl` 还原与 UI 分流

**出现概念**：`getFullUrl`、`fullUrl`、`WEBUI_PATH`、约定式路由、`weinre` / `cgi`。

**源码**：`biz/index.js:31-40` 执行 `req.fullUrl = util.getFullUrl(req)`（实现在 `lib/util/index.js:713`）；`biz/index.js:133-163` 用一组正则识别 Web UI、插件界面、`weinre` 与 `log` / `cgi` 内部应用，命中就 `transformReq` 或 `handleUIReq`，未命中才 `next()`。`WEBUI_PATH` 常量见 `lib/config.js:72`。

**为什么**：代理请求里的 URL 常是 `GET /path HTTP/1.1` 加 `Host`，必须还原成完整 URL 才能做规则匹配与抓包展示。把界面流量挡在用户规则之前，是避免管理请求被用户写的 `host` / `path` 规则误伤——这是「先界面、后代理」的一贯顺序。

**误解提示**：`fullUrl` 是内核还原的结果，不等于浏览器地址栏原样字符串；它还会被规则里的 `ruleUrl` 覆盖（下一步）。忽略这点，会误判 `host` 规则为何能改变出站目标。

### 第 18 步 · 规则求值 `req.rules`

**出现概念**：`req.rules`、`resolveRulesFile`、`setupRules`、`reqId`、`req.options`、`ruleUrl`。

**源码**：`lib/inspectors/rules.js:12-45` 组装规则上下文，`:159` 再次确认 `req.reqId = util.getReqId()`；`:40-44` 从 `util.rule.getUrl(req.rules.rule)` 取出 `ruleUrl`，落到 `req.options = util.parseUrl(ruleUrl || req.fullUrl)`。规则文件解析、插件规则合并与弱规则过滤都在此收口。

**为什么**：这一步是「代理」二字的落点。`req.options` 后续被 `http.request` 直接当作目标地址，因此 `ruleUrl` 优先于 `fullUrl`，正是 `host` / `xhost` 等改地址规则生效的根源；`reqId` 早于一切改写与采集，抓包对象与帧上下文才能归并到同一次请求。

**误解提示**：`req.rules` 是「各协议首条命中」的集合，不是原始规则文本；编译期产物在这里才被求值成 `value`。把 `req.rules` 当成匹配前的 rule 对象，会误以为插件能提前读到尚不存在的字段。

### 第 19 步 · 五分支匹配循环

**出现概念**：`resolveRuleList`、正则 / 通配 / 精确 / 前缀 / 否定五分支、`checkFilter`、`includeFilter`。

**源码**：`lib/rules/rules.js:929-938` 先归一化出 `curUrl`、`domainUrl`、`pureUrl` 三种 URL；真正的循环在 `lib/rules/rules.js:997-1119`，按 rule 上的标志位走五条互斥分支，命中后 `--index < 0` 即构造结果返回。`checkFilter`（`:986-995`）在每次比较前短路过滤条件。

**为什么**：用户写的一行规则在编译期只被结构化成分桶的 rule 对象，请求期才按当前 URL 求首条命中。分成五分支是为了让正则捕获、`*` 通配边界、`$` 精确、`indexOf === 0` 前缀与 `!` 否定各有明确语义；不分优先级字段、不建索引，是因为规则集通常只有几十到几百行，线性扫描最省事。

**误解提示**：这是首条命中，不是全量收集（`multiMatchs` 列出的协议才例外）。把 `includeFilter://m:POST` 当成 URL 匹配条件会找错位置——它编译进 `filters` 数组，由 `checkFilter` 在匹配循环内判定，而非参与 URL 比较。

## 阶段五：改写、旁路采集与出站

规则已定，接下来把「要改什么」变成「真的改了什么」，同时在不拖慢转发的前提下留一份抓包副本，最后把请求真正发往源站。这六步是全链路最密集的一段：改写与采样共用同一份被包装过的流，出站又涉及证书校验与连接复用两组独立配置。

### 第 20 步 · 请求改写与 Transform

**出现概念**：`reqHeaders` / `reqBody` / `urlParams` / `urlReplace`、流式 Transform、注册而非替换。

**源码**：`lib/inspectors/req.js:456-612` 批量求值 `req*` / `url*` 系列规则，`:581` 的 `handleReplace` 产出 `ReplaceStringTransform` / `ReplacePatternTransform`；挂载能力来自 `lib/init.js:90-112` 的 `addTextTransform` / `addZipTransform`。

**为什么**：改写并非立刻替换 Buffer，而是注册 Transform，等请求体真正流过时执行。这样改写与转发并行、内存占用可控，且解压 → 文本改写 → 重压缩三段管道对所有流量形态一致。

**误解提示**：抓包看到的请求是「改写后的字节」，不是客户端原始报文——采样与改写共用同一条包装流。以为界面显示的是原始请求，会误判规则到底有没有生效。

### 第 21 步 · 抓包 `data` 对象与事件总线

**出现概念**：`data` 对象、`reqEmitter`、`proxy.emit('request')`、`id` / `url` / `ttfb` / `abort`。

**源码**：`lib/inspectors/data.js:156-185` 构造 `data`，字段含 `id: req.reqId`、`url: req.fullUrl`、`rules: req.rules`、`ttfb` 与 `abort()`，并在 `:185` 广播到 `lib/index.js:39` 的事件总线：

```js
// lib/inspectors/data.js:156-185（节选）
var data = {
  id: req.reqId,
  url: req.fullUrl,
  req: reqData,
  res: resData,
  rules: req.rules,
  startTime: now,
  ttfb: getTTFB(),
  abort: function (clear) {
    if (clear === true) {
      reqBody = resBody = false;
      cleared = true;
    } else {
      req.emit('error', new Error('Aborted'));
    }
  }
};
proxy.emit('request', reqEmitter, data);
```

**为什么**：抓包模块不自己收发请求，只订阅这份对象。刻意分成两级：`proxy` 上的 `request` 只播一次用于登记会话，每条请求专属的 `reqEmitter` 负责后续 `send` / `response` / `end` / `abort` 状态迁移，避免所有监听者都得按 `reqId` 自行过滤。

**误解提示**：`data` 是内核持续原地更新的同一个对象引用，不是快照；UI 读到的与内核写的是同一份。以为它每次序列化拷贝，会低估字段膨胀对常驻内存的影响。

### 第 22 步 · 旁路采样与 `reqDelay`

**出现概念**：旁路采样、覆盖 `write` / `end`、`joinBuffer`、`reqDelay`。

**源码**：`lib/inspectors/data.js:279-323` 保存原始 `stream.write` / `stream.end`，换成先累加长度、拼接 Buffer、再 `write.apply(this, arguments)` 的包装；`lib/inspectors/data.js:542-551` 的中间件本体调 `emitDataEvents` 后按 `req.rules.reqDelay` 延时 `next()`。

**为什么**：采集必须旁路于转发——每个数据块仍被立即交给下游，抓包只是顺手记一份，链路上没有额外等待点。`reqDelay` 只影响时序、不影响采样结果，因为它作用在「采集已订阅、改写已注册」之后。

**误解提示**：超阈时 `reqBody` 被置为 `false`，但 `size`、`headers`、时间字段等元信息照常保留；以为「大 body 会拖垮内存」或「大 body 整条记录消失」都不对，界面仍能看到「有一个 20MB 的响应」，只是 body 栏为空。

### 第 23 步 · 出站 `req.request`

**出现概念**：`req.request`、`res.response`、`http.request` / `https.request`、`useHttps`。

**源码**：`lib/inspectors/res.js:194` 定义 `req.request(options)`；`lib/inspectors/res.js:641-644` 发起原生请求并把 `res.response` 注册为响应回调；`lib/handlers/http-proxy.js:5-47` 判定协议后调用 `req.request(req.options)`，本地文件协议由 `lib/handlers/file-proxy.js:233-248` 短路。

**为什么**：出站是「代理」真正向源站发请求的动作，`options` 来自第 18 步的 `req.options`，因此改地址规则在这一刻落地。把发起请求与响应回写拆成 `req.request` / `res.response` 一对入口，才能让 `statusCode` / `redirect` 这类 `isSpec` 规则在建立连接之前就短路返回。

**误解提示**：`req.request` 只是定义与触发，请求体并未在调用时全部发出（见下一步）。把它当成一次性同步发送，会误判 `reqDelay`、超时与背压的作用时机。

### 第 24 步 · `rejectUnauthorized` / agent

**出现概念**：`rejectUnauthorized`、`httpAgent` / `httpsAgent`、`maxSockets`、`--mode safe`。

**源码**：`lib/config.js:65` 默认 `config.rejectUnauthorized = false`；`lib/config.js:1039-1048` 构造 `agentConfig`（`maxSockets: config.sockets`、`keepAlive: true`），并由 `:1046` 的 `disableAgent` 在默认路径把 agent 置为 `false`。严格校验只在 `--mode safe`（`lib/config.js:809-810`）打开。

**为什么**：入站是伪造证书、由本地 CA 现签；出站则以普通客户端身份走 Node 原生校验。默认不校验源站证书是为了兼容自签名环境，代价是中间人风险被转移到「代理到源站」这一段——便利与安全的取舍被刻意放在这条边界上。`sockets=256` 是 agent 的连接上限，不是监听端口数。

**误解提示**：把 `rejectUnauthorized` 当成入站解密开关，会误以为关掉就能看到明文；它只影响出站握手。把 `sockets` 当成可监听端口数量，或以为默认启用了连接缓存，都会读错 `lib/config.js:1045-1048` 的注释。

### 第 25 步 · `pipeClient` 与背压

**出现概念**：`pipeClient`、`secureConnect`、`req.pipe`、`drain`、背压。

**源码**：`lib/inspectors/res.js:648-669` 监听 socket 的 `connect` / `secureConnect`，连接就绪才调 `pipeClient`；实现在 `lib/inspectors/res.js:65-77`：`noReqBody` 时 `client.end()`，有请求体时 `req.pipe(client)`。

**为什么**：连接建立前不能盲目转发请求体，否则数据会写进尚未就绪的套接字。`pipe` 把 Node Stream 的背压机制一并接管——下游 `write()` 返回 `false` 时自动暂停上游、待 `drain` 恢复——因此大请求体不会把内存撑爆。

**误解提示**：背压不是 Whistle 自己实现的一套流控，而是 `Stream.pipe` 的既有语义；`pipeClient` 只是决定「什么时候开始 pipe」与「无 body 时直接 end」。以为这里有一套自定义缓冲队列，会去错地方找限速逻辑。

## 阶段六：回写与观测

源站响应回来后，链路还剩最后一公里：把响应按规则改写并写回客户端，同时让界面能看到这次会话。最后三步把「回写」与「观测」并在一起讲，是因为它们共用第 21 步那个原地更新的 `data` 对象——响应改写改变的是发给客户端的字节，观测改变的是同一对象上的字段。

### 第 26 步 · 响应改写 `res.response`

**出现概念**：`res.response`、`resHeaders` / `resBody` / `resReplace`、`htmlBody` / `jsBody` / `cssBody`、`res.src`、`writeHead`。

**源码**：`lib/inspectors/res.js:781-1311` 是覆盖版响应入口，`:819-823` 处理 `replaceStatus`，`:1173` 执行 `res.src(_res, null, firstChunk)`，`:1239` 执行 `res.writeHead(...)` 把状态行与头部写给客户端；驱动规则来自 `res*` 系列与按内容类型注入的三组规则。

**为什么**：响应改写与请求改写对称，但多了一层「源站响应已到达」的前提。先读首块、合并响应规则、再注册替换与注入流，最后才写头，是为了让状态码、响应头与正文在同一次改写里保持一致；`resDelay` / `resSpeed` 也卡在回写前后，只改时序不改内容。

**误解提示**：`res.src` 与 `writeHead` 的先后不能颠倒，否则头部先发出就再也无法被 `resHeaders` 修改。把 `res.response` 当成只负责「转发源站字节」，会漏掉它是整条响应改写链的入口。

### 第 27 步 · 原地更新 / 有界缓存 / base64

**出现概念**：原地更新、有界缓存、`clearCache`、`toBase64String`、`ids[]` / `reqData{}` / `framesCache`。

**源码**：`lib/util/data-server.js:319-333` 的 `handleRequest` 把 `data` 直接写进 `reqData[id] = data` 并就地补 `version` / `nodeVersion`；`lib/util/data-server.js:216-220` 在返回前 `data.base64 = data.body.toString('base64')`；`lib/util/data-server.js:147-203` 的 `clearCache` 按结束时间淘汰、溢出时 `abort(true)` 删条目。

**为什么**：内核持续更新的对象与 UI 读到的是同一引用，没有快照、没有逐次序列化拷贝，换来零复制与增量字段天然可见。代价是这个对象在整个会话期常驻内存，所以必须有 600 条水位、1800 条溢出、360 条保留、单次 100 条上报这一组硬边界；二进制正文则在返回前才转 base64，避免长期占着 Buffer。

**误解提示**：这套缓存是自实现的 `ids[]` + `reqData{}` + `framesCache`，源码里没有 LRU 结构（LRU 在证书与插件侧）。把它当 LRU，会误判淘汰策略；以为 `getItem` 返回的是拷贝，会低估一处修改对所有消费者立即可见的影响。

### 第 28 步 · 短轮询上报与命中查询

**出现概念**：短轮询、gzip JSON、`sendGzip`、`hasNew`、100 / 900ms、命中查询。

**源码**：`biz/webui/cgi-bin/get-data.js:28,60` 用 `util.sendGzip` 返回压缩 JSON 并调 `proxy.getData(...)`；`biz/webui/htdocs/src/js/data-center.js:1157-1159` 依据 `hasNew` 决定 `setTimeout(load, hasNewData ? 100 : 900)`；`biz/webui/cgi-bin/get-matched-rules.js:6` 用 `proxy.getTestItem(testId)` 回查某次请求命中了哪些规则。

```js
// biz/webui/htdocs/src/js/data-center.js:1157-1159
cgi.getData(options, function (data) {
  var hasNewData = data && data.data && data.data.hasNew;
  setTimeout(load, hasNewData ? 100 : 900);
});
```

**为什么**：抓包数据不需要服务端推送，用带 `hasNew` 自适应间隔的短轮询即可——有新数据 100ms 快跟、无数据 900ms 省请求，gzip 再压掉 JSON 体积。命中查询则把「这次请求到底走了哪些规则」做成独立 CGI，让复现与排障能回看第 18、19 步的结论。

**误解提示**：这不是 SSE 也不是 WebSocket 上报，而是标准 HTTP JSON 短轮询；SSE 只用于响应体按 `text/event-stream` 分帧展示（`lib/inspectors/data.js:98-135`）。把两者混为一谈，会误判长连接上事件流的呈现方式。

## 一条规则在链路里的落点

以 `www.example.com/api resBody://(...) includeFilter://m:POST` 为例，把它拆成编译期与请求期两段，就能看清同一条规则在不同时刻的两种形态。

::: cols 20|30|50
| 时段 | 落在哪步 | 具体动作 |
|---|---|---|
| 编译期 | 链路启动前 | parseText 拆行并分桶 |
| 编译期 | 链路启动前 | includeFilter 编进 filters |
| 请求期 | 第 18 步 | req.rules 求值组装 |
| 请求期 | 第 19 步 | 五分支命中并过 filter |
| 请求期 | 第 26 步 | resBody 注入响应流 |
:::

编译期其实不在这 28 步的时间线上：用户保存规则时，`lib/rules/rules.js:1745-1806` 的 `parseText` 把这一行拆成 pattern、operation、属性与过滤条件，`parseRule`（`:1229-1408`）按协议名分桶，其中 `includeFilter://m:POST` 经 `resolveMatchFilter`（`:1549-1739`）编译进 `filters` 数组。此时 rule 只有 `matcher`，还没有 `value`。

请求期才真正介入：第 18 步 `lib/inspectors/rules.js:12-45` 把各协议首条命中组装成 `req.rules`；第 19 步 `lib/rules/rules.js:997-1119` 的循环先用前缀分支匹配 `www.example.com/api`，再由 `checkFilter` 判定 `m:POST`——若实际请求是 GET，这一条直接短路，不进入结果；若命中，`resolveValue`（`:811-852`）才把 `resBody` 的括号内容求值成 `value`。最后第 26 步 `lib/inspectors/res.js:819-998` 读 `resRules.resBody`，在响应流上注册替换 Transform，把 `(...)` 的内容写回客户端。可见「一条规则」不是在某个点被执行一次，而是在编译期被结构化、在请求期被命中、求值、再消费，横跨三个不同阶段。

## 如果换一种流量

上面 28 步是「HTTPS over CONNECT 且命中解密」这一条最完整的路径。换成别的流量形态，链会从不同位置切入或提前分叉，理解差异比死记 28 步更重要。

### HTTP 明文

明文 HTTP 不产生 CONNECT，因此第 1 至 14 步整体跳过，请求直接由 `lib/index.js:209` 的 `server.on('request', app)` 进入 Express，从第 15 步起与 HTTPS 完全合流。唯一的例外是独立 HTTP 端口上的隧道流量：`lib/https/index.js:1186` 的 `HTTP_RE` 命中后，`:1215-1226` 会用 `server.emit('connection', socket)` 与 `socket.emit('data', ...)` 把首包灌回主 server，等于让明文请求再走一遍 Express。也就是说，明文路径短在「不需要伪造证书与还原客户端信息」，长在「仍要完整经历装配、规则、改写、采集、出站、回写」。

### WebSocket

WebSocket 走 `upgrade` 事件而非 `connect`：`lib/upgrade.js:179-181` 注册入口，`util.getFullUrl`（`lib/util/common.js:1284`）依 `req.isWs` / `req.isHttps` 拼出 `ws://` 或 `wss://`。拨号在 `lib/https/index.js:557` 按 `isWss` 选 `tls` 或 `net`，解密后由 `lib/https/index.js:1107-1109` 的 `handlers.upgrade` 回流。之后连接交给 `lib/socket-mgr.js:764-847` 的 `handleConnect`，帧由 `lib/socket-mgr.js:291-301` 的 `ws-parser` 收发器处理，不进入第 26 步的 `res.response` 改写链——这正是「帧改写用 `frameScript`、报文改写用 `resBody`」的分界。

### SOCKS

SOCKSv5 是独立监听端口，由 `lib/index.js:96-124,151` 在配置 `socksPort` 时创建，`lib/index.js:182` 的 `client.on('connect')` 处理握手。它既没有 HTTP CONNECT 报文，也不进 Express 中间件链，因此第 1 至 14 步、第 17 至 26 步大多不适用；内核在这里只承担「按目标地址建连并双向透传」的角色。把它套进 28 步模型，会误以为存在 `fullUrl` 规则匹配与响应改写。

### TCP 隧道

任意端口的 CONNECT 同样被记成 `tunnel://host:port`（`lib/tunnel.js:75`），但未命中解密时走 `lib/tunnel.js:304-573` 的 `handleTunnel()`，核心是 `:596` 的 `net.connect` 纯透传，并跳过第 9 至 14 步的 SNI、证书与明文回流。若用户显式开启 `enable://inspect`，`lib/socket-mgr.js:768` 会按 `reqId` 建帧上下文，让裸字节流也能被插件自定义解析器切帧；这也是「解密隧道」与「不解密隧道」唯一共享的观测入口。

### h2 与 h2c

h2c 明文 preface 由 `HTTP2_RE`（`lib/https/index.js:1118,1231`）识别，走 `getHttp2Server`（`:1287`）；ALPN 协商的协议集合见 `lib/https/h2.js:10` 的 `SUPPORTED_PROTOS`。解密后的 H2 由 `toHttp1`（`lib/https/index.js:1013-1100`）转成 HTTP/1.1，以 `options.port = config.port`（`:1049`）重新请求本机主端口，`h2Handlers.request = toHttp1`（`:1112-1115`）完成绑定。因此 h2 与 28 步的差别集中在第 7 至 14 步：明文 h2c 跨过 SNI 与证书分支，加密 h2 仍经 `SNICallback`，但回流时多一层协议降级。

## 概念速查：这一步用到哪些名词

下表把六个阶段压成六行，用来回查「某个名词该去哪篇精解」。链接指向概念精解对应篇：01 代理、02 HTTP、03 TLS、04 运行时、05 抓包、06 规则、07 扩展、08 易混淆、09 贯通。

::: cols 18|28|30|24
| 阶段 | 核心概念 | 源码 | 详解篇 |
|---|---|---|---|
| 一 隧道判定 | connect / tunnel / reqId | lib/tunnel.js:44-213 | [01](/concepts/01-proxy) |
| 二 首包嗅探 | 200 / chunk[0] / 回退 | lib/https/index.js:1184 | [03](/concepts/03-tls) |
| 三 证书回流 | SNI / 现签 / 内部头 | lib/https/ca.js:582 | [03](/concepts/03-tls) |
| 四 装配求值 | Express / PipeStream | lib/index.js:37-51 | [04](/concepts/04-runtime) |
| 五 改写出站 | Transform / 旁路采样 | req.js:456 / data.js:279 | [06](/concepts/06-rules) |
| 六 回写观测 | res.response / 短轮询 | res.js:781 / get-data | [05](/concepts/05-capture) |
:::

需要按字母或缩写回查全部术语时，直接翻 [《全量术语索引》](/concepts/glossary)；只想核对数值与内部头，则用 [《术语、路径与配置速查》](/advanced/reference)。

## 与工程实际结合

这条链不是纸面模型，三个既有场景正好各自踩在其中一段上。[《HTTPS 证书信任与排障》](/scenarios/https-trust) 对应阶段一到三：装根证书、处理证书固定、判断「为什么没解密」，本质都是在核对 `isIntercept()` 五信号与首包嗅探的结果。[《复现、保存与重放》](/scenarios/reproduce-replay) 对应阶段五到六：Composer 把构造好的请求回打自身代理端口，因此照常命中第 18、19 步的规则，也照常被第 21 步登记、被第 28 步上报；理解 `data` 对象原地更新，才能明白重放时改的是同一份上下文。[《一次 HTTP 代理请求的旅程》](/core/http-request) 则是阶段四到六的 16 步展开版，两篇对照读，能看清 HTTPS 只是比明文 HTTP 多了前 14 步的还原工作。

## 小结

- 28 步按「隧道判定 → 首包识别 → 证书回流 → 装配求值 → 改写出站 → 回写观测」六阶段推进，前一阶段的产物正是后一阶段的输入。
- 最容易读反的三处：`chunk[0] != 22` 是「非 TLS 即回退」的反向写法；200 先于解密而非解密成功；`rejectUnauthorized` 只管出站、不管入站。
- 一条规则横跨编译期与请求期：先被 `parseText` 结构化，再在第 18、19 步命中求值，最后在第 20 或 26 步被消费。
- 换流量形态时，差异集中在前 14 步的切入方式；从第 15 步起，HTTP、HTTPS 与 h2 基本共用同一条 Express 主干。
- 抓包 `data` 对象是贯穿阶段五、六的同一引用，零复制换来便利，也要求 600 常规水位 / 1800 溢出阈值 / 1200 溢出后回砍水位，以及尾部 360 条 6 分钟宽限这组分级清理来兜底。

## 下一步

[《全量术语索引》](/concepts/glossary)：把本篇串过的、以及尚未展开的全部名词收成八类速查表，按分类查、按缩写查、按阈值查，随时回看每一处的源码落点。
