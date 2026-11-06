---
title: 进程模型与配置系统
description: 拆解 CLI、常驻业务进程与 pfork 子进程三层结构，以及配置单例的合并与变更通知。
---

# 进程模型与配置系统

上一篇走完了启动时序，本篇回答「服务跑起来之后是什么形状」：它由几类进程组成，配置对象从哪里来、如何合并、改了之后怎样通知到各处。这里还埋着一个最容易望文生义的坑——`lib/init.js` 名字像初始化模块，实际上却是每个请求都会经过的 Express 中间件。把这些理清，再读后面的请求链路才不会把「启动期」与「请求期」混为一谈。

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

## 小结

- 进程分 CLI、detached 业务进程、pfork 子进程三层；通信兼用 `sendData` 消息与 `127.0.0.1:<port>/cgi-bin/*` HTTP。
- `--cluster` 默认关闭，仅在 `index.js:199-213` 显式传入时 fork worker，靠 1 秒 `'1'` 心跳与 master 12s / worker 10s 超时自愈。
- `config` 是 `extend(exports, pkgConf)` 单例，优先级为 package.json < `~/.whistlerc` < CLI options，未传字段由 `variableProperties` 回退默认。
- `sockets` 是 agent 的 `maxSockets` 且默认禁用缓存，`timeout` 是 server 空闲超时；`--storage` 把数据挪到 `custom_dirs/<enc>/`。
- 变更通知有事件、修改戳、子进程消息三条路径；`lib/init.js` 是每请求中间件而非初始化函数。

## 下一步

[《一次 HTTP 代理请求的旅程》](/core/http-request)：配置与进程就位后，跟随一个普通 HTTP 请求走完从 `request` 事件到出站响应的完整链路。
