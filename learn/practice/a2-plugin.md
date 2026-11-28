---
title: A2 改得动 · 写一个最小插件并验证效果
description: 建 whistle.xxx 插件目录、声明 whistleConfig、安装后在请求链路上产生可观察效果。
---

# A2 改得动 · 写一个最小插件并验证效果

::: tip 先修知识
已完成 [A1 读源码](/practice/a1-source)，会用 `grep` 定位函数、会用前台 `w2 run`。本关需要 `node -v` 可用、会在本机建目录与文件；不需要发布 npm 包。
:::

## 本关目标

独立写出一个最小插件，放进 Whistle 的自定义插件目录并等一个发现周期，让它在**请求链路上产生一个能在 Network 里看到的效果**。做完你能说清主进程与插件子进程之间发生了什么，而不是只会照抄目录结构。

## 开始前

1. `w2 start` 在跑，界面能打开（插件发现是轮询，见 [16](/modules/plugins)）。
2. `练习靶子` 基线可用。
3. 本关的插件只在本机安装，不发布、不影响他人。

## 任务

### 第 1 步 · 建插件目录与声明

插件的本地目录要**直接放进自定义插件目录**——`w2 install` 只接受 npm 包名、Git 地址或 tgz，不接受本地路径（[28 实验二](/advanced/hands-on)、[16](/modules/plugins)）：

```sh
mkdir -p ~/.WhistleAppData/custom_plugins/whistle.practice-demo
cd ~/.WhistleAppData/custom_plugins/whistle.practice-demo
```

`package.json`（插件名必须匹配 `whistle.[a-z\d_-]+`）：

```json
{
  "name": "whistle.practice-demo",
  "version": "1.0.0",
  "main": "index.js"
}
```

`index.js`（导出 `server` 与 `rulesServer`，这是 [28 实验二](/advanced/hands-on) 核对过的最小可运行版本）：

```js
module.exports = (server, options) => {
  server.on('request', (req, res) => {
    res.setHeader('content-type', 'text/plain')
    res.setHeader('x-practice-plugin', 'loaded')
    res.end('hello from ' + options.name)
  })
}
module.exports.rulesServer = (server) => {
  server.on('request', (req, res) => {
    res.end('* file://(hello-plugin)\n')
  })
}
```

`rules.txt`（全局规则模板，`{{whistlePluginName}}` 会被替换成插件短名）：

```txt
{{whistlePluginName}}://hi practice.test/api
```

> 三个文件缺一不可：`server` 是插件本体、`rulesServer` 下发动态规则、`rules.txt` 是模板。**你不需要预先会写 Node 脚本**：这是 [28 实验二](/advanced/hands-on) 核对过的可抄模板，`module.exports` 是「导出一个函数」、`server.on('request', ...)` 是「收到请求时执行」，照抄即可；想理解语义再读 [35](/concepts/04-runtime) 的 EventEmitter 词条。

### 第 2 步 · 安装并确认被发现

目录放好后**等一个发现周期（约 6 秒）**，不必重启：

```sh
w2 status
```

打开 **Plugins** 面板，确认 `whistle.practice-demo` 出现在列表里。想看插件子进程的日志，用 `PFORK_MODE=inline w2 run`（把插件跑在当前进程、日志直接打到终端）——这是 [29](/advanced/source-reading) 给的调试入口。

> 若面板没出现：检查目录名正则、是否放在 `~/.WhistleAppData/custom_plugins/` 下、是否等过 6 秒；不要改用 `w2 install ./目录`，那条路不通。

### 第 3 步 · 让插件产生可观察效果

**两个效果要分两次验证，不能同时看**——`rulesServer` 下发的 `* file://(hello-plugin)` 会先短路构造响应，插件本体的 `server` 根本收不到请求（[28 实验二](/advanced/hands-on) 已注明）。

- **主验证（动态规则）**：保持 `rulesServer` 启用，发 `curl -s -i -x 127.0.0.1:8899 http://practice.test/api`，响应体应是 `hello-plugin`——这证明插件运行时下发的动态规则生效。
- **变体验证（插件本体）**：临时把 `index.js` 里的 `module.exports.rulesServer = ...` 注释掉、等一个发现周期，再发同一条 curl。**不用再在 Rules 里写规则**：`rules.txt` 的模板行 `{{whistlePluginName}}://hi practice.test/api` 已经把这条请求交给插件短协议（模板里的 `{{whistlePluginName}}` 会被替换成短名），此时应看到响应头 `x-practice-plugin: loaded` 与 `hello from whistle.practice-demo`。验证完把 `rulesServer` 注释恢复。

> 为什么 `rules.txt` 和 `rulesServer` 要分清：`rules.txt` 是插件自带的**静态全局模板**（安装时合入规则集），`rulesServer` 是插件运行时**动态下发**的规则；后者返回的 `* file://(hello-plugin)` 是通配短路，会抢在所有其它规则之前，所以只有注释掉它，`server` 才有机会处理请求。

### 第 4 步 · 产出工件

整理 `a2-plugin/` 工件目录：① `package.json`、`index.js`、`rules.txt` 三个源文件；② `w2 status` 输出（确认实例在跑）与 Plugins 面板出现该插件的记录（两者分开留档）；③ 动态规则验证的 `curl -i` 原始输出（看到 `hello-plugin`）；④ 注释 `rulesServer` 后的验证输出（看到 `x-practice-plugin`）；⑤ 一句话说明「主进程持有 ports 表、子进程跑 server / rulesServer」。

## 验收（工件可复核）

**该看到**：`w2 status` 显示实例在跑；插件目录命名合规且在 `custom_plugins/` 下、三个源文件齐全；等一个发现周期后 Plugins 面板出现该插件；动态规则验证看到 `hello-plugin`；注释 `rulesServer` 后**不用另写规则**即可看到 `x-practice-plugin`；两份 `curl -i` 原始输出都留档。

**不该看到**：只建了目录却没装；装了但没有任何请求链路效果（那只是「装上了」，不是「改得动」）；把插件代码直接 `require` 进主进程（[16](/modules/plugins) 说明插件跑在独立子进程）。

## 变式

1. **改模板**：改 `rules.txt` 里的模板行（静态全局规则），等 6 秒发现周期，观察结果是否跟着变。
2. **禁用再启用**：在 Plugins 面板禁用该插件，发一发看效果消失，再启用看效果回来（ON 开关思路的插件版）。
3. **制造失败**：把目录名改成不合规的 `practice-demo`（少了 `whistle.` 前缀），观察它是否还被发现，理解命名正则的作用。

## 没看到预期？按顺序查

1. 插件没出现在 Plugins → 目录名是否匹配 `whistle.[a-z\d_-]+`、是否放在 `~/.WhistleAppData/custom_plugins/`、是否等过 6 秒、三个文件是否齐全。
2. 规则不命中 → 插件短名与规则里写的协议名是否一致；ON / Save / 当前规则组。
3. 请求没有插件效果 → 插件子进程是否启动；看 `w2 run` 的终端日志。
4. 端口/路径报错 → 对照 [16](/modules/plugins) 的 `ports` 表与内部头 `PLUGIN_HOOKS`。

## 收尾

把插件目录从 `custom_plugins/` 移走（或改名使其不被发现），删掉规则组，关 ON；保留 `a2-plugin/` 工件目录。

## 隔日复核

第二天只看工件目录，按 `w2 status` → 把三个源文件放进 `~/.WhistleAppData/custom_plugins/whistle.practice-demo/` → 等 6 秒 → 确认 Plugins 面板出现 → `curl -s -i -x 127.0.0.1:8899 http://practice.test/api` 看 `hello-plugin` → 注释 `rulesServer` 再看 `x-practice-plugin` 的顺序重跑，记录卡住的一步。

## 背后的机制

- 插件发现、`p.fork` 隔离、`ports` 表与 hook 头：[16 插件系统](/modules/plugins)、[38 扩展机制与工程化](/concepts/07-extension)。
- 完整最小插件实验：[28 实验二](/advanced/hands-on)。
- 规则协议注册：[14 指令体系](/modules/protocol-catalog)。

## 晋级标准

不看教程，能自己写出一个**不同效果**的最小插件（例如给响应加一个自定义头），安装、命中、验证、清场，并产出一份别人能按着复现的工件目录。做到就进 [A3 内嵌集成](/practice/a3-embed)。

## 下一步

[A3 内嵌集成](/practice/a3-embed)：把 Whistle 当作库嵌进自己的 Node 进程，用事件与断言验证规则命中。
