---
title: 复现、保存与重放
description: 从 Network 抓包到 Composer 重放，追溯同一 data 引用、service 子进程与约定式 CGI 如何支撑会话的保存与回打。
---

# 复现、保存与重放

一个偶现的 502 只在某台手机上出现，等接上调试环境就再也复现不了；测试要把它存下来、改几个请求头再连发一百次。这类「把真实流量固定成可重复输入」的现场，是复现与重放最典型的工程问题。本篇从 `docs/docs/gui/network.md`、`composer.md`、`shortcut.md` 与 `test/units/composer.test.js` 的真实工作流出发，读完你能走通 Save、Import、Export 与 Replay 的完整闭环，并说清内核与界面为何读同一份数据、重活为何放进 service 子进程、以及 600 条缓存与 2MB 正文这些边界从哪来。

## 场景与痛点

- **排查偶现问题的工程师**：线上偶发 502，客户端环境特殊、无法稳定触发。约束是必须先把那一次真实请求完整保存下来，之后无论改请求头、改方法还是连续重放，都不能依赖再次复现现场。
- **跨工具协作的测试**：同事用 Fiddler 存了 SAZ，团队想直接导入 Whistle 分析；反过来也要把抓包导出成 SAZ 交给对方。约束是同一份会话要能在两种工具间往返，且导入格式不能只认自家私有结构。
- **验证规则是否命中的开发者**：改完一条规则，想确认某个请求到底命中了哪几行，还要把 Composer 发出的构造请求从海量抓包里单独挑出来。约束是查询要按请求 id 精确定位，过滤不能和真实业务流量混在一起。

## 可复制的配置

Network 底部搜索框支持多条件「与」搜索，`fc:` 前缀专门隔离 Composer 流量；导入导出格式由前端约定。

```txt
# 来源：docs/docs/gui/network.md、import-dialog.js
# 多条件「与」搜索
b:/"success":false/ m:POST s:200 H:api.example.com
# 只过滤 Composer 发出的请求
fc:/test/
# 导入支持 .txt .json .saz .har，导出可选 Fiddler *.saz
```

快捷键与 Composer 组件把「保存 → 编辑 → 重放」串成一条固定动作链。

```txt
# 来源：docs/docs/gui/composer.md、shortcut.md
# Replay / Edit Request / AsCURL / Replay Times(最多 100 次)
Ctrl+S 保存   Ctrl+I 导入   Ctrl+E 导出
Ctrl+Shift+Enter 设置重放次数   Ctrl+A 强制中断
# Test Rules 查命中规则，对应 cgi-bin/get-matched-rules
```

集成测试直接把这条链固化为可执行命令，`test/units/composer.test.js` 连续向 `cgi-bin/composer` POST 构造请求。

```bash
# 来源：package.json、test/index.test.js
npm test                 # node test/index.test.js，遍历 82 个 units
# Composer 单元覆盖 cgi-bin/composer 的构造与重放
```

三段分别对应过滤、动作与回归：`fc:` 把构造流量从业务流量里隔离出来，快捷键串起保存、导入导出与重放，`npm test` 则把 Composer 的 POST 流程固化进 82 个 units。值得注意的是 Import 与 Export 并非简单读写文本：`.saz` 要走 zip 解压与 `fiddlerMeta` 模板，`.har`、`.txt`、`.json` 才按文本解析，这也是把互操作放进 service 子进程的原因。换句话说，界面上的每个按钮都能在 `cgi-bin/` 找到同名文件，重活则统一收进 `lib/service/` 子进程；集成测试因此可以直接对 CGI 发请求，而不必驱动浏览器界面。

## 背后的设计思想

- [零复制优先](/core/capture-data)：`lib/util/data-server.js:319-333` 的 `handleRequest` 给 `data` 补上 id 与版本后，直接 `reqData[id] = data`，不做克隆。内核采样与 UI 轮询读的是同一对象引用，因此抓包列表、详情面板与导出内容天然一致；代价是任何一处原地改写都会立刻反映到全局，不能假设拿到的是快照。
- [内存有界优先于数据完整](/core/capture-data)：`lib/util/data-server.js:21-26` 把缓存定在 600 条、溢出 1800 条、单次上报 100 条，`lib/inspectors/data.js:8-11` 给请求与响应体设 2MB 上限、大对象 16MB。偶现请求能被存下来，但超阈正文只留元信息、旧会话按界淘汰，宁可少存也不撑爆常驻内存。
- [service 子进程隔离重活](/architecture/process-config)：`lib/service/index.js:1,10` 用 `pfork.fork` 把 `service.js` fork 成独立子进程，SAZ 的 zip 解析、会话 gzip 落盘与 Composer 重放这类重活不占主代理线程，子进程异常也不会拖垮抓包主链路。
- [约定优于配置](/modules/webui)：`biz/webui/lib/index.js:387-402` 的 `cgiHandler` 把 `req.path` 拼成 `../cgi-bin/xxx.js` 再 `require`，`get-data`、`get-matched-rules`、`sessions`、`composer` 的文件名即接口名。新增一个查询能力不必登记路由表，放一个同名文件即可。

## 源码链路

按「入口 → 规则解析 → 应用点 → 回写/上报」展开，重点看同一份 `data` 如何被四处复用。

1. **入口 · 旁路采样**：`lib/inspectors/data.js:279-302` 包装 `stream.write` 与 `stream.end`，累加 `reqData.size`、触发 `updateEvent`，最后仍 `write.apply(this, arguments)` 原样透传，抓包不改道。见 [抓包数据的采集与上报](/core/capture-data)。
2. **规则解析 · 原地登记**：`lib/util/data-server.js:319-333` 的 `handleRequest` 分配 `data.id`、写入 `data.version`，把同一个 `data` 放进 `reqData[id]`，为后续按 id 查询与命中登记建立索引。见 [抓包数据的采集与上报](/core/capture-data)。
3. **应用点 · 保存与 SAZ 互操作**：`lib/service/service.js:90-115` 的 `saveSessions` 对会话 `gzip(JSON.stringify(sessions))` 后写入 `SAVED_SESSIONS_PATH`；`lib/service/extract-saz.js:108-278` 用 `AdmZip` 解析 SAZ，`lib/service/generate-saz.js:105-181` 按 `fiddlerMeta` 模板生成 Fiddler SAZ。见 [进程模型与配置系统](/architecture/process-config)。
4. **应用点 · 构造并回打自身代理**：`lib/service/composer.js:345-513` 的 `handleRequest` 解析 URL、头与 body；`lib/service/composer.js:519-524` 的 `setup` 把 `PROXY_OPTS` 设为 Whistle 自身 host 与 port，`:242-243` 令 `options.host` / `options.port` 指向它，于是重放请求重新走一遍规则链；`MAX_REQ_COUNT = 100`（`lib/service/composer.js:19,118-120`）由 `getReqCount` 钳制重放次数。见 [一次 HTTP 代理请求的旅程](/core/http-request)。
5. **回写/上报 · 轮询与流式响应**：`biz/webui/cgi-bin/get-data.js:60` 调 `proxy.getData(...)` 返回抓包数据；`htdocs/src/js/data-center.js:1158-1159` 按 `hasNewData ? 100 : 900` 毫秒自适应轮询；`lib/service/compose-data.js:3-4` 用 `LRU({ max: 120 })` 承载重放的流式响应。见 [Web 管理界面](/modules/webui)。
6. **查询 · 命中规则与补详情**：`cgi-bin/get-matched-rules.js:6` 调 `lib/util/data-server.js:632` 的 `proxy.getTestItem` 返回 `realUrl` 与 `rules`；`lib/util/data-server.js:624` 的 `getItem` 按 id 补单个请求详情，`lib/util/data-server.js:886` 的 `getData` 才是主界面数据源。见 [规则引擎](/modules/rules-engine)。

## 边界与坑

- **缓存 600 条、溢出 1800 条、单次最多 100 条**：`lib/util/data-server.js:10-11` 把默认 `reqCacheSize` 定为 600，`:21-26` 由此推出 `OVERFLOW_LENGTH = MAX_LENGTH * 3`、`COUNT = 100`。超过界线的会话会被淘汰，不要把抓包列表当永久存储。
- **超过 2MB 的 body 只留元信息**：`lib/inspectors/data.js:8-11` 把请求体与响应体上限设为 2MB、大对象 16MB；`docs/docs/rules/enable.md:25` 的 `bigData` 可把抓包显示限制从 2M 放宽到 16M，超限内容仍不保证完整。
- **API 分页每次最多 120 条**：`lib/util/data-server.js:34` 的 `MAX_COUNT = 120`，`:36-42` 的 `formatApiOptions` 用上限钳制 `count`，批量拉取必须自行翻页。
- **Composer 界面历史 64 条、服务端 100 条**：`docs/docs/gui/composer.md:34` 写明界面最多保存 64 条，而 `lib/service/composer.js:24,88-90` 的 `MAX_HISTORY_LEN = 100` 才是服务端裁剪上限，两者不要混为一谈。
- **`proxy.getItem` 只用于插件按 id 补详情**：`lib/util/data-server.js:624` 的 `getItem` 返回单条并把 req/res 转成 base64，主界面数据来自 `lib/util/data-server.js:886` 的 `getData`（`biz/webui/cgi-bin/get-data.js:60` 调用）；误用 `getItem` 拉列表会拿不到分页与过滤结果。

## 小结

- 复现闭环是「抓包 Save → 导入导出 → Composer 编辑与重放」，SAZ 互操作让会话能在 Whistle 与 Fiddler 之间往返。
- 内核与 UI 读同一份 `data` 引用，一致性的代价是没有快照；600 条缓存、2MB 正文与 120 条分页都是有界设计。
- 重放不是直连目标，而是把构造好的请求回打 Whistle 自身代理端口，因此照常命中规则、照常被抓包记录。
- `test/units/composer.test.js` 直接 POST `cgi-bin/composer`，把手工流程固化成 82 个 units 中的可回归用例。
- CGI 文件名即接口名，命中规则、抓包数据、会话保存分别由 `get-matched-rules`、`get-data`、`sessions` 等约定式文件承接。

## 下一步

[《故障注入与容错验证》](/scenarios/fault-injection)：能重放之后，下一步是主动制造可控的失败，看 `statusCode`、`reqDelay`、`resSpeed` 与 `chance` 过滤器如何把超时、错误码与限流变成可复制的规则。
