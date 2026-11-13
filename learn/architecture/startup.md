---
title: 从 w2 start 到端口监听
description: 沿 w2 start 的调用时序，拆开 CLI 分发、starting 守护化与端口监听三段代码。
---

# 从 w2 start 到端口监听

上一篇用一张图给出了全局主干，却留下一个悬而未决的问题：图上那些方框是按什么次序被装配起来的、谁先谁后。本节把图中最前面的方框落到真实代码：敲下 `w2 start` 之后，参数如何被分发、进程如何脱离终端转入后台、以及主端口究竟在哪一行开始监听。读完你应当能沿着调用栈从 `bin/whistle.js` 一路走到 `server.listen`，并说清根 `index.js` 为什么不是一个「被 require 就立刻自启」的脚本，也能用 `w2 status` 反查这次启动留下的运行记录。

::: tip 先修知识
本篇承接 [《一张图看懂全局架构》](/architecture/overview)（前置 06），需要你已经理解那张图上的四类入口、[中间件](/concepts/04-runtime)链与事件总线分别对应哪个文件，以及「CLI 进程 / detached 业务进程 / 子进程」三层的大致分工；知道 [《概念精解 · Node 运行时与内核骨架》](/concepts/04-runtime) 里的进程与事件模型会更轻松。若对「入口脚本只导出函数、由外部注入参数再调用」这种约定不熟悉，可先读该篇；对[插件](/concepts/07-extension)与子进程隔离可查 [《概念精解 · 扩展机制与工程化》](/concepts/07-extension)；对配置合并与规则加载可查 [《概念精解 · 规则 DSL 全景》](/concepts/06-rules)；对启动后界面如何取数据可查 [《概念精解 · 抓包数据面与帧》](/concepts/05-capture)。

不需要预先读过源码，但能分清「短命的 CLI 进程」与「常驻的业务进程」就够了；成组混淆可查 [《易混淆概念辨析》](/concepts/08-confusions)，忘记名词查 [《全量术语索引》](/concepts/glossary)。
:::

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

**为什么把三个名字收敛到同一个入口**：`package.json:30-34` 把 `whistle`、`w2`、`wproxy` 都指向 `./bin/whistle.js`，是因为三者只是「叫法」不同、行为完全一致；差别只在 `getName()` 从 `process.argv[1]` 取到的展示名。把结论展开成推理：若每个名字各写一份参数解析，改一处就要同步三份，迟早出现「`w2 start` 能用、`wproxy start` 报错」这类分叉；共用一个入口后，命令分发只有 `argv[2]` 一处判据，新增子命令也只改一处。代价是帮助信息里的命令字要按展示名动态拼，不能写死；边界是「同一个入口」只保证参数解析一致，不同名字在脚本里仍可能被当成不同调用来源。

**为什么一批子命令由 CLI 自己拦截、另一批交给 starting**：`start` / `stop` / `restart` 要操作常驻进程（守护化、按 PID 结束、先停再起），属于「进程生命周期」，必须交给 `starting`；而 `root` 打印目录、`status` 查状态、`proxy` 配系统代理、`ca` 管根证书这些都只是一次性的本地动作，CLI 自己做完即可退出。把这条分界记住，就能解释表里「处理方」一列为什么不是清一色：判据不是命令长什么样，而是它要不要碰那个后台进程。代价是同一个 `run` 因此有了两义——`w2 run` 前台启动交给 `starting`，`w2 run <plugin>` 因 `argv[3]` 非选项被拦截成插件命令；边界是这种「按参数个数分叉」很隐蔽，写脚本时最好显式写全。

**`--init` 为什么顺手做两件事**：`--init` 在启动成功后自动配系统代理并安装根证书，是因为「代理起来了」并不等于「流量会进来、HTTPS 能解密」；`handleEnd` 拿到代理参数后调用 `setProxy(argv)` 与 `installCA([host])`，同时把 `persistentCapture` 追加进 `WHISTLE_MODE`，把「装好」与「配好」合并成一步。代价是它会改动操作系统代理设置与信任存储，属于有副作用的操作，批量部署时不能无脑加；边界是它只负责初始配置，之后仍要按规则面板决定是否解密。

**输入 → 动作 → 输出**：这一段的输入是用户敲下的命令字与参数（`argv[2]` 及其后的值），动作是 `bin/whistle.js` 按 `argv[2]` 判据把命令分给 CLI 自己或 `starting`，输出是「一次性动作做完即退出」或「转交后台进程托管」两种去向。把这三段分开看，就能解释表里为什么有的命令能立刻回显、有的命令要等一会儿才有结果——前者根本没进后台，后者要等守护化完成。

**代价与边界（补）**：按 `argv[2]` 单判据分发很简洁，代价是它只能看第一个词，命令的选项与参数得由各自的处理方再解析一遍；边界是这张表只覆盖「命令字」这一层，真正的端口、目录、认证等参数要等下一段的 `--data` 才进场。把「命令分发」和「参数传递」当成同一步，就容易误以为 `w2 start` 的一切都在 CLI 里定好了。

**打个比方**：`bin/whistle.js` 像公司总机，`whistle` / `w2` / `wproxy` 是三个对外公布的分机号，拨哪个都接到同一位接线员；接线员听第一个词（`argv[2]`）决定是「自己回一句」（CLI 拦截）还是「转给后台值班室」（starting）。

**把「命令分发」与「能力清单」对上号**：上一篇的能力清单里，「配系统代理 / 管根证书 / 装插件 / 加载规则文件」这几项调试前的准备工作，在代码里正好对应本篇 CLI 自己拦截的那批子命令——`proxy` / `ca` / `install` / `use`。它们不是「另一种启动方式」，而是把清单里的准备动作做成了一次性入口，都不碰常驻进程、执行完即退出。把这条对应关系记住，再看下一篇的「配置合并」就不会奇怪：本篇只负责把这些命令分发到位，配置如何在运行期被读到、改了又怎样通知，是 08 才展开的另一半。

**自己验证**：执行 `w2 status`（本篇守护化一段出现过），看它展示的端口与启动参数；再对照表里 `status` 一行写着「CLI」，就能确认这类只读查询确实不需要惊动后台进程——它读的是启动留下的运行记录，而不是向业务进程发问。

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

**为什么入口脚本只导出函数、不立刻自启**：把上面那句结论展开——`index.js:143` 导出的是 `function (options, callback) {...}`，模块顶层没有任何监听语句。若它一被 `require` 就立刻 `server.listen`，`--data` 里的端口、存储目录、认证等参数根本来不及传入；把「装配」与「启动」合成一个可传参的函数，bootstrap 才有机会先 `require(main)`、用 `util.parseJSON(program.data, true)` 解出 options，再调用这个导出函数。这也解释了为什么参数不走环境变量而走 `--data`：环境变量是进程级的全局状态，同机多实例会互相污染，显式传参才能做到「一个 storage 一份配置」。代价是 Whistle 不能脱离 CLI 或宿主单独启动，必须由它们注入参数后再触发；边界是它换来了「能被当库嵌入」——外部传入自定义 `server` 与 options 即可，不必另起一套启动协议。

**为什么需要实例去重键**：`main(options)` 用 `options.storage` 拼出 `index.js#<enc>#`，是因为 `starting` 要按「哪份运行记录对应哪个实例」来管 PID 与配置；同一 storage 复用同一份记录，不同 storage 就能并行起多个互不相扰的实例。把这条推理再走一步：若所有实例共用一个键，第二次 `w2 start` 会覆盖第一次的 PID，停止时就不知道该结束谁；若键里不带 storage，多实例的数据目录也会串在一起。代价是键本身只是字符串约定，`getHashIndex` 必须专门识别结尾 `#` 并找到前一个 `#`，`execCmd` 还要先把哈希截掉再拼 `require(main)` 的路径，多了一层解析；边界是它只解决「实例识别」，不解决「端口冲突」——两个实例仍要自己配不同端口。

**为什么 CLI 是短命进程、业务进程才是常驻的**：`starting` 以 `detached: true` 调 `cp.spawn` 后把标准输出重定向到错误文件，子进程因此与终端解耦；CLI 解析参数、发起 spawn、打印提示后即退出，此后常驻的是被拉起的业务进程。这样分层是为了让「关掉终端」不等于「关掉代理」，也让 `w2 status` 这类查询可以随开随走、不必依附某个长连接。代价是排障时要分清你看的是 CLI 的输出还是业务进程的日志（后者落在 `~/.startingAppData` 下的错误文件里）；边界是 `detached` 只解耦了终端，不自动做崩溃重启。

**守护化的输入 → 动作 → 输出**：输入是 CLI 序列化进 `--data` 的整份 options，动作是 `starting` 以 `detached: true` 拉起业务进程、bootstrap 再 `require(main)` 并把解出的 options 交给导出函数，输出是一个与终端解耦、常驻监听端口的进程，外加一份落在 `~/.startingAppData` 的运行记录。三段对上号，就能回答开头那个问题：根 `index.js` 为什么不能自启——它只是这条流水线末端的「动作」，参数得由上游注入。

**代价与边界（补）**：把配置序列化成 `encodeURIComponent(JSON.stringify(data))` 随命令传递，好处是多实例互不污染，代价是参数一旦很长就会顶到命令长度上限，且调试时只看到一段编码串、不易直观核对；边界是 `--data` 只在启动那一刻注入一次，运行中改配置并不经由这条通道，那是下一篇配置系统要讲的变更通知。

**为什么「被 require 即启动」在这里不成立**：很多 Node 工具是「被 require 即启动」，本篇特意反着来，是因为 Whistle 既要被 CLI 守护化、又要能被当库嵌入，两种用法对「谁提供 `server`、谁提供 options」的要求完全不同；统一收敛到「导出函数、由调用方注入」这一种入口形态，两种用法才能共用同一份装配代码。代价是第一次读源码的人容易在根 `index.js` 里找不到 `listen` 而以为漏看了文件；边界是这条约定只约束入口，lib 内部各模块仍按「被 require 即装配」的常规方式组织。

**自己验证**：执行 `w2 start` 把服务拉起来，再执行 `w2 status` 看它展示的端口与启动参数，最后到 `~/.startingAppData` 下找那份运行记录——三步都用的是本篇出现过的命令与路径，却能把「参数经 `--data` 传入 → 业务进程常驻 → 记录落盘供 status 反查」这条链完整走一遍；对照 `w2 run` 是前台启动，更能体会 `w2 start` 为什么要守护化。

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

**为什么先 `extend` 再交给 lib**：`index.js:173-175` 的顺序不是随手写的——`require('./lib/config').extend(options)` 必须先把 CLI 参数合并进全局配置单例，随后 `require('./lib')(callback, server)` 才能读到正确的端口、目录与开关。把结论展开：若反过来先加载 lib，中间件链与监听端口都会按默认值装配，等配置合并完成已经来不及改；「配置单例」这一步因此成了启动期与运行期的分界。代价是配置成了全局可变状态，任何模块都能读到、也可能在启动后改写；边界是 `--config` 与 `--cluster` 都必须在这一步之前解析完，否则分支判断读到的仍是半成品。

**`--config` 为什么要支持三种返回形态**：`loadConfig` 用 `require(path.resolve(config))` 载入文件，`:221-240` 兼容它导出对象、函数或 Promise，是因为配置文件可能只是静态对象，也可能需要读环境变量、查远程后异步返回；统一 `extend` 回 options 再进入 `startWhistle`，让调用方不必关心配置是同步还是异步来的。代价是配置阶段可能阻塞启动（等待 Promise），且外部文件的错误会直接变成启动失败；边界是它只负责「补齐 options」，不负责校验字段合法性。

**`--cluster` 为什么被留到下一篇**：`options.cluster` 分支只在主进程且显式传入时才 `forkWorker`，worker 还会被强制追加独立 storage 后缀；它与本篇的主线（单进程如何装配并监听）是两条正交的线，所以这里只点出分支位置、不展开心跳与自愈。把这条边界记住，读本篇时就不会把「多 worker 怎么保活」和「主端口怎么 listen」混成一个问题；那是 [进程模型](/concepts/04-runtime) 层面的另一组机制，下一篇专门讲。

**输入 → 动作 → 输出**：这一段的输入是 bootstrap 交来的 options 与可选的 `server`，动作是 `index.js` 先 `extend` 合并配置、再按 `conf.cluster` 决定走默认分支还是 `forkWorker`，输出是把监听工作整体交给 `lib/index.js`。可见根 `index.js` 自己并不碰端口，它只做「装配与分派」；把这一点和上一篇的图对照，图上最左边那个「启动」方框，落到代码里其实是这两步交接，而不是一次 `listen`。

**代价与边界（补）**：`:1-44` 提前打的 Node 兼容补丁与 `WHISTLE_ROOT` 等环境变量，是在业务代码加载之前就把运行环境抹平，好处是后续模块不必各写一份版本判断；代价是这些补丁全局生效，嵌入到别的宿主时也会影响宿主进程，属于「当库用」时要留意的边界。

**自己验证**：对照 `index.js:173-175` 那段三行代码，数一数 `extend(options)` 与 `require('./lib')` 谁先谁后；再顺着 `index.js:79-85` 看 `--config` 是如何把结果 `extend` 回 options 的，就能确认「先装配配置、后启动监听」不是文档归纳，而是调用顺序本身。

## 端口监听与 whistleStarted

`lib/index.js:36-61` 创建 express `app` 与 [`http.Server`](/concepts/04-runtime)，按顺序装配中间件链，再依次调用 `setupHttps`、`tunnelProxy`、`upgradeProxy`、`initDataServer`（`:57-61`）：HTTPS 解密、CONNECT 隧道、WebSocket 升级、[抓包](/concepts/05-capture)缓存四类能力都在这里挂到同一个 server 上。`server.timeout = config.timeout`（`:44`）设定空闲超时，`requestTimeout` 被置零，避免长连接被 Node 默认超时切断。

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

**为什么四类能力都挂到同一个 server**：`setupHttps`、`tunnelProxy`、`upgradeProxy`、`initDataServer` 依次挂在 `lib/index.js:36-61` 创建的那个 server 上，是因为上一篇图里「四类入口共用一个 `http.Server`」在启动期兑现成了这四次装配调用。把结论展开：HTTPS 解密、CONNECT 隧道、WebSocket 升级、抓包缓存各自是一种「连接语义」，但都从同一个端口进来；若各开一个 server，客户端就得填多个代理地址。代价是这四次装配必须按顺序完成、且都依赖同一个 `app`，任何一步抛错都会让监听无法继续；边界是 `requestTimeout` 被置零只解决「长连接不被切断」，并不等于没有空闲超时——`server.timeout = config.timeout` 仍在。

**为什么用 `count` 计数而不是「主 server listen 完就算启动」**：`:82-89` 的 `count` 把主 server 与可能额外开启的独立 HTTP / HTTPS / SOCKS 端口一起统计，只有计数归零才置 `process.whistleStarted = true` 并 `process.emit('whistleStarted', proxyEvents)`。这样设计是为了让「启动完成」这个信号覆盖所有监听入口：若只等主 server，某个独立端口还没起来就广播了 `whistleStarted`，依赖该端口的插件或界面会扑空。代价是计数初值要按 `_server` 是否存在取 1 或 2，多一个入口就要同步 `++count`，漏一次就永远等不到归零；边界是这个信号只表示「端口都就绪」，不表示「业务数据已就绪」——后者还要等 `biz/init`。

**为什么 `request` 事件要等 `biz/init` 完成才挂**：`lib/index.js:208-211` 把 `server.on('request', app)` 放进 `require('../biz/init')` 的回调里，是因为界面路由、规则与插件要先初始化；否则端口虽然已在监听，进来的请求却会在没有任何规则的情况下被处理。把这句展开：`biz/init` 与端口监听是两条并行的准备线，靠 `count` 汇合，所以启动日志往往比「首个请求可被处理」更早出现——这不是日志写错了，而是两个条件尚未同时满足。代价是启动到真正可用之间有一段「端口通、但请求还没接上」的窗口；边界是这段窗口只影响 `request`，CONNECT 与 Upgrade 走的是另外的入口。

**这套机制的载体**：`proxyEvents` 沿用的正是上一篇讲过的 [EventEmitter](/concepts/04-runtime) 总线，`whistleStarted` 事件把它作为载荷抛出去，让 `biz/init` 之后的订阅者拿到同一个内核对象。把这一点和「先装配、后监听」合起来看，[规则 DSL](/concepts/06-rules) 的加载、插件的就绪、抓包缓存的初始化都发生在 `server.listen` 之后、首个请求被处理之前，正好是 B 组从「静态图」转向「时间线」要补上的那段空白。

**输入 → 动作 → 输出**：输入是 `lib/index.js` 已被合并好的配置与那个 `http.Server`，动作是依次装配四类能力、解析绑定 IP 并检查端口占用、执行 `server.listen`，再把 `count` 逐步减到零后发出 `whistleStarted`，输出是「端口就绪」这个信号与挂在 `biz/init` 回调里的 `request` 处理链。把三步连起来，就能理解为什么本篇叫「到端口监听」而不是「到首个请求」——真正接客还要等下一道准备线。

**代价与边界（补）**：`process.whistleStarted = true` 与 `process.emit('whistleStarted', proxyEvents)` 挂在 `count` 归零处，意味着所有依赖「启动完成」的订阅者都压在同一个事件名上；好处是只有一处判定，代价是任何一个监听入口漏掉 `++count`，整条链就永远等不到这个事件，而症状只是「插件或界面没反应」，不会报错。边界是这个事件只发一次，运行期配置变化走的是另一套通知，不能复用它。

**为什么「启动完成」要拆成两个信号**：端口就绪由 `count` 归零后的 `whistleStarted` 表示，业务就绪由 `biz/init` 回调里挂上 `request` 表示，两者不是一回事。把结论展开：前者回答「能不能连上」，后者回答「连上之后有没有人按规则处理」；合成一个信号就会让 `w2 status` 这类只读查询误以为服务已完全可用，或让插件在规则未加载时就开始工作。代价是排障时要分别确认这两条线，日志里「已监听」不等于「已就绪」；边界是这两个信号都只在启动期发生一次，运行期没有第二个 `whistleStarted`。

**打个比方**：启动像开一家店——先按图把货架、收银、监控装好（四次装配），再拉开卷帘门（`server.listen`），但真正开始接待顾客要等店员到齐（`biz/init` 完成才挂 `request`）；`count` 就是那张「还有几个门没开完」的清单，少划掉一项就不算正式营业。

**自己验证**：执行 `w2 start` 后立刻执行 `w2 status`，能看到端口与启动参数；再对照本篇 `lib/index.js:208-211` 那句「端口可能已经处于监听状态，但业务数据、规则、插件就绪之前 `request` 事件尚未挂上」，就能理解为什么「查得到状态」不等于「首个请求已经被完整处理」——两者差在 `biz/init` 这条并行准备线上。

**从静态图到时间线的转折**：上一篇把四类入口、中间件链、事件总线画成一张平面图，回答的是「在哪」；本篇把最前面那段竖起来按时间读，回答的是「谁先谁后」。两套视角缺一不可：只看图，不知道 `biz/init` 与端口监听谁先完成；只看时序，又不知道这四次装配对应图上的哪个方框。代价是读的时候要不停在两张图之间对照；边界是本篇只走到「端口就绪」，运行期的进程与配置形状留给下一篇。

**为什么这一组三篇要连着读**：前一篇定位文件、本篇排定次序、下一篇补齐运行期，正好对应「在哪 / 何时 / 改了之后怎样」三个问题。跳过任何一篇，下一篇里反复出现的那些事件与配置对象都会变成没有来由的名词；B 组是「从模型落到代码」的接缝，术语密度也在这里陡增，遇到生词回概念精解查一次比硬猜更省时间。

**一个可带走的判断**：以后再看到「服务已经起来」这类描述，先问是端口就绪、业务就绪，还是插件就绪；本篇的 `count` 与 `biz/init` 说明这三者并不同步。把这个问题意识带到下一篇，就能理解为什么配置改了不需要重启、却需要三条通知路径——启动期只发生一次，运行期靠的是另一套机制。

**代价与边界的总账**：把入口脚本收敛成「导出函数」、把参数收敛成 `--data`、把启动完成收敛成 `count` 归零，三处都是用「单一判据」换「可预测」；代价是任一处判据漏写或错位，症状都不会当场报错，而是表现为「没反应」或「参数没生效」。边界是这三处都只管启动期，运行期的变化一概不走它们——这正是下一篇要补的半张图。

## 常见误解

1. **容易以为 `w2` / `whistle` / `wproxy` 是三套命令实现，其实它们都指向 `./bin/whistle.js`**：差别只在 `getName()` 取到的展示名；以为要分别排查，就会在三个名字之间来回试，而真正该看的只有 `argv[2]` 那一处分发。
2. **容易以为根 `index.js` 被 `require` 就会立刻监听端口，其实它只导出一个待调用的函数**：`--data` 里的参数要先经 bootstrap 解出、再传给这个函数；否则端口、存储目录与认证根本来不及注入，见[《概念精解 · Node 运行时与内核骨架》](/concepts/04-runtime)。
3. **容易以为 `server.listen` 一返回就等于「可以处理请求了」，其实端口监听与 `biz/init` 是两条并行准备线**：只有 `count` 归零才发 `whistleStarted`，且 `request` 事件要等后台初始化完成才挂上；启动日志早于首个可用请求，正是这个时间差，对照见[《易混淆概念辨析》](/concepts/08-confusions)。
4. **容易以为 `w2 run` 与 `w2 start` 只是前/后台之差，其实 `w2 run <plugin>` 会被 `:253-256` 拦截成插件命令**：判据是 `argv[3]` 是不是选项；写自动化脚本时把这个分叉当成「同一个命令」，就会莫名其妙跑起某个插件而不是服务。

## 小结

- `package.json:30-34` 的三个可执行名统一指向 `bin/whistle.js`，由 `argv[2]` 分发命令。
- `starting` 以 detached `cp.spawn` 守护化，options 经 `--data` JSON 传给 bootstrap，后者 `require(main)` 后调用导出函数；根 `index.js` 因此不自启动。
- `main(options)` 返回 `index.js#<enc>#` 作为实例去重键，PID 与 options 存于 `~/.startingAppData`。
- `index.js` 先 `config.extend(options)`，再 `require('./lib')(callback, server)`；`--config` 与 `--cluster` 是两条可选分支。
- `lib/index.js:93` 开始监听，所有监听计数归零才发 `whistleStarted`；`biz/init` 完成后才挂 `request` 事件。
- 本篇为 [《进程模型与配置系统》](/architecture/process-config) 准备了「启动时序」这条时间线：正因为四类能力、配置合并与 `request` 挂载的先后都已厘清，08 才能接着问「跑起来之后配置怎么改、进程怎么互通」。

## 下一步

[《进程模型与配置系统》](/architecture/process-config)：服务已经监听端口，接着看它由哪些进程组成、配置如何合并与变更通知。 紧接着读它，是因为本篇结束在「端口就绪、`whistleStarted` 已发出」这一刻，还没回答「之后配置改了怎样通知到各处、插件与后台服务以什么进程形态存在」；08 把静态的启动时序延续成运行期的进程与配置关系，并把本篇只点了一下的 `biz/init` 与 `options.cluster` 分支各自展开。
