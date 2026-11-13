---
title: 插件系统
description: 从命名与发现、pfork 子进程、hook 头通信到插件侧 API，拆解第三方代码接入内核的完整机制。
---

# 插件系统

[插件](/concepts/07-extension)是 Whistle 唯一允许第三方代码深度介入请求链路的入口：它既能注册新协议、下发规则与证书，也能全权接管一个 server 或读写管道。代价是必须隔离，因此整套设计围绕「主进程 ↔ [pfork](/concepts/07-extension) 子进程 ↔ 内部 HTTP 端口 ↔ Web UI」四方展开。本篇面向要写插件或改插件框架的开发者，所有机制都给到当前分支的行号。前面 [《进程模型与配置系统》](/architecture/process-config) 交代了三层进程与配置单例如何共享状态、[《指令体系与分发链路》](/modules/protocol-catalog) 把自定义协议接进了分发链，但「第三方代码凭什么能插进请求链路、又凭什么不会拖垮代理」这个隔离问题一直没展开；本篇就补上它，读完你能写插件、也能改插件框架。

::: tip 先修知识
本篇承接 [《进程模型与配置系统》](/architecture/process-config)（前置 08）与 [《指令体系与分发链路》](/modules/protocol-catalog)（前置 14），需要你已经理解 Whistle 的三层进程与配置单例如何共享状态、一条规则指令如何被解析并分发到请求链路，以及为什么第三方代码不能直接在主进程里 `require`。若对插件、pfork、ports 表、hook、sniCallback、Storage、PLUGIN_HOOKS 这些名词还不熟，可先读 [《概念精解 · 扩展机制与工程化》](/concepts/07-extension)；对「一次请求如何被采集」可查 [《概念精解 · 抓包数据面与帧》](/concepts/05-capture)；对规则文本如何编译命中可查 [《概念精解 · 规则 DSL 全景》](/concepts/06-rules)；对子进程与事件驱动可查 [《概念精解 · Node 运行时与内核骨架》](/concepts/04-runtime)。不要求预先读过 Whistle 源码，但知道「父子进程靠消息或本地端口通信」会更轻松。

给不熟悉插件的读者补一句：插件不是被主进程 `require` 进来的普通模块，而是运行在独立子进程里、通过本地 HTTP 端口与主进程对话的一段第三方代码；主进程手里只有一张「哪个能力对应哪个端口」的表。这正是本篇要先讲清进程隔离、再讲通信的原因。

再补一个容易卡住的点：本篇说的「端口」不是对外监听的代理端口，而是子进程临时占用、只在本机 `127.0.0.1` 上可达的内部端口；主进程和插件靠它对话，外部流量并不会直接打进来。把这两类端口分开，后面读 ports 表时才不会疑惑「为什么一个插件要占二十多个端口」。
:::

![主进程、插件子进程、内部端口与 Web UI 的四方关系](/diagrams/plugin-arch.svg)
*主进程按 [hook](/concepts/07-extension) 名把请求打到子进程的内部端口，插件侧再通过同一端口把界面、规则与证书能力暴露给 Web UI。*

## 命名、发现与安装

包名必须匹配 `whistle.[a-z\d_-]+`，允许带 npm scope，判定在 `lib/plugins/util.js:8-10,69-83`：`WHISLTE_PLUGIN_RE` 管裸名，`PLUGIN_NAME_RE` 管带 scope 的全名，`isPluginName` 是统一入口。`package.json` 的 [`whistleConfig`](/concepts/07-extension)（`lib/plugins/get-plugins-sync.js:122`）承载界面与能力声明，简名生成短协议、完整包名生成长协议，可用 `hideShortProtocol` / `hideLongProtocol`（`:175-176`）分别关闭。`get-plugins-sync.js:123-177` 把它展开成一整套字段：`getInspectorTabs` 与 `getCustomTab` 生成 req / res / tool / composer 四类 Tab，`networkColumn` 定制网络列表列，`networkMenus` / `rulesMenus` / `valuesMenus` / `pluginsMenus` 生成右键菜单，`hintList` 提供输入框补全，`staticDir`、`pluginVars`、`priority`、`pluginHomepage` 各司其职；`:184-199` 再把三份规则文件渲染成静态规则文本。命名空间也有保护：`lib/plugins/util.js:132-140` 的 `excludePlugin` 用 `protocols.contains(name)` 拒绝与内置协议同名的插件，避免 `whistle.host` 悄悄覆盖 `host` 指令。

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

**输入 → 动作 → 输出**：输入是磁盘上的插件目录（`custom_plugins/<name>` 或全局 npm 路径）与其 `package.json` / mtime；启动时 `getPluginsSync()` 同步扫一遍，此后每 6 秒 `refreshPlugins()` 按 path 与 mtime 做增量比对，只发 install / update / uninstall 差异事件，并顺带 `resetWorkers` 清缓存、`emit('updateRules')` 让规则引擎重算；输出是一份稳定的「已装插件清单」和可被规则引用的长短协议。

**为什么这样设计**：命名用 `whistle.[a-z\d_-]+` 加 scope 白名单，是为了让「哪些包是插件」在扫描阶段就能确定，不必加载代码再判断；`whistleConfig` 把界面 Tab、菜单、补全、静态规则等声明集中在一个字段里，等于给框架一张「能力清单」，避免插件靠约定文件名到处散落配置。`excludePlugin` 拒绝与内置协议同名，是防止 `whistle.host` 悄悄覆盖 `host` 指令这类「第三方把内核指令顶掉」的事故。用 6 秒轮询而非文件监听，是因为安装可能跨进程、跨网络，mtime 比对足够且实现最简——代价是装完到被识别最多有 6 秒延迟。

**代价与边界**：增量比对只看 path 与 mtime，因此「改了内容却没变 mtime」或「mtime 精度被文件系统截断」都可能让更新漏报；`inspectMode` 下 `update()` 直接停掉定时器，是调试优先于实时性的取舍。禁用只写 `disabledPlugins`、卸载只把 `package.json` 改名，都属于「软删除」，保留了回退余地，也意味着目录本身没被清理。UI 安装与 CLI 安装最终都汇流到同一份 `bin/plugin.js`，差异只在入口，排障时要意识到你看到的临时目录可能来自任一路径。

**打个比方**：发现机制像门口每隔 6 秒对一次访客名册——只记「谁来了、谁走了、谁换了证件」，没变化就不惊动屋里；名册格式（`whistle.` 前缀 + `whistleConfig`）事先统一，保安不用拆开每个人的包就知道该放行到哪个窗口。

**自己验证**：顺着 `refreshPlugins` 那段代码读——`newPlugin.path != plugin.path || newPlugin.mtime != plugin.mtime` 才进 `updatePlugins`；再对照 `excludePlugin` 用 `protocols.contains(name)` 拒绝同名，不用装任何插件就能确认「按 path / mtime 增量」与「内置协议名受保护」这两条规则。

**把结论展开**：为什么 `whistleConfig` 值得单独一个字段、而不是让插件在代码里 `exports` 出各种约定？因为发现阶段发生在插件**被加载之前**——扫描只看磁盘上的 `package.json`，此时根本不会执行插件代码；界面 Tab、菜单、补全、静态规则这些「没运行插件也得先知道」的信息，只能来自一份静态声明。这也解释了为什么改动只写 `disabledPlugins` 就能禁用：框架根本不需要拉起代码去问它「你支不支持禁用」。

**和安装两条路径的接口**：CLI 的 `w2 install` 与 UI 的 `POST /cgi-bin/plugins/install` 最后都落到同一份 `bin/plugin.js`，所以「谁发起安装」不影响「装成什么样」；`refreshPlugins` 只认目录 path 与 mtime，也就不必区分这次落盘来自哪个入口。把入口差异收在这一层，后面进程模型与通信才只面对一份统一的插件清单。

**换个角度看**：`w2 install` 与 UI 安装为什么都先写一份「最小 `package.json`」再交给 npm？因为发现机制只认 `package.json` 里的 `whistleConfig` 与包名前缀；先把它立起来，等于先给插件办了张「身份证」，之后的轮询扫描才有东西可认。这也是卸载只需把 `package.json` 改名就能生效的原因——抽掉身份证，目录还在，框架却已当它不存在。

## 进程模型

为什么坚持子进程？插件是 npm 上的第三方代码，任何未捕获异常、内存泄漏或阻塞调用都不该带走代理主进程；单端口多 hook 的 HTTP 转发又让主进程不必了解插件的模块结构，只需知道 [ports 表](/concepts/07-extension)。这层隔离的代价是每次 hook 都要一次本地往返，因此规则类 hook 才额外加了 ETag 缓存。

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

**输入 → 动作 → 输出**：输入是「某个插件第一次被某个 hook 调用」；`loadPlugin` 以固定的 `PLUGIN_MAIN` 脚本加插件目录 `value` 调 `p.fork`，同一组 script + value 复用已有进程、把 ports 表缓存在 `plugin[portsField]`，子进程 `close` 时清除；输出是一个隔离的子进程，以及一张「哪个 hook 该打到哪个内部端口」的映射表。

**为什么这样设计**：坚持子进程，是因为插件是 npm 上的第三方代码——未捕获异常、内存泄漏或阻塞调用都不该带走代理主进程；`config.inspectMode` 或 `PFORK_MODE=inline` 才走内联模式，专门给 `--inspect` 调试用，正常模式完全隔离。主进程只认 ports 表、不 `require` 插件模块，让「单端口多 hook 的 HTTP 转发」成为可能：主进程不必了解插件的模块结构，按 hook 类型选端口转发即可。每个 hook 值都拼上 uid，是为了同一台机器跑多个 Whistle 实例时，子进程只匹配本实例 uid 的分支，别处发来的内部请求不会串号。

**代价与边界**：隔离的代价是每次 hook 都要一次本地往返（规则类 hook 才额外加 ETag 缓存来摊薄它）；`p.kill` 传 10000 ms 超时兜底回收，但 ports 表仍要等 `close` 事件才清除，两者配合是为了避免重启时复用已失效端口。边界是「同组 script + value 才复用进程」——两个插件即便代码相同，只要目录不同就是两个子进程，内存开销随插件数线性增长。

**打个比方**：主进程像总机，插件各自在独立的分机房里；总机手里只有一张分机号表（ports 表），来电报出哪个部门（hook 名）就转去哪个分机，从不自己跑进机房干活，也不怕某间机房着火。

**自己验证**：对照 `loadPlugin` 的开头几行——`var ports = plugin[portsField]; if (ports) { return callback(null, ports); }`，再往下看 `p.fork` 传入的 `script: PLUGIN_MAIN` 与 `value: plugin.path`；不用起进程就能确认「同组复用、否则新拉起」这条规则，也能推出 ports 表为什么会缓存在主进程。

**把结论展开**：为什么「同组 script + value 复用进程」而不是「一个插件一个常驻进程」？`loadPlugin` 是按需调用的——只有某个 hook 第一次要找这个插件时才 `p.fork`，之后把 ports 表缓存在 `plugin[portsField]` 直接返回；这样冷门插件不占进程、热门插件也只起一次。代价是「第一次调用」要多付一次拉起开销，`requestPlugin` 的 5 次重试正是为这个未就绪窗口兜底。

**和通信段的接口**：这一段交付的产物是「一张 ports 表 + 一个隔离进程」，下一段的全部机制都建立在它之上——主进程按 hook 类型查这张表选端口，子进程按 hook 头在单端口上分发。换句话说，进程模型回答「代码跑在哪」，通信段回答「怎么把请求送进去」，两者是同一套隔离设计的上下两半。

**换个角度看**：为什么 `p.kill` 之后还要等 `close` 事件才清 ports 表，而不是立刻清？因为「发信号让子进程退出」和「子进程真的退出、端口真的释放」是两件事；若提前把表清了，紧接着到来的 hook 会按旧表转发到一个正在关闭的进程上。`10000 ms` 超时与 `close` 清理配合，正是把「通知」和「确认」分成两步。

## 通信：hook 头、内部端口与扩展点

通信的本质是一次普通的内部 HTTP 请求。这些 hook 按能力可分三组：`SNI` / `AUTH` / `HTTP` / `UI` / `TUNNEL` 允许插件全权接管对应的 server 或升级连接；`REQ_RULES` / `RES_RULES` / `TUNNEL_RULES` 只返回规则文本；`REQ_STATS` / `RES_STATS` 与十二个 pipe hook 在数据流上旁路读写。分组决定响应如何被消费：全接管类直接写回客户端，规则类被合并进 `req.rules`，统计与 pipe 类只观察或修改数据流。`lib/config.js:85-108` 的 [`PLUGIN_HOOKS`](/concepts/07-extension) 定义全部 hook 名：`SNI` / `AUTH` / `HTTP` / `UI` / `TUNNEL` / `TUNNEL_RULES` / `REQ_STATS` / `RES_STATS` / `REQ_RULES` / `RES_RULES`，再加 `:96-107` 的十二个读写 pipe hook（req / res / ws / tunnel 各自 read / write）。每个值都拼上 `uid`（`:86-107`），避免多实例间串号。这串 uid 在 `lib/config.js:29` 由时间戳、pid 与随机数拼出，进程内唯一；`PLUGIN_HOOKS` 的值（`:86-107`）、hook 头名（`:74`）乃至 `CLIENT_ID_HEADER`（`:70`）都带上它，子进程又通过 pfork 的 `config` 字段拿到同一份配置（`:646`），于是同一台机器跑多个 Whistle 实例时，子进程 `switch (getHookName(req))` 只匹配本实例 uid 的 hook 值，别处实例发来的内部请求不会落到自己的分支上。转发前主进程还会调 `addRealUrl` 与 `addSessionInfo`（`lib/plugins/index.js:556-618`）补齐原始 URL 与会话信息，`lib/plugins/compat.js:4-33` 的映射覆盖 `fullUrl`、[`reqId`](/concepts/05-capture)、`_ruleValue`、`host`、`proxy`、`pac`、`method`、客户端 IP 等二十余项，插件几乎能还原完整请求上下文。主进程把 hook 名写进 `x-whistle-plugin-hook-name_`（`lib/config.js:74`），例如 `lib/plugins/index.js:238,831,950`；`lib/plugins/compat.js:40-73` 的 `constsMap` 还把 `fullUrl`、`reqId`、`_ruleValue`、`host`、`proxy` 等上下文映射成一串 `x-whistle-*` 头随请求带上。

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
| 证书下发 | [sniCallback](/concepts/07-extension) | load-cert.js:7 |
| 认证 | AUTH hook | config.js:87 |
| 全权接管 | server/tunnel | config.js:88 |
| 读写 pipe | 12 个 hook | config.js:96 |
| 统计 | statsServer | REQ_STATS |
| 界面 | uiServer/staticDir | ports.uiPort |
| 菜单与 Tab | whistleConfig | sync.js:123 |
| 存储 | [Storage](/concepts/07-extension) | load-plugin.js:1147 |
:::

`uiServer` 之外，`whistleConfig` 的 `networkColumn`、各类 menus、Tab 与 `hintList` 在 `get-plugins-sync.js:123-177` 被解析，`staticDir` 配合 `assets/{tab,menu,modal}.html` 决定界面骨架；插件 UI 请求由 `biz/webui/lib/index.js:448-481` 转发到 `ports.uiPort`。动态规则还有一条独立入口：`lib/plugins/index.js:1436-1472` 的 `resolveWhistlePlugins` 把 `rule` 桶与 `plugin` 桶解析成插件名与取值，`pluginMgr.getRules` 再按 `rulesPort` 拉取规则文本，交给 `util.mergeRules` 合并（`lib/inspectors/rules.js:20-24`）；`util.filterRepeatPlugin`（`lib/rules/rules.js:2277`）负责去掉重复插件，避免同一请求反复触发同一个 hook。

**输入 → 动作 → 输出**：输入是「某类 hook 被触发」这一事件；主进程用 `getOptions` 把目标强制改成 `127.0.0.1` 加对应 hookPort、把 hook 名写进 `x-whistle-plugin-hook-name_` 头，并用 `addRealUrl` / `addSessionInfo` 补齐原始 URL 与会话信息；子进程单端口 server 按 `getHookName(req)` 把请求分发到对应 server / 规则 / pipe 分支；输出按分组不同而不同——全接管类直接写回客户端，规则类合并进 `req.rules`，统计与 pipe 类只观察或修改数据流。

**为什么这样设计**：把通信做成「一次普通的内部 HTTP 请求」，主进程便无需理解插件内部模块结构，只要按 hook 类型选端口；上下文头用 `compatHeaders` 的 `Object.defineProperty` 定义成不可枚举属性，是为了「插件读得到值、但遍历或转发时不会把内部字段泄漏出去」。`getOptions` 对响应规则把 `res.headers` 当请求头、补 `host` 与 `cookie`，则是让插件拿到的上下文与真实响应一致。规则类 hook 支持 ETag / max-age 并用 `rulesCache` 缓存 body，正是为了摊薄「每次请求都跑一遍插件脚本」的本地往返开销。

**代价与边界**：转发前要补齐二十余项上下文（`compat.js` 的 `constsMap`），任何一项映射漏了，插件看到的就是残缺请求；`requestPlugin` 失败重试 5 次、把 304 当缓存命中，是把「子进程可能未就绪」和「缓存协商」都塞进同一条链路，排障时要分清是插件没起还是缓存生效。三组 hook 的分组决定响应如何被消费，边界是「规则类只返回文本、全接管类直接写回」——在只读 hook 里想改响应流是做不到的。

**打个比方**：像公司里按工单类型分发的传达室——工单上盖一个章（hook 头）写明该去哪个科室，传达室不看内容只盖章转发；有的科室直接给访客回话（全接管），有的只在回执上附一行备注（规则），有的只在旁边登记不改信件（统计 / pipe）。

**自己验证**：顺着子进程那段 `switch (getHookName(req))` 代码数一数 `case PLUGIN_HOOKS.AUTH` / `SNI` / `UI` 分支，再对照上面 `::: cols` 扩展点表里的「全权接管」「规则协议」「读写 pipe」三行；不用发请求就能确认「按 hook 头分发、分组决定响应去向」这条主线。

**把结论展开**：uid 为什么必须拼进 hook 值、hook 头名乃至 `CLIENT_ID_HEADER`？因为同一台机器可能跑多个 Whistle 实例，而它们共用的是同一套 `127.0.0.1` 内部端口段；若 hook 值不带实例标识，A 实例发出的内部请求可能被 B 实例的子进程 `switch` 命中，插件就会替别人处理请求。把 uid 由时间戳、pid 与随机数拼出并随 pfork 的 `config` 下发，等于给每条内部请求盖了「只归本实例」的章。

**和插件侧 API 段的接口**：`compatHeaders` 把上下文定义成不可枚举属性、`getOptions` 把目标强制改成 `127.0.0.1`，这两件事一起保证了「插件读得到完整上下文、却不会把内部字段转发到外网」。下一段要讲的 `Storage`、`wsParser` 与反向 CGI，正是插件拿到这份干净上下文之后能进一步做的事——通信层负责「送得进、不泄漏」，API 层负责「拿到了能干什么」。

**换个角度看**：`getHookName` 为什么「读完即删该头」？因为 `x-whistle-plugin-hook-name_` 是主进程与子进程之间的内部约定，插件业务代码若看到它、甚至把它转发到外网，既泄漏内部标记又可能被误当成业务头处理。删头这个动作和 `compatHeaders` 的不可枚举是同一条思路：内部信息只在框架这一层可见。

## 插件侧 API 与网络闭环

`load-plugin.js` 在调用插件导出函数前，把一组能力挂到 `options` 上：`Storage`、`parseUrl`、`formatHeaders`、`wsParser`、`wrapWsReader` / `wrapWsWriter`、`require`（`:1147-1186`），`storage` / `localStorage` 与 `sharedStorage` 实例（`:1223-1236`），以及 `options.LRU`（`:1381`）。`Storage` 复用 `lib/rules/storage.js` 的持久化实现，`sharedStorage` 落在 `.shared_storage` 目录（`:1223`），因此插件不必自己管落盘。

每次请求进入插件时，`lib/plugins/load-plugin.js:163-165` 也会把 `localStorage`、`Storage`、`sharedStorage` 挂到 `req` 上，`:432-448` 的 `addSessionStorage` 用 `sessionStorage`（`:40` 的 LRU）按 reqId 提供 get / set / peek，插件不必自己维护会话字典。`wsParser`（`:904,970`）提供 WebSocket 帧的 sender / receiver，配合 `wrapWsReader` / `wrapWsWriter` 处理隧道帧；`:1729,1903,2207` 的 `rulesServer`、`resRulesServer`、`tunnelServer` 与 `server.emit('request', ...)` 把动态规则、隧道规则与全接管能力落在同一个 server 上。

反向调用同样走 HTTP：`:1240-1252` 用 `x-whistle-auth-key` 头拼出 `baseUrl`，预置 `/cgi-bin/get-session`、`get-frames`、`custom-frames` 的 `options`，插件可借此取会话与[抓包](/concepts/05-capture)帧。最巧妙的是网络闭环——`lib/plugins/proxy.js:261-285` 劫持 `net.Socket.prototype.connect`，把指向特殊 host 的连接改接到内部临时 server（`:272-284`），于是插件自己发起的 `http.request` 也会绕回主代理、再次经过规则匹配。这样插件既不必知道代理端口，也不会绕过用户配置的规则。劫持范围是可控的：`SPEC_HOST_RE` 只匹配带内部标记的特殊 host（`lib/plugins/proxy.js:265-270`），普通外网连接仍走原始的 `originConnect`（`:266`），不会把插件的全部流量都塞回代理。

**输入 → 动作 → 输出**：输入是插件导出函数被调用、或插件自己发起的一次 `http.request`；框架在调用前把 `Storage`、`parseUrl`、`wsParser`、`require` 等能力挂到 `options`，每次请求再把 `localStorage` / `sharedStorage` 与按 reqId 索引的 `sessionStorage` 挂到 `req` 上；`proxy.js` 劫持 `net.Socket.prototype.connect`，把指向特殊 host 的连接改接到内部临时 server；输出是「插件拿得到全套能力、自己发的请求又绕回主代理再过一遍规则」的闭环。

**为什么这样设计**：把 `Storage` / `sharedStorage` 直接注给插件，是让插件不必自己管落盘与会话字典；`sessionStorage` 用带 LRU 的 `sessionStorage` 按 reqId 提供 get / set / peek，正好对应「一次请求的生命周期」。最巧妙的是网络闭环——劫持 connect 让插件自己发起的请求也绕回主代理，插件因此既不必知道代理端口，也不会绕过用户配置的规则；`SPEC_HOST_RE` 只匹配带内部标记的特殊 host，普通外网连接仍走 `originConnect`，把劫持范围收在最小。

**代价与边界**：反向调用同样走 HTTP（用 `x-whistle-auth-key` 拼 `baseUrl` 取会话与抓包帧），意味着插件能力越丰富、对内部 CGI 的依赖越重；`sessionStorage` 是 LRU，超出容量或请求结束即失效，不能当长期存储用。劫持 `net.Socket.prototype.connect` 属于全局改写，边界全靠 `SPEC_HOST_RE` 的白名单——一旦匹配规则写宽，插件的全部外网流量都可能被误塞回代理，这正是注释强调「可控」的原因。

**打个比方**：框架像给外派员工配了一整套工牌、档案柜与内部电话（`options` / `Storage` / 反向 CGI），还把他发出的每封外寄信都先送回公司收发室盖一次章（劫持 connect），于是他不用记公司地址，也绕不开公司的寄送规定。

**自己验证**：顺着 `lib/plugins/proxy.js:261-285` 那段读——`net.Socket.prototype.connect` 被改写、特殊 host 指向内部临时 server、其余仍走 `originConnect`；再对照 `addSessionStorage` 按 reqId 提供 get / set / peek，不用装插件就能确认「能力注入」与「网络闭环」这两条设计。

**把结论展开**：网络闭环为什么要靠「劫持 `net.Socket.prototype.connect`」这么底层的手段？因为插件用的是普通 `http.request`，框架无法要求每个插件都显式改走代理端口；劫持 connect 后，指向特殊 host 的连接被改接到内部临时 server，插件「以为自己在直连」，实际绕回主代理又过了一遍规则。这样既不必给插件注入代理地址，也堵死了「插件请求绕过用户规则」的口子——`SPEC_HOST_RE` 白名单则保证只拦带内部标记的那部分。

**这一段的收束**：把前四段串起来看——命名发现决定「谁能进来」，进程模型决定「进来后跑在哪」，通信决定「请求怎么送进去」，这一段决定「插件拿到请求后能读写什么、自己发的请求又去哪」。四层合起来，才构成「第三方代码深度介入请求链路、又不拖垮代理」这个开篇立下的目标；下一篇转到浏览器一侧，看这些 ports 表与 CGI 如何被呈现给用户。

**换个角度看**：`storage` / `localStorage` / `sharedStorage` 三个名字为什么分成三份？它们对应三种生命周期——按 reqId 索引的单次会话、插件本地、以及落在 `.shared_storage` 目录里可跨实例共享的数据。把作用域写进名字，插件作者就不必自己判断「这份数据该放哪、会不会被别的实例看到」；`sessionStorage` 用 LRU 也正好呼应「一次请求结束即失效」这个边界。

## 常见误解

以下四条都来自本篇最容易读反的结论，尤其头两条关乎「插件到底跑在哪」。

1. **容易以为插件是在主进程里 `require` 进来的，其实它由 pfork 拉到独立子进程**：主进程只认 ports 表、按 hook 名转发，正常模式下插件崩溃不会带走代理主进程，只有 `inspectMode` 或 `PFORK_MODE=inline` 才内联，对照见 [《易混淆概念辨析》](/concepts/08-confusions)。
2. **容易以为 hook 头是插件业务协议的一部分，其实它只是内部转发标记**：`getHookName` 读完即删该头，插件业务代码看不到；上下文头还被 `compatHeaders` 定义成不可枚举，遍历或转发时不会泄漏内部字段。
3. **容易以为规则类 hook 每次请求都会重跑插件脚本，其实有 ETag / max-age 缓存**：`rulesCache` 按插件名与类型缓存 body、values 与 raw，子进程返回 `x-whistle-etag` / `x-whistle-max-age` 时更新，本地往返的代价因此被摊薄。
4. **容易以为插件自己发的 `http.request` 会绕过规则，其实它绕回主代理再匹配一次**：`proxy.js` 劫持 connect 把特殊 host 接到内部临时 server，普通外网连接仍走 `originConnect`，闭环的范围由 `SPEC_HOST_RE` 白名单界定。

## 小结

- `whistle.[a-z\d_-]+` 命名与 `whistleConfig` 决定长短协议与界面能力，搜索路径集中在 `module-paths.js:58-88`。
- 启动同步扫描加每 6 秒按 path / mtime 的增量轮询，安装落 `custom_plugins`，禁用只写 `disabledPlugins`。
- `p.fork` 以 script + value 复用子进程，ports 表缓存在主进程，close 或 `p.kill` 时清理。
- `PLUGIN_HOOKS` 的名称带 uid，经 `x-whistle-plugin-hook-name_` 打到 `127.0.0.1` 的 hookPort，子进程单端口按头分发。
- 规则 hook 用 ETag / max-age 缓存；`Storage`、`wsParser`、`require` 与反向 CGI 构成插件侧 API，劫持 connect 形成网络闭环。
- 本篇为 [《Web 管理界面》](/modules/webui) 准备了「插件的 ports 表、CGI 与 Tab 声明从哪来」这个前提：界面上看到的插件开关、`/whistle.xxx/` 转发与四个 Tab，都要靠这里讲清的 ports 表与 `whistleConfig` 才能落地。

## 下一步

[《Web 管理界面》](/modules/webui)：回到浏览器一侧，看这些 ports 表与 CGI 接口如何被识别、鉴权并渲染成四个 Tab。 紧接着读它，是因为本篇结尾停在「插件能力已经就位、但用户在哪儿点它」这个未解问题上——17 正好回答浏览器一侧如何把这套内部机制识别、鉴权并呈现出来。
