---
title: 规则引擎：解析与匹配
description: 从一行规则文本到请求期求值，拆解编译、分桶、匹配、优先级与热更新的完整链路。
---

规则引擎是 Whistle 最核心、也最容易读错的一层：用户写的是一行文本，请求期真正使用的却是一组按协议分桶、带过滤条件的编译对象。本篇面向要改匹配逻辑或写插件的开发者，沿「编译期 → 请求期」两条泳道走完 `lib/rules/rules.js`，并澄清缓存、优先级与热更新上的常见误解。所有结论都落到当前分支的具体行号，便于逐段对照源码验证。

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

## 规则集、Values 与模板

`getLines`（`rules.js:410-450`）是规则集展开的入口：整行 `${key}` 由 `rules.js:42` 的 `RULE_KEY_RE` 识别并替换成另一份规则集，整行 `{key}` 由 `rules.js:43` 的 `VALUE_KEY_RE` 替换成 Values 内容，二者都用局部字典防重复展开。内嵌值写在规则文件里的 ```key``` 块，由 `lib/util/index.js:202-241` 的 `resolveInlineValues` 抽出来存进 `inlineValues`，键还会拼上文件名以隔离作用域。

模板变量是另一条线：`rules.js:76-77` 的 `TPL_VAR_RE` 列出 `${method}`、`${now}`、`${reqHeaders.x}` 等可取值，`rules.js:721-789` 的 `resolveTplVar` / `renderTpl` / `resolveVar` 在求值阶段替换，`${...}` 形式的 Values 引用也在这里展开（`:782-788`）。反引号模板由 `rules.js:70` 的 `TPL_RE` 识别，`%plugin=x` 由 `rules.js:91` 的 `PLUGIN_VAR_RE` 收集到 `_globalPluginVars`（`rules.js:1755-1768`）。远程规则 `@url` 则在编译前展开：`lib/util/index.js:3305-3318` 的 `REMOTE_RULES_RE` 与 `getRemoteRulesResolver` 负责替换，`lib/util/http-mgr.js:425-449` 的 `add` 把 URL 登记进缓存；本地路径按 `http-mgr.js:41` 的 5000 ms 轮询，远端按 `:17-18,42` 的 10 至 30 s 间隔刷新，最多 20 条（`lib/util/index.js:3304`）。

这套分层的设计取舍很清楚：规则文本、Values、模板、远程内容在编译期就被拍平成一份纯文本，请求期只需面对统一的 rule 对象，不必在热路径上做 IO。代价是任何一处 Values 变化都要整份重编译，这也是下一节热更新采用全量策略的原因。

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

## 过滤器、缓存澄清与热更新

`rules.js:57` 的 `PROPS_FILTER_RE` 一次列出可过滤的属性：方法、IP、请求头、env、状态码、SNI、客户端端口、服务端 IP 等，`rules.js:54` 的 `PATTERN_FILTER_RE` 则处理 `filter://.../i` 这种整行模式过滤。`resolveMatchFilter`（`rules.js:1549-1739`）把它们编译进 `filters` 数组，匹配时由 `matchExcludeFilters`（`rules.js:1985-2009`）统一判定：存在 include 过滤器时要求至少命中一条且不能被 exclude 命中，否则只要求不被 exclude 命中（`:2008`）。`includeFilter` / `excludeFilter` 都先经 `protocols.js:151-152` 的别名归并到 `filter`。`ignore` 与 `skip` 的差别在 `lib/util/index.js:1913-1985`：`resolveIgnore` 把 `ignore` 编译成按协议名屏蔽的 `filter`，`skip` 则是别名归并后的同类开关，前者作用于整条规则集，后者常用于行内排除。

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

## 小结

- `parseText` 把一行文本拆成 pattern / operation / 属性 / 过滤器，`parseRule` 编译成按协议分桶的 rule 对象。
- `${key}` 规则集、内嵌值、模板变量与 `@url` 远程规则都在编译期被拍平，请求期只做求值。
- `resolveRuleList` 生成三种 URL，匹配循环按正则、通配、精确、前缀、否定五分支推进，首条命中即返回。
- 优先级靠行序表达，important、multiMatchs、backRulesFirst、filterWeakRule 是有限补丁。
- `regUrlCache` / `hostCache` 是每次编译后清空的普通对象，lru-cache 只用于模板、证书与插件规则。
- 规则变更触发全量重编译，由 `_mflag`、`setModified` 与前端轮询串成闭环。

## 下一步

[《指令体系与分发链路》](/modules/protocol-catalog)：沿 `req.rules` 往下走，看每条协议在哪个 inspector 或 handler 里真正落地。
