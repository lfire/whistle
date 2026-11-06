---
title: 接口未就绪：Mock 与契约先行
description: 从内联 JSON 到 Values 与本地模板，追溯 Mock 为何在 handler 短路、容量如何分档、以及 204/304 与 2MB 边界的由来。
---

# 接口未就绪：Mock 与契约先行

后端接口还在评审，前端页面已经要联调；测试想稳定复现一个 500，又不愿真的把服务打挂。这类「依赖未就绪、却要先固定请求与响应」的现场，是契约先行的典型工程问题。本篇从 `docs/docs/rules/file.md`、`tpl.md`、`resBody.md`、`statusCode.md` 等真实规则出发，读完你能用内联值、Values 与本地文件搭出可复制的 Mock，并说清它为什么根本不出网、内容容量如何分档，以及 204/304 与 2MB 这些边界从哪来。

## 场景与痛点

- **前端工程师与未实现的接口**：`/api/data` 后端还没写，页面却要按 `{"status":"ok"}` 渲染。约束是不改前端代码里的请求地址，也不额外起一个假后端占端口，最好一条规则就能返回固定 JSON。
- **测试工程师与条件化响应**：搜索接口要按请求体里 `"type":"advanced"` 返回不同结果，同时以 50% 概率注入 500 验证客户端容错。约束是同一 URL 上按方法、按内容分流，且故障比例可重复、可关闭。
- **契约维护者与内容体积**：Mock 内容从几行 JSON 长到几百 KB，需要决定放内联、Values 还是本地文件。约束是改动要即时生效，大响应体的合并改写不能拖垮内存，模板还要能按请求参数动态生成。

## 可复制的配置

内联值是最轻的一档，必须用 `()` 包裹；`tpl` 与 `resType` 分别负责动态模板与响应类型。

```txt
# 来源：docs/docs/rules/file.md、tpl.md、operation.md
# 内联 JSON，括号不可省略
www.example.com/api/data file://({"status":"ok"})
# 本地 JS 模板按请求参数生成响应
https://www.example.com/test/tpl tpl:///User/xxx/test.js
# 直接返回内容并指定响应类型
pattern file://(直接返回的内容) resType://html
```

同一 URL 上按方法或请求体分流，靠的是过滤器而不是多条 URL 规则。

```txt
# 来源：docs/docs/rules/pattern.md、file.md
# 仅对 GET 生效
www.example.com/api file://({"status":"ok"}) includeFilter://m:GET
# 请求体含 advanced 类型才命中本地结果
www.example.com/api/search file:///Users/username/search-results.json includeFilter://b:/"type":\s*"advanced"/i
```

响应阶段的改写、合并、状态码与动态规则，可以叠在同一批规则里。

```txt
# 来源：docs/docs/rules/resBody.md、resMerge.md、statusCode.md、reqScript.md
www.example.com/api/data resBody://({"status":"modified"})
www.example.com/path resMerge://test=123 file://({"name":"avenwu"})
# 一半概率返回 500，测试客户端容错
www.example.com/api/unstable statusCode://500 includeFilter://chance:0.5
# 由脚本动态生成规则
www.example.com/path reqScript://{test.js}
```

容量分档决定内容放哪里：`operation.md` 是操作值的总纲，`docs/docs/rules/file.md:68-71` 给出明确建议。

```txt
# 来源：docs/docs/rules/file.md、operation.md
# <2KB 内联；2KB~200KB 放 Values；>200KB 用本地文件
# 在 Values 建好 result.json 后即可按 key 引用
www.test.com/cgi-bin/test file://{result.json}
```

四段规则对应四种契约来源：内联值适合几行 JSON，模板适合按 `${query.callback}` 等变量动态生成，Values 适合团队共享的中等体积内容，本地文件适合大体积与频繁编辑。它们在编译期都被拍平成同一个 rule 对象，区别只在 `resolveValue` 求值阶段从哪里取 `value`；也正因如此，把一份 Mock 从内联挪到 Values 时，pattern 与过滤器都不必改动。

## 背后的设计思想

- [短路转发](/core/http-request)：`file` / `tpl` 由 `lib/handlers/file-proxy.js:259-260` 删掉 `rules.proxy` 与 `rules.host` 后，用 `rule.value` 直接构造 200 响应；`statusCode` 则在 `lib/inspectors/res.js:1313-1319` 于出站前取 `getStatusCodeFromRule` 的结果 `res.response(...)` 并置 `Connection: close`，连 file-proxy 这一层都不到。两条路径都不拨出站 socket，后端不存在也能返回结果，故障注入也不会真把上游打挂。
- [配置即代码、可热替换](/modules/rules-engine)：规则文本与 Values 都是可编辑的文本，`lib/rules/util.js:58-106` 监听变更并整份重编译。因此把契约从内联值挪到 Values、再挪到本地文件，只是换一处存储，不需要重启进程；`w2 add` 导入 `.whistle.js` 走的是同一条更新链。
- [内存有界优先于数据完整](/core/capture-data)：容量分档不是文档建议而是实现约束。抓包侧 `lib/inspectors/data.js:8-11` 把请求体、响应体上限设为 2MB、大对象上限 16MB；合并改写也只对小于 2MB 的 body 自动生效。宁可截断，也不让一份巨型 Mock 撑爆常驻内存。
- [解析期与请求期分离](/modules/rules-engine)：`lib/rules/rules.js:1745-1806` 的 `parseText` 只把一行文本结构化成 rule 对象，`resolveValue` 与 `{key}` 引用要到命中之后才求值成 `value`。所以内联值、Values、模板在编译期被拍平成统一对象，请求期只面对同一种结构，热路径上不做 IO。

## 源码链路

按「入口 → 规则解析 → 应用点 → 回写/上报」展开，Mock 的短路位置是这条链的关键。

1. **入口与编译**：`lib/rules/rules.js:1745-1806` 的 `parseText` 逐行 `removeComment`、`split`、`formatShorthand`；`lib/rules/rules.js:225-266` 的 `formatShorthand` 把裸 `()` 内联值补成 `file://` 协议，`{key}` 补成 Values 引用。见 [规则引擎](/modules/rules-engine)。
2. **分桶**：`lib/rules/protocols.js:256-265` 的 `resetRules` 只给 `protocols` 数组内的协议预建数组（`resBody`、`resMerge` 在其中），另建 `_localRule`、`_bodyFilters`、`_clientCerts` 专用桶，并把 `rules.rule.isRuleProto` 置真。`file` / `tpl` / `rawfile` 并不在协议数组里，由 `RULE_RE`（`lib/rules/protocols.js:78`）配合 `isFileProxy`（`:279-283`）在 handler 阶段识别；`status` 经 alias 映射成 `statusCode`（`:143`），它与 `redirect` 在 `lib/rules/rules.js:1311-1322` 被打上 `isSpec` 标记后统一落进 `rules.rule` 桶，靠 `isRuleProto` 区分。见 [指令体系与分发链路](/modules/protocol-catalog)。
3. **命中**：`lib/inspectors/rules.js:29-45` 的 `setupRules` 调 `resolveRules`、`util.filterWeakRule`，再把 `req.options` 定稿；首条命中由 `lib/rules/rules.js:997` 自上而下遍历返回，`includeFilter://m:GET`、`chance:0.5` 由过滤器在 `checkFilter` 阶段判定。见 [一次 HTTP 代理请求的旅程](/core/http-request)。
4. **应用点（短路）**：`lib/handlers/file-proxy.js:233-269` 判定 `isFileProxy` 后删掉 proxy 与 host，用 `rule.value` 直接构造 200 响应；`statusCode` 则由 `lib/util/index.js:3576-3599` 的 `getStatusCodeFromRule` 直接产出 `{ statusCode, headers }`，不经后端。见 [指令体系与分发链路](/modules/protocol-catalog)。
5. **响应改写**：`lib/inspectors/res.js` 承担 `resBody`、`resMerge` 等响应阶段的替换与合并，`lib/handlers/file-proxy.js:250-253` 顺带处理 OPTIONS 预检与 CORS 包装；204/304 之类无响应体的请求在此被跳过。见 [一次 HTTP 代理请求的旅程](/core/http-request)。
6. **回写与热更新**：Values 的 `{key}` 在请求期求值，改动由 `lib/rules/util.js:58-106` 的 `httpMgr.addChangeListener` 触发全量重编译并 `pluginMgr.emit('updateRules', true)`，落盘交给 `lib/rules/storage.js` 的 files / values / properties 目录；旁路采样仍记入 [抓包数据的采集与上报](/core/capture-data)。见 [规则引擎](/modules/rules-engine)。

## 边界与坑

- **内联值必须用 `()` 包裹**：`docs/docs/rules/file.md:26-39` 明确不加括号会被当作本地文件路径或 `{key}`，导致 404；同一篇 `:256-258` 还指出不推荐 `file://https://xxx` 这种形式，远程内容应改用 `https` / `http` 协议。
- **statusCode 默认空响应体、401 会弹认证框**：`docs/docs/rules/statusCode.md:133-145` 说明默认内容为空，需配合 `resBody` 才有正文；返回 401 默认触发浏览器登录框，要用 `disable://userLogin` 或 `lineProps://disableUserLogin` 关闭。
- **204/304 无响应体时注入类不生效**：`docs/docs/rules/resBody.md:6` 与 `docs/docs/rules/cssPrepend.md:3` 都标注「204、304 等无响应内容体的请求不受影响」，`resBody`、`htmlAppend`、`jsPrepend` 等注入与替换规则会被跳过。
- **GET/HEAD 无请求体时 reqBody 不生效**：`docs/docs/rules/reqBody.md:3` 写明 GET、HEAD 等无内容体的请求不受影响，`docs/docs/gui/composer.md:24` 也从界面侧确认 GET/HEAD/OPTIONS 会自动忽略请求体。
- **resMerge / reqMerge 自动合并仅限 body 小于 2MB**：`docs/docs/rules/resMerge.md:52` 与 `reqMerge.md:52` 规定超限跳过，需加 `enable://resMergeBigData` / `enable://reqMergeBigData` 或 `lineProps://enableBigData`；请求侧阈值是 `lib/inspectors/req.js:19-20,163` 的 `MAX_REQ_SIZE`（2MB）与 `BIG_MAX_REQ_SIZE`（16MB），响应侧对应 `lib/inspectors/res.js:21-22,1010` 的 `MAX_RES_SIZE` / `BIG_MAX_RES_SIZE`，两侧都是把默认 2MB 放宽到 16MB，而不是取消限制。

## 小结

- Mock 的本质是短路转发：`file` / `tpl` 在 `lib/handlers/file-proxy.js` 构造响应，`statusCode` 在 `lib/inspectors/res.js:1313-1319` 出站前直接回码，请求不出网，后端未就绪也能联调。
- 同一 URL 的条件化响应靠过滤器表达：`includeFilter://m:GET` 按方法、`b:` 按请求体正则、`chance:0.5` 按概率注入故障。
- 内容容量按 2KB 与 200KB 分三档，内联、Values、本地文件各有归属，改动经 `lib/rules/util.js:58-106` 全量重编译即时生效。
- 编译期只做结构化、请求期才求值，是内联值与 `{key}` 能共用同一 rule 对象的前提。
- 括号、空响应体、204/304、无请求体方法与 2MB 合并上限，是官方与源码共同划定的五类边界。

## 下一步

[《复现、保存与重放》](/scenarios/reproduce-replay)：当 Mock 不足以解释一个偶现问题时，下一步是把真实请求抓下来、存成会话再反复重放，看 Network 与 Composer 背后的 CGI 与 service 子进程如何协作。
