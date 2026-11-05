---
title: 弱网与异常注入：把偶发变成必现
description: 用规则把偶发的超时、抖动与错误码固定成可复现场景，并沿源码追溯其编译、生效与中断路径。
---

# 弱网与异常注入：把偶发变成必现

线上偶发的超时、慢响应与 5xx 往往只在特定网络条件下出现，回到测试环境就消失。本篇以 Whistle 的延迟、限速、状态码与缓存规则为工具，把这类偶发问题改造成可重复触发的确定性场景，并沿源码说明规则从文本到请求的落点。读完你能独立搭出弱网与异常注入组合，也清楚每条规则在哪个阶段生效、在什么情况下不生效。

## 场景与痛点

移动端弱网验收。产品在高铁、电梯等场景下白屏或反复重试，而办公网络一切正常。需要把 3 秒请求延迟、5 秒响应延迟以及 3kb/s 限速固定下来，才能稳定观察加载态、骨架屏与超时提示是否按设计出现，而不是靠运气复现。

后端不稳定接口联调。依赖方接口偶发 500 或 429，客户端的重试与降级逻辑难以验证。用 `chance:0.5` 让一半请求返回 500，再对限流路径返回 429 并附带 `retry-after`，可以把容错分支从「等它自己坏」变成「每次都走到」。

维护与缓存演练。发布窗口需要验证维护页、缓存头与超时阈值。把域名整体改成 503 维护页、对静态资源设置长缓存、对接口禁用缓存，同时验证默认 36 秒无数据传输的超时判定，能提前暴露客户端对缓存与超时的错误假设。

::: cols 20|30|50
| 规则 | 生效阶段 | 作用 |
|---|---|---|
| reqDelay | 转发请求前 | 延迟请求上行 |
| resDelay | 回写响应前 | 延迟响应下行 |
| statusCode | 请求期短路 | 不回源直接返回 |
| replaceStatus | 响应期 | 回源后替换状态码 |
:::

## 可复制的配置

以下规则可直接粘贴到 Rules 面板，按需要叠加 `includeFilter` 或 `excludeFilter` 收窄命中范围，避免误伤同一域名下的其它请求；调试结束把对应行注释掉即可恢复，不必改动任何业务代码。延迟与中断成对使用，可以在延迟结束后直接掐断连接，模拟「请求发出但永远收不到结果」。

```txt
# 来源：docs/docs/rules/reqDelay.md
www.example.com/path reqDelay://3000
www.example.com/path2 reqDelay://5000 enable://abort

# 来源：docs/docs/rules/resDelay.md
www.example.com/path resDelay://3000
www.example.com/path2 resDelay://5000 enable://abortRes
```

固定毫秒值只能覆盖单一时序，官方给出用 `reqScript` 动态生成规则，随机落在 1 至 6 秒之间。

````txt
# 来源：docs/docs/rules/reqDelay.md、reqScript.md
``` delay.js
rules.push(`* reqDelay://${1000 + Math.ceil(5000 * Math.random())}`);
```
www.example.com/path reqScript://{delay.js}
````

状态码与响应改写分属两个时机：`statusCode` 在请求期短路，`replaceStatus` 先回源再改码。

```txt
# 来源：docs/docs/rules/statusCode.md
www.example.com/api/unstable statusCode://500 includeFilter://chance:0.5

# 来源：docs/docs/rules/replaceStatus.md
www.example.com replaceStatus://503 resBody://(<h1>系统维护中...</h1>)
www.example.com/api/rate-limited replaceStatus://429 resHeaders://retry-after=60
```

限速单位是 kb/s，请求体与响应体分别由两条规则控制。

```txt
# 来源：docs/docs/rules/reqSpeed.md、resSpeed.md
www.example.com/path reqSpeed://3
www.example.com/path resSpeed://3
```

缓存与超时属于边界条件注入，用来验证客户端是否遵守服务端约定。

```txt
# 来源：docs/docs/rules/cache.md
https://example.com/static cache://3600
https://example.com/api cache://no-cache

# 来源：docs/docs/rules/disable.md
wwww.example.com/path disable://cache
pattern disable://timeout
```

## 背后的设计思想

[可观测性优先](/domain/debugging-workflow)：偶发问题难修，是因为观察窗口不可控。Whistle 不改动业务代码，而是把网络条件变成可编辑的规则文本，延迟、限速与状态码都可以在两次请求之间切换，于是「偶发」被压缩为「按配置必现」，抓包列表里也能同步看到规则命中情况。

[过滤器在解析期编译、请求期判定](/modules/rules-engine)：`chance:0.5` 只在规则解析时编译成概率匹配器，真正的随机判定发生在每次请求匹配阶段。解析与执行分离，使同一条规则文本无需重复解析就能对大量请求逐条判定，也让包含过滤器与排除过滤器能和其他指令自由组合。

[请求期与响应期时机分离](/modules/protocol-catalog)：`reqDelay` 卡在转发前，`resDelay` 卡在回源后；`statusCode` 不回源，`replaceStatus` 必须先拿到真实响应。指令被绑定到明确阶段，才不会用错工具——想验证客户端对空响应体的处理，就不能拿 `replaceStatus` 代替 `statusCode`。

[内存有界优先](/core/capture-data)与[中断能力由界面反向下发](/modules/webui)：长时间挂起的连接会持续占用抓包内存，因此除了 36 秒超时兜底，界面还能主动中断。规则描述「要发生什么」，界面描述「现在停掉哪一条」，两者通过请求编号汇合，既保证观测数据有界，也让调试者随时收回控制权。

## 源码链路

1. **入口 · 过滤器编译**：`lib/rules/rules.js:1549-1739` 的 `resolveMatchFilter` 把 `m:`、`b:`、`chance:` 等前缀解析成匹配函数，`lib/rules/rules.js:1985-2009` 的 `matchExcludeFilters` 在请求到来时执行判定。参见[规则引擎：解析与匹配](/modules/rules-engine)。
2. **规则解析 · 阶段组装**：`lib/rules/rules.js:2239-2299` 的 `resolveRules` 按 `isReq` 与 `isRes` 挑选协议表，把命中结果写入 `req.rules`，请求期与响应期各取一份。参见[指令体系与分发链路](/modules/protocol-catalog)。
3. **应用点 · 延迟与限速**：`lib/inspectors/data.js:544` 取 `reqDelay` 挂定时器，`lib/inspectors/res.js:1162` 取 `resDelay`；`lib/inspectors/req.js:520-524` 与 `lib/inspectors/res.js:910-914` 把速度值写到 `data.speed`。参见[一次 HTTP 代理请求的旅程](/core/http-request)。
4. **应用点 · 状态码短路**：`lib/util/index.js:3576-3599` 的 `getStatusCodeFromRule` 在请求尚未发出时返回构造好的响应，`statusCode` 因此不产生回源流量。参见[一次 HTTP 代理请求的旅程](/core/http-request)。
5. **回写 · 响应期改写**：`lib/inspectors/res.js:819-825` 用 `replaceStatus` 改写状态码，`lib/inspectors/res.js:870-891` 按 `cache` 值重写 `cache-control` 与 `expires`。参见[抓包数据的采集与上报](/core/capture-data)。
6. **上报 · 界面中断**：`biz/webui/cgi-bin/abort.js:6-22` 接收前端指令，经 `lib/util/data-server.js:642` 的 `abortRequest` 下发，最终由 `lib/socket-mgr.js:859` 导出的 `abort` 销毁连接并清理连接表。参见[Web 管理界面](/modules/webui)。

## 边界与坑

- 限速只作用于有 body 的流量：`reqSpeed` 对 `CONNECT`、`UPGRADE` 及 204 等无响应体的请求无效（`docs/docs/rules/reqSpeed.md`）；`resSpeed` 对 `GET`、`HEAD`、`CONNECT`、`UPGRADE` 等无请求体的请求无效（`docs/docs/rules/resSpeed.md`）。
- `statusCode` 默认返回空响应体，需要正文必须叠加 `resBody`；返回 401 时浏览器默认弹出认证框，应加 `disable://userLogin`（`docs/docs/rules/statusCode.md`）。
- `chance` 是按 `Math.random()` 与概率值比较命中的概率过滤器，取值 0 至 1，不是定时器，也不会随时间累积命中（`docs/docs/rules/filters.md`）。
- 默认对单个请求 36 秒内无数据传输即判定超时，`disable://timeout` 可关闭该判定（`docs/docs/rules/disable.md`）。
- 对 204、304 等无响应体的状态码，`resBody` 一类 body 改写不生效（`docs/docs/rules/resBody.md`）。

## 小结

- 弱网注入的核心不是「更慢」，而是把不可控的网络条件转成可重复的规则文本。
- 延迟、限速、状态码、缓存分别落在请求期、响应期与回写期，选错阶段就得不到预期结果。
- 过滤器在解析期编译、请求期判定，是概率规则能低成本复用的前提。
- 超时兜底与界面主动中断共同保证挂起连接不会无限占用抓包内存。
- 概率过滤器与随机脚本负责覆盖时序，确定性规则负责回归复现，两者互补而非替代。

## 下一步

[《HTTPS、证书与鉴权的排障现场》](/scenarios/https-trust)：当注入规则遇到 HTTPS 隧道，先要看懂解密判定与证书信任，才能确定规则是否真正作用到了明文请求。
