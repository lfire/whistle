---
title: L1 看得见 · 把一次请求看全并留下证据
description: 用自造靶子练发请求、读懂 Network 各面板、过滤与保存证据，并判断请求到底有没有出网。
---

# L1 看得见 · 把一次请求看全并留下证据

::: tip 先修知识
已完成 [第 0 站](/guide/quickstart) 与 [自造靶子](/practice/target)，`练习靶子` 规则组能随时打开。本关不需要后端、不需要 HTTPS 解密，全部用 `http://practice.test` 完成。
:::

## 本关目标

给你任意一个请求，你能让它在 Network 里出现、点开说清「客户端发了什么、代理做了什么、最后返回了什么」、把证据保存下来，并判断**这次请求有没有真的出网**。这是所有排障与改写的地基：看不清就没法改。

## 开始前

1. `w2 start` 在跑，界面 `http://local.whistlejs.com` 能打开。
2. 打开 `练习靶子` 规则组的 **ON**。
3. 终端备用一行命令：`curl -s -i -x 127.0.0.1:8899 http://practice.test/api`。
4. **Composer** 的打开方式与 **Global Rules**（旧版标作 Whistle）开关已在 [自造靶子](/practice/target) 第 3 步教过；本关第 1 步会再用到它，若记不清先回看那一节。

## 任务

### 第 1 步 · 造三条不同来源的请求

依次执行（两条都是本机靶子请求，第三条用界面版；全程不需要任何外部站点）：

```sh
curl -s -i -x 127.0.0.1:8899 http://practice.test/api
curl -s -i -x 127.0.0.1:8899 "http://practice.test/api?from=ping"
```

再到 **Composer**，URL 填 `http://practice.test/api`，**Global Rules**（旧版标作 **Whistle**）开关保持开启，点发送。这样列表里会有两条规则造出的请求和一条 Composer 构造的请求。

### 第 2 步 · 把一条请求点开看全

在 Network 里点开 `practice.test/api`，逐个看：

| 面板 | 你要能回答 |
|---|---|
| Overview / General | 请求方法、完整 URL、状态码、耗时各是多少 |
| Request Headers | 客户端实际发出去哪些头；`Host` 是什么 |
| Response Headers | 响应头里有没有你没写的字段；`Content-Length` 与 body 长度是否对得上 |
| Response | 内容是不是规则里那段 JSON |
| Timeline | 时间花在哪一段；被规则短路的请求通常没有真实的出站连接耗时 |

### 第 3 步 · 用搜索框把目标筛出来

在 Network 底部搜索框依次试（前缀用法来自官方 `docs/docs/gui/network.md`）：

```txt
practice.test
m:POST
s:200
fc:
```

`fc:` 只筛 Composer 发出的请求——这是把「我造的流量」与「真实流量」分开的关键，后面重放与排障都会用到。

### 第 4 步 · 留证据

右键这条请求 → **Save** 保存会话；再用 **Export** 导出（`.saz` / `.txt` / `.json`），接着用 **Import** 把文件导回来，确认列表里出现同一条请求。这三个动作要连起来练：[L3](/practice/l3-simulate) 与[通关项目](/practice/final-project) 都要靠它们把偶发现场固定并反复重放。

### 第 5 步 · 判断有没有出网

把 `练习靶子` 的 **ON 关掉**，再发一次同样的 `curl`。这次应失败（域名根本不存在）。对比两次结果，你就有了判断「响应是谁给的」的方法：**规则开着有响应、关掉就失败 = 请求从未出网**。

## 验收

**该看到**：三条请求都在 Network 里；点开能看到完整的请求头、响应头、响应体；`fc:` 能单独筛出 Composer 那条；关掉 ON 后同一命令失败。

**不该看到**：`Tunnel to`（本关全用 http）、`captureError`（没开 HTTPS 解密）、以及任何「明明关了规则却还返回固定 JSON」的情况（那说明规则组没关对，或另有规则在生效）。

## 变式

1. **换方法**：`curl -X POST -s -i -x 127.0.0.1:8899 http://practice.test/api`，看 Overview 里方法是否变成 POST、规则是否仍命中。
2. **带查询参数**：改成 `curl -s -i -x 127.0.0.1:8899 "http://practice.test/api?v=2"`，确认 `$` 精确匹配仍命中（路径精确、查询参数任意）。改状态码的玩法留到 [L2](/practice/l2-rewrite) 详讲。
3. **故意发错端口**：把 `-x` 的端口改成一个没在跑的端口，观察失败现象，记住「工具没起来」长什么样。

## 没看到预期？按顺序查

1. Network 空白 → `curl` 的 `-x` 端口与 `w2 status` 是否一致；界面是否连到了另一个实例。
2. 有请求但内容不对 → ON 是否开着、是否 Save、当前选中的规则组是不是 `练习靶子`。
3. Composer 那条没出现 → **Whistle** 开关是否开启；用 `fc:` 过滤确认。
4. 搜索框筛不出 → 前缀是否写对（无前缀按 URL、`m:` 按方法、`s:` 按状态码、`fc:` 按 Composer）。
5. 关掉 ON 仍返回 JSON → 检查是否还有别的规则组在命中，或浏览器/命令行缓存。

## 收尾

关掉 `练习靶子` 的 ON；把本关临时改过的规则文本恢复成基线（本关没有新增规则，只需确认基线没被改坏）。导出的证据文件留着，[L3](/practice/l3-simulate) 会用它。

## 背后的机制

- 抓包为什么是旁路、界面为什么靠短轮询刷新：[12《抓包数据的采集与上报》](/core/capture-data)、[36《抓包数据面与帧》](/concepts/05-capture)。
- 规则为什么能短路转发、请求为什么不出网：[20《Mock 与契约先行》](/scenarios/mock-contract)、[09《一次 HTTP 代理请求的旅程》](/core/http-request)。
- Network 搜索前缀的完整清单：[速查表](/advanced/reference)。

## 晋级标准

不看本页，能独立完成：发出请求 → 在 Network 点开说清请求头/响应头/响应体 → 用至少两种前缀筛出目标 → 用「关 ON 反证」判断有没有出网 → Save / Export / Import 完整走一遍。做到就进 [L2 改得动](/practice/l2-rewrite)。

## 下一步

[L2 改写](/practice/l2-rewrite)：从「看得见」到「改得动」，并按目标精确限定，确认没有误伤别的请求。
