---
title: 团队协作：规则集、远程规则与配置即代码
description: 从团队共享规则、.whistle.js 到多实例隔离，追踪配置即代码的加载、热替换与同步链路。
---

# 团队协作：规则集、远程规则与配置即代码

当一份代理规则不再只属于一个人，工程问题就来了：前端、后端、测试各有一套本地覆盖，团队又希望基础规则统一收口，还要在 CI 与新人入职时一键还原整套环境。本篇把这些日常协作动作放回源码里审视，读完你能说清一条 `@` 引入的远程规则如何被拉取、展开、重编译，界面为何能在别人改了规则后自动刷新，以及多实例为什么必须靠目录而不是进程内状态来隔离。所有配置与阈值都来自官方使用文档、集成测试或源码，可逐段对照验证。

## 场景与痛点

**一、团队基础规则与个人覆盖并存。** 团队把公共的 host、mock、跨域规则放在一处共享地址，个人只想在自己项目里覆盖其中几条。若两者都写进同一个 Rules 文件，合并冲突与互相踩踏几乎不可避免；若各写各的，又缺少一个稳定的叠加顺序，谁先生效全凭手工拖放。

**二、环境交接靠口头描述。** 新同事入职或 CI 拉起回归环境时，需要把十几条规则、若干 Values 与插件变量准确导入。手工在界面里逐条点选既慢又容易漏，`w2 add` 与 `.whistle.js` 正是为把这份「环境说明书」变成可版本化、可评审的代码而存在。

**三、多项目、多实例并行。** 同一台开发机上同时跑两个项目的代理，若共用默认存储目录，Rules、Values、证书与会话会互相覆盖。端口冲突只是表象，真正的问题是共享了同一份状态，导致一个人的改动悄悄改掉了另一个人的调试现场。

## 可复制的配置

`@` 支持远程 URL、本地路径、插件接口与 Windows 路径，Whistle 会定时回源更新（来源 `docs/docs/rules/@.md`）：

```txt
# 来源：docs/docs/rules/@.md
@https://team.example.com/configs/base-rules.txt
@~/projects/my-app/whistle-overrides.txt
@whistle.nohost/api/rules
@C:/whistle/rules.txt
```

把环境写成代码，用 `w2 add` 导入；同名规则默认提示确认，`--force` 才强制覆盖（来源 `docs/docs/cli.md`）：

```js
// 来源：docs/docs/cli.md（.whistle.js / w2 add）
exports.groupName = '项目开发环境';
exports.name = '[my-app]本地环境配置';
exports.rules = `
test.example.com http://127.0.0.1:5566
test.example.com/cgi-bin ignore://http
`;
```

```bash
# 来源：docs/docs/cli.md
w2 add             # 执行当前目录 .whistle.js，同名规则提示确认
w2 add --force     # 强制覆盖已有同名规则
```

Values 让大段内容在多条规则间共享；`lineProps://important` 只提升所在行同类协议的优先级（来源 `docs/docs/rules/operation.md`、`lineProps.md`）：

```txt
# 来源：docs/docs/rules/operation.md（Values 引用）
www.test.com/cgi-bin/test file://{result.json}
# 来源：docs/docs/rules/lineProps.md
www.example.com/path file:///User/xxx/important1.html
www.example.com/path file:///User/xxx/important2.html lineProps://important
```

`skip` 跳过指定规则后继续匹配，`ignore` 则不再匹配同类型其它规则（来源 `docs/docs/rules/skip.md`、`ignore.md`）：

```txt
# 来源：docs/docs/rules/skip.md
www.example.com/path skip://operation=file:///User/xxx/index1.html
# 来源：docs/docs/rules/ignore.md
www.example.com/path2 ignore://file|host
```

插件变量既可全局配置，也可按请求精细化，分别由 `globalPluginVars` 与 `pluginVars` 读取（来源 `docs/docs/rules/plugin-vars.md`）：

```txt
# 来源：docs/docs/rules/plugin-vars.md（全局）
%autosave=123
%autosave.enableAutoSave=true
%autosave.storageDir=/User/xxx/test/sessions
# 来源：同上（按请求精细化）
www.test.com/api %autosave=abc
```

Rules 界面勾选 `Allow multi-select` 后支持多选规则集；多实例必须端口与存储目录双双独立（来源 `docs/docs/faq.md`、`cli.md`）：

```bash
# 来源：docs/docs/faq.md（Rules 界面 Settings）
# 勾选 Allow multi-select 即可多选规则集
# 来源：docs/docs/cli.md（启动多个实例）
w2 start -p 8010 -S 8010
w2 start -p 8011 -S 8011
```

## 背后的设计思想

**配置即代码、可热替换。** 见 [配置即代码、可热替换](/modules/rules-engine)。无论规则来自界面编辑、`@` 远程文件、`w2 add` 还是插件接口，最终都落到 `lib/rules/util.js:58-106` 的同一个监听器里：把当前选中的规则、Default、Mock、Service、Shadow 依次拼成一个 `rulesList`，再整体交给 `rules.parse`。系统没有为「谁改了哪一行」维护增量 diff，任何来源变化都走一次全量重编译，代价可控而语义统一；也正因如此，规则文本才能像代码一样放进仓库、被 `@` 引用、被脚本生成，改完即生效而不必重启。

**修改戳 + 已有轮询搭便车，不做长连接广播。** 见 [抓包数据的采集与上报](/core/capture-data)。`lib/config.js:1126-1134` 的 `setModified` 只把 `mrulesTime` / `mvaluesTime` 写成时间戳，不推送任何规则正文；`biz/webui/cgi-bin/get-data.js:41-44` 把它塞进本来就要返回的轮询响应，前端 `htdocs/src/js/data-center.js:903-928` 比对后自行重拉。省掉一条独立的推送通道，是多端同步能保持轻量的关键，也让「别人改了规则我这边自动刷新」几乎零成本。

**装配与启动分离、顺序即优先级。** 见 [装配与启动分离](/architecture/process-config) 与 [顺序即优先级](/modules/rules-engine)。`w2 add` 只把规则写进存储，不必重启正在跑的进程；`w2 start -S` 则换一个目录重新装配整套状态。规则本身不设优先级字段，行序就是优先级，`lib/rules/rules.js:997` 的线性扫描首条命中即返回，`important` 只是这一模型上的有限补丁，而非另一套排序机制。

**多实例靠目录隔离，而非进程内状态。** 见 [进程模型与配置系统](/architecture/process-config)。`-S` 在 `lib/config.js:1067-1091` 把 `baseDir` 重定向到 `custom_dirs/<storage>`，连同 `rulesDir`、`valuesDir`、`propertiesDir` 一并换掉；规则、Values、证书与会话各自一套，因此实例之间不需要任何进程内互斥，运维上也只需保证端口与目录唯一即可横向扩展。

## 源码链路

1. **入口：远程与本地规则轮询。** `lib/util/http-mgr.js:38-45` 的 `getInterval` 给本地文件 5 秒、给远端按 `lib/util/http-mgr.js:17-18` 的 `MIN_INTERVAL=10s` / `MAX_INTERVAL=30s` 分摊；`:425-449` 的 `add` 把 `@` 目标登记进 `cache` 并触发首次拉取，内容变化通过 `addChangeListener` 广播。对应 [规则引擎：解析与匹配](/modules/rules-engine) 的热更新入口。
2. **规则解析：`@url` 展开。** `lib/util/index.js:3304-3318` 定义 `MAX_REMOTE_RULES_COUNT = 20`，`getRemoteRulesResolver` 用正则把每条 `@path` 替换成回源正文，超过 20 条直接丢弃，避免远程引用无限嵌套拖垮一次编译。见 [规则引擎：解析与匹配](/modules/rules-engine)。
3. **规则解析：全量重拼与版本标记。** `lib/rules/util.js:58-106` 按「选中 → Default → Mock → Service → Shadow」重拼并调用 `rules.parse`；`lib/rules/rules.js:2051-2110` 在 parse 内刷新 `_mflag` 版本标记，让旧缓存整体失效。见 [规则引擎：解析与匹配](/modules/rules-engine)。
4. **应用点：运行期整体替换与分组存储。** `lib/index.js:231-239` 的 `setShadowRules` 改写 `config.shadowRules` 后直接 `rulesUtil.parseRules()`；`lib/rules/storage.js:61-171` 提供分组、`.backup` 双写与 `.recycle_bin` 回收站；`lib/config.js:1067-1091` 完成 storage 重定向。见 [进程模型与配置系统](/architecture/process-config)。
5. **回写：只写修改戳。** `lib/config.js:1126-1134` 的 `setModified` 只更新 `mrulesClientId` / `mrulesTime` 与 Values 对应字段，不广播内容；`lib/index.js:231-239` 的替换动作与这条回写串在同一次变更里。见 [抓包数据的采集与上报](/core/capture-data)。
6. **上报：随轮询返回并触发重拉。** `biz/webui/cgi-bin/get-data.js:41-44` 把四个修改戳并入响应；`htdocs/src/js/data-center.js:903-928` 的 `checkDataChanged` 比对 `mrulesClientId` 与时间戳，变化时 `trigger('rulesChanged')` 重新拉取，界面随之刷新。见 [Web 管理界面](/modules/webui)。

## 边界与坑

- **首条命中，`important` 有作用域。** `lib/rules/rules.js:997` 自上而下线性扫描，命中的第一条同类规则即生效；`docs/docs/rules/lineProps.md` 明确 `important`「仅对同类协议的操作生效」，不能跨协议压过别的规则。
- **`ignore` 与 `skip` 语义不同。** `docs/docs/rules/ignore.md` 指出被 `ignore` 忽略的规则「不会继续匹配同类型的其他规则」，若想跳过一条后继续尝试剩余同类规则，应改用 `skip`（`docs/docs/rules/skip.md`）。
- **插件内置规则优先级更低。** `docs/docs/extensions/usage.md` 说明插件 `rules.txt` 是全局规则且「优先级低于 Rules 界面配置的规则」；`docs/docs/rules/operation.md` 另提醒 `http/https/ws/wss/tunnel/host/enable` 等协议禁止从文件或远程 URL 获取操作内容。
- **`file` 等协议会让 `proxy` 失效。** `docs/docs/rules/lineProps.md` 记载默认配置了 `file` 时 `proxy` 自动失效，需要 `lineProps://weakRule` 或 `proxyHost` 才恢复，最容易在「本地文件替换 + 上游代理」组合里踩空。
- **轮询、目录与导入上限。** 远程规则是定时轮询而非实时推送（`lib/util/http-mgr.js:17-18,38-45`）；`docs/docs/cli.md` 强调多实例共享存储目录会「数据覆盖或损坏」；Rules/Values 导入体在 `biz/webui/cgi-bin/util.js:10,82` 被 `MAX_OBJECT_SIZE = 6MB` 截断，超限直接报 `The file size can not exceed 6MB`。

## 小结

- `@` 把远程 URL、本地文件、插件接口统一成可版本化的规则来源，`w2 add` 与 `.whistle.js` 让整套环境配置像代码一样被导入与评审。
- 任何来源变化都走 `lib/rules/util.js:58-106` 的全量重编译，`lib/rules/rules.js:997` 的线性扫描让行序成为唯一优先级模型。
- 同步不靠长连接：`setModified` 只写时间戳，搭 `get-data` 轮询便车，前端 `checkDataChanged` 比对后重拉。
- 多实例用 `-S` 把状态重定向到独立目录，端口与目录必须同时唯一，进程内无需互斥。
- 规则叠加、协议优先级与 6MB 导入上限，是团队协作里最常见的三类隐性约束。

## 下一步

[《CI、嵌入式集成与自动化回归》](/scenarios/automation)：把这套「配置即代码」的能力进一步交给流水线，看 `require('whistle')` 如何在测试进程里内嵌启动并注入隐藏规则。
