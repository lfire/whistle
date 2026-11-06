---
title: 概念精解：从名词到工程直觉
description: 用词典式的详尽词条把工程里的专业名词讲透，建立五层递进的理解框架。
---

# 概念精解：从名词到工程直觉

读源码时最常卡住的往往不是语法，而是名词：CONNECT、ALPN、伪头、chunked、隧道、SNI 这些词各自只懂一半，连起来就互相打架。本板块是「概念精解」——一份详尽的概念词典，把工程里出现的大量专业名词用形象、递进的方式讲透，并逐一落回当前工程的真实源码位置。它以[站点导览](/guide/orientation)的代码地图与[领域基础](/domain/proxy-basics)的模型为前置，读完你能把一个名词同时说清「是什么、像什么、在 Whistle 里在哪一行、为什么这样设计、容易和谁混」。

![概念体系分层地图](/diagrams/concepts-map.svg)
*图注：五层从流量入口递进到规则与扩展，末端由辨析、贯通、索引三部分收口；箭头表示概念的依赖方向。*

## 与速查表的分工

[《术语、路径与配置速查》](/advanced/reference)回答的是「数值是多少、路径在哪、默认值是什么」：端口、阈值、CLI 开关、内部头，一页查完即可离开。本板块回答的是「它到底是什么、为什么长成这样、和隔壁那个词差在哪」，不追求一页查完，反而刻意把每个词展开成一张卡片。同一个 `socksPort`，速查表给你「默认关闭」这一行，[代理与流量入口](/concepts/01-proxy)则要讲清 SOCKS 与 HTTP 代理在报文层的本质差别；同一个 `enable://h2`，速查表登记它是开关，[HTTP 报文与连接语义](/concepts/02-http)则要讲清 ALPN 与伪头如何让它生效。查数值去速查表，建理解来本板块，两者互补而不重复。

## 本层概念地图

### 五层递进

本板块把散落在工程里的名词按「流量从外到内、再从内到外」排成**五层**，七篇详解分属其中；后一层总是建立在前一层的概念之上。

::: cols 16|44|40
| 层 | 对应篇目 | 这一层回答什么 |
|---|---|---|
| 第一层 | [01 代理与流量入口](/concepts/01-proxy)、[02 HTTP 报文与连接](/concepts/02-http) | 流量从哪进来、字节按什么格式组织 |
| 第二层 | [03 TLS、证书与信任](/concepts/03-tls) | 加密如何被安全地拆开 |
| 第三层 | [04 Node 运行时](/concepts/04-runtime)、[05 抓包数据面](/concepts/05-capture) | 进程里跑着什么、数据怎么被看见 |
| 第四层 | [06 规则 DSL](/concepts/06-rules) | 人的决策如何写成可热替换的文本 |
| 第五层 | [07 扩展与工程化](/concepts/07-extension) | 能力如何被第三方与自动化复用 |
:::

篇号不是层号：01 与 02 同属第一层，04 与 05 同属第三层，所以详解排到第七篇，层数仍只有五层。五层也不是难度分级，而是依赖方向：不先分清「CONNECT 是隧道而不是请求」，就读不懂「为什么要 MITM」；不先分清「chunked 是传输编码、gzip 是内容编码」，就看不懂抓包前为什么要先 dechunk 再 unzip。

### 辨析 → 贯通 → 索引

五层讲完并没有结束，末尾用三部分收口：[易混淆概念辨析](/concepts/08-confusions)把成对出现的词集中对照，[一次请求的贯通推演](/concepts/09-walkthrough)把孤立词条串成一条完整链路，[术语索引](/concepts/glossary)则提供按中文与英文回查的入口。三者分别解决「分不清」「串不起」「找不到」，与本板块的词典定位相呼应。

## 概念之间的关系

概念不是孤岛。下表挑出十二组最容易被割裂记忆的关系，第四列给出它们在源码里真正相遇的位置；读任意一篇时回查这张表，能快速定位名词之间的接缝。

::: cols 22|18|22|38
| 概念 A | 关系 | 概念 B | 在源码里相遇的位置 |
|---|---|---|---|
| CONNECT | 触发判定 | MITM 解密 | `lib/tunnel.js:168` |
| 绝对 URI | 还原为 | 完整 URL | `lib/util/common.js:1248` |
| SOCKSv5 | 翻译成 | 内部 CONNECT | `lib/index.js:151` |
| CONNECT 200 | 切换为 | 纯字节透传 | `lib/util/index.js:369` |
| Upgrade / 101 | 交给 | WebSocket 帧 | `lib/upgrade.js:77` |
| ALPN | 协商出 | h2 或 http/1.1 | `lib/https/h2.js:10` |
| HTTP/2 伪头 | 降级为 | 普通 Header | `lib/https/index.js:1030` |
| gzip 改写 | 触发 | 删 content-length | `lib/init.js:87` |
| chunked | 先于 | unzip 解码 | `lib/service/util.js:137` |
| SSE 流 | 被切成 | 抓包帧 | `lib/inspectors/data.js:331` |
| PAC 脚本 | 决定 | 上游选路 | `lib/rules/index.js:273` |
| 上游代理 | 包进 | 二级 CONNECT | `lib/config.js:169` |
:::

表的读法是「A 经某种关系变成或决定 B，而这次相遇发生在第四列的代码里」。例如 `CONNECT → 判定 → MITM` 落在 `lib/tunnel.js:168-213` 的拦截判定；`伪头 → 降级 → 普通 Header` 落在 `lib/https/index.js:1030-1043` 的 `:authority` 转 `host`；`CONNECT 200` 的常量定义在 `lib/util/index.js:369-375`，真正把这段字节写回客户端 socket 的调用点则在 `lib/tunnel.js:281`（判定拆隧道之后）。把关系与落点成对记，比孤立背单词更抗遗忘。

## 怎么读

### 三条路线

- **系统通读**：从[代理与流量入口](/concepts/01-proxy)顺读到[扩展与工程化](/concepts/07-extension)，再进[辨析](/concepts/08-confusions)与[贯通](/concepts/09-walkthrough)。适合第一次接触代理内核，或想把已有经验重新梳理成体系。
- **按词回查**：带着具体名词直接跳进对应篇，用页内标题定位卡片，读完「容易混淆」再顺着链接去[辨析篇](/concepts/08-confusions)；[术语索引](/concepts/glossary)与[速查表](/advanced/reference)负责快速定位。适合读源码时被一个词卡住。
- **结合场景**：从[工程场景总览](/scenarios/index)挑一个真实问题（如[真机接入](/scenarios/mobile-remote)、[弱网注入](/scenarios/fault-injection)），遇到不懂的名词再回到本板块查卡片，最后用[动手实验](/advanced/hands-on)验证。适合「先有问题、后补概念」。

三条路线并不互斥，常见走法是先按词回查救急，再抽时间系统通读补齐。

### 统一词条卡片结构

每篇的核心词条一律用同一张卡片，读者可以只看自己需要的字段：

- `> 一句话通俗定义`：不超过四十个字的白话定义，先建立第一印象。
- **打个比方**：两到三句生活化类比，负责把抽象机制变成可想象的场景。
- **在 Whistle 里**：具体行为加 `lib/xxx.js:行号` 的真实落点，必要时附不超过十二行的源码片段。
- **为什么这样设计**：它解决的工程矛盾、取舍与代价。
- **容易混淆**：与相邻概念的本质差别，可链到[辨析篇](/concepts/08-confusions)。
- **工程中的样子**：真实规则、命令或工作流，并链到对应的[工程场景](/scenarios/index)。

核心词条之外，每篇另设「速览表」覆盖次要名词，四列固定为「名词 / 一句话 / 源码落点 / 易混淆」，只求对齐称呼、不求展开；宽表统一用 `::: cols` 控制列宽，避免长短列互相挤压。

## 与工程实际结合

一个典型现场：手机连上电脑的 Wi-Fi 代理后，抓包列表里只有一条条隧道，看不到任何 HTTPS 明文。按概念链条排查，顺序恰好是本板块前三层的顺序——先确认流量确实进了代理（[系统代理与 PAC](/concepts/01-proxy)），再看 CONNECT 是否只回了 `200 Connection Established`（[CONNECT 词条](/concepts/01-proxy)），然后判断[TLS、证书与信任](/concepts/03-tls)里的 MITM 是否被启用、根证书是否被完全信任，最后才怀疑规则写错。真机接入的完整步骤见[真机、移动端与远程页面调试](/scenarios/mobile-remote)，证书排障见[HTTPS、证书与鉴权排障](/scenarios/https-trust)。

```txt
# 来源：docs/docs/rules/enable.md
# 对目标域名强制开启 HTTPS 解密（MITM）
www.example.com enable://capture
```

```bash
# 来源：docs/docs/cli.md
w2 proxy 8899
w2 ca
```

先用 `w2 proxy` 打开系统代理、用 `w2 ca` 安装并信任根证书，再用 `enable://capture` 打开解密，三步分别对应「入口」「信任」「判定」三个概念层；任何一层缺失，表现都是「只有隧道没有明文」。把这条排查链记住，比背下十个名词更能解决现场问题。

## 板块目录

本板块在全站统一编号中占 **31–41**（编号规则见[站点导览](/guide/orientation)）；下列序号就是全站编号，链接文字保留各篇自身的层级名。

31. [概念精解：从名词到工程直觉](/concepts/index)（本篇）：板块定位、五层递进、概念关系与三种读法。
32. [第一层：代理与流量入口](/concepts/01-proxy)：正向、反向、系统代理、PAC、上游代理、CONNECT、SOCKSv5 与隧道。
33. [第一层：HTTP 报文与连接语义](/concepts/02-http)：报文结构、分块与压缩、Keep-Alive、HTTP/2、ALPN、Upgrade 与帧。
34. [第二层：TLS、证书与信任](/concepts/03-tls)：中间人、CA、证书链、SNI、SAN 与信任存储。
35. [第三层：Node 运行时与内核骨架](/concepts/04-runtime)：Stream、事件循环、连接池与进程模型。
36. [第三层：抓包数据面与帧](/concepts/05-capture)：四阶段 inspector、请求与响应采集、缓存。
37. [第四层：规则 DSL 全景](/concepts/06-rules)：pattern、protocol、Values 与匹配优先级。
38. [第五层：扩展机制与工程化](/concepts/07-extension)：插件 hook、多实例与配置即代码。
39. [易混淆概念辨析](/concepts/08-confusions)：成对名词的集中对照与判别口诀。
40. [一次请求的贯通推演](/concepts/09-walkthrough)：把全部词条串成一条完整链路。
41. [术语索引](/concepts/glossary)：按中文与英文回查全部名词及所在篇。

## 常见误解

1. **把本板块当速查表**：这里每个词条都刻意展开，查单个数值或默认值应去[速查表](/advanced/reference)。
2. **把五层当难度分级**：五层是依赖方向而非由易到难，第一层的 HTTP/2 伪头并不比第二层的证书链简单。
3. **把比方当实现**：卡片里的类比只负责建立直觉，真实行为一律以「在 Whistle 里」给出的 `lib/xxx.js:行号` 为准。
4. **以为名词只属于某一层**：`CONNECT` 既是入口层的报文，又在隧道判定、上游代理与抓包里反复出现，关系表正是为这种跨层出场准备的。
5. **跳过收尾三部分**：只逐词读完五层仍可能「分不清、串不起」，[辨析](/concepts/08-confusions)与[贯通](/concepts/09-walkthrough)负责把点连成线。

## 小结

- 本板块是详尽的概念词典，与[速查表](/advanced/reference)按「建理解 / 查数值」分工。
- 五层递进按流量与依赖方向排列：入口 → 报文 → TLS → 运行时 → 规则与扩展。
- 末尾以[辨析](/concepts/08-confusions)、[贯通](/concepts/09-walkthrough)、[索引](/concepts/glossary)收口。
- 十二组关系表给出概念在源码里相遇的位置，是跨篇回查的接缝。
- 三条读法可自由组合；每张核心词条卡片含定义、比方、落点、取舍、混淆与工程样子六个字段。

## 下一步

[《第一层：代理与流量入口》](/concepts/01-proxy)：从「客户端把请求交给了谁」开始，用十张卡片讲清正向代理、绝对 URI、CONNECT、SOCKSv5 与 `tunnel://` 伪 URL。
