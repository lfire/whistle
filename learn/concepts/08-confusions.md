---
title: 易混淆概念辨析
description: 把全站形近、名近、阶段近的概念摆成对照手册，逐组给出差别、源码落点与踩坑现象。
---

# 易混淆概念辨析

本篇是「概念精解」板块的对照手册，不再逐个讲透名词，而是把容易互相串味的概念成对摆开。前置知识是前七篇建立的代理、TLS、进程、抓包、规则与扩展模型；读完你能在排查时迅速判断「我到底该看哪一层」，而不是在几个同名的文件之间来回翻。全文按八个主题分组，每组固定回答差别、类比、源码怎么分、写错会看到什么、该回查哪一节。

## 本层概念地图

八个小节共 83 组对照，下表给出主题、组数与主要源码落点，可按现象反查。

::: cols 24|26|26|24
| 主题 | 组数 | 主要落点 | 回查章节 |
|---|---|---|---|
| 代理与协议 | 15 组 | `lib/tunnel.js` | `/concepts/01-proxy` |
| TLS 与证书 | 11 组 | `lib/https/ca.js` | `/concepts/03-tls` |
| 运行时与进程 | 11 组 | `lib/config.js` | `/concepts/04-runtime` |
| 抓包与数据面 | 8 组 | `inspectors/data.js` | `/concepts/05-capture` |
| 规则 DSL | 18 组 | `lib/rules/rules.js` | `/concepts/06-rules` |
| 扩展与工程化 | 9 组 | `lib/plugins/` | `/concepts/07-extension` |
| 阈值与常量 | 6 组 | `data-server.js` | `/advanced/reference` |
| 命名相近不同物 | 5 组 | `lib/rules/index.js` | `/concepts/glossary` |
:::

使用顺序建议：先按现象查「踩坑表现」，再用「在 Whistle 里怎么分」的行号跳源码，最后按「相关章节」回补整块知识。若只想核对数值，直接看 `/advanced/reference`。

## 一、代理与协议

这一组的共同根源是「客户端把请求发给了谁、代理读到的是哪一层的字节」。

```js
// lib/tunnel.js:168-213（节选，解密判定的总闸）
var isCustomIntercept = function () {
  return filter.https || filter.capture ||
    filter.intercept || policy === 'intercept' ||
    policy === 'capture';
};
var isEnableIntercept = function () {
  var capture = properties.isEnableCapture();
  return capture && !CRONET_RE.test(ua) &&
    !SYS_HOST_RE.test(hostname);
};
```

### CONNECT 隧道 vs MITM 解密
- **一句话差别**：前者只搬字节，后者拆成两段 TLS 换出可读明文。
- **形象类比**：隧道像密封运钞车一路不开封；MITM 像在中转站开箱验货再封一辆新车。
- **在 Whistle 里怎么分**：`lib/tunnel.js:577-596` 只做 `net.connect` 纯转发；`:264-282` 先回 200 再读首包，交给 `lib/https/index.js:1184-1234` 分流解密。
- **踩坑表现**：不装根证书就想看 HTTPS 明文，界面只有一条隧道记录、没有请求详情。
- **相关章节**：[代理基础](/concepts/01-proxy)、[CONNECT 判定](/core/connect-mitm)。

### 透传 vs 解密
- **一句话差别**：透传零改写零记录正文，解密后才能跑规则与抓包。
- **形象类比**：透传像原封转交包裹；解密像拆包登记、换好内容再寄出。
- **在 Whistle 里怎么分**：`lib/tunnel.js:304-573` 的 `handleTunnel` 是透传落点；`lib/tunnel.js:168-213` 的 `isIntercept()` 决定这条 CONNECT 是否进解密分支。
- **踩坑表现**：写了 `resBody://` 对 HTTPS 完全不生效，多半是这条隧道被判为纯透传。
- **相关章节**：[TLS 与 MITM](/concepts/03-tls)、[CONNECT 判定](/core/connect-mitm)。

### Upgrade/101 vs CONNECT/200
- **一句话差别**：101 是切换应用协议并继续按帧解析，200 只是隧道就绪、后续按字节。
- **形象类比**：101 像换车厢但仍查票；200 像放行之后不再看车厢里装什么。
- **在 Whistle 里怎么分**：`lib/upgrade.js:179-181` 注册 `upgrade` 事件；`lib/tunnel.js:44` 注册 `connect`，`:281` 的 `setEstablished` 写 `200 Connection Established`。
- **踩坑表现**：把 WebSocket 当 CONNECT 处理会丢帧，把 CONNECT 当 Upgrade 会去解析不存在的帧头。
- **相关章节**：[HTTP 与报文](/concepts/02-http)、[隧道与帧](/core/tunnel-websocket)。

### SOCKS vs HTTP 代理
- **一句话差别**：SOCKS 协商目标地址与端口，HTTP 代理读绝对 URI 请求行。
- **形象类比**：SOCKS 像只报门牌号的搬运工；HTTP 代理像要读完整快递单再转送。
- **在 Whistle 里怎么分**：`lib/index.js:151-207` 把 SOCKS 连接转成对主端口的内部 CONNECT；`lib/index.js:40-43` 的 Express 链处理普通 HTTP 请求。
- **踩坑表现**：给 SOCKS 客户端配了 HTTP 代理地址，握手直接失败且不产生任何请求日志。
- **相关章节**：[代理基础](/concepts/01-proxy)、[代理形态](/domain/proxy-basics)。

### 绝对 URI vs origin-form
- **一句话差别**：代理请求行写完整 URL，直连只写路径加 Host 头。
- **形象类比**：前者像信封写全收件地址；后者像只写房间号、靠楼名补全。
- **在 Whistle 里怎么分**：`biz/index.js:34` 用 `util.getFullUrl(req)` 还原完整 URL；`lib/inspectors/rules.js:40-44` 再据此落到 `req.options`。
- **踩坑表现**：正向代理场景发了 origin-form，代理不知道转发给谁，规则也不会命中。
- **相关章节**：[HTTP 与报文](/concepts/02-http)、[请求旅程](/core/http-request)。

### 正向 vs 反向代理
- **一句话差别**：正向代表客户端访问任意源站，反向代表源站接收指定流量。
- **形象类比**：正向像代客跑腿；反向像店门口的接待台替后厨接单。
- **在 Whistle 里怎么分**：`lib/index.js:96-124` 让 `httpPort` / `httpsPort` 回调同一个 `app`；规则侧靠 `lib/rules/index.js:150` 的 `host` 改目标。
- **踩坑表现**：用反向代理思路配 `host`，结果所有域名都被转到同一台机器。
- **相关章节**：[代理基础](/concepts/01-proxy)、[代理形态](/domain/proxy-basics)。

### 系统代理 vs PAC vs ZeroOmega
- **一句话差别**：系统代理是全局开关，PAC 是选路脚本，ZeroOmega 是浏览器插件版开关。
- **形象类比**：系统代理像总水阀；PAC 像按房间分水的管路图；ZeroOmega 像只管自家水龙头的阀门。
- **在 Whistle 里怎么分**：`lib/rules/index.js:264-276` 用 `node-pac` 编译 PAC 后按 URL 查上游；系统代理设置由 `bin/proxy.js` 落到操作系统。
- **踩坑表现**：PAC 排除了某域名、插件也放行，流量根本没到 Whistle，界面一片空白。
- **相关章节**：[代理基础](/concepts/01-proxy)、[本地联调](/scenarios/local-env)。

### 上游代理 vs 链式 CONNECT
- **一句话差别**：上游是出站转发目标，链式是连到 Whistle 之前先套一层隧道。
- **形象类比**：上游像出城必经的检查站；链式像先走一段封闭通道再进检查站。
- **在 Whistle 里怎么分**：`lib/config.js:169-203` 的 `getHttpsAgent` 用 hagent 包出站；`lib/util/patch.js:100-159` 手写第二个 CONNECT 报文。
- **踩坑表现**：只配上游不配链式，Whistle 收不到本该被解密的那条 CONNECT。
- **相关章节**：[代理基础](/concepts/01-proxy)、[全局架构](/architecture/overview)。

### host vs proxy vs DNS
- **一句话差别**：`host` 改目标主机，`proxy` 改下一跳，DNS 只影响域名到 IP 的解析。
- **形象类比**：host 改收件人；proxy 改快递公司；DNS 改地址簿里的门牌号。
- **在 Whistle 里怎么分**：`lib/rules/index.js:126-303` 的 `getProxy` 合并各类规则；`lib/rules/dns.js:1-20` 只做解析缓存。
- **踩坑表现**：以为 `host://` 能走上级代理，结果 DNS 仍解析原域名，连到了错误机房。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[规则引擎](/modules/rules-engine)。

### HTTP/2 多路复用 vs HTTP/1.1 keep-alive
- **一句话差别**：h2 一条连接并发多个 stream，h1 同连接只能顺序排队。
- **形象类比**：h2 像多车道高速；h1 像单车道且后车必须等前车通过。
- **在 Whistle 里怎么分**：`lib/https/h2.js:353-367` 建 `http2.createSecureServer`；`lib/https/index.js:1013-1100` 的 `toHttp1` 降级为 h1 再复用中间件。
- **踩坑表现**：按 h1 的「一请求一响应」去读 h2 抓包，看到交错帧就误判顺序错乱。
- **相关章节**：[HTTP 与报文](/concepts/02-http)、[流量形态](/domain/web-protocols)。

### h2 vs h2c
- **一句话差别**：h2 跑在 TLS 上由 ALPN 协商，h2c 是明文 HTTP/2、靠首包识别。
- **形象类比**：h2 像加密专列；h2c 像不加密但同样编组的货车。
- **在 Whistle 里怎么分**：`lib/https/h2.js:10` 的 `SUPPORTED_PROTOS` 走 ALPN；`lib/https/index.js:1118` 的 `HTTP2_RE` 命中 preface 才走明文 h2 server。
- **踩坑表现**：客户端发 h2c 而服务端只等 TLS，首包被当成裸 TCP 字节流透传。
- **相关章节**：[HTTP 与报文](/concepts/02-http)、[CONNECT 判定](/core/connect-mitm)。

### WebSocket 帧 vs TCP 字节流
- **一句话差别**：帧有边界与类型，裸 TCP 只有字节顺序、没有消息概念。
- **形象类比**：帧像一封封贴标签的信；字节流像一根连续不断的水管。
- **在 Whistle 里怎么分**：`lib/socket-mgr.js:291-301` 用 `ws-parser` 构造收发器；`:772-773` 无需抓帧时直接 `req.pipe(res).pipe(req)`。
- **踩坑表现**：对裸 TCP 用 `frameScript` 逐帧改写，脚本一个帧事件都收不到。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[隧道与帧](/core/tunnel-websocket)。

### chunked vs gzip
- **一句话差别**：chunked 是传输分块方式，gzip 是内容编码，两者可以同时存在。
- **形象类比**：chunked 像把书拆成几包寄；gzip 像把每包文字压缩成密文。
- **在 Whistle 里怎么分**：`lib/init.js:87-155` 的 `addTransforms` 先解压再改写重压缩；`lib/inspectors/rules.js:73-133` 的 `getDecoder` / `getEncoder` 处理编码。
- **踩坑表现**：只删 `content-length` 却没处理 `content-encoding`，改写后客户端解压直接报错。
- **相关章节**：[HTTP 与报文](/concepts/02-http)、[请求旅程](/core/http-request)。

### Content-Length vs chunked
- **一句话差别**：前者声明固定字节数，后者用分块边界表示结束。
- **形象类比**：前者像写明「共 300 页」；后者像每章盖「续」直到最后盖「完」。
- **在 Whistle 里怎么分**：`lib/init.js:106-112` 一旦要 gunzip 就 `delete content-length`；`lib/inspectors/res.js:1182,1206` 响应侧同样删除。
- **踩坑表现**：改写 body 后保留旧长度，客户端要么截断内容、要么一直等剩余字节。
- **相关章节**：[HTTP 与报文](/concepts/02-http)、[请求旅程](/core/http-request)。

### SSE vs WebSocket
- **一句话差别**：SSE 是单向不结束的 HTTP 响应，WebSocket 是 101 之后的双向帧。
- **形象类比**：SSE 像广播喇叭只往外说；WebSocket 像对讲机两边都能讲。
- **在 Whistle 里怎么分**：`lib/inspectors/data.js:331-355` 按 `\n\n` 给 SSE 切帧展示；`lib/socket-mgr.js:325` 起的 `handleWsSend` / `handleWsReceive` 处理双向帧。
- **踩坑表现**：把 SSE 当 WebSocket 注入帧，事件流被拆坏、界面只剩半截文本。
- **相关章节**：[HTTP 与报文](/concepts/02-http)、[抓包上报](/core/capture-data)。

## 二、TLS 与证书

这一组都围绕「谁信任谁、证书里的名字怎么对上」。

### SNI vs SAN
- **一句话差别**：SNI 是客户端握手时带来的域名，SAN 是证书里允许匹配的域名列表。
- **形象类比**：SNI 像访客自报姓名；SAN 像通行证上印好的可用名单。
- **在 Whistle 里怎么分**：`lib/https/index.js:1295` 用 `checkSNI(chunk)` 取名；`lib/https/ca.js:241-252` 把域名写进 SAN 扩展。
- **踩坑表现**：以为改 SNI 能绕过域名校验，实际浏览器只认证书里的 SAN。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[证书体系](/modules/certificates)。

### ALPN vs SNI
- **一句话差别**：ALPN 协商 `h2` 还是 `http/1.1`，SNI 指示要哪个站点的证书。
- **形象类比**：ALPN 像商量用哪种语言交谈；SNI 像说明要找哪间办公室。
- **在 Whistle 里怎么分**：`lib/https/h2.js:10` 的 `SUPPORTED_PROTOS` 决定协议；`lib/https/index.js:1295` 的 SNI 结果驱动 `getSNIServer` 选证书。
- **踩坑表现**：关掉 ALPN 却期待 h2，流量被降到 h1 后多路复用消失。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[HTTPS 与中间人](/domain/tls-mitm)。

### 根证书 vs 叶证书
- **一句话差别**：根 CA 负责签发并被系统信任，叶证书承载某个域名的单次连接。
- **形象类比**：根像公安局的印章；叶像它开出的某一张具体通行证。
- **在 Whistle 里怎么分**：`lib/https/ca.js:476-549` 的 `createCACert` 置 `cA:true`；`:206-266` 的 `createSelfCert` 置 `cA:false` 并复用根私钥。
- **踩坑表现**：把叶证书装进信任库，其它域名依旧告警，因为叶证书没有签发权。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[证书体系](/modules/certificates)。

### 证书链 vs 信任锚
- **一句话差别**：链是叶到根的逐层验签路径，信任锚是系统预置、验证终止的那个根。
- **形象类比**：链像一级级向上请示的介绍信；信任锚像最终盖章认可的那本名册。
- **在 Whistle 里怎么分**：`lib/https/ca.js:558-573` 用根私钥签叶证书；`lib/config.js:65` 默认不校验源站链，`--mode safe`（`:809-810`）才打开。
- **踩坑表现**：只装了中间 CA 没装根，浏览器仍报「不受信任的颁发者」。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[HTTPS 与中间人](/domain/tls-mitm)。

### 证书校验 vs 证书固定
- **一句话差别**：校验看链能否追溯到信任锚，固定是应用写死只认指定证书或公钥。
- **形象类比**：校验像查介绍信真伪；固定像只认某个人的签名、真介绍信也不看。
- **在 Whistle 里怎么分**：`lib/config.js:65,809-810` 控制出站校验；`lib/tunnel.js:199-200` 的 `CRONET_RE` / `SYS_HOST_RE` 直接放行 pinning 系统域名。
- **踩坑表现**：装了根证书仍抓不到某些 App，就是命中固定，换证书必然握手失败。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[证书排障](/scenarios/https-trust)。

### 自签根 CA vs 自签源站证书
- **一句话差别**：前者是你装进信任库、用来签别人的 CA，后者是源站自己给自己签的叶证书。
- **形象类比**：前者像自己刻了枚公章；后者像商户手写的一张收据。
- **在 Whistle 里怎么分**：`lib/https/ca.js:427-446` 读取或新建本地根；`lib/config.js:65` 用 `rejectUnauthorized=false` 容忍自签源站。
- **踩坑表现**：以为「装了自签证书」等于信任所有站点，其实只信任了本地 CA 这一支。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[证书排障](/scenarios/https-trust)。

### mTLS 客户端证书 vs 服务端证书
- **一句话差别**：服务端证书证明「你是谁」，mTLS 里客户端证书证明「我是谁」。
- **形象类比**：服务端证书像店铺营业执照；客户端证书像会员卡，双向都要出示。
- **在 Whistle 里怎么分**：`lib/rules/index.js:21` 的 `clientCerts` 缓存；`lib/https/index.js:542-557` 组装 `opts` 时带上客户端证书。
- **踩坑表现**：只导入服务端证书去访问 mTLS 接口，服务端直接拒绝握手。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[证书排障](/scenarios/https-trust)。

### MITM 两段 TLS vs 一条隧道
- **一句话差别**：两段是客户端与代理、代理与源站各握一次；隧道只有一条字节管道。
- **形象类比**：两段像在中转站换车并重新安检；一条隧道像整车原样穿过。
- **在 Whistle 里怎么分**：`lib/https/index.js:1251-1267` 拨向内部 TLS server；`lib/tunnel.js:596` 的 `net.connect` 是纯隧道出口。
- **踩坑表现**：把延迟与握手失败都算到「网络慢」，忽略两段握手带来的额外失败面。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[CONNECT 判定](/core/connect-mitm)。

### CN vs SAN
- **一句话差别**：CN 是早期单域名字段，SAN 是可放多域名与 IP 的现代扩展。
- **形象类比**：CN 像只写一个名字的旧证件；SAN 像可附多个别名的通行证。
- **在 Whistle 里怎么分**：`lib/https/ca.js:484` 的 CN 取 `'whistle.' + 时间戳`；`:241-252` 把域名按 type 2、IP 按 type 7 写进 SAN。
- **踩坑表现**：只填 CN 不填 SAN，现代浏览器直接报域名不匹配。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[证书体系](/modules/certificates)。

### PEM vs DER vs PFX
- **一句话差别**：PEM 是 Base64 文本，DER 是二进制，PFX 把证书与私钥打包加密。
- **形象类比**：PEM 像打印出来的文本件；DER 像缩微胶片；PFX 像带锁的整套档案盒。
- **在 Whistle 里怎么分**：`biz/webui/cgi-bin/rootca.js:4-13` 按 `crt` / `pem` / `cer` 下载；`lib/https/ca.js:347-369` 按同名 `.key` 配 `.crt` / `.pem` 读取。
- **踩坑表现**：把 DER 当 PEM 直接上传，解析失败而界面只提示「证书无效」。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[证书体系](/modules/certificates)。

### 入站伪造证书 vs 出站 rejectUnauthorized
- **一句话差别**：入站是本地 CA 现签给客户端看，出站是代理以客户端身份校验源站。
- **形象类比**：入站像给访客发临时通行证；出站像自己出门时查对方营业执照。
- **在 Whistle 里怎么分**：`lib/https/ca.js:616-624` 的 `SNICallback` 现签；`lib/config.js:65` 默认 `rejectUnauthorized=false` 放宽出站。
- **踩坑表现**：开了 `--mode safe` 后自签源站突然连不上，问题其实在出站侧而非根证书。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[CONNECT 判定](/core/connect-mitm)。

## 三、运行时与进程

这一组的关键是「代码跑在哪个进程、对象活多久」。

### pfork vs cluster
- **一句话差别**：pfork 按功能拉起隔离子进程，cluster 按 CPU 分担同一主端口。
- **形象类比**：pfork 像把不同工种分到独立车间；cluster 像同一车间多开几条相同产线。
- **在 Whistle 里怎么分**：`lib/plugins/index.js:620-670` 的 `p.fork`；`index.js:199-213` 仅在 `options.cluster && cluster.isMaster` 时 fork worker。
- **踩坑表现**：以为 `--cluster` 能隔离插件崩溃，实际插件仍由 pfork 单独承载。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[进程与配置](/architecture/process-config)。

### cluster worker vs pfork 子进程
- **一句话差别**：worker 共享主端口并各有 storage 后缀，pfork 子进程持有自己的内部端口表。
- **形象类比**：worker 像同一前台的多个值班窗口；pfork 像后台各有内线的独立部门。
- **在 Whistle 里怎么分**：`index.js:165-172` 给 worker 追加 `.__cluster_worker.<i>_` 后缀；`lib/plugins/load-plugin.js:1347-1374` 回传 ports 表。
- **踩坑表现**：在 worker 里按固定端口找插件，会连到另一个 worker 的子进程。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[进程与配置](/architecture/process-config)。

### proxyEvents vs reqEmitter
- **一句话差别**：proxyEvents 是全站唯一总线，reqEmitter 是单条请求专属发射器。
- **形象类比**：前者像小区广播；后者像这一户的门铃，只通知这一单的订阅者。
- **在 Whistle 里怎么分**：`lib/index.js:45` 创建 `proxyEvents`；`lib/inspectors/data.js:185` 广播后再由 reqEmitter 抛 `send` / `response` / `end` / `abort`。
- **踩坑表现**：在总线上监听每次状态变化，会收到所有请求回调，只能自己按 reqId 过滤。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[抓包上报](/core/capture-data)。

### inspector vs handler
- **一句话差别**：inspector 是请求四阶段的改写中间件，handler 是出站分发与兜底。
- **形象类比**：inspector 像出厂前的多道质检；handler 像决定走哪条物流并签收退回件。
- **在 Whistle 里怎么分**：`lib/inspectors/index.js:1-8` 固定 `rules → req → data → res`；`lib/handlers/index.js:1-7` 是 `file-proxy → http-proxy → error-handler`。
- **踩坑表现**：在 handler 里找 `reqBody` 改写，出站请求其实已经发出去了。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[请求旅程](/core/http-request)。

### 旁路采样 vs 改写 Transform
- **一句话差别**：采样覆盖 `write` / `end` 只顺手记一份，Transform 会真的替换流过的字节。
- **形象类比**：采样像在传送带旁装计数器；Transform 像在带上换掉一件货。
- **在 Whistle 里怎么分**：`lib/inspectors/data.js:279-323` 包装后立即 `write.apply`；`lib/init.js:87-155` 的 `addTransforms` 插入替换流。
- **踩坑表现**：以为抓包看到的是客户端原始报文，其实采样点在改写之后。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[抓包上报](/core/capture-data)。

### LRU vs 自实现有界缓存
- **一句话差别**：LRU 按访问淘汰键值项，抓包缓存按条数与结束时间批量清理。
- **形象类比**：LRU 像书架满了抽走最久没翻的书；抓包缓存像每天清一次过期挂号单。
- **在 Whistle 里怎么分**：`lib/rules/index.js:20` 的 `tplCache = new LRU({ max: 36 })`；`lib/util/data-server.js:75-95` 用 `ids[]` + `reqData{}` + `framesCache` 手工维护。
- **踩坑表现**：以为规则匹配有 LRU，实际 `regUrlCache` 在每次编译后被整体清空（`lib/rules/rules.js:1802-1805`）。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[抓包上报](/core/capture-data)。

### 短轮询 vs SSE/长连接
- **一句话差别**：短轮询由客户端定时发 HTTP 取增量，SSE 是服务端持续写一条不结束的响应。
- **形象类比**：短轮询像隔一会儿去信箱看信；SSE 像邮差守在门口一有信就递进来。
- **在 Whistle 里怎么分**：`biz/webui/htdocs/src/js/data-center.js:1157-1159` 按 `hasNew` 选 100 / 900 ms；`lib/inspectors/data.js:331-355` 把 SSE 响应按事件切帧展示。
- **踩坑表现**：给抓包数据强行换 SSE，会丢掉 gzip、同源鉴权与背压控制。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[Web 管理界面](/modules/webui)。

### agent vs socksAgent
- **一句话差别**：agent 管 HTTP/HTTPS 出站连接池，socksAgent 管 SOCKS 上游连接。
- **形象类比**：agent 像普通货运车队的调度表；socksAgent 像专走隧道线路的调度表。
- **在 Whistle 里怎么分**：`lib/config.js:86-87` 分别是 `max:360` 与 `max:100` 的 LRU；`:1039-1048` 构造 `httpAgent` / `httpsAgent`，默认还 `disableAgent`。
- **踩坑表现**：调大 `sockets` 却发现 SOCKS 连接没变多，因为改的是另一组 agent。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[进程与配置](/architecture/process-config)。

### 单例配置 vs 每次 require 新建
- **一句话差别**：`config` 是模块导出对象被就地扩展的全局单例，require 多次拿到同一引用。
- **形象类比**：单例像全楼共用一块总电表；新建像每户各装一块互不相干的表。
- **在 Whistle 里怎么分**：`lib/config.js:16` 的 `var config = extend(exports, pkgConf)`；`:608-610` 让 `variableProperties` 回退默认值。
- **踩坑表现**：某个模块改了 `config.xxx` 却忘了全站可见，另一处读到的值已被覆盖。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[进程与配置](/architecture/process-config)。

### storage vs baseDir
- **一句话差别**：baseDir 是数据总根，storage 是其下用于隔离多实例的子目录名。
- **形象类比**：baseDir 像整栋档案楼；storage 像楼里给某租户单独编的房间号。
- **在 Whistle 里怎么分**：`lib/util/common.js:598-599` 给出根路径；`lib/config.js:1067-1091` 把 `custom_dirs/<enc(storage)>/` 拼成 rules / values / properties 子目录。
- **踩坑表现**：两个实例 storage 不同却互相找规则，改了 A 的配置 B 完全没生效。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[协作配置](/scenarios/collab-config)。

### detached 守护进程 vs CLI 短命进程
- **一句话差别**：`w2 start` 拉起常驻 detached 进程后 CLI 立即退出，CLI 自身不持有端口。
- **形象类比**：前者像值班室换班后长期亮灯；后者像送完通知就走的传达员。
- **在 Whistle 里怎么分**：`bin/whistle.js` 负责解析与守护化；`lib/service/index.js:17-32` 把标量序列化成 fork 参数拉起后台服务。
- **踩坑表现**：在 CLI 进程里打断点等请求，断点永远不命中，因为请求在另一个进程。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[启动流程](/architecture/startup)。

## 四、抓包与数据面

这一组区分「记录的是什么结构」以及「有没有改变转发」。

### 抓包 session vs 帧
- **一句话差别**：session 是一次请求的完整记录对象，帧是长连接上逐条收发的消息单元。
- **形象类比**：session 像一次通话的整份记录单；帧像通话里的一句句话。
- **在 Whistle 里怎么分**：`lib/util/data-server.js:319-333` 原地写入 `reqData[id] = data`；`:342-345` 把帧推进 `framesCache`。
- **踩坑表现**：在 session 里找 WebSocket 消息内容，只能看到摘要，正文要去帧列表。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[抓包上报](/core/capture-data)。

### 旁路采样 vs 阻断
- **一句话差别**：采样不改变转发，阻断会挂起或丢弃数据直到放行。
- **形象类比**：采样像旁边记账；阻断像把闸门按下让货先停一停。
- **在 Whistle 里怎么分**：`lib/inspectors/data.js:279-323` 只累加与拼接；`lib/socket-mgr.js:63-84` 的 `setConnStatus` 用 pause / ignore 控制帧去向。
- **踩坑表现**：想「只看不改」却点了暂停，客户端会一直等到超时。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[隧道与帧](/core/tunnel-websocket)。

### getData vs getItem
- **一句话差别**：getData 批量返回增量列表并带修改戳，getItem 按 id 取单个会话详情。
- **形象类比**：getData 像取今天新到的整叠快递单；getItem 像凭单号查某一件的内件。
- **在 Whistle 里怎么分**：`lib/util/data-server.js:895-910` 用 `COUNT` 限单次条数；`:624-631` 的 `getItem` 按 id 补 base64。
- **踩坑表现**：用 getData 想拿完整 body，结果只有摘要，详情要再调 getItem。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[Web 管理界面](/modules/webui)。

### get-data vs get-session
- **一句话差别**：前者是抓包主数据与修改戳入口，后者按 id 列表补会话详情。
- **形象类比**：get-data 像刷一次大屏看有哪些新单；get-session 像点开某几单看明细。
- **在 Whistle 里怎么分**：`biz/webui/cgi-bin/get-data.js:28-60` 用 `sendGzip` 返回并调 `proxy.getData`；`get-session.js` 按 id 批量取详情。
- **踩坑表现**：只调 get-session 没先 get-data，前端拿不到 `hasNew` 与修改戳，界面不刷新。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[抓包上报](/core/capture-data)。

### pause vs ignore vs abort
- **一句话差别**：pause 挂起帧等待放行，ignore 丢弃当前块并继续，abort 直接断开连接。
- **形象类比**：pause 像按暂停键；ignore 像跳过这一句；abort 像直接挂断电话。
- **在 Whistle 里怎么分**：`lib/socket-mgr.js:63-84` 的 `PAUSE_STATUS=1` / `IGNORE_STATUS=2`；`biz/webui/cgi-bin/abort.js:18-19` 同时调 `data.abort()` 与 `socketMgr.destroy()`。
- **踩坑表现**：以为 ignore 只是不显示，实际那一帧已经不转发给对端了。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[隧道与帧](/core/tunnel-websocket)。

### Replay vs Composer 构造
- **一句话差别**：Replay 重发已抓到的原始请求，Composer 从零手写一个新请求。
- **形象类比**：Replay 像照着原件复印再寄一次；Composer 像拿张空白单重新填。
- **在 Whistle 里怎么分**：`/scenarios/reproduce-replay` 的重放走 `/cgi-bin/sessions/export`；`biz/webui/lib/index.js:540` 的 `/cgi-bin/composer` 先补客户端 IP 再转 service。
- **踩坑表现**：用 Replay 改参数却没生效，因为重放沿用原始报文，改动要在 Composer 里做。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[复现与重放](/scenarios/reproduce-replay)。

### SAZ/HAR vs Whistle 私有格式
- **一句话差别**：SAZ/HAR 是通用会话交换格式，Whistle 内部用 txt/json 与自己的 data 对象。
- **形象类比**：通用格式像国际通用报关单；私有格式像仓库自己的入库台账。
- **在 Whistle 里怎么分**：`lib/service/service.js:30` 的 `SESSIONS_FILE_RE` 认 `.txt/.json/.saz`；`:487-497` 的 `importSessions` 只把 `.saz` 交给 `extract-saz`。
- **踩坑表现**：把界面导出的 json 喂给只认 HAR 的工具，字段完全对不上。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[复现与重放](/scenarios/reproduce-replay)。

### body 阈值 vs 帧截断
- **一句话差别**：body 阈值控制整段响应是否缓存正文，帧截断限制单帧最大负载。
- **形象类比**：前者像规定一箱货最多登记多重；后者像规定每件包裹最大尺寸。
- **在 Whistle 里怎么分**：`lib/inspectors/data.js:7-14` 的 `MAX_BODY_SIZE=360KB` 与 `BIG_DATA_SIZE=16MB`；`lib/socket-mgr.js:219-221` 按 `MAX_PAYLOAD`（1MB）截断单帧。
- **踩坑表现**：大响应界面显示「有 20MB 但 body 为空」是 body 超阈，不是帧被切了。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[抓包上报](/core/capture-data)。

## 五、规则 DSL

这一组最容易「名字看着像、实际在两个阶段生效」。

### ignore vs skip
- **一句话差别**：`skip` 是归并到 `ignore` 的别名，二者都按协议名屏蔽规则。
- **形象类比**：像「禁止入内」与「请绕行」两块牌子，最终由同一个门卫执行。
- **在 Whistle 里怎么分**：`lib/rules/protocols.js:131-154` 把 `skip → ignore` 归并；`lib/util/index.js:1913-1985` 的 `resolveIgnore` 编译成按协议名屏蔽的 filter。
- **踩坑表现**：以为 `skip` 只跳过一行、`ignore` 屏蔽整份，解析后其实是同一机制。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[规则引擎](/modules/rules-engine)。

### enable vs disable
- **一句话差别**：enable 打开某项能力开关，disable 关闭它，二者都是全局布尔位。
- **形象类比**：enable 像合上某个电闸；disable 像把同一个电闸拉开。
- **在 Whistle 里怎么分**：`lib/rules/protocols.js:14` 把二者列入开关类协议；`lib/tunnel.js:168-178` 的 `disable.intercept` / `disable.https` / `disable.capture` 一票否决解密。
- **踩坑表现**：`enable://captureData` 与 `disable://https` 同时写，后者优先把解密关掉。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[指令体系](/modules/protocol-catalog)。

### intercept vs capture
- **一句话差别**：两者都强制解密，语义侧重「拦截改写」与「只抓包记录」。
- **形象类比**：intercept 像开箱检查并可能换内容；capture 像开箱只拍照登记。
- **在 Whistle 里怎么分**：`lib/tunnel.js:179-187` 的 `isCustomIntercept` 把两个策略头值一视同仁顶成真；`:203-204` 再由 `weakTunnel` 决定是否回退。
- **踩坑表现**：以为写 `capture` 就一定不改写，其实规则里的 `resBody` 仍会生效。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[CONNECT 判定](/core/connect-mitm)。

### tunnel vs connect（事件名 vs 策略头值）
- **一句话差别**：`connect` 是 Node 的 CONNECT 事件名，`tunnel` / `connect` 也是策略头的两个取值。
- **形象类比**：一个像「门口这个岗位叫连接岗」；一个像「工单上写着按隧道方式处理」。
- **在 Whistle 里怎么分**：`lib/tunnel.js:44` 注册 `server.on('connect', ...)`；`:144-148` 读 `x-whistle-policy`，两个值都令 `useTunnelPolicy` 为真强制透传。
- **踩坑表现**：在策略头里写 `connect` 想「走 CONNECT 事件」，结果是把解密关掉了。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[CONNECT 判定](/core/connect-mitm)。

### reqRules vs rulesFile
- **一句话差别**：`reqRules.txt` 是插件随包的静态请求规则，`rulesFile` 是运行期从文件动态读取的规则。
- **形象类比**：前者像随设备出厂的说明书；后者像现场临时下发的一张调度单。
- **在 Whistle 里怎么分**：`lib/plugins/get-plugins-sync.js:189-194` 扫描期渲染 `_rules.txt` / `reqRules.txt`；`lib/rules/index.js:437` 在请求期解析 `rulesFile`。
- **踩坑表现**：改了 `reqRules.txt` 不重启不生效，因为它在扫描时已读进缓存。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[插件系统](/modules/plugins)。

### Values vs 内嵌值
- **一句话差别**：Values 是界面里可复用的键值素材，内嵌值是写在规则文件反引号块里的局部值。
- **形象类比**：Values 像公共仓库的货架；内嵌值像随这份文件夹带的便签。
- **在 Whistle 里怎么分**：`lib/rules/rules.js:43` 的 `VALUE_KEY_RE` 替换 `{key}`；`lib/util/index.js:202-241` 的 `resolveInlineValues` 抽反引号块并给键拼文件名隔离。
- **踩坑表现**：内嵌值键名与 Values 同名时作用域不同，容易取到意外内容。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[规则引擎](/modules/rules-engine)。

### 内嵌值 vs 模板变量
- **一句话差别**：内嵌值是编译期被抽出的常量文本，模板变量在请求期按上下文求值。
- **形象类比**：内嵌值像预先印好的固定文案；模板变量像每次填表时才写上当前时间。
- **在 Whistle 里怎么分**：`lib/util/index.js:202-241` 在 `getLines` 阶段抽内嵌值；`lib/rules/rules.js:76-77,721-789` 的 `resolveTplVar` / `renderTpl` 在求值阶段替换 `${method}`。
- **踩坑表现**：在内嵌值里写 `${method}`，得到的是字面量而不是真实方法名。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[规则引擎](/modules/rules-engine)。

### `${key}` 规则集 vs `${method}` 模板变量
- **一句话差别**：整行 `${key}` 展开另一份规则集，`${method}` 是替换为请求方法的模板变量。
- **形象类比**：前者像把另一章整段贴进来；后者像在这句话里填入当前的动词。
- **在 Whistle 里怎么分**：`lib/rules/rules.js:42` 的 `RULE_KEY_RE` 在 `getLines`（`:410-450`）展开规则集；`:76-77` 的 `TPL_VAR_RE` 由 `:721-789` 求值。
- **踩坑表现**：把 `${method}` 写成独立一行，会被当成规则集名去找一份不存在的文件。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[规则引擎](/modules/rules-engine)。

### pattern filter vs lineProps
- **一句话差别**：filter 决定「对哪些请求生效」，lineProps 修饰「这条规则自身怎么匹配」。
- **形象类比**：filter 像入场资格检查；lineProps 像给这张票加上「仅限本排」的备注。
- **在 Whistle 里怎么分**：`lib/rules/rules.js:54` 的 `PATTERN_FILTER_RE` 与 `:57` 的 `PROPS_FILTER_RE`；`:1549-1739` 的 `resolveMatchFilter` 编译进 `filters` 数组。
- **踩坑表现**：把 `includeFilter://` 当 `lineProps://` 写，规则永远不命中。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[规则引擎](/modules/rules-engine)。

### important vs backRulesFirst
- **一句话差别**：important 把单条规则插到协议桶首位，backRulesFirst 把整份规则行序反转。
- **形象类比**：important 像把一张单据插到最上面；backRulesFirst 像把整摞单据倒过来放。
- **在 Whistle 里怎么分**：`lib/rules/rules.js:1400-1406` 跳过已有 important 再插入；`lib/rules/util.js:46-52` 的 `reverseRules` 反序，`:64-66` 读开关。
- **踩坑表现**：两者同开时顺序互相抵消，排错要先看行序再看 important。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[规则引擎](/modules/rules-engine)。

### 首条命中 vs 多命中
- **一句话差别**：默认每协议取首条命中即返回，多命中协议收集全部结果挂到 `rule.list`。
- **形象类比**：首条像点菜只认第一道；多命中像把同类菜全端上桌。
- **在 Whistle 里怎么分**：`lib/rules/rules.js:997` 的循环 `--index < 0` 即 return；`lib/rules/protocols.js:186-227` 的 `multiMatchs` 列出 40 项，由 `:2273-2296` 改走 `getRuleList`。
- **踩坑表现**：给 `reqHeaders` 写两条以为会叠加，实际只有第一条生效。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[规则引擎](/modules/rules-engine)。

### mflag vs setModified
- **一句话差别**：`_mflag` 是规则对象自身的版本标记，`setModified` 写的是给前端比对的配置修改戳。
- **形象类比**：前者像这份文件自带的修订号；后者像前台黑板上「规则已改」的提示。
- **在 Whistle 里怎么分**：`lib/rules/rules.js:2051-2110` 的 `parse` / `append` / `clearAppend` 维护 `_mflag`；`lib/config.js:1126-1134` 写 `mrulesClientId` / `mrulesTime`。
- **踩坑表现**：只改了 Values 却没打修改戳，前端轮询比对不到变化，界面不刷新。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[进程与配置](/architecture/process-config)。

### rule 协议桶 vs 插件协议
- **一句话差别**：未知 `xxx://` 回退到 `rule` 桶，再由插件管理器解析成具体插件名。
- **形象类比**：rule 桶像「待分派」筐；插件协议像筐上贴了具体承办部门。
- **在 Whistle 里怎么分**：`lib/rules/rules.js:1320-1323` 找不到桶就回退 `rule`；`lib/plugins/index.js:1436-1472` 的 `resolveWhistlePlugins` 解析 `rule` / `plugin` 桶。
- **踩坑表现**：自定义协议没被识别时，先查包名是否合规范，而不是先改规则语法。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[插件系统](/modules/plugins)。

### `tunnel://` 伪 URL vs Final URL
- **一句话差别**：`tunnel://host:port` 是隧道阶段的内部标识，Final URL 是规则求值后真正出站的地址。
- **形象类比**：前者像运单上的「待定目的地」；后者像分拣后写定的实际收件地址。
- **在 Whistle 里怎么分**：`lib/tunnel.js:75` 把 CONNECT 归一成 `tunnel://`；`lib/rules/rules.js:947-967` 的 `getPathRule` 把 matcher 与剩余路径拼成最终 URL。
- **踩坑表现**：拿 `tunnel://` 去配路径匹配规则永远命不中，因为隧道阶段没有路径。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[CONNECT 判定](/core/connect-mitm)。

### 规则集 vs 分组
- **一句话差别**：规则集是可被选中并叠加的一整份规则文本，分组只是界面上的归类显示。
- **形象类比**：规则集像一整本可启用的操作手册；分组像书架上贴的分类标签。
- **在 Whistle 里怎么分**：`lib/rules/util.js:89-99` 的选中 → Default → Mock → Service → Shadow 叠加顺序；`lib/rules/storage.js:61-74` 管理 files / properties 目录。
- **踩坑表现**：以为把规则拖进某分组就启用了它，实际未选中就完全不参与匹配。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[协作配置](/scenarios/collab-config)。

### 别名 vs 正式协议名
- **一句话差别**：别名只在解析期归并，运行期看到的始终是归并后的正式名。
- **形象类比**：别名像同事间的外号；正式名像工牌姓名，考勤系统只认后者。
- **在 Whistle 里怎么分**：`lib/rules/protocols.js:131-154` 把 `status → statusCode`、`hosts → host` 归并；`:1-75` 的 73 项数组才是注册表。
- **踩坑表现**：在插件里监听 `status` 桶收不到东西，实际数据都在 `statusCode`。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[指令体系](/modules/protocol-catalog)。

### file vs resBody
- **一句话差别**：`file` 由出站 handler 直接读本地文件短路返回，`resBody` 在响应改写阶段替换源站正文。
- **形象类比**：file 像不发货、直接把库存样品递出去；resBody 像货到了再换掉里面内容。
- **在 Whistle 里怎么分**：`lib/handlers/file-proxy.js:233-248` 按 `options.protocol` 判定；`lib/inspectors/res.js:950` 在 `res.response` 链上替换正文。
- **踩坑表现**：同时写 `file` 与 `resBody`，前者短路后后者根本没有机会执行。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[指令体系](/modules/protocol-catalog)。

### statusCode vs replaceStatus
- **一句话差别**：`statusCode` 在发请求前就短路返回，`replaceStatus` 是拿到源站响应后改状态码。
- **形象类比**：前者像根本没下单就回复「已取消」；后者像收到货后再改签收单状态。
- **在 Whistle 里怎么分**：`lib/util/index.js:3576-3599` 的 `getStatusCodeFromRule` 在 `isSpec` 时短路；`lib/inspectors/res.js:819` 在响应改写阶段处理 `replaceStatus`。
- **踩坑表现**：用 `statusCode://200` 想改源站返回的 500，请求根本没发出去。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[指令体系](/modules/protocol-catalog)。

## 六、扩展与工程化

这一组的共同点是「名字一样，但一个在进程内、一个在进程外」。

### 插件 hook vs EventEmitter 事件
- **一句话差别**：hook 是跨进程的 HTTP 请求名，EventEmitter 是同进程内的字符串事件。
- **形象类比**：hook 像给另一个部门打电话；事件像在本办公室喊一声。
- **在 Whistle 里怎么分**：`lib/config.js:85-108` 的 hook 名经 `x-whistle-plugin-hook-name_`（`:74`）发到 `127.0.0.1`；`lib/index.js:45` 的 `proxyEvents` 只在主进程内 `emit`。
- **踩坑表现**：在插件里 `proxyEvents.on('request')`，永远收不到主进程的事件。
- **相关章节**：[扩展机制](/concepts/07-extension)、[插件系统](/modules/plugins)。

### ui tab vs 服务端 inspector
- **一句话差别**：ui tab 是浏览器顶层页面，inspector 是服务端每请求执行的中间件。
- **形象类比**：ui tab 像另开一扇门进陈列室；inspector 像流水线上的一道工序。
- **在 Whistle 里怎么分**：`lib/plugins/get-plugins-sync.js:159-163` 声明 Tab 并走 `biz/webui/lib/index.js:473-481` 的 `uiPort`；`lib/inspectors/index.js:1-8` 固定四阶段顺序。
- **踩坑表现**：在 ui tab 页面里等 `req` 对象，那里只有浏览器 DOM。
- **相关章节**：[扩展机制](/concepts/07-extension)、[Web 管理界面](/modules/webui)。

### pipe vs PipeStream
- **一句话差别**：pipe 是插件读写流的 12 个 hook，PipeStream 是包装 req/res 的 npm 依赖。
- **形象类比**：pipe 像接在油管上的取样阀；PipeStream 像整条可插拔的油管本身。
- **在 Whistle 里怎么分**：`lib/config.js:96-107` 定义 pipe hook，`lib/socket-mgr.js:838-843` 接进双 Transform；`lib/init.js:1,87-155` 用 `PipeStream.wrapSrc/wrapDest`。
- **踩坑表现**：搜索 `pipe` 改到了 `PipeStream` 源码，插件 hook 一个也没动。
- **相关章节**：[扩展机制](/concepts/07-extension)、[请求旅程](/core/http-request)。

### middlewares vs uiMiddleware
- **一句话差别**：`middlewares` 进主 Express 链处理所有请求，`uiMiddleware` 只作用于管理界面链。
- **形象类比**：前者像总入口的安检；后者像只在前台通道加的第二道登记。
- **在 Whistle 里怎么分**：`lib/config.js:906-908,981-982` 解析并 `resolvePath`；`:521` 单独读 `uiMiddleware`；装配在 `lib/index.js:40-43,51`。
- **踩坑表现**：把审计中间件放进 `uiMiddleware`，代理流量完全没被记录。
- **相关章节**：[扩展机制](/concepts/07-extension)、[Web 管理界面](/modules/webui)。

### NPM 模块 API vs CLI
- **一句话差别**：模块 API 在宿主进程内启动并返回控制对象，CLI 会守护化成独立后台进程。
- **形象类比**：前者像把发动机装进自己的车；后者像买一台自带电源的整机。
- **在 Whistle 里怎么分**：`index.js:143-148` 导出 `function(options, callback)` 且不守护化；`bin/whistle.js` 处理 `start` 的 detached 行为。
- **踩坑表现**：脚本退出代理随之消失，或 `w2 start` 与嵌入式实例同时抢 8899 端口。
- **相关章节**：[扩展机制](/concepts/07-extension)、[CI 与自动化](/scenarios/automation)。

### d.ts vs 运行时
- **一句话差别**：d.ts 只给 TypeScript 编辑器看，运行时行为由 `index.js` 与 `lib/` 决定。
- **形象类比**：d.ts 像包装盒上的规格贴纸；运行时像真正通电运转的机器。
- **在 Whistle 里怎么分**：`index.d.ts:69-145,186-209` 全是 interface / type；`index.js:143-148` 与 `lib/index.js:215-241` 才是实现。
- **踩坑表现**：给类型加了字段就以为功能生效，实际运行时仍是 undefined。
- **相关章节**：[扩展机制](/concepts/07-extension)、[源码阅读路线](/advanced/source-reading)。

### shadowRules vs 用户规则集
- **一句话差别**：shadowRules 只在内存、不落盘，用户规则集由 storage 持久化并可在界面编辑。
- **形象类比**：前者像白板上的临时批注；后者像装订成册的正式值班表。
- **在 Whistle 里怎么分**：`lib/config.js:611-646` 解析后仅写 `config`；`lib/index.js:234-239` 的 `setShadowRules` 立即重解析；`lib/rules/storage.js:61-74` 才是落盘目录。
- **踩坑表现**：重启后临时规则消失，或以为界面 Rules 列表里能看到它。
- **相关章节**：[扩展机制](/concepts/07-extension)、[CI 与自动化](/scenarios/automation)。

### mode vs shadowRulesMode
- **一句话差别**：`mode` 是用户传入的原始开关串，`shadowRulesMode` 是它派生出的一个状态位。
- **形象类比**：mode 像一整张点菜单；shadowRulesMode 像厨房据此亮起的某一盏灯。
- **在 Whistle 里怎么分**：`lib/config.js:704-720` 按分隔符拆分字符串；`:781,783` 置 `config.shadowRulesMode = true`；`:864` 再由它派生 `networkMode`。
- **踩坑表现**：直接改 `shadowRulesMode` 却被下次配置合并覆盖，应该改 `mode` 输入。
- **相关章节**：[扩展机制](/concepts/07-extension)、[进程与配置](/architecture/process-config)。

### Local Agent API vs 进程内 API
- **一句话差别**：前者由外部进程经 `w2 root bin/api` 拿模块再调用，后者是同进程 `require` 返回的对象。
- **形象类比**：前者像打电话到服务台问事；后者像自己就在值班室直接看表盘。
- **在 Whistle 里怎么分**：`bin/api.js:1-11` 与 `docs/docs/extensions/api.md:1-44` 的 `loadApi`；`lib/index.js:215-241` 的 `exportInterfaces` 挂的是同进程能力。
- **踩坑表现**：在插件里照抄 Agent API 的 `spawnSync('w2', ...)`，多绕一次进程还拿不到内部对象。
- **相关章节**：[扩展机制](/concepts/07-extension)、[CI 与自动化](/scenarios/automation)。

## 七、阈值与常量

数字相同或相近，作用却分属完全不同的子系统。

```js
// lib/util/data-server.js:21-34（节选，抓包缓存的五个量）
var MAX_LENGTH = config.reqCacheSize;      // 600
var OVERFLOW_LENGTH = MAX_LENGTH * 3;      // 1800
var PRESERVE_LEN = 360;
var COUNT = 100;
var MAX_COUNT = 120;
```

### 600/1800/360 vs 100/120
- **一句话差别**：依次是常规水位、溢出水位、溢出后保留量、单次默认返回数、API 单次上限。
- **形象类比**：像书架放 600 本、超 1800 本清到留 360 本、每次借 100 本、外部接口另限 120 本。
- **在 Whistle 里怎么分**：`lib/util/data-server.js:21-26,34` 五个常量并排定义；`:904` 用 `COUNT` 收敛单次条数，`:36-40` 的 `formatApiOptions` 用 `MAX_COUNT`。
- **踩坑表现**：把 `COUNT` 当成缓存总量去调，内存没降反而单次拉取变少。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[速查表](/advanced/reference)。

### 360KB/1MB vs 2MB/16MB
- **一句话差别**：360KB 默认 body 上限、1MB 非流式请求上限、2MB 流式请求/响应体上限、16MB bigData 上限。
- **形象类比**：像四档不同规格的收纳盒，从便签到整箱，越大的越晚启用。
- **在 Whistle 里怎么分**：`lib/inspectors/data.js:7-14` 定义四个常量；`lib/util/index.js:4012` 另有 1MB 帧负载上限；严格模式下按 `config.strict` 降到 256KB。
- **踩坑表现**：严格模式下以为配置没生效，其实是 `config.strict` 改了基准值。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[抓包上报](/core/capture-data)。

### 100/900ms vs 6s vs 5s/10~30s
- **一句话差别**：分别是前端取数短轮询、抓包清理与插件刷新、规则文件本地与远端刷新周期。
- **形象类比**：像每秒看一次信箱、每 6 秒巡一次楼、本地清单 5 秒核一次、外地清单十几秒同步。
- **在 Whistle 里怎么分**：`biz/webui/htdocs/src/js/data-center.js:1157-1159`；`lib/util/data-server.js:18` 与 `lib/plugins/index.js:36` 均为 6000；`lib/util/http-mgr.js:41` 为 5000、`:17-18,42` 为 10~30s。
- **踩坑表现**：把 6s 当成规则热更新延迟，改了规则要等的是另一条 5s 通道。
- **相关章节**：[抓包与数据面](/concepts/05-capture)、[速查表](/advanced/reference)。

### sockets=256 vs 监听端口数
- **一句话差别**：`sockets` 是每目标域名出站连接池的 `maxSockets`，与监听几个端口无关。
- **形象类比**：前者像每家收货点最多同时派几辆车；后者像仓库开了几个大门。
- **在 Whistle 里怎么分**：`lib/config.js:1035-1048` 构造 `agentConfig`，`:1046` 默认还 `disableAgent = true`；`lib/index.js:90-124` 才决定 `port` / `httpPort` / `socksPort`。
- **踩坑表现**：并发上不去就狂调 `sockets`，实际瓶颈是默认禁用了 agent 连接缓存。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[代理形态](/domain/proxy-basics)。

### 7 天 / 36 天 vs 根证书十年
- **一句话差别**：叶证书提前 7 天生效、36 天后过期，根证书按 `ONE_YEAR * 10` 签十年。
- **形象类比**：叶像短期访客证；根像长期有效的机构印章，寿命差两个量级。
- **在 Whistle 里怎么分**：`lib/https/ca.js:46-49` 定义 `MIN_DATE` / `MAX_DATE`；`:565-572` 的 `isShortPeriod` 选短档，否则走十年档。
- **踩坑表现**：拿叶证书有效期去判断根证书是否该重装，白做一次证书轮换。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[证书体系](/modules/certificates)。

### 22s 帧心跳 vs 1s cluster 心跳
- **一句话差别**：22 秒是帧通道的 PING/PONG，1 秒是 cluster master 与 worker 的存活心跳。
- **形象类比**：前者像长通话里偶尔「喂」一声；后者像值班室每秒点一次名。
- **在 Whistle 里怎么分**：`lib/socket-mgr.js:8,366-375,498-502` 的 `INTERVAL = 22 * 1000`；`index.js:14-16,99-141` 的 `INTERVAL = 1000` 与 10s / 12s 超时自愈。
- **踩坑表现**：把 22s 当成 worker 掉线判定，真实自愈在 10~12 秒内就发生了。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[隧道与帧](/core/tunnel-websocket)。

## 八、命名相近但不同物

文件名或符号名几乎一样，实际分属前后端、不同进程或不同层。

### 前端 `htdocs/src/js/data-center.js` vs 服务端 `lib/service/data-center.js`
- **一句话差别**：前者是浏览器里发起轮询与渲染的模块，后者是 service 子进程里处理会话数据的模块。
- **形象类比**：一个像前台大屏的刷新程序；一个像后台库房的台账程序。
- **在 Whistle 里怎么分**：`biz/webui/htdocs/src/js/data-center.js:1157-1159` 调 `cgi.getData`；`lib/service/data-center.js` 被 `lib/service/service.js:22` 引入处理 `shareData`。
- **踩坑表现**：改了前端轮询间隔却去服务端文件里找，或反过来，改完完全没效果。
- **相关章节**：[扩展机制](/concepts/07-extension)、[Web 管理界面](/modules/webui)。

### `lib/init.js` vs 启动初始化
- **一句话差别**：`lib/init.js` 是每个请求都执行的 Express 中间件，init 指「初始化本次请求」。
- **形象类比**：像每次进门前重新整理一次随身物品，而不是大楼落成时的一次性装修。
- **在 Whistle 里怎么分**：`lib/init.js:157` 导出 `function (req, res, next)`；由 `lib/index.js:40` 挂到中间件数组第一项。
- **踩坑表现**：把只该跑一次的逻辑写进它，会在每个请求上重复执行。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[请求旅程](/core/http-request)。

### `lib/rules/index.js` vs `lib/rules/rules.js`
- **一句话差别**：前者是规则管理器、缓存与路由求值入口，后者是文本解析与匹配算法本体。
- **形象类比**：前者像调度室决定用哪套流程；后者像车间里真正把零件装起来的机器。
- **在 Whistle 里怎么分**：`lib/rules/index.js:20-21` 持有 `tplCache` / `clientCerts`，`:126-303` 的 `getProxy` 做路由；`lib/rules/rules.js:1745-1806` 的 `parseText` 与 `:997-1120` 的匹配循环。
- **踩坑表现**：改匹配分支却改到 index.js，或找缓存却翻 rules.js，两边都白费。
- **相关章节**：[规则 DSL](/concepts/06-rules)、[规则引擎](/modules/rules-engine)。

### `SNICallback`(TLS) vs `sniCallback://`(插件协议)
- **一句话差别**：前者是 Node TLS server 按域名取证书的回调，后者是规则里把决策转交插件的协议。
- **形象类比**：前者像窗口按姓名发证的动作；后者像规则上写「此人请去插件窗口办」。
- **在 Whistle 里怎么分**：`lib/https/ca.js:616-624` 的 `SNICallback` 调 `getOrCreateCert`；`lib/https/load-cert.js:7-8` 的 `SNI_CALLBACK_RE` 解析协议并查 `remoteCerts`。
- **踩坑表现**：搜 `sniCallback` 改到了 TLS 回调，插件规则却一点没变。
- **相关章节**：[TLS 与证书](/concepts/03-tls)、[证书体系](/modules/certificates)。

### `clientError` vs `error-handler`
- **一句话差别**：`clientError` 是 http.Server 的畸形报文事件，`error-handler` 是 Express 链末尾的错误兜底中间件。
- **形象类比**：前者像大门外拦下写错格式的包裹；后者像流水线末尾处理返工件。
- **在 Whistle 里怎么分**：`lib/index.js:24-34` 的 `handleClientError` 回 400 / 431；`lib/handlers/error-handler.js:3-5` 用 `res.response(wrapGatewayError(...))` 兜底。
- **踩坑表现**：畸形请求头根本进不了 Express，在 error-handler 里加日志一条也看不到。
- **相关章节**：[运行时与进程](/concepts/04-runtime)、[请求旅程](/core/http-request)。

## 与工程实际结合

排查时把现象先归到某一组，再按行号下钻，能省掉大量来回翻文件的时间。下表给出五条最常见的入口。

::: cols 26|24|26|24
| 现象 | 先查对照 | 源码锚点 | 场景入口 |
|---|---|---|---|
| HTTPS 看不到明文 | 透传 vs 解密 | `tunnel.js:168` | `/scenarios/https-trust` |
| 规则改了不生效 | 首条命中 / 别名 | `rules.js:997` | `/scenarios/index` |
| 大响应 body 为空 | body 阈值 | `data.js:7-14` | `/core/capture-data` |
| 插件协议没触发 | rule 桶 / 命名 | `index.js:1436` | `/modules/plugins` |
| 重启后规则消失 | shadowRules | `config.js:611` | `/scenarios/automation` |
:::

```bash
# 排查顺序示例（来源 bin/whistle.js、lib/config.js:704）
w2 status                       # 先确认在跟哪个实例说话
w2 start -p 8899 --mode safe    # 出站校验与解密分开验证
```

第一条命令排除「改了 A 实例却看 B 实例」的 storage 串台问题；第二条把 `mode` 的影响单独隔离出来。若现象仍与证书有关，回到 `/concepts/03-tls`；与进程有关，回到 `/concepts/04-runtime`；与阶段先后有关，回到 `/core/http-request` 的 16 步链路。

## 常见误解

- **「名字一样就是一回事」**：本篇里 `auth`、`pipe`、`connect`、`index.js`、`data-center.js` 都至少对应两个不同层的对象。看到同名先问「在哪个进程、哪个阶段」，再决定跳哪个文件。
- **「数值一样就是同一个上限」**：360 同时是 `lib/config.js:86` 的 agent LRU 容量、`lib/config.js:1037` 的严格模式 sockets 下限和 `lib/util/data-server.js:24` 的溢出保留量，三者毫无关系。
- **「界面上的顺序就是执行顺序」**：分组、规则集叠加、inspector 顺序、handler 顺序是四套不同的序，界面只呈现其中一小部分，真正的次序要看 `lib/index.js:40-43` 与 `lib/rules/util.js:89-99`。
- **「抓包所见即客户端原始报文」**：采样点在改写之后，`lib/inspectors/data.js:279-323` 覆盖的是被 `PipeStream` 包装过的流，想看原始字节得另外抓链路层。

## 小结

最容易错的 8 条，按排查频率排序：

1. CONNECT 的 200 是「隧道就绪」开关，不是业务成功码；之后代理不再解析应用协议。
2. 装根证书只是入场券，`isIntercept()` 还会被策略头、全局开关与系统黑名单一票否决。
3. `sockets=256` 是每域名连接池上限，默认还禁用了 agent 缓存，与监听端口数无关。
4. `lib/init.js` 是每请求中间件，不是启动初始化；只跑一次的逻辑写进去会重复执行。
5. 规则默认每协议首条命中，`reqHeaders` 写两条不会叠加；别名在解析期已被归并。
6. `statusCode` 在发请求前短路，`replaceStatus` 在响应回来后改，二者不能互换。
7. 抓包是旁路采样，看到的是改写后的字节；`data` 对象原地更新，UI 读同一引用。
8. 插件不在主进程 `require`，hook 头读完即删；`shadowRules` 不落盘，重启即失效。

## 下一步

[《概念串联走查》](/concepts/09-walkthrough)：用一个完整请求把本板块出现过的名词按发生顺序再走一遍，检查每一层能否对上真实源码。
