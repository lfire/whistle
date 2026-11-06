---
title: 站点导览与代码地图
description: 固定研读基线、给出代码地图，并说明五层学习路径该怎么走。
---

# 站点导览与代码地图

第一次打开一个成熟的 Node.js 代理项目，最容易迷路的不是语法，而是不知道「哪个文件负责哪一段」。本节先固定版本基线，再给出一张可以按图索骥的代码地图，最后说明五层路径各自解决什么问题。读完你应该能回答：一个请求进来先落到哪里、规则该去哪找、抓包数据存在哪里。

::: tip 先修知识
需要能读懂 Node.js 的 `http.Server`、Express 中间件与 Stream。用过任意一种抓包工具（Charles、Fiddler 或浏览器 DevTools）会更顺畅；本节不含源码细节，可以当成索引反复回查。
:::

## 站点基线：先把版本钉死

本站基于 `guide` 分支、提交 `3b85cebc4`、版本 `v2.10.13`（`package.json:4`）撰写，运行环境要求 Node.js `>= 16.0.0`（`package.json:77-78` 的 `engines`）。README 列出的能力是：对 HTTP、HTTPS、HTTP/2、WebSocket、TCP 抓包与改写；支持 HTTP、HTTPS、SOCKS、反向代理多种代理模式；内置 Weinre、Console、Composer；可通过插件扩展，也可作为 npm 模块引用（`README.md:17-30`）。

为什么开篇就强调基线？因为 CONNECT 解密判定、叶证书有效期、HTTP/2 降级策略都随版本调整，脱离提交谈行号很容易对不上。本站所有 `路径:行号` 引用都以这个提交为准，若你检出的是其它版本，请以函数名和事件名作为锚点，而不是死记行号。需要补充的是，`3b85cebc4` 之后的提交只改动文档站 `learn/`，业务源码（`lib/`、`bin/`、`biz/` 等）零改动，因此这里的行号与函数名对得上当前仓库，不必换成文档站自身的提交号。

与官方 `docs/` 的分工也要先分清：`docs/index.md:1-20` 所在的官方文档站回答「怎么装证书、怎么写规则、怎么启动」，本站回答「这条规则在哪个函数被解析、为什么要这样设计」。遇到配置项语义查官方文档，遇到实现机制查本站，两者互补而不重叠。

## 代码地图

下表把仓库按目录切开。「建议时机」一列是阅读顺序建议，不是重要性排序。

| 路径 | 职责 | 关键文件 | 建议时机 |
|---|---|---|---|
| `bin/` | CLI、证书、系统代理 | `bin/whistle.js` | 看启动流程 |
| `index.js` | npm 包入口、cluster | `index.js` | 最先扫一眼 |
| `lib/` | 内核装配与配置 | `lib/index.js`、`lib/config.js` | 主线 |
| `lib/` | 初始化、隧道、升级 | `lib/init.js`、`lib/tunnel.js` | 主线 |
| `lib/` | 连接管理 | `lib/upgrade.js`、`lib/socket-mgr.js` | 看 ws / 帧 |
| `lib/https/` | 证书与 MITM | `lib/https/ca.js`、`lib/https/index.js` | 看 HTTPS |
| `lib/rules/` | 规则引擎与存储 | `lib/rules/rules.js` | 看规则 |
| `lib/inspectors/` | 请求四阶段 | `rules.js`、`req.js`、`data.js`、`res.js` | 主线 |
| `lib/handlers/` | 出站分发 | `file-proxy.js`、`http-proxy.js` | 主线 |
| `lib/plugins/` | 插件加载与通信 | `lib/plugins/index.js` | 看扩展 |
| `lib/util/` | 工具与抓包缓存 | `data-server.js`、`patch.js` | 按需 |
| `lib/service/` | 后台服务 | `lib/service/service.js` | 按需 |
| `biz/` | Web UI 与 weinre | `biz/index.js` | 看界面 |
| `docs/` | 官方使用文档 | `docs/index.md` | 查用法 |
| `test/` | 测试 | `test/index.test.js` | 验证猜想 |
| `assets/` | 静态资源 | `assets/js/` | 按需 |

为什么把 `lib/` 单独拆成三行？因为它是内核，而内核里又明显分成「装配」「协议入口」「连接管理」三簇，混在一起看会误以为它们平级。

## 五层学习路径

侧栏把「开始之前」之后的正文分成五层，每层回答一类问题：

1. **第一层 · 领域基础**：代理形态、TLS 中间人、流量协议。先建立「线上到底发生了什么」的模型。
2. **第二层 · 全局架构**：一张图、启动流程、进程与配置。把模型对应到进程与模块边界。
3. **第三层 · 核心链路**：一次 HTTP 请求、CONNECT 判定、隧道与帧、抓包采集。沿数据流走完整条链。
4. **第四层 · 模块深潜**：规则引擎、指令体系、证书、插件、Web UI。逐个拆开子系统。
5. **第五层 · 进阶实践**：动手实验、阅读路线、速查表。把前面读到的东西用起来。

本篇属于「开始之前」，作用是给你地图和坐标，不进入任何一条具体链路。

## 怎么读这份源码

建议先领域、后源码。原因很直接：如果不先理解 CONNECT 隧道与两段 TLS，看到 `lib/tunnel.js` 的解密判定只会觉得是一堆布尔条件；先有模型，代码里的每个分支才有理由。

读的时候把仓库和文档并排打开，遇到 `lib/index.js:40-52` 这类引用就立刻跳过去看一眼，再回来接着读。以「一次请求」为主线串起各层，比按目录从头翻到尾有效得多：入口 → 中间件 → 规则 → 出站 → 抓包，这条线在后面的架构总览里会完整展开。另外，行号会随提交漂移，但 `server.on('connect')`、`app.use(mw.bind(proxyEvents))` 这类事件名和函数名相对稳定的锚点，值得优先记住。

## 小结

- 基线是 `guide` 分支 `3b85cebc4`、v2.10.13、Node.js >= 16，引用行号以此为准。
- 官方 `docs/` 讲用法，本站讲实现与设计取舍，两者互补。
- `lib/` 是内核，`lib/https/`、`lib/rules/`、`lib/inspectors/`、`lib/handlers/` 是四条主要支线。
- 五层路径从领域模型递进到动手实践，先建立模型再读代码。
- 以「一次请求」为主线索，边读边对照仓库相对路径。

## 下一步

[《代理的形态与 CONNECT 隧道》](/domain/proxy-basics)：先弄清正向代理、隧道代理与 CONNECT 报文，再进入源码里的四类入口。
