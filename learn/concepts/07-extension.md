---
title: 第五层：扩展机制与工程化
description: 把插件、hook、内部端口、约定式 CGI 与 NPM 模块 API 串成一条可扩展的工程链路。
---

# 第五层：扩展机制与工程化

前四层把一次请求从代理入口一路送到抓包界面，本层回答「这套能力怎样被第三方代码复用与放大」。前置概念是进程隔离、内部 HTTP 转发与 Express 中间件；读完你能独立写出一个最小插件，说清 `w2 install` 之后主进程与插件子进程之间发生了什么，也能把 Whistle 当作 npm 模块嵌进自己的服务。本层不追求新协议知识，而是把散落在 `lib/plugins/`、`biz/webui/` 与 `index.d.ts` 的名词收成一张可回查的词典。

## 本层概念地图

扩展机制可以切成五簇，簇与簇之间以「发现 → 隔离 → 通信 → 呈现 → 复用」为序。下表每格只给锚点，详细定义见后面的完整卡片。

::: cols 22|28|28|22
| 概念簇 | 回答什么问题 | 主源码落点 | 去哪补前置 |
|---|---|---|---|
| 发现与声明 | 插件从哪被找到 | `get-plugins-sync.js` | 插件系统 |
| 隔离与通信 | 第三方代码怎么跑 | `plugins/index.js` | 进程与配置 |
| 能力扩展点 | 能接管哪些阶段 | `load-plugin.js` | 隧道与帧 |
| 界面与鉴权 | 谁有权看数据 | `webui/lib/index.js` | Web 管理界面 |
| 库化与类型 | 如何嵌入别的服务 | `index.d.ts` | 站点导览 |
:::

五簇对应的章节分别是[《插件系统》](/modules/plugins)、[《进程模型与配置系统》](/architecture/process-config)、[《隧道、WebSocket 与帧拦截》](/core/tunnel-websocket)、[《Web 管理界面》](/modules/webui) 与[《站点导览与代码地图》](/guide/orientation)。读卡片时若某个行号对不上，先按函数名回查源码，再回来对照名词，比死记行号稳妥。

## 一、插件本体：发现、声明与隔离

### 插件（Plugin）
> 以独立 npm 包接入、运行在隔离子进程里的第三方扩展。

**打个比方**：像给汽车加装行车记录仪，不拆发动机，只从点烟器取电、靠标准接口通信。记录仪烧了最多少一段录像，车照样能开。
**在 Whistle 里**：`lib/plugins/index.js:36-41` 启动时同步扫描一次，包名须匹配 `whistle.[a-z\d_-]+`（`lib/plugins/util.js:8-10`），此后 `lib/plugins/index.js:508-550` 每 6 秒（`INTERVAL = 6000`，`:36`）按 path 与 mtime 增量比对，只发 `uninstall` / `update` / `updateRules` 差异事件（`:528-530`），新增插件由 `updateRules` 统一触发重编译。
**为什么这样设计**：插件是仓库外的第三方代码，未捕获异常、内存泄漏、阻塞调用都不该带走代理主进程；子进程把故障域缩小到一个插件。代价是每个 hook 都要一次本地 HTTP 往返，所以规则类 hook 才额外加了 ETag 缓存。
**容易混淆**：不是主进程里 `require` 进来的模块，而是 `p.fork` 拉起的独立进程，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：`w2 install whistle.xxx` 装好后写 `xxx://` 规则，见 [插件系统](/modules/plugins) 与 [CI 与自动化](/scenarios/automation)。

### `whistleConfig`（Plugin Manifest）
> `package.json` 里声明界面、菜单与协议能力的配置块。

**打个比方**：像设备的说明书插页，告诉主机「我有几个按钮、要不要进菜单、静态文件放哪」。主机不必拆开设备就能列出功能清单。
**在 Whistle 里**：`lib/plugins/get-plugins-sync.js:122` 读取，`:123-177` 展开成 req / res / tool / composer 四类 Tab、网络列、四组右键菜单、补全词表与 `staticDir`；`docs/docs/extensions/dev.md:637` 给出 `noOption` 的配置样例。
**为什么这样设计**：把能力声明放进清单，扫描阶段就能建好索引，不必先启动插件进程再问一遍；代价是清单变更要等下一次轮询才生效。
**容易混淆**：它是静态声明，不是运行时代码；改它不会执行任何插件逻辑。
**工程中的样子**：在包里配置 `inspectorsTab` 增加详情 Tab，见 [Web 管理界面](/modules/webui) 与 [协作配置](/scenarios/collab-config)。

### 长短协议（Short / Long Protocol）
> 同一插件按简名与完整包名生成的两种规则协议名。

**打个比方**：像同一个人既有工牌简称又有身份证全名，两个名字都能点到人，但全名不会和别人重。
**在 Whistle 里**：`lib/plugins/get-plugins-sync.js:175-176` 的 `hideShortProtocol` / `hideLongProtocol` 可分别关闭；`lib/rules/protocols.js:289-306` 的 `contains` 会拒绝与内置协议同名的插件，避免 `whistle.host` 悄悄覆盖 `host`。
**为什么这样设计**：简名便于手写规则，带 scope 的全名避免同名冲突；代价是主进程要同时维护两套名字到包路径的映射。
**容易混淆**：长协议不是另一个插件，而是同一个包的两个入口。
**工程中的样子**：`whistle.test-rules://` 与 `test-rules://` 指向同一实现，见 [指令体系](/modules/protocol-catalog)。

### `PLUGIN_HOOKS`（Hook 名表）
> 主进程与插件子进程约定的全部内部请求名。

**打个比方**：像总机上的分机号表，来电报出分机名才知道转给哪个部门；分机号本身不携带业务内容。
**在 Whistle 里**：`lib/config.js:85-95` 是 10 个命名 hook，`:96-107` 是 12 个 req / res / ws / tunnel 的 read / write pipe hook，每项都拼上 `uid`。

```js
// lib/config.js:85-107（节选，12 个 pipe hook 以注释代）
config.PLUGIN_HOOKS = {
  SNI: 'sni-' + uid,        AUTH: 'auth-' + uid,
  HTTP: 'http-' + uid,      UI: 'ui-' + uid,
  TUNNEL: 'tunnel-' + uid,
  TUNNEL_RULES: 'tunnel-rules-' + uid,
  REQ_STATS: 'req-stats-' + uid,
  RES_STATS: 'res-stats-' + uid,
  REQ_RULES: 'req-rules-' + uid,
  RES_RULES: 'res-rules-' + uid
  // 另有 12 个 req/res/ws/tunnel 的 read/write hook
};
```

**为什么这样设计**：收发两端共用一份常量表，新增扩展点只改一处；代价是主进程与子进程必须加载同一份 config，版本错位会直接丢请求。
**容易混淆**：hook 名既不是状态码也不是普通业务头，它是内部路由键，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：插件导出 `rulesServer` 就自动接入 `REQ_RULES`，见 [插件系统](/modules/plugins)。

### `uid` 防冲突（Instance Uid）
> 拼在内部头与 hook 名后的实例唯一后缀。

**打个比方**：像同一栋楼里两户人家的门牌加楼层号，快递只写「302」不会送错门。
**在 Whistle 里**：`lib/config.js:29` 用时间戳、`process.pid` 与随机数拼出 `uid`，`:64` 挂到 `config.uid`；`:70-84` 的 `CLIENT_INFO_HEADER`、`SHOW_LOGIN_BOX`、`DISABLE_RULES_HEADER` 等内部头，以及 `:85-108` 的每个 hook 名都带 `+ uid`。
**为什么这样设计**：一台机器常同时跑多个 Whistle 实例或 cluster worker，共用 `127.0.0.1` 内部端口时不加后缀会串台；代价是头名变长，且跨进程必须传递同一个 uid。
**容易混淆**：它不是请求 id，也不随请求变化，而是随进程启动固定，见 [运行时与进程](/concepts/04-runtime)。
**工程中的样子**：多实例用 `--storage` 隔离数据目录时，uid 同步隔离内部头，见 [协作配置](/scenarios/collab-config)。

## 二、通信与端口：隔离之后怎么说话

### ports 表（Ports Map）
> 子进程回传给主进程的一组内部监听端口清单。

**打个比方**：像酒店给每个部门列的内线号码表，总机不关心部门里有多少人，只按号码转接。
**在 Whistle 里**：`lib/plugins/load-plugin.js:1347-1374` 一次性回传二十余项端口；主进程缓存在 `plugin[portsField]`（`lib/plugins/index.js:624-627,662`），子进程 `close` 时删除（`:663-665`），卸载时由 `p.kill`（`:678-686`）按 script + value 结束进程。
**为什么这样设计**：主进程只需知道端口，不必了解插件的模块结构；代价是端口表必须等子进程就绪，首次请求会多一次 fork 等待。
**容易混淆**：这些端口全绑在 `127.0.0.1`，不是对外监听端口，不占用 `port` / `uiport`。
**工程中的样子**：插件崩溃后 ports 缓存失效，下一次请求自动重新 fork，见 [插件系统](/modules/plugins)。

```js
// lib/plugins/load-plugin.js:1347-1372（节选）
callback(null, {
  authPort, sniPort, port, upgrade,
  statsPort, resStatsPort,
  uiPort, rulesPort, resRulesPort,
  tunnelRulesPort, tunnelPort,
  reqWritePort, reqReadPort,
  resWritePort, resReadPort,
  wsReqWritePort, wsReqReadPort,
  wsResWritePort, wsResReadPort
});
```

### `uiPort` / `rulesPort` / `tunnelRulesPort`（三类内线）
> 分别承载插件界面、请求动态规则、隧道动态规则的三个端口。

**打个比方**：像一栋楼里的前台、档案室与货运通道，来客、查档、搬货各走各的门，互不排队。
**在 Whistle 里**：三者在 `lib/plugins/load-plugin.js:1356-1359` 随 ports 表回传；`lib/plugins/index.js:897` 按 `type + 'Port'` 选端口拉规则，`biz/webui/lib/index.js:473-481` 把 `/whistle.xxx/` 转发到 `uiPort`。
**为什么这样设计**：界面流量可能很大且要带 Cookie，规则流量高频且要缓存，隧道规则只在 CONNECT 阶段用，拆开便于各自限流；代价是插件要导出最多三个 server。
**容易混淆**：`rulesPort` 拉的是规则文本，不是 `rules.txt` 静态文件，后者在扫描期已读入，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：`test.example.com whistle.test-rules-server://` 触发动态取规则，见 [Mock 契约](/scenarios/mock-contract)。

### hook 头（Hook Header）
> 主进程写进内部请求、子进程读完即删的分发标记。

**打个比方**：像信封上写的「转财务部」，传达室据此分拣，拆信之后这行字就没用了。
**在 Whistle 里**：头名是 `lib/config.js:74` 的 `x-whistle-plugin-hook-name_`；`lib/plugins/index.js:950` 写入 `options.headers`，`lib/plugins/load-plugin.js:851-853` 的 `getHookName` 读取后立刻 `delete`，`:2012-2031` 用 switch 把请求 `emit` 给对应 server。
**为什么这样设计**：单端口承载全部 hook，靠一个头做多路复用，省掉为每个能力开端口；代价是这个头绝不能泄漏到插件业务代码或上游。
**容易混淆**：它不是 HTTP 普通头，插件作者遍历 `req.headers` 看不到它，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：抓包里看到 `x-whistle-*` 头说明请求还在内部链路，见 [能力边界](/scenarios/boundaries)。

```js
// lib/plugins/load-plugin.js:2012-2031（节选）
server.on('request', function (req, res) {
  delete req.headers['x-whistle-internal-id'];
  switch (getHookName(req)) {
  case PLUGIN_HOOKS.AUTH:
    authServer && authServer.emit('request', req, res);
    break;
  case PLUGIN_HOOKS.SNI:
    sniServer && sniServer.emit('request', req, res);
    break;
  }
});
```

UI 分支还会先 `setContext(req)` 再转发，HTTP / TUNNEL 等分支结构相同。

### pipe（读写管道 Hook）
> 在双向流上旁路读写数据的 12 个扩展点。

**打个比方**：像在输油管上接的取样阀与注入口，油照常往前流，阀门只观察或掺入一点点，不另铺一条管子。
**在 Whistle 里**：`lib/config.js:96-107` 定义 req / res / ws / tunnel 各自的 read / write；`lib/socket-mgr.js:838-843` 用 `pipeStream` 把 `reqRead` / `reqWrite` / `resRead` / `resWrite` 接进两条对称的 Transform 管道。
**为什么这样设计**：流式改写不能等 whole body，只能逐块处理；旁路让插件不影响转发时序。代价是要自管背压与帧边界。
**容易混淆**：`pipe` 是插件 hook，不是 `PipeStream` 这个 npm 依赖，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：`www.example.com pipe://whistle.xxx` 逐块改写响应，见 [隧道与帧](/core/tunnel-websocket)。

## 三、能力扩展点：证书、认证、界面与存储

### `sniCallback`（动态证书回调）
> 握手前由插件决定某域名用哪张证书、要不要解密。

**打个比方**：像门卫在访客报出姓名时，临时决定给他哪张临时通行证，或者直接放行不检查。
**在 Whistle 里**：`lib/https/load-cert.js:7-51` 用 `SNI_CALLBACK_RE` 解析 `sniCallback://` 规则，把结果写入 `remoteCerts`；`lib/https/ca.js:616-624` 的 `SNICallback` 则按 servername 现签叶证书。示例见 `docs/docs/extensions/dev.md:188-235`。
**为什么这样设计**：静态自定义证书无法按请求动态选择，回调把决策权交给插件；代价是每次握手多一次内部往返，必须缓存。
**容易混淆**：`SNICallback`（TLS 回调）与 `sniCallback://`（规则协议）不是同一物，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：`www.example.com sniCallback://test-sni` 只对特定域名换证书，见 [证书排障](/scenarios/https-trust)。

### `auth`（认证的两层含义）
> 既是请求阶段的认证协议，也是插件接管登录的 AUTH hook。

**打个比方**：像大楼既有一张通用的门禁卡规则，也有一个可以完全接管闸机的保安室；前者按名单放行，后者自己定规矩。
**在 Whistle 里**：`lib/config.js:87` 的 `AUTH` hook 对应 `lib/plugins/load-plugin.js:1723,1751-1753` 的 `authServer`（声明与 `createServer()` 创建）；`lib/plugins/index.js:920,936` 的 `authReq` 在取规则前先做认证，失败时按 401 / 407 / 403 拼出拒绝响应。规则里的 `auth://` 属于请求改写，落在 `lib/inspectors/req.js:460-604`。
**为什么这样设计**：把认证放在规则求值之前，未授权请求不必跑插件逻辑；代价是两套 `auth` 名字容易误读。
**容易混淆**：一个是协议、一个是 hook，二者阶段与出口都不同，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：`* auth://user:pass` 是规则写法，`lack init auth` 生成的是 hook 插件，见 [能力边界](/scenarios/boundaries)。

### Storage / sharedStorage（插件存储）
> 注入给插件的持久化键值能力与跨插件共享存储。

**打个比方**：像给每个租户配一个带锁的储物柜，另在大堂放一个公共公告板；柜子私密，公告板谁都能贴。
**在 Whistle 里**：`lib/plugins/load-plugin.js:1147-1186` 把 `Storage`、`require`、`wsParser` 挂到 `options`；`:1223-1236` 建 `.plugins/<name>` 私有目录与 `.shared_storage` 共享文件，`:163-165` 每次请求再把三者挂到 `req` 上。
**为什么这样设计**：插件不该自己管落盘路径，尤其多实例 `--storage` 会改根目录；统一注入避免互相覆盖。代价是共享存储没有隔离，写键名要自行加前缀。
**容易混淆**：`Storage` 是构造函数，`storage` / `localStorage` 是实例，`sharedStorage` 跨插件可见，见 [运行时与进程](/concepts/04-runtime)。
**工程中的样子**：插件用 `options.storage` 保存令牌，见 [插件系统](/modules/plugins)。

### ui tab（插件 Tab）
> 由清单声明、在管理界面顶层打开的插件页面。

**打个比方**：像浏览器新开一个标签页，页面内容完全由扩展提供，与主界面并列显示。
**在 Whistle 里**：`lib/plugins/get-plugins-sync.js:159-163` 生成 req / res / tool / composer 四类 Tab 配置；`biz/webui/lib/index.js:448-481` 按 `PLUGIN_PATH_RE` 把 `/whistle.xxx/` 转发到 `uiPort`；配置样例见 `docs/docs/extensions/dev.md:926-935`。
**为什么这样设计**：Tab 需要独立 URL 才能刷新、分享与鉴权，因此走内部端口而不是内联 HTML；代价是插件必须自己起 `uiServer` 或声明 `staticDir`。
**容易混淆**：ui tab 是浏览器一侧的顶层页面，不是服务端 inspector 页签，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：点插件名打开 Option 页，见 [Web 管理界面](/modules/webui) 与 [协作配置](/scenarios/collab-config)。

### inspector 页签（Inspector Tab）
> 挂在某条抓包会话详情面板里的子页签。

**打个比方**：像病历本里附的一页专科检查单，只针对这一个病人，不单独开一本新病历。
**在 Whistle 里**：`lib/plugins/get-plugins-sync.js:123` 的 `getInspectorTabs` 与 `:159-163` 的 `getCustomTab` 生成配置；请求四阶段 inspector 固定在 `lib/inspectors/index.js:1-8` 的 `rules → req → data → res` 顺序里。
**为什么这样设计**：页签要拿到当前会话的 `reqId` 与上下文，内嵌在详情面板最自然；代价是只能在选中会话后加载。
**容易混淆**：它与 ui tab 分属「会话详情」与「顶层页面」，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：选中一条请求后看插件自定义 Tab，见 [抓包上报](/core/capture-data)。

### weinre（远程调试注入）
> 命中规则后向 HTML 注入调试脚本的旁路能力。

**打个比方**：像给网页悄悄装一个对讲机，页面照常渲染，只是多了一路可被远端连上的调试通道。
**在 Whistle 里**：`lib/inspectors/weinre.js:23-51` 在 `res.on('src')` 里判断响应类型，用 Transform 把脚本插到首块；服务由 `biz/weinre/index.js:11-20` 按需 fork。
**为什么这样设计**：移动端没有 DevTools，注入脚本是唯一低成本入口；代价是要禁用 CSP 与缓存，且只改 HTML / JS 响应。
**容易混淆**：它是注入脚本，不是独立代理端口，见 [抓包与数据面](/concepts/05-capture)。
**工程中的样子**：`m.example.com weinre://test` 后连调试端，见 [真机调试](/scenarios/mobile-remote)。

### log 注入（Log Injection）
> 命中 `log://` 后把日志采集脚本插入响应体。

**打个比方**：像在书页第一页夹一张复写纸，读者照常翻书，写下的内容同时被抄走一份。
**在 Whistle 里**：`lib/inspectors/log.js:26-79` 用 `getScript` 生成脚本、按 `$INTERCEPT_CONSOLE` 决定是否接管 console，再由 `res.addZipTransform` 插到首个数据块；脚本本体是 `assets/js/log.js`。
**为什么这样设计**：把「页面内日志」送到代理界面，只能靠注入；代价是要解压再压缩，并删掉 `content-length`。
**容易混淆**：`log://` 是注入规则，`/cgi-bin/log/*` 是回传接口，见 [Web 管理界面](/modules/webui)。
**工程中的样子**：`m.example.com log://` 后在 Console 面板看日志，见 [真机调试](/scenarios/mobile-remote)。

### Console（页面控制台）
> 被注入脚本接管、把日志回传到界面的 `window.console`。

**打个比方**：像把对讲机的麦克风接到房间广播上，屋里人照常说话，声音同时被录到值班室。
**在 Whistle 里**：`assets/js/log.js:1-18` 用 `window._whistleConsole` 去重并覆盖 `window.console`；开关来自 `lib/inspectors/log.js:46` 的 `interceptConsole`。
**为什么这样设计**：覆盖原生对象能零侵入地捕获 `console.log` 全部参数；代价是必须防重复注入、处理循环引用与序列化。
**容易混淆**：它是浏览器里的对象，不是 Node 进程的 `console`，见 [抓包与数据面](/concepts/05-capture)。
**工程中的样子**：真机页面点一下按钮，日志出现在管理界面，见 [真机调试](/scenarios/mobile-remote)。

## 四、Web UI 的工程化：路由、鉴权与跨域

### 约定式 CGI 路由（Convention CGI）
> 请求路径直接映射到同名 `.js` 文件并调用其导出函数。

**打个比方**：像图书馆按索书号直接找书架，不用先查总目录，号是多少就去第几排第几格。
**在 Whistle 里**：`biz/webui/lib/index.js:387-418` 的 `cgiHandler` 把 `/cgi-bin/rules/add` 拼成 `cgi-bin/rules/add.js` 并 `require(filepath)(req, res)`；`:602-607` 用 `app.all('/cgi-bin/*', ...)` 统一挂 body parser 后接入。
**为什么这样设计**：新增接口只需放一个文件，不必改集中路由表；代价是路径来自用户输入，安全责任全压在校验上。
**容易混淆**：「约定式」不等于「无防护」，目录穿越由 `existsUpPath` 挡住，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：新增 `cgi-bin/xxx/yyy.js` 即可被前端调用，见 [Web 管理界面](/modules/webui)。

### 路径白名单（Path Allowlist）
> 免鉴权、guest 可写与允许跨域的三组路径清单。

**打个比方**：像小区门禁的三张名单：快递免登记、访客只进院子、外来车辆只停指定车位，权限各不相同。
**在 Whistle 里**：`biz/webui/lib/index.js:39-48` 定义 `ALLOW_PLUGIN_PATHS`、`DONT_CHECK_PATHS`、`GUEST_PATHS`、`CORS_PATHS`、`UPLOAD_URLS` 与 `ALLOW_CROSS_URLS`；`:388-389` 的 `checkInternalPath` 与 `existsUpPath` 组成第一道防线。
**为什么这样设计**：把安全边界收敛成几张可审计的数组，比散落在各 CGI 里判断更可靠；代价是新接口忘记登记就会被 403 或失去鉴权。
**容易混淆**：白名单不是「全部放行」，只是跳过特定检查，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：`/cgi-bin/rootca` 免登录下载根证书，见 [证书排障](/scenarios/https-trust)。

### Basic 认证（Basic Auth）
> 用 `Authorization` 头或查询参数核对用户名密码的登录方式。

**打个比方**：像在门口报一次口令，守卫核对无误后给你一张可反复出示的临时贴纸。
**在 Whistle 里**：`biz/webui/lib/index.js:154-193` 的 `verifyLogin` 先比 Cookie 里的登录键，再由 `:178` 的 `parseAuth` 解析 `authorization` / `proxy-authorization` 头与查询参数；`:195-210` 的 `checkAuth` 失败则 `requireLogin`。
**为什么这样设计**：脚本与 CLI 不方便走 Cookie，保留 Basic 让自动化可用；代价是凭据会随请求头出现，必须配合 HTTPS 或本机回环。
**容易混淆**：它只是三种身份之一，另两种是 Cookie 登录与 guest，见 [运行时与进程](/concepts/04-runtime)。
**工程中的样子**：`curl -u user:pass http://127.0.0.1:8899/cgi-bin/...`，见 [CI 与自动化](/scenarios/automation)。

### Cookie / guest 只读（Guest Read-only）
> 用登录 Cookie 识别身份，未登录者降级为受限 guest。

**打个比方**：像正式员工刷卡进全楼，访客只能在一层大厅看公告，既不让进机房也不让改公告。
**在 Whistle 里**：`lib/config.js:426-433` 把 `guestName` / `guestPassword` 折成 `config.guest`；`biz/webui/lib/index.js:155-164` 在未携带 admin 身份时套用 guest，`:42-43` 的 `GUEST_PATHS` 只放行 composer、导出等少数可写接口。
**为什么这样设计**：演示与协作场景需要「能看不能改」，单独建一套权限树太重；代价是 guest 边界靠路径清单维护，新增写接口要复核。
**容易混淆**：guest 不是「无鉴权」，它仍有自己的登录键，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：把只读地址发给同事看抓包，见 [协作配置](/scenarios/collab-config)。

### CORS（跨域资源共享）
> 只对登记过的路径与来源回写跨域响应头。

**打个比方**：像前台只给预约过的外单位开访客条，不是谁递个名片就放行。
**在 Whistle 里**：`biz/webui/lib/index.js:356-373` 的 `checkInternalPath` / `checkAllowOrigin` 判断来源，`:391-394` 命中才写 `access-control-allow-origin` 与 `allow-credentials`；路径清单在 `:44,48-49`。
**为什么这样设计**：管理界面默认同源，只有被嵌入其它页面或本地工具调用时才需要放开；代价是前端跨域请求要带上正确来源头。
**容易混淆**：开了 CORS 不等于免鉴权，两者是独立检查，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：本地构建工具读取 `/cgi-bin/status` 判断代理是否就绪，见 [CI 与自动化](/scenarios/automation)。

### middlewares / uiMiddleware（启动中间件）
> 由配置注入 Express 链的自定义中间件列表，后者只作用于 UI。

**打个比方**：像在总流水线与前台通道各加一道自定义质检工位，前者管所有货，后者只管来访件。
**在 Whistle 里**：`lib/config.js:906-908` 把逗号分隔字符串拆成数组，`:981-982` 逐项 `resolvePath`；`:521` 单独读 `uiMiddleware`；装配点在 `lib/index.js:40-43,51`，均以 `bind(proxyEvents)` 绑定同一事件总线。
**为什么这样设计**：给嵌入式场景留一个不改源码就能插入逻辑的口子；代价是中间件抛错会直接影响请求链。
**容易混淆**：`middlewares` 进主链，`uiMiddleware` 只进界面链，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：`w2 start --middlewares ./audit.js` 做审计，见 [CI 与自动化](/scenarios/automation)。

## 五、把 Whistle 当库用：NPM 模块 API 与类型

### NPM 模块 API（Embedded Mode）
> `require('whistle')` 后在自己进程里启动代理并返回控制对象。

**打个比方**：不是买一台整机，而是把发动机装进自己的车架，方向盘与仪表仍由原厂提供。
**在 Whistle 里**：`index.js:143-148` 导出 `function (options, callback)`，`:150-163` 支持传入已有 `options.server` 并复用其端口；`:221-240` 允许 `config` 以对象、函数、Promise、回调四种形态返回。返回对象由 `lib/index.js:215-241` 装配。
**为什么这样设计**：CI 与内部平台需要把代理和自身服务同端口同生命周期管理；代价是宿主进程崩溃会一起带走代理。
**容易混淆**：它不会像 `w2 start` 那样守护化自启，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：测试脚本里 `require('whistle')({ port: 8899 })`，见 [CI 与自动化](/scenarios/automation)。

### proxyEvents / exportInterfaces（事件总线与导出接口）
> 贯穿中间件的 EventEmitter，以及挂到返回对象上的一组能力。

**打个比方**：像大楼里的广播总线与前台的服务清单，前者负责喊话，后者列明可以叫哪些部门办事。
**在 Whistle 里**：`lib/index.js:45` 创建 `proxyEvents`，`:40-43` 让所有中间件 `bind(proxyEvents)`；`lib/index.js:215-241` 的 `exportInterfaces` 把 `rules`、`util`、`pluginMgr`、`setAuth`、`getRuntimeInfo`、`setShadowRules` 等挂到返回对象。
**为什么这样设计**：同进程内用事件最轻，跨模块能力用显式导出最清楚；代价是事件名是字符串契约，改名要同步所有监听者。
**容易混淆**：`proxyEvents` 是全站总线，`reqEmitter` 是单请求发射器，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：宿主监听 `proxyEvents` 统计请求，见 [CI 与自动化](/scenarios/automation)。

### WhistleOptions / WhistleResult（入参与返回类型）
> TypeScript 描述的启动选项与启动后可用接口。

**打个比方**：像合同的甲方需求清单与乙方交付清单，写清能提什么要求、能拿回什么东西。
**在 Whistle 里**：`index.d.ts:69-145` 列出 `port`、`mode`、`storage`、`shadowRules`、`middlewares`、`certDir` 等选项；`:186-209` 列出 `logger`、`setAuth`、`setUIHost`、`getRuntimeInfo`、`getShadowRules`、`setShadowRules`。
**为什么这样设计**：嵌入式调用方多为 TypeScript 工程，类型即文档；代价是类型与运行时字段靠人工同步。
**容易混淆**：类型声明不产生任何运行时行为，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：`const w = require('whistle')({ port: 8899 })`，见 [CI 与自动化](/scenarios/automation)。

### d.ts（Type Declarations）
> 只给编辑器与编译器看的接口声明文件。

**打个比方**：像产品包装上的规格贴纸，照着贴纸选型号，但贴纸本身不供电、不运转。
**在 Whistle 里**：`index.d.ts:69-145,186-209` 只有 interface 与 type，`:209` 声明默认导出函数签名；真正实现在 `index.js:143-148` 与 `lib/index.js:215-241`。
**为什么这样设计**：把类型与实现分离，JS 用户零负担、TS 用户有补全；代价是声明可能与实现漂移。
**容易混淆**：d.ts 不是运行时代码，删掉它不影响启动，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：TS 项目里获得 `options.port` 补全，见 [源码阅读路线](/advanced/source-reading)。

### mode（运行模式串）
> 用 `|` 分隔、在配置合并期展开成一组布尔开关的字符串。

**打个比方**：像点餐时一次报出「不要辣、多加醋、打包」，厨房把每句拆成一个操作标记，不必为每种组合单列菜名。
**在 Whistle 里**：`lib/config.js:704-720` 按分隔符切开并逐个匹配正则，`:726-760` 把 `agent`、`multiEnv`、`pureProxy` 等折成配置位；`:857-885` 再由 `headless` 与 `shadowRulesMode` 派生 `pluginsOnlyMode` / `networkMode` / `rulesMode`。
**为什么这样设计**：组合爆炸的开关用字符串表达最省配置项；代价是拼错单词会被静默忽略，排查困难。
**容易混淆**：`mode` 是输入串，`shadowRulesMode` 是它派生出的一个状态位，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：`w2 start --mode "pureProxy|multiEnv"`，见 [协作配置](/scenarios/collab-config)。

### shadowRules（影子规则）
> 只存在内存、不落盘、不进用户规则集的临时规则。

**打个比方**：像在白板上临时写的调度指令，擦掉就不留痕，也不写进正式值班表。
**在 Whistle 里**：`lib/config.js:611-646` 支持字符串、数组与对象三种形态，可同时带 `values`；`lib/index.js:231-239` 暴露 `getShadowRules` / `setShadowRules`，后者改完立即 `rulesUtil.parseRules()`；声明见 `index.d.ts:130,200-201`。
**为什么这样设计**：自动化与临时注入需要覆盖规则又不能污染用户配置；代价是进程重启即丢失，且与 `rules` 的合并顺序要小心。
**容易混淆**：它不是落盘规则集，也不出现在界面的 Rules 列表里，见 [易混淆辨析](/concepts/08-confusions)。
**工程中的样子**：CI 里 `w.setShadowRules('* host://stub')` 后跑用例，见 [CI 与自动化](/scenarios/automation)。

## 六、次要词条速览

以下条目不单独展开，用四列速览表收拢；「易混淆」一列给出最短的区分线索，详见 [易混淆辨析](/concepts/08-confusions)。

::: cols 22|28|28|22
| 名词 | 一句话 | 源码落点 | 易混淆 |
|---|---|---|---|
| `w2 install` | 装插件到自定义目录 | `bin/plugin.js:124` | 非 npm 全局装 |
| `w2 uninstall` | 改包名使扫描失效 | `sync.js:115-119` | 非删进程 |
| `w2 exec` | 注入 `.bin` 执行命令 | `whistle.js:132` | 非启动代理 |
| `w2 use` | 加载外部规则文件 | `whistle.js:226` | 非装插件 |
| 自定义证书目录 | 覆盖根 CA 与域名证书 | `config.js:903` | 非下载目录 |
| SAZ / HAR | 会话导入导出格式 | `service.js:30` | 非抓包缓存 |
| Local Agent API | 供外部进程编程调用 | `bin/api.js:1` | 非进程内 API |
| Composer 历史 | 保存手工构造请求 | `webui:548` | 非抓包会话 |
| `disabledPlugins` | 只禁用不卸载 | `plugins:692-700` | 非删目录 |
| `rulesServer` 缓存 | ETag 与 max-age | `plugins:973-1010` | 非静态规则 |
| 12 个 pipe hook | 四类流各读写两端 | `config.js:96` | 非命名 hook |
| `options.server` | 复用已有监听端口 | `index.js:150` | 非新建端口 |
| `setAuth` / `setUIHost` | 运行期改鉴权与域名 | `index.js:224` | 非启动项 |
| `getRuntimeInfo` | 取进程统计对象 | `index.js:228` | 非配置快照 |
| `emudhra` | 兼容特定安卓的公开链 | `ca.js:582` | 非可信凭据 |
:::

第三列是短锚点，省略了 `lib/`、`biz/webui/lib/` 等前缀；完整路径已在前面的卡片与后文给出，也可对照 [速查表](/advanced/reference)。

表中三处值得多看一眼。`rulesServer` 的缓存键是「插件名 + 类型」（`lib/plugins/index.js:974`），子进程回 `x-whistle-etag` / `x-whistle-max-age` 时更新（`:991-1006`），未过 `maxAge` 直接复用缓存（`:1041-1044`），304 也当作命中（`:1103-1104`）。`Local Agent API` 的加载方式是 `w2 root bin/api` 拿到模块路径后再 `require`（`docs/docs/extensions/api.md:1-44`），因此它走命令行通道，与 `lib/index.js:215-241` 的进程内导出是两套入口。`emudhra` 在 `lib/https/emudhra.js` 的注释里明确是公开披露的密钥，只作兼容用途，绝不能当可信凭据。

## 与工程实际结合

把上面的名词落到一条可复制的工作流。官方文档的最小插件从 `rules.txt` 起步（`docs/docs/extensions/dev.md:24-38`），下面的 `package.json` 取自该文的插件命名与 `whistleConfig` 片段，入口代码把同文 `rulesServer` 示例（`:263-281`）改写成 CommonJS 命名导出，以匹配 `lib/plugins/load-plugin.js:1631-1635` 对 `execPlugin.rulesServer` 的识别。

```jsonc
// whistle.test-rules/package.json（来源 docs/docs/extensions/dev.md:24-38, 630-644）
{
  "name": "whistle.test-rules",
  "version": "1.0.0",
  "whistleConfig": { "noOption": true }
}
```

```js
// whistle.test-rules/index.js（来源 docs/docs/extensions/dev.md:263-281，改为 CommonJS）
exports.rulesServer = function (server) {
  server.on('request', function (req, res) {
    res.end('* reqHeaders://x-client=whistle.test-rules');
  });
};
```

```bash
# 安装与验证（来源 bin/plugin.js:124-145、bin/whistle.js:226）
w2 install ./whistle.test-rules
w2 use ./whistle.test-rules/rules.txt
```

三条命令对应三段链路：`w2 install` 由 `bin/plugin.js:139-145` 拉起 `npm install` 并落到 `custom_plugins/`，随后 `lib/plugins/index.js:508-550` 的 6 秒轮询发现它；`w2 use` 把规则文件并进当前规则集；请求命中 `whistle.test-rules://` 时，`lib/plugins/index.js:1436-1472` 的 `resolveWhistlePlugins` 解析插件名，`:891-1035` 按 `rulesPort` 取回规则文本并合并。

三条真实场景线值得对照。其一是自动化：CI 用 `require('whistle')` 启动、`setShadowRules` 注入临时规则、`getRuntimeInfo` 取统计，收尾由宿主进程关闭，见 [CI 与自动化](/scenarios/automation)。其二是协作配置：团队用 `w2 use` 加载共用规则文件、用 guest 只读地址分享界面、用 `disabledPlugins` 收敛各人插件差异，见 [协作配置](/scenarios/collab-config)。其三是真机调试：手机装根证书后，用 `weinre://` 与 `log://` 注入脚本，在 Console 面板看页面日志，见 [真机调试](/scenarios/mobile-remote)。三者分别复用「库化」「清单声明」「注入」三组机制，也说明扩展层不是孤立功能，而是前四层能力的出口。

若只是改插件框架，最短的阅读顺序是 `lib/config.js:63-108`（头与 hook 名）→ `lib/plugins/get-plugins-sync.js:110-213`（发现与声明）→ `lib/plugins/index.js:620-686`（fork 与 kill）→ `lib/plugins/load-plugin.js:1347-1374,2012-2031`（ports 与分发）→ `biz/webui/lib/index.js:387-418,602-607`（约定式 CGI）。这条线把「一个包」变成「一次内部请求」的全过程串起来，配合 [插件系统](/modules/plugins) 与 [Web 管理界面](/modules/webui) 两篇模块深潜，定位问题会快得多。

## 常见误解

- **插件 ≠ 主进程内 require**：`lib/plugins/index.js:633-647` 用 `p.fork` 拉起 `lib/plugins/load-plugin.js`，`config.inspectMode` 或 `PFORK_MODE=inline` 才内联调试（`:632`）。按同进程模块去打断点，断点永远不会命中。
- **hook 头 ≠ HTTP 普通头**：头名来自 `lib/config.js:74`，值带 `uid` 且由 `lib/plugins/load-plugin.js:851-853` 读完即删。若把它当业务头转发到上游，会泄漏内部标记并让对端困惑。
- **ui tab ≠ 服务端 inspector**：前者由 `get-plugins-sync.js:159-163` 声明、走 `biz/webui/lib/index.js:473-481` 的 `uiPort`；后者是 `lib/inspectors/index.js:1-8` 的请求四阶段中间件。名字都有「页签」，一个在浏览器、一个在服务端。
- **pipe ≠ PipeStream**：pipe 是 `lib/config.js:96-107` 的 12 个 hook，落在 `lib/socket-mgr.js:838-843` 的双 Transform；`PipeStream` 是 `pipestream` 依赖，由 `lib/init.js:1,87-155` 提供 `addTextTransform` / `addZipTransform`。两者都可能出现在「改写」讨论里，但层级不同。
- **约定式 CGI ≠ 无安全防护**：`biz/webui/lib/index.js:387-418` 的路径映射确实没有路由表，但 `:388` 的 `existsUpPath` 与 `checkInternalPath`、`:39-48` 的白名单、`:154-210` 的鉴权都在前面挡着。以为「放个文件就能被任意调用」，会漏掉目录穿越与鉴权两类风险。
- **`auth` 既有协议又有 hook 两层含义**：规则里的 `auth://` 属于请求改写（`lib/inspectors/req.js:460-604`），`PLUGIN_HOOKS.AUTH` 属于插件接管登录（`lib/plugins/load-plugin.js:1751-1753`）。查问题时先确认说的是哪一层，否则会找错文件。
- **d.ts ≠ 运行时代码**：`index.d.ts:69-145,186-209` 只有声明，实现在 `index.js:143-148` 与 `lib/index.js:215-241`。改类型不会改变行为，反之加字段不改类型也不会报错。
- **NPM 模块 API ≠ CLI 自启**：`index.js:143-148` 的导出函数不会守护化、不会写 `~/.startingAppData`，生命周期由宿主管理；`w2 start` 的 detached 行为在 `bin/whistle.js`。把二者混用，会出现「脚本退出后代理也没了」或「端口被两个实例抢占」。
- **shadowRules ≠ 落盘规则集**：`lib/config.js:611-646` 只写内存，`lib/index.js:234-239` 的 `setShadowRules` 也不落盘；`lib/rules/util.js:89-99` 的选中 / Default / Mock / Service / Shadow 才是叠加顺序。以为它会出现在界面 Rules 列表里，重启后会发现「规则不见了」。

以上九条都能在 [易混淆辨析](/concepts/08-confusions) 找到成组的对照说明；若只想快速核对数值与常量，可查 [速查表](/advanced/reference)。

## 小结

- 扩展层的地基是隔离：插件以 `p.fork` 子进程运行，主进程只持有 ports 表，靠 hook 头在 `127.0.0.1` 上做多路分发。
- `whistleConfig` 是静态清单，长短协议、Tab、菜单、静态规则文件都在扫描期确定；`rulesServer` 才是每请求的动态规则入口。
- 内部头与 `PLUGIN_HOOKS` 全部带 `uid`，是多实例与 cluster worker 不串台的前提。
- Web UI 用约定式 CGI 换取「放文件即接口」，同时用白名单、Basic / Cookie / guest 与 CORS 四道检查兜住安全边界。
- `index.js` + `lib/index.js:215-241` + `index.d.ts` 让 Whistle 可被嵌入宿主进程，`mode` 与 `shadowRules` 则提供不改源码的运行期调控。
- weinre、`log://`、`assets/js/log.js` 是一组「注入脚本 → 回传界面」的旁路能力，与插件体系并列而非从属。

## 下一步

[《易混淆概念辨析》](/concepts/08-confusions)：把全站近百组形近、名近、阶段近的概念摆在一起对照，逐组给出差别、类比、源码落点、踩坑表现与回查章节。
