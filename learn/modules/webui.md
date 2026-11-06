---
title: Web 管理界面
description: 从主代理复用、biz 识别层、约定式 CGI 到前端轮询，拆解管理界面的路由与鉴权实现。
---

# Web 管理界面

Whistle 的管理界面没有独立进程，也没有单独的端口默认值：它复用主代理的 Express app，靠一层 `biz` 中间件把「管理流量」从普通代理流量里摘出来。本篇面向要加 CGI、改鉴权或动前端的开发者，按「识别 → 路由 → 鉴权与接口 → 前端与取舍」展开，行号均来自当前分支。

![浏览器到数据缓存的分层链路](/diagrams/webui.svg)
*浏览器请求先经 biz 识别层，再由 express 路由分发到 CGI 或 service 子进程，最终落到本地数据缓存。*

## 复用主代理与 biz 识别层

`lib/index.js:36-44` 创建唯一的 express app，中间件数组里 `'../biz'` 排在 `lib/init.js` 之后、inspectors 之前，因此 Web UI 请求会抢在规则匹配之前被识别。`lib/config.js:72` 把界面根路径定为 `/.whistle-path.5b6af7b9884e1165/`，`biz/index.js:11-22` 据此组装一组正则：`CUSTOM_WEBUI_PATH_RE` 认旧式自定义路径，`PLUGIN_RE` 认 `/whistle.xxx/`，`INTERNAL_APP` 认 `weinre.<port>` / `log.<port>` / `cgi.<port>`，其余靠 `config.WEBUI_HEAD`、`localIpCache` 与 `config.isLocalUIUrl(host)`（`:99-109`）判断本地 UI Host。命中后 `transformUI`（`:24-29`）把请求交给 `handleUIReq`，并改写 `req.url` 去掉前缀（`:137`）。识别逻辑并不只看路径：`biz/index.js:56-97` 先尝试从 `realHostRe` 或 `_whistleInternalHost_` 参数还原真实 Host 写进 `REAL_HOST_HEADER`（`:60-71`），再按 `internalAppRe` 判断是否带端口后缀、设置 `isWeinre` 与 `isProxyReq`（`:72-81`）；`config.isLocalUIUrl(host)` 与 `localIpCache`（`:101-108`）负责本地 IP 直连。`PREVIEW_PATH_RE`（`:13`）命中的预览请求被改写成 `/preview.html`（`:110-113`），`/_/` 与 `/-/` 前缀作为 bypass 去掉（`:115-123`）。这些改写都发生在 `next()` 之前，后续 inspectors 看到的是一个「干净」的界面请求。

```js
// biz/webui/cgi-bin/rootca.js:4-13
module.exports = function(req, res) {
  var type = req.query.type;
  if (type !== 'crt' && type !== 'pem') {
    type = 'cer';
  }
  if (req.query.enableHttps) {
    properties.setEnableCapture(true);
  }
  res.download(getRootCAFile(), 'rootCA.' + type);
};
```

`--uiport` 是正交的一条线：`biz/init.js:5-20` 在 `config.customUIPort` 存在时另起一个 `http.Server` 并 `ui.setupServer(server)`（`:9-10`），监听独立端口；否则直接 `callback()`，界面继续复用主代理。默认单端口的取舍很直接——用户只需配置一个代理地址，不必为管理界面再开防火墙端口。

## 路由表与约定式 CGI

`biz/webui/lib/index.js` 是路由总表，注册顺序即优先级。`app.all('/service/*')`、`/cgi-bin/service/*`、`/cgi-bin/sessions/*`、`/cgi-bin/log/*` 与 `POST /cgi-bin/plugins/install` 统一 `sendToService` 转给 service 子进程（`:421-425`）；`rootca.pro` 虚域名由 `:332-341` 直接返回证书文件；`/whistle.xxx/` 由 `PLUGIN_PATH_RE`（`:448`）匹配后转发到 `ports.uiPort`（`:473-481`）；`/rules`、`/values` 返回纯文本（`:563,587`），`/web-worker.js` 返回 Worker 脚本（`:592`）。`/weinre/*` 在 `:680-685` 去掉前缀后转发。除约定式接口外还有少量直接注册的路由：`app.post('/cgi-bin/composer', ...)`（`:540`）构造并发出自定义请求，`:545-548` 把 `compose-data`、`saved/*`、`temp/*`、`history` 转给 service 子进程，`IMPORT_CGI`（`:513-532`）把远程 URL 改写成临时文件读取。它们不适合放进约定式目录，因为要复用上传解析或先做 URL 改写。

最值得注意的是约定式 CGI：路径直接映射到文件名，没有集中式的路由清单。

```js
// biz/webui/lib/index.js:387-402
function cgiHandler(req, res) {
  if (common.existsUpPath(req.path) || !checkInternalPath(req)) {
    return res.status(403).end('Forbidden');
  }
  if (checkAllowOrigin(req)) {
    res.setHeader('access-control-allow-origin', req.headers.origin);
    res.setHeader('access-control-allow-credentials', true);
  }
  var filepath = path.join(__dirname, '..' + req.path) + '.js';
  var handleResponse = function() {
    try {
      require(filepath)(req, res);
    } catch(err) {
      sendError(res, err);
    }
  };
```

```js
// biz/webui/lib/index.js:602-607
app.all('/cgi-bin/*', function(req, res, next) {
  req.isUploadReq = UPLOAD_URLS.indexOf(req.path) !== -1;
  return req.isUploadReq ? uploadUrlencodedParser(req, res, next) : urlencodedParser(req, res, next);
}, function(req, res, next) {
  return req.isUploadReq ? uploadJsonParser(req, res, next) : jsonParser(req, res, next);
}, cgiHandler);
```

`cgiHandler` 把 `/cgi-bin/rules/add` 拼成 `cgi-bin/rules/add.js` 并调用其 `module.exports(req, res)`（`:395-398`），`require.cache` 命中就直接执行，否则先 `getStat` 确认文件存在（`:403-418`）。收益是新增接口只需放一个文件，不必改路由表；风险是路径來自用户输入，因此 `common.existsUpPath(req.path)` 与 `checkInternalPath(req)`（`:388`）构成白名单式防线，专门挡目录穿越。首页由 `:643-663` 预压缩 `indexHtml` / `indexJs` 并带 ETag 与 `max-age=300` 返回；静态资源交给 `express.static(htdocs, { maxAge: 600000 })`（`:699`）。首页缓存是预计算的：`:643-645` 用 `zlib.gzipSync` 生成 `gzipIndexHtml` / `gzipIndexJs`，`:646-655` 比对 `if-none-match` 命中即返回 304，否则带 `max-age=300` 的 gzip 内容；`:662-673` 在调试模式下改用 `injectHtml` 注入脚本。跨域与上传另有两张清单：`UPLOAD_URLS`（`:47`）决定走哪个 body parser，`CORS_PATHS` / `ALLOW_CROSS_URLS`（`:44,48-49`）配合 `checkAllowOrigin`（`:391-394`）控制响应头。

## 认证与 CGI 接口

鉴权挂在路由之前：`loadAuthPlugins`（`biz/webui/lib/index.js:21,262`）允许插件接管登录，`verifyLogin`（`:154-193`）依次比对 Cookie 中的登录键、Basic / `proxy-authorization` 头以及查询参数，`checkAuth`（`:195-210`）失败则 `requireLogin`；`config.guest`（`:155-164`）提供只读 guest 身份。`DONT_CHECK_PATHS`（`:40-41`）列出免鉴权白名单，含 `server-info`、`rootca`、`status` 与 `/preview.html`，`GUEST_PATHS`（`:42-43`）另列 guest 可写的接口，`ALLOW_PLUGIN_PATHS`（`:39`）单独放行插件界面要读的三个列表接口，避免插件 UI 被完整鉴权挡住。接口表里的 `socket/{data,change-status,abort}` 是三个真实文件，分别对应抓包数据、状态切换与中止连接；`get-data.js` 还会在响应里带上 `disabledPlugins`（`biz/webui/cgi-bin/get-data.js:50`），前端 `data-center.js:922-928` 的 `checkDataChanged` 正是比对 `mrulesClientId` / `mrulesTime` 与 `mvaluesClientId` / `mvaluesTime` 两组标记，决定只刷新规则还是只刷新 Values。插件状态共用同一套 CGI：`cgi-bin/plugins/status.js:17` 依据 `disabledPlugins` 给每个插件标 `selected`，`disable-plugin.js:14-18` 负责写回，界面上的启用开关因此无需刷新整页。

::: cols 26|34|40
| 接口 | 用途 | 实现 |
|---|---|---|
| get-data | 抓包主数据 | get-data.js |
| init | 初始化配置 | init.js |
| get-session | 会话详情 | get-session.js |
| get-frames | WebSocket 帧 | get-frames.js |
| get-matched-rules | 命中规则 | matched-rules.js |
| rules/* | 规则增删选 | cgi-bin/rules/ |
| values/* | Values 管理 | cgi-bin/values/ |
| plugins/* | 插件状态 | cgi-bin/plugins/ |
| certs/* | 证书上传 | cgi-bin/certs/ |
| socket/* | 会话状态 | cgi-bin/socket/ |
| rootca | 下载根证书 | rootca.js |
| create-cert | 打包证书 | create-cert.js |
| composer | 构造请求 | lib/index.js:540 |
:::

前端 `biz/webui/htdocs/src/js/data-center.js:88-94` 定义 `CGI_URL = 'cgi-bin/'` 与 rules / values / plugins / certs / service / socket 六组前缀，`:444-450` 列出 `getData`、`getLogs`、`getInitial`、`getMatchedRules` 四个取数接口；`cgi.js:61` 的 `$.ajax(opts)` 封装统一处理 auth 参数、排队与 abort。服务端 `config.setModified`（`lib/config.js:1126`）打的版本标记，最终由 `data-center.js:903` 的 `checkDataChanged` 比对决定是否重拉。

两个同名文件要分清：上面的 `checkDataChanged` 与 100 / 900 ms 轮询都在浏览器端 `biz/webui/htdocs/src/js/data-center.js`，而 `lib/service/data-center.js:8` 是 service 子进程的抓包缓存，`MAX_COUNT = 100` 限制缓存条数，二者分处前后端、不共享代码。抓包缓存容量还受 CLI 参数影响：`docs/docs/cli.md:47-48` 标注 `--reqCacheSize` 默认 600、`--frameCacheSize` 默认 512，`lib/util/data-server.js:10-16` 又对二者设了强制下限（`reqCacheSize < 600` 抬到 600、`frameCacheSize < 720` 时设为 600），所以命令行标注的默认值与运行时实际生效值未必一致，排查缓存问题时以 `config.reqCacheSize` 为准。

## 前端栈、weinre 与轮询取舍

前端是 webpack 1 打包的 React 应用：根 `package.json:80-115` 的 devDependencies 固定 React 15 / react-dom 15 / react-virtualized 9 / jQuery 4 / Bootstrap 3 / CodeMirror 5 与 Babel 6，`npm run dev` 即 `webpack --config ./biz/webui/htdocs/src/webpack.config -w`（`package.json:68`）。入口 `biz/webui/htdocs/src/js/index.js:1-19` 引入样式与各组件，`index.js:75` 定义四 Tab `['network','rules','values','plugins']`，`:4869` 把 `<Index />` 挂到 `#container`；构建产物 `biz/webui/htdocs/js` 被 `.gitignore` 排除，仓库里只见源码；界面运行时加载的是构建后的 `js/index.js`，而服务端 `biz/webui/lib/index.js:609-673` 同时保留 `/preview.html` 与首页注入钩子，使同一份 HTML 能按查询参数切换内嵌模式。

weinre 与 `log://` 是两条注入线：`biz/weinre/index.js` 用 `pfork.fork` 拉起 `biz/weinre/server.js`，后者调 `weinre2.run` 并回传端口；`lib/inspectors/weinre.js:17` 把 `target-script-min.js` 注入 HTML。`log://` 由 `lib/inspectors/log.js:6-8` 注入 `assets/js/log.js`，该脚本覆盖 `window.console`（`assets/js/log.js:10`）把日志回传到界面。

最后是抓包数据为何用短轮询而非 WebSocket：`data-center.js:1157-1159` 依据 `hasNew` 决定下一次 100 ms 还是 900 ms 再拉。

```js
// biz/webui/htdocs/src/js/data-center.js:1157-1159
    cgi.getData(options, function (data) {
      var hasNewData = data && data.data && data.data.hasNew;
      setTimeout(load, hasNewData ? 100 : 900);
```

短轮询实现简单、响应可 gzip、弱网下由客户端控制节奏、且与所有 CGI 同源共用鉴权与缓存；长连接虽能省掉空请求，却要单独处理断线重连、背压与跨域。对调试工具而言，100 / 900 ms 两档自适应已足够接近实时，这是刻意选择的复杂度下限。同理，界面把「增加接口」压缩成「放一个文件」，却把路径安全责任集中到 `existsUpPath` 与 `checkInternalPath` 两处；这类约定优于配置的取舍，贯穿整个 Web UI 层。

## 小结

- 界面默认复用主代理的 express app，`biz/index.js` 靠路径正则与本地 Host 识别管理流量，`--uiport` 才另起端口。
- `/cgi-bin/*` 是约定式路由：路径映射到同名 `.js` 的 `module.exports(req,res)`，`existsUpPath` 防目录穿越。
- `loadAuthPlugins`、`verifyLogin` 与 `DONT_CHECK_PATHS` 组成鉴权，Cookie、Basic、guest 三种身份并存。
- 前端为 webpack 1 + React 15 的四 Tab 应用，构建产物不入库；抓包靠 100 / 900 ms 自适应短轮询。
- weinre 与 `log://` 通过 pfork 子进程与脚本注入接入，是同一套界面上的旁路能力。

## 下一步

进入 [《工程场景总览》](/scenarios/index)，把前面各层的机制放回真实工程问题里：从场景出发，向上追溯设计思想，向下定位到具体源码。
