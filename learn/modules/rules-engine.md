---
title: 规则引擎：解析与匹配
description: 从一行规则文本到请求期求值，拆解编译、分桶、匹配、优先级与热更新的完整链路。
---

# 规则引擎：解析与匹配

规则引擎是 Whistle 最核心、也最容易读错的一层：用户写的是一行文本，请求期真正使用的却是一组按协议分桶、带过滤条件的编译对象。本篇面向要改匹配逻辑或写[插件](/concepts/07-extension)的开发者，沿「编译期 → 请求期」两条泳道走完 `lib/rules/rules.js`，并澄清缓存、[优先级](/concepts/06-rules)与热更新上的常见误解。所有结论都落到当前分支的具体行号，便于逐段对照源码验证。前面 09 把 `req.rules`、`req.options` 当作「已经算好的规则产物」用了一整条链路、12 把请求与帧的采集上报闭环，却都把「一行规则文本怎么变成这些产物」留成了黑盒；本篇就补上这个黑盒，读完后你能对着任意一条规则，说清它先被编译成什么、又在请求期如何被求值命中。

::: tip 先修知识
先做 [第 0 站](/guide/quickstart)：本篇讲的是你在 Rules 与界面背后动过的那套机制。

若某个名词卡住，按主题回查 [概念精解总览](/concepts/index) 与 [《全量术语索引》](/concepts/glossary)；正文在术语首次出现处也给了对应链接。

不需要预先读过源码，但能分清「编译期只做结构化、请求期才做求值」就够了；成对辨析可查 [《易混淆概念辨析》](/concepts/08-confusions)，忘记名词查 [《全量术语索引》](/concepts/glossary)。

给不熟源码的读者补一句：09 / 12 里反复出现的 `req.rules`、`reqDelay`、`req*` / `res*`、`MAX_PAYLOAD_SIZE`，讲的都是「规则已经算好之后」的效果；本篇要回答的恰是它们还没算好之前的样子——用户写进界面的一行文本，经过哪些步骤才变成请求期可直接消费的编译对象。
:::

![规则引擎的编译期与请求期泳道](/diagrams/rules-flow.svg)
*编译期把文本编译成按协议分桶的 rule 对象，请求期按 URL 求首条命中，再把 matcher 求值成 value。*

## 从一行文本到 rule 对象

一行规则的语法是 `pattern operation [lineProps...] [filters...]`：`pattern` 决定命中哪些 URL，`operation` 是带协议的指令，其余是行属性与过滤条件。解析入口是 `lib/rules/rules.js:1745-1806` 的 `parseText`，它先调 `getLines` 展开规则集，再对每一行依次做 `removeComment`、`split(/\s+/)`、`formatShorthand`、`indexOfPattern` 与 `resolveMatchFilter`。注释正则来自 `lib/util/common.js:2132-2136`，它只剥掉 `#` 之后的内容，因此值里的 `#` 需要额外转义。

```js
// lib/rules/rules.js:1773-1780
    line = line.map(formatShorthand);
    var patternIndex = indexOfPattern(line);
    if (patternIndex === -1) {
      return;
    }

    var pattern = line[0];
    var result = resolveMatchFilter(line.slice(1));
```

`formatShorthand`（`rules.js:225-266`）把裸路径补成 `file://`、`{}` 补成值引用、`@` 改写成 `G://`、`%plugin=x` 改写成 `P://`，让用户能少敲协议名。`indexOfPattern`（`rules.js:1456-1473`）判断首个 token 是否为 pattern；若不是，说明用户把操作写在了前面，`rules.js:1782-1800` 会把「操作列表 × 模式列表」做笛卡尔积再逐条 `parseRule`。这个位置调换是 Whistle 支持的双写法，读源码时不要误以为只认一种顺序。多行值由 `rules.js:21` 的 `MULTI_TO_ONE_RE` 在 `getLines` 阶段先合并成单行。

```js
// lib/rules/rules.js:1782-1794
    if (patternIndex > 0) {
      //supports: operator-uri1 operator-uriX pattern1 pattern2 ... patternN
      var opList = [pattern];
      var patternList = matchers.filter(function (p) {
        if (isPattern(p) || isHost(p) || !util.hasProtocol(p)) {
          return true;
        }
        opList.push(p);
      });
      opList.forEach(function (matcher) {
        patternList.forEach(function (pattern) {
          parseRule(rulesMgr, pattern, matcher, raw, root, result, file);
        });
      });
```

分桶发生在 `parseRule`（`rules.js:1229-1408`）：`rules.js:1280-1334` 判定协议名，`rules.js:1335-1361` 构造 rule 对象，最后 `list.push(rule)`（`:1407`）。桶由 `lib/rules/protocols.js:256-265` 的 `resetRules` 预建，每个协议名对应一个数组，另有 `_localRule`、`_bodyFilters`、`_clientCerts` 三个专用桶。命中之后并不直接可用：`resolveValue`（`rules.js:811-852`）会把 `matcher` 里对 Values 的引用求值，产出 `value`、`path` 或 `files` 并挂回 rule。换句话说，编译期只做「结构化」，请求期才做「求值」。`resolveValue` 的求值顺序也值得一读：`rules.js:816-825` 先切出协议前缀并取出 Values 键，`rules.js:826-830` 在值缺失时退回 `getValue` 解析内联内容，`rules.js:842-849` 还对 `style://` 做 128 字符截断、对 `<...>` 形式产出 `path` 与 `files`。因此同一个 rule 对象在命中前只有 `matcher`，命中之后才有 `value`；插件若提前读取只会拿到 undefined。

::: cols 24|34|42
| 字段 | 编译来源 | 请求期用途 |
|---|---|---|---|
| not / isRegExp | `!` / `/regex/` | 否定与正则分支 |
| isExact / wildcard | `$` / `parseWildcard` | 精确与通配分支 |
| matcher / filters | operation / 过滤属性 | 求值成 value |
| lineProps | `lineProps://` | 修饰匹配行为 |
:::

**输入 → 动作 → 输出**：输入是用户写进界面的一行文本（语法是 `pattern operation [lineProps...] [filters...]`），动作是 `parseText` 依次展开规则集、去注释、按空白切词、补全省写协议、定位首个 token 并解析过滤器，再由 `parseRule` 判定协议名、构造 rule 对象、压进对应协议桶；输出是一组按协议分桶、带 `not` / `isRegExp` / `isExact` / `matcher` / `filters` / `lineProps` 等标志位的编译对象。这条泳道到「结构化」为止：`resolveValue` 要等请求命中后才把对 [Values](/concepts/06-rules) 的引用求值成 `value` / `path` / `files`，所以同一个 rule 对象在命中前只有 `matcher`。

上面这一行语法，就是 [规则 DSL](/concepts/06-rules) 的最小书写单位：其中 [`pattern`](/concepts/06-rules) 决定「命中哪些 URL」、[`operation`](/concepts/06-rules) 决定「命中后做什么」，其余行属性与过滤条件只修饰匹配行为。`formatShorthand` 让用户少敲协议名（裸路径补成 `file://`、`{}` 补成值引用、`@` 改写成 `G://`、`%plugin=x` 改写成 `P://`），`indexOfPattern` 又同时支持「操作在前、模式在后」的双写法——两种写法最终都汇到同一批 `parseRule` 调用，读源码时不要把双写法误认成只认一种顺序。

**为什么把「结构化」与「求值」拆到两个时期**：编译期面对的是静态文本，能一次算清协议名、分桶与匹配标志位；而 `matcher` 里对 Values、模板变量、`${...}` 的引用往往依赖「这一次请求」才有意义（例如 `${reqHeaders.x}`、内联内容、`<...>` 形式的文件列表）。把结论展开成推理：若在编译期就把值全部展开，Values 一变、或某个请求头不同，就得重算整份规则；留到请求期命中后再求值，编译结果才能被反复复用。代价是编译好的 rule 对象在命中前是「半成品」，插件若提前读取 `value` 只会拿到 undefined；边界是这套分工只覆盖「一行文本 → 一批桶」，真正跨桶组装成 `req.rules` 是下一篇分发链的事。

**为什么省写与双写法都收敛到 `parseRule`**：省写与位置调换看起来是两种便利，其实都在「进入编译主干之前」把文本归一化。把结论展开：若让每种省写、每种顺序各走一条解析分支，后面的分桶、标志位、优先级处理都要各写一遍；先归一成统一的 token 序列，再交给同一批 `parseRule`，等于用一处预处理换来了下游只有一条编译路径。代价是「用户写的」与「编译后存的」不再是同一串文本，排障时要先还原省写；边界是 `indexOfPattern` 只在首个 token 不是 pattern 时才用「操作列表 × 模式列表」的笛卡尔积兜底，多操作多模式会展开成多条规则。

**代价与边界**：按协议分桶让请求期只需扫相关协议数组，代价是桶结构由 `resetRules` 预建、协议名被固定成一张清单，新增一种写法要么落进已有桶、要么回退；`resolveValue` 对 `style://` 做 128 字符截断、对 `<...>` 产出 `path` 与 `files`，说明「求值」这一步还会按协议做后处理，并不是简单的字符串替换。边界是本节只讲单个 rule 对象如何生成，多个桶之间谁先命中、如何叠加，留到「优先级与叠加顺序」那一节。

**打个比方**：编译期像把一张写明「地址 → 动作」的快递单先拆成标准字段、按目的地分到不同格口里；`pattern` 是地址、`operation` 是动作，分拣时只看地址格式、不拆包裹，`resolveValue` 才是等包裹真到了格口、再按当次信息决定里面装什么。

**自己验证**：对照本节开头那段 `var pattern = line[0]` 与 `var result = resolveMatchFilter(line.slice(1))` 的代码块，问自己「这一行结束时 `result` 里有没有已经算好的 `value`」；再对照那张「字段 / 编译来源 / 请求期用途」表，逐行说出 `matcher / filters` 与 `lineProps` 分别在哪个时期发挥作用。能分清「结构化」与「求值」两步，就抓住了本篇两条泳道的分界。

## 规则集、Values 与模板

`getLines`（`rules.js:410-450`）是规则集展开的入口：整行 `${key}` 由 `rules.js:42` 的 `RULE_KEY_RE` 识别并替换成另一份规则集，整行 `{key}` 由 `rules.js:43` 的 `VALUE_KEY_RE` 替换成 Values 内容，二者都用局部字典防重复展开。内嵌值写在规则文件里的 ```key``` 块，由 `lib/util/index.js:202-241` 的 `resolveInlineValues` 抽出来存进 `inlineValues`，键还会拼上文件名以隔离作用域。

模板变量是另一条线：`rules.js:76-77` 的 `TPL_VAR_RE` 列出 `${method}`、`${now}`、`${reqHeaders.x}` 等可取值，`rules.js:721-789` 的 `resolveTplVar` / `renderTpl` / `resolveVar` 在求值阶段替换，`${...}` 形式的 Values 引用也在这里展开（`:782-788`）。反引号模板由 `rules.js:70` 的 `TPL_RE` 识别，`%plugin=x` 由 `rules.js:91` 的 `PLUGIN_VAR_RE` 收集到 `_globalPluginVars`（`rules.js:1755-1768`）。远程规则 `@url` 则在编译前展开：`lib/util/index.js:3305-3318` 的 `REMOTE_RULES_RE` 与 `getRemoteRulesResolver` 负责替换，`lib/util/http-mgr.js:425-449` 的 `add` 把 URL 登记进缓存；本地路径按 `http-mgr.js:41` 的 5000 ms 轮询，远端按 `:17-18,42` 的 10 至 30 s 间隔刷新，最多 20 条（`lib/util/index.js:3304`）。

这套分层的设计取舍很清楚：规则文本、Values、模板、远程内容在编译期就被拍平成一份纯文本，请求期只需面对统一的 rule 对象，不必在热路径上做 IO。代价是任何一处 Values 变化都要整份重编译，这也是下一节热更新采用全量策略的原因。

**输入 → 动作 → 输出**：输入是可能引用了别处的规则文本——整行 `${key}` 规则集、整行 `{key}` 值引用、写在规则文件里的内嵌值块、`${method}` / `${now}` / `${reqHeaders.x}` 模板变量、`%plugin=x` 全局插件变量，以及 `@url` 远程规则；动作是 `getLines` 与几个键名正则在编译期把引用层层展开、`resolveInlineValues` 把内嵌块抽出来存进 `inlineValues`、`resolveTplVar` / `renderTpl` / `resolveVar` 把模板变量留到求值阶段替换、远程内容在编译前先抓取并登记进缓存再轮询刷新；输出是一份已经拍平的纯文本，再交给上一节的 `parseText` 走同一条编译路径。换句话说，本节补的是「`parseText` 拿到的那一行文本，本身可能已经不是用户敲下的原文」。

**为什么把展开放在编译期、把替换留到求值期**：`${key}` 规则集、`{key}` 值引用、内嵌值块与 `@url` 远程内容都是静态的，一次展开就能定形；而 `${method}`、`${now}`、`${reqHeaders.x}` 这类模板变量依赖「这一次请求」，必须在命中后才有值。把结论展开成推理：若把静态引用也留到请求期，每来一个请求都要重新拉一遍规则集、解析一遍内嵌值、甚至发一次远程请求，热路径上就全是 IO；提前拍平，请求期只面对统一的 rule 对象。原文那句「代价是任何一处 Values 变化都要整份重编译」正是这个取舍的反面——用「改一次、全量重来」换「热路径零 IO」。

**为什么内嵌值的键要拼上文件名**：`resolveInlineValues` 把内嵌块抽出来存进 `inlineValues` 时，键还会拼上文件名以隔离作用域。把结论展开：多个规则文件都写一个同名内嵌键是很常见的事，若键只按名字存，后加载的文件会悄悄覆盖前一个；拼上文件名，等于给每份规则文件一个独立命名空间。代价是跨规则文件复用同名键时不会自动共享，得显式走 `${key}` 规则集引用；边界是隔离只按文件名，同一文件内仍不能重名。

**为什么远程规则要分本地与远端两种刷新节奏**：本地路径按 5000 ms 轮询、远端按 10 至 30 s 间隔刷新且最多 20 条。把结论展开：本地文件改动快、读取也便宜，短轮询能及时反映；远端要走网络、还可能限流，缩短间隔既浪费又容易把对方打挂，拉长并加上条数上限更稳妥。代价是「改了远程规则却没立刻生效」不一定是匹配问题，也可能只是还没到下一轮刷新；边界是这份刷新清单最多 20 条，超出就要先清理旧的登记。

**代价与边界**：拍平的代价是任何一处 Values、模板或远程内容变化都触发全量重编译（下一节 `httpMgr.addChangeListener` 那条路径），局部增量更新在这里行不通；边界是编译期拍平只对「静态引用」成立，模板变量与 `${...}` 形式的值引用仍在求值阶段展开，两者混写时要分清哪部分会随请求变。`%plugin=x` 被收进 `_globalPluginVars`、反引号模板由 `TPL_RE` 识别，说明「变量」也有静态与动态之分，别一律当成请求期才算。

**打个比方**：编译期像把一份带「见附件 A」「见附录 B」的总图纸，先把所有附件复印贴齐、拼成一张完整图纸再发到车间；模板变量则像图纸上留的「按当批批次号填写」空格，要等这批活真正开工（请求命中）才填。车间只认拼好的那张图，不必每次跑去翻附件柜。

**自己验证**：对照本节列出的 `${key}`、`{key}`、内嵌值块、`@url` 与 `${method}` 这几类写法，自己分一分「哪些在编译期就定形、哪些要等请求命中」；再对照原文「任何一处 Values 变化都要整份重编译」那句，回答「改一个内嵌值，为什么不是只重算那一条规则」。能答上来，就理解了后面全量重编译的来由。

## 匹配算法：五条分支

请求期入口是 `resolveRuleList`（`rules.js:929-938`），它先把当前请求归一化出三种 URL：`curUrl`（带协议与端口）、`domainUrl`（去端口）、`pureUrl`（去查询串），分别用于路径匹配、域名匹配与边界判断。

```js
// lib/rules/rules.js:930-938
  var curUrl = util.formatUrl(req.curUrl || req.fullUrl);
  var notHttp = list.isRuleProto && curUrl[0] !== 'h';
  //支持域名匹配
  var domainUrl = removePort(curUrl);
  var hasIndex = typeof index === 'number';
  index = hasIndex ? index : -1;
  var results = [];
  var url = util.getPureUrl(curUrl);
  var _domainUrl = util.getPureUrl(domainUrl);
```

真正的匹配循环在 `rules.js:997-1120`，按 rule 对象上的标志位走五条互斥分支。正则分支（`:1007-1033`）用编译好的 RegExp 测试并把 `$1..$9` 收进 `regExp` 表；通配分支（`:1034-1080`）先跑 `preMatch`，再按 `path` 判断路径边界；精确分支（`:1081-1087`）要求 `pattern === url || pattern === curUrl`；前缀分支（`:1088-1119`）用 `indexOf(pattern) === 0` 加 `isPathSeparator` 检查，避免 `/foo` 误伤 `/foobar`；否定规则由每分支的 `not` 取反（`:1009,1083`）。

```js
// lib/rules/rules.js:1081-1092
    } else if (rule.isExact) {
      matchedRes = pattern === url || pattern === curUrl;
      if ((not ? !matchedRes : matchedRes) && checkFilter() && --index < 0) {
        if (result = getExactRule(getRelativePath(pattern, curUrl, rule.matcher))) {
          return result;
        }
      }
    } else if (
      ((matchedUrl = curUrl.indexOf(pattern) === 0) ||
        (rule.isDomain && domainUrl.indexOf(pattern) === 0)) &&
      checkFilter()
    ) {
```

循环内的 `checkFilter`（`rules.js:986-995`）在每次比较前还会短路两类情况：非 HTTP 协议不允许 `isFileProxy` 规则命中（`:988-990`），请求阶段的工具协议 `log` / `weinre` 直接放行（`:991-993`）。命中后 `getPathRule`（`rules.js:947-967`）把 `matcher` 与剩余 `filePath` 拼成最终 URL，并把 `files` 逐项拼接，这正是前缀规则支持路径透传的实现。

通配符的语义集中在 `rules.js:120-142` 的 `domainToRegExp` / `pathToRegExp` / `queryToRegExp`：`*` 不跨分隔符，`**` 允许跨一段，`***` 连点号一起吞；`parseWildcard`（`rules.js:1162-1228`）据此把域名与路径分别编译成 `preMatch` 正则和 `path` 字符串，并记下 `isExact`、`hasQuery`。子匹配传值由 `rules.js:876-883` 的 `replaceSubMatcher` 完成，正则命中时在 `rules.js:1014-1017` 收集 `RegExp.$1..$9`，通配命中时在 `:1039-1041` 收集捕获组，最终写回 `matcher` 里的 `$0..$9`。

::: cols 22|36|42
| 分支 | 判定条件 | 关键行 |
|---|---|---|---|
| 正则 | `isRegExp` | `1007-1033` |
| 通配 | `rule.wildcard` | `1034-1080` |
| 精确 | `isExact` + `$` | `1081-1087` |
| 前缀/域名 | `indexOf === 0` | `1088-1119` |
| 否定 | `rule.not` | 各分支取反 |
:::

**输入 → 动作 → 输出**：输入是一次请求的 `curUrl`（带协议与端口）、由它派生的 `domainUrl`（去端口）与 `pureUrl`（去查询串），以及某个协议桶里自上而下排列的 rule 对象；动作是 `resolveRuleList` 先归一化出三种 URL，再由匹配循环按 rule 上的标志位走正则、通配、精确、前缀 / 域名、否定五条互斥分支，命中后用 `getPathRule` 把 `matcher` 与剩余 `filePath` 拼成最终 URL、`replaceSubMatcher` 把 `$0..$9` 写回 `matcher`；输出是该协议桶里第一条命中的 rule（或没有命中），供后面组装 `req.rules`。

**为什么一次请求要准备三种 URL**：`curUrl` 带端口、适合精确路径比较，`domainUrl` 去端口、专为域名规则准备，`pureUrl` 去查询串、用于边界判断。把结论展开：一条域名规则若拿带端口的 `curUrl` 去比就会落空，而路径规则若拿带查询串的 URL 比，又会被查询参数干扰；三种视图各管一类比较，比在循环里对同一字符串反复裁剪更省事、也更不容易错。同理，前缀分支用 `indexOf(pattern) === 0` 再加 `isPathSeparator` 检查，是专门为了不让 `/foo` 误伤 `/foobar`。

**为什么五条分支要互斥、且首条命中即返回**：每个 rule 在编译期就带上了 `isRegExp` / `wildcard` / `isExact` / `not` 等标志位，循环里用 `if / else if` 一次只进一条，避免「既按正则算、又按通配算」产生歧义；一旦构造出结果就 `return`，把「顺序」直接当作优先级。把结论展开：若收集齐所有命中再挑，就得额外定义一套比较规则（谁更具体、谁更靠前），而规则集通常只有几十到几百行，线性扫描 + 首条返回比维护有序结构更省事。代价是「后面的规则永远轮不到」，想叠加同类效果只能靠下一节的 important、多命中、后置优先这些补丁；边界是这里只解决「单个协议桶内谁命中」，跨桶谁先谁后不在这一层。

**为什么子匹配要写回 `matcher`**：正则命中时收集 `RegExp.$1..$9`、通配命中时收集捕获组，最终由 `replaceSubMatcher` 写回 `matcher` 里的 `$0..$9`。把结论展开：用户在 `operation` 里引用 `$1` 时，拿到的必须是「这一次 URL 实际匹配出来的片段」，而不是编译期就定好的常量；因此命中与取值必须合在同一步完成。代价是捕获组编号上限到 `$9`，更复杂的提取表达不了；边界是 `$0..$9` 只在命中之后才有值，与上一节「命中前只有 `matcher`」正好呼应。

**代价与边界**：把通配语义编译成 `preMatch` 正则与 `path` 字符串、把正则命中收集进 `RegExp.$1..$9`，换来了匹配期只做测试与取组；代价是 `*` 不跨分隔符、`**` 只允许跨一段、`***` 连点号一起吞，这三档语义必须记准，写错一档整条规则就落空。`checkFilter` 在每次比较前还会短路两类情况（非 HTTP 协议不让 `isFileProxy` 命中、`log` / `weinre` 直接放行），边界是这些短路只影响匹配循环，不改变规则本身是否被编译。

**打个比方**：`resolveRuleList` 像分拣员手里同时摊开三张地址条——一张带门牌号（`curUrl`）、一张只写小区名（`domainUrl`）、一张划掉了备注栏（`pureUrl`）；五条分支是五把口径不同的尺子，同一件包裹只量一把、第一把量中便贴上标签送出，后面的尺子连碰都不碰。想让两把尺子都量到同一件，就得换到 `multiMatchs` 那类「多命中」窗口，而不是在这一层的循环里找。

**自己验证**：对照那张「分支 / 判定条件 / 关键行」的五分支表，逐条问自己「这一支靠哪个标志位进、靠什么条件算命中」；再对照精确分支那段 `pattern === url || pattern === curUrl` 的代码，回答「为什么前缀分支还要多一个 `isPathSeparator` 检查」。能说清「五支互斥 + 首条返回」，就理解了下一节所有优先级补丁都在补什么。

## 优先级与叠加顺序

默认优先级最简单：`rules.js:997` 的循环自上而下遍历协议数组，一旦 `--index < 0` 就构造结果并 `return`，因此同一协议内是首条命中生效。要打破它，有四种机制。`lineProps://important` 在 `rules.js:1400-1406` 把规则插到该协议数组第一个非 important 元素之前——注意它跳过已有的 important 元素再插入（`:1401-1405`），因此多条 important 之间仍保持原有相对顺序；`multiMatchs`（`protocols.js:186-227`）列出 40 个允许多命中的协议，`rules.js:2273-2296` 对它们改用 `getRuleList` 收集全部命中。`backRulesFirst` 由 `lib/rules/util.js:64-66` 读取、`lib/rules/util.js:46-52` 的 `reverseRules` 反转行序实现后置优先。规则集的叠加顺序在 `lib/rules/util.js:89-99`：选中规则 → Default → Mock → Service → Shadow，越靠后的桶越晚追加，也就越晚命中。`filterWeakRule`（`lib/util/index.js:3741-3753`）则在存在 `host` 或 `proxy` 时删掉弱 `rule`，让转发规则优先于本地映射。

::: cols 26|36|38
| 机制 | 实现位置 | 效果 |
|---|---|---|---|
| 首条命中 | `rules.js:997` | 自上而下即返回 |
| important | `1400-1406` | 插到协议数组首位 |
| multiMatchs | `protocols.js:186` | 40 项全收集 |
| backRulesFirst | `util.js:46-52` | 后置规则反序在前 |
| filterWeakRule | `util/index.js:3741` | 弱规则让位 host |
:::

理解这层的取舍：不分优先级字段、不建索引，是因为规则集通常只有几十到几百行，线性扫描比维护有序结构更省事；而 important、后置优先、多命中这些开关，是把「顺序」本身当作唯一优先级模型后的有限补丁。

**输入 → 动作 → 输出**：输入是编译好的各协议数组（默认按行序排列）与四种打破默认顺序的开关；动作是首条命中的循环自上而下取第一条，`lineProps://important` 把规则插到该协议数组第一个非 important 元素之前、`multiMatchs` 对 40 个协议改用 `getRuleList` 收集全部命中、`backRulesFirst` 由 `reverseRules` 反转行序、`filterWeakRule` 在存在 `host` 或 `proxy` 时删掉弱 `rule`，再叠加「选中规则 → Default → Mock → Service → Shadow」的桶序；输出是「谁先被匹配到」的最终顺序。

这里把两个术语点明：写在规则行尾、修饰匹配行为的 [lineProps](/concepts/06-rules)（行属性）里，最典型的就是 [important](/concepts/06-rules)——它不是一条新协议，而是把所在行在协议数组里往前挪的开关；注意它跳过已有的 important 元素再插入，因此多条 important 之间仍保持原有相对顺序，并不是「谁标了谁就绝对最前」。

**为什么把「顺序」本身当作唯一的优先级模型**：源码里没有优先级字段、也不建索引，规则一多本来可以用权重或树来排，但规则集通常只有几十到几百行，线性扫描比维护有序结构更省事。把结论展开：一旦引入数值优先级，就得规定「同分怎么办、跨协议怎么比、用户改一个数会不会牵动一片」，复杂度远高于「谁写在前面谁先命中」；把顺序写死，用户看规则文本的顺序就等于看执行顺序，排障时最直观。代价正是原文那句——important、后置优先、多命中、弱规则让位这些开关，都是「顺序不够用」之后补上的有限补丁，每多一个开关就多一条要记的例外。

**为什么 `filterWeakRule` 要让转发规则优先于本地映射**：它在存在 `host` 或 `proxy` 时删掉弱 `rule`。把结论展开：用户一旦显式写了「往哪发」，意图通常比一条本地映射规则更强；若让本地映射先命中，写好的 `host` 就像没生效一样。用「弱规则让位」把这个判断固化下来，避免每次匹配都要比较「这条是不是用户显式指定的」。代价是多一条「弱」的判定标准；边界是它只在 `host` / `proxy` 存在时触发，其余情况仍按纯行序。

**代价与边界**：`multiMatchs` 让 40 个协议可以叠加多条命中，代价是这 40 项要单独维护一份清单；`backRulesFirst` 反转行序让「后写的反而优先」，代价是界面上看到的顺序与实际命中顺序不再一致；`filterWeakRule` 让转发规则优先于本地映射，边界是它只在存在 `host` 或 `proxy` 时才触发。规则集叠加「越靠后的桶越晚追加、也就越晚命中」，意味着同一条规则放在 Default 还是 Mock，结果可能不同——顺序即语义，既是这层最大的便利，也是最容易踩的坑。

**打个比方**：默认规则像一排按提交先后排好的队伍，先来先办；`important` 是给某人一张「插到队首、但不越过其他持同类票的人」的票，`backRulesFirst` 是把整条队伍倒过来放，`multiMatchs` 是少数几个窗口允许「一队人一起办」，而规则集叠加顺序决定了哪支队伍整体排在后面。没有叫号机（优先级字段），全靠站位。

**自己验证**：对照那张「机制 / 实现位置 / 效果」表，逐行说出四种开关各自改的是「行序」「命中条数」还是「整桶顺序」；再对照原文「多条 important 之间仍保持原有相对顺序」那句，回答「两条都标了 important 的规则，谁先命中」。能分清这四种补丁改的不是同一件事，就不会把它们混成「优先级有四种」。

## 过滤器、缓存澄清与热更新

`rules.js:57` 的 `PROPS_FILTER_RE` 一次列出可过滤的属性：方法、IP、请求头、env、状态码、SNI、客户端端口、服务端 IP 等，`rules.js:54` 的 `PATTERN_FILTER_RE` 则处理 `filter://.../i` 这种整行模式过滤。`resolveMatchFilter`（`rules.js:1549-1739`）把它们编译进 `filters` 数组，匹配时由 `matchExcludeFilters`（`rules.js:1985-2009`）统一判定：存在 include 过滤器时要求至少命中一条且不能被 exclude 命中，否则只要求不被 exclude 命中（`:2008`）。`includeFilter` / `excludeFilter` 都先经 `protocols.js:151-152` 的别名归并到 `filter`。`ignore` 与 `skip` 不是同一个开关的两种写法：别名 `skip:'ignore'`（`protocols.js:140`）只决定**分桶**——两者都进 `ignore` 桶，但 `rule.matcher` 保留原始前缀。运行期 `resolveProps`（`rules.js:1125-1160`）用 `SKIP_RE`（`:96`，`^skip:\/\/`）把 `skip://` 规则单独摘出：`skip://pattern=x` 之类经 `EXACT_SKIP_RE`（`:93`）写成 `ignore|pattern=x`，或按 `|` 拆成协议名，统一存进 `req._skipProps`（`:1138-1146`）；匹配循环 `rules.js:997-1001` 用 `exactIgnore` / `checkSkip`（`lib/util/index.js:1995-2021`）命中即 `continue`，只跳过当前这条规则、继续匹配后面的同类规则（`docs/docs/rules/skip.md:2`）。其余 `ignore://` 规则才由 `parseRuleProps`（`lib/util/index.js:1883-1895`）编译成屏蔽项，经 `ignoreRules`（`:2090-2139`）`delete rules[name]` 删掉整个协议桶，实现「忽略后不再匹配同类其它规则」（`docs/docs/rules/ignore.md:29`）。简言之，别名归并只统一了桶名，`skip://` 前缀在运行期被重新分流为「逐条跳过」，`ignore://` 才是「整类屏蔽」。

这里必须澄清一个流传很广的误解：**URL 匹配不使用 lru-cache**。`regUrlCache` / `hostCache` 定义在 `rules.js:64-65`，只是两个普通对象，并且在每次 `parseText` 结束时被整体清空（`rules.js:1804-1805`）；它们只缓存同一次编译内的正则 URL 解析结果。

```js
// lib/rules/rules.js:1802-1805
  enabledList.push([rawLine, file]);
  });
  regUrlCache = {};
  hostCache = {};
```

lru-cache 用在别处：模板编译结果 `tplCache`（`lib/rules/index.js:20`，`max: 36`）、客户端证书缓存（`lib/rules/index.js:21`）、证书体系的各级缓存，以及插件动态规则缓存（`lib/plugins/index.js:46`）。把两者混为一谈，会误判规则改了却「没生效」的原因。

热更新是全量重编译：`lib/rules/util.js:58-106` 注册 `httpMgr.addChangeListener`，每次变更都重新拼好规则集并调 `rules.parse(rulesList)`（`:104`），同时 `pluginMgr.emit('updateRules', true)`。`Rules.prototype.parse` / `append` / `clearAppend`（`rules.js:2051-2110`）维护 `_rawText` 与 `_mflag` 版本标记（`:2078,2093,2109`），前端靠它判断是否需要重拉。落盘由 `lib/rules/storage.js` 负责，目录分 `files` / `properties` / `.backup` / `.recycle_bin`（`:61-74`），写入采用异步重试与双写备份（`:749-755`）。CGI 侧是 `biz/webui/cgi-bin/rules/*` 的一组约定式接口，`add`、`remove`、`select`、`import`、`export` 等文件名与接口同名，正是约定式路由的直接体现；删除并非直接抹除，而是先移入 `lib/rules/storage.js:63` 的 `.recycle_bin` 目录。改动后由 `config.setModified`（`lib/config.js:1126`）打标记，前端 `biz/webui/htdocs/src/js/data-center.js:903` 的 `checkDataChanged` 轮询比对后刷新。全量重编译看似浪费，却把展开、模板、远程与优先级收敛到同一条路径上，避免局部增量更新与规则集叠加顺序产生分歧。

**输入 → 动作 → 输出**：输入是规则行尾的过滤属性（方法、IP、请求头、env、状态码、SNI、客户端端口、服务端 IP 等）与 `filter://.../i` 整行模式过滤；动作是 `resolveMatchFilter` 把它们编译进 `filters` 数组，匹配时由 `matchExcludeFilters` 判定「存在 include 时至少命中一条且不被 exclude 命中，否则只要求不被 exclude 命中」，`resolveProps` 又把 `skip://` 规则单独摘进 `req._skipProps`、让 `ignore://` 规则编译成屏蔽项删掉整个协议桶；输出是「这条规则此刻是否参与匹配」以及「该协议桶是否整体被屏蔽」。规则变更这一路的输入是 Values / 规则集 / 远程内容的改动，动作是 `httpMgr.addChangeListener` 触发全量重编译并通知 `updateRules`、由 `_mflag` 与 `setModified` 打标记、前端 `checkDataChanged` 轮询比对后刷新，输出是一份全新编译的规则集与一次界面重拉。

这里把 [过滤器](/concepts/06-rules) 与 [热更新](/concepts/06-rules) 两个词点明：前者是「同一条规则对哪些请求生效」的限定，后者是「规则改了之后怎么让请求期用上新版本」的机制，二者一个作用在匹配期、一个作用在编译期，别混成一回事。

**为什么 `skip://` 与 `ignore://` 明明归到同一个桶、语义却不同**：别名 `skip:'ignore'` 只统一了分桶名，`rule.matcher` 仍保留原始前缀；运行期 `resolveProps` 用 `SKIP_RE` 把 `skip://` 重新分流成「逐条跳过」——命中即 `continue`，只跳过当前这条、继续匹配后面的同类规则；其余 `ignore://` 才由 `parseRuleProps` / `ignoreRules` 删掉整个协议桶，实现「忽略后不再匹配同类其它规则」。把结论展开：若只靠分桶，两者都会变成「整类屏蔽」，`skip` 想要的「只放过这一条」就没法表达；保留前缀、在运行期再分流，等于用一处很小的判断换来了两种粒度。代价是别名归并只统一了桶名、没统一语义，读源码时必须追到 `resolveProps` 才看得懂；边界是 `skip://pattern=x` 这类精确写法会被改写成 `ignore|pattern=x`，与按 `|` 拆协议名的写法走不同分支。

**为什么 URL 匹配不用 lru-cache、规则变更却用全量重编译**：`regUrlCache` / `hostCache` 只是两个普通对象，在每次 `parseText` 结束时被整体清空，缓存的只是「同一次编译内」的正则 URL 解析结果；既然规则一变整份就要重编译，逐条淘汰旧缓存没有意义，「重建而非淘汰」才是想要的效果。把两句放一起看：全量重编译把展开、模板、远程与优先级收敛到同一条路径上，避免局部增量更新与规则集叠加顺序产生分歧；`regUrlCache` 的整体清空正是为这条路径服务的。真正用 `lru-cache` 的是模板编译结果 `tplCache`、客户端证书缓存、证书体系各级缓存与插件动态规则缓存——把两者混为一谈，会误判「规则改了却没生效」的原因。

**为什么删除不直接抹除、而是先移进 `.recycle_bin`**：落盘目录里专门分了 `.backup` 与 `.recycle_bin`，删除先移入回收站、改动靠 `setModified` 打标记、前端轮询比对后再刷新。把结论展开：规则是「一处写、处处读」的共享配置，直接抹掉既没法撤销、也可能让正在拉取的界面读到半份数据；先移入回收站、再异步通知，等于给误删留一道缓冲。代价是磁盘上会多留一份旧数据、要定期清理；边界是回收站只接住「删除」，Values 或模板的改动仍走全量重编译那条路。

**代价与边界**：全量重编译看似浪费，代价是每一次改动都要重跑展开、模板与分桶，改动频繁时开销集中；换来的是「只有一条编译路径」这个强保证，边界是前端靠 `_mflag` / `setModified` 轮询感知变化，因此界面上的「生效」最多滞后一个轮询周期，而不是改完即刻。`ignore://` 删整个协议桶很干脆，代价是「只想屏蔽一条、放过其它」时必须改用 `skip://`；`matchExcludeFilters` 的 include / exclude 判定要求「至少命中一条且不被 exclude 命中」，边界是没写 include 时只检查 exclude，写与不写的默认行为不同。

**打个比方**：`regUrlCache` / `hostCache` 像分拣员这个班次里随手记的便签，下班（一次编译结束）就整张扔掉、下次重新拿空白纸；`lru-cache` 则像有固定格数、会把最久没翻的那一格腾出来的文件柜。全量重编译相当于「换班就重发一整套新便签」，而不是去文件柜里逐格改旧纸——两者管的东西不一样，混起来就会找错「规则没生效」的原因。

**自己验证**：对照 `regUrlCache = {}` / `hostCache = {}` 那段代码块，问自己「这两个对象活到下一次编译吗」；再对照原文 `skip://` 与 `ignore://` 那段说明，回答「一条 `skip://` 命中后，后面的同类规则还会不会被匹配」。能答清「整体清空」与「逐条跳过」这两个动作，就抓住了本节最容易读错的两处。

## 常见误解

1. **容易以为一行规则在编译期就已经算出了最终取值，其实编译期只做结构化、请求期命中后才求值**：`resolveValue` 要等命中才把对 Values 的引用变成 `value` / `path` / `files`，因此插件若在命中前读 `rule.value` 只会拿到 undefined。把「编译」与「求值」当成同一步，就会奇怪「为什么规则写了却没生效」。
2. **容易以为 important 会让某条规则绝对排到最前、或让多命中成为默认，其实它只是把行挪到该协议数组第一个非 important 元素之前**：多条 important 之间仍保持原有相对顺序；默认仍是「首条命中即返回」，只有 `multiMatchs` 列出的 40 个协议才改用 `getRuleList` 收集全部命中。对照见[《易混淆概念辨析》](/concepts/08-confusions)。
3. **容易以为 URL 匹配用了 lru-cache，规则改了没生效是缓存没淘汰，其实 `regUrlCache` / `hostCache` 是每次编译后整体清空的普通对象**：lru-cache 只用于模板编译结果、客户端证书、证书体系与插件动态规则缓存；规则改了没生效，更该查 Values / 远程规则的刷新时机与前端轮询，而不是去清一个不存在的 LRU。
4. **容易以为 `skip://` 与 `ignore://` 只是同一个开关的两种写法，其实一个逐条跳过、一个整类屏蔽**：别名 `skip:'ignore'` 只统一了分桶名，运行期 `resolveProps` 会把 `skip://` 摘进 `req._skipProps` 命中即 `continue`，只放过当前这一条；`ignore://` 才经 `ignoreRules` 删掉整个协议桶。写成 `ignore://` 想「只忽略一条」，反而会把整类规则一起关掉。
5. **容易把全站两处 `rules.js` 当成同一个文件**：请求链路篇讲的是 `lib/inspectors/rules.js`——请求期分配 `reqId`、装配 `setupRules`；本篇讲的是 `lib/rules/rules.js`——编译期解析文本、请求期求值命中。跨篇看到 `rules.js:行号` 时，先确认所在章节谈的是「谁把规则产物交给请求」还是「谁把规则文本编译成产物」，否则很容易把两个阶段的行为互相套用。

## 小结

- `parseText` 把一行文本拆成 pattern / operation / 属性 / 过滤器，`parseRule` 编译成按协议分桶的 rule 对象。
- `${key}` 规则集、内嵌值、模板变量与 `@url` 远程规则都在编译期被拍平，请求期只做求值。
- `resolveRuleList` 生成三种 URL，匹配循环按正则、通配、精确、前缀、否定五分支推进，首条命中即返回。
- 优先级靠行序表达，important、multiMatchs、backRulesFirst、filterWeakRule 是有限补丁。
- `regUrlCache` / `hostCache` 是每次编译后清空的普通对象，lru-cache 只用于模板、证书与插件规则。
- 规则变更触发全量重编译，由 `_mflag`、`setModified` 与前端轮询串成闭环。
- 本篇为 [《指令体系与分发链路》](/modules/protocol-catalog) 准备了「按协议分桶的 rule 对象」这个终点：编译、匹配、优先级与热更新都已逐段厘清，14 才能只回答一直悬着的问题——这些桶在请求期由谁取用、又分别落到哪个 inspector 或 handler。

## 下一步

[《指令体系与分发链路》](/modules/protocol-catalog)：沿 `req.rules` 往下走，看每条协议在哪个 inspector 或 handler 里真正落地。 紧接着读它，是因为本篇停在「规则已编译成按协议分桶的对象」，却没回答「分桶之后谁消费、跨桶怎么组装成 `req.rules`」；14 正好补上从分桶到 `req.rules`、再到 inspectors 应用与 handlers 出站这条分发链，把本篇的编译产物接到 09 那条 Express 主干上。
