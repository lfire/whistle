---
title: CI、嵌入式集成与自动化回归
description: 拆解把 Whistle 当库内嵌到测试进程的启动、隐藏规则注入、节拍器与分页接口，串起自动化回归链路。
---

# CI、嵌入式集成与自动化回归

当调试代理要进流水线，问题就从「怎么点界面」变成「怎么在测试进程里把它拉起来并断言规则真的生效」。CI 里没有交互式桌面，也没有人去装根证书；上游平台还希望把 Whistle 当作按需启动的内部服务。本篇沿官方集成测试与 NPM 模块文档走一遍，读完你能说清 `require('whistle')` 之后配置如何装配、三类隐藏规则如何注入、测试节拍器为何靠 `get-data` 驱动，以及内嵌模式与 CLI 模式到底差在哪。所有片段与阈值都来自集成测试、官方文档或源码。

## 场景与痛点

**一、CI 需要一个可编程的代理实例。** 接口回归要验证「命中 mock 规则后返回指定内容」，如果依赖全局安装的 `w2` 与人工配置的界面状态，用例就无法在干净环境重复执行。更稳妥的做法是把 Whistle 作为库内嵌进测试进程，用代码注入规则、订阅事件并断言。官方测试干脆把代理拉进 `test/index.test.js` 所在进程，用 `storage:'test_'` 开一套独立状态，正是为了让这条链路不受机器既有环境影响。

**二、上游平台按需拉起代理。** 类似 nohost 的场景里，代理不应长期占端口，而是由业务服务在需要时 fork 一个子进程、拿到随机端口再把请求转发过去。这要求入口只做装配、不自己决定守护化方式，也要求存储目录能与日常实例隔离。

**三、断言「规则生效」需要可观测的抓手。** 光看进程启动成功不够，还要确认请求确实经过了代理、重放次数符合预期、抓包会话能被分页取回。官方测试用事件订阅、隐藏规则注入与固定节拍器解决了这件事，而这些接口恰好也是自动化最该复用的部分。

## 可复制的配置

真实内嵌启动片段（来源 `test/index.test.js:105-128`，节选）：

```js
// 来源：test/index.test.js:105-128
var proxy = startWhistle({
  port: config.port, storage: 'test_',
  httpPort: config.httpServerPort, httpsPort: config.httpsServerPort,
  certDir: path.join(__dirname, 'assets/certs'),
  debugMode: true, localUIHost: 'local.whistle.com',
  pluginHost: 'test=test.local.whistle.com',
  mode: 'enableRequestHeaderRules',
  rules: { Default: defaultRules, test: { rules: '...', enable: true } },
  values: values, copy: true
}, startTest);
```

启动后订阅事件、设置 UIHost（来源 `test/index.test.js:130-136`）：

```js
// 来源：test/index.test.js:130-136
proxy.on('tunnelRequest', util.noop);
proxy.on('wsRequest', util.noop);
proxy.on('_request', util.noop);
proxy.setUIHost('_');
proxy.setUIHost();
proxy.setPluginUIHost('test', '_');
proxy.setPluginUIHost('whistle.test', '');
```

三类隐藏规则由测试资产注入，对应 `setMockRules` / `setServiceRules` / `setShadowRules`（来源 `test/index.test.js:29-31,247-249`）：

```js
// 来源：test/index.test.js:29-31,247-249
var mockRules = util.readText('assets/rules/mock.txt');
var serviceRules = util.readText('assets/rules/service.txt');
var shadowRules = util.readText('assets/rules/shadow.txt');
proxy.rulesUtil.setMockRules(mockRules);
proxy.rulesUtil.setServiceRules(serviceRules);
proxy.setShadowRules(shadowRules);
```

每批 30 个用例并发、82 个 units 动态装载，并用 `get-data` 作 10000ms 节拍器（来源 `test/index.test.js:265-295`）：

```js
// 来源：test/index.test.js:265-279
var stride = 30;
var list = testList.slice(0, stride);
list.forEach(function (fn) { fn(); });
// 来源：test/index.test.js:282-295（每 10000ms 打 get-data）
setTimeout(getData, 10000); // /cgi-bin/get-data
```

`repeatCount:3` 验证三次 body 全部到达（来源 `test/units/composer.test.js:68-77`）：

```js
// 来源：test/units/composer.test.js:68-77
body: JSON.stringify({
  url: 'http://127.0.0.1:18080/composer-repeat',
  method: 'POST', body: 'repeat',
  repeatCount: 3, needResponse: true
});
// bodies.should.eql(['repeat', 'repeat', 'repeat'])
```

NPM 集成、Local Agent API 与 CLI 启动方式（来源 `docs/docs/extensions/npm.md`、`api.md`、`cli.md`）：

```bash
# 来源：docs/docs/extensions/npm.md
npm i --save whistle pfork
# 来源：docs/docs/extensions/api.md
w2 root bin/api
# 来源：docs/docs/cli.md
w2 run --inspect
w2 start --config /data/xxx.json
```

把上述接口拼成一段可运行的最小回归脚本（Node CommonJS）：

```js
// 来源：docs/docs/extensions/npm.md、test/index.test.js:105-136、lib/index.js:215-241
const assert = require('assert');
const startWhistle = require('whistle');
startWhistle({ port: 18080, storage: 'ci_' }, (proxy) => {
  const seen = [];
  proxy.on('_request', (req) => seen.push(req.fullUrl));   // 事件订阅
  proxy.setShadowRules('www.test.com file://({"ec":0})');   // 规则整体替换
  assert(proxy.getShadowRules().indexOf('ec') > -1);        // 断言注入成功
  assert.strictEqual(typeof proxy.setUIHost, 'function');   // 导出接口断言
  console.log('内嵌启动完成，_request 监听数', proxy.listenerCount('_request'));
});
```

它与 `w2 start` 的差别很关键：内嵌模式没有 detached 守护进程，不会自动装根证书、也不会改系统代理，`docs/docs/cli.md` 里 `--init` 那类动作都要自己按需触发；回调拿到的 `proxyEvents` 才是操作入口，而不是一个已经配好环境的黑盒。反过来说，正因为它不碰系统状态，才适合在并行任务里一次起多个互不干扰的实例，跑完随测试进程一起退出，不留后台残留。

## 背后的设计思想

**装配与启动分离。** 见 [装配与启动分离](/architecture/process-config)。`index.js:143-148` 只导出一个纯函数，内部 `:173-175` 先用 `config.extend(options)` 统一装配，再交给 `require('./lib')`；守护化（CLI）、嵌入式（CI）、外部 Server 复用各自先注入 `options`，入口不替调用方决定进程形态，这是同一份内核能同时服务 `w2 start` 与 `require('whistle')` 的前提。

**约定优于配置。** 见 [约定优于配置](/modules/webui)。`biz/webui/lib/index.js:387-418` 把 `req.path` 直接拼成 `cgi-bin/xxx.js` 文件名去加载，没有注册表也没有路由表；测试因此只要 `util.request('http://local.whistlejs.com/cgi-bin/get-data')` 就能驱动状态机，自动化用例写起来与普通 HTTP 调用无异。`get-data`、`composer`、`sessions` 等接口都以文件名对外暴露，写用例时不必先维护一份接口清单，新增能力也无需同步改路由配置。

**第三方代码与重活隔离。** 见 [第三方代码必须隔离](/modules/plugins)。插件经 `lib/plugins/index.js:633-647` 的 `p.fork` 跑在独立子进程，`docs/docs/extensions/npm.md` 也明确「强烈建议在独立子进程中运行 Whistle」；CI 里配合 `--no-global-plugins` 可把不确定的第三方代码彻底挡在回归之外。

**内存有界优先。** 见 [内存有界优先](/core/capture-data)。长跑回归会持续产生会话，`lib/util/data-server.js:21-26` 用定长数组与溢出回收限住缓存，`lib/service/composer.js:19` 把重放夹到 100 次，`lib/util/data-server.js:34` 把单页夹到 120 条；这些阈值不是优化，而是让自动化可以整夜跑而不撑爆内存的兜底。

## 源码链路

1. **入口：导出函数与配置装配。** `index.js:143-148` 的 `module.exports` 是纯函数，`:173-175` 调 `config.extend(options)` 后 `require('./lib')(callback, server)`；CLI 与 CI 都从这一个入口进入。见 [装配与启动分离](/architecture/process-config)。
2. **入口：外部 Server 与 cluster 分支。** `index.js:150-163` 复用外部 `http.Server` 并自动分配 `__custom_server_...` 存储，`index.js:199-213` 处理 cluster 且在 `:207` 断言 `!options.server`。见 [进程模型与配置系统](/architecture/process-config)。
3. **应用点：事件与接口绑定。** `lib/index.js:39-52` 建 `proxyEvents` 并把中间件逐个 `bind` 上去，`:82-89` 在回调里 `process.emit('whistleStarted')`，`:215-241` 的 `exportInterfaces` 挂出 `setShadowRules` / `setUIHost` / `rulesUtil`。见 [一次 HTTP 代理请求的旅程](/core/http-request)。
4. **规则解析：运行期整体替换。** `lib/index.js:231-239` 的 `setShadowRules` 改写 `config.shadowRules` 后调 `rulesUtil.parseRules()` 触发全量重编译；`test/index.test.js:247-249` 正是用它注入三类隐藏规则。见 [规则引擎：解析与匹配](/modules/rules-engine)。
5. **应用点：约定式 CGI 与重放上限。** `biz/webui/lib/index.js:387-418` 把路径映射成文件名，`lib/service/composer.js:19,118-120` 的 `getReqCount` 把 `repeatCount` 夹到 `MAX_REQ_COUNT=100`。见 [Web 管理界面](/modules/webui)。
6. **回写/上报：分页接口。** `lib/util/data-server.js:818` 的 `getSessionsForApi` 经 `:34-51` 的 `formatApiOptions` 每页最多 120 条，靠 `startId` / `startTime` 翻页；测试节拍器正是反复打 `get-data` 来推进批次。见 [抓包数据的采集与上报](/core/capture-data)。

## 边界与坑

- **CI 必须用独立 `storage`。** `test/index.test.js:107` 用 `test_`，`docs/docs/extensions/npm.md` 的内部服务模式也建议「设置新存储目录」；否则回归会污染日常的 Rules、Values、证书与会话，甚至把别人的调试现场覆盖掉。
- **`options.server` 与 `cluster` 互斥。** `index.js:207` 直接 `assert(!options.server, 'cannot exist options.server in cluster mode')`，想在 cluster 下复用外部 Server 会立即抛错，二者只能选一。
- **分页与重放都有硬上限。** `lib/util/data-server.js:34` 的 `MAX_COUNT=120` 且 `:36-51` 表明不给 `startId` / `startTime` 只能取首页；`lib/service/composer.js:19,118-120` 把重放夹到 100 次，写用例时不要假设能一次拉全量或无限重放。
- **`--inspect` 仅 `w2 run` 支持。** `bin/whistle.js:95-99` 对 `start` / `restart` 直接报 `Inspector mode only supported with w2 run command` 并退出；`docs/docs/cli.md` 的 `-h` 把它列为通用参数，容易误导成可给后台实例加调试端口。
- **`npm test` 与真实端口。** `package.json:70` 定义 `"test": "npm run lintfix && node test/index.test.js"`，即先跑 `eslint --fix` 再跑用例；`test/config.test.js:3` 固定真实端口 6666，本机已有服务占用会直接导致失败，CI 需保证端口空闲。

## 小结

- 入口是纯函数：先注入 `options` 装配配置，再由调用方决定守护化、内嵌或复用外部 Server。
- 三类隐藏规则经 `setMockRules` / `setServiceRules` / `setShadowRules` 注入，`setShadowRules` 触发全量重编译。
- 约定式 CGI 让测试用普通 HTTP 调用即可驱动状态机，事件订阅与断言提供可观测性。
- 长跑靠有界缓存、100 次重放上限与 120 条分页共同兜底，内存不会随用例数线性增长。
- 内嵌模式不自动装证书、不设系统代理，与 CLI 的环境准备责任完全不同。

## 下一步

[《能力边界、风险与合规》](/scenarios/boundaries)：当代理被放进流水线与共用环境，需要回过头看清解密、证书信任、敏感数据与管理面的边界在哪里。
