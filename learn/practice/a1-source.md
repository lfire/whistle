---
title: A1 读得懂 · 带现象钻源码并验证理解
description: 从「同一路径两行规则谁生效」出发定位 parseText 与求值时机，用断点与规则实验验证预测。
---

# A1 读得懂 · 带现象钻源码并验证理解

::: tip 先修知识
已完成[综合通关项目](/practice/final-project)，会写规则并用 Network 验证命中。本关需要 `node -v` 可用、会用 `grep` 在仓库里找符号、能打开 Chrome DevTools。不需要改任何源码。
:::

## 本关目标

带着一个具体现象钻进源码，定位到负责它的函数，**先写下预测，再用一个可运行实验验证**。做完你能回答「这行规则在编译期变成什么、在请求期哪一步被求值」，而不是只记住结论。

## 开始前

1. 仓库已 clone 在本地，`lib/` 目录可读。
2. 关闭后台实例（`w2 stop`），本关用前台 `w2 run --inspect` 便于下断点。
3. 准备 Chrome，地址栏能打开 `chrome://inspect`。
4. 现象来自 [L2 第 5 步](/practice/l2-rewrite)：**同一路径写两行同协议规则，只有第一行生效**。

## 任务

### 第 1 步 · 先写预测（不要先看答案）

在笔记里回答三问，写清楚你的猜测：

1. 一行文本 `pattern operation` 在启动时被变成什么数据结构？
2. Values 引用 `{key}` 是在启动时求值，还是请求到来时才求值？
3. 两行同 pattern 只生效一行，是「编译期丢掉一行」还是「请求期只取第一条」？

### 第 2 步 · 用符号定位源码

```sh
cd /Users/你的用户名/Documents/benji/github/whistle   # 换成你的仓库路径
grep -n "parseText\|resolveValue\|getRuleList\|multiMatchs" lib/rules/rules.js | head -20
```

记下命中行号。重点读两段：

- `lib/rules/rules.js:1745-1806` 的 `parseText`：把文本切成行、去掉注释、拆成 `pattern operation`，按协议分桶。
- `lib/rules/rules.js:811-852` 的 `resolveValue`：命中后才把 `{key}` / 内联值求值成 `value` / `path` / `files`。

对照 [13《规则引擎：解析与匹配》](/modules/rules-engine) 与 [37《规则 DSL 全景》](/concepts/06-rules) 的讲解，检查你的预测。

### 第 3 步 · 用断点看到它真的发生

```sh
w2 run --inspect
```

另开 Chrome 访问 `chrome://inspect` → 找到对应的 Node 目标 → **inspect**。在 `lib/rules/rules.js` 的 `parseText` 与 `resolveValue` 各下一个断点。[29 阅读路线](/advanced/source-reading) 给的是通用断点清单与前台调试方法；这两个断点是本关按 `grep` 找到的函数自己加的，不在那份清单里。

**第一次连 Node 调试器的完整步骤**（前几关没用过，这里一次给全）：
1. Chrome 地址栏打开 `chrome://inspect`，切到 **Devices** 或页面里的 **Remote Target** 列表。
2. 保持 `w2 run --inspect` 在前台运行，列表里会出现一个 Node 目标，点它下面的 **inspect**。
3. 在弹出的 DevTools 里按 `Ctrl+P` / `Cmd+P`，输入 `rules.js` 打开源码文件。
4. 用 `Ctrl+F` 搜 `parseText` 与 `resolveValue`，**在函数体第一行**（`function parseText(...)` 的下一行）点行号下断点；打在定义行也能停，但那时参数还没进 Scope。若改规则时没停，用 `grep -n "parseText(" lib/rules/rules.js` 找调用点改打调用行。
5. 回到终端发请求，DevTools 会停在断点上；在右侧 **Scope** 里看 `line` / `rule` 变量，把值记下来。

然后：

```sh
# 在 Rules 里改一行规则并 Save，观察 parseText 断点
curl -s -i -x 127.0.0.1:8899 http://practice.test/api   # 观察 resolveValue 断点
```

**记录**：改规则时哪个断点先命中？发请求时哪个断点命中？`line` / `rule` 变量长什么样？这决定了「编译期」与「请求期」的分界。

### 第 4 步 · 用规则实验验证预测

写两行同 pattern：

```txt
$practice.test/api reqHeaders://x-first=1
$practice.test/api reqHeaders://x-second=2
```

发一发，看请求头里是 `x-first` 还是 `x-second`；再把第二行加上 `lineProps://important`，重新 Save 再发一次（[L2 第 5 步](/practice/l2-rewrite#第-5-步--练规则顺序)）。把「预测 → 实际」写成两行对照。

### 第 5 步 · 产出工件

整理 `a1-source/` 工件目录，**必须包含原始输出，不能只写手写结论**：① `grep.txt`（`grep -n ...` 的完整输出）；② 两段源码片段（带文件名与行号）；③ `devtools.txt`（断点命中顺序、Scope 里 `line` / `rule` 的实际值；有截图更好）；④ `curl.txt`（两行规则改前/改后的 `curl -i` 输出）；⑤ `prediction.md`（三问预测 vs 实际逐条对照 + 一句话结论「因为 X，所以在 Y 层做 Z」）。

## 验收（工件可复核）

**该看到**：`grep.txt` 有命中行号；`devtools.txt` 记录了改规则时 `parseText` 命中、发请求时 `resolveValue` 命中，并写明变量值；`curl.txt` 证明两行规则只有第一行生效、加 `important` 后换一行；`prediction.md` 的预测与实际逐条对得上。五份原始输出齐全，别人能按着复现。

**不该看到**：只贴一段源码却说不出它对应哪个现象；断点没命中就凭文档下结论；预测与实际不符却不修正预测。

## 变式

1. **换成 Values**：把规则改成 `file://{mock.json}`，在 `resolveValue` 断点里确认 `{key}` 是在请求期才展开。
2. **换协议**：把 `reqHeaders` 换成 `statusCode`，观察短路发生在哪一步、后续断点是否还命中。
3. **故意改错**：写一行 `pattern` 后面没有 operation，看 `parseText` 是报错还是静默忽略。

## 没看到预期？按顺序查

1. `chrome://inspect` 找不到目标 → 确认用的是 `w2 run --inspect`（`w2 start` 不支持 `--inspect`，见 [29](/advanced/source-reading)）。
2. 断点不命中 → 断点是否打在真正执行的分支；`w2 run` 是否重新加载了规则。
3. 两行都生效 → 检查是不是写了两个不同协议（不同协议可叠加，[L2 第 6 步](/practice/l2-rewrite)）。
4. `grep` 行号对不上 → 用函数名当锚点，不要用行号（[01 导览](/guide/orientation) 说过基线）。

## 收尾

停掉前台实例（`Ctrl+C`），关掉断点，把规则恢复成基线，删掉临时两行规则。

## 隔日复核

把 `a1-source/` 放一天，第二天**只看工件**（不看教程），按下面命令重新完成：`w2 run --inspect` → `chrome://inspect` 连目标 → 在 `parseText` / `resolveValue` 下断点 → 写两行同 pattern 规则 → 发 `curl -s -i -x 127.0.0.1:8899 http://practice.test/api` → 预测并验证。记下哪一步卡住、怎么解决；把第二天新产生的 `curl -i` 输出与断点记录另存为 `day2-*`，与首日工件并排，用来对比是不是一次跑通。

## 背后的机制

- 编译期结构化与请求期求值：[13](/modules/rules-engine)、[37](/concepts/06-rules)。
- 断点清单与前台调试：[29 源码阅读与调试路线](/advanced/source-reading)。
- 16 步请求链路：[09](/core/http-request)；28 步贯通：[40](/concepts/09-walkthrough)。

## 晋级标准

不看教程，能拿一个**新的**现象（例如「为什么 `{key}` 改了内容不用改规则」）自己走完「定位函数 → 下断点 → 预测 → 实验验证」，并产出一份别人能按着复现的笔记。做到就进 [A2 写插件](/practice/a2-plugin)。

## 下一步

[A2 写插件](/practice/a2-plugin)：从「读懂」到「改得动」，写一个最小插件并让它在请求链路上产生可观察效果。
