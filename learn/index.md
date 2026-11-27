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
      text: 按 01–41 顺读
      link: /guide/orientation
    - theme: alt
      text: 概念精解
      link: /concepts/index
features:
  - title: 领域知识先行
    details: 先讲清正向代理、CONNECT 隧道、证书链与 MITM、HTTP/2 与 WebSocket 帧，再读代码，避免只认得 API 却不理解取舍。
  - title: 结论都有出处
    details: 每个实现细节都标注仓库内文件路径与行号，可随时跳回源码核对；易混淆的概念单独点破。
  - title: 主线递进 + 两大专题
    details: 第 0 站先跑通工具，再按 41 篇由浅入深：领域基础 → 全局架构 → 核心链路 → 模块深潜 → 工程场景 → 进阶实践；零基础请按下方「概念先行」路线，不必硬顺读。
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

本套教程其余 41 篇是**源码研读**，默认你已经会用 Whistle；它回答「为什么这样设计」，不回答「第一步点哪里」。所以不论你有没有基础，都请先完成 **[第 0 站 · 第一次跑通](/guide/quickstart)**：装好、启动、接流量、装证书、写下并验证第一条规则。先让工具真的跑起来，后面每个机制都有东西可以对照。

其余 41 篇最省力的读者，是**用过任意一种抓包工具（Charles、Fiddler 或浏览器 DevTools）、读过一点 JavaScript / Node.js** 的人；但零基础同样可以学，第 0 站不要求任何编程基础。跑通第 0 站之后，下面两条路线选一条：

- **路线 A · 有基础**（用过抓包工具、看得懂一点 Node.js）：按编号 **01 → 41** 顺读，先建模型，再进源码，最后用工程场景检验。
- **路线 B · 完全零基础**：先走「概念先行」，分三段，每段读完再进下一段：
  1. **打底**：**31** 概念精解总览 → **32** 代理与流量入口 → **33** HTTP 报文 → **34** TLS 与证书 → **35** Node 运行时骨架。
  2. **回主线**：回到 **01** 导览 → **02–05** 领域基础 → **06–17** 主线（架构、核心链路、模块深潜）。
  3. **检验与回查**：**18–27** 工程场景 → **28–30** 动手与速查；**36–38** 的三篇详解按词回查，**39–41** 的辨析、贯通与术语索引随时回查。

编号只是全站的统一序号，**不代表必须按数字从小到大读**。概念精解排在 31–41，是因为它同时承担「词典」角色，但其中 31–35 正是为零基础准备的入门内容。各篇「先修知识」里出现的「可先读《概念精解 · XX》」，就是这条路的入口：看到时放心跳过去，读完再回来，不算跳读。

不需要预先安装 Whistle，也不需要会写 Node.js——第 0 站把安装到验证的每一步都列全了，正文里的代码片段也都配了中文说明。

## 学习路径

站点按「先跑通工具、再建立领域模型、最后进入工程实现」的顺序组织。**[第 0 站](/guide/quickstart)** 是所有路线共同的动手起点；其后每一层都回答一类问题，前一层是后一层的前置知识。模块深潜之后插入一层横向的「工程场景」专题，把前面各层学到的机制放回真实工程问题里检验：向上追问为什么这样设计，向下定位到具体源码；末尾的「概念精解」是可通读也可随时回查的词典。

全站 **41 篇正文按阅读顺序统一编号 01–41**，侧栏每项前的两位数字就是该编号，分组标题与卡片下方也标出了每个板块的编号范围；[第 0 站](/guide/quickstart) 是动手准备，刻意不占编号，先做完它再进入编号序列。站点不再使用带数字的层级标签：板块名只表示内容主题，顺序完全由 01–41 表达。按编号顺读即可走完主线，按板块跳读也不影响理解；这里的「顺读」指上方 **路线 A**，零基础读者请按 **路线 B** 的「概念先行」打底再回到主线。两条路线都以第 0 站为共同起点，最终都会走完全站。

<div class="path-grid">
  <a class="path-card" href="/guide/quickstart">
    <span class="path-card__num">第 0 站 · 动手准备</span>
    <span class="path-card__title">第一次跑通 Whistle</span>
    <span class="path-card__desc">装好、启动、接流量、装证书、写下并验证第一条规则；先跑通，再读机制。</span>
    <span class="path-card__links">第 0 站 · 从这里开始 →</span>
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
    <span class="path-card__links">31–41 · 11 篇 · 零基础打底段 →</span>
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
