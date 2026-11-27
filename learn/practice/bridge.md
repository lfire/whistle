---
title: 迁移关 · 从练习靶子到真实项目
description: 把靶子上练熟的能力换到真实域名、本地服务与 HTTPS 站点，列清必改项、起步命令、验收与官方文档的查法。
---

# 迁移关 · 从练习靶子到真实项目

::: tip 先修知识
已完成 [L1–L4](/practice/index)，能看全请求、精确改写、造现场、接 HTTPS 与多客户端。本关不教新指令，只做一件事：把 `practice.test` 换成真实工作里的目标，并确认能力没有留在练习环境里。
:::

## 本关目标

独立完成三种真实接入，并说清「从靶子迁移过来时，哪些行必须改、哪些不用改、最容易漏哪一处」。做完你能把前面五关的任何一套规则，迁移到自己项目里的域名。

## 开始前

1. `w2 start` 在跑、`练习靶子` 基线可用。
2. 另开两个终端窗口备用（本关要用系统自带的 `python3 -m http.server` 起本机服务，不需要装任何东西、不需要后端框架）。
3. 本关的 `www.example.com` 只是**写进规则里的目标域名**，我们会用规则把它改道到本机服务，所以它是否真的可达并不影响练习。

## 必改项清单（换域名前先读）

从 `practice.test` 迁到自己的项目时：

| 项目 | 要不要改 | 说明 |
|---|---|---|
| 规则里的 pattern | **必须改** | 换成真实域名/路径；继续用 `$` 前缀做路径精确匹配，避免误伤子路径 |
| `file://{key}` 引用的 Values | 通常不用改 | 内容与域名无关；只有内容本身要变时才改 |
| `reqHeaders` / `statusCode` / `reqDelay` 等操作 | 不用改 | 它们不依赖目标域名 |
| 过滤器里的 `reqH.*` / `m:*` | 按需求改 | 真实客户端的请求头与练习里造的不一样 |
| 证书与 Enable HTTPS | 首次接 HTTPS 目标要检查 | 按 [第 0 站](/guide/quickstart) 第 4 步确认信任与开关 |
| 规则组的 ON / 收尾 | **最容易漏** | 真实项目里忘关规则，会把同事的流量一起改掉 |

**最容易漏的一处**：`practice.test/api` 不加 `$` 会按路径前缀连 `/api/user` 一起命中。真实域名下子路径更多，漏了 `$` 的后果比练习里严重得多。

## 任务

### 第 1 步 · 线上域名 + 本地 dev server（对应 19 本地联调）

1. 起两个本机服务，分别模拟「前端页面」与「接口」：

```sh
# 终端 A：模拟前端 dev server
python3 -m http.server 5173
# 终端 B：模拟接口服务
python3 -m http.server 5174
```

2. 新建一组规则，命名 `真实联调`，写：

```txt
www.example.com http://127.0.0.1:5173 excludeFilter://*/api
www.example.com/api http://127.0.0.1:5174
```

3. 用代理发两发：

```sh
curl -s -i -x 127.0.0.1:8899 http://www.example.com/
curl -s -i -x 127.0.0.1:8899 http://www.example.com/api/users
```

**该看到**：两条响应分别来自 5173 与 5174 两个目录列表页面，而不是 `example.com` 的内容；Network 里能看到请求被改道到了哪个地址。

> 这就是 [19《本地联调与环境切换》](/scenarios/local-env) 里那几行占位配置的**可直接运行版本**：把占位域名换成 `www.example.com`，把「本地 dev server / 测试机」换成两个本机端口。真实项目里把 `127.0.0.1:5174` 换成你的测试机 IP 即可，其余一行都不用动。

### 第 2 步 · 只 Mock 一个接口，其余照常回源（对应 20 契约先行）

把上一组规则改成三行，让**每一条路径都有真实可达的成功响应**：

```txt
$www.example.com/api/user file://{user.json} resType://json
www.example.com/api http://127.0.0.1:5174
www.example.com http://127.0.0.1:5173 excludeFilter://*/api
```

发三条，三条都应成功：

```sh
curl -s -i -x 127.0.0.1:8899 http://www.example.com/api/user   # 拿到 Values 里的固定 JSON
curl -s -i -x 127.0.0.1:8899 http://www.example.com/api/order  # 落到 5174 的目录列表
curl -s -i -x 127.0.0.1:8899 http://www.example.com/           # 落到 5173 的目录列表
```

**这是本关最重要的一条证据**：规则成功作用在真实可达的本机服务上，三个接口各有各的结果，没有一条依赖「域名不存在导致的失败」。`/api/user` 走 Mock 短路、`/api/order` 走接口服务、`/` 走前端服务，正是真实联调里「Mock 一部分、回源一部分」的样子。

**这一步要理解的是**：Mock 只短路被精确匹配的那一个接口，其它请求仍按原来的路径走到对应服务。真实项目里后端就绪后，只要把第一行删掉，`/api/user` 就会落到 5174 那个服务，业务代码零改动。

### 第 3 步 · 真实 HTTPS 站点（对应 23 证书排障）

确认 [第 0 站](/guide/quickstart) 第 4 步的证书信任与 Enable HTTPS 都可用后：

```sh
curl -s -i -x 127.0.0.1:8899 https://example.com
```

在 Network 里点开，应能看到明文请求头与响应体；关掉 Enable HTTPS 再发一次，应变成 `Tunnel to`。给其中一个域名写 `域名 disable://capture`，确认它退回透传。

> 若你的环境没有外网，用 `https://practice.test/api` 配合 [L4](/practice/l4-extend) 第 1 步代替；要练的判据是「能不能看明文、为什么不能、什么时候该放行」，不是必须访问某个特定站点。证书固定 / mTLS 的目标一律放行不解密（[27](/scenarios/boundaries)）。

### 第 4 步 · 什么时候查官方文档

本仓库 `docs/` 是官方使用文档，完整参数与界面说明在那里；本套教程只讲机制与练法。触发条件很具体：

| 遇到什么 | 去哪查 |
|---|---|
| 忘了某条指令的完整参数、别名、可选值 | 官方 `docs/docs/rules/` 对应协议页，或 `https://wproxy.org/docs/` |
| 界面按钮找不到、快捷键不清楚 | 官方 `docs/docs/gui/`（network / rules / values / composer / https） |
| 命令参数、启动选项记不全 | 官方 `docs/docs/cli.md`、`w2 help` |
| 出现没见过的报错（如 `captureError`） | 官方 `docs/docs/faq.md` |
| 想知道「为什么会这样」、源码在哪一行 | 本站 01–41 |

**一次实操**：打开官方 `docs/docs/rules/reqDelay.md`，找到「延迟后 abort」那一节，把示例 `www.example.com/path2 reqDelay://5000 enable://abort` 抄进你的练习规则（换成靶子路径）并跑一次。再打开 `docs/docs/rules/filters.md`，确认 `chance` 的取值范围是 0–1。这两处都是本站没有逐条展开的参数细节，以后遇到新指令都用这个动作补齐。

## 验收

**该看到**：三种接入各留下一条证据（终端输出或 Network 截图）；能说出换域名时至少 4 个必改/不必改项；能演示「关掉 Mock 后 `/api/user` 回源」；能在官方文档里找到并实际跑通一个本站没写过的参数组合（`reqDelay` + `enable://abort`）。

**不该看到**：改了域名却忘了加 `$` 导致子路径被误伤；Mock 关掉后仍返回固定 JSON（说明还有别的规则在命中）；把 `host://` 指回 Whistle 自己的端口造成自环。

## 变式

1. **整套换域名**：把本关所有规则里的 `www.example.com` 换成你自选的一个域名/路径，用 `curl` 逐条验证哪些行必须跟着改。
2. **换端口**：把 5173 / 5174 换成别的端口，确认只有规则里那两处要改。
3. **故意漏 `$`**：把 `$www.example.com/api/user` 的 `$` 去掉，发 `/api/user/extra`，观察误伤，再加回来。

## 没看到预期？按顺序查

1. 两个 `python3 -m http.server` 是否真的在跑（终端有没有输出、端口有没有被占用）。
2. 规则的 ON / Save / 当前规则组。
3. pattern 是否精确（`$`）、`excludeFilter` 是否把目标排除了。
4. HTTPS 三步：根证书信任、Enable HTTPS、是否被 `disable://capture` 放行。
5. 官方 `faq.md` 里的 `Tunnel to` / `captureError` 条目。

## 收尾

停掉两个 http.server（终端 `Ctrl+C`），关掉 `真实联调` 规则组的 ON，确认 `练习靶子` 也关着。真实项目里这一步尤其重要：**改道到本机的规则如果忘了关，第二天整个团队都会访问到你的机器**。

## 背后的机制

- 改道为什么只改「派送单」、不动代码与 DNS：[19《本地联调与环境切换》](/scenarios/local-env)。
- `file://` 短路与回源的边界：[20《接口未就绪：Mock 与契约先行》](/scenarios/mock-contract)。
- HTTPS 解密的三层前提与放行：[23《HTTPS、证书与鉴权排障》](/scenarios/https-trust)、[10《CONNECT 判定与 TLS 解密》](/core/connect-mitm)。
- pattern 精确匹配与过滤器：官方 `docs/docs/rules/pattern.md`、`filters.md`。

## 晋级标准

不看本页，能把 [L2](/practice/l2-rewrite) 或 [L3](/practice/l3-simulate) 里任意一套规则迁到一个真实/自选域名上，用证据证明生效且没误伤，并说清必改项与清场动作。做到就进 [L5 排得清](/practice/l5-diagnose)——排障判断必须建立在真实接入的经验上。

## 下一步

[L5 排障](/practice/l5-diagnose)：把六步法用到没见过的现象上，并判断什么时候不该用 Whistle。
