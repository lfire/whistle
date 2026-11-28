---
title: 自造靶子 · 不用后端也能练
description: 用 Whistle 自己造出一个不存在的域名与固定响应，作为全部训练关共用的可运行环境。
---

# 自造靶子 · 不用后端也能练

学抓包最容易卡住的地方，不是规则难写，而是**手边没有一个能稳定产生请求的目标**：教程里的 `www.example.com`、测试机 IP、本地 dev server、真机、团队共享 URL，零基础者一样都没有。本关先把这个地基补上——用 Whistle 自己造一个靶子，之后 L1–L5 和通关项目全部基于它，不依赖任何后端、手机、团队或联网条件。

::: tip 先修知识
已完成 [第 0 站 · 第一次跑通](/guide/quickstart)：`w2 start` 在跑、界面能打开、Rules 会 Create / Save / ON。只需要再会一行 `curl` 命令；不会用命令行也没关系，本关给了 Composer 的等价做法。
:::

## 本关目标

做出一个**随时可命中、随时可改写、不出网**的练习请求：访问一个根本不存在的域名，Whistle 直接返回你写的固定响应，并在 Network 里留下完整记录。做完你就拥有了一个可以反复折腾、绝不会把真实服务搞坏的练习环境。

## 为什么这样可行

`file://(...)` 这类规则会在请求转发出去之前短路：代理直接构造响应返回，请求根本不访问目标主机（机制见 [20《接口未就绪：Mock 与契约先行》](/scenarios/mock-contract)）。所以域名存在与否完全无所谓——正因为 `practice.test` 不存在，才能反过来证明「响应确实是我用规则造出来的，不是某个后端发的」。

## 任务

## 开始前

1. `w2 start` 在跑，`w2 status` 显示 `is running`；界面 `http://local.whistlejs.com` 能打开。
2. 已通过 [第 0 站](/guide/quickstart) 的 11 项通关自检，会在 **Rules** 里 Create / Save / 切换 ON。
3. 准备一个空规则组（新建并命名 `练习靶子`），本页所有规则都写在这一组里，方便整组开关与清场。

### 第 1 步 · 写一条自造响应的规则

打开 **Rules** → **Create** 新建一组规则，命名 `练习靶子`，粘贴并在末尾留一个空行：

```txt
$practice.test/api file://({"status":"ok","from":"whistle"})
```

点 **Save**，确认 **ON** 为开启（红色）。

> 行首的 `$` 是官方 `docs/docs/rules/pattern.md` 的**路径精确匹配**前缀：`$practice.test/api` 只命中 `/api`，不会连 `/api/user` 一起命中。L3、[迁移关](/practice/bridge) 与[通关项目](/practice/final-project) 都依赖这一点，先记住「不写 `$` 就会按路径前缀误伤子路径」即可。

> 内联值必须用英文括号 `()` 包裹，且内容里不能有空格或换行：括号是在告诉解析器「这是要直接返回的内容，不是文件路径」，少了它就会被当路径去找文件，结果就是 404（官方 `docs/docs/rules/file.md`）。站内可直接照本页第 1 步的代码块抄，不必跳出去查。想写带空格的内容，改用 [Values](/concepts/06-rules) 建 key 再写 `file://{key}`，[第 0 站](/guide/quickstart#再进一步用-values-返回固定-json) 演示过。

### 第 2 步 · 用一行命令发出请求

终端执行（`8899` 换成你实际的端口）：

```sh
curl -s -i -x 127.0.0.1:8899 http://practice.test/api
```

`-x` 表示「把这一发请求交给指定代理」，`-i` 让响应头也打印出来。即使系统代理没开，这一发也一定会经过 Whistle。

### 第 3 步 · 在界面上看到它

回到 **Network**，搜索框输入 `practice.test`，应能看到刚才那条请求；点开看 **Response**，内容应是你写的那段 JSON。

想省掉命令行，也可以用界面版：打开 **Composer**（Network 里右键请求 → Edit，或顶部入口），URL 填 `http://practice.test/api`，确认 **Global Rules**（旧版界面标作 **Whistle**）开关是开启状态，它决定本次构造的请求是否套用界面里配置的规则，点发送。Composer 发出的请求会带 `fc:` 标记，在搜索框输入 `fc:` 可以单独筛出来。

## 验收

**该看到**：

1. 终端输出 `200`（或 `HTTP/1.1 200`）以及 `{"status":"ok","from":"whistle"}`。
2. Network 里出现 `practice.test/api`，Response 面板里是同一段 JSON。
3. 请求详情里能看到这是经代理处理的记录，而不是一条 `Tunnel to`。

**不该看到**：

- 404 / 502 / `captureError`——出现就说明规则没命中或被当成了文件路径。
- 任何真实网络请求：把 ON 关掉再发一次，`practice.test` 无法解析，会直接失败。这个反证恰好说明第 1 步的响应是规则造的。

## 变式

1. **改内容**：把规则里的 JSON 改成 `{"status":"changed"}`，Save，再发一次——响应应立刻跟着变，不需要重启任何东西。
2. **加路径**：追加一行 `$practice.test/ping file://(pong)`，分别请求两个路径，确认各自返回自己的内容。
3. **只换方法**：把请求改成 `curl -X POST ...`，观察同一条规则是否仍命中（默认按 URL 匹配，与方法的限定方式见 L2）。
4. **故意写坏**：去掉括号写成 `file://hello`，Save 再发，应看到 404；把括号加回来恢复。记住这个报错长什么样，后面能省很多时间。

## 没看到预期？按顺序查

| 现象 | 最可能的原因 | 处理 |
|---|---|---|
| 返回 404 | 内联值没加 `()`，被当成文件路径 | 检查规则里的括号 |
| 请求根本没出现在 Network | 没走代理 | 确认 `-x` 的端口与 `w2 status` 一致；Composer 版确认 **Whistle** 开关开启 |
| 响应还是旧内容 | 改了没 Save，或 ON 关着 | Save + 确认 ON 红色 |
| 出现 `Tunnel to` | 用了 https 但没开解密 | 本关统一用 `http://`，HTTPS 留到 [L4](/practice/l4-extend) |
| 端口连不上 | 实例没起来或换了端口 | `w2 status`，必要时 `w2 start -p 8899` |

## 收尾

练习结束前，把 `练习靶子` 这组的 **ON 关掉**（或删掉规则），避免它以后影响别的调试。后面每一关开始时再打开它——**随手关规则**是灵活应用的第一条习惯。

## 背后的机制

- `file://` 为什么能短路转发、内联值与 Values 的区别：[20《接口未就绪：Mock 与契约先行》](/scenarios/mock-contract)、[37《规则 DSL 全景》](/concepts/06-rules)。
- Composer 为什么回打 Whistle 自身代理、为什么带 `fc:`：[21《复现、保存与重放》](/scenarios/reproduce-replay)、[36《抓包数据面与帧》](/concepts/05-capture)。
- 规则编译与命中的完整链路：[13《规则引擎》](/modules/rules-engine)、[09《一次 HTTP 代理请求的旅程》](/core/http-request)。

## 晋级标准

能不看本页，自己写出一条自造响应规则、发出请求、在 Network 里点开确认内容，并用「关掉 ON 就失败」证明它确实生效。做到这一点，就进入 [L1 看得见](/practice/l1-observe)。

## 下一步

[L1 观察](/practice/l1-observe)：用这个靶子练「把一次请求看全、留下证据、判断它有没有出网」。
