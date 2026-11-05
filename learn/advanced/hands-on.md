---
title: 三个动手实验
description: 用一条规则链、一个最小插件和一次嵌入式启动，把前四层的源码认识变成可复现的操作。
---

前四层解决的是「请求怎么走、模块怎么分」，本层只解决三件事：能不能跑起来、能不能照着改、改完去哪里查。三个实验各自可独立完成，但共享同一套源码坐标，建议依次做，每做一步就回到对应文件核对一次现象。以下所有命令、行号与阈值都以 `guide` 分支 `3b85cebc4`、v2.10.13 为准，路径一律写仓库相对路径；若你检出的是其它提交，请以函数名和事件名作锚点。

## 实验一：用一条规则链看懂请求生命周期

目标是让一次请求同时穿过规则解析、请求改写、响应延迟与抓包上报四条链路，并在界面上拿到可见证据。

### 先把代理跑起来

按 `README.md:38-61` 的四步部署：装包、启动、装根证书、设代理。

```bash
# README.md:38-61 · 安装与启动
npm i -g whistle
w2 start -p 8899
w2 ca
```

`-p 8899` 覆盖 `package.json:7` 的默认端口，`w2 ca` 由 `bin/ca/cli.js` 安装根证书，`bin/whistle.js:214-217` 把 `proxy` 与 `ca` 两个子命令分派给对应模块。第四步设代理可以用 `w2 proxy`，也可按 README 推荐用 ZeroOmega 把浏览器代理指向 `127.0.0.1:8899`；HTTPS 抓包必须完成第三步，否则 `lib/tunnel.js:168-213` 的解密判定不会生效。打开 `http://local.whistlejs.com/` 进入界面，后续操作都在 Rules 与 Network 两个面板之间切换。

启动后先用 `w2 status` 确认实例在运行（`bin/status.js:11-40` 会列出 PID、端口与 `storage`），再访问一个 HTTP 页面看 Network 是否开始记录；若列表为空，优先检查代理是否真的指向了 8899，而不是急于怀疑规则引擎。证书这一步对 HTTP 请求不是必需的，但一旦后续要看 HTTPS 明文，根证书未信任会让 `lib/tunnel.js:168-213` 的解密分支被跳过，界面只能看到 CONNECT 隧道而看不到内层请求。把这两项前置条件先钉死，后面所有「现象对不上」的排查才有共同基线。

### 写一组同时命中四条链路的规则

```txt
# Rules 面板（解析见 lib/rules/rules.js:48）
example.com/api file://({"ok":true,"from":"whistle"})
example.com/api reqHeaders://(x-demo: 1)
example.com/api resDelay://800
example.com/api log://
```

第一行用内嵌值 `file://(...)`（`lib/rules/rules.js:48` 的 `VALUE_RE` 匹配括号内容）返回一段 JSON；也可以把内容存进 Values，再用 `file://{key}` 引用。后三行分别命中 `reqHeaders`、`resDelay`、`log`，三者都在 `lib/rules/protocols.js:18,36,48` 注册。规则的通用写法是 `pattern operation`：`pattern` 匹配 URL，`operation` 决定由哪个 handler 接手；命中结果最终落在 `req.rules` 上，供四个 inspector 阶段读取。

### 预期现象与对应源码链路

配置生效后访问 `http://example.com/api`，Network 面板出现这一条请求，详情里请求头多出 `x-demo: 1`，响应体是上面那段 JSON，计时上能看出约 800ms 的停顿，Console 里能看到 `log://` 的输出。四条链路的落点分别是：`lib/inspectors/rules.js:153-214` 生成 `reqId`、解析规则并挂上编解码钩子；`lib/inspectors/req.js:456-612` 应用 `reqHeaders` 等请求阶段改写；`resDelay` 在 `lib/inspectors/res.js:1163` 取值；`lib/handlers/file-proxy.js:233-248` 判定 `file://` 协议并直接构造响应，请求不再发往真实服务器；`lib/inspectors/data.js:185` 的 `proxy.emit('request', reqEmitter, data)` 把抓包数据交给缓存。

界面为什么几乎能实时看到数据？`lib/util/data-server.js:92-95` 把 `request` 与 `frame` 事件绑到缓存，`biz/webui/cgi-bin/get-data.js:60` 用 `proxy.getData` 打包返回，前端 `biz/webui/htdocs/src/js/data-center.js:1159` 依据 `hasNew` 决定 100ms 还是 900ms 再拉一次：有新数据就加快，空闲就放慢。这就是短轮询把缓存显示出来的完整链条，也是 Network 面板与内核之间唯一的通路。

### 现象 → 应该去看哪个文件

::: cols 50|50
| 现象 | 首先检查 |
|---|---|
| 规则完全不生效 | `rules.js:186` 规则初始化 |
| 请求头没有改写 | `req.js:456` 请求阶段 |
| 延迟不起作用 | `res.js:1163` 响应阶段 |
| Network 空白 | `data.js:185` 抓包上报 |
| 内嵌值不返回 | `file-proxy.js:233` 出站 |
:::

表中文件位于 `lib/inspectors/` 与 `lib/handlers/`，行号是各模块导出函数或取值点的入口；先在那里下断点，再沿 `req.rules` 顺藤摸瓜，比从头翻目录快得多。

## 实验二：写一个最小插件

插件是第三方代码，Whistle 用独立进程隔离它。本实验做一个能被规则命中、并出现在插件列表里的最小插件。

### 目录与清单

新建 `whistle.hello/`，其 `package.json` 的 `name` 必须匹配 `whistle.[a-z\d_-]+`（`lib/plugins/util.js:8-10` 的 `WHISLTE_PLUGIN_RE` 与 `PLUGIN_NAME_RE`），`whistleConfig` 可选（`lib/plugins/get-plugins-sync.js:122`）。

```json
// whistle.hello/package.json（复制时删去本行注释）
{
  "name": "whistle.hello",
  "version": "1.0.0",
  "main": "index.js",
  "whistleConfig": { "hideShortProtocol": false }
}
```

主文件导出 `server`（或 `pluginServer`）与 `rulesServer`，由 `lib/plugins/load-plugin.js:1616-1635` 分别取作 `startServer` 与 `startRulesServer`。下面是 Node CommonJS 的最小可运行版本。

```js
// whistle.hello/index.js
module.exports = (server, options) => {
  server.on('request', (req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end('hello from ' + options.name);
  });
};
module.exports.rulesServer = (server) => {
  server.on('request', (req, res) => {
    res.end('* file://(hello-plugin)\n');
  });
};
```

`rules.txt` 是全局规则模板，`lib/plugins/get-plugins-sync.js:184-188` 用 `renderPluginRules` 把 `{{whistlePluginName}}` 替换成短名后再合入规则集。

```txt
# whistle.hello/rules.txt
example.com hello://hi
```

### 安装与发现

```bash
# bin/plugin.js:124-145 · 安装本地插件
w2 install ./whistle.hello
w2 status
```

也可以直接把目录放进 `~/.WhistleAppData/custom_plugins/`（`bin/plugin.js:12` 的 `CUSTOM_PLUGIN_PATH`，根路径由 `lib/util/common.js:598-603` 给出）。插件被 `lib/plugins/index.js:620-670` 的 `p.fork` 拉起，主进程只保存它返回的端口；`lib/plugins/load-plugin.js:2012-2031` 的 `server.on('request')` 依据 hook 头（`lib/config.js:74` 的 `PLUGIN_HOOK_NAME_HEADER`）把请求分发到 `authServer` / `sniServer` / `uiServer` / `httpServer`。插件运行时可用的 `options.storage`、`require`、`wsParser` 等在 `load-plugin.js:1147-1186` 注入，`options.storage` 最终由 `load-plugin.js:1229-1234` 落到独立数据目录。

调试用 `PFORK_MODE=inline w2 run`（`lib/plugins/index.js:632,657` 让插件在当前进程跑，日志直接打到终端）、`w2 run --inspect`（`bin/whistle.js:93-103` 明确 inspector 仅 `w2 run` 支持）、`w2 status` 查看实例。插件目录每 6 秒刷新一次（`lib/plugins/index.js:36,544-550`），改完文件稍等即可被发现，不必重启主进程。

协议有长短两种写法：`whistle.hello://xxx` 是长协议，`hello://xxx` 是短协议（`docs/docs/extensions/dev.md:49`），二者等价；`whistleConfig.hideShortProtocol` 与 `hideLongProtocol` 可分别隐藏其一。

验证是否成功有三处可看：`w2 status` 之后界面 Plugins 列表出现 `hello`，Rules 里写 `example.com whistle.hello://hi` 能命中插件的 `server`，而 `rulesServer` 返回的那条规则会让匹配请求直接得到 `hello-plugin`。若插件始终不出现，先查 `name` 是否合规、目录是否落在 `CUSTOM_PLUGIN_PATH` 下、以及 6 秒刷新是否已经跑过一轮；若出现了但请求没被分发，再回到 `load-plugin.js:851-853` 确认 hook 头有没有被正确写入。

## 实验三：把 Whistle 嵌进自己的 Node 进程

不启 CLI、不装系统代理，直接在业务进程里拿到一个可编程的代理实例，用事件与接口操纵它。

### 调用形态

入口是 `index.js:143-148` 的 `startWhistle(options?, callback?)`；只传一个函数时它会被当作 callback，选项置空。`options.config`（即 `--config`）由 `index.js:79-83` 用 `require(path.resolve(config))` 载入，`index.js:245` 另外导出 `getWhistlePath()`。类型定义在 `index.d.ts:69-145` 的 `WhistleOptions` 与 `186-209` 的 `WhistleResult` / `WhistleCallback`。

```js
// 参考 test/index.test.js:105-136 · 嵌入式启动
const startWhistle = require('whistle');
const proxy = startWhistle({
  port: 8899,
  storage: 'demo_',
  debugMode: true
}, () => console.log('whistle ready'));

proxy.on('request', () => {});
proxy.on('wsRequest', () => {});
proxy.on('tunnelRequest', () => {});
proxy.on('frame', () => {});
proxy.on('rulesDataChange', () => {});
process.on('whistleStarted', () => console.log('started'));
```

`test/index.test.js:105-136` 正是这样用的：传入 `port`、`storage`、`httpPort`、`httpsPort`、`certDir`、`debugMode`、`rules`、`values`，随后对返回的 `proxy` 监听 `tunnelRequest`、`wsRequest`、`_request` 并调用 `setUIHost` 等接口。这段真实用例是本实验最可靠的模板。

### 关键选项与事件

`options.server` 可传自定义 `http.Server`（`index.js:150-163` 会自动派生 `port` / `host` 并生成隔离用的 `storage`）；`options.cluster` 触发 `index.js:200-211` 的 `cluster.fork`；`storage` 用不同子目录隔离多实例（`lib/config.js:1072-1074`）。`proxyEvents` 上的 `request`、`frame`、`tunnelRequest`、`wsRequest`、`rulesDataChange` 分别在 `lib/inspectors/data.js:185`、`lib/socket-mgr.js:765`、`lib/rules/util.js:130` 等处发出；启动完成时 `lib/index.js:85-87` 发 `process.emit('whistleStarted', proxyEvents)` 并执行回调。`lib/index.js:215-241` 的 `exportInterfaces` 把 `rules` / `util` / `httpsUtil` / `pluginMgr` / `logger` / `socketMgr` / `setAuth` / `setShadowRules` 挂到返回值上，这些是嵌入式最主要的编程面。

与 CLI 模式的差别必须记牢：嵌入式没有 detached 后台进程，也不会自动设置系统代理、自动安装根证书，端口监听、证书准备与界面访问都要自己安排。收尾时主动 `server.close()` 并清掉定时器，否则进程不会自然退出。端口被占用时 `bin/whistle.js:68-84` 会给出 `EADDRINUSE` / `EACCES` 提示（换 `-p` 或提升权限），嵌入式同样要先避开冲突端口再启动。

嵌入式最适合的场景是把代理当作测试基建或长驻服务的一段逻辑：例如在集成测试里临时起一个实例、注入规则、用 `request` 事件断言请求头，再关掉它；或在同一进程内按 `storage` 起多个互不干扰的实例。它不适合替代桌面抓包，因为浏览器代理设置与证书信任仍需用户手动完成。理解了这条边界，就不会把「进程内可编程」误当成「开箱即用的完整 CLI」。

## 小结

- 实验一用一条规则链同时打到 `rules.js`、`req.js`、`data.js`、`file-proxy.js` 四处，界面数据来自 `cgi-bin/get-data` 的短轮询。
- 实验二的最小插件受命名正则、`p.fork` 隔离、hook 头分发与 6 秒刷新四项约束，长短协议等价。
- 实验三把 Whistle 变成进程内对象，事件与 `exportInterfaces` 是主要编程面，但不再代管代理设置与证书。
- 三个实验共用同一套行号坐标；遇到对不上的现象，先回对应入口文件确认版本基线，再怀疑自己的配置。

## 下一步

[《源码阅读与调试路线》](/advanced/source-reading)：把「在哪儿下断点」系统化，并补齐调试开关、测试体系与阅读方法。
