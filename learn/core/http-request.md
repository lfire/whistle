---
title: 一次 HTTP 代理请求的旅程
description: 用精确的 16 步链路，串起请求归一化、规则改写、抓包采集、出站与响应回写。
---

# 一次 HTTP 代理请求的旅程

前两篇分别讲清了服务如何监听、配置与进程如何就位。本篇进入全站最核心的一条链路：一个普通 HTTP 代理请求从进入 `request` 事件，到拿到源站响应并回写客户端，中间到底经过哪些模块。全文按 16 个可定位的步骤展开，并合并为七个讲解段；读完你应当能对着源码，把每一步的输入、输出与所在文件一一对应，也能说清请求改写与响应改写各自由哪些规则驱动。

![一次 HTTP 代理请求的 16 步链路](/diagrams/http-request.svg)
*图注：入口归一化后依次经过 init、biz、四个 inspector 与三个 handler，最终由出站请求与响应改写收口。*

## 链路全景：16 步与三段职责

中间件顺序本身写在代码里：`lib/index.js:40-43` 把 `./init`、`../biz`、`require('./inspectors')`、`config.middlewares`、`require('./handlers')` 依次 `app.use`，并用 `bind(proxyEvents)` 让所有中间件的 `this` 指向同一个事件总线。展开后，`lib/inspectors/index.js:1-8` 是 `rules → req → data → res`，`lib/handlers/index.js:1-7` 是 `file-proxy → http-proxy → error-handler`。把这条链按动作切细，就是下面 16 步：

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

## 第一段：入口与归一化（第 1-7 步）

### 从 request 事件到 fullUrl

第 1 步的 `server.on('request', app)` 位置很关键：它写在 `lib/index.js:208-211` 的 `biz/init` 回调里，说明端口虽已监听，但应用要等初始化完成才接请求。进入应用后，`lib/init.js:157` 这个每请求中间件先做流包装与客户端信息解析（第 2-4 步），它给 `req` / `res` 装上的 `addTextTransform`、`addZipTransform`、`res.response` 等能力，是后面所有改写动作的支点。

第 5-6 步由 `biz/index.js` 承担。`util.getFullUrl(req)` 依据 `req.isHttps` 与 `Host` 还原出完整 URL，`biz/index.js:133-163` 再用一组正则识别 Web UI 路径、插件路径、`weinre` 与 `log` / `cgi` 内部应用：命中就 `util.transformReq` 转发到本地端口或直接交给 `transformUI`（`:150,:159`）渲染，未命中才 `next()` 进入规则链。把界面流量挡在用户规则之前，是为了避免管理请求被用户写的 `host` / `path` 规则误伤。

### 分配 reqId 与解析规则

第 7-8 步在 `lib/inspectors/rules.js` 完成。`rules.js:153-160` 先标记请求计数、分配 `reqId`、再次刷新 `fullUrl`，随后 `setupRules`（`:27-45`）依次 `resolveRules`、解析规则文件、合并插件规则、过滤弱规则，最后从 `req.rules.rule` 取出 `ruleUrl` 并落到 `req.options`。

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

## 第二段：改写与采集（第 8-11 步）

### 请求改写由哪些规则驱动

第 9 步 `lib/inspectors/req.js:456-612` 把 `req.rules` 展开成一次具体的改写。它调用 `util.parseRuleJson` 批量求值 `reqHeaders`、`reqCookies`、`auth`、`params`、`reqCors`、`reqReplace`、`urlReplace`、`urlParams`，再叠加 `method`、`reqCharset`、`referer`、`ua`、`reqSpeed` 以及 `reqBody` / `reqPrepend` / `reqAppend`。也就是说，请求侧改写的驱动集合是 `req*` 与 `url*` 系列规则，外加少量无前缀的 `method` / `ua` / `referer`。

改写并非直接替换 Buffer，而是注册 Transform：`req.js:581` 的 `handleReplace` 产出 `ReplaceStringTransform` / `ReplacePatternTransform`，`:589-596` 用 `req.addZipTransform(new FileWriterTransform(...))` 挂上写文件流。这些 Transform 会在请求体真正流过时才执行，因此改写是流式的、与转发并行的。

### 采集对象与响应侧规则

第 10-11 步的 `lib/inspectors/data.js:55-185` 构造一个 `data` 对象，字段涵盖 `id`、`url`、请求与响应元信息、`rules` 以及 `abort` 方法，并在 `:185` 用 `proxy.emit('request', reqEmitter, data)` 把它广播到事件总线。抓包模块不自己收发请求，只订阅这份对象；后续请求发出、响应到达、流结束或中断时，又会由 `reqEmitter` 抛出 `send`（`:430`）、`response`（`:439`）、`end`（`:405`）或 `abort`（`:482`）事件。`data.js:542-551` 随后按 `req.rules.reqDelay` 决定延时多久再 `next()`，这个延时作用在「采集已订阅、改写已注册」之后，因此不会影响抓包对象的创建。

第 12 步的 `lib/inspectors/res.js:190` 定义 `req.request(options)`，`:781` 定义 `res.response(_res)`，二者构成出站与回写的一对入口。响应改写的驱动规则与请求侧对称，来自 `res.js:781-1311` 读取的 `resHeaders`、`resCookies`、`resBody`、`resPrepend`、`resAppend`、`resReplace`、`resCharset`、`resDelay`、`resSpeed`、`resCors`、`replaceStatus`，以及 `htmlBody` / `jsBody` / `cssBody` 按内容类型注入的三组规则。`res.js:1162-1173` 的 `resRules.resDelay` 与 `reqDelay` 遥相呼应，分别卡在回写前后。

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

## 小结

- 16 步链路按「归一化 → 改写采集 → 出站回写」三段推进，顺序由 `lib/index.js:40-43` 与两个 index 固定。
- 请求改写由 `req*` / `url*` 规则驱动，响应改写由 `res*` / `html|js|cssBody` / `replaceStatus` 规则驱动，二者分别落在 `req.js` 与 `res.js`。
- 出站用 `(useHttps ? https : http).request`，连接就绪才 `req.pipe(client)`；响应经 `res.src` 与 `writeHead` 回写，异常由 `error-handler` 兜底。
- `PipeStream` 让改写以 Transform 形式流式插入，解压改写重压缩必须同步删除并重建 `content-length`。
- 抓包 `data` 对象在 `data.js` 构造后广播到事件总线，与改写链并行而不阻塞转发。

## 下一步

[《CONNECT 判定与 TLS 解密》](/core/connect-mitm)：普通 HTTP 走完了，下一篇看 CONNECT 隧道何时被拆开、TLS 首包如何被识别并还原成明文请求。
