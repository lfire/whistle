---
title: L2 改得动 · 按目标选指令、精确限定、验证没误伤
description: 练请求头/响应头/状态码/响应体改写、pattern 与过滤器限定、规则顺序与命中排查。
---

# L2 改得动 · 按目标选指令、精确限定、验证没误伤

::: tip 先修知识
已完成 [L1 看得见](/practice/l1-observe)，能点开一条请求看全并留下证据。所有练习继续用 [自造靶子](/practice/target)，不需要后端与 HTTPS。
:::

## 本关目标

拿到一个明确目标（例如「只给 `/api` 加一个请求头，其它路径不许变」），你能选对指令、把作用范围精确限定、用 Network 证据确认生效，并**证明没有误伤别的请求**。会改只是及格，能限定且能证伪才是「灵活」。

## 开始前

打开 `练习靶子` 规则组（ON 开着），并把它改成下面这组基线（Save 后确认）：

```txt
$practice.test/api file://({"status":"ok"})
$practice.test/other file://({"status":"other"})
```

这两条路径就是本关的「目标」与「对照组」：任何改动都必须在 `/api` 上生效、在 `/other` 上不生效。

## 任务

### 第 1 步 · 按目标选指令，各做一轮

把下面每一行**单独**加到规则组末尾（一次只加一条，做完看结果，再换下一条），发请求验证：

| 目标 | 追加的规则 | 怎么发 | 该看到 |
|---|---|---|---|
| 给请求加头 | `practice.test/api reqHeaders://x-practice=1` | `curl -s -i -x 127.0.0.1:8899 http://practice.test/api` | 点开 Request Headers 出现 `x-practice: 1` |
| 给响应加头 | `practice.test/api resHeaders://x-practice=1` | 同上 | Response Headers 出现 `x-practice: 1` |
| 直接返状态码 | `practice.test/api statusCode://404` | 同上 | 状态码 404，且没有你写的 JSON |
| 改响应体 | `practice.test/api resBody://(changed)` | 同上 | 响应体被追加/替换为 `changed` |

> 内联值一律用英文括号 `()` 包裹、内容不含空格（官方 `docs/docs/rules/file.md`、`resBody.md`）。`statusCode://` 会立即中断请求、不转发后端，是造错误场景最快的指令。

### 第 2 步 · 每一步都做「没误伤」验证

加完任意一条规则后，**同时**发两条：

```sh
curl -s -i -x 127.0.0.1:8899 http://practice.test/api
curl -s -i -x 127.0.0.1:8899 http://practice.test/other
```

`/api` 必须变、`/other` 必须原样。这一步比「改成功」更重要——真实工作里最常出的事故就是规则写宽了，把别人的请求一起改了。

### 第 3 步 · 练 pattern 的三种限定

依次把规则里的 pattern 换成下面三种，观察命中范围变化（`$` 是官方的路径精确匹配前缀，`^` 开启通配符解析）：

```txt
$practice.test/api reqHeaders://x-practice=1       # 路径精确：只命中 /api，/api/user 不命中
practice.test reqHeaders://x-practice=1             # 整域名：所有路径都命中
^practice.test/api/* reqHeaders://x-practice=1      # 通配符：/api/xxx 命中，/other 不命中
```

每换一种，把这三条都发一遍，把「谁变了、谁没变」记下来：

```sh
curl -s -i -x 127.0.0.1:8899 http://practice.test/api
curl -s -i -x 127.0.0.1:8899 http://practice.test/api/user
curl -s -i -x 127.0.0.1:8899 http://practice.test/other
```

基线里我们已经用 `$` 精确匹配 `/api`：**不加 `$` 时 `practice.test/api` 会按路径前缀连 `/api/user` 一起命中**，后面 L3 的 Mock 与故障注入就会被它遮蔽。这是本关最容易被忽略、在真实项目里也最容易出事故的一点。完整匹配语法见官方 `docs/docs/rules/pattern.md`。

### 第 4 步 · 用过滤器按方法/内容二次限定

```txt
practice.test reqHeaders://x-practice=1 includeFilter://m:POST
```

分别发 GET 与 POST（`-X POST`），应该只有 POST 那条带上请求头。`chance`、`reqH.`、`b:` 等过滤器的完整清单见官方 `docs/docs/rules/filters.md`。其中按请求头限定的写法是 `includeFilter://reqH.头名:值`（值支持关键字或正则），例如 `includeFilter://reqH.x-client:phone-sim`——[L3](/practice/l3-simulate) 的半开放目标 3 会用到，先在这里发一发 `curl -s -i -x 127.0.0.1:8899 -H "X-Client: phone-sim" http://practice.test/api` 验证它能命中。排除型写法是 `excludeFilter://*/static` 这种。

### 第 5 步 · 练规则顺序

把两条规则写成上下两行、都匹配 `practice.test/api` 但给不同的头值，发一次请求，看哪个生效。默认每协议**首条命中即返回**，行序就是优先级；`lineProps://important` 可以把某行提前。这就是「规则写了却没生效」最常见的原因之一，机制见 [13《规则引擎》](/modules/rules-engine)。

### 第 6 步 · 复用 Values，并练「多协议叠加」

[第 0 站](/guide/quickstart#再进一步用-values-返回固定-json) 教过 Values，这里把步骤再走一遍：打开 **Values** Tab → **Create** → 命名 `mock.json` → 内容填 `{"status":"ok","from":"values"}` → 保存。`{mock.json}` 里的名字必须与这里完全一致，否则取不到值。规则改成：

```txt
$practice.test/api file://{mock.json}
```

再发请求，响应应来自 Values；改 Values 内容保存后刷新，响应跟着变——规则文本与内容分离，团队协作时尤其有用。接着在同一路径上**叠加**一条不同协议的规则（例如再加 `reqHeaders://x-layer=2`），发一次请求，应同时看到自定义请求头与 Values 的响应。这验证了一条关键机制：不同协议桶各取首条命中、可以叠加，而同一协议只取第一条（[13](/modules/rules-engine)）。L3 的「延迟 + 兜底响应」就建立在这个结论上。

## 验收

**该看到**：每条指令都在 `/api` 上产生预期变化；`/other` 始终原样；`includeFilter://m:POST` 只影响 POST；两行同 pattern 时只有第一条生效；`file://{mock.json}` 返回 Values 里的内容。

**不该看到**：改一条规则导致两条路径同时变化（说明 pattern 写宽了）；改了 Values 却没变化（没 Save 或 key 名不一致）；所有请求都 404（内联值漏了括号）。

## 变式

1. **只匹配 POST 的 Mock**：把 `file://{mock.json}` 加上 `includeFilter://m:POST`，确认 GET 时不返回 Mock。
2. **排除静态资源**：给整域名规则加 `excludeFilter://*/static`，再发 `/static/a.js`，确认它被排除。
3. **故意写坏**：把 `reqHeaders://x-practice=1` 写成 `reqHeaders://x-practice = 1`（多空格），看规则是否还命中；记住「编译没报错但没生效」的表现。
4. **提升优先级**：给第二行加 `lineProps://important`，看它是否反超第一行。

## 没看到预期？按顺序查

1. **ON / Save / 当前规则组**——三项先确认，[第 0 站](/guide/quickstart) 第 6 步有完整顺序。
2. **pattern 是否真的匹配**——在 Network 里点开请求看完整 URL，别凭记忆写。
3. **是否被前面的规则先命中**——默认首条命中即返回，行序即优先级；`lineProps://important` 能改变顺序。
4. **过滤器是否把请求排除了**——`includeFilter` / `excludeFilter` 的条件逐条对一遍。
5. **Values key 是否存在、有没有空格**——`{key}` 与 Values 里的名字必须完全一致。
6. **请求/响应期是否搞反**——`reqHeaders` 在转发前、`resHeaders` 在回写前，看错面板会以为没生效。
7. **是不是 HTTPS 没解密**——本关用 http；HTTPS 的规则必须先在 [L4](/practice/l4-extend) 完成证书与 Enable HTTPS。

## 收尾

把本关追加的所有规则删掉，只留 `练习靶子` 的两条基线；关掉 ON。养成习惯：**每做完一个调试目标就清场**，不留一串互相覆盖的旧规则。

## 背后的机制

- 指令全景与 73 个协议名：[14《指令体系与分发链路》](/modules/protocol-catalog)、[37《规则 DSL 全景》](/concepts/06-rules)。
- 编译期结构化、请求期求值、首条命中与分桶：[13《规则引擎：解析与匹配》](/modules/rules-engine)。
- `file://` 短路与 Values：[20《Mock 与契约先行》](/scenarios/mock-contract)。
- 改写发生在流的哪一段：[09《一次 HTTP 代理请求的旅程》](/core/http-request)。

## 晋级标准

不看本页，给定一个目标（例如「只给 POST 的 `/api` 返回固定 JSON，其它请求一律不动」），能独立写出规则、发两类请求做对照、用 Network 证据证明生效且没误伤，并能在没生效时按上面 7 步自己定位原因。做到就进 [L3 造得出](/practice/l3-simulate)。

## 下一步

[L3 构造](/practice/l3-simulate)：把接口未就绪、偶发 500、慢网这些「现场里碰不到」的情况，用规则变成随时可复现的必现场景。
