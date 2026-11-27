---
title: 进程模型与配置系统
description: 拆解 CLI、常驻业务进程与 pfork 子进程三层结构，以及配置单例的合并与变更通知。
---

# 进程模型与配置系统

上一篇走完了启动时序，结束在「端口就绪、启动完成」这一刻，却留下一个尚未回答的问题：服务随后是以什么形态常驻的、配置改了怎样传到各处。本篇回答「服务跑起来之后是什么形状」：它由几类进程组成，配置对象从哪里来、如何合并、改了之后怎样通知到各处。这里还埋着一个最容易望文生义的坑——`lib/init.js` 名字像初始化模块，实际上却是每个请求都会经过的 Express 中间件。把这些理清，再读后面的请求链路才不会把「启动期」与「请求期」混为一谈，也能对照 `~/.WhistleAppData/.whistle/` 判断一份配置究竟落在哪。

::: tip 先修知识
先做 [第 0 站](/guide/quickstart)：本篇把那次启动与运行拆成了代码时序。

若某个名词卡住，按主题回查 [概念精解总览](/concepts/index) 与 [《全量术语索引》](/concepts/glossary)；正文在术语首次出现处也给了对应链接。

不需要预先读过源码，但能分清「启动期只装配一次」与「请求期每请求都执行」就够了；成组混淆可查 [《易混淆概念辨析》](/concepts/08-confusions)，忘记名词查 [《全量术语索引》](/concepts/glossary)。
:::

![三层进程与配置单例的关系](/diagrams/process-config.svg)
*图注：CLI 短命、业务进程常驻、pfork 子进程按功能隔离；配置单例贯穿三层并对外广播变更。*

## 三层进程与两种通信

Whistle 的进程不是一层，而是职责分明的三层。最外层是 CLI 进程：执行 `w2 start` 时解析参数、发起守护化、打印提示后即退出。中间层是 detached 业务进程，也就是真正持有主端口、运行 Express 中间件链的常驻进程。最内层是 pfork 子进程，由 `pfork` 依赖（`package.json:57`）拉起，把第三方代码与代理主进程隔开。

三类子进程的入口各不相同：后台服务 `lib/service/index.js:17-32` 的 `getOptions()` 把 config 中的标量字段序列化成 fork 参数，再由 `:51` 的 `fork(...)` 拉起 `service.js`；每个插件由 `lib/plugins/index.js:620-670` 的 `loadPlugin` 单独 `p.fork`，按需加载并缓存端口；weinre 则由 `biz/weinre/index.js:11-20` 在请求到来时才 `fork(options, callback)`。插件是第三方代码，崩溃或内存泄漏不该带走代理主进程，这是按功能隔离而非按 CPU 隔离的核心动机。

::: cols 20|32|48
| 层级 | 载体 | 职责 |
|---|---|---|
| CLI | bin/whistle.js | 解析参数、守护化、退出 |
| 业务进程 | index.js / lib | 监听端口、跑中间件链 |
| service | service.js | 后台服务与安装任务 |
| 插件 | pfork 各插件 | 第三方规则与界面 |
| weinre | server.js | 远程调试服务 |
:::

主进程与子进程之间有两套通信方式并存。消息通道是 `child.on('data', ...)` 接收与 `child.sendData({type})` 发送，例如 `lib/service/index.js:61-72` 处理 `whistleIdChange`、`w2NetworkInterfacesChange` 等类型并回发 `whistleId`；数据通道则是本地 HTTP：`lib/service/index.js:171` 直接请求 `http://127.0.0.1:<curOptions.port>/cgi-bin/service/save`。前者传控制信号，后者传结构化数据，两条通道互不抢占。子进程侧对应 `process.sendData({type})`（如 `lib/service/service.js:342`、`:582`），与 `child.sendData` 是同一套 pfork 消息机制的两端。

**为什么按功能隔离而不是按 CPU 隔离**：把「插件是第三方代码」这句展开——第三方代码不可信，崩溃或内存泄漏若发生在主进程，带走的就是整个代理与所有正在经过的请求；把后台服务、每个插件、weinre 各自放进 pfork 子进程，等于给每类功能划了独立的故障域，某一个挂了只影响它自己。这与 cluster 的「多核利用」方向不同：前者怕的是「被带崩」，后者怕的是「一颗核跑不满」。代价是每个子进程都要单独拉起、单独传参，启动更慢、占用的内存也更多；边界是隔离只挡住运行环境的故障，插件写出的规则或配置仍在主进程生效，配置层面的影响并未被隔离。

**两种通信为什么并存**：消息通道（`child.on('data', ...)` 收、`child.sendData({type})` 发）传的是 `whistleIdChange`、`w2NetworkInterfacesChange` 这类控制信号，短小、要求及时；数据通道走本地 HTTP（`http://127.0.0.1:<curOptions.port>/cgi-bin/service/save`）传的是结构化数据，可以稍大、需要落到已有的 `cgi-bin` 逻辑里。把两者分开，是为了让「控制信号」不被「大块数据」堵住，反过来也不必为一条状态变更单开一次本地请求。代价是排障时要先分清问题在哪条通道——消息丢了看 `child.on('data', ...)` 的订阅，数据没落盘看那次本地请求；边界是两条通道都只在主进程与子进程之间，前端界面另有自己的轮询路径。

**输入 → 动作 → 输出**：这一段的输入是配置里的标量字段与运行期的功能任务，动作是 `getOptions()` 把标量序列化成 fork 参数、再由 `fork(...)` 拉起对应子进程，输出是各自独立运行的服务、插件或 weinre，以及它们经 `process.sendData({type})` 回传的消息。三段对上号，就能明白为什么表格里「层级」一列越往下越细：每往下一层，都是把上一层不想承担的风险或职责再切出去一块。

**自己验证**：执行 `w2 start` 把服务拉起来，再到 `~/.WhistleAppData/.whistle/`（用户主目录下的隐藏目录：macOS / Linux 用 `cd ~/.WhistleAppData`，Windows 在用户目录的 `.WhistleAppData`，也可先 `w2 status` 确认实例）下看 `rules` / `values` / `properties` / `certs` 是否齐备；这几类数据落盘的位置，正是主进程与子进程都要读写、却不必共享内存的那份「共同事实」——它解释了为什么两层通信可以各管一段，而不必把所有状态都塞进消息里。

## cluster：与 pfork 正交的另一条线

`--cluster` 解决的不是隔离而是多核利用，默认并不启用。`index.js:199-213` 只有在 `options.cluster && cluster.isMaster` 时才计算 worker 数量并循环 `forkWorker(i)`；否则直接落到 `startWhistle()`。它与 pfork 子进程是两条正交的线：worker 分担同一个主端口，pfork 子进程承载独立功能，两者可以同时存在。

```js
// index.js:14-16
var INTERVAL = 1000;
var TIMEOUT = 10000;
var MASTER_TIMEOUT = 12000;
```

`index.js:99-141` 的 `forkWorker` 实现了一套双向心跳与自愈：master 侧 `worker.on('message')`（`:123-140`）只认 `'1'`，收到后置 `state[index] = true`、用 `INTERVAL`（1 秒）起 `worker.send('1', noop)` 定时向 worker 发心跳，并把 `refork` 看门重置为 `MASTER_TIMEOUT`（12 秒）；worker 侧在 `require('./lib')` 回调里 `process.send('1', noop)` 并每秒定时重发（`index.js:191-196`），同时用 `process.on('message', activeTimeout)`（`:190`）收 master 心跳刷新 `activeTimeout()`——后者以 `TIMEOUT`（10 秒）看门，超时便 `process.exit(1)`。任一侧 `disconnect` 或 `exit` 都会触发 `refork`，先 kill 旧 worker 再延时 600 毫秒重拉（`index.js:113-118`）。

为避免多个 worker 抢同一份数据，`index.js:165-172` 给每个 worker 强制追加形如 `.__cluster_worker.<index>_...__` 的 storage 后缀。这也解释了上一篇提到的去重键为何要带 storage：worker 与多实例都靠它区分彼此的配置目录。

**为什么心跳要双向**：`index.js:99-141` 里 master 只认 `'1'`，收到后置 `state[index] = true`、用 `INTERVAL`（1 秒）定时向 worker 发心跳并把 `refork` 看门重置为 `MASTER_TIMEOUT`（12 秒）；worker 侧在 `require('./lib')` 回调里回 `'1'`，同时用 `TIMEOUT`（10 秒）看门收 master 心跳，超时便 `process.exit(1)`。两边各盯各的，是因为「worker 卡住」与「master 卡住」是两种不同的故障：只由 master 探活，master 自己僵住时没人重拉 worker；只由 worker 探活，worker 假死时 master 又不知道。双向心跳把两侧都纳入看门，`disconnect` 或 `exit` 任一发生都触发 `refork`。代价是 1 秒一次的心跳与三档超时常量成了硬编码约定，调参要同时改两侧才不会误判；边界是它只保活 worker 进程，不保活业务数据——`refork` 后新 worker 仍从自己的 storage 后缀重新开始。

**为什么每个 worker 要带 storage 后缀**：`index.js:165-172` 强制追加 `.__cluster_worker.<index>_...__`，是为了让多个 worker 不抢同一份运行记录与数据目录。把这条和上一篇提到的去重键连起来：启动期按 storage 区分运行记录，worker 又各自改了 storage，于是「多实例」与「多 worker」复用同一套按目录区分的机制，不必另写一套。代价是目录名里混进了 worker 序号，人工排查时要先看清是哪一份；边界是它只解决「数据不打架」，不解决「端口怎么分」——worker 仍靠 cluster 分担同一个主端口。

**打个比方**：pfork 像把不同工种安排进相隔的房间，一间着火不烧到别间；cluster 像同一间房里多招几位同样的师傅轮班干活，谁累倒了由工头（master）按心跳再补一位。前者防「互相带崩」，后者求「别闲着」，所以两条线能同时存在。

**自己验证**：对照代码块里 `INTERVAL = 1000`、`TIMEOUT = 10000`、`MASTER_TIMEOUT = 12000` 三个常量，问自己「哪一侧盯哪一侧、超时后谁退出」；能答对 worker 超时 `process.exit(1)`、master 超时 `refork`，就理解了双向看门为什么不是多余的一层。

## 配置单例：合并优先级与目录

`lib/config.js:16` 只有一行 `var config = extend(exports, pkgConf);`，却奠定了整个配置系统的形态：模块导出对象本身被就地扩展成全局单例，任何 `require('./config')` 拿到的都是同一个引用，因此启动期写入一次，运行期处处可见。

```js
// lib/config.js:608-610
variableProperties.forEach(function (name) {
  config[name] = newConf[name] || pkgConf[name];
});
```

合并优先级写在 `lib/config.js:493-509` 的 `extend(newConf)` 里：`:497` 先 `readWhistleRc(newConf)` 读 `~/.whistlerc`，`:498` 再 `extend({}, rcConf, newConf)`，于是形成 `package.json` 默认字段 < `~/.whistlerc` < CLI options 的覆盖顺序。`:507-508` 把 `WHISTLE_MODE` 环境变量拼进 `mode`，这也是 `--init` 能以 `persistentCapture` 影响行为的原因；`:608-610` 则让 `variableProperties`（`:39-58`，含 `sockets`、`storage`、`baseDir`、`rules`、`values` 等）在未显式传入时回退到 `pkgConf` 默认值，避免 undefined 覆盖默认值。

数据目录固定在 `~/.WhistleAppData/.whistle/`：根路径由 `lib/util/common.js:598-599` 给出，`.whistle` 来自 `package.json:5` 的 `dataDirname`，其下 `rules` / `values` / `properties` 由 `lib/config.js:148-150` 定义。证书落在 `lib/https/ca.js:19-33` 的 `certs` 目录，自定义插件目录则是 `config.CUSTOM_PLUGIN_PATH`（`lib/config.js:144`）。传入 `--storage` 时，`lib/config.js:1067-1091` 把存储重定向到 `custom_dirs/<encodeURIComponent(storage)>/`，并重新拼出 rules / values / properties 三个子目录——这正是多实例互不干扰的落盘体现。

两个数值开关也常被误读。`sockets=256` 不是监听端口数，而是 `HttpAgent` / `HttpsAgent` 的 `maxSockets`：`lib/config.js:1039-1048` 构造 `agentConfig`，且 `:1046` 的 `disableAgent = !newAgentConf && !useAgent` 在默认路径下直接把 agent 置为 `false`，即主动关掉连接缓存以规避 Node 11 以上的缓存缺陷（`:1045` 注释）。只有显式传入 `agentConfig`（`:522`）或 `--mode agent`（`:726-727` 置 `useAgent = true`）时 `disableAgent` 才为假、真正 `new HttpAgent(...)`；`config.sockets` 还会先经 `:1035` 规整为至少 1，`config.strict` 下抬到至少 360。也就是说 256 只是常规模式的 `maxSockets` 默认上限，且默认路径根本不生效。`timeout=360000` 则是 `lib/index.js:44-45` 写入 `server.timeout` 的空闲超时，同时 `requestTimeout` 被置零。

```js
// lib/config.js:1039-1048
var agentConfig = newAgentConf || {
  maxSockets: config.sockets,
  keepAlive: true,
  keepAliveMsecs: KEEP_ALIVE_MSECS,
  maxFreeSockets: 0
};
var disableAgent = !newAgentConf && !useAgent;
config.httpAgent = disableAgent ? false : new HttpAgent(agentConfig);
config.httpsAgent = disableAgent ? false : new HttpsAgent(agentConfig);
```

**为什么用 `extend(exports, pkgConf)` 就地扩展导出对象**：`lib/config.js:16` 只有一行，却让「模块导出对象本身」成了全局单例——任何 `require('./config')` 拿到的都是同一个引用，启动期写入一次，运行期处处可见。把结论展开：若改成每次 require 返回一份新对象，启动期合并的 CLI 参数就只在那个模块里有效，别的模块读到的仍是默认值，配置等于没生效；就地扩展用「同一个引用」换来了「一处写、处处读」。代价是配置成了全局可变状态，任何模块都能改，改动的来源不再能从函数签名上看出来；边界是它只保证「同进程内可见」，子进程与前端界面读不到这个对象，得靠消息与轮询。

**为什么优先级是 package.json < `~/.whistlerc` < CLI options**：`extend(newConf)` 先 `readWhistleRc(newConf)` 读用户级配置，再 `extend({}, rcConf, newConf)` 让后写的覆盖先写的，于是「出厂默认 → 用户习惯 → 本次启动」逐层收窄。这样排是因为越靠后的来源越具体、也越临时：改包默认值影响所有用户，写 `~/.whistlerc` 只影响本机，敲一次 CLI options 只影响这一回。代价是同一个字段可能在三处都有值，排查「为什么没生效」要按这个顺序逐一比对；边界是 `variableProperties` 只让未显式传入的字段回退默认，显式传入的空值不会被悄悄补回，属于「信任调用方」的取舍。

**`sockets` 与 `timeout` 为什么容易被误读**：`sockets=256` 管的是 `HttpAgent` / `HttpsAgent` 的 `maxSockets`（出站连接池），`timeout=360000` 管的是 `server.timeout`（空闲超时），一个朝向源站、一个朝向客户端，本就不是一个维度；更反直觉的是默认 `disableAgent = !newAgentConf && !useAgent` 为真时，agent 直接被置为 `false`，连接池根本不启用，256 只是常规模式的上限。把这两句展开：调大 `sockets` 是减少高并发出站时的排队，并不会让端口接更多客；`requestTimeout` 被置零也只是不让 Node 默认超时切断长连接，空闲超时仍在。代价是「默认值看起来生效、其实默认路径没启用」，不读这段源码很容易按字面调优；边界是只有显式传入 `agentConfig` 或 `--mode agent` 才真正创建 agent。

**`--storage` 为什么能把实例隔开**：`lib/config.js:1067-1091` 把存储重定向到 `custom_dirs/<encodeURIComponent(storage)>/`，并重新拼出 rules / values / properties 三个子目录，等于给每个实例一整套独立落盘数据。把这条和前两篇连起来：启动期用 storage 做去重键，worker 用 storage 后缀分目录，这里再用同一个值换目录，三层复用一个概念，多实例互不干扰才不需要额外开关。代价是目录名被编码过，人工找文件时要先解出原值；边界是它只挪数据目录，端口仍要各自配置，单靠 `--storage` 不能让两个实例同时监听同一端口。

**输入 → 动作 → 输出**：输入是 package.json 默认字段、`~/.whistlerc` 与 CLI options 三份来源，动作是 `extend(newConf)` 按优先级合并、`variableProperties` 回退未传字段、再把 `WHISTLE_MODE` 拼进 `mode`，输出是那个被就地扩展、全进程共享的 `config` 单例，以及由它决定的 `rules` / `values` / `properties` / `certs` 落盘位置。三段对上号，就能回答「改了配置谁先看到」：同进程内立刻可见，跨进程与跨界面要走下一段的三条通知路径。

**自己验证**：执行 `w2 start` 把服务拉起来，到 `~/.WhistleAppData/.whistle/` 下数 `rules` / `values` / `properties` / `certs` 四个目录；再对照 `--storage` 一段说的 `custom_dirs/<encodeURIComponent(storage)>/`，就能明白「同一套子目录被整体复制一份」正是多实例隔离的落盘体现，而 `sockets=256` 与 `timeout=360000` 这两个数并不会在这份目录里出现——它们属于出站与超时，不属于落盘配置。

## 变更通知的三条路径

配置改动要同时让内核、前端界面与子进程感知，代码里用了三条并行的路径，而非一个统一总线事件。

::: cols 22|38|40
| 路径 | 触发点 | 消费方 |
|---|---|---|
| 事件广播 | rulesDataChange 等 | 插件与内核监听者 |
| 修改戳 | setModified | 前端 checkDataChanged |
| 子进程消息 | process.sendData | service 子进程 |
:::

第一条是 `proxyEvents.emit(...)`：`lib/rules/util.js:130-396` 在规则增删改时发 `rulesDataChange`，`:434-466` 在值变动时发 `valuesDataChange`，`lib/plugins/index.js:220` 发 `pluginsChange`。第二条是修改戳：`lib/config.js:1126-1134` 的 `setModified(clientId, isRules)` 写入 `mrulesClientId` / `mrulesTime` 或 `mvaluesClientId` / `mvaluesTime`，`biz/webui/cgi-bin/get-data.js:41-44` 把它们随每次轮询返回，前端 `biz/webui/htdocs/src/js/data-center.js:903` 的 `checkDataChanged` 比对后决定重拉规则或值。第三条是子进程消息：`lib/service/service.js:342` 用 `process.sendData({type: 'whistleIdChange'})` 把变化推回主进程。这里的前端 `data-center.js` 与服务端 `lib/service/data-center.js:8` 的 `MAX_COUNT = 100` 只是同名文件，职责不同（后者裁剪上报历史列表，详见[抓包篇](/core/capture-data)「上报通道」），不要混为一谈。

```js
// lib/config.js:1126-1134
config.setModified = function (clientId, isRules) {
  if (isRules) {
    config.mrulesClientId = clientId || '';
    config.mrulesTime = Date.now();
  } else {
    config.mvaluesClientId = clientId || '';
    config.mvaluesTime = Date.now();
  }
};
```

三条路径的分工很清楚：同进程内用事件最轻，跨轮询用时间戳最省连接，跨进程用消息最可靠。它们共同绕开了「每次改规则都全量广播」的开销。

**为什么是三条路径而不是一条总线事件**：把「配置改动要同时让内核、前端界面与子进程感知」展开——同进程内的插件与内核监听者用 `proxyEvents.emit(...)` 最轻，一次调用即达；前端界面是跨轮询的，每次拉数据时顺带比对修改戳最省连接，不必为一条变更单开长连接；子进程是跨进程边界，收不到本进程事件，只能用 `process.sendData({type})` 推消息。三者面向的是三种不同的「距离」，硬凑成一个总线事件反而要在每种边界上各做一次适配。代价是同一处改动要在三处各写一遍通知代码，漏一条就出现「界面没刷新」或「子进程没跟上」；边界是它们都只通知「变了」，不负责把新值搬运过去——真正的取数仍由各自的消费方按原路径去读。

**修改戳为什么用时间戳而不是全量广播**：`setModified(clientId, isRules)` 写入 `mrulesClientId` / `mrulesTime` 或 `mvaluesClientId` / `mvaluesTime`，前端 `checkDataChanged` 比对后才决定重拉规则或值。这样每次轮询只多带两个小字段，配置再大也不占用带宽；把「谁改的」`clientId` 一起记下，还能让发起改动的那端不必重复拉自己刚写的数据。代价是界面感知变更永远有最多一次轮询间隔的延迟，且时间戳只说明「变过」、不说明「变成什么」；边界是它服务于前端轮询这一条消费路径，内核与子进程仍走各自那两条。

**为什么两个同名 `data-center.js` 要分清**：前端 `biz/webui/htdocs/src/js/data-center.js` 负责拉数据与比对修改戳，服务端 `lib/service/data-center.js` 的 `MAX_COUNT = 100` 只裁剪上报历史列表，二者同名却不同职。把这条和抓包链路连起来看：[抓包](/concepts/05-capture) 数据的「上报通道」与「界面取数」本就是两段，一个同名文件最容易让人以为前端直接读了服务端那份缓存。代价是排障时按文件名搜索会同时命中两处，必须先看路径再判断；边界是本篇只点出这个坑，上报通道的完整链路留到后面的抓包篇。

**这套机制的载体**：第一条路径 `proxyEvents.emit(...)` 沿用的正是 [EventEmitter](/concepts/04-runtime) 总线；`rulesDataChange`、`valuesDataChange`、`pluginsChange` 这些事件名就是「看不见的调用关系」。把三条路径合起来看，[规则 DSL](/concepts/06-rules) 的增删改、值的变动、插件的装卸都走这套通知，而不是重启服务——这正是配置单例「一处写、处处读」在运行期的兑现方式。

**输入 → 动作 → 输出**：输入是一次规则 / 值 / 插件的改动，动作是 `setModified` 写修改戳、`proxyEvents.emit(...)` 广播事件、`process.sendData({type})` 推子进程消息三条并行，输出是内核监听者、前端 `checkDataChanged` 与 service 子进程各自感知到「有变化」，再按自己的路径重拉数据。三段分开看，就能解释为什么改一条规则不用重启：变化被通知出去，而配置本身一直在那个共享单例里。

**自己验证**：对照表格「路径 / 触发点 / 消费方」三列，问自己每一列的消费方离改动点有多远——同进程、跨轮询、跨进程；能按这个距离把三行对上号，就不会再把「修改戳」当成「数据本身」，也不会指望一个 `proxyEvents.emit(...)` 能直接刷新界面。

## lib/init.js 其实是每请求中间件

最后澄清命名陷阱。`lib/init.js:157` 导出的是 `function (req, res, next)`，这是标准的 Express 中间件签名，而非启动期初始化函数；它由 `lib/index.js:40` 的 `middlewares` 数组第一项引入，每个请求都会执行一次。

```js
// lib/init.js:157-162
module.exports = function (req, res, next) {
  util.removeSpecPath(req);
  PipeStream.wrapSrc(req);
  PipeStream.wrapDest(res);
  addTransforms(req, res);
  addErrorEvents(req, res);
```

它在本请求上做四件事：`PipeStream.wrapSrc/wrapDest`（`:159-160`）把 `req` / `res` 包装成可插拔的双向流，`addTransforms`（`:87-155`）挂上 `addTextTransform` / `addZipTransform` 等改写能力，`addErrorEvents`（`:9-30`）统计请求数并兜底错误，`:166-189` 解析客户端 IP、端口与 clientId。`:235-260` 还定义了 `res.response`，作为后续所有出站响应回写客户端的统一入口。之所以叫 `init`，是「初始化本次请求的上下文」，与进程启动毫无关系——下一篇的 16 步链路正式从这里起步。

**为什么名字会骗人**：`lib/init.js:157` 导出的是 `function (req, res, next)`，`next` 是 Express 中间件的标志性参数；它由 `lib/index.js:40` 的 `middlewares` 数组第一项引入，每个请求都会执行一次。把结论展开：`init` 指的是「初始化本次请求的上下文」，不是「初始化进程」；进程级初始化早在上一篇的启动时序里就完成了。若真把它当启动模块，就会以为 Transform 能力只在开机时挂一次，而实际上每个请求的 `req` / `res` 都要重新包一遍。代价是这个命名让第一次读源码的人极易找错阶段；边界是它虽每请求执行，却只碰「本次请求」的上下文，不碰全局配置与子进程。

**每请求做四件事的理由**：`PipeStream.wrapSrc/wrapDest` 把 `req` / `res` 包装成可插拔的双向 [Stream](/concepts/04-runtime)，`addTransforms` 挂上 `addTextTransform` / `addZipTransform` 等改写能力，`addErrorEvents` 统计请求数并兜底错误，`res.response` 作为后续所有出站响应回写客户端的统一入口。四件事合成一层「支点」：后面的规则匹配、请求改写、响应改写都只管往这两个流上插变换，不必各自处理底层收发。代价是每个请求都要付出一次包装与事件挂载的开销；边界是它只准备「能改写」，真正改不改、怎么改由链上后面的阶段决定。

**输入 → 动作 → 输出**：输入是刚进门的原始 `req` / `res`，动作是包装成双向流、挂改写与错误事件、解析客户端 IP / 端口 / clientId、定义 `res.response`，输出是一对「可被后续各阶段安全改写」的请求与响应对象，以及统一回写入口。把这三段和上一篇的链序对上，就明白本篇结尾为什么要专门澄清这个命名：下一篇的 16 步链路，第一步正是从这里起步，而不是从一次新的进程初始化起步。

**打个比方**：`lib/init.js` 像餐厅每桌开席前铺的餐桌垫与餐具，不是装修厨房——每来一桌（每个请求）都要铺一次，之后上菜、调味、撤盘（改写与出站）都在这套摆好的餐具上进行；把它当成「装修」，就会奇怪为什么每桌都要重新铺。

**自己验证**：对照代码块的 `function (req, res, next)` 签名，数一数参数里有没有 `next`、再看它有没有任何启动相关调用；答案是有 `next`、没有启动动作，正好印证「这是每请求中间件」。再顺着 `lib/index.js:40` 的 `middlewares` 数组看它排在第一位，就能把它和上一篇的链序接起来。

**为什么三层不是「三个进程」这么简单**：CLI 退出后只剩业务进程常驻，pfork 子进程又是按需拉起、随时可灭的，所以某一时刻实际存在的进程数并不固定。把「三层」理解成三种角色而非三个常驻实例，才不会奇怪为什么刚 `w2 start` 完看进程列表只有一两个；代价是排障时不能按固定数量去数，得按角色判断谁该在。

**两种通信的代价再补一层**：`sendData` 消息与本地 HTTP 都要求数据可序列化，于是内存里的对象引用、打开的连接句柄都传不过去，只能传「描述」；这逼着跨进程接口设计得偏扁平。边界是正因如此，配置单例才选了「落盘 + 通知」而不是「把对象推给子进程」——后者在这个模型里根本做不到。

**为什么默认关闭 `--cluster`**：多核利用听着总是好的，但多 worker 意味着多份配置目录、多套心跳状态与更复杂的排障路径，而代理工作负载多半卡在等待网络而非 CPU；默认单进程能让「看到的现象 = 一个进程的行为」这条对应关系保持简单。代价是重 CPU 场景下要手动开启并自行确认收益；边界是它解决不了隔离问题，插件崩溃仍要靠 pfork 那一层。

**把两条正交线合起来看**：pfork 按功能切、cluster 按算力切，两个维度可以叠成网格——一个 cluster worker 内部仍可拉起自己的 pfork 子进程。代价是进程树会变得很深，日志里要同时分辨 worker 序号与功能名；边界是无论怎么叠，配置单例只在各自进程内有效，跨进程仍要靠消息或落盘数据。

**为什么「单例」与「运行期改动」不矛盾**：`config` 是同一个引用，所以启动期合并一次就处处可见；运行期改的也是这个引用上的字段，各模块下一次读到的自然是新值，不必重建对象。把两条合起来才能解释「改规则不重启」：不是有人把新配置推送到了每个模块，而是它们本来就共享同一份。代价是任何模块都能改它，写坏一处会静默影响全局；边界是它只在同一进程内共享，跨进程与跨界面才需要三条通知路径。

**为什么把配置与素材、开关、信任分开落盘**：`rules` 是改动最频繁的「配置」，`values` 是可复用的「素材」，`properties` 是零散「开关」，`certs` 是最不该被覆盖的「信任」。四者变更频率与备份策略都不同，混在一个目录里容易在迁移时把证书一起冲掉。代价是查一个行为要翻好几个目录；边界是本篇只讲「落在哪」，规则内容如何匹配、证书如何签发各归其专篇。

**三条路径为什么要按「距离」记**：同进程、跨轮询、跨进程三类消费方，对「及时」与「可靠」的要求各不相同，用一个统一事件反而要在每个边界上各写一次适配。记住「距离」这个判据，比死记三个事件名更耐用：以后新增一类消费方，先判断它离改动点有多远，就知道该挂在哪条路径上。代价是判据是经验性的，边界模糊时仍要回到代码确认；边界是三条路径都只通知「变了」，新值始终由消费方自己按原路径去读。

**命名陷阱的普遍意义**：`lib/init.js` 不是唯一一个名字会骗人的地方——`data-center.js` 前后端同名、`init` 既可能指进程也可能指请求，都提醒我们判断阶段要看签名与调用点，而不是看文件名。把「启动期只装配一次」与「请求期每请求都执行」这条分界带到后面的请求链路，才不会在 16 步里找错起点。

**这一组的收束**：前两篇分别定位文件与排定次序，本篇补齐运行期形状，B 组这一转折段回答的其实是同一个问题的三面——图上的方框对应哪个文件、这些方框何时被装配、装配好之后配置与进程如何保持同步。带着「在哪 / 何时 / 改了之后怎样」这三个问题往后读请求链路，就不会再被启动期与请求期混在一起的名词绊住。

## 常见误解

1. **容易以为 `lib/init.js` 是启动期初始化模块，其实它是每个请求都会经过的 Express 中间件**：签名是 `function (req, res, next)`，`init` 指「初始化本次请求上下文」；把启动期与请求期混在一起，就会以为 Transform 能力只挂一次，对照见[《易混淆概念辨析》](/concepts/08-confusions)。
2. **容易以为 pfork 子进程与 `--cluster` worker 都是「多开几个进程提速」，其实一个按功能隔离、一个按多核分担**：worker 分担同一主端口并各自带 storage 后缀，pfork 子进程承载插件与后台服务、默认按需拉起；二者默认都不启用，见[《概念精解 · 扩展机制与工程化》](/concepts/07-extension)。
3. **容易以为 `sockets=256` 限制的是监听端口数或并发总量，其实它是 agent 的 `maxSockets`，且默认路径根本不启用连接池**：`disableAgent` 为真时 `config.httpAgent` / `httpsAgent` 直接被置为 `false`，只有显式传入 `agentConfig` 或 `--mode agent` 才创建，见[《概念精解 · Node 运行时与内核骨架》](/concepts/04-runtime)。
4. **容易以为改一条规则要重启服务，其实变动是经三条通知路径扩散出去的**：同进程用 `proxyEvents.emit(...)`、跨轮询用 `setModified` 的修改戳、跨进程用 `process.sendData({type})`；配置一直在那个共享单例里，重启并不是前提。

## 小结

- 进程分 CLI、detached 业务进程、pfork 子进程三层；通信兼用 `sendData` 消息与 `127.0.0.1:<port>/cgi-bin/*` HTTP。
- `--cluster` 默认关闭，仅在 `index.js:199-213` 显式传入时 fork worker，靠 1 秒 `'1'` 心跳与 master 12s / worker 10s 超时自愈。
- `config` 是 `extend(exports, pkgConf)` 单例，优先级为 package.json < `~/.whistlerc` < CLI options，未传字段由 `variableProperties` 回退默认。
- `sockets` 是 agent 的 `maxSockets` 且默认禁用缓存，`timeout` 是 server 空闲超时；`--storage` 把数据挪到 `custom_dirs/<enc>/`。
- 变更通知有事件、修改戳、子进程消息三条路径；`lib/init.js` 是每请求中间件而非初始化函数。
- 本篇为 [《一次 HTTP 代理请求的旅程》](/core/http-request) 准备了「运行期形状」这张底图：正因为进程分层、配置单例与每请求中间件都已分清，下一篇才能放心跟随一个普通请求走完从 `request` 事件到出站响应的完整链路，而不必再回头解释启动期。

## 下一步

[《一次 HTTP 代理请求的旅程》](/core/http-request)：配置与进程就位后，跟随一个普通 HTTP 请求走完从 `request` 事件到出站响应的完整链路。 紧接着读它，是因为本篇把「服务跑起来之后是什么形状」讲完了，却始终停在进程与配置的静态层面，还没有让任何一个真实请求走一遍那条中间件链；下一篇把 `lib/init.js` 这个每请求起点接上后续各阶段，静态结构自此变成一次可追踪的旅程。
