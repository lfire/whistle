---
title: A3 接得进 · 把 Whistle 嵌进自己的系统
description: 用 require('whistle') 在 Node 进程内起实例、注入隐藏规则、用事件与断言验证命中。
---

# A3 接得进 · 把 Whistle 嵌进自己的系统

::: tip 先修知识
已完成 [A2 写插件](/practice/a2-plugin)。本关需要 `node -v` 可用，且在项目目录执行过 `npm i whistle`（[26 自动化](/scenarios/automation) 说明 `require('whistle')` 是装配配置的纯函数，不起后台守护进程、不改系统代理、不装证书）。
:::

## 本关目标

把 Whistle 当作库嵌进自己的 Node 进程，用**事件订阅 + 断言**验证一条隐藏规则真的命中，而不是靠肉眼看界面。做完你能把代理能力接进自动化测试。

## 开始前

1. 新建练习目录并装依赖：`mkdir -p ~/whistle-practice/embed && cd ~/whistle-practice/embed && npm i whistle`。
2. 默认 8899 的实例可以并存（本关用独立端口 18080 与独立 `storage`）。
3. 确认 [26](/scenarios/automation) 的「内嵌不起后台进程」这一条——它决定了本关的收尾方式。

## 任务

### 第 1 步 · 写最小可运行脚本

`embed-practice.js`（写法来自 [26 自动化](/scenarios/automation) 与 [28 实验三](/advanced/hands-on)）：

```js
const assert = require('assert')
const startWhistle = require('whistle')
// 若报 Cannot find module 'whistle'：先在本目录执行 npm i whistle
// assert 是 Node 内置模块，不需要安装；assert(条件) 在条件为假时抛错并让脚本退出

startWhistle({ port: 18080, storage: 'ci_' }, (proxy) => {
  const seen = []
  proxy.on('_request', (url) => seen.push(url))   // 实参是 URL 字符串，不是 req 对象
  proxy.setShadowRules('www.test.com file://({"ec":0})')   // 注入隐藏规则
  assert(proxy.getShadowRules().indexOf('ec') > -1)        // 断言注入成功
  assert.strictEqual(typeof proxy.setUIHost, 'function')   // 导出接口断言
  console.log('内嵌启动完成，_request 监听数', proxy.listenerCount('_request'))
})
```

运行：

```sh
node embed-practice.js
```

终端应输出「内嵌启动完成」与监听数。

### 第 2 步 · 用流量验证隐藏规则命中

另开终端：

```sh
curl -s -i -x 127.0.0.1:18080 http://www.test.com/
```

响应应是 `{"ec":0}`（来自 `setShadowRules` 的 `file://`），**不是**真实站点内容。在脚本里把 `seen` 数组打印出来（例如在 `setTimeout` 里 `console.log(seen)`），确认 `_request` 事件收到了这条 URL。

### 第 3 步 · 把它变成断言

在脚本里补一段自动化断言。**代理请求的 `path` 必须是完整 URL（absolute-form）**，写成 `path: '/'` 是直打端口的 origin-form，代理不会按域名匹配规则（这正是 [02](/domain/proxy-basics) 教过的请求行形态）：

```js
const http = require('http')
setTimeout(() => {
  assert(seen.some(u => u.indexOf('www.test.com') > -1), '事件没收到请求')
  const req = http.request({
    host: '127.0.0.1', port: 18080, method: 'GET',
    path: 'http://www.test.com/'          // absolute-form，代理才按域名匹配
  }, (res) => {
    let body = ''
    res.on('data', c => body += c)
    res.on('end', () => {
      assert.strictEqual(body, '{"ec":0}')
      console.log('断言通过：隐藏规则命中，事件数', seen.length)
    })
  })
  req.on('error', e => console.error(e))
  req.end()
}, 1000)
```

把 `node embed-practice.js` 的完整输出贴进工件，再用 `curl -s -i -x 127.0.0.1:18080 http://www.test.com/` 做一次外部对照。**不要为了让断言通过而伪造输出**；断言失败时按下面「没看到预期」排查。

### 第 4 步 · 产出工件

`a3-embed/` 目录：① `embed-practice.js`；② `node embed-practice.js` 的终端输出；③ `curl -x 18080` 的响应输出；④ 事件数组打印；⑤ 一句话说明「内嵌实例与命令行实例的三点不同」。

## 验收（工件可复核）

**该看到**：脚本能独立启动、不报端口冲突；`setShadowRules` 的断言通过；18080 端口能收到请求并返回 `{"ec":0}`；`_request` 事件里有该 URL；工件五件齐全。

**不该看到**：只启动了实例却没有任何规则命中证据；脚本改了系统代理或装了证书（内嵌不该做这些）；把 8899 与 18080 混用导致证据串台。

## 变式

1. **换端口与存储**：改成 18081 + `storage: 'ci2_'`，同时起两个内嵌实例，确认互不干扰。
2. **换隐藏规则**：把 `file://({"ec":0})` 换成 `statusCode://503`，用 `curl -i` 看状态码。
3. **故意断言失败**：把断言里的 `ec` 改成不存在的字符串，看脚本如何报错——这是把「人工看界面」升级为「自动化守卫」的关键。

## 没看到预期？按顺序查

1. `Cannot find module 'whistle'` → 是否在练习目录里 `npm i whistle`。
2. 端口冲突 → 换端口；`storage` 用独立名字（[08 进程模型](/architecture/process-config)）。
3. 规则没命中 → `setShadowRules` 是否在回调里调用；`http.request` 的 `path` 是否写成完整 URL（不能是 `/`）；pattern 是否与请求的 Host 一致。
4. 响应来自真实站点 → `curl` 的 `-x` 端口是否指向内嵌实例。

## 收尾

`Ctrl+C` 结束脚本；确认没有残留的后台实例（`w2 status --all` 看不到 18080 那个，因为它不是 CLI 实例）。保留工件目录。

## 隔日复核

第二天只看工件，重新 `node embed-practice.js` + `curl` 验证，记录卡住的一步。

## 背后的机制

- 内嵌入口为什么是纯函数、隐藏规则与事件订阅：[26 自动化](/scenarios/automation)、[28 实验三](/advanced/hands-on)。
- `exportInterfaces` 与进程内单例：[35 Node 运行时](/concepts/04-runtime)。
- 规则注入与全量重编译：[13 规则引擎](/modules/rules-engine)。

## 晋级标准

不看教程，能自己写一段脚本：起一个独立端口的内嵌实例、注入一条不同的隐藏规则、用 `curl` 与断言双向证明它命中，并产出可复现工件。做到就进 [A4 协作方案](/practice/a4-collab)。

## 下一步

[A4 协作方案](/practice/a4-collab)：设计多人共用的规则集方案，处理分组、冲突与回滚。
