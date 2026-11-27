---
title: 接口未就绪：Mock 与契约先行
description: 从内联 JSON 到 Values 与本地模板，追溯 Mock 为何在 handler 短路、容量如何分档、以及 204/304 与 2MB 边界的由来。
---

# 接口未就绪：Mock 与契约先行

后端接口还在评审，前端页面已经要联调；测试想稳定复现一个 500，又不愿真的把服务打挂。这类「依赖未就绪、却要先固定请求与响应」的现场，是契约先行的典型工程问题。本篇从 `docs/docs/rules/file.md`、`tpl.md`、`resBody.md`、`statusCode.md` 等真实规则出发，读完你能用内联值、[Values](/concepts/06-rules) 与本地文件搭出可复制的 Mock，并说清它为什么根本不出网、内容容量如何分档，以及 204/304 与 2MB 这些边界从哪来。[《本地联调与环境切换》](/scenarios/local-env)（19）把流量改到了 dev server、测试机或本地文件，但三种去向都有一个共同前提：目标存在、会应答；本篇承接这个未解问题，回答「后端根本没写好」时如何让请求连网都不出就拿到固定响应。

::: tip 先修知识
本篇承接 [《本地联调与环境切换》](/scenarios/local-env)（19），本篇会讲清（不需要预先掌握）：规则命中后由 handler 决定出站或短路、`file://` 会删掉 proxy 与 host 直接构造响应、以及规则按行序首条命中即返回。19 讲的是「把流量送到某个真实目标」，本篇把同一条短路链推到「目标不存在、由代理自己造响应」。

若某个名词卡住，按主题回查 [概念精解总览](/concepts/index) 与 [《全量术语索引》](/concepts/glossary)；正文在术语首次出现处也给了对应链接。

给完全没读过源码的读者：把「短路转发」先理解成「代理不把请求发给后端，而是自己拼一份响应发回浏览器」。因此后端存不存在、占没占端口，都不影响这条链路；本篇后面所有 `file://`、`tpl://`、`statusCode://` 的写法，只是决定这份「自己拼的响应」内容从哪来、状态码是多少。
:::

## 场景与痛点

- **前端工程师与未实现的接口**：`/api/data` 后端还没写，页面却要按 `{"status":"ok"}` 渲染。约束是不改前端代码里的请求地址，也不额外起一个假后端占端口，最好一条规则就能返回固定 JSON。
- **测试工程师与条件化响应**：搜索接口要按请求体里 `"type":"advanced"` 返回不同结果，同时以 50% 概率注入 500 验证客户端容错。约束是同一 URL 上按方法、按内容分流，且故障比例可重复、可关闭。
- **契约维护者与内容体积**：Mock 内容从几行 JSON 长到几百 KB，需要决定放内联、Values 还是本地文件。约束是改动要即时生效，大响应体的合并改写不能拖垮内存，模板还要能按请求参数动态生成。

三条现场的「输入 → 动作 → 输出」是同构的：输入都是「依赖未就绪」（接口没写、要按条件给不同结果、内容体积变大），动作统一为在 handler 里短路转发、用 `rule.value` 直接造响应，输出是一份不改前端地址、不占端口、可即时改动的契约。

为什么这样设计：把约束写成「不改请求地址、不另起假后端、故障比例可重复可关闭」，是为了先排除掉「真起一个服务」这条路——那要么得改 baseURL、要么得抢端口，而且注入 500 会真把服务打挂。短路让「故障」退化成一次返回值，测试要的「可重复、可关闭」才成立：想关掉故障，删掉那条规则即可，不必去重启或恢复一个被打挂的后端。

代价与边界：短路响应没走真实网络栈，socket 层超时、握手、分块传输这些行为都不会被覆盖；要验证它们得回到 19 的真实改道，或用 22 的弱网与异常注入。换句话说，Mock 能证明「前端拿到这份数据会怎么渲染」，不能证明「这条链路在线上真的通」，两者别混为一谈。

类比：像拍电影用的道具餐，看着是一桌菜（状态码、响应头、正文齐全），其实没有厨房（后端）、也不用点火（不出网），只负责让镜头（前端渲染）顺利走完。

最小自验：对照 `www.example.com/api/data file://({"status":"ok"})` 与 `www.example.com/api/unstable statusCode://500 includeFilter://chance:0.5`，两者都不含任何目标主机或端口；由此即可自证「响应由代理本地构造、不依赖后端存在」，不必真的把服务关掉去试。

三条现场与后文四段配置对应得上：前端「接口没写却要渲染」对应第一段内联 `()` 与模板；测试「按方法、按请求体、按概率分流」对应 `includeFilter://m:GET`、`b:` 与 `chance:0.5` 那段；契约维护者「内容从几行长到几百 KB」对应 2KB / 200KB 的分档那段。先看痛点，就知道四段不是四种并列语法，而是四种不同的约束各自逼出来的写法。

按角色看也清楚：前端要的是「地址不动就有数据」，测试要的是「同一 URL 上能重复注入故障、还能一键关掉」，契约维护者要的是「改了即时生效又不撑爆内存」。三者能同时满足，是因为它们分别落在值来源、过滤器、容量阈值三个不同层面；后面「背后的设计思想」四条原则，正好各管一层，少一条就有一类诉求落空。

## 可复制的配置


> **动手前**：规则写在 **Rules**，内联值或 `{key}` 引用的内容建在 **Values**（Create 新建并保存）。若还没把工具跑起来，先完成 [第 0 站](/guide/quickstart) 第 5 步与通关自检第 9 项；示例域名请换成你能访问的站点。下面示例里的域名、IP、路径与 `{key}` 都是占位，请替换成你自己的目标；引用 `{key}` 之前，先在 Values 里 Create 好同名条目。

内联值是最轻的一档，必须用 `()` 包裹；`tpl` 与 `resType` 分别负责动态模板与响应类型。

```txt
# 来源：docs/docs/rules/file.md、tpl.md、operation.md
# 内联 JSON，括号不可省略
www.example.com/api/data file://({"status":"ok"})
# 本地 JS 模板按请求参数生成响应
https://www.example.com/test/tpl tpl:///User/xxx/test.js
# 直接返回内容并指定响应类型
www.example.com/api file://(直接返回的内容) resType://html
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

四段规则对应四种契约来源：内联值适合几行 JSON，模板适合按 `${query.callback}` 等变量动态生成，Values 适合团队共享的中等体积内容，本地文件适合大体积与频繁编辑。它们在编译期都被拍平成同一个 rule 对象，区别只在 `resolveValue` 求值阶段从哪里取 `value`；也正因如此，把一份 Mock 从内联挪到 Values 时，[pattern](/concepts/06-rules) 与过滤器都不必改动。

把这段结论拆成「输入 → 动作 → 输出」：输入是一行 pattern 加一个值来源（内联 `()`、`{key}`、模板路径或本地文件）；动作是编译期把它们拍平成同一个 rule 对象、请求期由 `resolveValue` 从对应位置取出 `value`；输出是一份统一的响应体，handler 根本不区分它从哪来。四种来源收敛成一种结构，是后面「编译期只结构化、请求期才求值」那条原则的具体体现。

为什么这样设计：把「值从哪来」推迟到请求期，是为了让同一条 pattern 与过滤器在三种存储之间迁移时零改动。若编译期就把内容写死，从内联挪到 Values 等于重写整条规则；延迟求值把「匹配」和「取值」解耦，容量分档才只是换一处存储、不动规则结构。

代价与边界：延迟求值的代价是 `{key}` 在 Values 里找不到时会落空，且大体积内容每次命中都要读一次；所以才用 2KB 与 200KB 把「频繁编辑的大内容」赶到本地文件，避免常驻内存被撑大。这也是为什么「改动即时生效」与「别放太大的内容」必须同时讲——两者是同一个内存约束的两面。

类比：像同一张订单（pattern）可以写「现货」（内联）、「仓库自提」（Values）或「按图现做」（模板），收银台（handler）只认最终端上来的那盘菜（value），不关心它从哪来、在哪做。

最小自验：把 `file://({"status":"ok"})` 换成 `file://{result.json}` 的写法，其余 pattern 与过滤器都不动，按「pattern 与过滤器都不必改动」即可自验「值来源与匹配是解耦的」——用上面两段现成配置对照即可，不需要真去建一个 Values。

把四种值来源的「输入 → 求值位置」摊开：内联 `()` 的输入就写在那一行规则里、编译期被 `formatShorthand` 补成 `file://`；`{key}` 的输入是一个 Values 键名、请求期才去取值；模板路径的输入是一个本地 JS 文件、按 `${query.callback}` 之类的变量动态生成；本地文件的输入是一个磁盘路径、由 handler 读出来。四者输入各异，却在编译期被拍平成同一个 rule 对象，handler 只面对统一的 `value`，这正是上面那句结论展开后的样子。

反过来想，若编译期就把内容写死在 rule 对象里，会有什么后果：把一份 Mock 从内联挪到 Values 时，pattern、过滤器、值都得重写一遍，`{key}` 这种「先引用、后取值」的写法也就不存在了；更麻烦的是大体积内容会在每次重编译里被整份搬动。延迟求值看似只是个实现细节，实际撑起了「容量分档只是换存储、不动规则」这个便利。

## 背后的设计思想

- [短路转发](/core/http-request)：`file` / `tpl` 由 `lib/handlers/file-proxy.js:259-260` 删掉 `rules.proxy` 与 `rules.host` 后，用 `rule.value` 直接构造 200 响应；`statusCode` 则在 `lib/inspectors/res.js:1313-1319` 于出站前取 `getStatusCodeFromRule` 的结果 `res.response(...)` 并置 `Connection: close`，连 file-proxy 这一层都不到。两条路径都不拨出站 socket，后端不存在也能返回结果，故障注入也不会真把上游打挂。
- [配置即代码、可热替换](/modules/rules-engine)：规则文本与 Values 都是可编辑的文本，`lib/rules/util.js:58-106` 监听变更并整份重编译。因此把契约从内联值挪到 Values、再挪到本地文件，只是换一处存储，不需要重启进程；`w2 add` 导入 `.whistle.js` 走的是同一条更新链。
- [内存有界优先于数据完整](/core/capture-data)：容量分档不是文档建议而是实现约束。[抓包](/concepts/05-capture)侧 `lib/inspectors/data.js:8-11` 把请求体、响应体上限设为 2MB、大对象上限 16MB；合并改写也只对小于 2MB 的 body 自动生效。宁可截断，也不让一份巨型 Mock 撑爆常驻内存。
- [解析期与请求期分离](/modules/rules-engine)：`lib/rules/rules.js:1745-1806` 的 `parseText` 只把一行文本结构化成 rule 对象，`resolveValue` 与 `{key}` 引用要到命中之后才求值成 `value`。所以内联值、Values、模板在编译期被拍平成统一对象，请求期只面对同一种结构，热路径上不做 IO。

四条原则拼起来正好是一条链：短路转发解释「为什么不出网」，配置即代码解释「为什么改动即时生效」，内存有界解释「为什么有容量分档」，解析期与请求期分离解释「为什么三种来源能共用同一个 rule 对象」。少任何一条，前面那些可复制的配置就退回到了「照着抄」而不是「推得出」；四条合起来，才把「一份返回能从哪来、改了为何立刻生效、大到哪里会被拦下」一次说清。

输入 → 动作 → 输出：输入一段规则文本或一次 Values 改动 → 变更监听触发全量重编译、解析期只做结构化、请求期才求值 → 输出一个不带 IO 的热路径 rule 对象，或直接短路的响应。这条链也解释了为什么「挪动值来源」不需要动 pattern：因为变动发生在求值那一端，不在匹配那一端。

为什么这样设计：抓包侧与合并改写侧共用同一组容量常量（2MB / 16MB），是为了让「能存多少」和「能改多少」用同一把尺子，避免出现「抓得到却改不动」的错位。把阈值放在实现里而不是文档建议里，也意味着它不是可以随手放宽的口味问题，而是内存约束下的硬边界。

代价与边界：宁可截断也不撑爆内存，代价是超大响应会被跳过合并或被截断，调试时容易误判成「规则没生效」；热替换又是「整份重编译」，规则量很大时，一次改动的成本高于增量更新。两者都是用一点便利换常驻内存的稳定，读「边界与坑」时要把这条线索带上。

类比：像餐厅限量供应，宁可少给一份也不让后厨堆到走不动；菜单（规则）可以随时换版，但换版是整本重印，不是改一页。

最小自验：对照 `www.example.com/api/data resBody://({"status":"modified"})` 与「自动合并仅限 body 小于 2MB」这条边界，把合并对象设想成超过 2MB，即可判断 `resMerge` 会被跳过、需要 `enable://resMergeBigData` 一类开关——用已有配置与阈值自验，不必真去造一个大文件。

把四条原则放回 18 的五层尺子：短路转发对应内核机制（请求在哪一步被截断）、配置即代码与解析期请求期分离对应设计原则与编译模型、内存有界对应边界。本篇「背后的设计思想」因此不是四句赞语，而是把「为什么不出网 / 为什么改了就生效 / 为什么有分档 / 为什么能共用结构」这四问逐格填进五层；四问都有答案，前面那些配置才推得出来。

若把 2MB 上限当成可以随手取消的口味问题，后果不在这一条规则上：抓包侧、请求体、响应体、合并改写共用同一组常量，放开一处就等于让一份巨型 Mock 同时被采集、被缓存、被改写三遍，常驻内存会被放大数倍。「宁可截断也不撑爆内存」因此不是保守，而是把风险挡在最早的一环；`enable://resMergeBigData` 只放宽到 16MB、不取消，也是同一个道理。

## 源码链路

按「入口 → 规则解析 → 应用点 → 回写/上报」展开，Mock 的短路位置是这条链的关键。

1. **入口与编译**：`lib/rules/rules.js:1745-1806` 的 `parseText` 逐行 `removeComment`、`split`、`formatShorthand`；`lib/rules/rules.js:225-266` 的 `formatShorthand` 把裸 `()` 内联值补成 `file://` 协议，`{key}` 补成 Values 引用。见 [规则引擎](/modules/rules-engine)。
2. **分桶**：`lib/rules/protocols.js:256-265` 的 `resetRules` 只给 `protocols` 数组内的协议预建数组（`resBody`、`resMerge` 在其中），另建 `_localRule`、`_bodyFilters`、`_clientCerts` 专用桶，并把 `rules.rule.isRuleProto` 置真。`file` / `tpl` / `rawfile` 并不在协议数组里，由 `RULE_RE`（`lib/rules/protocols.js:78`）配合 `isFileProxy`（`:279-283`）在 handler 阶段识别；`status` 经 alias 映射成 `statusCode`（`:143`），它与 `redirect` 在 `lib/rules/rules.js:1311-1322` 被打上 `isSpec` 标记后统一落进 `rules.rule` 桶，靠 `isRuleProto` 区分。见 [指令体系与分发链路](/modules/protocol-catalog)。
3. **命中**：`lib/inspectors/rules.js:29-45` 的 `setupRules` 调 `resolveRules`、`util.filterWeakRule`，再把 `req.options` 定稿；首条命中由 `lib/rules/rules.js:997` 自上而下遍历返回，`includeFilter://m:GET`、`chance:0.5` 由过滤器在 `checkFilter` 阶段判定。见 [一次 HTTP 代理请求的旅程](/core/http-request)。
4. **应用点（短路）**：`lib/handlers/file-proxy.js:233-269` 判定 `isFileProxy` 后删掉 proxy 与 host，用 `rule.value` 直接构造 200 响应；`statusCode` 则由 `lib/util/index.js:3576-3599` 的 `getStatusCodeFromRule` 直接产出 `{ statusCode, headers }`，不经后端。见 [指令体系与分发链路](/modules/protocol-catalog)。
5. **响应改写**：`lib/inspectors/res.js` 承担 `resBody`、`resMerge` 等响应阶段的替换与合并，`lib/handlers/file-proxy.js:250-253` 顺带处理 OPTIONS 预检与 CORS 包装；204/304 之类无响应体的请求在此被跳过。见 [一次 HTTP 代理请求的旅程](/core/http-request)。
6. **回写与热更新**：Values 的 `{key}` 在请求期求值，改动由 `lib/rules/util.js:58-106` 的 `httpMgr.addChangeListener` 触发全量重编译并 `pluginMgr.emit('updateRules', true)`，落盘交给 `lib/rules/storage.js` 的 files / values / properties 目录；旁路采样仍记入 [抓包数据的采集与上报](/core/capture-data)。见 [规则引擎](/modules/rules-engine)。

把 1–6 收拢成「输入 → 动作 → 输出」：输入一条含 `file` / `tpl` / `statusCode` / `resBody` 的规则 → 逐行结构化、按协议或专用桶分装、setupRules 定稿 `req.options`、首条命中 → file-proxy 删掉 proxy 与 host 直接构造 200，或由 res 阶段做替换与合并 → 输出一份不出网或经改写的响应，Values 的改动再经全量重编译热更新。

为什么这样设计：`file` / `tpl` 不进协议数组、留到 handler 阶段由 `isFileProxy` 识别，是因为它们要「短路整条出站链」；若放在请求期分桶里当成普通改写指令消费，就会先被取用、再谈不上下掉 proxy 与 host。把短路判定放到最后一公里，才能干净地让请求哪儿都不去，这也是本篇「根本不出网」在链路上的落点。

代价与边界：短路点靠后，意味着前面 1–3 步（解析、分桶、命中）一步没少，一条 `file` 规则并非零成本，只是省掉了出站 socket 与后端等待。排查「短路没生效」仍要按 1→6 逐段看，不能只盯 file-proxy；另外第 6 步里 `pluginMgr` 这个前缀本身就指向 [插件](/concepts/07-extension) 体系，说明热更新链路与扩展机制是接在一起的，而不只是内核自己重编译。

类比：像快递在最后一公里被「就地签收退回」，前面的揽收、分拣、装车一步没少，只是没上路；所以「省下了路费」不等于「没走过流程」。

最小自验：把第 4 步「删 proxy 与 host、直接构造 200」与第 6 步「Values 的 `{key}` 在请求期求值」对照看——前者决定「去不去后端」，后者决定「响应内容从哪来」，两件事分处链路两端，就能理解为什么「挪动值来源」不会影响「短路是否发生」。

六步与七段模板里「源码链路」一节是同一条链的两种粒度：模板给的是「入口 → 规则解析 → 应用点 → 回写」的粗线，本篇细到 parseText、分桶、setupRules、短路、响应改写、热更新六个工位。其中第 2 步的分桶最容易被跳过——`file` / `tpl` 不在协议数组里，正是后面短路能干净发生的前提，读的时候要特意停一下，别把它当成普通分桶规则扫过去。

按 1→6 排查「短路没生效」可以这样问：这行规则有没有被 `formatShorthand` 正确补成协议（第 1 步）→ 有没有落进该落的桶、还是被当成普通改写指令（第 2 步）→ 过滤器有没有把这回请求筛掉（第 3 步）→ `isFileProxy` 有没有判定成立、proxy 与 host 有没有被删掉（第 4 步）。逐段问下来，比反复改 `()` 的写法有效得多。

## 边界与坑

- **内联值必须用 `()` 包裹**：`docs/docs/rules/file.md:26-39` 明确不加括号会被当作本地文件路径或 `{key}`，导致 404；同一篇 `:256-258` 还指出不推荐 `file://https://xxx` 这种形式，远程内容应改用 `https` / `http` 协议。
- **statusCode 默认空响应体、401 会弹认证框**：`docs/docs/rules/statusCode.md:133-145` 说明默认内容为空，需配合 `resBody` 才有正文；返回 401 默认触发浏览器登录框，要用 `disable://userLogin` 或 `lineProps://disableUserLogin` 关闭。
- **204/304 无响应体时注入类不生效**：`docs/docs/rules/resBody.md:6` 与 `docs/docs/rules/cssPrepend.md:3` 都标注「204、304 等无响应内容体的请求不受影响」，`resBody`、`htmlAppend`、`jsPrepend` 等注入与替换规则会被跳过。
- **GET/HEAD 无请求体时 reqBody 不生效**：`docs/docs/rules/reqBody.md:3` 写明 GET、HEAD 等无内容体的请求不受影响，`docs/docs/gui/composer.md:24` 也从界面侧确认 GET/HEAD/OPTIONS 会自动忽略请求体。
- **resMerge / reqMerge 自动合并仅限 body 小于 2MB**：`docs/docs/rules/resMerge.md:52` 与 `reqMerge.md:52` 规定超限跳过，需加 `enable://resMergeBigData` / `enable://reqMergeBigData` 或 `lineProps://enableBigData`；请求侧阈值是 `lib/inspectors/req.js:19-20,163` 的 `MAX_REQ_SIZE`（2MB）与 `BIG_MAX_REQ_SIZE`（16MB），响应侧对应 `lib/inspectors/res.js:21-22,1010` 的 `MAX_RES_SIZE` / `BIG_MAX_RES_SIZE`，两侧都是把默认 2MB 放宽到 16MB，而不是取消限制。

- **容易以为 `file://({"status":"ok"})` 的括号只是排版，其实不加括号会被当成本地路径或 `{key}` 引用而 404**，括号是「这是内联值」的唯一标记。
- **容易以为 `statusCode://500` 会把服务真的打到 500，其实它根本不出网**，只是在出站前直接回码，后端毫发无伤；`chance:0.5` 也只是决定这一次回不回 500。
- **容易以为 `resBody` / `resMerge` 对所有响应都会生效，其实 204、304 等无响应体的请求会被整段跳过**，注入与替换类规则都落空。
- **容易以为加上 `enable://resMergeBigData` 就取消了 2MB 上限，其实它只把默认 2MB 放宽到 16MB**，上限仍在、默认也仍是 2MB。这几条的共性是把「配置文本看起来会怎样」当成了「链路实际怎样走」，更细的对照可见 [《概念精解 · 易混淆概念辨析》](/concepts/08-confusions)。

把这一节的五条既有坑与上面四条辨析分开看，会更清楚该记什么：五条坑是官方或源码划定的事实边界（括号、空响应体、204/304、无请求体方法、2MB 合并上限），照着改就能绕过；四条辨析是读者心里默认错的模型（括号只是排版、500 真把服务打挂、注入对所有响应生效、放宽即取消上限）。前者是「怎么写才对」，后者是「链路究竟怎么走」，后者只能靠把源码链路走通来纠正，光看配置文本改不出来。

## 小结

- Mock 的本质是短路转发：`file` / `tpl` 在 `lib/handlers/file-proxy.js` 构造响应，`statusCode` 在 `lib/inspectors/res.js:1313-1319` 出站前直接回码，请求不出网，后端未就绪也能联调。
- 同一 URL 的条件化响应靠过滤器表达：`includeFilter://m:GET` 按方法、`b:` 按请求体正则、`chance:0.5` 按概率注入故障。
- 内容容量按 2KB 与 200KB 分三档，内联、Values、本地文件各有归属，改动经 `lib/rules/util.js:58-106` 全量重编译即时生效。
- 编译期只做结构化、请求期才求值，是内联值与 `{key}` 能共用同一 rule 对象的前提。
- 括号、空响应体、204/304、无请求体方法与 2MB 合并上限，是官方与源码共同划定的五类边界。
- 本篇为 [《复现、保存与重放》](/scenarios/reproduce-replay) 准备了「响应可以被凭空构造」这个前提：既然一份返回能不依赖后端、由内联值或 Values 固化下来，21 就顺势回答「那能不能把一次真实请求也整体存成会话、再反复重放」，并把有界缓存与 Composer / CGI 链补上。

## 下一步

[《复现、保存与重放》](/scenarios/reproduce-replay)：当 Mock 不足以解释一个偶现问题时，下一步是把真实请求抓下来、存成会话再反复重放，看 Network 与 Composer 背后的 CGI 与 service 子进程如何协作。之所以紧接着读它，是因为 20 造的响应是「按规则固定生成」的，能覆盖「依赖未就绪」，却解释不了一个只在特定线上流量里偶现的问题；要复现它得先有真实请求数据，这正是 21 从「构造」转向「采集与回放」要补的空白。
