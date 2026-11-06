---
title: HTTP 报文与连接语义
description: 用十三张词条卡片讲清报文结构、分块与压缩、连接复用、HTTP/2、ALPN、Upgrade 与帧。
---

# HTTP 报文与连接语义

流量进了代理之后，代理能看懂多少、能改多少，全由报文与连接的语义决定。本层承接[代理与流量入口](/concepts/01-proxy)的「进门」结论，前置概念是[Web 协议与流量形态](/domain/web-protocols)里对 HTTP、HTTPS、WebSocket 的基本印象。读完你能说清一条报文由哪几部分组成、为什么改写 body 前必须先删 `content-length`、chunked 与 gzip 到底差在哪一层，以及 HTTP/2 伪头、ALPN、Upgrade、SSE 与 TCP 字节流各自把连接带向了什么形态。

![协议栈与 Whistle 四类入口](/diagrams/protocol-stack.svg)
*图注：同一条 TCP 连接上，HTTP/1.x 报文、HTTP/2 帧、Upgrade 后的 WebSocket 与纯透传字节流由四类入口分别接住。*

## 本层概念地图

本层十三条概念分成三簇：先有「一次请求怎么被描述」，才有「这段内容怎么传完、连接能不能复用」，最后才是「连接换协议之后还剩下什么」。前一簇的字段，正是后一簇要处理的对象。

::: cols 24|36|40
| 层次 | 决定什么 | 对应词条 |
|---|---|---|
| 报文结构 | 一次请求如何被描述 | 请求行、Header、Body、状态码 |
| 传输语义 | 边界、编码与连接复用 | 定长、分块、gzip、Keep-Alive |
| 协议升级 | 换协议后数据如何承载 | ALPN、101、伪头、帧、SSE |
:::

三簇在源码里也各自成段：请求与响应被包装成可插拔的流落在 `lib/init.js:157-163`，边界与编码处理落在 `lib/init.js:87-155` 与 `lib/service/util.js:137-146`，协议判定与降级落在 `lib/https/index.js:1117-1119` 与 `lib/https/index.js:1013-1100`。完整的一次请求旅程见[一次 HTTP 代理请求的旅程](/core/http-request)，帧与隧道的后续处理见[隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。

## 核心词条

### 请求行 / 状态行（Request Line / Status Line）

> 报文的第一行，请求侧写方法与目标，响应侧写版本与状态码。

**打个比方**：像快递单的抬头。寄件那一栏写「送到哪、用什么方式」，回执那一栏写「收到了、结果如何」；抬头只有一行，却决定了后面所有栏目该怎么填，抬头写错，整张单子就走不进分拣。

**在 Whistle 里**：`lib/https/index.js:1117-1119` 的 `HTTP_RE`、`HTTP2_RE`、`CONNECT_RE` 用正则识别第一个数据包的开头，`lib/https/index.js:1186` 据此判断是不是 HTTP/1.x 请求行；代理形态下这一行是绝对 URI，由 `lib/util/common.js:1248-1285` 的 `getFullUrl` 拆成 `host` 与 `path`。响应侧的状态行则由 `lib/https/index.js:149` 在协议切换时写成 `HTTP/1.1 101 Switching Protocols`。

```http
# 示意：绝对 URI 请求行，见 lib/util/common.js:1248
GET http://www.example.com/api HTTP/1.1
Host: www.example.com
```

**为什么这样设计**：把方法、目标、版本压进一行，是为了让代理在读到第一个换行时就能决定转发目标，而不必等完整 body；代价是这一行的写法有 origin-form、absolute-form、authority-form 多种，代理必须逐一兼容。Whistle 用一组正则先分流入 HTTPS 与 HTTP/2 明文 preface，再把请求行统一还原成完整 URL。

**容易混淆**：请求行不是 Header，CONNECT 的 `host:port` 也不是请求路径；三者形态差别见[一次 HTTP 代理请求的旅程](/core/http-request)与[辨析篇](/concepts/08-confusions)。

**工程中的样子**：[真机、移动端与远程页面调试](/scenarios/mobile-remote)里抓不到请求时，先看这一行有没有进代理；`docs/docs/rules/method.md` 的 `method://` 规则改的正是请求行里的方法。

### Header（HTTP Header）

> 报文首部的键值对，描述元数据而不承载业务实体。

**打个比方**：像包裹外侧贴的一叠标签：收件人、易碎、保价、请勿倒置。标签不是货物本身，但搬运工全靠标签决定怎么搬、能不能堆叠、要不要转交下一个人；标签写错，货物再完好也会送错地方。

**在 Whistle 里**：`lib/util/common.js:35-54` 的 `ILLEGAL_TRAILERS` 列出不允许出现在报文尾部 Trailer 里的字段——既有 `connection`、`keep-alive`、`transfer-encoding`、`upgrade` 等逐跳头，也有 `host`、`content-length`、`authorization`、`set-cookie` 等端到端头；`lib/util/common.js:432-436` 的 `removeIllegalTrailers` 据此过滤。`lib/util/index.js:3520` 的 `formatH2Headers` 另用 `isIllegalcHeader` 过滤 HTTP/2 不允许的字段，`:authority` 等伪头由 `lib/https/h2.js:276-278` 单独写入。规则的 `reqHeaders://` / `resHeaders://` 改的就是这一层。

**为什么这样设计**：Header 把控制信息与实体分离，让中间节点无需理解 body 就能路由、缓存与鉴权；代价是逐跳头只约束「这一跳」、端到端头却要原样带走，而 Trailer 作为响应末尾才追加的头，既不能改分帧与长度、也不该重复承载鉴权与路由信息，所以这两类字段一并被列入禁止名单。Whistle 把名单集中在 `ILLEGAL_TRAILERS` 一处，由 `removeIllegalTrailers`（`lib/util/common.js:432-436`）与 `addTrailerNames`（`lib/util/common.js:464-472`）共用，比在每个转发点各写一次判断更不容易漏。

**容易混淆**：Header ≠ Body，也 ≠ HTTP/2 伪头；伪头以冒号开头、由协议规定顺序，普通 Header 是自由键值对，对照见[辨析篇](/concepts/08-confusions)。

**工程中的样子**：[弱网与异常注入](/scenarios/fault-injection)里给 429 附带 `retry-after`，或在[本地联调与环境切换](/scenarios/local-env)里透传 `x-forwarded-for`，都是在 Header 层做文章，不需要碰 body。

### Body（Message Body）

> 报文里真正承载数据的部分，长度与编码由首部说明。

**打个比方**：像信封里的信纸。信封上的标签只说明「里面有一页纸、是中文、别折」，真正的内容得拆开才知道；信封可以换、标签可以改，但改了信纸就必须重新称重，否则收件人按旧重量去读会读错。

**在 Whistle 里**：`lib/init.js:157-163` 用 `PipeStream.wrapSrc(req)` 与 `PipeStream.wrapDest(res)` 把请求与响应包装成可插拔的流，之后的 `resBody://`、`htmlAppend://` 等规则都往这条流里插入 Transform；`lib/inspectors/data.js:7-11` 给出 2 MB、16 MB 等采集上限，决定大 body 是完整抓取还是截断。

**为什么这样设计**：把 body 当流而不是整块字符串，才能边收边转、不把大文件全堆进内存；代价是任何改写都会让原本声明的长度失效，因此必须先删 `content-length`（`lib/init.js:150-154`）。流模型还让 gzip 解压、字符转码、内容注入能像流水线一样串起来。

**容易混淆**：Body ≠ 报文全部，也不等于「有 body」——204、304 及 HEAD 响应按语义没有实体；`resBody://` 对这类状态码不生效，见 `docs/docs/rules/resBody.md`。

**工程中的样子**：[接口未就绪：Mock 与契约先行](/scenarios/mock-contract)里 `resBody://({"status":"mock"})` 直接替换响应体，[复现、保存与重放](/scenarios/reproduce-replay)则把采集到的 body 存下来复用。

### 状态码（Status Code）

> 响应首部的三位数字，概括本次请求的处理结果。

**打个比方**：像办事窗口亮起的号码牌。三位数字只告诉你「办成了、要补材料、还是窗口出错了」，不解释细节；但排队的人、叫号系统、后台统计都按这个数字分流，所以它必须短、必须统一。

**在 Whistle 里**：HTTP/2 把状态码搬进 `:status` 伪头（`lib/https/h2.js:301`），降级回 HTTP/1.x 时再由 `lib/https/index.js:1081-1086` 的 `writeHead` 写回状态行；`lib/https/index.js:149` 单独处理 `101`。规则侧的 `statusCode://` 短路返回、`replaceStatus://` 回源后替换（`docs/docs/rules/statusCode.md`、`replaceStatus.md`），分别对应「不回源」与「回源后改」两个阶段。

**为什么这样设计**：用少量数字统一表达结果，让客户端、代理、缓存各层无需解析正文就能决策；代价是语义高度压缩，2xx 只说成功、不保证业务成功，代理也无法仅凭状态码判断 body 是否被改写。把 `:status` 与状态行互转，正是为了让规则层始终面对同一个 `statusCode` 字段。

**容易混淆**：状态码 200 ≠ CONNECT 的 `200 Connection Established`，后者只表示隧道就绪（见[代理与流量入口](/concepts/01-proxy)）；也别把 101 当成成功响应，它是协议切换。对照见[辨析篇](/concepts/08-confusions)。

**工程中的样子**：[弱网与异常注入](/scenarios/fault-injection)里用 `statusCode://500` 与 `replaceStatus://429` 把偶发错误固定成必现，配合 `chance:0.5` 验证客户端重试逻辑。

### Content-Length vs chunked（Content-Length / Chunked Transfer）

> 两种划定 body 边界的方式：预先给总长，或分块边发边报长度。

**打个比方**：像寄一批书。一种方式是箱子上写「共十本」，收件人数到十本就封箱；另一种是每寄一本就喊一声「第一本到了」，最后喊一声「没了」，收件人靠这声「没了」才知道结束。前者要求先知道总数，后者允许边装边寄。

**在 Whistle 里**：`lib/service/util.js:137-146` 的 `getBody` 先看 `transfer-encoding` 是否为 `chunked`，是则先 `dechunkify` 去分块，再交给 `zlib.unzip`；`lib/init.js:87-155` 的 `addTransforms` 在插入任何改写 Transform 前 `delete req.headers['content-length']` / `delete svrRes.headers['content-length']`，因为一旦改写，原先声明的长度必然失效；`lib/util/common.js:38` 也把 `content-length` 列入禁止作为 Trailer 的字段清单。

```js
// lib/service/util.js:137-146 · 先去分块再解压
var chunked = headers['transfer-encoding'];
if (chunked === 'chunked') {
  body = dechunkify(body);
}
zlib.unzip(headers['content-encoding'], body, function (err, result) {
  if (!err && result) { body = result; }
  return callback(body && body.toString('base64'));
});
```

**为什么这样设计**：定长最简单，但要求发送方预先知道总长度，动态生成的响应做不到；分块把「长度」推迟到发送时，代价是每个块都要带长度前缀、末尾要有终止块。代理选择「先去分块、再改写、让底层重新定界」，是为了对上层规则隐藏这两种差异。

**容易混淆**：chunked 是传输编码、gzip 是内容编码，二者处于不同层且可同时存在；把分块当成压缩，是抓包里最常见的误判，对照见[辨析篇](/concepts/08-confusions)。

**工程中的样子**：[复现、保存与重放](/scenarios/reproduce-replay)里保存下来的 body 已经是去分块、解压后的明文；若跳过这一步直接存档，重放时长度与编码都会对不上。

### Content-Encoding / gzip vs Transfer-Encoding（Content-Encoding / Transfer-Encoding）

> 内容编码压缩实体本身，传输编码描述实体如何被搬运。

**打个比方**：像把衣服抽真空再装箱。抽真空改变的是衣服本身（内容编码），装箱时分成几个小盒、每盒贴编号（传输编码）改变的是搬运方式；收货人得先按编号把盒子凑齐，再拆真空袋，顺序反了就什么也穿不上。

**在 Whistle 里**：`lib/util/index.js:1591-1602` 的 `getZipStream` 按 `content-encoding` 选择 gzip、br、deflate、zstd 的压缩流，`lib/util/index.js:1604-1607` 的 `isZip` 用 `31/139` 两字节识别 gzip 魔数（只收到首字节 `31` 时也放行）；`lib/init.js:87-155` 的 `addTextTransform` / `addZipTransform` 把解压与重压缩挂到 PipeStream 上，并在开始时删掉 `content-length`。`lib/service/util.js:146` 的 `zlib.unzip` 负责采集侧解码。

```js
// lib/util/index.js:1591-1607 · 按编码选流（节选）
function getZipStream(headers) {
  switch (getContentEncoding(headers)) {
  case 'gzip':    return zlib.createGzip();
  case 'br':      return supportsBr && zlib.createBrotliCompress();
  case 'deflate': return zlib.createDeflate();
  case 'zstd':    return supportsZstd && zlib.createZstdCompress();
  }
}
exports.isZip = function (encoding, chunk) {
  if (encoding === 'gzip') {
    return chunk[0] === 31 && (chunk[1] == null || chunk[1] === 139);
  }
};
```

**为什么这样设计**：把「内容怎么压」与「内容怎么传」分开，浏览器才能对静态资源做透明解压，而代理仍能对分块流做边传边处理；代价是任何一层改写都要按「先去传输编码、再解内容编码、改完重新编码」的顺序来，漏一步就会得到乱码。Whistle 把这条顺序固化在 `addTransforms` 与 `getBody` 两处。

**容易混淆**：`content-encoding` ≠ `transfer-encoding`，也 ≠ `accept-encoding`；把 gzip 与 chunked 混为一谈会误判 body 边界，对照见[辨析篇](/concepts/08-confusions)。

**工程中的样子**：[接口未就绪：Mock 与契约先行](/scenarios/mock-contract)里替换 gzip 响应时不用手工解压，`enable://gzip` 可指定压缩方式（`docs/docs/rules/enable.md`）；[弱网与异常注入](/scenarios/fault-injection)里 `resDelay` 与压缩流叠加时顺序也由这条流水线保证。

### Keep-Alive（Persistent Connection）

> 一条 TCP 连接上顺序承载多个请求与响应，不每次重新握手。

**打个比方**：像打电话时不挂断，连续问好几个问题。省掉了每次重拨的等待，但对方必须按顺序一问一答，前一个没答完，后一个只能等着；想同时聊三件事，还是得再开两条线。

**在 Whistle 里**：`lib/util/common.js:53` 把 `keep-alive` 列入禁止作为 Trailer 的字段清单，说明它只约束「这一跳」的连接，不能原样透传给下一段；`lib/https/h2.js:10` 的 `SUPPORTED_PROTOS` 则给出更高层的替代方案——ALPN 协商到 `h2` 时，连接复用从「排队」升级为「并发」。出站连接池上限 `sockets` 的配置见[术语速查](/advanced/reference)。

**为什么这样设计**：HTTP/1.1 默认复用连接，省去反复三次握手与慢启动；代价是队头阻塞——同一连接上的响应必须按请求顺序返回，一个慢响应会拖住后面全部请求。这正是 HTTP/2 多路复用要解决的矛盾，也解释了为什么代理要区分「连接复用」与「流并发」。

**容易混淆**：Keep-Alive ≠ HTTP/2 多路复用，前者是串行复用、后者是同一连接上多个独立流交错；也不等于长连接推送，对照见[辨析篇](/concepts/08-confusions)。

**工程中的样子**：[弱网与异常注入](/scenarios/fault-injection)里给某个请求加 3 秒 `reqDelay`，同一连接上的后续请求会一起变慢，这个现象只有分清 Keep-Alive 与多路复用才能解释。

### HTTP/2 伪头与多路复用（Pseudo-Header / Multiplexing）

> HTTP/2 用冒号开头的伪头描述请求，并在一条连接上并发多个流。

**打个比方**：像把一摞信件拆成编号纸片，混在同一条传送带上传。每张纸片自带「属于哪封信」的编号，收件端按编号重新拼好；不像旧式传送带必须一封信送完才轮到下一封，慢的那封不再挡住别的信。

**在 Whistle 里**：`lib/https/h2.js:276-278` 写入 `:path`、`:method`、`:authority`，`lib/https/h2.js:301` 从 `:status` 取响应状态；`lib/util/index.js:3520` 的 `formatH2Headers` 过滤掉 HTTP/2 不允许的普通头；降级时 `lib/https/index.js:1030-1043` 把 `:authority` 转成 `host` 并剔除所有以冒号开头的字段。`lib/https/h2.js:369-380` 的 `getHttpServer` 用 `http2.createServer({ allowHTTP1: true })` 同时兼容两种版本。

```js
// lib/https/h2.js:10,276-301 · 伪头与 ALPN（节选）
var SUPPORTED_PROTOS = ['h2', 'http/1.1', 'http/1.0'];
headers[':path'] = options.path;
headers[':method'] = options.method;
headers[':authority'] = req.headers.host;
var statusCode = h2Headers[':status'];
```

**为什么这样设计**：伪头把 HTTP/1.x 请求行的信息拆成结构化字段，配合二进制帧与流编号，才可能在一条连接上并发多路且互不阻塞；代价是协议不再能用文本行解析，代理必须在入口处做「降级成 HTTP/1.x」或「升级成 h2」的转换，让规则层继续面对熟悉的 Header 模型。

**容易混淆**：伪头 ≠ 普通 Header，字段名带冒号、有固定集合与顺序；多路复用 ≠ Keep-Alive，前者并发、后者串行。对照见[辨析篇](/concepts/08-confusions)。

**工程中的样子**：`enable://h2` 让 Whistle 到服务器的出站启用 HTTP/2（`docs/docs/rules/enable.md`），链路见[Web 协议与流量形态](/domain/web-protocols)；降级细节见[一次 HTTP 代理请求的旅程](/core/http-request)。

### ALPN（Application-Layer Protocol Negotiation）

> TLS 握手时顺带协商上层用 h2 还是 http/1.1 的扩展。

**打个比方**：像接通电话后先说一句「我们讲中文还是英文」。这句话夹在寒暄里一并说完，不等正式谈话开始就已定好语言，之后双方都按约定讲；若等谈完再问，前几句就白说了。

**在 Whistle 里**：`lib/https/h2.js:10` 定义 `SUPPORTED_PROTOS = ['h2', 'http/1.1', 'http/1.0']`，`lib/https/h2.js:159` 与 `lib/https/h2.js:223` 把它作为 `ALPNProtocols` 传给 `tls.connect`；`lib/util/common.js:1796,1811` 还用 `options.ALPNProtocols` 是否存在来决定走 `tls` 还是 `net`，并在加密套件报错时回退。也就是说，ALPN 的结果直接影响后续用哪套解析器。

**为什么这样设计**：把协议选择塞进 TLS 握手，省掉一次额外往返，也让 h2 与 https 在端口上无法被外部区分；代价是协商结果绑定在握手阶段，代理必须提前声明自己支持的协议列表，且降级时要能把 h2 会话还原成 HTTP/1.x 请求（`lib/https/index.js:1013-1100`）。

**容易混淆**：ALPN ≠ Upgrade，前者在 TLS 握手内协商、后者在 HTTP 报文里请求切换。ALPN 也 ≠ SNI：两者都在 ClientHello 里，但 ALPN 在 `application_layer_protocol_negotiation` 扩展列出 `h2` / `http/1.1` 由服务端选定，决定「说什么协议」；SNI 在 `server_name` 扩展只带目标域名，供服务端选证书，决定「找哪个站点」。一个定解析器、一个定证书，互不替代，对照见[TLS、证书与信任](/concepts/03-tls)与[辨析篇](/concepts/08-confusions)。

**工程中的样子**：[HTTPS、证书与鉴权排障](/scenarios/https-trust)里「客户端说 h2、源站只认 http/1.1」的兼容问题，排查起点就是这张 `SUPPORTED_PROTOS` 列表。

### Upgrade / 101（Protocol Upgrade / 101 Switching Protocols）

> 用普通 HTTP 请求申请换协议，服务端回 101 后这条连接改说新语言。

**打个比方**：像在柜台先用普通话办完登记，工作人员说「请到旁边通道改用手语」，之后同一扇门后面的交流方式就变了；门没换、人没换，只是从登记那一刻起，双方都不再按原来的规矩说话。

**在 Whistle 里**：`lib/util/common.js:498-509` 的 `UPGRADE_RE` 与 `isUpgrade` 判定 `Connection: upgrade` 或 `ws:` / `wss:`；`lib/upgrade.js:77-180` 的 `upgradeHandler` 接住 `server.on('upgrade')` 事件，重建请求元信息后交给 `handleWebsocket`（`lib/upgrade.js:175`）；`lib/https/index.js:149` 写出 101 状态行，`:154` 用 WebSocket GUID 计算 `Sec-WebSocket-Accept`。

```js
// lib/util/common.js:498-509 · Upgrade 判定
var UPGRADE_RE = /^\s*upgrade\s*$/i;
var WS_RE = /^\s*websocket\s*$/i;
exports.isUpgrade = function (options, headers) {
  var p = options.protocol;
  if (p === 'ws:' || p === 'wss:' || options.method === 'UPGRADE') {
    return true;
  }
  return headers && UPGRADE_RE.test(headers.connection);
};
```

**为什么这样设计**：让 WebSocket 这类长连接复用现成的 HTTP 端口与代理链路，避免另开端口被防火墙拦住；代价是 101 之后连接不再有「请求/响应」结构，代理必须换一套帧级处理方式，且 Upgrade 头属于逐跳头、不能透传给下一段。

**容易混淆**：Upgrade ≠ CONNECT，前者把连接升级成 WebSocket 等协议、代理仍参与解析，后者把连接降级成纯字节管道、代理默认不解析；101 ≠ 200，对照见[代理与流量入口](/concepts/01-proxy)与[辨析篇](/concepts/08-confusions)。

**工程中的样子**：[隧道、WebSocket 与帧拦截](/core/tunnel-websocket)里逐帧查看与暂停，前提就是这条连接已经走完 Upgrade；[真机、移动端与远程页面调试](/scenarios/mobile-remote)里的 `frameScript` 也只在这类连接上生效。

### WebSocket 帧（WebSocket Frame）

> 连接升级之后，双方交换的最小数据单元，带操作码与负载长度。

**打个比方**：像改用对讲机后的一句句话。不再有信封和抬头，每句话自带「这是文字还是心跳、说完了没有」的标记；听的人按标记把碎片拼成一句，而不是等到对方挂机才一起听。

**在 Whistle 里**：`lib/socket-mgr.js:291-301` 的 `getReceiver` / `getSender` 通过 `wsParser` 分别构造接收与发送解析器，`lib/socket-mgr.js:303` 起的 `execHandleFrame` 再对每一帧做拦截与改写；`lib/https/index.js:154` 在握手阶段用固定 GUID 生成 `Sec-WebSocket-Accept`，确认双方确实在说 WebSocket。`lib/upgrade.js:175` 把 socket 交给连接管理器后，数据流就从「报文」变成「帧」。

**为什么这样设计**：帧把长连接上的消息切成可独立处理的单元，才能做逐帧抓取、暂停、忽略与注入，而不必缓冲整条会话；代价是代理必须自己维护掩码、分片与合并状态，比解析 HTTP 报文更容易出错。把收发解析器分开，是为了让「看帧」与「改帧」互不干扰。

**容易混淆**：帧 ≠ HTTP 报文，也 ≠ TCP 字节流；帧是 WebSocket 协议层的结构，字节流只是它的载体。与 SSE 的「文本事件」差别见[隧道、WebSocket 与帧拦截](/core/tunnel-websocket)与[辨析篇](/concepts/08-confusions)。

**工程中的样子**：[真机、移动端与远程页面调试](/scenarios/mobile-remote)里在 Frames 面板逐帧查看、用 `enable://ignoreSend` 忽略发送帧（`docs/docs/rules/enable.md`），都是帧级能力的直接用法。

### SSE（Server-Sent Events）

> 服务端向客户端单向推送的文本事件流，基于普通 HTTP 长响应。

**打个比方**：像广播喇叭。喇叭只管一条条往外播，听众不能对着喇叭回话；每播完一条停顿一下，听众就能把这一条单独记下来，不必等广播全部结束。它还是原来那根电线，只是不再挂断。

**在 Whistle 里**：`lib/inspectors/data.js:14` 定义分隔符 `SSE_SEP = Buffer.from('\n\n')`，`:331-355` 的 `handleResBody` 在 `content-type` 为 `text/event-stream` 时置 `isSse`，并调用 `parseFrame(resBody, true, end)` 按空行把持续到达的响应体切成一条条事件；`captureStream` 也因 SSE 被自动打开，实现边收边显示。

```js
// lib/inspectors/data.js:331-355 · SSE 分帧（节选）
if (headers) {
  isSse = util.trimType(headers['content-type']) === 'text/event-stream';
  captureStream = captureStream || isSse;
}
var setResBody = function (end) {
  if (isSse) {
    resBody = parseFrame(resBody, true, end);
  } else {
    resData.body = resBody;
  }
};
```

**为什么这样设计**：SSE 复用 HTTP 与现有缓存、鉴权、压缩设施，只需服务端不结束响应即可推送，比另开协议轻；代价是单向、只能传文本，且代理若按「完整响应」处理会一直等不到结束标记。Whistle 因此单独识别 `text/event-stream`，把它当流切帧而不是当 body 缓存。

**容易混淆**：SSE ≠ WebSocket，前者单向文本、走普通 HTTP，后者双向、走 Upgrade 后的帧；SSE 也不是 chunked 的别名，它只是常常借助分块传输。对照见[辨析篇](/concepts/08-confusions)。

**工程中的样子**：[抓包数据的采集与上报](/core/capture-data)里流式显示的长响应，以及[弱网与异常注入](/scenarios/fault-injection)里对推送接口加延迟，都要先确认这条响应被识别为 SSE，否则界面会一直空着等结束。

### TCP 字节流（TCP Byte Stream）

> 连接建立后最原始的形态：只有先后顺序，没有报文边界。

**打个比方**：像一根连续的水管。水一直流，管道不替你标出「这一杯到哪里结束」；要分杯，得由接水的人自己按事先约定的刻度去量。所有 HTTP 报文、TLS 记录、WebSocket 帧，都是人为在这根水管上刻出来的刻度。

**在 Whistle 里**：`lib/https/index.js:1117-1119` 的三个正则正是对第一包字节做「这是什么刻度」的探测，`lib/https/index.js:1186` 与 `:1231` 据此分流 HTTP/1.x、HTTP/2 preface 与 CONNECT；`lib/https/index.js:1013-1100` 的 `toHttp1` 把 h2 流重新格式化成 HTTP/1.x 请求再交给主链路。至于 CONNECT 之后的纯透传，则由 `lib/tunnel.js:75` 的 `tunnel://` 表示一条尚未被解析的字节通道。

```js
// lib/https/index.js:1117-1119,1186 · 首包探测（节选）
var HTTP_RE = /^(\w+)\s+(\S+)\s+HTTP\/1.\d$/im;
var HTTP2_RE = /^PRI\s\*\s+HTTP\/2.0$/im;
var CONNECT_RE = /^CONNECT$/i;
var isHttp = chunk && HTTP_RE.test(headersStr);
var isHttpH2 = HTTP2_RE.test(headersStr);
```

**为什么这样设计**：TCP 只保证字节有序到达，把「消息边界」交给上层定义，才能同时承载 HTTP、TLS、WebSocket 等完全不同的协议；代价是代理必须靠首包特征猜协议，猜错就会把报文当乱码或把加密数据当明文。Whistle 把探测集中在入口，一旦确定形态就转成统一的内部请求对象，后续环节不再碰原始字节。

**容易混淆**：字节流 ≠ 报文，也 ≠ 帧；「代理看不到内容」说的是它选择不解析字节流，而不是连接上没有数据。与隧道、解密的关系见[CONNECT 判定与 TLS 解密](/core/connect-mitm)与[辨析篇](/concepts/08-confusions)。

**工程中的样子**：[隧道、WebSocket 与帧拦截](/core/tunnel-websocket)里 `enable://inspect` 让 TUNNEL 条目显示内容，本质就是重新为这段字节流加上解析层；[能力边界与风险](/scenarios/boundaries)里讨论的「抓不到明文」，也根源于这一层。

## 次要词条速览

以下十条只对齐称呼；完整卡片见上文，成对辨析去[辨析篇](/concepts/08-confusions)。

::: cols 20|30|28|22
| 名词 | 一句话 | 源码落点 | 易混淆 |
|---|---|---|---|
| 管线化 | 同连接连发多个请求 | `lib/util/common.js:53` | 与多路复用 |
| h2c | 明文 HTTP/2 升级 | `lib/https/h2.js:369` | 与 h2 |
| Trailer | 报文尾部的补充头 | `lib/https/index.js:1060` | 与 Header |
| Range/206 | 分段请求与部分响应 | `lib/util/common.js:46` | 与完整 200 |
| Cookie/Set-Cookie | 请求携带与响应下发 | `lib/util/common.js:43` | 与鉴权头 |
| CORS 预检 | OPTIONS 探测跨域许可 | `lib/handlers/file-proxy.js:250` | 与实际请求 |
| DNS/A/AAAA | 域名解析到 IP 地址 | `lib/rules/index.js:273` | 与 host 映射 |
| host 映射 | 规则改写目标主机 | `lib/util/common.js:1250` | 与 DNS |
| h2 空闲超时 | 客户端 1 分钟不用即关闭 | `lib/https/h2.js:13` | 与缓存头 |
| 缓存头 | `cache-control` 等策略 | `lib/util/common.js:39` | 与 TTL |
:::

表里的落点集中在两处：`lib/util/common.js:35-54` 的禁入 Trailer 字段清单一次覆盖了 Cookie、Range、缓存头与逐跳字段；`lib/https/` 下的 h2 与降级逻辑则覆盖 h2c、Trailer 与连接空闲超时。`CORS 预检` 的 OPTIONS 处理不在清单里，而在 `lib/handlers/file-proxy.js:250`。按文件簇回查，比逐词搜更省力。

## 与工程实际结合

把这些词条放进一个现场：某接口偶发返回旧数据，前端又要在后端未就绪时先跑通页面，还要验证弱网下缓存与超时是否按设计生效。于是同一组规则里同时出现报文边界（`resBody`）、编码与长度（代理自动删 `content-length`）、缓存头（`cache://`）、协议版本（`enable://h2`）四类概念。完整用法见[弱网与异常注入](/scenarios/fault-injection)与[接口未就绪：Mock 与契约先行](/scenarios/mock-contract)，手机侧的验证见[真机、移动端与远程页面调试](/scenarios/mobile-remote)，协议背景回看[Web 协议与流量形态](/domain/web-protocols)、[一次 HTTP 代理请求的旅程](/core/http-request)与[隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。

```txt
# 来源：docs/docs/rules/cache.md、resBody.md、enable.md
# 接口禁用缓存并替换响应体
www.example.com/api/data cache://no-cache resBody://({"status":"mock"})
# 静态资源缓存一天
www.example.com/static cache://86400
# 让 Whistle 到服务器的出站启用 HTTP/2
www.example.com enable://h2
```

这三条规则正好落在三个不同层次：`cache://` 改 Header，`resBody://` 改 Body 并由 `lib/init.js:87-155` 自动处理长度，`enable://h2` 改的是出站协议协商（`lib/https/h2.js:10`）。若发现替换后的响应在浏览器里是乱码或长度报错，先怀疑 gzip 与 `content-length` 的处理顺序，而不是规则写错。

## 常见误解

1. **chunked ≠ gzip**：chunked 是 `transfer-encoding`，描述 body 怎么被分块搬运；gzip 是 `content-encoding`，压缩实体本身，二者可叠加且顺序是「先 dechunk 再 unzip」（`lib/service/util.js:137-146`）。
2. **keep-alive ≠ h2 多路复用**：Keep-Alive 只是同一连接上串行复用、仍有队头阻塞；HTTP/2 用流编号让多个请求交错并发（`lib/https/h2.js:276-278`），对照见[辨析篇](/concepts/08-confusions)。
3. **Upgrade ≠ CONNECT**：Upgrade 把连接升级成 WebSocket 等协议、代理继续按帧解析（`lib/upgrade.js:77-180`）；CONNECT 把连接降级成纯字节管道、代理默认不解析（`lib/tunnel.js:44`）。
4. **SSE ≠ WebSocket**：SSE 是普通 HTTP 长响应上的单向文本事件流，按 `\n\n` 切帧（`lib/inspectors/data.js:14,331-355`）；WebSocket 双向、需要 101 升级并按帧解析。
5. **HTTP/2 伪头 ≠ 普通 Header**：伪头以冒号开头、有固定集合，降级时被显式剔除（`lib/https/index.js:1030-1043`），不能当自定义头随意增删。
6. **删 `content-length` ≠ 丢了 body**：改写 body 前删掉长度声明是为了让底层重新定界（`lib/init.js:150-154`），内容仍在流里；把「长度头消失」当成「响应为空」会误判整条链路。

## 小结

- 报文由请求行/状态行、Header、Body、状态码四部分构成，代理在 `lib/init.js:157-163` 把它包装成可插拔的流。
- 边界有两种：定长 `Content-Length` 与分块 `chunked`；改写 body 必先删长度头（`lib/init.js:87-155`）。
- 内容编码与传输编码分属两层，采集侧按「先 dechunk 再 unzip」解码（`lib/service/util.js:137-146`）。
- Keep-Alive 串行复用，HTTP/2 用伪头与多路复用并发；ALPN 在 TLS 握手里定协议（`lib/https/h2.js:10`）。
- Upgrade/101 之后是帧，SSE 是长响应上的文本事件，二者与 CONNECT 的纯字节透传都不同。
- TCP 字节流没有边界，入口靠 `lib/https/index.js:1117-1119` 的正则探测首包来决定交给哪套解析器。

## 下一步

[《TLS、证书与信任》](/concepts/03-tls)：既然 CONNECT 之后默认只有加密字节流，接下来讲清中间人、CA、根证书、SNI 与证书链，回答 Whistle 凭什么能解密、客户端又凭什么信任它。
