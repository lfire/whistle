---
title: 指令体系与分发链路
description: 从协议名数组、别名与派生集合出发，讲清一条指令如何分桶、取首条命中并落到 inspector 或 handler。
---

# 指令体系与分发链路

上一篇把规则文本编译成了按协议分桶的 rule 对象，本篇接着回答「分桶之后谁消费」。Whistle 的指令不是一个枚举类，而是 `lib/rules/protocols.js` 里一张协议名数组加若干派生集合；理解别名、分桶和阶段筛选，就能判断任意一条 `xxx://value` 会在哪个文件里生效。以下按「静态定义 → 请求期分发 → 分类清单 → 易混淆点 → 扩展注册」展开，行号均来自当前分支。13 把规则文本编译成按协议分桶的 rule 对象后，留下两个未解问题：这些桶在请求期由谁按什么顺序取用，以及一条 `xxx://value` 究竟落到哪个文件；本篇就把「编译产物 → `req.rules` → inspector / handler」这条消费链补全，读完后你能拿着任意一条协议名，说清它在哪一步被取用、由哪个阶段生效。

::: tip 先修知识
先做 [第 0 站](/guide/quickstart)：本篇讲的是你在 Rules 与界面背后动过的那套机制。

若某个名词卡住，按主题回查 [概念精解总览](/concepts/index) 与 [《全量术语索引》](/concepts/glossary)；正文在术语首次出现处也给了对应链接。

不需要预先读过源码，但知道 09 那条 `rules → req → data → res` 的 Express 主干会更轻松；成对辨析可查 [《易混淆概念辨析》](/concepts/08-confusions)，忘记名词查 [《全量术语索引》](/concepts/glossary)。

给不熟源码的读者补一句：13 反复出现的「协议桶」在这里终于有了主人——本篇讲的「协议名数组 + 派生集合」就是这些桶的名字清单与分组规则，而「分发」就是把桶里的 rule 对象挑出来、组装成请求期真正被消费的 `req.rules`。
:::

## 73 个协议名与派生集合

`lib/rules/protocols.js:1-75` 的 `protocols` 数组共 73 项，从 `G`、`style`、`host`、`rule` 一直到 `cipher`、`sniCallback`，它是全站唯一的「合法协议名」清单。`lib/rules/protocols.js:131-154` 的 `aliasProtocols` 负责把用户习惯的写法归并进来：`status` → `statusCode`、`skip` → `ignore`、`pathReplace` → `urlReplace`、`hosts` / `xhost` → `host`、`P` → `G`，以及 `html` / `js` / `css` 分别落到 `htmlAppend` / `jsAppend` / `cssAppend`。别名只在解析期用于分桶与协议名归一，`rule.matcher` 仍保留原始前缀——`skip://` 正是靠这个前缀在运行期被 `resolveProps`（`rules.js:1125-1160`）单独摘进 `req._skipProps`，走「跳过当前规则、继续匹配」的语义，与 `ignore://` 的「整类屏蔽」不同；机制差异见 [《规则引擎》](/modules/rules-engine) 的过滤器小节。

由主数组再派生出几组集合：`pureResProtocols`（`:82-111`）是纯响应协议，`reqProtocols`（`:156-158`）从中剔除后供请求阶段使用，`toolProtocols`（`:76`）只有 `log` 与 `weinre`，`multiMatchs`（`:186-227`）列出 40 个允许多命中的协议。分桶由 `resetRules` 完成，每个协议名一个数组：

```js
// lib/rules/protocols.js:256-265
function resetRules(rules) {
  protocols.forEach(function (protocol) {
    rules[protocol] = [];
  });
  rules._localRule = [];
  rules._bodyFilters = [];
  rules._clientCerts = [];
  rules.rule.isRuleProto = true;
  return rules;
}
```

派生集合的用途并不重复：`protocolsWithoutG`（`:155`）供已解析通用规则的请求使用，`resProtocols`（`:112-120`）在纯响应集合上再叠加 `filter`、`enable`、`ignore` 等开关类协议，`binProtocols` / `jsProtocols` / `cssProtocols`（`:121-130`）决定响应体按二进制、JS 还是 CSS 注入，`isBinProtocol`（`:242-254`）据此返回类型码。拆成集合而非运行时逐个判断，是为了让 `resolveRules` 只做一次数组遍历，不必对每个协议反复比对字符串。

`contains(name)`（`lib/rules/protocols.js:289-306`）同时检查主数组、别名、代理类正则与文件代理写法，它被 `lib/plugins/util.js:134` 的 `excludePlugin` 用来阻止插件名与内置协议冲突。这个「数组即注册表」的设计很朴素：新增内置协议只需在数组里加一行，分发与阶段筛选自动获得该桶。

**输入 → 动作 → 输出**：输入是 `protocols` 数组里 73 个协议名、`aliasProtocols` 的别名映射，以及由主数组派生出的 `pureResProtocols` / `reqProtocols` / `resProtocols` / `toolProtocols` / `multiMatchs` / `binProtocols` / `jsProtocols` / `cssProtocols` 等集合；动作是 `resetRules` 为每个协议名预建一个数组桶、`contains(name)` 把别名与文件代理写法一并认进来、`isBinProtocol` 据此返回类型码；输出是一张「协议名 → 桶 / 阶段 / 多命中行为」的静态登记表，供请求期 `resolveRules` 只做一次遍历就能取用。

**为什么用「数组即注册表」、还要派生这么多集合**：把结论展开成推理：`resolveRules` 在请求期要按阶段选协议集合（响应阶段用 `pureResProtocols`、请求阶段用 `reqProtocols`、其余用全量或 `protocolsWithoutG`），若每次都对 73 个名字逐个比对字符串、判断属于哪个阶段，热路径上会多出大量重复判断；提前把「纯响应」「请求可用」「开关类」「按二进制 / JS / CSS 注入」分成集合，请求期只需遍历一张已经筛好的名单。代价是新增内置协议时，除了在数组里加一行，还得确认它该进哪些派生集合；边界是这些集合只是「分组视图」，真正的桶仍由 `resetRules` 按主数组一一建立。`contains(name)` 同时检查主数组、别名、代理类正则与文件代理写法，还被 `excludePlugin` 用来阻止插件名与内置协议冲突——这张数组既是分发依据，也是命名空间保护线。

**为什么别名只在解析期归并、却保留 `rule.matcher` 原始前缀**：`status` → `statusCode`、`skip` → `ignore`、`P` → `G` 这类别名让分桶与协议名归一有唯一依据；但 `skip://` 正是靠保留下来的原始前缀，才在运行期被 `resolveProps` 单独摘进 `req._skipProps`、走「跳过当前规则、继续匹配」的语义。把两句放一起：若别名归并连前缀也一起改掉，`skip` 与 `ignore` 就彻底同化、「逐条跳过」这一档能力会消失。代价是「用户写的协议名」与「桶名」可能不同，排障时要记得回查 `aliasProtocols`；边界是别名只影响分桶与归一，不改变规则本身的取值与匹配。

**为什么 `toolProtocols` 只有 `log` 与 `weinre` 两项却要单列**：它们既不是纯响应协议、也不改报文，只是请求阶段的工具能力，单独成组后阶段筛选就能直接放行。把结论展开：若把它们混进 `pureResProtocols`，响应阶段会白扫一遍；混进 `reqProtocols`，又和其它请求改写规则共用一套命中逻辑。单列一项，等于把「这两个特殊」显式写进集合定义。代价是每个特例都要占一组集合；边界是这一组只影响阶段筛选，不改变它们最终由哪个 inspector 注入脚本。

**代价与边界**：73 项数组是「全站唯一合法协议名清单」，好处是任意一条 `xxx://value` 能否生效、落到哪个桶，一处可查；代价是清单与派生集合、别名表三处要手工保持一致，新增或改名时漏一处就会出现「名字存在但没有桶」。`isBinProtocol` 返回类型码决定响应体按二进制、JS 还是 CSS 注入，边界是它只给类型、不做注入，真正的注入在响应侧 inspector 里完成。

**打个比方**：73 项数组像公司总通讯录，派生集合像按「早班 / 晚班 / 只接内部线」事先圈好的分组名单，`resetRules` 则是按总名单给每个人预置一个收纳格。请求期不必抱着整本通讯录逐页翻，只要按当前班次抽出一页分组名单、照着格子取人即可；代价是通讯录改名时，分组名单与收纳格都得跟着改，漏一处就出现「名单上有、格子却空着」。

**自己验证**：对照 `resetRules` 那段为每个协议名建数组的代码块，数一数它除了 73 个协议桶还预建了哪几个专用桶（`_localRule` / `_bodyFilters` / `_clientCerts`）；再对照本节列出的派生集合，自己分一分「哪些决定阶段、哪些决定多命中、哪些决定响应体按什么类型注入」。能说清「一张数组 + 几组集合」各管什么，就看懂了下一节 `resolveRules` 为什么能只遍历一次。

## 分发链：从分桶到 req.rules

分发链条是固定的五步。第一步在 `lib/rules/rules.js:1280-1334` 的 `parseRule` 里判定协议：裸 IP 补成 `host://`，`/xxx` 补成 `file://` 或 `rule://`，`plugin.` / `whistle.` 前缀归到 `plugin`，其余按 `://` 前缀查 `aliasProtocols`。第二步按协议名取桶（`:1316-1318`），找不到就回退到 `rule`（`:1320-1323`）——未知 `xxx://` 正是借此变成插件协议。第三步是请求期 `resolveRules`（`rules.js:2239-2299`），它按阶段选协议集合：响应阶段用 `pureResProtocols`，请求阶段用 `reqProtocols`，其余用全量或 `protocolsWithoutG`（`:2252-2258`），再对每个协议取首条命中：

```js
// lib/rules/rules.js:2260-2271
  protos.forEach(function (name) {
    if (
      name !== 'pipe' &&
      (name === 'proxy' ||
        name === 'rule' ||
        name === 'plugin' ||
        !filter[name]) &&
      (rule = self.getRule(req, rules[name], vals, null, null, null, isReq))
    ) {
      _rules[name] = rule;
    }
  });
```

组装结果写进 `req.rules`（`lib/inspectors/rules.js:12-60`），期间 `util.mergeRules`（`lib/util/index.js:2195-2227`）合并插件规则、`util.ignoreRules`（`:2090-2141`）按 `filter` 屏蔽、`util.filterWeakRule` 让弱规则让位。第四步由 `lib/inspectors/` 应用改写：`req.js`、`res.js` 处理头与体，`data.js` 处理延迟与限速，`weinre.js` / `log.js` 注入脚本。第五步由 `lib/handlers/` 出站：`http-proxy.js` 发请求，`file-proxy.js` 处理本地文件，`error-handler.js` 兜底。

`multiMatchs` 是这条链上唯一的例外：`rules.js:2273-2296` 对列出的协议改用 `getRuleList` 收集全部命中并挂到 `rule.list`，`rulesFile` / `resScript` 还会过滤出首个脚本项、记下 `scriptIndex`（`:2278-2293`）；`util.ignoreRules(_rules, filter)`（`:2297`）在返回前按 `filter` 统一删桶，保证 inspector 拿到的是「每协议一项、且未被屏蔽」的形态。

再看 `host` 与 DNS：`lib/rules/index.js:126-303` 的 `getProxy` 把插件规则、规则文件规则、请求头规则与全局规则按 `:152-155` 的顺序合并，再由 `lib/rules/dns.js:1-20` 的解析缓存把域名落到 IP；`pac` 用 `node-pac` 编译脚本后按 URL 查上游（`lib/rules/index.js:264-276`）。这类协议不改写报文，只改变「往哪发」，因此放在规则求值之后、handlers 出站之前。

**输入 → 动作 → 输出**：输入是 13 编译好的各协议桶与当前请求所处的阶段；动作是固定的五步——`parseRule` 判定协议并取桶（找不到就回退到 `rule`）、`resolveRules` 按阶段选协议集合再对每个协议取首条命中、`mergeRules` / `ignoreRules` / `filterWeakRule` 合并插件规则与屏蔽弱规则后组装成 `req.rules`、请求侧与响应侧的 inspectors 应用头与体的改写、handlers 出站；输出是请求期真正被消费的 `req.rules`，以及被改写后发往源站（或直接短路返回）的报文。

**为什么按「阶段」选协议集合、而不是一次取全量**：响应阶段只该看 `pureResProtocols`、请求阶段只该看 `reqProtocols`，是因为 `resHeaders` 这类规则在请求还没发出时根本无从生效，而 `reqHeaders` 又必须在出站前落地。把结论展开：若每阶段都遍历全部 73 个协议，既白做功、又可能让「只该在响应期生效」的规则提前改了请求状态；按阶段筛一遍，等于把「什么时候该看哪些桶」写进了集合定义里。代价是阶段与集合的对应关系要维护，边界是 `host` / `pac` / `proxy` 这类「只改往哪发、不改报文」的协议被放在规则求值之后、handlers 出站之前，既不属于请求改写也不属于响应改写。

**为什么 `multiMatchs` 是这条链上唯一的例外**：默认每协议只取首条命中挂进 `req.rules`，但 `rulesFile` / `resScript` 这类协议需要叠加多条结果，于是对 `multiMatchs` 列出的协议改用 `getRuleList` 收集全部命中、挂到 `rule.list`，`rulesFile` / `resScript` 还会挑出首个脚本项并记下 `scriptIndex`。把结论展开：若强行把它们也压成「首条命中」，多条脚本规则里后面的就永远不生效；可一旦放开，又得在返回前用 `ignoreRules` 按 `filter` 统一删桶，才能保证 inspector 拿到的仍是「每协议一项、且未被屏蔽」的形态。代价是这一支要单独维护命中列表与脚本下标；边界是「多命中」只对清单里的协议成立，其余协议仍是首条即返回。

**为什么 `host` 与 DNS 放在「求值之后、出站之前」**：`getProxy` 把插件规则、规则文件规则、请求头规则与全局规则按顺序合并，再由解析缓存把域名落到 IP，`pac` 用编译好的脚本按 URL 查上游。把结论展开：这几类协议不改一个字节的报文，只决定「往哪发」，因此既不需要请求侧改写、也不需要响应侧改写；可它们又必须晚于规则求值——要先知道用户有没有写 `host` / `proxy`，才能定下出站目标。放在两者之间，等于让「先算好去哪、再动手发」成为固定次序。代价是路由这一步夹在求值与出站之间，排障时要顺着这条次序找；边界是它只改变目标地址，不改头部与正文。

**代价与边界**：五步链把「判定 → 分桶 → 取命中 → 组装 → 应用 / 出站」固定下来，好处是任何一条 `xxx://value` 都能顺链定位；代价是链条写死在多个文件里，改一处阶段判断要连带检查 inspectors 与 handlers 是否还认这个桶。边界是未知 `xxx://` 会回退到 `rule` 桶、再借 `resolveWhistlePlugins` 变成插件协议，这条回退是插件得以接入的入口，但也意味着「写错协议名」不会报错、只会被当成插件协议处理。

**打个比方**：五步链像一条分拣流水线：`parseRule` 先给包裹贴上目的地格口（分桶），`resolveRules` 按当前班次从各格口各取一件（按阶段取首条命中），`mergeRules` 把几处来的清单并成一张派车单（`req.rules`），inspectors 在装车前改包装（改写），handlers 最后发车（出站）。`multiMatchs` 则是少数几个格口允许「一整叠一起取」，其余格口仍只取最上面那一件。

**自己验证**：对照那段 `protos.forEach` 的代码块，逐个数出 `name !== 'pipe'` 与 `!filter[name]` 这两道闸门各自挡掉什么；再顺着「`parseRule` 取桶 → `resolveRules` 取首条命中 → 写进 `req.rules` → inspectors 应用 → handlers 出站」五步，回答「一条 `resHeaders` 为什么不会在请求阶段就被用掉」。能走通这条链，就把 13 的编译产物接到了 09 的 Express 主干上。

## 指令分类表

以下四张表按类别分组，每格只给指令、作用、实现文件与阶段，避免一张巨表。表的「实现」列只写目录内文件名与锚点行号：请求改写集中在 `lib/inspectors/req.js:460-604`，响应改写集中在 `lib/inspectors/res.js:819-998`，两者都通过 `util.getMatcherValue` 读取已求值内容；`lib/rules/index.js` 则承担路由、脚本与 TLS 参数这类「不发请求也要先算」的指令。阶段列标明它属于匹配、路由、握手、出站还是响应，读源码时按阶段找比按字母找更快。

::: cols 18|32|34|16
| 指令 | 作用 | 实现 | 阶段 |
|---|---|---|---|
| reqHeaders | 改请求头 | req.js:465 | 请求 |
| reqBody | 换请求体 | req.js:538 | 请求 |
| urlParams | 改查询串 | req.js:472 | 请求 |
| urlReplace | 重写路径 | req.js:562 | 请求 |
| method / ua | 改方法头 | req.js:504 | 请求 |
:::

::: cols 18|32|34|16
| 指令 | 作用 | 实现 | 阶段 |
|---|---|---|---|
| resHeaders | 改响应头 | res.js:831 | 响应 |
| resBody | 换响应体 | res.js:950 | 响应 |
| replaceStatus | 改状态码 | res.js:819 | 响应 |
| htmlAppend | 追加 HTML | res.js:953 | 响应 |
| resSpeed | 响应限速 | res.js:910 | 响应 |
:::

::: cols 18|32|34|16
| 指令 | 作用 | 实现 | 阶段 |
|---|---|---|---|
| file / tpl | 本地文件 | file-proxy.js:236 | 出站 |
| statusCode | 直接返回 | util:3576 | 短路 |
| redirect | 302 跳转 | util:3592 | 短路 |
| host | 改目标主机 | rules/index.js:150 | 路由 |
| proxy / socks | 上游代理 | rules/index.js:126 | 路由 |
| pac | PAC 脚本 | rules/index.js:251 | 路由 |
:::

::: cols 18|32|34|16
| 指令 | 作用 | 实现 | 阶段 |
|---|---|---|---|
| filter / ignore | 屏蔽协议 | util:2090 | 匹配 |
| enable / disable | 开关能力 | util:2213-2222 | 全局 |
| rulesFile | 动态规则 | rules/index.js:437 | 请求 |
| resScript | 响应脚本 | rules/index.js:462 | 响应 |
| reqDelay | 请求延迟 | data.js:544 | 请求 |
| weinre / log | 注入脚本 | weinre.js:24 | 响应 |
| cipher / sniCallback | TLS 参数 | rules/index.js:682 | 握手 |
:::

**输入 → 动作 → 输出**：输入是分发链组装好的 `req.rules` 里各协议项；动作是按类别落到不同的实现文件与阶段——请求改写集中在请求侧 inspector、响应改写集中在响应侧 inspector，两者都通过 `util.getMatcherValue` 读取已求值内容，路由、脚本与 TLS 参数由规则索引层在「不发请求也要先算」的时刻处理，本地文件、直接返回、跳转与注入脚本各在表里标了实现与阶段；输出是「这条指令在哪个文件、哪个阶段被消费」的定位表。四张表按类别拆开，而不是拼成一张巨表，是为了让读者按阶段查（匹配 / 路由 / 握手 / 出站 / 响应）比按字母查更快。

**为什么这四张表只做「定位」、不展开每条指令**：把结论展开：每格只给指令、作用、实现与阶段，读者拿到一个文件名加锚点行号就能直接跳过去，够用了；若把每条指令的调用链、取值方式、上下游都写进去，四张小表会重新膨胀成一篇长文，反而失去速查的意义。代价是表里看不到「这条指令之前还经过哪些环节」，那部分得靠分发链那五步补；边界是它只做定位，不解释取值与命中规则。

**为什么「实现」列只写文件名与锚点行号、还要单列一个「阶段」**：把结论展开：同一类「改写报文」的指令里，`reqHeaders` 与 `resHeaders` 只差一个前缀，却一个落在请求期、一个落在响应期；若只给实现位置，读者仍得自己翻源码判断先后。加上「阶段」列，等于把「什么时候生效」直接标在表里，和上一节「按阶段选协议集合」是同一套思路。代价是阶段划分本身是一份需要维护的约定，新增指令要同时登记实现位置与阶段；边界是表里只给「指令 / 作用 / 实现 / 阶段」四列，不展开每条指令的取值细节，那些留到 13 的求值环节与本篇的别名 / 分桶去解释。

**为什么 `statusCode` / `redirect` 被标成「短路」、`cipher` / `sniCallback` 被标成「握手」**：前者要在发请求之前就结束、根本不产生响应体，后者作用于 TLS 参数、连 HTTP 报文都还没开始，二者都不属于任何 inspector。把结论展开：分类表若强行把所有指令塞进「请求 / 响应」两栏，这两类就会被误读成「某处改写」；单列「短路」与「握手」，是在提醒读者「这几条不走常规的改写链」。代价是阶段种类变多；边界是「短路」与「握手」只描述生效时机，不描述实现在哪个文件——那要看「实现」列。

**代价与边界**：分类表把 73 个协议名按用途摊开，好处是任意一条 `xxx://value` 能按「改请求 / 改响应 / 路由 / 短路 / 注入 / 握手」对号入座；代价是它只到「实现文件 + 阶段」这一层，同一文件里多条指令的先后、多命中与否仍要回看 `multiMatchs` 与分发链。边界是表里 `file / tpl` 标成「出站」、`filter / ignore` 标成「匹配」，它们与 13 的分桶、求值各管一段，别把「阶段」当成「实现位置」的替代品。

**打个比方**：四张表像按科室分好的索引卡——改挂哪面墙（阶段）、由谁经手（实现）一眼可见，比把全部条目抄在一张总表上再逐行找快得多；代价是同一条指令若跨两类用途，得自己按命名前缀判断该翻哪张卡，卡片本身不会替你归类。

**自己验证**：对照四张表，随便挑一条 `urlReplace`、一条 `resSpeed`、一条 `host`，分别说出它属于「请求 / 响应 / 路由」哪个阶段、实现落在哪个文件；再回答「为什么 `statusCode` 的阶段是短路、而不是响应」。能对上号，就说明你已经会把协议名当成「阶段 + 实现」来读，而不是一串平铺的名字。

## 三个易混淆点

这三处最容易在改源码时踩坑：文档里都叫「协议」，代码里却分属三条完全不同的路径。

**其一，`statusCode` 与 `redirect` 不在 `protocols` 数组里。** 它们经 `aliasProtocols` 归并后被 `rules.js:1311-1314` 标成 `isSpec`（1 或 2），仍走 `rule` 桶，由 `lib/util/index.js:3576-3599` 的 `getStatusCodeFromRule` 在发请求前短路返回；调用点在 `lib/tunnel.js:381`、`lib/https/index.js:131` 与 `lib/inspectors/res.js:1313`。所以它们不属于任何 inspector，而是「在建立连接之前就结束」的特殊规则。

```js
// lib/util/index.js:3576-3591
exports.getStatusCodeFromRule = function (rules, req) {
  var rule = rules.rule;
  var isSpec = rule && rule.isSpec;
  if (!isSpec) {
    return;
  }
  var disableUserLogin = isDisableUserLogin(rule, req);
  rule = getMatcherValue(rule) || '';
  var isRedirect = isSpec === 2;
  if (req && isRedirect && rule && compareUrl(rule, req.fullUrl)) {
    req.isWebProtocol = true;
    req.options = parseUrl(req.fullUrl);
    return;
  }
  var code = rule || 200;
  var result = { statusCode: code, headers: {} };
```

**其二，`file` / `tpl` / `rawfile` 也不在数组里。** `protocols.js:78` 的 `RULE_RE` 与 `:279-283` 的 `isFileProxy` 单独识别它们；`lib/handlers/file-proxy.js:236-237` 按 `req.options.protocol` 判定后接入，而不是靠协议分桶。这也是为什么文件类规则支持路径透传，而普通协议只取首条命中。

**其三，`lib/service/` 不参与请求期规则应用。** 它是 pfork 拉起的管理子进程，处理 composer、抓包导入导出、插件安装等；从 `biz/webui/lib/index.js:421-425` 的转发路径可见，只有 `/service/*`、`/cgi-bin/service|sessions|log/*` 与插件安装会转给它，这些请求都不经过 `lib/inspectors/` 的匹配链。把它误当成规则应用阶段，会找不到任何对应的 inspector。

**输入 → 动作 → 输出**：输入是三条看起来都叫「协议」、实际路径不同的东西；动作是分别追它们真正生效的位置——`statusCode` / `redirect` 经别名归并后被标成 `isSpec`、仍走 `rule` 桶却在发请求前由 `getStatusCodeFromRule` 短路返回，`file` / `tpl` / `rawfile` 由 `RULE_RE` / `isFileProxy` 单独识别、按 `req.options.protocol` 接入文件 handler，`lib/service/` 是 pfork 拉起的管理子进程、只接几类转发路径、根本不经过匹配链；输出是「这三条各自不落在哪个 inspector」的明确结论。

**为什么把它们单列出来**：文档里都叫「协议」，代码里却分属三条完全不同的路径；若默认「凡协议都走分桶 → inspector」，改源码时就会去找一个根本不存在的 inspector。把结论展开：`statusCode` / `redirect` 要在「建立连接之前就结束」，`file` 系列要支持路径透传（所以不能只取首条命中），`lib/service/` 处理的是 composer、抓包导入导出、插件安装这类管理流量——三者的共同点只是「名字像协议」，其余没有一处相同。代价是这三条各要记一条例外；边界是「不在 `protocols` 数组里」不等于「不生效」，只是生效路径不在分发表里。

**为什么 `file` 系列支持路径透传，而普通协议只取首条命中**：`RULE_RE` 与 `isFileProxy` 单独识别它们、按 `req.options.protocol` 接入，而不是靠协议分桶取首条命中。把结论展开：本地文件规则常要把 URL 里剩余的路径接到本地目录后面，形如「命中前缀 + 透传剩余路径」；若压成「首条命中即返回」，剩余路径就丢了。绕开分桶、改按 `options.protocol` 分发，正是为了保留这段路径。代价是它们不参与常规的「每协议一项」形态；边界是这套路径透传只对文件类规则成立。

**代价与边界**：`isSpec` 短路让状态码与跳转在建连前就返回，代价是它们不参与任何改写、也不产生响应体；`file` 系列按 `req.options.protocol` 分发，代价是绕开了「每协议取首条命中」的常规形态；`lib/service/` 不参与匹配，边界是只有列出的那几类转发路径才转给它，把它误当成规则应用阶段会一无所获。三条例外彼此也不通用，排障时要先认清面前是哪一条路径。

**打个比方**：这三条像都挂在「协议」招牌下的三个柜台，其实一个在「开门前就办完」（短路返回）、一个走「后门专窗」（文件 handler）、一个根本不在营业厅里（管理子进程）。顺着招牌去找统一的 inspector 窗口只会扑空；先认清各自柜台在哪，才知道该翻哪一段源码。

**自己验证**：对照「指令分类表」里 `statusCode` / `redirect` 标的「短路」、`file / tpl` 标的「出站」，再回看本节三条辨析，回答「为什么这三条都不能在匹配链里找到对应实现」；能说清「名字像协议、路径各不同」，就避开了改源码时最常见的空跑。

## 自定义协议注册

包名形如 `whistle.[a-z\d_-]+`，可带 npm scope（`lib/plugins/util.js:8-10,69-83`）。`get-plugins-sync.js:115-199` 读取 `package.json` 的 `whistleConfig`，由简名生成短协议、由完整包名生成长协议，并可用 `hideShortProtocol` / `hideLongProtocol`（`:175-176`）关闭其一；`rules.txt`、`_rules.txt`（兼容 `reqRules.txt`）、`resRules.txt` 三份静态规则文件分别在 `:185-199` 被渲染。`rulesServer` 是动态规则 hook，由 `lib/plugins/load-plugin.js:1903-1904` 起服务、`:2205-2207` 接请求。请求期由 `lib/plugins/index.js:1436-1472` 的 `resolveWhistlePlugins` 把 `rule` 桶与 `plugin` 桶里的规则解析成插件名与取值，交给主进程转发。

值得注意的是注册顺序：静态规则文件在插件扫描时一次性读入缓存，动态规则才每请求调用；因此高频变化应放 `rulesServer`，纯映射放 `rules.txt`，避免让每次请求都多一次跨进程往返。插件协议与内置协议的边界同样由这张数组决定：`lib/plugins/util.js:132-140` 的 `excludePlugin` 会用 `protocols.contains(name)` 拒绝与内置协议同名的插件，避免 `whistle.host` 之类包名悄悄覆盖 `host` 指令。换言之，`protocols` 数组既是分发依据，也是命名空间保护线。

**输入 → 动作 → 输出**：输入是形如 `whistle.[a-z\d_-]+` 的包名（可带 npm scope）、`package.json` 里的 `whistleConfig`、三份静态规则文件 `rules.txt` / `_rules.txt` / `resRules.txt`，以及动态规则 hook `rulesServer`；动作是插件扫描时由简名生成短协议、由完整包名生成长协议（可用 `hideShortProtocol` / `hideLongProtocol` 关闭其一）、一次性渲染静态规则文件、为动态规则起服务接请求、`resolveWhistlePlugins` 把 `rule` 桶与 `plugin` 桶里的规则解析成插件名与取值交给主进程转发；输出是「插件协议 → 插件进程」的注册与解析通路。

**为什么静态规则与动态规则要分开**：静态规则文件在插件扫描时一次性读入缓存，动态规则才每请求调用。把结论展开：`rules.txt` 里多是「协议名 → 固定映射」，一次读入即可反复用；而 `rulesServer` 面向高频变化的内容，若也塞进静态文件，每次改动都要重新扫描一遍。把原文那句「高频变化应放 `rulesServer`、纯映射放 `rules.txt`」翻过来理解：分开是为了不让每次请求都多一次跨进程往返。代价是两类规则各有自己的加载时机，排障时要先分清改的是哪一份；边界是注册顺序由插件扫描决定，静态规则早于任何请求存在。

**为什么 `protocols` 数组能同时当「命名空间保护线」**：`excludePlugin` 用 `protocols.contains(name)` 拒绝与内置协议同名的插件，避免 `whistle.host` 之类包名悄悄覆盖 `host` 指令。把结论展开：插件协议与内置协议共用同一套 `xxx://` 写法与同一张分发表，若允许同名，用户写一条 `host` 指令时根本分不清该走内置路由还是插件；用数组做一次冲突检查，等于在注册入口就把歧义挡住。代价是插件包名要避开 73 个内置名字；边界是它只挡「同名」，不限制插件自定义其它短 / 长协议名。

**为什么同一插件会有长短两个协议名**：由简名生成短协议、由完整包名生成长协议，`hideShortProtocol` / `hideLongProtocol` 还能各关掉一个。把结论展开：短协议方便手写，长协议在带 npm scope 的包名下仍能保持全局唯一；两者指向同一个插件，只是入口别名不同。代价是读 `req.rules` 时要认清落的是哪一个、别当成两个不同插件；边界是「关掉其一」只影响名字可见性，不改变插件本身的解析通路。

**代价与边界**：动态规则灵活，代价是每请求一次跨进程调用；静态规则省往返，代价是变化要等下一次扫描。`whistleConfig` 让命名可控，也意味着「同一个插件可能有两个协议名」。边界是未知 `xxx://` 回退 `rule` 桶只是入口，真正能不能解析成插件，取决于 `resolveWhistlePlugins` 能否在已注册的插件里找到对应名字——回退不等于一定生效。

**打个比方**：静态规则文件像一次印好、人手一册的通讯录，查得快但改一个号码得等下次再印；`rulesServer` 像每来一个电话就现问一次查号台，随时能变、代价是每次多一通跨进程问询。短协议与长协议则是同一个人登记的两个别名（一个好记、一个带全名不会重），`excludePlugin` 像入职时核对花名册，禁止新人和老员工重名，免得前台分不清该把电话转给谁。

**自己验证**：对照本节列出的三份静态规则文件与 `rulesServer`，自己分一分「改哪一份会立刻生效、改哪一份要等扫描」；再回看 `contains(name)` 与 `excludePlugin` 那两处，回答「为什么一个叫 `whistle.host` 的包注册不上」。能说清「数组既是分发依据、也是命名空间保护线」，就把本节与第一节那张 73 项数组接上了。

## 常见误解

1. **容易以为 73 个协议名就是全部指令，其实 `statusCode` / `redirect` 与 `file` / `tpl` / `rawfile` 都不在这张数组里**：前者经别名归并标成 `isSpec` 后由 `getStatusCodeFromRule` 在建连前短路返回，后者由 `RULE_RE` / `isFileProxy` 单独识别、按 `req.options.protocol` 接入文件 handler。把「数组里没有」当成「不生效」，就会在 inspectors 里找一个不存在的实现。
2. **容易以为别名归并后 `skip://` 与 `ignore://` 完全等价，其实运行期又被重新分流**：`skip:'ignore'` 只统一了分桶名，`resolveProps` 会把保留前缀的 `skip://` 摘进 `req._skipProps` 走「跳过当前规则、继续匹配」，`ignore://` 才删掉整个协议桶；机制差异见 [《规则引擎》](/modules/rules-engine) 的过滤器小节，对照可查[《易混淆概念辨析》](/concepts/08-confusions)。
3. **容易以为插件的静态规则改了会立刻生效，其实 `rules.txt` 要等下一次插件扫描、`rulesServer` 才每请求调用**：静态规则文件在扫描时一次性读入缓存，高频变化应放动态 hook；把两者当成同一份「随时可改」的规则，就会在界面上等不到变化，对照见自定义协议注册一节。
4. **容易以为每协议都只取首条命中，其实 `multiMatchs` 列出的协议会收集全部命中**：默认分发链对每个协议取首条命中挂进 `req.rules`，但 `rulesFile` / `resScript` 这类协议改用 `getRuleList` 收集全部命中并挂到 `rule.list`，返回前再用 `ignoreRules` 统一删桶。把「首条命中」当成全站铁律，就会奇怪「为什么后面几条脚本规则也能生效」。

## 小结

- `protocols.js:1-75` 的 73 项数组是协议名注册表，`aliasProtocols` 归并写法，派生集合决定阶段与多命中行为。
- `parseRule` 判定并分桶，`resolveRules` 按阶段取首条命中组装 `req.rules`，再由 inspectors 应用、handlers 出站。
- `contains` 与未知 `xxx://` 回退 `rule`，是插件协议得以接入的入口。
- `statusCode` / `redirect` 走 isSpec 短路，`file` 系列按 `options.protocol` 分发，`lib/service/` 不参与匹配。
- 自定义协议来自 `whistle.xxx` 包名的长短协议、三份静态规则文件与 `rulesServer` 动态 hook。
- 本篇为 [《证书体系的实现细节》](/modules/certificates) 准备了「握手阶段指令的前提」这个入口：分发链把 `cipher` / `sniCallback` 标成握手阶段、不属于任何 inspector，15 才能接着补上 HTTPS 解密链路所需的本地 CA 生成、缓存与按域名签发叶证书。

## 下一步

[《证书体系的实现细节》](/modules/certificates)：当请求进入 HTTPS 解密链路，看本地 CA 如何生成、缓存并为每个域名签发叶证书。 紧接着读它，是因为本篇把指令一路分发到了 inspectors 与 handlers，却把 `cipher` / `sniCallback` 这类握手阶段指令只标成「TLS 参数」、没交代它们生效的前提；HTTPS 解密链路要先有客户端信任的本地根 CA、并由它为每个域名签发叶证书，前面这条「匹配 → 改写 → 出站」的链才接得上加密流量。15 正好补上本地 CA 的生成、缓存与签发，把本篇留在握手阶段的悬念落到证书体系上。
