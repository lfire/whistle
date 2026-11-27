---
title: L3 造得出 · 把没发生过的现场造出来
description: 练接口未就绪的 Mock 契约、慢网与异常注入、偶发故障概率化、保存现场与重放。
---

# L3 造得出 · 把没发生过的现场造出来

::: tip 先修知识
已完成 [L2 改得动](/practice/l2-rewrite)，会按目标写规则、限定范围、用对照证明没误伤。继续用 [自造靶子](/practice/target)，不需要后端、真机或真实故障。
:::

## 本关目标

从「能改一条请求」升级到「能造一个现场」：接口还没写好也能联调，超时/慢响应/偶发 500 不用等线上复现，偶发问题能存下来反复重放。做完你能独立回答「我要验证的是客户端的哪个假设，该用哪条规则把它稳定造出来」。

## 开始前

`练习靶子` 基线（ON 开着、已 Save）：

```txt
$practice.test/api file://({"status":"ok"})
$practice.test/other file://({"status":"other"})
```

## 任务

### 第 1 步 · 接口未就绪，先把契约固定下来

后端只给了接口文档，服务还没部署。用 Values 造一份稳定的响应：

1. 按 [第 0 站](/guide/quickstart#再进一步用-values-返回固定-json) 的做法，在 **Values** 里建 `user.json`，填 `{"id":1,"name":"demo"}` 并保存。
2. 规则组里追加（基线用了 `$` 精确匹配 `/api`，不会遮蔽 `/api/user`，**无需删除**；若你之前写的是不带 `$` 的宽匹配，先改成 `$`，否则这条子路径会被基线抢先命中）：

```txt
$practice.test/api/user file://{user.json} resType://json
```

3. 发请求：`curl -s -i -x 127.0.0.1:8899 http://practice.test/api/user`。

**这一步的价值**：前端不用等后端，规则就是契约。后端就绪后把这条规则关掉即可，业务代码一行都不用改。注意 `file://` 是短路转发，请求根本不出网（机制见 [20](/scenarios/mock-contract)）。

### 第 2 步 · 把「偶发」变成「必现」

依次追加规则，每次发请求看结果：

| 想验证的客户端行为 | 规则 | 该看到 |
|---|---|---|
| 接口 500 时的降级提示 | `practice.test/api statusCode://500` | 状态码 500，没有业务响应体 |
| 请求发出后一直没结果 | `practice.test/api reqDelay://3000` | 约 3 秒后才响应 |
| 响应回来但很慢 | `practice.test/api resDelay://3000` | 请求已发出、响应延迟约 3 秒 |
| 连接被中断 | `practice.test/api reqDelay://5000 enable://abort` | 请求中断、没有正常响应 |
| 一半请求失败 | `practice.test/api statusCode://500 includeFilter://chance:0.5` | 连发 10 次，约一半是 500 |

`chance` 是**过滤器**，不是独立协议，必须写成 `includeFilter://chance:0.5`（取值 0–1，官方 `docs/docs/rules/filters.md`）。它是每次请求现算的概率，所以是统计近似——想稳定复现就去掉 `chance`，只留 `statusCode://500`。

### 第 3 步 · 把现场存下来再反复重放

1. 在 Network 里右键那条请求 → **Save**（快捷键 `Ctrl+S` / `Cmd+S`）。
2. **Export** 导出为 `.saz`，再用 **Import** 导入回来（官方 `docs/docs/gui/composer.md` 也支持 Import / Export）。
3. 打开 **Composer**，对保存的请求改一个请求头或方法，点发送；用 `fc:` 在搜索框单独筛出这次构造的请求。
4. 对比原请求与重放请求：重放是**回打 Whistle 自身代理**，所以仍会命中当前规则、仍会被抓到（见 [21](/scenarios/reproduce-replay)）。这解释了为什么关掉规则再重放会看到不同结果。

### 第 4 步 · 把一组条件叠起来，做一个完整场景

把上面几步组合成一个可复用的「弱网 + 偶发错误」规则集（新建一组，命名 `弱网演练`）：

```txt
$practice.test/api/user file://{user.json} resType://json
$practice.test/api/slow reqDelay://2000
$practice.test/api/slow file://({"status":"slow"})
$practice.test/api/flaky statusCode://500 includeFilter://chance:0.5
$practice.test/api/flaky file://({"status":"ok"})
$practice.test/api/abort reqDelay://3000 enable://abort
```

**为什么每个路径要写两行**：不同协议的规则可以叠加，同一协议只首条命中（[L2](/practice/l2-rewrite) 第 5 步）。`chance` 未命中时第一行不生效，请求会落到第二行 `file://` 拿到固定响应——所以连发 10 次会看到约一半 500、一半 200，而不是「一半失败、一半 502」。若不给 `slow` / `flaky` 兜底，未命中条件时请求会尝试出网，而这个域名根本不存在。

四个路径互不干扰，一次演练里能分别验证正常、慢、偶发失败、中断四种客户端分支。这就是「灵活」的样子：不是记一条规则，而是按目标搭出一套可切换的场景。

### 第 5 步 · 半开放：只给目标，自己设计

前面每一步都给了规则文本，那只证明你会执行。下面三个目标**只给需求、不给答案**：自己写规则、自己决定怎么验证、自己清场，写完再展开参考思路对照。

**目标 1**：只让 `POST` 的 `/api/order` 返回 `{"status":"maintenance"}`，`GET` 与其它路径完全不受影响。
**目标 2**：让 `/api/slow` 中约 1/10 的请求延迟 2 秒，其余立即返回固定内容。
**目标 3**：给带 `X-Client: phone-sim` 的请求加响应头 `x-target: phone`，其它客户端不加。

每个目标都要写出：规则文本、两发对照的 curl、预期看到什么、怎么清场。

::: details 参考思路（先自己写完再展开）
目标 1：

```txt
$practice.test/api/order file://({"status":"maintenance"}) includeFilter://m:POST
```

再发一次 GET 与 `/other` 做对照。

目标 2：

```txt
$practice.test/api/slow reqDelay://2000 includeFilter://chance:0.1
$practice.test/api/slow file://({"status":"ok"})
```

第二行是兜底：`chance` 未命中时仍要有响应。连发 20 次，应看到少数变慢、其余正常。

目标 3：

```txt
practice.test resHeaders://x-target=phone includeFilter://reqH.x-client:phone-sim
```

带 / 不带该请求头各发一次做对照。

**判据**：三条都做出「该变 / 不该变」两发对照；至少一条用了过滤器；做完关掉 ON 清场。三条一次写对，说明你能自己设计规则集，可以进 [L4](/practice/l4-extend)；卡住就回 [L2](/practice/l2-rewrite) 第 3–4 步补 pattern 与过滤器。
:::

## 验收

**该看到**：`/api/user` 返回 Values 里的固定 JSON；`statusCode://500` 立即返回 500；`reqDelay://3000` 明显变慢；`chance:0.5` 连发 10 次约一半失败；Save/Export/Import 后能重放且 `fc:` 能筛出；四个演练路径各自表现不同。

**不该看到**：改了规则但四个路径表现一样（说明 pattern 写宽或规则组没切对）；`chance` 写成独立协议导致规则没命中；重放时看不到 `fc:`（Composer 的 Global Rules 开关没开）。

## 变式

1. **只让 POST 失败**：给 `statusCode://500` 加 `includeFilter://m:POST`，用 GET/POST 各发一次做对照。
2. **概率调到必现**：把 `chance:0.5` 改成 `chance:1`，确认 10 次全失败；再改成 `chance:0` 确认全成功。
3. **延迟叠加**：同一行同时写 `reqDelay://1000` 与 `resDelay://1000`，看总耗时是否约 2 秒，理解两个阶段各自卡在哪。
4. **重放时改规则**：先开着 `statusCode://500` 重放一次、关掉再重放一次，对比两次响应——验证「重放仍受当前规则影响」。

## 没看到预期？按顺序查

1. ON / Save / 当前规则组（每关第一步都是这个）。
2. `chance` 是否写成 `includeFilter://chance:0.5`；概率是否落在 0–1。
3. `reqDelay` / `resDelay` 单位是毫秒；`enable://abort` 要与延迟类规则同行使中断才有意义。
4. `file://{user.json}` 的 key 名与 Values 里是否完全一致、内容是否保存。
5. 重放没出现 → Composer 的 **Whistle** 开关、`fc:` 过滤前缀。
6. 四个路径串味 → pattern 是否写得太宽、是否有另一组规则也在命中。

## 收尾

关掉 `弱网演练` 与 `练习靶子` 的 ON；把 `statusCode://500`、`reqDelay`、`chance` 这些会改变行为的规则全部移除或注释。**调试规则用完必须清**——留在系统里，下一个问题会被你自己的规则带偏。

## 背后的机制

- Mock 为什么短路、内联值与 Values 的区别：[20《接口未就绪：Mock 与契约先行》](/scenarios/mock-contract)。
- 延迟/中断分别卡在转发前还是回写前、`chance` 何时掷骰子：[22《弱网与异常注入》](/scenarios/fault-injection)。
- 重放为什么回打自身代理、Save/Export 的数据形态：[21《复现、保存与重放》](/scenarios/reproduce-replay)。
- 请求期与响应期的阶段划分：[09《一次 HTTP 代理请求的旅程》](/core/http-request)。

## 晋级标准

不看本页，给定一个假设（例如「客户端在接口 500 且慢响应时会不会重复提交」），能独立选规则把场景稳定造出来、连发多次验证、把现场存成可重放的证据、演练完清场。做到就进 [L4 接得上](/practice/l4-extend)。

## 下一步

[L4 扩展](/practice/l4-extend)：把 HTTPS 解密、真机、上游代理、多人共享与 CI 这些更复杂的接入方式跑通，每项都给本机等价替代做法。
