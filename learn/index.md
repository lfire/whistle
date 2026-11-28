---
layout: home
title: Whistle 源码研读
description: 基于 guide 分支，逐级吃透一个跨平台网络抓包调试代理的实现原理与源码细节
hero:
  name: Whistle 源码研读
  text: 从代理原理到源码
  tagline: 不只讲「怎么用」，更讲「为什么这样设计」——沿着当前分支的源码，把一个网络抓包调试代理拆开来看。
  actions:
    - theme: brand
      text: 第 0 站 · 先跑通
      link: /guide/quickstart
    - theme: alt
      text: 实战通关 L1–L5
      link: /practice/index
    - theme: alt
      text: 源码研读 01–41
      link: /guide/orientation
features:
  - title: 领域知识先行
    details: 先讲清正向代理、CONNECT 隧道、证书链与 MITM、HTTP/2 与 WebSocket 帧，再读代码，避免只认得 API 却不理解取舍。
  - title: 结论都有出处
    details: 每个实现细节都标注仓库内文件路径与行号，可随时跳回源码核对；易混淆的概念单独点破。
  - title: 主线递进 + 两大专题
    details: 第 0 站先跑通工具，零基础接着走实战通关 L1–L5 的能力训练；想深读实现再按 41 篇由浅入顺读：领域基础 → 全局架构 → 核心链路 → 模块深潜 → 工程场景 → 进阶实践。
  - title: 场景可双向追溯
    details: 10 篇工程场景从真实问题出发，向上追溯设计思想、向下定位到源码路径与行号，每个场景都有可复制的配置。
  - title: 概念讲透，不点到为止
    details: 11 篇概念精解用「类比 + 源码 + 设计取舍 + 易混淆 + 工程实例」拆解 360 个术语、83 组辨析与 28 步贯通链路。
  - title: 图表支持放大
    details: 18 张自绘矢量架构图与时序图，点击即可放大、缩放、拖拽，解决信息密集图缩在正文里看不清的问题。
---

<div class="meta-strip">
  <span>源码分支：guide</span>
  <span>提交：3b85cebc4</span>
  <span>版本：whistle v2.10.13</span>
  <span>运行环境：Node.js ≥ 16</span>
  <span>41 篇正文 · 18 张图</span>
</div>

## 先说清楚：这是什么、零基础怎么开始

**Whistle 是一个装在你电脑上的网络抓包调试代理**：浏览器或手机把请求交给它，它替你转发到目标网站，途中把请求和响应记下来，也能按你写的规则改写。其余 41 篇不教怎么点界面，而是把这套能力拆到源码层，回答「它凭什么能看见 HTTPS 明文」「一行规则是怎么被解析和命中的」；[第 0 站](/guide/quickstart) 专门手把手教界面与操作。

这套教程的目标不是「读完 41 篇」，而是**让你能独立、灵活地把 Whistle 用到真实工作里**。所以内容分成两层：

- **[实战通关 · L1–L5 + 高级层](/practice/index)**：按「能独立完成什么」分级的训练关，每关都有可直接执行的任务、可观察的验收、变式练习、排障清单和收尾要求；L1–L5 到「灵活应用」，[A1–A5 高级层](/practice/advanced-index) 到「能改、能集成、能管、能讲清」，每关产出可复核工件。这是零基础者的主路线。
- **01–41 源码研读**：讲清每个机制为什么这样设计，是**按需回查**的原理层，不是入门课。

不论走哪条，都请先完成 **[第 0 站 · 第一次跑通](/guide/quickstart)**：装好、启动、接流量、装证书、写下并验证第一条规则。之后再按目标选一条：

- **路线 A · 零基础，目标是能独立干活（推荐）**：第 0 站 → [自造靶子](/practice/target)（不需要后端也能练） → [L1 看得见](/practice/l1-observe) → [L2 改得动](/practice/l2-rewrite) → [L3 造得出](/practice/l3-simulate) → [L4 接得上](/practice/l4-extend) → [迁移关](/practice/bridge)（把靶子换到真实项目） → [L5 排得清](/practice/l5-diagnose) → [综合通关项目](/practice/final-project) → [高级层 A1–A5](/practice/advanced-index)（读源码、写插件、内嵌集成、协作方案、性能合规与讲解）。每关结束对照「晋级标准」再往下走；遇到不懂的名词按关卡末尾的链接回查 01–41，**不必按编号顺读**。
- **路线 B · 已会抓包、想读源码**：按 **01 → 41** 顺读；概念精解 31–41 既可系统通读，也适合随时按词回查。

两条路线的差别只是「先做后读」还是「先读后做」，最终覆盖同一套机制。这个顺序是核查出来的：直接把零基础者送进 01–17 源码主线，读完仍做不出一个真实任务——多数篇章只增加知识、不增加可执行能力——所以把训练关提为主路线。

不需要预先装过 Whistle，也不需要后端服务、真机或团队环境：第 0 站把安装到验证列全了，训练关用 Whistle 自己造靶子，全部练习都能在本机完成。

**本篇的学习目标（可验收）**：本篇是**导航页**，不承担工具操作能力，全站总目标由[实战通关](/practice/index) 的 L1–L5 逐关验收。读完能自检三条即算达成：① 说出路线 A / 路线 B 分别适合谁；② 能点开第 0 站与实战通关两个入口；③ 能说清「通关看的是做出来的结果，不是读完的篇数」。

## 学习路径

站点有两条主线：**[实战通关](/practice/index)** 按能力等级 L1–L5 组织，每关只问「你能独立做出什么」，是零基础者达成「能灵活应用」的主路线；**01–41** 按「先建立领域模型，再进入工程实现」组织，是源码研读与按需回查的原理层。**[第 0 站](/guide/quickstart)** 是两条路线共同的动手起点。模块深潜之后插入一层横向的「工程场景」专题，把机制放回真实工程问题里检验：向上追问为什么这样设计，向下定位到具体源码；末尾的「概念精解」是可通读也可随时回查的词典。

全站 **41 篇正文按阅读顺序统一编号 01–41**，侧栏每项前的两位数字就是该编号，分组标题与卡片下方也标出了每个板块的编号范围；[第 0 站](/guide/quickstart) 与 [实战通关](/practice/index) 刻意不占编号——前者是动手准备，后者按 L1–L5 能力等级排列。站点不再使用带数字的层级标签：板块名只表示内容主题，01–41 的顺序只用于源码研读这条线。按编号顺读对应上方 **路线 B**，零基础读者请走 **路线 A** 的训练关。两条路线都以第 0 站为起点，最终覆盖同一套机制。

<div class="path-grid">
  <a class="path-card" href="/guide/quickstart">
    <span class="path-card__num">第 0 站 · 动手准备</span>
    <span class="path-card__title">第一次跑通 Whistle</span>
    <span class="path-card__desc">装好、启动、接流量、装证书、写下并验证第一条规则；先跑通，再读机制。</span>
    <span class="path-card__links">第 0 站 · 从这里开始 →</span>
  </a>
  <a class="path-card" href="/practice/index">
    <span class="path-card__num">实战通关 · 零基础主路线</span>
    <span class="path-card__title">L1–L5 能力训练</span>
    <span class="path-card__desc">用自造靶子练观察、改写、构造、复杂接入与独立排障，每关有任务、验收、变式和清场要求。</span>
    <span class="path-card__links">L1–L5 · 8 篇 · 从会开关到能独立解决问题 →</span>
  </a>
  <a class="path-card" href="/guide/orientation">
    <span class="path-card__num">导览与准备</span>
    <span class="path-card__title">站点导览与代码地图</span>
    <span class="path-card__desc">确认源码基线，认识目录职责，搞清楚本站与官方使用文档的分工。</span>
    <span class="path-card__links">01 · 1 篇 · 顺读起点 →</span>
  </a>
  <a class="path-card" href="/domain/proxy-basics">
    <span class="path-card__num">领域基础</span>
    <span class="path-card__title">代理、TLS 与协议</span>
    <span class="path-card__desc">正向代理与 CONNECT、证书链与中间人、HTTP/2 与 WebSocket、抓包调试的能力模型。</span>
    <span class="path-card__links">02–05 · 4 篇 · 先懂业务 →</span>
  </a>
  <a class="path-card" href="/architecture/overview">
    <span class="path-card__num">全局架构</span>
    <span class="path-card__title">四类入口与一条总线</span>
    <span class="path-card__desc">从全局架构图切入，再拆解启动链路、进程模型与配置系统。</span>
    <span class="path-card__links">06–08 · 3 篇 · 建立骨架 →</span>
  </a>
  <a class="path-card" href="/core/http-request">
    <span class="path-card__num">核心链路</span>
    <span class="path-card__title">一次请求走过的地方</span>
    <span class="path-card__desc">HTTP 请求 16 步、CONNECT 解密判定、隧道与帧拦截、抓包数据采集上报。</span>
    <span class="path-card__links">09–12 · 4 篇 · 全站重点 →</span>
  </a>
  <a class="path-card" href="/modules/rules-engine">
    <span class="path-card__num">模块深潜</span>
    <span class="path-card__title">规则、证书、插件与 UI</span>
    <span class="path-card__desc">逐个拆开规则引擎、指令体系、根 CA 签发、插件子进程与 Web 管理界面。</span>
    <span class="path-card__links">13–17 · 5 篇 · 深入细节 →</span>
  </a>
  <a class="path-card" href="/scenarios/index">
    <span class="path-card__num">工程场景 · 专题</span>
    <span class="path-card__title">从问题追溯到代码</span>
    <span class="path-card__desc">10 篇真实工程场景：联调、Mock、重放、弱网、证书、真机、协作、CI 与边界，每篇双向追溯设计思想与源码。</span>
    <span class="path-card__links">18–27 · 10 篇 · 学以致用 →</span>
  </a>
  <a class="path-card" href="/advanced/hands-on">
    <span class="path-card__num">进阶实践</span>
    <span class="path-card__title">动手、调试与速查</span>
    <span class="path-card__desc">三个可复制的实验、源码阅读路线与断点建议、术语/路径/配置/阈值速查。</span>
    <span class="path-card__links">28–30 · 3 篇 · 上手验证 →</span>
  </a>
  <a class="path-card" href="/concepts/index">
    <span class="path-card__num">概念精解 · 专题</span>
    <span class="path-card__title">把专业名词讲透</span>
    <span class="path-card__desc">分层递进的概念词典：类比、源码落点、设计取舍、83 组易混辨析、28 步贯通案例与 360 条术语索引。</span>
    <span class="path-card__links">31–41 · 11 篇 · 按需回查词典 →</span>
  </a>
</div>

## 站点约定

为了让长表格和架构图在页面上依然可读，站点做了几处专门处理。阅读时留意这些约定：

| 元素 | 处理方式 | 你该怎么做 |
|---|---|---|
| 第 0 站 | 动手跑通的最小闭环 | 读任何一篇之前先做完它，否则「Rules 在哪」「Tunnel to 是什么」都无从对照 |
| 每篇开头的绿色提示框 | 「先修知识」 | 先看它：写清本篇承接哪几篇、需要哪些概念；零基础按框里的概念精解链接先补即可 |
| 架构图 / 时序图 | 矢量 SVG，点击放大 | 图小看不清时，点图进入查看器，滚轮缩放、拖拽、`0` 键回到 1:1 |
| 长表格 | 限制列数并按需固定列宽 | 表格可横向滚动，右侧渐隐与提示说明还有内容；手机上看宽表不要以为被截断 |
| 源码引用 | `lib/xxx.js:行号` 这样的写法 | 冒号后面的数字是行号，表示「仓库里这个文件的第 N 行」；第一次读不必真的去翻，当坐标看即可 |
| 代码块 | 顶部有语言标签、复制与折叠按钮 | 长代码（≥8 行）可点「折叠」收起，行首的小三角能按结构收起局部；复制始终拿到完整代码 |

::: tip 与官方文档的关系
仓库里的 [`docs/`](https://github.com/avwo/whistle/tree/master/docs) 是官方**使用文档**，回答「这条规则怎么写、这个按钮在哪」；本站是**源码研读**，回答「这条规则是怎么被解析和命中的、这个按钮背后的 CGI（界面请求对应的一个服务端小脚本） 做了什么」。两者互补，遇到具体指令的完整参数仍建议同时查阅官方文档。
:::

::: warning 合规提醒
本站涉及 HTTPS 中间人解密的原理与实现，仅用于**调试自己有权调试的流量**。安装根证书会扩大本机信任范围，请勿在生产环境或他人设备上滥用；证书固定（pinning）、双向认证（mTLS）等场景也不应被绕过。
:::

## 关于基线

所有结论以当前分支 `guide` 的提交 `3b85cebc4`（`v2.10.13`）为准；其后的提交只更新文档站 `learn/`，业务源码零改动，因此站内行号仍对应当前仓库。Whistle 上游仍在持续迭代，函数名与行号可能随版本变化——阅读时请以你本地 checkout 的源码为准，把本文档当作**导航图**而不是规格说明书。
