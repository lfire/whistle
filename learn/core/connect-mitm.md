---
title: CONNECT 判定与 TLS 解密
description: 拆解 CONNECT 的解密判定、首包识别、SNI 证书签发与两段独立 TLS 的还原路径。
---

# CONNECT 判定与 TLS 解密

上一篇的 16 步链路处理的是「已经能读到明文」的请求；而 HTTPS 代理请求首先以 CONNECT 隧道的形式到达，代理看不到一个字节的正文。本篇回答两个问题：Whistle 凭什么决定拆开某条 CONNECT，以及拆开之后如何把 TLS 首包还原成上一篇那条 Express 链路。文中所有判定都落到 `lib/tunnel.js` 与 `lib/https/index.js` 的真实分支上，读完你能解释「为什么装了根证书也不一定解密」。

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

这个 `tunnel://host:port` 不是真实协议，而是内核给隧道流量用的伪 URL：后续的规则匹配、抓包展示、`socketMgr` 的帧归属都拿它当标识。同一段代码还分配 `reqId`（`:89`）、解析客户端 IP 与端口（`:81-86`）、把 `req.rules` 挂到 `reqSocket` 上，为后面的判定备好上下文。

之所以不直接沿用 `https://`，是因为 CONNECT 阶段代理只知道目标主机与端口，并不知道路径、方法乃至是否真的跑 HTTP；用独立协议前缀把「未知内容的字节管道」与「已知 URL 的请求」区分开，规则引擎才不会对一条隧道误判路径匹配。`:76` 紧接着 `proxy.emit('_request', tunnelUrl)`，正是让抓包侧在解密尚未开始前就先登记这条连接。

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

最终的 `isIntercept()`（`:202-213`）把这些信号收成三段：先看本地 UI 与常规拦截条件，再看 IP 直连是否配有自定义证书（`:207-209`），最后才在 `:210-212` 处理 Proxifier 场景——只有 `config.proxifier` 与 `disable.proxifier` 同时满足、且目标落在 Web 端口时才放行解密。层层收窄的结构说明解密是例外而非常态：默认路径始终指向纯透传，每多开一个条件都要有明确理由。

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

## 先回 200，再识别首包

判定命中后进入 `lib/tunnel.js:248-283`。`:264-280` 调用 `dispatch(reqSocket, next, isWebPort)` 尝试解密，第三个参数 `isWebPort` 由 `:188-189` 得出（端口 80 / 443 或命中自定义拦截）；紧接着 `:281` 立刻 `util.setEstablished(reqSocket)`，由 `lib/util/index.js:373-375` 写出 `HTTP/1.1 200 Connection Established`。注意顺序：200 不等待解密结果，先让客户端认为隧道已建立，首包识别在后台继续。

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

- 明文 HTTP 命中 `HTTP_RE`（`:1117`），`:1215-1226` 在 `forHttps` / `captureHttp` 未开启时 `socket.resume()`，用 `server.emit('connection', socket)` 与 `socket.emit('data', addClientInfo(...))` 把首包灌回主 server，等于让明文请求重新走一遍 Express 链。
- 命中 `HTTP2_RE`（`:1118`）的 h2c preface，或首字节 `chunk[0] === 22` 的 TLS 握手记录，才继续解密。
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

两侧 TLS 必须分开理解：入站是伪造证书、由本地 CA 现签，客户端信任的前提是已安装根 CA；出站则是 `(useHttps ? https : http).request` 或 `tls.connect` 走 Node 原生校验，`lib/config.js:65` 默认 `config.rejectUnauthorized = false`，以便处理自签名源站，只有 `--mode safe`（`config.js:809-810`）才打开严格校验。便利与安全的取舍被刻意留在这条边界上。

## 不解密分支：纯透传的完整路径

未命中解密，或首包回退，都落到 `lib/tunnel.js:304-573` 的 `handleTunnel()`。它记录隧道计数、构造 `reqEmitter` 与 `data` 抓包对象，再经 `getProxy` 解析上游。若配置了上游 SOCKS 或 HTTP 代理，`:501-545` 会按 `isSocks` 分别设置 `proxyPort` / `localDNS` / `auths` 或 `proxyPort` / `proxyAuth`，最后由 `:545` 的 `netMgr.connect(dstOptions, handleProxy)` 发出；`lib/service` 之外的数据通道由此建立。

没有上游代理时走 `tunnel()`（`:577-596`），核心只有一句 `net.connect`：

```js
// lib/tunnel.js:596
resSocket = net.connect(resData.port, ip, handleConnect);
```

连接就绪后，`reqSocket.inspectFrames = inspect`、`reqSocket.fullUrl = tunnelUrl`（`:650-651`）把隧道上下文挂到 socket 上，`sendEstablished`（`:729-826`）再写回 `HTTP/1.1 200 Connection Established`（`:777,784`）。它与解密分支先发的 `setEstablished` 是两种不同实现：前者还要叠加 `resHeaders`、`replaceStatus`、`responseFor` 等响应规则，后者只是最简 200。`:748-750` 的 `enableTunnelAck` 则配合 `:149-150` 的策略头，让客户端在透传前先确认一个字节，避免首包被过早消费。

`:758-762` 同样检查 `rollBackTunnel`，为真时 `reqSocket.resume()` 并直接回调，把首包原样接回纯透传管道。也正因两条分支最终都落到 `handleTunnel`，`enable://inspect` 之类的抓帧能力对「解密的隧道」与「不解密的隧道」才有一致的入口：区别只在于前者已经把 TLS 换成了明文，后者仍需按字节流处理。这把问题自然交给了下一篇的 `socket-mgr`。

## 小结

- `connect` 事件由 `tunnel.js:38-44` 注册，URL 被归一为 `tunnel://host:port`，缺省端口补 443。
- `isIntercept()` 综合禁用属性、自定义拦截、全局抓包开关、系统黑名单与自定义证书；`x-whistle-policy` 的五个值决定是否强制透传或强制解密。
- 命中解密时先 `setEstablished` 回 200，`readOneChunk` 按明文 HTTP / H2 preface / 首字节 22 分流，失败即 `rollBackTunnel` 回退。
- SNI 驱动 `node-forge` 现签叶证书，内部 TLS server 把明文经 `server.emit('request')` 打回 Express；H2 由 `toHttp1` 转回主端口。
- 入站伪造证书、出站原生校验且默认 `rejectUnauthorized = false`；不解密分支由 `net.connect` 与 `sendEstablished` 完成纯透传。

## 下一步

[《隧道、WebSocket 与帧拦截》](/core/tunnel-websocket)：解密与否都会汇入双向流，下一篇看 `socket-mgr` 如何统一管理连接上下文与帧。
