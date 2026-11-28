---
title: A4 管得住 · 多人共用的规则集方案
description: 用本机两份规则集模拟团队协作，验证分组、冲突时的生效顺序与改错后的回滚。
---

# A4 管得住 · 多人共用的规则集方案

::: tip 先修知识
已完成 [A3 内嵌集成](/practice/a3-embed)，会用 Rules 的 Create / Save / ON、`@` 本地规则文件、`.whistle.js` + `w2 add`（[L4](/practice/l4-extend) 第 5 步）。本关用一台机器的两份规则集模拟两个人，不需要团队或服务器。
:::

## 本关目标

设计一套多人共用的规则集方案，说清「谁改哪一层、冲突时谁生效、改错怎么回滚」，并用可观察证据验证这三条。做完你能对一套共享规则负责，而不只是会写自己的那几行。

## 开始前

1. `w2 start` 在跑、`练习靶子` 基线可用。
2. 新建目录 `~/whistle-practice/collab/`，本关所有工件放这里。
3. 记住三条既有事实：默认每协议首条命中即返回、行序即优先级（[L2](/practice/l2-rewrite)）；任一来源变化都会全量重编译（[25](/scenarios/collab-config)）；界面靠轮询感知变化、不是推送。
4. **Rules 默认不支持多选**：先在 Rules 面板勾选 `Allow multi-select`（[25](/scenarios/collab-config) 第 89 行），否则「两组都选中」这一步做不了。
5. 本关会用到三个终端命令，先记住：`cp a a.bak` 备份、`cp a.bak a` 恢复、`diff -u old new > diff.txt` 生成差异；不需要额外安装工具。

## 任务

### 第 1 步 · 建两层规则集（模拟两个人）

`team-base.txt`（团队公共层，只放稳定规则）：

```txt
$practice.test/api file://({"status":"base"})
practice.test/other file://({"status":"other"})
```

`my-override.txt`（个人覆盖层，只放本次调试）：

```txt
$practice.test/api reqHeaders://x-who=me
```

在 Rules 里 **Create** 两组并分别 Import / 粘贴，命名 `团队基线` 与 `我的覆盖`；`w2 add` 或 `@` 的用法见 [L4 第 5 步](/practice/l4-extend)。

### 第 2 步 · 验证「谁生效」

发一发：

```sh
curl -s -i -x 127.0.0.1:8899 http://practice.test/api
curl -s -i -x 127.0.0.1:8899 http://practice.test/other
```

记录：响应来自哪一层、请求头里有没有 `x-who`。**只选中一组**与**勾选 `Allow multi-select` 后两组都选中**各做一次，把差异写下来——这就是多人协作里最常见的「我明明写了却不生效」。

### 第 3 步 · 制造冲突并给出规则

在 `my-override.txt` 里加一行**同协议同 pattern**的规则：

```txt
$practice.test/api file://({"status":"mine"})
```

两组都选中，再发一次。应该只有一个 `file://` 生效（首条命中即返回，行序/选中顺序决定）。把「哪一行生效、为什么」写成结论；再给**个人覆盖层那一行**（`$practice.test/api file://({"status":"mine"})` 末尾）加 `lineProps://important`，重新 Save 再发，看结果是否反转——`important` 只影响同一协议桶内的行序，加在别的协议行上不会改变这个冲突的结果。

### 第 4 步 · 回滚

1. 先把两份文件各存一份 `*.bak`：`cp team-base.txt team-base.txt.bak`、`cp my-override.txt my-override.txt.bak`。
2. **在界面 Rules 里改坏**（不是只改本地文件）：把 `团队基线` 那组第一行的 `$` 删掉，Save，发 `curl -s -i -x 127.0.0.1:8899 http://practice.test/api/user` 记录误伤现象——不带 `$` 时 `/api` 会按前缀连子路径一起命中（[L2](/practice/l2-rewrite) 第 3 步）。
3. **恢复也要作用在界面**：把 `team-base.txt.bak` 的内容重新贴回 `团队基线` 组并 Save（若该组是用 `w2 add` 导入的，就重新执行一次 `w2 add`），等一个刷新周期，再发同一条 curl 确认恢复。**只 `cp` 本地文件不会影响运行态**——界面里的规则是 Import 进来的副本，这是本关最容易做错的一步。
4. 生成差异工件：`diff -u team-base.txt.bak team-base.txt > diff.txt`（若两者内容相同，diff.txt 为空也正常，说明已回滚到基线）。

**记录**：改坏了什么现象、恢复用了哪一步、多久被界面感知。

### 第 5 步 · 写方案并产出工件

`a4-collab/` 目录：① 两份规则集 + 两份 `.bak` + `diff.txt`；② 第 2–4 步的 curl 输出；③ 冲突结论与 `important` 反转证据；④ 回滚记录（含界面恢复步骤）；⑤ 一页方案说明（三层分工：公共层 / 个人层 / 临时层；命名约定；评审与回滚流程；为什么变更要全量重编译）。

## 验收（工件可复核）

**该看到**：勾了 `Allow multi-select` 后两层能同时选中；单选/多选结果有明确差异；同协议冲突只有一行生效且给覆盖层加 `important` 能反转；改坏必须作用在界面、恢复也必须作用在界面且现象可逆；`diff.txt` 与五件工件齐全。

**不该看到**：只写方案却没有 curl 证据；把回滚写成「重新写一遍」而不是「从可恢复的副本恢复」；忽略界面轮询导致的「以为没生效」。

## 变式

1. **加第三个人**：再建 `qa-override.txt`，设计三层优先级并验证。
2. **远程来源**：把公共层改成 `@` 指向本地文件，改文件后测刷新周期。
3. **命名冲突**：两组用同一个名字，观察界面如何区分，写进方案的命名约定。

## 没看到预期？按顺序查

1. 规则集没更新 → 界面是轮询（本地约 5 秒、远程 10–30 秒），等一个周期；`w2 add` 要重新执行。
2. 冲突结果不符 → 检查当前选中了哪几组、行序、`lineProps://important`。
3. 回滚没生效 → 是否只在本地 `cp` 了文件、却没把内容贴回界面并 Save；`@` 来源是否等过刷新周期。
4. 误伤子路径 → 是否漏了 `$` 精确匹配。

## 收尾

关掉 `我的覆盖` 与 `团队基线` 的 ON，把临时规则删掉；保留工件目录。

## 隔日复核

第二天只看工件里的方案与 `.bak`，重新搭一次两层规则集并复现冲突与回滚，记录卡住的一步。

## 背后的机制

- 规则来源、`@`、全量重编译、修改戳与轮询：[25 团队协作](/scenarios/collab-config)、[13 规则引擎](/modules/rules-engine)。
- 首条命中、行序与 `important`：[L2 改得动](/practice/l2-rewrite)。
- 多实例隔离：[08 进程模型与配置系统](/architecture/process-config)。

## 晋级标准

不看教程，给定一个「3 人、公共规则 + 个人覆盖 + 临时演练」的需求，能独立写出分层方案、用 curl 证明优先级、并演示一次可恢复的回滚，产出可复现工件。做到就进 [A5 性能、合规与讲解](/practice/a5-perf-compliance)。

## 下一步

[A5 性能、合规与讲解](/practice/a5-perf-compliance)：量化代理开销、给出合规结论，并把机制讲给一个会追问的人。
