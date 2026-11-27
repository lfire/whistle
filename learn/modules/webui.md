---
title: Web 管理界面
description: 从主代理复用、biz 识别层、约定式 CGI 到前端轮询，拆解管理界面的路由与鉴权实现。
---

# Web 管理界面

Whistle 的管理界面没有独立进程，也没有单独的端口默认值：它复用主代理的 Express app，靠一层 `biz` 中间件把「管理流量」从普通代理流量里摘出来。本篇面向要加 CGI、改鉴权或动前端的开发者，按「识别 → 路由 → 鉴权与接口 → 前端与取舍」展开，行号均来自当前分支。前面 [《插件系统》](/modules/plugins) 讲清了第三方能力如何通过 [ports 表](/concepts/07-extension) 与 CGI 暴露出来、[《抓包数据的采集与上报》](/core/capture-data) 讲清了会话与帧如何被采集进有界缓存、并以 100 / 900 ms 短轮询经独立 cgi 接口上报，但「浏览器上那些按钮和数据，究竟怎么找到对应接口、怎么被允许访问、又怎么刷新出来」还没交代；本篇就补上浏览器这一侧，读完你能加 CGI、改鉴权或动前端。

::: tip 先修知识
先做 [第 0 站](/guide/quickstart)：本篇讲的是你在 Rules 与界面背后动过的那套机制。

若某个名词卡住，按主题回查 [概念精解总览](/concepts/index) 与 [《全量术语索引》](/concepts/glossary)；正文在术语首次出现处也给了对应链接。

不要求预先读过 Whistle 源码，但知道「浏览器与服务端靠 HTTP 接口通信」会更轻松。

给不熟悉界面的读者补一句：这里的「管理界面」不是另一个网站，而是跑在代理同一个端口上的一批特殊路径；浏览器访问 `/.whistle-path.5b6af7b9884e1165/` 之类的地址时，请求会先被 biz 层认出来、再交给 CGI 处理，和真正被代理的业务流量走的是两套待遇。

再补一个容易混的点：本篇反复出现的 `data-center.js` 有两个，一个在浏览器源码里管轮询，一个在 service 子进程里管抓包缓存；读到点破「二者分处前后端、不共享代码」之前，先记住「同名 ≠ 同一份」会省去不少困惑。
:::

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

**输入 → 动作 → 输出**：输入是打到主端口的一个请求；`biz` 中间件排在 inspectors 之前，先用路径正则（`CUSTOM_WEBUI_PATH_RE` / `PLUGIN_RE` / `INTERNAL_APP`）与本地 Host 判断「这是不是管理流量」，命中就 `transformUI` 交给 `handleUIReq` 并改写 `req.url` 去掉前缀，还从 `realHostRe` / `_whistleInternalHost_` 还原真实 Host 写进 `REAL_HOST_HEADER`；输出是后续 inspectors 看到的一个「干净」的界面请求。

**为什么这样设计**：把界面识别放在规则匹配之前，是为了让管理流量「抢在规则之前被摘出来」——否则一条改写规则可能把 `/cgi-bin/...` 也当成普通代理请求转发出去。`--uiport` 是正交的一条线：只有 `config.customUIPort` 存在时才另起 `http.Server` 并 `ui.setupServer(server)`，否则直接 `callback()` 继续复用主代理；默认单端口让用户只需配一个代理地址，不必为界面再开防火墙端口。

**代价与边界**：识别逻辑并不只看路径，还要靠 `isLocalUIUrl(host)` 与 `localIpCache` 判断本地 IP 直连，因此「用非预期 Host 访问」或「反向代理后再转发」都可能认不出来；`PREVIEW_PATH_RE` 改写成 `/preview.html`、`/_/` 与 `/-/` 作 bypass 去掉前缀，这些改写都发生在 `next()` 之前，边界是「一旦放行到 inspectors，就再没有第二次界面识别机会」。所有界面流量和代理流量共用一个端口，也意味着端口层的访问控制无法把两者分开。

**打个比方**：`biz` 像写字楼前台的迎宾位，客人一进门先问「是来办事还是找公司」——办事的（管理流量）直接领到侧门改好门禁卡，找公司的（代理流量）才放进主电梯；迎宾位必须站在电梯之前，否则人混进去了就分不清了。

**自己验证**：对照那段装配顺序——`'../biz'` 排在 `lib/init.js` 之后、inspectors 之前，再看 `rootca.js` 这个 CGI 例子：`res.download(getRootCAFile(), 'rootCA.' + type)` 前还顺手 `properties.setEnableCapture(true)`；不用打开浏览器就能确认「界面请求先被识别、且 CGI 就是一个普通函数」这两件事。

**把结论展开**：为什么识别逻辑要在 `next()` 之前把 `req.url` 改「干净」？因为后面的 inspectors 与规则匹配都按「一个普通 HTTP 请求」来写，若界面前缀 `/.whistle-path.5b6af7b9884e1165/` 还留在 URL 里，规则就会拿它去匹配、甚至把管理请求当普通代理流量转发出去。把 Host 还原写进 `REAL_HOST_HEADER`、把预览请求改写成 `/preview.html`，都是同一条思路：界面流量在进主链之前先被「翻译」成主链认得的样子。

**和路由段的接口**：这一层只回答「这个请求是不是管理流量」，命中之后交给 `handleUIReq`，至于 `/cgi-bin/*` 具体找哪个文件、`/whistle.xxx/` 转发到哪个端口，全是下一段路由表的事。把「识别」与「分发」拆开，好处是识别规则（路径正则、本地 Host）可以独立调整，不必牵动路由表。

**换个角度看**：`--uiport` 为什么是「正交的一条线」而不是改写默认行为？因为默认复用主代理能省掉一个端口，但企业环境常要求管理界面单独监听；`config.customUIPort` 存在时才另起 `http.Server` 并 `ui.setupServer(server)`，否则直接 `callback()`，等于把「要不要分家」做成一个开关，两条路径共用同一套 biz 识别与路由代码。

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

**输入 → 动作 → 输出**：输入是一个 `/cgi-bin/*` 请求；`app.all('/cgi-bin/*', ...)` 先按 `UPLOAD_URLS` 选 body parser，`cgiHandler` 再用 `common.existsUpPath(req.path)` 与 `checkInternalPath(req)` 挡目录穿越、把 `/cgi-bin/rules/add` 拼成 `cgi-bin/rules/add.js` 并调用其 `module.exports(req, res)`，`require.cache` 命中就直接执行、否则先 `getStat` 确认文件存在；输出是该 CGI 文件写回的响应。

**为什么这样设计**：约定式 CGI 让「路径直接映射到文件名」，新增接口只需放一个文件、不必改路由表，这正是「约定优于配置」的收益；风险是路径来自用户输入，所以白名单式防线（`existsUpPath` / `checkInternalPath`）被集中到 `cgiHandler` 一处，而不是散落在每个 CGI 里。首页预压缩 `indexHtml` / `indexJs` 并带 ETag 与 `max-age=300` 返回，是把「不常变的大文件」的开销提前算好；`if-none-match` 命中即返回 304，省掉重复传输。像 [Composer](/concepts/05-capture) 这类要复用上传解析或先做 URL 改写的接口不适合放进约定目录，才被单独注册成 `app.post('/cgi-bin/composer', ...)`。

**代价与边界**：`require(filepath)` 依赖 `require.cache`，调试时改了 CGI 文件不会立刻生效，得清缓存或重启——这是「零路由表」换来的开发期代价。`sendToService` 把 `/service/*`、`/cgi-bin/sessions/*`、`/cgi-bin/log/*` 与 `POST /cgi-bin/plugins/install` 统一转给 service 子进程，意味着这些接口的行为不在 Web 进程内，排障时要跨进程看。跨域与上传各有清单（`UPLOAD_URLS` / `CORS_PATHS` / `ALLOW_CROSS_URLS`），新增接口若忘了登记，就会走到错误的 parser 或缺 CORS 头。

**打个比方**：约定式 CGI 像按房间号直接找人——`cgi-bin/rules/add` 就是「rules 楼 add 室」，不用查总台名册；但门牌号由访客自己报，所以门口必须有人核对「不许出现 `..`（目录穿越）」，`existsUpPath` 与 `checkInternalPath` 就是这位门卫。

**自己验证**：顺着 `cgiHandler` 读——`path.join(__dirname, '..' + req.path) + '.js'` 再 `require(filepath)(req, res)`；对照 `app.all('/cgi-bin/*', ...)` 里按 `req.isUploadReq` 选 parser 的分支，不用发请求就能确认「路径即文件名、上传走另一套 parser」这两条规则。

**把结论展开**：为什么首页要「预压缩」而不是每次请求实时 gzip？首页 HTML / JS 是固定内容，用 `zlib.gzipSync` 在启动时算好 `gzipIndexHtml` / `gzipIndexJs`，之后比对 `if-none-match` 命中就回 304，连压缩都省了；`max-age=300` 又让浏览器五分钟内不再来问。把不常变的大文件的开销提前到启动期，是典型的「以空间换每次请求的延迟」。

**和鉴权段的接口**：`cgiHandler` 只负责「找到文件并执行」，「这个身份能不能调」并不在它里面——鉴权挂在路由之前，由 `verifyLogin` / `checkAuth` 统一挡。所以新增一个 CGI 文件默认就受整套鉴权保护，作者不必在每个文件里重复写登录判断；代价是 `DONT_CHECK_PATHS` 这类白名单必须集中维护，漏登记就会把接口暴露出去。

**换个角度看**：`require.cache` 命中就直接执行，为什么既是收益也是坑？收益是同一个 CGI 文件不必反复读盘解析；坑是调试时改了 `.js` 文件不会立刻生效，得清缓存或重启。约定式路由省掉的那张「集中清单」，在这里变成了「开发期要记得缓存」的隐性成本。

## 认证与 CGI 接口

鉴权挂在路由之前：`loadAuthPlugins`（`biz/webui/lib/index.js:21,262`）允许[插件](/concepts/07-extension)接管登录，`verifyLogin`（`:154-193`）依次比对 Cookie 中的登录键、Basic / `proxy-authorization` 头以及查询参数，`checkAuth`（`:195-210`）失败则 `requireLogin`；`config.guest`（`:155-164`）提供只读 guest 身份。`DONT_CHECK_PATHS`（`:40-41`）列出免鉴权白名单，含 `server-info`、`rootca`、`status` 与 `/preview.html`，`GUEST_PATHS`（`:42-43`）另列 guest 可写的接口，`ALLOW_PLUGIN_PATHS`（`:39`）单独放行插件界面要读的三个列表接口，避免插件 UI 被完整鉴权挡住。接口表里的 `socket/{data,change-status,abort}` 是三个真实文件，分别对应[抓包](/concepts/05-capture)数据、状态切换与中止连接；`get-data.js` 还会在响应里带上 `disabledPlugins`（`biz/webui/cgi-bin/get-data.js:50`），前端 `data-center.js:922-928` 的 `checkDataChanged` 正是比对 `mrulesClientId` / `mrulesTime` 与 `mvaluesClientId` / `mvaluesTime` 两组标记，决定只刷新规则还是只刷新 [Values](/concepts/06-rules)。插件状态共用同一套 CGI：`cgi-bin/plugins/status.js:17` 依据 `disabledPlugins` 给每个插件标 `selected`，`disable-plugin.js:14-18` 负责写回，界面上的启用开关因此无需刷新整页。

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
| rootca | 下载[根证书](/concepts/03-tls) | rootca.js |
| create-cert | 打包证书 | create-cert.js |
| composer | 构造请求 | lib/index.js:540 |
:::

前端 `biz/webui/htdocs/src/js/data-center.js:88-94` 定义 `CGI_URL = 'cgi-bin/'` 与 rules / values / plugins / certs / service / socket 六组前缀，`:444-450` 列出 `getData`、`getLogs`、`getInitial`、`getMatchedRules` 四个取数接口；`cgi.js:61` 的 `$.ajax(opts)` 封装统一处理 auth 参数、排队与 abort。服务端 `config.setModified`（`lib/config.js:1126`）打的版本标记，最终由 `data-center.js:903` 的 `checkDataChanged` 比对决定是否重拉。

两个同名文件要分清：上面的 `checkDataChanged` 与 100 / 900 ms 轮询都在浏览器端 `biz/webui/htdocs/src/js/data-center.js`，而 `lib/service/data-center.js:8` 在 `:99` 用 `slice(0, MAX_COUNT)`（`MAX_COUNT = 100`）裁剪**已保存会话列表**，不是抓包缓存容量，二者分处前后端、不共享代码。抓包缓存容量还受 CLI 参数影响：`docs/docs/cli.md:47-48` 标注 `--reqCacheSize` 默认 600、`--frameCacheSize` 默认 512，`lib/util/data-server.js:10-16` 又对二者设了强制下限（`reqCacheSize < 600` 抬到 600、`frameCacheSize < 720` 时设为 600），所以命令行标注的默认值与运行时实际生效值未必一致，排查缓存问题时以 `config.reqCacheSize` 为准。

**输入 → 动作 → 输出**：输入是一次带 Cookie / Basic / `proxy-authorization` 头或查询参数的界面请求；鉴权挂在路由之前，`loadAuthPlugins` 允许插件接管登录，`verifyLogin` 依次比对登录键、Basic 与查询参数，`checkAuth` 失败则 `requireLogin`，`config.guest` 提供只读身份；放行后 `get-data` 等 CGI 返回抓包主数据，前端 `checkDataChanged` 比对 `mrulesClientId` / `mrulesTime` 与 `mvaluesClientId` / `mvaluesTime` 两组标记，决定只刷新规则还是只刷新 Values；输出是「该身份看得到的、且只重拉变化部分」的界面数据。

**为什么这样设计**：把鉴权放在路由之前，是为了让所有 CGI 不必各自写一遍登录判断；`DONT_CHECK_PATHS` 列出 `server-info`、`rootca`、`status` 与 `/preview.html` 等免鉴权白名单，`GUEST_PATHS` 与 `ALLOW_PLUGIN_PATHS` 再分别放行 guest 可写接口与插件界面要读的三个列表接口，粒度按「谁能看 / 谁能改」分开。插件状态与普通 CGI 共用同一套接口（`status.js` 依据 `disabledPlugins` 标 `selected`、`disable-plugin.js` 写回），界面上的启用开关因此无需刷新整页。

**代价与边界**：Cookie、Basic、guest 三种身份并存，排障时要先分清请求走的是哪一条；`checkDataChanged` 依赖两对版本标记，服务端 `config.setModified` 打戳、前端比对，任一处不同步就会「该刷没刷」。最易踩的边界是抓包缓存容量：CLI 标注的 `--reqCacheSize` 默认 600、`--frameCacheSize` 默认 512，运行时 `lib/util/data-server.js:10-16` 又设了强制下限，命令行标注值与实际生效值未必一致，排查时以 `config.reqCacheSize` 为准。还要分清浏览器端 `data-center.js` 的 100 / 900 ms 轮询与 service 子进程 `lib/service/data-center.js:8` 的抓包缓存同名却分处前后端、不共享代码。

**打个比方**：鉴权像前台先查工牌（Cookie / Basic / guest），不同工牌能进的房间写在三张名单里（免鉴权 / guest 可写 / 插件可读）；进屋后也不把整屋东西搬出来，只按「上次看到的版本号」挑变化的格子补货（两对 ClientId / Time 标记）。

**自己验证**：对照 `::: cols` 接口表数一数 `get-data`、`rules/*`、`values/*`、`plugins/*` 与 `socket/*` 五组，再看 `checkDataChanged` 比对的是 `mrulesClientId` / `mrulesTime` 与 `mvaluesClientId` / `mvaluesTime` 两组标记；不用开界面就能确认「按标记只刷变化部分」这条逻辑。

**把结论展开**：为什么 `get-data.js` 要在响应里带 `disabledPlugins`、`checkDataChanged` 又要比对两对标记？因为界面上规则、Values、插件状态都可能变，但每次全量重拉既浪费又容易打断操作；把「规则」「Values」各打一对 `m*ClientId` / `m*Time` 标记，前端就能精确判断「只刷规则」还是「只刷 Values」，插件开关则靠 `disabledPlugins` 就地切换、连整页都不用刷。

**和前端段的接口**：这一节列出的 `::: cols` 接口表，正是下一段 `data-center.js` 里 rules / values / plugins / certs / service / socket 六组前缀要打的目标；服务端用 `config.setModified` 打版本戳，前端用 `checkDataChanged` 比对决定重拉。两边围绕同一对标记配合，才把「界面上的一次点击」变成「只重拉必要的那部分数据」。

**换个角度看**：为什么要特意点明浏览器端 `data-center.js` 与 service 子进程 `lib/service/data-center.js:8` 是两个同名文件？因为它们一个管轮询节奏、一个管有界抓包缓存，却同名到容易在排障时被当成一处；把「命令行标注的默认值与运行时实际生效值未必一致」也写进来，是提醒排查缓存问题时以 `config.reqCacheSize` 为准，而不是照着 CLI 文档猜。

## 前端栈、weinre 与轮询取舍

前端是 webpack 1 打包的 React 应用：根 `package.json:80-115` 的 devDependencies 固定 React 15 / react-dom 15 / react-virtualized 9 / jQuery 4 / Bootstrap 3 / CodeMirror 5 与 Babel 6，`npm run dev` 即 `webpack --config ./biz/webui/htdocs/src/webpack.config -w`（`package.json:68`）。入口 `biz/webui/htdocs/src/js/index.js:1-19` 引入样式与各组件，`index.js:75` 定义四 Tab `['network','rules','values','plugins']`，`:4869` 把 `<Index />` 挂到 `#container`；构建产物 `biz/webui/htdocs/js` 被 `.gitignore` 排除，仓库里只见源码；界面运行时加载的是构建后的 `js/index.js`，而服务端 `biz/webui/lib/index.js:609-673` 同时保留 `/preview.html` 与首页注入钩子，使同一份 HTML 能按查询参数切换内嵌模式。

weinre 与 `log://` 是两条注入线：`biz/weinre/index.js` 用 [`pfork.fork`](/concepts/07-extension) 拉起 `biz/weinre/server.js`，后者调 `weinre2.run` 并回传端口；`lib/inspectors/weinre.js:17` 把 `target-script-min.js` 注入 HTML。`log://` 由 `lib/inspectors/log.js:6-8` 注入 `assets/js/log.js`，该脚本覆盖 `window.console`（`assets/js/log.js:10`）把日志回传到界面。

最后是抓包数据为何用短轮询而非 WebSocket：`data-center.js:1157-1159` 依据 `hasNew` 决定下一次 100 ms 还是 900 ms 再拉。

```js
// biz/webui/htdocs/src/js/data-center.js:1157-1159
    cgi.getData(options, function (data) {
      var hasNewData = data && data.data && data.data.hasNew;
      setTimeout(load, hasNewData ? 100 : 900);
```

短轮询实现简单、响应可 gzip、弱网下由客户端控制节奏、且与所有 CGI 同源共用鉴权与缓存；长连接虽能省掉空请求，却要单独处理断线重连、背压与跨域。对调试工具而言，100 / 900 ms 两档自适应已足够接近实时，这是刻意选择的复杂度下限。同理，界面把「增加接口」压缩成「放一个文件」，却把路径安全责任集中到 `existsUpPath` 与 `checkInternalPath` 两处；这类约定优于配置的取舍，贯穿整个 Web UI 层。

**输入 → 动作 → 输出**：输入是前端一次 `getData` 调用返回的 `hasNew` 标记；`data-center.js:1157-1159` 依据 `hasNewData` 决定下一次 100 ms 还是 900 ms 再拉；输出是「有变化时近乎实时、无变化时低频空转」的自适应轮询节奏。另一路输入是页面 HTML，weinre 与 `log://` 通过 pfork 子进程与脚本注入把调试能力挂到同一套界面上。

**为什么这样设计**：抓包数据用短轮询而非 WebSocket，是因为短轮询实现简单、响应可 gzip、弱网下由客户端控制节奏、且与所有 CGI 同源共用鉴权与缓存；长连接虽能省掉空请求，却要单独处理断线重连、背压与跨域。对调试工具而言，100 / 900 ms 两档自适应已足够接近实时，这是刻意选择的复杂度下限——把「增加接口」压缩成「放一个文件」，把路径安全责任集中到 `existsUpPath` 与 `checkInternalPath` 两处，是同一套「约定优于配置」的取舍。

**代价与边界**：短轮询在无数据时仍会按 900 ms 发空请求，省掉的是实现复杂度、付出的是这点固定开销；`hasNew` 由服务端数据决定，标记若不准就会「该快不快」。weinre 靠 `pfork.fork` 拉起独立 server、`log://` 靠注入 `assets/js/log.js` 覆盖 `window.console`，两者都是旁路能力，边界是「只作用在注入了脚本的页面上」，且构建产物 `biz/webui/htdocs/js` 被 `.gitignore` 排除、仓库里只见源码，界面运行时加载的是构建后的 `js/index.js`。

**打个比方**：轮询像门卫每隔一会儿探头看一眼信箱——有信就跑得勤（100 ms），没信就歇久点（900 ms）；比起装一条专线（WebSocket）时刻盯着，这套「按有无自适应」的办法设备简单、坏了也容易查。

**自己验证**：对照 `data-center.js:1157-1159` 那三行——`var hasNewData = data && data.data && data.data.hasNew; setTimeout(load, hasNewData ? 100 : 900);`；把 `hasNew` 分别代成 true / false，就能自己推出两档节奏，不用抓包也能确认这段自适应逻辑。

**把结论展开**：为什么 `hasNew` 只决定「下一次 100 ms 还是 900 ms」，而不是「有数据就一直快、没数据就一直慢」？因为抓包是突发性的——一次页面加载会在短时间涌进几十条，随后归于平静；两档自适应让忙时贴近实时、闲时几乎不发空请求。若固定 100 ms，空闲时纯属浪费；若固定 900 ms，密集请求又会明显卡顿。

**这一段的收束**：把整篇串起来看——biz 识别决定「哪些请求是界面」，路由决定「界面请求找哪个文件」，鉴权决定「谁能调」，这一段决定「浏览器用什么节奏把数据刷出来」。四层都跑在同一个 express app 上，正是开篇「没有独立进程、没有单独端口默认值」的落点；weinre 与 `log://` 则证明这套界面还能挂旁路能力而不另起门户。

**换个角度看**：为什么 weinre 靠 `pfork.fork` 拉独立 server、`log://` 靠注入脚本覆盖 `window.console`？因为两者都不改主界面的渲染逻辑，只是「往页面里塞一段东西、把数据送回来」；用子进程与脚本注入这种旁路方式，主应用甚至可以不知道它们的存在。代价是它们只作用在注入了脚本的页面上，且构建产物 `biz/webui/htdocs/js` 不入库，改前端得先跑 `npm run dev` 才能看到效果。

## 常见误解

以下四条都来自本篇最容易读反的结论，尤其头两条关乎「界面到底跑在哪」。

1. **容易以为管理界面跑在独立进程或独立端口上，其实默认复用主代理的 Express app**：只有 `--uiport`（`config.customUIPort`）才另起 `http.Server`；「一个代理地址即可」正是默认单端口的原因，对照见 [《易混淆概念辨析》](/concepts/08-confusions)。
2. **容易以为 `/cgi-bin/*` 有一张集中式路由清单，其实路径直接映射到同名 `.js` 文件**：新增接口只需放一个文件，`require.cache` 命中即执行；代价是路径来自用户输入，必须由 `existsUpPath` 与 `checkInternalPath` 挡目录穿越。
3. **容易以为前端抓包用的是 WebSocket 长连接，其实是 100 / 900 ms 自适应短轮询**：`hasNew` 决定下一次间隔，短轮询与所有 CGI 同源共用鉴权与缓存，是刻意选择的复杂度下限。
4. **容易以为浏览器端的 `data-center.js` 与 service 子进程的抓包缓存是同一份代码，其实二者分处前后端、不共享**：前者管 100 / 900 ms 轮询与 `checkDataChanged`，后者是 `lib/service/data-center.js:8` 裁剪已保存会话列表的上限（`MAX_COUNT = 100`）。

## 小结

- 界面默认复用主代理的 express app，`biz/index.js` 靠路径正则与本地 Host 识别管理流量，`--uiport` 才另起端口。
- `/cgi-bin/*` 是约定式路由：路径映射到同名 `.js` 的 `module.exports(req,res)`，`existsUpPath` 防目录穿越。
- `loadAuthPlugins`、`verifyLogin` 与 `DONT_CHECK_PATHS` 组成鉴权，Cookie、Basic、guest 三种身份并存。
- 前端为 webpack 1 + React 15 的四 Tab 应用，构建产物不入库；抓包靠 100 / 900 ms 自适应短轮询。
- weinre 与 `log://` 通过 pfork 子进程与脚本注入接入，是同一套界面上的旁路能力。
- 本篇为 [《工程场景总览》](/scenarios/index) 准备了「机制已逐层拆完」这个起点：识别、路由、鉴权、CGI 与轮询都已落地，接下来才有条件把每一层放回真实工程问题里追问为什么。

## 下一步

进入 [《工程场景总览》](/scenarios/index)，把前面各层的机制放回真实工程问题里：从场景出发，向上追溯设计思想，向下定位到具体源码。 紧接着读它，是因为到这里 01–17 把「怎么实现」逐层拆完了，接下来要换一个提问方向——从实现转向工程问题：不再问「这个 CGI 怎么路由」，而是问「联调、Mock、弱网、真机、协作这些真实场景下，该动用哪几层机制、为什么这样设计」，场景篇正是从问题反向追溯回这些实现。
