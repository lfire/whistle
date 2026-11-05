---
title: 从 w2 start 到端口监听
description: 沿 w2 start 的调用时序，拆开 CLI 分发、starting 守护化与端口监听三段代码。
---

上一篇用一张图给出了全局主干，本节把图中最前面的方框落到真实代码：敲下 `w2 start` 之后，参数如何被分发、进程如何脱离终端转入后台、以及主端口究竟在哪一行开始监听。读完你应当能沿着调用栈从 `bin/whistle.js` 一路走到 `server.listen`，并说清根 `index.js` 为什么不是一个「被 require 就立刻自启」的脚本。

![从 w2 start 到端口监听的启动时序](/diagrams/startup.svg)
*图注：CLI 按命令分发，starting 把业务进程守护化，后者完成配置装配后才开始监听端口。*

## 三个可执行名，同一个入口

`package.json:30-34` 把 `whistle`、`w2`、`wproxy` 三个可执行名全部指向 `./bin/whistle.js`。这解释了为什么无论用哪个名字启动，走的都是同一套参数解析逻辑；差别只在于 `getName()`（`bin/whistle.js:86-90`）从 `process.argv[1]` 取到的展示名，以及帮助信息里的命令字。

真正的分发发生在 `bin/whistle.js:191-263`，判据是 `argv[2]`。一批子命令由 CLI 自己拦截处理：`root` 打印安装根目录，`status` 查运行状态，`proxy` 配系统代理，`ca` 管根证书，`install` / `uninstall` 管插件，`use` / `enable` / `add` 加载规则文件，而 `run <plugin>` 与 `exec` 转给 `plugin.run`（`bin/whistle.js:253-256`）。剩下的 `start`、`stop`、`restart`、`run`、`help` 落进最后的 `else` 分支，交给 `program.parse(argv)`（`bin/whistle.js:257-263`）——此处的 `program` 来自 `require('starting')`（`bin/whistle.js:3`）。

::: cols 20|28|52
| 命令 | 处理方 | 行为 |
|---|---|---|
| start | starting | 守护化启动并转入后台 |
| stop | starting | 按 PID 结束业务进程 |
| restart | starting | 先停再起，复用旧参数 |
| run | starting / CLI | 前台运行；带插件名时拦截 |
| status | CLI | 读 PID 与 options 展示 |
| root | CLI | 打印代码安装根目录 |
| proxy / ca | CLI | 配系统代理 / 管根证书 |
| install / use | CLI | 装插件 / 加载规则文件 |
| exec | CLI | 执行插件命令 |
:::

表中 `run` 有两义：`w2 run` 是前台启动，交给 `starting`；`w2 run <plugin>` 因 `argv[3]` 非选项而被 `:253-256` 拦截，等价于执行一次插件命令。这个细节常被忽略，却决定了「启动服务」与「跑插件」在同一命令字下的分叉。顺带一提，`--init`（`bin/whistle.js:177`）会在启动成功后自动配系统代理并安装根证书：`handleEnd` 拿到 `showUsage` 返回的代理参数后调用 `setProxy(argv)` 与 `installCA([host])`（`bin/whistle.js:48-66`），同时 `:198-200` 把 `persistentCapture` 追加进 `WHISTLE_MODE`。

## starting 守护化与实例去重键

`starting` 是 `package.json:62` 声明的外部依赖（版本 `^8.0.3`），并不在本仓库源码内。它负责把业务进程拉成 detached 后台进程：`starting/lib/cli.js:90-94` 以 `detached: true` 调用 `execCmd`，最终由 `starting/lib/cli.js:231` 的 `cp.spawn(execPath || 'node', args, options)` 落地，标准输出被重定向到错误文件，进程因此与终端解耦。

参数不是靠环境变量，而是随启动命令显式传递。`starting/lib/cli.js:226-229` 把整份 options 序列化成 `encodeURIComponent(JSON.stringify(data))` 并追加 `--data`；`starting/lib/bootstrap.js:15` 声明该选项，`:6-12` 的 `run <main>` 动作里先 `main = require(main)`，确认导出是函数后，再以 `util.parseJSON(program.data, true)` 的结果调用它。

```js
// starting/lib/bootstrap.js:6-12（外部依赖）
program
  .command('run <main>')
  .action(function (main) {
    main = require(main);
    if (typeof main == 'function') {
      main(util.parseJSON(program.data, true));
    }
  });
```

这就回答了开头的问题：根 `index.js:143` 写的是 `module.exports = function (options, callback) {...}`，它导出的是一个待调用的函数，模块顶层没有任何自启语句。若它一被 require 就立刻监听端口，`--data` 里的端口、存储目录、认证等参数根本来不及传入；把「装配」与「启动」合成一个可传参的函数，才让 `starting` 有机会先注入配置再触发监听。这种「入口脚本只导出函数」的约定，也让 Whistle 能被当作库嵌入：外部传入自定义 `server` 与 `options`，不必另起一套启动协议。

守护化还附带一套状态记录。`starting/lib/cli.js:83` 把子进程的 stderr 重定向到 `~/.startingAppData` 下的错误文件，`config._pid` 与 `config.main` 经 `writeConfig` 一并写入运行记录（`starting/lib/cli.js:96-101`）；`w2 status` 之所以能看到端口与启动参数，正是 `bin/util.js:145-150` 的 `readConfig` 反向读取了这份记录。CLI 是短命进程，它解析参数、发起 spawn、打印提示后即退出，此后常驻的是被拉起的业务进程。

去重键由 `bin/whistle.js:93-103` 的 `main(options)` 提供：它取 `options.storage` 做 `encodeURIComponent`，拼出 `index.js#<enc>#` 这样的字符串返回（`bin/whistle.js:101-102`）。`starting/lib/cli.js:186-194` 的 `getHashIndex` 专门识别结尾 `#` 并找到前一个 `#`，于是 `getRunningPath`（`:196-199`）用这段 `#...#` 作为配置文件名，而 `execCmd`（`:203-208`）先把哈希截掉再拼 `[BOOTSTRAP_PATH, 'run', main]`，保证 `require(main)` 拿到的仍是干净的 `index.js` 路径。换句话说，同一个 storage 对应同一份运行记录，不同 storage 可以并行起多个互不相扰的实例；PID 与 options 就落在 `~/.startingAppData`（`bin/util.js:123-150` 的 `getDataDir` / `getConfigFile` / `readConfig`）。

## index.js：装配配置，再交给 lib

业务进程真正执行的是根 `index.js` 导出的函数。`index.js:143-148` 先兼容「只传 callback」的调用形态，随后 `startWhistle()` 在 `:173` 执行 `require('./lib/config').extend(options)`，把 CLI 参数合并进全局配置单例；紧接着 `:174-175` 判断 `conf.cluster`，默认分支直接 `return require('./lib')(callback, server)`，把监听工作交给 `lib/index.js`。

```js
// index.js:173-175
var conf = require('./lib/config').extend(options);
if (!conf.cluster) {
  return require('./lib')(callback, server);
}
```

`--config` 文件（`bin/whistle.js:179`）在 `index.js:79-85` 的 `loadConfig` 里用 `require(path.resolve(config))` 载入，`:221-240` 支持它导出对象、函数或 Promise，并把结果 `extend` 回 options 后再进入 `startWhistle`。`options.cluster` 分支则位于 `index.js:165-172` 与 `:199-213`：只有主进程且显式传入 `--cluster` 时才 `forkWorker`，worker 会被强制追加独立的 storage 后缀，具体机制留到下一篇展开。此外 `:1-44` 还提前打了若干 Node 兼容补丁（如 `net.Socket.prototype.connect`、`tls.checkServerIdentity`），并设置 `WHISTLE_ROOT` 等环境变量。

## 端口监听与 whistleStarted

`lib/index.js:36-61` 创建 express `app` 与 `http.Server`，按顺序装配中间件链，再依次调用 `setupHttps`、`tunnelProxy`、`upgradeProxy`、`initDataServer`（`:57-61`）：HTTPS 解密、CONNECT 隧道、WebSocket 升级、抓包缓存四类能力都在这里挂到同一个 server 上。`server.timeout = config.timeout`（`:44`）设定空闲超时，`requestTimeout` 被置零，避免长连接被 Node 默认超时切断。

监听动作在 `lib/index.js:90-95`：先解析绑定 IP、检查端口占用，再执行 `server.listen(config.port, host, execCallback)`。这里有个容易看漏的计数设计——`:82-89` 用 `count` 统计所有待完成的监听，主 server 之外若还开了独立的 HTTP / HTTPS / SOCKS 端口，每个都会 `++count`；只有计数归零，`execCallback` 才置 `process.whistleStarted = true` 并 `process.emit('whistleStarted', proxyEvents)`（`lib/index.js:82-89`）。

```js
// lib/index.js:82-89
var count = _server ? 1 : 2;
var execCallback = function () {
  if (--count === 0) {
    process.whistleStarted = true;
    process.emit('whistleStarted', proxyEvents);
    typeof callback === 'function' && callback.call(server, proxyEvents);
  }
};
```

最后一层顺序约束在 `lib/index.js:208-211`：`require('../biz/init')(proxyEvents, callback)` 完成后台初始化后，回调里才 `server.on('request', app)` 并调用 `execCallback()`。也就是说，端口可能已经处于监听状态，但在业务数据、规则、插件就绪之前，`request` 事件尚未挂上 Express 应用；`biz/init` 与端口监听是两条并行的准备线，靠 `count` 汇合。理解这一点，才能解释为什么启动日志出现得比「首个请求可被处理」更早。

## 小结

- `package.json:30-34` 的三个可执行名统一指向 `bin/whistle.js`，由 `argv[2]` 分发命令。
- `starting` 以 detached `cp.spawn` 守护化，options 经 `--data` JSON 传给 bootstrap，后者 `require(main)` 后调用导出函数；根 `index.js` 因此不自启动。
- `main(options)` 返回 `index.js#<enc>#` 作为实例去重键，PID 与 options 存于 `~/.startingAppData`。
- `index.js` 先 `config.extend(options)`，再 `require('./lib')(callback, server)`；`--config` 与 `--cluster` 是两条可选分支。
- `lib/index.js:93` 开始监听，所有监听计数归零才发 `whistleStarted`；`biz/init` 完成后才挂 `request` 事件。

## 下一步

[《进程模型与配置系统》](/architecture/process-config)：服务已经监听端口，接着看它由哪些进程组成、配置如何合并与变更通知。
