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
      text: 从导览开始
      link: /guide/orientation
    - theme: alt
      text: 直接看全局架构
      link: /architecture/overview
    - theme: alt
      text: 速查表与术语
      link: /advanced/reference
features:
  - title: 领域知识先行
    details: 先讲清正向代理、CONNECT 隧道、证书链与 MITM、HTTP/2 与 WebSocket 帧，再读代码，避免只认得 API 却不理解取舍。
  - title: 结论都有出处
    details: 每个实现细节都标注仓库内文件路径与行号，可随时跳回源码核对；易混淆的概念单独点破。
  - title: 五层递进 + 场景专题
    details: 领域基础 → 全局架构 → 核心链路 → 模块深潜 → 工程场景 → 进阶实践，29 篇文档由浅入深，可顺读也可按需查阅。
  - title: 场景可双向追溯
    details: 10 篇工程场景从真实问题出发，向上追溯设计思想、向下定位到源码路径与行号，每个场景都有可复制的配置。
  - title: 图表支持放大
    details: 15 张自绘矢量架构图与时序图，点击即可放大、缩放、拖拽，解决信息密集图缩在正文里看不清的问题。
---

<div class="meta-strip">
  <span>源码分支：guide</span>
  <span>提交：3b85cebc4</span>
  <span>版本：whistle v2.10.13</span>
  <span>运行环境：Node.js ≥ 16</span>
  <span>29 篇正文 · 15 张图</span>
</div>

## 学习路径

站点按「先建立领域模型，再进入工程实现」的顺序组织。每一层都回答一类问题，前一层是后一层的前置知识。模块深潜之后插入一层横向的「工程场景」专题，把前面各层学到的机制放回真实工程问题里检验：向上追问为什么这样设计，向下定位到具体源码。

<div class="path-grid">
  <a class="path-card" href="/guide/orientation">
    <span class="path-card__num">第 0 层 · 准备</span>
    <span class="path-card__title">站点导览与代码地图</span>
    <span class="path-card__desc">确认源码基线，认识目录职责，搞清楚本站与官方使用文档的分工。</span>
    <span class="path-card__links">1 篇 · 从这里开始 →</span>
  </a>
  <a class="path-card" href="/domain/proxy-basics">
    <span class="path-card__num">第 1 层 · 领域基础</span>
    <span class="path-card__title">代理、TLS 与协议</span>
    <span class="path-card__desc">正向代理与 CONNECT、证书链与中间人、HTTP/2 与 WebSocket、抓包调试的能力模型。</span>
    <span class="path-card__links">4 篇 · 先懂业务 →</span>
  </a>
  <a class="path-card" href="/architecture/overview">
    <span class="path-card__num">第 2 层 · 全局架构</span>
    <span class="path-card__title">四类入口与一条总线</span>
    <span class="path-card__desc">从全局架构图切入，再拆解启动链路、进程模型与配置系统。</span>
    <span class="path-card__links">3 篇 · 建立骨架 →</span>
  </a>
  <a class="path-card" href="/core/http-request">
    <span class="path-card__num">第 3 层 · 核心链路</span>
    <span class="path-card__title">一次请求走过的地方</span>
    <span class="path-card__desc">HTTP 请求 16 步、CONNECT 解密判定、隧道与帧拦截、抓包数据采集上报。</span>
    <span class="path-card__links">4 篇 · 全站重点 →</span>
  </a>
  <a class="path-card" href="/modules/rules-engine">
    <span class="path-card__num">第 4 层 · 模块深潜</span>
    <span class="path-card__title">规则、证书、插件与 UI</span>
    <span class="path-card__desc">逐个拆开规则引擎、指令体系、根 CA 签发、插件子进程与 Web 管理界面。</span>
    <span class="path-card__links">5 篇 · 深入细节 →</span>
  </a>
  <a class="path-card" href="/scenarios/index">
    <span class="path-card__num">专题 · 工程场景</span>
    <span class="path-card__title">从问题追溯到代码</span>
    <span class="path-card__desc">10 篇真实工程场景：联调、Mock、重放、弱网、证书、真机、协作、CI 与边界，每篇双向追溯设计思想与源码。</span>
    <span class="path-card__links">10 篇 · 学以致用 →</span>
  </a>
  <a class="path-card" href="/advanced/hands-on">
    <span class="path-card__num">第 5 层 · 进阶实践</span>
    <span class="path-card__title">动手、调试与速查</span>
    <span class="path-card__desc">三个可复制的实验、源码阅读路线与断点建议、术语/路径/配置/阈值速查。</span>
    <span class="path-card__links">3 篇 · 上手验证 →</span>
  </a>
</div>

## 站点约定

为了让长表格和架构图在页面上依然可读，站点做了几处专门处理。阅读时留意这些约定：

| 元素 | 处理方式 | 你该怎么做 |
|---|---|---|
| 架构图 / 时序图 | 矢量 SVG，点击放大 | 图小看不清时，点图进入查看器，滚轮缩放、拖拽、`0` 键回到 1:1 |
| 长表格 | 限制列数并按需固定列宽 | 表格可横向滚动；宽表的列宽已按内容长短预设 |
| 源码引用 | `lib/xxx.js:行号` | 用行内代码标注，便于在编辑器里直接跳转核对 |
| 代码块 | 标注语言与文件位置 | 每段控制在 20 行内，只截取与结论相关的片段 |

::: tip 与官方文档的关系
仓库里的 [`docs/`](https://github.com/avwo/whistle/tree/master/docs) 是官方**使用文档**，回答「这条规则怎么写、这个按钮在哪」；本站是**源码研读**，回答「这条规则是怎么被解析和命中的、这个按钮背后的 CGI 做了什么」。两者互补，遇到具体指令的完整参数仍建议同时查阅官方文档。
:::

::: warning 合规提醒
本站涉及 HTTPS 中间人解密的原理与实现，仅用于**调试自己有权调试的流量**。安装根证书会扩大本机信任范围，请勿在生产环境或他人设备上滥用；证书固定（pinning）、双向认证（mTLS）等场景也不应被绕过。
:::

## 关于基线

所有结论以当前分支 `guide` 的提交 `3b85cebc4`（`v2.10.13`）为准。Whistle 仍在持续迭代，函数名与行号可能随版本变化——阅读时请以你本地 checkout 的源码为准，把本文档当作**导航图**而不是规格说明书。
