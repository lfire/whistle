---
title: 指令体系与分发链路
description: 从协议名数组、别名与派生集合出发，讲清一条指令如何分桶、取首条命中并落到 inspector 或 handler。
---

上一篇把规则文本编译成了按协议分桶的 rule 对象，本篇接着回答「分桶之后谁消费」。Whistle 的指令不是一个枚举类，而是 `lib/rules/protocols.js` 里一张协议名数组加若干派生集合；理解别名、分桶和阶段筛选，就能判断任意一条 `xxx://value` 会在哪个文件里生效。以下按「静态定义 → 请求期分发 → 分类清单 → 易混淆点 → 扩展注册」展开，行号均来自当前分支。

## 73 个协议名与派生集合

`lib/rules/protocols.js:1-75` 的 `protocols` 数组共 73 项，从 `G`、`style`、`host`、`rule` 一直到 `cipher`、`sniCallback`，它是全站唯一的「合法协议名」清单。`lib/rules/protocols.js:131-154` 的 `aliasProtocols` 负责把用户习惯的写法归并进来：`status` → `statusCode`、`skip` → `ignore`、`pathReplace` → `urlReplace`、`hosts` / `xhost` → `host`、`P` → `G`，以及 `html` / `js` / `css` 分别落到 `htmlAppend` / `jsAppend` / `cssAppend`。别名只在解析期生效，运行期看到的始终是归并后的名字。

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
| enable / disable | 开关能力 | protocols.js:14 | 全局 |
| rulesFile | 动态规则 | rules/index.js:437 | 请求 |
| resScript | 响应脚本 | rules/index.js:462 | 响应 |
| reqDelay | 请求延迟 | data.js:544 | 请求 |
| weinre / log | 注入脚本 | weinre.js:24 | 响应 |
| cipher / sniCallback | TLS 参数 | rules/index.js:682 | 握手 |
:::

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

## 自定义协议注册

包名形如 `whistle.[a-z\d_-]+`，可带 npm scope（`lib/plugins/util.js:8-10,69-83`）。`get-plugins-sync.js:115-199` 读取 `package.json` 的 `whistleConfig`，由简名生成短协议、由完整包名生成长协议，并可用 `hideShortProtocol` / `hideLongProtocol`（`:175-176`）关闭其一；`rules.txt`、`_rules.txt`（兼容 `reqRules.txt`）、`resRules.txt` 三份静态规则文件分别在 `:185-199` 被渲染。`rulesServer` 是动态规则 hook，由 `lib/plugins/load-plugin.js:1903-1904` 起服务、`:2205-2207` 接请求。请求期由 `lib/plugins/index.js:1436-1472` 的 `resolveWhistlePlugins` 把 `rule` 桶与 `plugin` 桶里的规则解析成插件名与取值，交给主进程转发。

值得注意的是注册顺序：静态规则文件在插件扫描时一次性读入缓存，动态规则才每请求调用；因此高频变化应放 `rulesServer`，纯映射放 `rules.txt`，避免让每次请求都多一次跨进程往返。插件协议与内置协议的边界同样由这张数组决定：`lib/plugins/util.js:132-140` 的 `excludePlugin` 会用 `protocols.contains(name)` 拒绝与内置协议同名的插件，避免 `whistle.host` 之类包名悄悄覆盖 `host` 指令。换言之，`protocols` 数组既是分发依据，也是命名空间保护线。

## 小结

- `protocols.js:1-75` 的 73 项数组是协议名注册表，`aliasProtocols` 归并写法，派生集合决定阶段与多命中行为。
- `parseRule` 判定并分桶，`resolveRules` 按阶段取首条命中组装 `req.rules`，再由 inspectors 应用、handlers 出站。
- `contains` 与未知 `xxx://` 回退 `rule`，是插件协议得以接入的入口。
- `statusCode` / `redirect` 走 isSpec 短路，`file` 系列按 `options.protocol` 分发，`lib/service/` 不参与匹配。
- 自定义协议来自 `whistle.xxx` 包名的长短协议、三份静态规则文件与 `rulesServer` 动态 hook。

## 下一步

[《证书体系的实现细节》](/modules/certificates)：当请求进入 HTTPS 解密链路，看本地 CA 如何生成、缓存并为每个域名签发叶证书。
