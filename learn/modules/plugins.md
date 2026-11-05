---
title: 插件系统
description: 从命名与发现、pfork 子进程、hook 头通信到插件侧 API，拆解第三方代码接入内核的完整机制。
---

插件是 Whistle 唯一允许第三方代码深度介入请求链路的入口：它既能注册新协议、下发规则与证书，也能全权接管一个 server 或读写管道。代价是必须隔离，因此整套设计围绕「主进程 ↔ pfork 子进程 ↔ 内部 HTTP 端口 ↔ Web UI」四方展开。本篇面向要写插件或改插件框架的开发者，所有机制都给到当前分支的行号。

![主进程、插件子进程、内部端口与 Web UI 的四方关系](/diagrams/plugin-arch.svg)
*主进程按 hook 名把请求打到子进程的内部端口，插件侧再通过同一端口把界面、规则与证书能力暴露给 Web UI。*

## 命名、发现与安装

包名必须匹配 `whistle.[a-z\d_-]+`，允许带 npm scope，判定在 `lib/plugins/util.js:8-10,69-83`：`WHISLTE_PLUGIN_RE` 管裸名，`PLUGIN_NAME_RE` 管带 scope 的全名，`isPluginName` 是统一入口。`package.json` 的 `whistleConfig`（`lib/plugins/get-plugins-sync.js:122`）承载界面与能力声明，简名生成短协议、完整包名生成长协议，可用 `hideShortProtocol` / `hideLongProtocol`（`:175-176`）分别关闭。`get-plugins-sync.js:123-177` 把它展开成一整套字段：`getInspectorTabs` 与 `getCustomTab` 生成 req / res / tool / composer 四类 Tab，`networkColumn` 定制网络列表列，`networkMenus` / `rulesMenus` / `valuesMenus` / `pluginsMenus` 生成右键菜单，`hintList` 提供输入框补全，`staticDir`、`pluginVars`、`priority`、`pluginHomepage` 各司其职；`:184-199` 再把三份规则文件渲染成静态规则文本。命名空间也有保护：`lib/plugins/util.js:132-140` 的 `excludePlugin` 用 `protocols.contains(name)` 拒绝与内置协议同名的插件，避免 `whistle.host` 悄悄覆盖 `host` 指令。

发现路径由 `lib/plugins/module-paths.js:58-88` 组装：Node 原生 `module.paths`、全局 npm 目录、`APPDATA/npm`、`config.baseDir`、`WHISTLE_PLUGINS_PATH` 依次并入，并把 `config.CUSTOM_PLUGIN_PATH`（`:83-86`）设为安装根。`lib/plugins/index.js:36-41` 在启动时用 `getPluginsSync()` 同步扫描一次；此后 `INTERVAL = 6000`（`:36`）驱动 `refreshPlugins()`（`:508-550`）按 path 与 mtime 做增量比对，只发出 install / update / uninstall 差异事件（`:533-535`）。

```js
// lib/plugins/index.js:512-524
      var pluginNames = Object.keys(allPlugins);
      pluginNames.forEach(function (name) {
        var plugin = allPlugins[name];
        var newPlugin = _plugins[name];
        if (!newPlugin) {
          uninstallPlugins = uninstallPlugins || {};
          uninstallPlugins[name] = plugin;
        } else if (
            newPlugin.path != plugin.path ||
            newPlugin.mtime != plugin.mtime
          ) {
          updatePlugins = updatePlugins || {};
          updatePlugins[name] = newPlugin;
```

`refreshPlugins` 收尾还做三件事：`showVerbose` 输出差异（`:526`）、`pluginUtil.resetWorkers` 清理失效的 Web Worker 脚本缓存（`:536`）、`pluginMgr.emit('updateRules')` 让规则引擎重算（`:535`）。`update()`（`:544-550`）在 `inspectMode` 下停掉定时器，保证调试过程不被轮询打断。

安装分两条路径。CLI 的 `w2 install` 进 `bin/plugin.js:124-145`：先建临时目录、写好最小 `package.json`，再 `cp.spawn('npm', ['install', name, ...])`（`:139-145`），参数里带 `--no-package-lock`（`:291`），成功后由 `bin/plugin.js:170` 的 `fs.renameSync` 落到 `custom_plugins/<name>`（`bin/plugin.js:12`）。UI 路径是 `POST /cgi-bin/plugins/install`（`lib/service/service.js:354`），请求经 `biz/webui/lib/index.js:425` 转到 service 子进程，由 `lib/service/install.js:4-13` 监听 `installPlugins` 消息再调同一份 `bin/plugin.js`。卸载只需把目录里的 `package.json` 改名（`lib/plugins/get-plugins-sync.js:115-119`），下次轮询自然识别为消失；禁用不改文件，只写 `properties` 的 `disabledPlugins`（`lib/plugins/index.js:699-700`、`biz/webui/cgi-bin/plugins/disable-plugin.js:14-18`）。`bin/plugin.js:146-180` 还处理失败收尾：npm 退出码非零就删掉临时目录（`:153`）；目标目录已存在时改用 `fse.copySync` 加删除（`:38-41,174-179`）而非直接 rename，避免覆盖用户已装的插件。用轮询而非文件监听，是因为安装可能跨进程、跨网络，mtime 比对足够且实现最简。

## 进程模型

为什么坚持子进程？插件是 npm 上的第三方代码，任何未捕获异常、内存泄漏或阻塞调用都不该带走代理主进程；单端口多 hook 的 HTTP 转发又让主进程不必了解插件的模块结构，只需知道 ports 表。这层隔离的代价是每次 hook 都要一次本地往返，因此规则类 hook 才额外加了 ETag 缓存。

插件不在主进程里 `require`，而是由 `pfork` 按需拉起。`loadPlugin`（`lib/plugins/index.js:620-670`）以 `script` 固定为 `lib/plugins/load-plugin.js`（`:29` 的 `PLUGIN_MAIN`）、`value` 为插件目录路径调用 `p.fork`（`:633-647`）；同一组 script + value 会复用已有进程，ports 表缓存在 `plugin[portsField]`（`:39,624-627,662`），子进程 `close` 时清除（`:663-665`）。

```js
// lib/plugins/index.js:624-640
  var ports = plugin[portsField];
  if (ports) {
    return callback(null, ports);
  }
  util.getBoundIp(config.host, function (host) {
    conf.host = host || LOCALHOST;
    var moduleName = plugin.moduleName;
    var name = moduleName.substring(moduleName.indexOf('/') + 1);
    var isInline = config.inspectMode || process.env.PFORK_MODE === 'inline';
    p.fork(
      {
        data: config.getPluginData(moduleName),
        _inspect: config.inspectMode,
        name: moduleName,
        script: PLUGIN_MAIN,
        value: plugin.path,
```

传给 pfork 的字段也值得一看：`config.getPluginData(moduleName)` 携带插件私有数据，`staticDir` 指向静态目录，`MAX_AGE_HEADER` / `ETAG_HEADER` 把缓存头名一并下发（`:635-647`）；启动结果通过 `proxy.emit('pluginLoad', ...)` 或 `pluginLoadError` 广播（`:654-661`），供日志与界面感知。ports 表共有二十余项，除 auth / sni / ui / rules / tunnel 外，还包含 `upgrade`、`statsPort`、`resStatsPort` 与十二个读写端口（`:1347-1374`），主进程靠 `getPluginReqOpts` 按 hook 类型选端口。

`config.inspectMode` 或 `PFORK_MODE=inline` 会让 pfork 走内联模式（`:632`），便于 `--inspect` 调试；正常模式则完全隔离，插件崩溃不会带走代理主进程。卸载或禁用时由 `p.kill`（`lib/plugins/index.js:678-686`）按同样的 script + value 结束进程，并传入 10000 ms 超时（`:684`）供 pfork 兜底回收；ports 表仍要等 `close` 事件才清除（`:663-665`），两者配合避免重启时复用已失效端口。子进程启动后把监听端口表回传主进程（`lib/plugins/load-plugin.js:1347-1374`），包含 `authPort`、`sniPort`、`uiPort`、`rulesPort`、`resRulesPort`、`tunnelPort` 以及十二个读写 pipe 端口，主进程据此拼出转发目标。

```js
// lib/plugins/load-plugin.js:1347-1358
  var callbackHandler = function () {
    pluginInited = true;
    callback(null, {
      authPort,
      sniPort,
      port: port,
      upgrade: upgrade,
      statsPort: statsPort,
      resStatsPort: resStatsPort,
      uiPort: uiPort,
      rulesPort: rulesPort,
      resRulesPort: resRulesPort,
      tunnelRulesPort: tunnelRulesPort,
```

## 通信：hook 头、内部端口与扩展点

通信的本质是一次普通的内部 HTTP 请求。这些 hook 按能力可分三组：`SNI` / `AUTH` / `HTTP` / `UI` / `TUNNEL` 允许插件全权接管对应的 server 或升级连接；`REQ_RULES` / `RES_RULES` / `TUNNEL_RULES` 只返回规则文本；`REQ_STATS` / `RES_STATS` 与十二个 pipe hook 在数据流上旁路读写。分组决定响应如何被消费：全接管类直接写回客户端，规则类被合并进 `req.rules`，统计与 pipe 类只观察或修改数据流。`lib/config.js:85-108` 的 `PLUGIN_HOOKS` 定义全部 hook 名：`SNI` / `AUTH` / `HTTP` / `UI` / `TUNNEL` / `TUNNEL_RULES` / `REQ_STATS` / `RES_STATS` / `REQ_RULES` / `RES_RULES`，再加 `:96-107` 的十二个读写 pipe hook（req / res / ws / tunnel 各自 read / write）。每个值都拼上 `uid`（`:86-107`），避免多实例间串号。转发前主进程还会调 `addRealUrl` 与 `addSessionInfo`（`lib/plugins/index.js:556-618`）补齐原始 URL 与会话信息，`lib/plugins/compat.js:4-33` 的映射覆盖 `fullUrl`、`reqId`、`_ruleValue`、`host`、`proxy`、`pac`、`method`、客户端 IP 等二十余项，插件几乎能还原完整请求上下文。主进程把 hook 名写进 `x-whistle-plugin-hook-name_`（`lib/config.js:74`），例如 `lib/plugins/index.js:238,831,950`；`lib/plugins/compat.js:40-73` 的 `constsMap` 还把 `fullUrl`、`reqId`、`_ruleValue`、`host`、`proxy` 等上下文映射成一串 `x-whistle-*` 头随请求带上。

`getOptions` 对响应规则做了特殊处理（`lib/plugins/index.js:1077-1086`）：把 `res.headers` 当作请求头、补上 `host` 与 `cookie`，并记下 `req._statusCode`，使插件拿到的上下文与真实响应一致。上下文头并非直接拼进业务头，而是 `lib/plugins/compat.js:94-104` 的 `compatHeaders` 用 `Object.defineProperty` 定义成不可枚举属性（`:75-91`），插件读取得到值，遍历或转发时却不会把内部字段泄漏出去。

`getOptions`（`lib/plugins/index.js:1071-1094`）把目标强制改成 `127.0.0.1` 加对应 hookPort；`requestPlugin`（`:1097-1107`）失败重试 5 次，并把 304 当作缓存命中处理。规则类 hook 还支持 `ETag` / `max-age`：`lib/plugins/index.js:973-1010` 用 `rulesCache` 按插件名与类型缓存 body、values 与 raw，子进程返回 `x-whistle-etag` / `x-whistle-max-age` 时更新，避免每次请求都跑一遍脚本。子进程侧只有单端口 hagent server（`lib/plugins/load-plugin.js:17`，40500 段），按 hook 头分发：

```js
// lib/plugins/load-plugin.js:2012-2024
      server.on('request', function (req, res) {
        delete req.headers['x-whistle-internal-id'];
        switch (getHookName(req)) {
        case PLUGIN_HOOKS.AUTH:
          if (authServer) {
            authServer.emit('request', req, res);
          }
          break;
        case PLUGIN_HOOKS.SNI:
          if (sniServer) {
            sniServer.emit('request', req, res);
          }
          break;
        case PLUGIN_HOOKS.UI:
```

`getHookName`（`lib/plugins/load-plugin.js:851-853`）读完即删该头，插件业务代码看不到内部标记。所有扩展点汇总如下：

::: cols 26|34|40
| 扩展点 | 承载方式 | 关键位置 |
|---|---|---|
| 规则协议 | 长短协议 | util.js:9 |
| 静态规则 | rules.txt 等 | sync.js:185 |
| 动态规则 | rulesServer | load-plugin.js:1903 |
| 证书下发 | sniCallback | load-cert.js:7 |
| 认证 | AUTH hook | config.js:87 |
| 全权接管 | server/tunnel | config.js:88 |
| 读写 pipe | 12 个 hook | config.js:96 |
| 统计 | statsServer | REQ_STATS |
| 界面 | uiServer/staticDir | ports.uiPort |
| 菜单与 Tab | whistleConfig | sync.js:123 |
| 存储 | Storage | load-plugin.js:1147 |
:::

`uiServer` 之外，`whistleConfig` 的 `networkColumn`、各类 menus、Tab 与 `hintList` 在 `get-plugins-sync.js:123-177` 被解析，`staticDir` 配合 `assets/{tab,menu,modal}.html` 决定界面骨架；插件 UI 请求由 `biz/webui/lib/index.js:448-481` 转发到 `ports.uiPort`。动态规则还有一条独立入口：`lib/plugins/index.js:1436-1472` 的 `resolveWhistlePlugins` 把 `rule` 桶与 `plugin` 桶解析成插件名与取值，`pluginMgr.getRules` 再按 `rulesPort` 拉取规则文本，交给 `util.mergeRules` 合并（`lib/inspectors/rules.js:20-24`）；`util.filterRepeatPlugin`（`lib/rules/rules.js:2277`）负责去掉重复插件，避免同一请求反复触发同一个 hook。

## 插件侧 API 与网络闭环

`load-plugin.js` 在调用插件导出函数前，把一组能力挂到 `options` 上：`Storage`、`parseUrl`、`formatHeaders`、`wsParser`、`wrapWsReader` / `wrapWsWriter`、`require`（`:1147-1186`），`storage` / `localStorage` 与 `sharedStorage` 实例（`:1223-1236`），以及 `options.LRU`（`:1381`）。`Storage` 复用 `lib/rules/storage.js` 的持久化实现，`sharedStorage` 落在 `.shared_storage` 目录（`:1223`），因此插件不必自己管落盘。

每次请求进入插件时，`lib/plugins/load-plugin.js:163-165` 也会把 `localStorage`、`Storage`、`sharedStorage` 挂到 `req` 上，`:432-448` 的 `addSessionStorage` 用 `sessionStorage`（`:40` 的 LRU）按 reqId 提供 get / set / peek，插件不必自己维护会话字典。`wsParser`（`:904,970`）提供 WebSocket 帧的 sender / receiver，配合 `wrapWsReader` / `wrapWsWriter` 处理隧道帧；`:1729,1903,2207` 的 `rulesServer`、`resRulesServer`、`tunnelServer` 与 `server.emit('request', ...)` 把动态规则、隧道规则与全接管能力落在同一个 server 上。

反向调用同样走 HTTP：`:1240-1252` 用 `x-whistle-auth-key` 头拼出 `baseUrl`，预置 `/cgi-bin/get-session`、`get-frames`、`custom-frames` 的 `options`，插件可借此取会话与抓包帧。最巧妙的是网络闭环——`lib/plugins/proxy.js:261-285` 劫持 `net.Socket.prototype.connect`，把指向特殊 host 的连接改接到内部临时 server（`:272-284`），于是插件自己发起的 `http.request` 也会绕回主代理、再次经过规则匹配。这样插件既不必知道代理端口，也不会绕过用户配置的规则。劫持范围是可控的：`SPEC_HOST_RE` 只匹配带内部标记的特殊 host（`lib/plugins/proxy.js:265-270`），普通外网连接仍走原始的 `originConnect`（`:266`），不会把插件的全部流量都塞回代理。

## 小结

- `whistle.[a-z\d_-]+` 命名与 `whistleConfig` 决定长短协议与界面能力，搜索路径集中在 `module-paths.js:58-88`。
- 启动同步扫描加每 6 秒按 path / mtime 的增量轮询，安装落 `custom_plugins`，禁用只写 `disabledPlugins`。
- `p.fork` 以 script + value 复用子进程，ports 表缓存在主进程，close 或 `p.kill` 时清理。
- `PLUGIN_HOOKS` 的名称带 uid，经 `x-whistle-plugin-hook-name_` 打到 `127.0.0.1` 的 hookPort，子进程单端口按头分发。
- 规则 hook 用 ETag / max-age 缓存；`Storage`、`wsParser`、`require` 与反向 CGI 构成插件侧 API，劫持 connect 形成网络闭环。

## 下一步

[《Web 管理界面》](/modules/webui)：回到浏览器一侧，看这些 ports 表与 CGI 接口如何被识别、鉴权并渲染成四个 Tab。
