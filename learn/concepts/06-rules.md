---
title: 规则 DSL 全景
description: 以概念词典的方式讲透规则文本、编译分桶、值体系、匹配优先级与热更新，把每个名词落到真实源码与工程场景。
---

# 规则 DSL 全景

本层是「概念精解」的规则语言分册，前置知识是 [规则引擎：解析与匹配](/modules/rules-engine) 与 [指令体系与分发链路](/modules/protocol-catalog) 已经拆过的「编译期 → 请求期」两条泳道。这里不再沿调用链往下走，而是把规则世界里每个名词——pattern、operation、别名、分桶、规则集、Values、模板变量、过滤器、important、热更新——逐个拆成定义、类比、源码落点与设计取舍。读完你能把一行规则逐 token 讲清楚，能判断 `${key}` 与 `${method}` 分别在哪个阶段展开，也能解释为什么改一行规则要整份重编译。

![一条规则的完整解剖](/diagrams/rules-anatomy.svg)
*图注：一行规则被拆成 pattern、operation、lineProps 与 filters，再编译成按协议分桶的 rule 对象。*

## 本层概念地图

规则 DSL 可以切成五簇：**语法**（一行文本的四部分）、**编译**（别名、注册表、分桶、规则集）、**值**（Values、内嵌值、模板与插件变量、远程规则）、**匹配**（四类匹配、过滤、优先级、屏蔽）、**更新**（全量重编译与版本戳）。五簇共用一条主线：文本在编译期被拍平成统一的 rule 对象，请求期只做求值、不再做 IO。下面把词条与主干文件对上，读到后文每张卡片时可回来定位。

::: cols 20|30|50
| 概念簇 | 代表词条 | 主源码落点 |
|---|---|---|
| 语法 | 模式 / 指令 / 属性 / 过滤 | `rule.md` 等 |
| 编译 | 别名 / 注册表 / 分桶 / 规则集 | `rules.js` 等 |
| 值 | Values / 内嵌值 / 模板变量 | `util/index.js` |
| 匹配 | 四类匹配 / 过滤 / 优先级 | `rules.js` |
| 更新 | 热更新 / mflag / 修改戳 | `util.js`、`config.js` |
:::

前置概念只有一句话：用户写的是纯文本，请求期真正使用的是一组按协议分桶、带过滤条件的编译对象。带着这张地图，下面进入词条。

### DSL / 规则文本
> 用一行纯文本描述「匹配谁、做什么」的领域语言。

**打个比方**：像给快递员写的一张便签，「送到 A 栋的件，改投 B 柜」，只有对象与动作两栏，不写程序、不调接口，谁都能照着填，也谁都能一眼读懂。
**在 Whistle 里**：官方语法是 `pattern operation [lineProps...] [filters...]`（`docs/docs/rules/rule.md:8`）；`lib/rules/rules.js:1745-1806` 的 `parseText` 先经 `getLines`（`:410-450`）展开，再对每行依次做 `removeComment`、`split(/\s+/)`、`formatShorthand`（`:225-266`）、`indexOfPattern`（`:1456-1473`）与 `resolveMatchFilter`（`:1549-1739`）。
**为什么这样设计**：文本便于界面编辑、导入导出、远程下发与版本比对；代价是每次变更都要整份重编译，无法只改一行就局部生效。
**容易混淆**：规则文本 ≠ 请求期对象；命中前 rule 只有 `matcher`，求值后才有 `value`，见 [规则引擎](/modules/rules-engine)。
**工程中的样子**：[契约 Mock](/scenarios/mock-contract) 用一行 `pattern file://{mock.json}` 固定接口返回。

### pattern（匹配模式）
> 决定「这条规则命中哪些 URL」的表达式。

**打个比方**：像信封上的收件地址，邮局只看这一栏决定往哪个分拣口送；地址写法可以是精确门牌、整条街通配，也可以是一段特征描述（正则）。
**在 Whistle 里**：`lib/rules/rules.js:929-938` 的 `resolveRuleList` 预生成 `curUrl`、`domainUrl`（`removePort` 去端口）、`url`（`getPureUrl` 去查询串）与 `_domainUrl` 四种形态供不同分支使用；`:997-1120` 按标志位走五条分支，`getPathRule`（`:947-967`）把 `matcher` 与剩余 `filePath` 拼成最终 URL 并支持路径透传。
**为什么这样设计**：同一条规则要兼顾带端口/去端口、带查询串/去查询串的比较，请求期一次性预处理成几组 URL、命中时直接取用，比在热循环里反复裁切更省；代价是这几种形态在命中时必须保持一致。
**容易混淆**：pattern 是匹配表达式，operation 是指令，二者位置可整体调换（见速览表「位置调换」），见 [指令体系](/modules/protocol-catalog)。
**工程中的样子**：[本地环境切换](/scenarios/local-env) 用域名 pattern 把流量整体指向本地端口。

### operation（操作指令）
> 形如 `protocol://value` 的「做什么」。

**打个比方**：像便签右半栏的动词——「改投」「暂存」「转寄」，光有地址没用，还得写清动作；`value` 则是这个动作的参数。
**在 Whistle 里**：`lib/rules/rules.js:1229-1407` 的 `parseRule` 判定协议名、构造 rule 对象并 `list.push`（`:1407`）；`resolveValue`（`:811-852`）在命中后把 `matcher` 对 Values 的引用求值成 `value`、`path` 或 `files` 挂回 rule。
**为什么这样设计**：编译期只做结构化、请求期才求值，把值解析推迟到命中，避免为未命中的规则做无用 IO；代价是插件若在命中前读 `value` 只会拿到 undefined。
**容易混淆**：`matcher` 是编译期字符串，`value` 是请求期求值结果，见 [规则引擎](/modules/rules-engine)。
**工程中的样子**：[契约 Mock](/scenarios/mock-contract) 里 `file://{mock.json}` 的 `{mock.json}` 命中后才会被换成真实内容。

### protocol / 指令 与 协议注册表 / 分桶
> 协议名是唯一合法指令清单，规则按名分桶存放。

**打个比方**：像图书馆按书架编号上架，书号决定它进哪一格；找书时直接去那一格取首本，不必全馆翻一遍，新增一类书也只要加一个编号。
**在 Whistle 里**：`lib/rules/protocols.js:1-75` 的 `protocols` 数组共 73 项，是全站唯一合法协议名清单；`:256-265` 的 `resetRules` 为每个名字预建一个数组，另有 `_localRule`、`_bodyFilters`、`_clientCerts` 三个专用桶；`contains`（`:289-306`）还兼做插件命名空间的保护线。
**为什么这样设计**：「数组即注册表」最朴素——新增内置协议只加一行，分发与阶段筛选自动获得该桶；代价是协议集合启动时即固定，扩展要靠插件的 `xxx://` 回退机制。
**容易混淆**：`statusCode` / `file` 不在这张数组里，见 [指令体系](/modules/protocol-catalog) 与本文「常见误解」。
**工程中的样子**：[协议目录](/modules/protocol-catalog) 把 73 项按请求、响应、出站、路由分类逐项列出。

### 别名（alias）
> 把用户习惯写法归并成正式协议名。

**打个比方**：像通讯录里的「老王」自动指向全名「王建国」，你随口怎么叫都行，档案里登记的始终是正式姓名，不会出现两个人的档案。
**在 Whistle 里**：`lib/rules/protocols.js:131-154` 的 `aliasProtocols` 负责归并：`status → statusCode`、`skip → ignore`、`pathReplace → urlReplace`、`hosts / xhost → host`、`P → G`，以及 `html / js / css` 分别落到 `htmlAppend / jsAppend / cssAppend`；`includeFilter` / `excludeFilter` 也在 `:151-152` 归并到 `filter`。
**为什么这样设计**：兼容历史写法与简写，让用户少敲协议名，又让运行期只面对一个名字；归并只在解析期发生，编译后的 rule 对象里不再有别名。
**容易混淆**：别名只在解析期存在，运行期看到的始终是归并后的名字，见 [指令体系](/modules/protocol-catalog)。
**工程中的样子**：[协作配置](/scenarios/collab-config) 里团队混用 `status` 与 `statusCode` 不会冲突。

### 规则集 / 分组
> 一组可命名、可被整行引用、可分组管理的规则文本。

**打个比方**：像把常用便签装订成一册，需要时写「按第 3 册办」即可，不必每次把十几行重抄一遍；册子还能分门别类放，各人各管一册。
**在 Whistle 里**：整行 `${key}` 由 `lib/rules/rules.js:42` 的 `RULE_KEY_RE` 识别、在 `getLines`（`:410-450`）展开成另一份规则集；整行 `{key}` 由 `:43` 的 `VALUE_KEY_RE` 换成 Values 内容，二者都用局部字典防重复展开。分组判定用 `util.isGroup`（`lib/util/index.js:363`）在 `lib/rules/util.js:147-149` 完成，选中列表由 `:198-208` 的 `getSelectedRulesList` 读取。
**为什么这样设计**：复用与隔离兼顾——公共规则抽成集，团队按组启用；代价是任一被引用集变化都要整份重编译。
**容易混淆**：`${key}` 规则集引用 ≠ `${method}` 模板变量，二者语法相近、时机完全不同，见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[协作配置](/scenarios/collab-config) 用分组让不同成员各管一册规则。

### Default / Mock / Service / Shadow Rules
> 四类内置规则桶，按固定顺序追加、越靠后越晚命中。

**打个比方**：像叠穿的四层衣服，外层最后套上、最先被看到；想让某层生效，得看它压在谁上面，而不是看它写得多早。
**在 Whistle 里**：`lib/rules/util.js:89-99` 的叠加顺序是「选中规则 → Default → Mock → Service → Shadow」，越靠后的桶越晚追加；`backRulesFirst`（`:64-66`）可由 `reverseRules`（`:46-52`）反转行序实现后置优先。
**为什么这样设计**：用「追加顺序」统一表达优先级，避免再引入一套优先级字段；代价是规则写在哪个桶直接决定输赢，调试时容易误判。
**容易混淆**：桶顺序 ≠ 行内顺序，同一桶内仍是首条命中，见 [规则引擎](/modules/rules-engine)。
**工程中的样子**：[契约 Mock](/scenarios/mock-contract) 把 Mock 桶当作团队共享的契约返回源。

### Values 与 内嵌值 / 内联值
> Values 是命名的多行列表；内嵌值是写在规则文件里的值块。

**打个比方**：Values 像公共储物柜，按名字取一整包、谁都能用；内嵌值像把纸条直接夹在这一页书里，只在本文件范围内有效，换一本书就不认。
**在 Whistle 里**：Values 引用由 `lib/rules/rules.js:43` 的 `VALUE_KEY_RE` 与 `resolveValue`（`:811-852`）处理；内嵌值由 `lib/util/index.js:202-241` 的 `resolveInlineValues` 从 ```key``` 块抽出存进 `inlineValues`，`getInlineKey`（`:202-204`）还把键拼上文件名以隔离作用域。
**为什么这样设计**：Values 便于跨规则复用、界面集中管理；内嵌值让单文件自带依赖、便于导入导出；键加文件名前缀避免同名值互相污染。
**容易混淆**：Values ≠ 内嵌值——前者是全局命名存储，后者是文件作用域的临时块，见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[契约 Mock](/scenarios/mock-contract) 把大段响应体放进 Values，规则里只写 `{mock.json}`。

### 模板变量 与 插件变量
> `${method}` 求值期展开，`%plugin=x` 登记为插件变量。

**打个比方**：模板变量像填空答题卡上的 `${姓名}`，交卷时才按当场信息填；插件变量像给插件留的署名栏，先登记、后由插件自己认领。
**在 Whistle 里**：`lib/rules/rules.js:76-77` 的 `TPL_VAR_RE` 列出 `${method}`、`${now}`、`${reqHeaders.x}` 等，`:721-789` 的 `resolveTplVar` / `renderTpl` / `resolveVar` 在求值阶段替换，反引号模板由 `:70` 的 `TPL_RE` 识别；`%plugin=x` 由 `:91` 的 `PLUGIN_VAR_RE` 收集到 `_globalPluginVars`（`:1755-1768`）。
**为什么这样设计**：把「运行时才知道的值」推迟到求值期，规则文本本身保持静态可复用；插件变量让插件在不改解析器的前提下注入自定义取值。
**容易混淆**：`${method}` 模板变量 ≠ `${key}` 规则集引用，前者求值期替换、后者编译期展开，见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[协作配置](/scenarios/collab-config) 用 `${reqHeaders.x-env}` 按请求头分流到不同契约。

### `@` 远程规则
> 以 `@url` 引入一份远程或本地文件里的规则。

**打个比方**：像在便签上写「细则见公告栏」，公告栏换了内容，便签不用改；只是你得定期去看公告栏更新没有，不能指望它实时喊你。
**在 Whistle 里**：`lib/util/index.js:3305-3318` 的 `REMOTE_RULES_RE` 与 `getRemoteRulesResolver` 在编译前替换 `@url`；`lib/util/http-mgr.js:425-449` 的 `add` 把 URL 登记进缓存，本地路径按 `:38-45` 的 5000 ms、远端按间隔轮询，最多 20 条（`lib/util/index.js:3304`）。
**为什么这样设计**：让规则能集中托管、多端共享，编译期展开后请求期仍只看统一文本；代价是远程变更触发全量重编译，且存在轮询延迟。
**容易混淆**：远程规则轮询 ≠ UI 抓包短轮询，前者是配置同步、后者是数据上报，见 [协作配置](/scenarios/collab-config)。
**工程中的样子**：[协作配置](/scenarios/collab-config) 用 `@https://.../rules.txt` 让团队共用一份规则。

### rulesFile / reqScript / resScript / frameScript 与 脚本沙箱上下文
> 脚本类指令动态产生规则或改帧，跑在受限上下文中。

**打个比方**：像给流水线装一台可编程小电脑，只递给它当前件的资料和几个按钮，不让它碰整座工厂的电闸；它能算出该贴什么标签，却动不了别的线。
**在 Whistle 里**：`reqScript` / `resRules` 等由 `lib/rules/protocols.js:133-137` 归并到 `rulesFile` / `resScript`；`lib/rules/rules.js:379-408` 处理多行与插件模板，`resolveRules`（`:2239-2299`）对脚本类协议用 `getRuleList`（`:2301-2314`）收集全部命中。帧脚本的上下文（url、headers、values、`ctx.sendToClient`、`ctx.destroy` 等）见 `docs/docs/rules/frameScript.md:41-61`。
**为什么这样设计**：把「按请求动态决定」的能力开放给用户，又用上下文限定可见对象，避免脚本直接触达内核；代价是脚本执行落在热路径，高频变化才应放动态 hook。
**容易混淆**：`rulesFile` 改的是规则，`frameScript` 改的是帧，见 [规则引擎](/modules/rules-engine)。
**工程中的样子**：[契约 Mock](/scenarios/mock-contract) 用 `rulesFile` 按请求头动态挑选契约。

### 过滤器 filter / includeFilter / excludeFilter / 属性过滤器
> 精确控制「规则在什么场景才生效」的条件。

**打个比方**：像便签上补一句「仅工作日、仅加急件」，地址对了还得满足这些附加条件才照办，否则这张便签当没写。
**在 Whistle 里**：`lib/rules/rules.js:57` 的 `PROPS_FILTER_RE` 一次列出方法、IP、请求头、env、状态码、SNI、客户端端口、服务端 IP 等属性（缩写 `m / i / h / b / s / chance`），`:54` 的 `PATTERN_FILTER_RE` 处理 `filter://.../i`；`resolveMatchFilter`（`:1549-1739`）编译进 `filters`，`matchFilter` / `matchExcludeFilters`（`:1819-2009`）统一判定，`includeFilter` / `excludeFilter` 经 `lib/rules/protocols.js:151-152` 归并到 `filter`。
**为什么这样设计**：匹配与过滤分离，让同一批规则按方法、头部、比例精细切分；include 要求至少命中一条、exclude 要求一条都不沾，语义正交。
**容易混淆**：属性过滤器（`m:POST`）≠ 整行模式过滤（`filter://.../i`），见 [规则引擎](/modules/rules-engine)。
**工程中的样子**：[故障注入](/scenarios/fault-injection) 用 `chance` 按比例注入失败。

### lineProps / important
> 行属性只修饰当前规则，`important` 把规则插到同类协议最前。

**打个比方**：像给某一张便签贴「加急」贴纸，只影响这一张、不改动整叠顺序；加急的被挪到同格书架最顺手的位置，但只在自己那一格里挪。
**在 Whistle 里**：`lineProps` 由 `lib/rules/rules.js:55` 的 `LINE_PROPS_RE` 识别；`important` 在 `:1400-1406` 把规则插到该协议数组第一个非 important 元素之前，跳过已有 important 以保持相对顺序；`isImportant` / `mergeRule`（`lib/util/index.js:2163-2193`）在合并时优先保留 important 项。
**为什么这样设计**：在「顺序即优先级」的模型里，用一个行内标记提供有限的提权，而不引入全局优先级字段；代价是它只在同类协议内生效，跨协议无效。
**容易混淆**：`important` 仅对同类协议生效，见 [规则引擎](/modules/rules-engine) 与本文「常见误解」。
**工程中的样子**：[协作配置](/scenarios/collab-config) 用 `lineProps://important` 让兜底规则压过普通规则。

### 首条命中 / 多命中 / backRulesFirst / 弱规则
> 默认每协议取首条命中，四种机制补丁式地改变顺序。

**打个比方**：像在一格书架里从前往后抽，抽到第一本就走；「多命中」是把这一格全抱走，「后置优先」是把书架反过来摆，「弱规则」则是有人占座时主动让位。
**在 Whistle 里**：`lib/rules/rules.js:997` 的循环自上而下、`--index < 0` 即构造结果并 `return`；`lib/rules/protocols.js:186-227` 的 `multiMatchs` 列出 40 个允许多命中的协议，`rules.js:2273-2296` 对它们改用 `getRuleList`；`backRulesFirst` 由 `lib/rules/util.js:64-66` 读取、`:46-52` 的 `reverseRules` 反转行序；`filterWeakRule`（`lib/util/index.js:3741-3753`）在存在 `host` 或 `proxy` 时删掉弱 `rule`。
**为什么这样设计**：规则集通常几十到几百行，线性扫描比维护有序索引更省。`resolveRuleList`（`lib/rules/rules.js:929`）从 `list` 头部逐条取规则，命中且 `checkFilter()` 通过时 `--index < 0`（`:1019`）即构造结果并 `return`；`multiMatchs` 里的协议改走 `getRuleList`（`:2273-2296`）收齐全部命中再挂到 `rule.list`。四种机制都是把「顺序」当唯一优先级模型后的有限补丁，不额外建索引。
**容易混淆**：首条命中是「同协议内」，多命中只对 `multiMatchs` 里的 40 项生效，见 [指令体系](/modules/protocol-catalog)。
**工程中的样子**：[本地环境切换](/scenarios/local-env) 靠行序决定哪条 host 规则先命中。

### ignore / skip
> `ignore` 按协议名删掉已命中的结果；`skip` 按 pattern/operation 跳过当前规则、继续匹配后面的同类规则。

**打个比方**：像给书架贴「这几格今天不借」，并非关掉整个图书馆；其它格子照常开放，只是被贴的几格取不到书。
**在 Whistle 里**：`lib/rules/protocols.js:140` 的 `skip: 'ignore'` 只是**协议名**别名——`skip://...` 与 `ignore://...` 都进 `ignore` 桶；差别在 matcher 的写法，由 `resolveProps`（`lib/rules/rules.js:1125-1160`，经 `resolveFilter` `:2208` 以 `isIgnore=true` 调用）分流。普通 `ignore://file|host` 走 `EXACT_IGNORE_RE` 分支写 `result['ignore|...']`，最终 `ignoreRules`（`lib/util/index.js:2090-2139`）`delete rules[name]`；而 `skip://operation=...` / `skip://pattern=...` 的 matcher 带 `skip://` 前缀（`SKIP_RE`，`rules.js:96`），走另一分支写 `req._skipProps`（`:1138-1147`）。
**为什么这样设计**：两条屏蔽路径作用点不同。`ignoreRules` 在 `resolveRules` 收尾（`lib/rules/rules.js:2297`）删掉已取到的首条命中，该协议**不再**尝试同类型后续规则（官方 `docs/docs/rules/ignore.md:28-29`）；`req._skipProps` 则在匹配循环（`:997-1001`）里由 `checkSkip`（`lib/util/index.js:2011-2021`）逐条 `continue`，跳过当前规则后**继续**在同类列表里往下匹配（`docs/docs/rules/skip.md` 的示例即命中第二条 `file` 规则）。别名说的是「协议名」、`_skipProps` 说的是「matcher 的 `skip://` 前缀」，二者不矛盾；其余协议始终各自取首条命中、不受影响。
**容易混淆**：ignore/skip ≠ 终止整条规则链，也 ≠ 否定匹配（`!pattern`），见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[故障注入](/scenarios/fault-injection) 用 `ignore://*` 临时关掉一批改写规则。

### 精确 / 通配 / 正则 / 前缀匹配 · 否定 · 子匹配 $0..$9 · 路径边界
> 四种 pattern 形态、取反与捕获组传值。

**打个比方**：像四种找人方式——报全名（精确）、按姓氏通配（通配）、按特征描述（正则）、按街区前缀（前缀）；前缀还得确认门牌边界，别把「王府井」当成「王府井大街 1 号」的邻居。
**在 Whistle 里**：`lib/rules/rules.js:997-1120` 按 `isRegExp`、`wildcard`、`isExact`、`indexOf === 0` 走五分支，否定由各分支的 `not`（`:18-19` 的 `NON_RE`）取反；`parseWildcard`（`:1162-1228`）把域名与路径编译成 `preMatch` 与 `path`，`getPathRule`（`:947-967`）处理路径边界与分隔符检查，避免 `/foo` 误伤 `/foobar`；子匹配由 `replaceSubMatcher`（`:876-883`）写回 `$0..$9`。
**为什么这样设计**：把四种匹配统一编译成 rule 上的标志位，请求期只做一次分支判断；路径边界单独检查，是前缀匹配最容易「过度命中」的地方。
**容易混淆**：`!pattern` 否定匹配 ≠ `ignore://` 屏蔽协议，前者改命中结果、后者删命中项，见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[本地环境切换](/scenarios/local-env) 用 `$` 精确与 `/regex/` 正则隔离路径。

### tunnel:// 伪 URL / Final URL / realUrl
> `tunnel://` 是记账伪协议，realUrl 是改写后的真实目标。

**打个比方**：像物流单上的「内部中转编号」与「最终收件地址」——前者只是仓库自己记账用，不对应任何真实地点；后者才是车真正要开去的地方。
**在 Whistle 里**：不解密的 CONNECT 被记成 `tunnel://host:port`（`lib/tunnel.js:75`）；`WEB_PROTOCOL_RE`（`lib/rules/rules.js:22`）把 `tunnel` 列入可匹配的伪协议；`realUrl` 由 `biz/webui/cgi-bin/get-matched-rules.js:11` 随命中详情返回，Test Rules 据此展示规则改写后的真实目标。
**为什么这样设计**：任意端口的 TCP 隧道没有 HTTP URL，需要一个统一形态参与规则匹配与抓包登记；`realUrl` 把「客户端以为的地址」与「实际发出的地址」分开，便于调试转发类规则。
**容易混淆**：`tunnel://` ≠ 真实协议，也不在 `protocols` 数组里，见 [隧道、WebSocket 与帧拦截](/core/tunnel-websocket) 与本文「常见误解」。
**工程中的样子**：[远程调试](/scenarios/mobile-remote) 里用 Test Rules 对照 `realUrl` 与原始 URL。

### 热更新 / mflag / setModified
> 规则变更触发全量重编译，靠版本戳通知界面重拉。

**打个比方**：像公告栏换了一版，管理员不逐条通知每个人，只在栏角改个版号；大家路过对一下版号，变了才重读整栏，没变就各干各的。
**在 Whistle 里**：`lib/rules/util.js:58-106` 注册 `httpMgr.addChangeListener`，每次变更重新拼好规则集并调 `rules.parse(rulesList)`，同时 `pluginMgr.emit('updateRules', true)`；`Rules.prototype.parse` / `append` / `clearAppend`（`lib/rules/rules.js:2051-2110`）维护 `_rawText` 与 `_mflag`；`config.setModified`（`lib/config.js:1126-1134`）打 `mrulesClientId` / `mrulesTime`；前端 `htdocs/src/js/data-center.js:903` 轮询比对后刷新，插件变更由 `lib/plugins/index.js:508-550` 触发 `updateRules`。
**为什么这样设计**：全量重编译把展开、模板、远程与优先级收敛到同一条路径，避免局部增量与规则集叠加顺序产生分歧；代价是改一行也重编整份，故用版本戳而非推数据来省带宽。
**容易混淆**：`mflag` 是编译侧版本标记，`setModified` 是配置侧修改戳，二者不是一回事，见 [规则引擎](/modules/rules-engine)。
**工程中的样子**：[协作配置](/scenarios/collab-config) 里成员保存规则后，各端靠这串戳自动同步。

## 次要词条速览

下面这些名词在规则文件与界面里高频出现，不必各占一张卡片，但同样要能一眼分清它落在哪、和谁容易混。表格的「源码落点」一律写主干文件与行号锚点。

::: cols 20|30|28|22
| 名词 | 一句话 | 源码落点 | 易混淆 |
|---|---|---|---|
| style | 界面着色样式 | `protocols.js:3` | 不改报文 |
| enable / disable | 全局能力开关 | `protocols.js:15-16` | 非行内过滤器 |
| delete | 删除指定头字段 | `protocols.js:17` | 非删会话 |
| responseFor | 用指定响应替换 | `protocols.js:31` | 非 resScript |
| pipe | 串联两条规则 | `protocols.js:6` | 非 proxy |
| plugin | 调用插件协议 | `protocols.js:19` | 非内置桶 |
| G / P 插件变量 | 全局插件变量引用 | `protocols.js:153` | P 归并到 G |
| 远程规则轮询 | @url 定时刷新 | `http-mgr.js:38` | 非抓包轮询 |
| 后缀过滤 | 按扩展名匹配 | `rules.js:85` | 非 includeFilter |
| headerReplace | 替换请求头值 | `protocols.js:37` | 非 reqHeaders |
| urlReplace | 重写 URL 路径 | `protocols.js:57` | pathReplace 别名 |
| reqMerge / resMerge | 合并 JSON 字段 | `protocols.js:25` | reqMerge→params |
| 多行规则块 | `line\`\`` 代码块 | `rules.js:21,379` | 非注释 |
| 位置调换 | 操作写在模式前 | `rules.js:1782` | 非语法错误 |
| 注释 | `#` 之后被剥除 | `common.js:2132` | 值内 # 需转义 |
:::

其中 `lib/rules/protocols.js:1-75` 的 73 项数组与 `:131-154` 的别名表是理解整张表的钥匙：速览里的 `urlReplace`、`pathReplace`、`status` 能同时存在，正因为别名在解析期归并；`style` / `enable` / `delete` 之所以能影响全局，是因为它们本身就在协议数组里、各自有桶。把「协议名」与「写法」混为一谈，就会误以为改了别名却「没生效」。

## 与工程实际结合

### 一行规则的逐 token 解剖

把 `docs/docs/rules/rule.md` 的四部分语法拼成一条包含全部成分的「完整规则」，再逐 token 拆开。下表行号均在 `lib/rules/rules.js`：

```txt
# 组合自 docs/docs/rules/rule.md 的语法结构
www.example.com/api file://{mock} reqHeaders://{hdr} lineProps://important includeFilter://m:POST excludeFilter:///admin
```

::: cols 24|26|50
| token | 属于 | 含义与落点 |
|---|---|---|
| `www.example.com/api` | pattern | 前缀命中，`:1088` |
| `file://{mock}` | operation | 文件加 Values，`:1229` |
| `reqHeaders://{hdr}` | operation | 改请求头，`:811` |
| `lineProps://important` | lineProps | 提权插队，`:1400` |
| `includeFilter://m:POST` | filter | 仅 POST 生效，`:1549` |
| `excludeFilter:///admin` | filter | 排除路径，`:1819` |
:::

`parseText`（`lib/rules/rules.js:1745-1806`）先 `getLines` 展开，再用 `indexOfPattern`（`:1456-1473`）确认首个 token 是 pattern；若把 operation 写在前面，`:1782-1800` 会把「操作列表 × 模式列表」做笛卡尔积再逐条 `parseRule`，这就是速览表里的「位置调换」。过滤器经 `resolveMatchFilter`（`:1549-1739`）编译，由 `matchExcludeFilters`（`:1819-2009`）统一判定：存在 include 时要求至少命中一条且不被 exclude 命中，否则只要求不被 exclude 命中。

### 来自官方文档的真实示例

`docs/docs/rules/rule.md` 给出的「组合配置」示例，一条规则串起三个 operation：

```txt
# 来源：docs/docs/rules/rule.md（组合配置）
www.example.com/* file:///static-files cache://3600 resCors://*
```

「位置调换」示例说明同一语义可以有另一种写法：

```txt
# 来源：docs/docs/rules/rule.md（位置调换）
proxy://127.0.0.1:8080 www.example.com api.example.com
```

「契约 Mock」用第一类写法把接口固定成本地文件，「本地环境切换」用第二类写法批量改目标，分别见 [契约 Mock](/scenarios/mock-contract) 与 [本地环境切换](/scenarios/local-env)。团队协作时再用 `@url` 远程规则（[协作配置](/scenarios/collab-config)）统一分发，改完由 `setModified`（`lib/config.js:1126-1134`）打戳通知各端重拉。整条语法链的实现见 [规则引擎](/modules/rules-engine)，协议落点见 [指令体系](/modules/protocol-catalog)。

## 常见误解

- **URL 匹配不用 LRU**。`regUrlCache` / `hostCache`（`lib/rules/rules.js:64-65`）只是两个普通对象，且在每次 `parseText` 结束时被整体清空（`:1804-1805`），只缓存同一次编译内的正则 URL 解析结果。lru-cache 用在别处：模板编译 `tplCache`（`lib/rules/index.js:20`）、证书缓存与插件动态规则缓存。见 [规则引擎](/modules/rules-engine)。
- **`ignore` 与 `skip` 只在协议名层面是别名，语义并不等价**。`lib/rules/protocols.js:140` 的 `skip: 'ignore'` 让两者共用 `ignore` 桶，但 `resolveProps`（`lib/rules/rules.js:1125-1160`）按 matcher 是否带 `skip://` 前缀分流：普通 `ignore://` 由 `ignoreRules`（`lib/util/index.js:2090-2139`）`delete rules[name]` 删掉已取的首条命中，该协议不再匹配同类型其它规则；`skip://` 则写 `req._skipProps`，在匹配循环（`:997-1001`）逐条跳过、继续匹配后面的同类规则。区别在于「同类型其它规则还试不试」，其余协议照常保留、匹配链并未中止；这正是官方 `ignore.md:28-29` 与 `skip.md` 的差别。见 [概念辨析](/concepts/08-confusions)。
- **`statusCode` / `redirect` / `file` / `tpl` / `rawfile` 都不在 `protocols` 数组**。`lib/rules/protocols.js:1-75` 的 73 项里没有它们：`status → statusCode`（`:143`）与 `redirect` 归并后被 `lib/rules/rules.js:1311-1314` 标成 `isSpec`(1/2)，由 `lib/util/index.js:3576-3599` 在发请求前短路返回；`file` / `rawfile` / `tpl` / `dust` / `jsonp` 由 `lib/rules/protocols.js:78` 的 `RULE_RE` 经 `protoMgr.isFileProxy`（`:279-283`）识别，再由 `lib/handlers/file-proxy.js:233-238` 按 `options.protocol` 分发。见 [指令体系](/modules/protocol-catalog)。
- **`important` 仅对同类协议生效**。`lib/rules/rules.js:1400-1406` 把规则插到「该协议数组」第一个非 important 元素之前，跨协议的桶互不影响；`lib/util/index.js:2163-2193` 的 `mergeRule` 也只在同桶合并时优先保留 important。见 [规则引擎](/modules/rules-engine)。
- **Values ≠ 内嵌值**。Values 是全局命名存储，由 `lib/rules/rules.js:43` 的 `VALUE_KEY_RE` 与 `resolveValue`（`:811-852`）引用；内嵌值是写在规则文件 ```key``` 块里、由 `lib/util/index.js:202-241` 抽取并拼上文件名隔离作用域的临时块。见 [概念辨析](/concepts/08-confusions)。
- **`${key}` 规则集 ≠ `${method}` 模板变量**。前者由 `lib/rules/rules.js:42` 的 `RULE_KEY_RE` 在编译期经 `getLines`（`:410-450`）整行展开成另一份规则集；后者由 `:76-77` 的 `TPL_VAR_RE` 在求值期经 `:721-789` 替换成请求信息。语法相近、时机完全不同，见 [概念辨析](/concepts/08-confusions)。
- **mflag ≠ setModified**。`_mflag` 是 `Rules.prototype.parse` / `append`（`lib/rules/rules.js:2051-2110`）维护的编译侧版本标记，前端据此判断是否重拉；`setModified`（`lib/config.js:1126-1134`）是配置侧打 `mrulesClientId` / `mrulesTime` 的修改戳。二者分属编译与配置两条线，见 [规则引擎](/modules/rules-engine)。
- **`tunnel://` ≠ 真实协议**。不解密的 CONNECT 被记成 `tunnel://host:port`（`lib/tunnel.js:75`）只是记账用的伪 URL，`lib/rules/rules.js:22` 的 `WEB_PROTOCOL_RE` 才让它参与匹配；它不在 73 项 `protocols` 数组里，也没有对应 inspector，见 [隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。
- **别名只在解析期存在**。`lib/rules/protocols.js:131-154` 的 `aliasProtocols` 在 `parseRule` 判定协议时归并，编译后的 rule 对象与运行期 `req.rules` 里只有正式名；但 `contains`（`:289-306`）恰恰也接受 `aliasProtocols[name]`（`:292`），并连带认 `PROXY_RE`、ws/web 伪协议与 `isFileProxy`（`:279-283`），用来拦住插件占用这些名字，并非「只认归并后的名字」。见 [指令体系](/modules/protocol-catalog)。

## 小结

- 一行规则是 `pattern operation [lineProps...] [filters...]`，`parseText` 拆成四部分，`parseRule` 编译成按协议分桶的 rule 对象。
- `protocols` 数组 73 项是唯一注册表，`aliasProtocols` 与 `resetRules` 负责归并写法与预建桶；`statusCode` / `file` 走特殊路径，不在数组内。
- `${key}` 规则集、内嵌值、模板变量、插件变量与 `@url` 远程规则都在编译期拍平，请求期只做求值。
- 匹配按正则、通配、精确、前缀、否定五分支推进，默认同协议首条命中；important、multiMatchs、backRulesFirst、filterWeakRule 是有限补丁。
- `regUrlCache` / `hostCache` 每次编译后清空；规则变更触发全量重编译，由 `_mflag`、`setModified` 与前端轮询串成闭环。

## 下一步

[《扩展机制与工程化》](/concepts/07-extension)：规则语言已经能描述匹配、值、优先与更新，下一篇转向「语言之外」——插件与脚本怎样注册协议、注入动态规则，把 Whistle 的能力边界继续往外推。
