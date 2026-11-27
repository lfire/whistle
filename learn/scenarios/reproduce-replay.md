---
title: 复现、保存与重放
description: 从 Network 抓包到 Composer 重放，追溯同一 data 引用、service 子进程与约定式 CGI 如何支撑会话的保存与回打。
---

# 复现、保存与重放

一个偶现的 502 只在某台手机上出现，等接上调试环境就再也复现不了；测试要把它存下来、改几个请求头再连发一百次。这类「把真实流量固定成可重复输入」的现场，是复现与重放最典型的工程问题。本篇从 `docs/docs/gui/network.md`、`composer.md`、`shortcut.md` 与 `test/units/composer.test.js` 的真实工作流出发，读完你能走通 Save、Import、Export 与 [Replay](/concepts/05-capture) 的完整闭环，并说清内核与界面为何读同一份数据、重活为何放进 service 子进程、以及 600 条缓存与 2MB 正文这些边界从哪来。[《接口未就绪：Mock 与契约先行》](/scenarios/mock-contract)（20）已经证明一份响应可以凭空构造、不依赖后端存在，却留下一个未解问题：那些只在特定线上流量里偶现的真实请求，既不能靠规则生成、也无法稳定再次触发；本篇承接这个空白，把「固定响应」推进到「固定一次真实请求」，回答如何把偶现现场存成会话、再反复重放。

::: tip 先修知识
本篇承接 [《接口未就绪：Mock 与契约先行》](/scenarios/mock-contract)（20），本篇会讲清（不需要预先掌握）：规则命中后由 handler 决定出站或短路、`file://` 会直接构造响应而不出网、以及抓包会话按 id 索引、有界缓存会淘汰旧条目。20 讲的是「目标不存在时由代理自己造响应」，本篇把视角翻到「目标真实存在、但那一次请求再也复现不了」——先得把真实流量采下来、存成会话，才谈得上编辑与重放。

若对抓包、reqId、Composer、Replay、帧与旁路采样不熟悉，可先读 [《概念精解 · 抓包数据面与帧》](/concepts/05-capture)；对规则 DSL、pattern、Values 与过滤器可查 [《概念精解 · 规则 DSL 全景》](/concepts/06-rules)；对插件与 pfork 子进程可查 [《概念精解 · 扩展机制与工程化》](/concepts/07-extension)；对一次请求如何贯通内核与界面可查 [《概念精解 · 一次请求的完整贯通》](/concepts/09-walkthrough)。不要求预先读过源码，但知道「CGI 文件名即接口名」与「service 子进程承载重活」这两个约定会更轻松；忘记某个名词可查 [《全量术语索引》](/concepts/glossary)。
:::

## 场景与痛点

- **排查偶现问题的工程师**：线上偶发 502，客户端环境特殊、无法稳定触发。约束是必须先把那一次真实请求完整保存下来，之后无论改请求头、改方法还是连续重放，都不能依赖再次复现现场。
- **跨工具协作的测试**：同事用 Fiddler 存了 SAZ，团队想直接导入 Whistle 分析；反过来也要把抓包导出成 SAZ 交给对方。约束是同一份会话要能在两种工具间往返，且导入格式不能只认自家私有结构。
- **验证规则是否命中的开发者**：改完一条规则，想确认某个请求到底命中了哪几行，还要把 [Composer](/concepts/05-capture) 发出的构造请求从海量[抓包](/concepts/05-capture)里单独挑出来。约束是查询要按请求 id 精确定位，过滤不能和真实业务流量混在一起。

三条现场的「输入 → 动作 → 输出」是同构的：输入都是「一次再也触发不了的真实请求」，动作统一为先用 Save 把它固定成会话、再按需 Import / Export、最后用 Composer 编辑并重放，输出是一份不依赖再次复现现场、能改请求头改方法、还能连发多次的可重复输入。三条看似不同的角色，其实只在「保存之后要拿它做什么」上分叉：工程师要改头连发、测试要跨工具往返、开发者要按 id 精确定位。

为什么这样设计：偶现问题难修，难点不在「怎么改那条请求」，而在「怎么让那一次请求不再消失」。所以闭环第一步永远是保存而不是重写——否则每改一次请求头，都得回线上碰一次运气；把「采集」和「构造」拆成两步，20 靠规则造出来的响应与本篇存下来的真实请求才各管一类问题：一个回答「依赖没写好」，一个回答「现场回不去」，谁也替代不了谁。若反过来先想着「重写一份请求」，就又绕回了 20 的构造思路，偶现流量里那些特殊的头、时序与 Cookie 反而会丢。

代价与边界：保存下来的会话受 600 条缓存与 2MB 正文限制（两条边界在「边界与坑」里展开），旧会话会被按界淘汰、超阈正文只留元信息。因此「存下来」不等于「永久无损存档」：长周期回归要配合导出 SAZ，把会话搬到进程之外，才不会哪天被缓存淘汰掉。换句话说，这一层给的是「可重复输入」，不是「可信归档」，两者对完整性的要求并不一样。

类比：像把一段偶然出现的现场录成录像带，之后倒带、暂停、改几句台词、反复播放都不用再等一次现场；但录像带会磨损、容量有限，对应这里的缓存条数与正文上限，录不下的部分只能留个片段索引。

最小自验：对照 `fc:/test/` 这条搜索前缀，先在 Network 搜索框里只过滤出 Composer 发出的请求，就能亲眼确认「构造流量与业务流量被分开」——用本篇现成的过滤命令即可，不必真的导入一份 SAZ。再对照 `Ctrl+Shift+Enter 设置重放次数`，就能理解「连发一百次」是靠界面把次数交下去，而不是靠手工点一百遍。

三条现场与后文三段配置也对得上：工程师「存下来再改头连发」对应快捷键与 `npm test` 那条动作链，测试「跨工具往返」对应 `.saz` 导入导出，开发者「按请求 id 精确定位」对应 `fc:` 与 `get-matched-rules`。先看痛点，就知道三段配置不是三种并列语法，而是「隔离、动作、回归」三种约束各自逼出来的写法；后文那四条设计原则，正好各管其中一层。

按角色看也清楚：工程师要的是「地址不动就有数据、还能连发」，测试要的是「同一份会话能在 Whistle 与 Fiddler 之间往返」，开发者要的是「按请求 id 精确定位、不与业务流量混」。三者能同时满足，是因为它们分别落在采集、互操作、查询三个不同层面；后文那四条设计原则正好各管一层，少一条就有一类诉求落空。反过来想，若不做「先保存」这一步，偶现请求就只能在出现它的那一刻被处理一次，改头、连发、跨工具交接都无从谈起——这不是省了一个按钮，而是整条复现链断了。

## 可复制的配置

Network 底部搜索框支持多条件「与」搜索，`fc:` 前缀专门隔离 Composer 流量；导入导出格式由前端约定。

```txt
# 来源：docs/docs/gui/network.md、import-dialog.js
# 多条件「与」搜索
b:/"success":false/ m:POST s:200 H:api.example.com
# 只过滤 Composer 发出的请求
fc:/test/
# 导入支持 .txt .json .saz .har，导出可选 Fiddler *.saz
```

快捷键与 Composer 组件把「保存 → 编辑 → 重放」串成一条固定动作链。

```txt
# 来源：docs/docs/gui/composer.md、shortcut.md
# Replay / Edit Request / AsCURL / Replay Times(最多 100 次)
Ctrl+S 保存   Ctrl+I 导入   Ctrl+E 导出
Ctrl+Shift+Enter 设置重放次数   Ctrl+A 强制中断
# Test Rules 查命中规则，对应 cgi-bin/get-matched-rules
```

集成测试直接把这条链固化为可执行命令，`test/units/composer.test.js` 连续向 `cgi-bin/composer` POST 构造请求。

```bash
# 来源：package.json、test/index.test.js
npm test                 # node test/index.test.js，遍历 82 个 units
# Composer 单元覆盖 cgi-bin/composer 的构造与重放
```

三段分别对应过滤、动作与回归：`fc:` 把构造流量从业务流量里隔离出来，快捷键串起保存、导入导出与重放，`npm test` 则把 Composer 的 POST 流程固化进 82 个 units。值得注意的是 Import 与 Export 并非简单读写文本：`.saz` 要走 zip 解压与 `fiddlerMeta` 模板，`.har`、`.txt`、`.json` 才按文本解析（`biz/webui/htdocs/src/js/index.js:3630-3645`），这也是把互操作放进 service 子进程的原因。取数类按钮大多对应 `cgi-bin/` 下的同名文件（`get-data`、`get-matched-rules`、`sessions`），但 `composer` 是例外：`biz/webui/lib/index.js:540` 显式注册 `app.post('/cgi-bin/composer')`，经 `sendToService`（`:79-91`）把请求转进 `lib/service/` 子进程；集成测试因此可以直接对这个 CGI 发请求，而不必驱动浏览器界面。

把三段配置收拢成「输入 → 动作 → 输出」：输入是 Network 搜索框里的一串条件（`b:` / `m:` / `s:` / `H:` 与 `fc:` 前缀）或一次快捷键、一次 CGI POST；动作是前端按「与」逻辑筛出会话、快捷键把 Save → Import → Export → Replay 串成固定动作链、`npm test` 把 Composer 的 POST 固化成回归用例；输出是「被隔离出来的目标会话」与「可反复执行的重放序列」。三段分别管过滤、动作、回归，缺一段，闭环就退回到手工操作。

为什么这样设计：把过滤做成多条件「与」、又单独给 Composer 流量一个 `fc:` 前缀，是因为重放会往抓包列表里灌入大量构造请求；若不与真实业务流量隔离，排查时根本分不清哪条是现场、哪条是自己打出来的，按 id 精确定位也就无从谈起。把动作链固化进 `npm test`，则让「手工点一遍」变成「82 个 units 里可回归的一条」，改动 Composer 链路时能立刻发现回归。

把「Import 与 Export 并非简单读写文本」这句结论再展开：前端按格式把会话分流，`.har`、`.txt`、`.json` 能直接按文本解析，`.saz` 却要先 zip 解压、再按 `fiddlerMeta` 模板渲染——这是 CPU 与内存都吃紧的活。所以 `composer` 才成了「文件名即接口名」的例外：它单独注册 POST 路由，经 `sendToService` 转进 `lib/service/` 子进程，而不是像 `get-data` 那样按约定直接 require 一个查询文件。输入不同格式 → 前端分流 → 重活转子进程 → 输出统一会话结构，这条推理把「为什么偏偏 composer 例外」说圆了。

代价与边界：`fc:` 只隔离 Composer 发出的请求，不会自动区分「同一 URL 上不同改法的重放」；多条件「与」搜索与快捷键都是前端约定，换界面版本就得重新对照 `docs/docs/gui/network.md`、`composer.md`、`shortcut.md`，不能当成协议层保证。子进程转发也多了一次进程间通信：好处是主代理线程不被 zip 解析拖住，代价是排障时要多想一层「这一步到底在 CGI 里还是在 service 里」。

类比：像给实验样本贴专属标签（`fc:`），再把它和流水线上的正品分开放，免得统计时把自造样本算进良品率；重活则交给后场作坊（service 子进程），前厅照常接客。

最小自验：照着 `Ctrl+S 保存 / Ctrl+I 导入 / Ctrl+E 导出` 与 `Ctrl+Shift+Enter 设置重放次数` 的顺序在心里走一遍，就能确认「保存 → 编辑 → 重放」是一条固定链而非三个独立按钮；再对照 `npm test` 那行，理解这条链为何能被固化成一条命令。把 `get-data`（约定式查询）与 `composer`（单独注册 POST）放一起看，不用读源码也能自己说出「为什么偏偏它例外」。

反过来想，若把 `.saz` 的 zip 解析与 `fiddlerMeta` 渲染留在 CGI 里同步做完，会发生什么：一次导入大会话就会把处理该请求的线程占住，界面轮询取数跟着变慢，而这段逻辑与主代理抓包其实毫无关系。把它转进 service 子进程，等于把「互操作」和「观测」两类负载隔开；这也解释了为什么 `composer` 要单独注册 POST 路由——它要承载上传体，不能像纯查询那样按「文件名即接口名」的约定轻轻带过。

## 背后的设计思想

- [零复制优先](/core/capture-data)：`lib/util/data-server.js:319-333` 的 `handleRequest` 给 `data` 补上 id 与版本后，直接 `reqData[id] = data`，不做克隆。内核采样与 UI 轮询读的是同一对象引用，因此抓包列表、详情面板与导出内容天然一致；代价是任何一处原地改写都会立刻反映到全局，不能假设拿到的是快照。
- [内存有界优先于数据完整](/core/capture-data)：`lib/util/data-server.js:21-26` 把缓存定在 600 条、溢出 1800 条、单次上报 100 条，`lib/inspectors/data.js:8-11` 给请求与响应体设 2MB 上限、大对象 16MB。偶现请求能被存下来，但超阈正文只留元信息、旧会话按界淘汰，宁可少存也不撑爆常驻内存。
- [service 子进程隔离重活](/architecture/process-config)：`lib/service/index.js:1` 引入 `pfork.fork`，`:10` 把 `SCRIPT` 指向 `service.js`，`:51` 的 `loadService` 真正 fork 出子进程并缓存 `curChild`。SAZ 的 zip 解析、会话 gzip 落盘与 Composer 重放这类重活经 `sendToService` 转进去，不占主代理线程；`lib/service/index.js:58-60` 监听子进程 `close` 后置空 `curChild`，下次请求会重新拉起，子进程异常也不会拖垮抓包主链路。
- [约定优于配置](/modules/webui)：`biz/webui/lib/index.js:387-402` 的 `cgiHandler` 把 `req.path` 拼成 `../cgi-bin/xxx.js` 再 `require`，`get-data`、`get-matched-rules`、`sessions` 的文件名即接口名，新增一个查询能力放一个同名文件即可，不必登记路由表。例外是 `composer`：`biz/webui/lib/index.js:540` 单独注册 POST 路由，因为它要承载上传体并直接 `sendToService`（`:79-91`）转进子进程，不是纯查询。

四条原则拼起来正好是一条链：零复制优先解释「为什么内核与 UI 看到的内容天然一致」，内存有界优先解释「为什么缓存与正文都要封顶」，service 子进程隔离解释「为什么重活不占主代理线程」，约定优于配置解释「为什么新增查询只要放一个同名文件」。少任何一条，前面那些可复制的配置就退回到「照着抄」而不是「推得出」。

输入 → 动作 → 输出：输入一次被旁路采样的请求 `data` → `handleRequest` 补上 id 与版本后原地放进 `reqData[id]`、重活经 `sendToService` 转入子进程、CGI 按文件名取数 → 输出「内核与 UI 共读的同一份数据」与「不占主线程的 SAZ / 重放结果」。这条链也解释了为什么抓包列表、详情面板与导出内容能对得上：它们本来就读的是同一个对象，不是三份各自同步的副本。

为什么这样设计：零复制省掉了三处各自维护快照的同步成本，代价却是任何一处原地改写都会立刻反映到全局，不能假设拿到的是快照——这与「一致性」是同一个取舍的两面。service 子进程把 zip 解析、会话 gzip 落盘、Composer 重放这类可能长时间占用的活挪出去，子进程异常时 `close` 后置空 `curChild`、下次请求重新拉起，于是抓包主链路不会被一次失败的 SAZ 导入拖垮；若把这些活留在主线程，一次大文件解压就能让整个代理卡顿。

代价与边界：内存有界（600 条缓存、1800 条溢出、单次 100 条，以及 2MB 正文 / 16MB 大对象）意味着「宁可少存也不撑爆常驻内存」，偶现请求能被存下，但超阈正文只留元信息、旧会话按界淘汰。约定优于配置让新增查询只要放一个同名 CGI 文件即可，代价是接口散落在目录里、没有一张集中路由表能一眼看全，`composer` 这种要承载上传体的还得单独注册 POST 路由——便利与可发现性在这里是互换的。

类比：像仓库里只放一张原始单据（同一份 `data`），柜台、账本、快递都照它抄，谁改了这张单据所有人都立刻看到；重活则交给后场作坊（service 子进程），前厅照常接客，作坊临时关门也不影响前厅，下次有活再重新开门。

最小自验：对照「取数类按钮大多对应 `cgi-bin/` 下的同名文件（`get-data`、`get-matched-rules`、`sessions`），但 `composer` 是例外」这一句，把 `get-data` 与 `composer` 放一起看——前者是纯查询、按约定走文件，后者要上传体、转进子进程所以单独注册 POST；不用看源码就能自己说出「为什么偏偏它例外」。再对照「子进程 `close` 后置空 `curChild`」，就能理解为什么一次失败的重放不会让后续抓包一起停摆。

把四条原则按「数据面 / 进程面 / 接口面」归位会更清楚：零复制与内存有界都在管同一份 `data` 怎么存、存多少，service 子进程管重活放在哪个进程，约定优于配置管界面怎么找到这些能力。四者不重叠，所以调缓存阈值不必动 CGI，改一条查询也不必动缓存。

再把「一致性」这条往反面推一步：如果 `handleRequest` 改成给每处消费者克隆一份 `data`，列表、详情、导出就各自拿到独立快照，短期看更安全，却要新增一套「哪份是最新」的同步规则；一次请求头被 Composer 改过之后，三处到底以谁为准反而说不清。零复制把这个问题消解在最开始——大家读同一张单据，也一起承担「没有快照」的代价。同理，若把 600 条缓存当成可随手取消的口味问题，偶现请求确实不会被淘汰了，但常驻内存会随抓包时长无上限增长，最终拖垮的是整台开发机上的代理。

## 源码链路

按「入口 → 规则解析 → 应用点 → 回写/上报」展开，重点看同一份 `data` 如何被四处复用。

1. **入口 · 旁路采样**：`lib/inspectors/data.js:279-310` 包装 `stream.write`（`:281-302`）与 `stream.end`（`:303-310`），累加 `reqData.size`、触发 `updateEvent`，最后仍 `write.apply(this, arguments)` 原样透传，抓包不改道。见 [抓包数据的采集与上报](/core/capture-data)。
2. **规则解析 · 原地登记**：`lib/util/data-server.js:319-333` 的 `handleRequest` 分配 `data.id`、写入 `data.version`，把同一个 `data` 放进 `reqData[id]`，为后续按 id 查询与命中登记建立索引。见 [抓包数据的采集与上报](/core/capture-data)。
3. **应用点 · 保存与 SAZ 互操作**：`lib/service/service.js:96-115` 的 `saveSessions` 对会话 `gzip(JSON.stringify(sessions))` 后写入 `SAVED_SESSIONS_PATH`；`lib/service/extract-saz.js:108-278` 用 `new AdmZip(buffer)`（`:109`）解析 SAZ，`lib/service/generate-saz.js:105-181` 按 `getFiddler2Meta`（`:101`）渲染 `fiddlerMeta` 模板生成 Fiddler SAZ。见 [进程模型与配置系统](/architecture/process-config)。
4. **应用点 · 构造并回打自身代理**：`lib/service/composer.js:345-513` 的 `handleRequest` 解析 URL、头与 body；`lib/service/composer.js:519-524` 的 `setup` 把 `PROXY_OPTS` 设为 Whistle 自身 host 与 port，`:242-243` 令 `options.host` / `options.port` 指向它，于是重放请求重新走一遍规则链；`MAX_REQ_COUNT = 100`（`lib/service/composer.js:19,118-120`）由 `getReqCount` 钳制重放次数。见 [一次 HTTP 代理请求的旅程](/core/http-request)。
5. **回写/上报 · 轮询与流式响应**：`biz/webui/cgi-bin/get-data.js:60` 调 `proxy.getData(...)`（`lib/util/data-server.js:886`）返回抓包数据；前端 `biz/webui/htdocs/src/js/data-center.js:1157-1159` 把 `setTimeout(load, hasNewData ? 100 : 900)` 挂在下一次轮询上，有新数据就加快、空闲就放慢；`lib/service/compose-data.js:3-4` 用 `LRU({ max: 120, maxAge: 60000 })` 承载重放的流式响应。注意这是前端的 100/900 毫秒轮询，与服务端 `lib/service/data-center.js:8` 的 `MAX_COUNT = 100`（`:99` 用于裁剪已保存会话列表）不是一回事。见 [Web 管理界面](/modules/webui)。
6. **查询 · 命中规则与补详情**：`biz/webui/cgi-bin/get-matched-rules.js:6` 按 `testId` 调 `lib/util/data-server.js:632` 的 `proxy.getTestItem`，再把 `realUrl` 与 `rules` gzip 返回（`:10-13`）；`lib/util/data-server.js:624` 的 `getItem` 按 id 补单个请求详情并把 req/res 转 base64，`lib/util/data-server.js:886` 的 `getData` 才是主界面数据源。见 [规则引擎](/modules/rules-engine)。

把 1–6 收拢成「输入 → 动作 → 输出」：输入一次真实请求（被旁路采样）→ 分配 id、原地登记进 `reqData[id]`、按需要 gzip 落盘或经 SAZ 模板互操作、Composer 把构造请求回打自身代理、前端轮询取数、命中规则与补详情按 id 查询 → 输出「可反复重放且照常被抓包记录的会话」与「前端能看到的一致数据」。六步不是六个并列模块，而是同一份数据从采集到被界面读到的六个工位。

为什么这样设计：第 4 步把 `PROXY_OPTS` 设为 Whistle 自身 host 与 port，是整条链最反直觉也最关键的一处——重放若直连目标服务器，就会绕开规则链、也不再被抓包记录，前面辛苦保存的「现场」与新发出的请求就对不上了；回打自身代理让重放请求「照常走一遍规则链、照常命中规则、照常被采集」，调试者改的那几个请求头才真的生效，也才能在事后用 Test Rules 查它命中了哪几行。`MAX_REQ_COUNT = 100` 由 `getReqCount` 钳制重放次数，则是给这条「会自我增殖」的链路装一个闸门。

代价与边界：回打自身意味着一次重放会额外产生一条新的抓包记录，所以才需要 `fc:` 把它从业务流量里隔离出来；连发次数又受 100 次钳制，避免一次误操作把 600 条缓存直接打满。第 5 步还要注意前端的 100 / 900 毫秒轮询与服务端 `MAX_COUNT = 100` 不是一回事：一个决定「多久去问一次有没有新数据」，一个决定「已保存会话列表裁到多少条」，排查「数据没刷新」时把两个 100 混成一个就会走错方向。

类比：像把录好的带子不从播放器直接送到电视，而是重新塞回同一台录像机的输入口，于是它会被当成一次「新的录制」再走一遍所有处理电路；带子上因此又多了一段，得靠标签（`fc:`）把新旧分开。

最小自验：把第 4 步「把 `PROXY_OPTS` 设为 Whistle 自身 host 与 port」与第 6 步「按 `testId` 查命中规则」对照——前者决定重放请求会不会再走规则链，后者决定能不能查到它命中了哪几行；两件事一前一后，就能理解为什么重放之后还能用 Test Rules 查命中，而不必真的驱动浏览器。再把第 2 步「原地登记同一个 `data`」与第 5 步「前端轮询取数」对照，就能自证「列表、详情、导出天然一致」不是靠同步而是靠同源。

按 1→6 排查「保存 / 重放没生效」可以这样问：这次请求有没有被旁路采样记下来（第 1 步）→ 有没有分到 id、进没进 `reqData[id]`（第 2 步）→ 走的是 gzip 落盘还是 SAZ 模板、需不需要转进子进程（第 3 步）→ `PROXY_OPTS` 有没有指向自身代理、重放次数有没有被钳制（第 4 步）→ 前端轮询有没有把新数据取回来（第 5 步）→ 按 id 查命中与补详情有没有走对 `getItem` / `getData`（第 6 步）。逐段问下来，比反复点 Ctrl+S 有效得多。

六步与七段模板里「源码链路」一节是同一条链的两种粒度：模板给的是「入口 → 规则解析 → 应用点 → 回写/上报」的粗线，本篇细到旁路采样、原地登记、SAZ 互操作、回打自身代理、轮询取数、按 id 查询六个工位。其中第 4 步最容易被跳过——把 `PROXY_OPTS` 指向自身代理而不是目标服务器，正是「重放仍算一次真实请求」在链路上的落点；读的时候要特意停一下，别把它当成普通的「发一次 HTTP」扫过去。

## 边界与坑

- **缓存 600 条、溢出 1800 条、单次最多 100 条**：`docs/docs/cli.md:47` 的 `-R/--reqCacheSize` 标默认 600，源码 `lib/util/data-server.js:10-12` 再强制不低于 600，两者一致；`:21-26` 由此推出 `MAX_LENGTH = config.reqCacheSize`、`OVERFLOW_LENGTH = MAX_LENGTH * 3`、`COUNT = 100`（`:904` 在 `getData` 里钳制单次返回条数）。另有 `-F/--frameCacheSize` 官方 `docs/docs/cli.md:48` 写 512，被 `lib/util/data-server.js:14-16` 抬到 600，别和抓包条数混为一谈。超过界线的会话会被淘汰，不要把抓包列表当永久存储。
- **超过 2MB 的 body 只留元信息**：`lib/inspectors/data.js:8-11` 把请求体与响应体上限设为 2MB、大对象 16MB；`docs/docs/rules/enable.md:25` 的 `bigData` 可把抓包显示限制从 2M 放宽到 16M，超限内容仍不保证完整。
- **API 分页每次最多 120 条**：`lib/util/data-server.js:34` 的 `MAX_COUNT = 120`，`:36-42` 的 `formatApiOptions` 用上限钳制 `count`，批量拉取必须自行翻页。
- **Composer 界面历史 64 条、服务端 100 条**：`docs/docs/gui/composer.md:34` 写明界面最多保存 64 条，而 `lib/service/composer.js:24,88-90` 的 `MAX_HISTORY_LEN = 100` 才是服务端裁剪上限，两者不要混为一谈。
- **`proxy.getItem` 只用于[插件](/concepts/07-extension)按 id 补详情**：`lib/util/data-server.js:624` 的 `getItem` 返回单条并把 req/res 转成 base64，主界面数据来自 `lib/util/data-server.js:886` 的 `getData`（`biz/webui/cgi-bin/get-data.js:60` 调用）；误用 `getItem` 拉列表会拿不到分页与过滤结果。

- **容易以为 Import / Export 只是读写一份文本，其实 `.saz` 要走 zip 解压与 `fiddlerMeta` 模板**：正因为这类互操作是 CPU 与内存重活，才被 `sendToService` 转进 service 子进程，而不是在 CGI 里顺手处理。
- **容易以为 Composer 重放是直连目标服务器，其实它把 `PROXY_OPTS` 设为 Whistle 自身 host 与 port、回打自身代理端口**：所以重放请求会照常命中规则、照常被抓包记录，改过的请求头才真的生效。
- **容易以为「内核与 UI 读同一份 `data`」意味着各自拿到一份快照，其实那是同一个对象引用**：`handleRequest` 直接 `reqData[id] = data`、不做克隆，任何一处原地改写都会立刻反映到全局，不能假设列表里的条目是只读副本。
- **容易以为 Composer 界面历史 64 条与服务端 `MAX_HISTORY_LEN = 100` 是同一个上限，其实两者分属界面与服务端**：再叠上 `MAX_REQ_COUNT = 100` 钳制重放次数，「64 / 100 / 100」是三处含义不同的数字，别互相套用；更细的对照可见 [《概念精解 · 易混淆概念辨析》](/concepts/08-confusions)。

把这一节五条既有坑与上面四条辨析分开看，会更清楚该记什么：五条坑是官方或源码划定的事实边界（缓存条数、2MB 正文、120 条分页、64 / 100 条历史、`getItem` 的用途），照着改就能绕过；四条辨析是读者心里默认错的模型（导入导出是纯文本、重放直连目标、同一份 `data` 是快照、几处 100 是同一个上限）。前者是「怎么配才对」，后者是「这条链究竟怎么走」，后者只能靠把源码链路走通来纠正，光看配置文本改不出来。

## 小结

- 复现闭环是「抓包 Save → 导入导出 → Composer 编辑与重放」，SAZ 互操作让会话能在 Whistle 与 Fiddler 之间往返。
- 内核与 UI 读同一份 `data` 引用，一致性的代价是没有快照；600 条缓存、2MB 正文与 120 条分页都是有界设计。
- 重放不是直连目标，而是把构造好的请求回打 Whistle 自身代理端口，因此照常命中规则、照常被抓包记录。
- `test/units/composer.test.js` 直接 POST `cgi-bin/composer`，把手工流程固化成 82 个 units 中的可回归用例。
- CGI 文件名即接口名，命中规则、抓包数据、会话保存分别由 `get-matched-rules`、`get-data`、`sessions` 等约定式文件承接。
- 本篇为 [《弱网与异常注入：把偶发变成必现》](/scenarios/fault-injection) 准备了「真实请求可以被固化成可重复输入」这个前提：既然一次偶现流量能存成会话、改头改方法再连发，22 就顺势回答「那能不能不靠真实流量、主动把超时、错误码与限流也注入成必现」，把「复现现场」推进到「制造现场」。

## 下一步

[《弱网与异常注入：把偶发变成必现》](/scenarios/fault-injection)：能重放之后，下一步是主动制造可控的失败，看 `statusCode`、`reqDelay`、`resSpeed` 与 `chance` 过滤器如何把超时、错误码与限流变成可复制的规则。之所以紧接着读它，是因为 21 固定下来的始终是「那一次真实请求的原始输入」——它能反复回放现场，却不能凭空造出「请求发出后永远收不到结果」或「一半请求返回 500」这类现场里没发生过的失败；要验证客户端的容错与降级分支，就得从「回放」转向「主动注入」，这正是 22 用 `reqDelay`、`statusCode` 与 `chance` 补上的空白。
