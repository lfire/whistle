---
title: 源码阅读与调试路线
description: 四条阅读路线、调试开关、断点清单与测试体系，把「读哪里」变成可执行的顺序。
---

# 源码阅读与调试路线

读完前四层后，最常见的困境不是看不懂语法，而是改动一落地却不知道该从哪个文件开始追。本篇把仓库拆成四条互不重叠的阅读路线，每条给出文件顺序与它回答的问题，再补齐调试开关、断点清单和测试体系。所有引用均以 `guide` 分支 `3b85cebc4` 为准，路径为仓库相对路径；建议把仓库与文档并排打开，遇到行号就跳过去看一眼再回来。

## 四条阅读路线

四条路线各自闭合，不必按目录顺序通读。它们的区别在入口事件，而不在文件夹名称。

### 路线一 · 请求主链

回答「一次普通 HTTP 请求从进来到出去经过哪些函数」。顺序：`lib/index.js:36-60` 装配 Express 中间件链 → `lib/init.js` 归一化请求 → `biz/index.js` 处理 Web UI 与 CGI → `lib/inspectors/rules.js:153-214` 解析规则 → `lib/inspectors/req.js:456-612` 应用请求阶段改写 → `lib/handlers/http-proxy.js` 发起出站请求 → `lib/inspectors/data.js:185` 上报抓包。关键是记住「入口 → 中间件 → 规则 → 出站 → 抓包」这条链序，四类入口最终都汇入同一条 `app.use(mw.bind(proxyEvents))` 中间件链。

### 路线二 · HTTPS 解密链

回答「CONNECT 进来后凭什么决定解密」。顺序：`lib/tunnel.js:44` 的 `server.on('connect')` → `lib/tunnel.js:168-213` 的 `isIntercept()` 判定 → `lib/https/index.js:1184-1234` 的 `readOneChunk` 首包嗅探 → `lib/https/ca.js:47-49,566-570` 生成叶证书 → `lib/https/index.js:1105` 把解密后的明文重新 `server.emit('request')` → 回到路线一的 inspector 链。判定里 `disable.intercept`、`policy === 'capture'`、`hasCustomCerts()` 三个分支最值得细看，它们决定了「隧道直通」还是「中间人代签」。

### 路线三 · 规则链

回答「文本规则怎么变成 `req.rules` 上的字段」。顺序：`lib/rules/rules.js:48` 的 `VALUE_RE` 识别内嵌值 → `lib/rules/index.js` 解析规则文本 → `lib/inspectors/rules.js:12-45` 的 `resolveRules` 把结果挂到请求 → `lib/rules/protocols.js:18-48` 查协议表 → `lib/util/index.js:1406` 的 `getRuleValue` 取值 → `lib/inspectors/req.js:456` 与 `lib/inspectors/res.js:1163` 按阶段应用。规则引擎与规则应用是两件事，前者产出数据，后者消费数据，别混在一处找。

### 路线四 · 扩展链

回答「第三方插件怎么被拉起并拿到请求」。顺序：`bin/plugin.js:12,124-145` 定位与安装 → `lib/plugins/util.js:8-10` 校验命名 → `lib/plugins/get-plugins-sync.js:122,184-188` 读取 `whistleConfig` 与 `rules.txt` → `lib/plugins/index.js:620-670` 用 `p.fork` 拉起子进程 → `lib/plugins/load-plugin.js:1147-1186` 注入 `options` → `lib/plugins/load-plugin.js:2012-2031` 按 hook 头分发。这条线同时解释了为什么插件崩溃不会带走代理主进程。

## 调试与断点

`w2 run` 与 `w2 start` 是两种截然不同的运行方式。`w2 run` 走 `bin/whistle.js:106-112` 的 `runCallback`，前台运行、`debugMode` 生效、子进程 stdio 继承到当前终端，日志与断点都能直接看到；`w2 start` 走 `bin/whistle.js:113` 的 `startCallback`，由 `starting` 托管为 detached 后台进程，CLI 退出后业务进程仍在。`--inspect` 与 `--inspectBrk` 仅 `w2 run` 支持：`bin/whistle.js:93-103` 在 `start` / `restart` 收到这两个选项时直接报错退出，并提示改用 `w2 run`（选项定义在 `188-189` 行）。

`PFORK_MODE` 控制插件子进程形态：`inline` 让 `lib/plugins/index.js:632,657` 把插件跑在当前进程，便于单步；`bind` 由 `index.js:218` 在 `debugMode` 下自动设置。`w2 status` 读取 `~/.startingAppData`（`bin/util.js:124,145-171`）列出各实例的 PID、端口与 `storage`，多实例排错时先跑它。日志走 `lib/util/logger.js:8` 的 fatal / error / warn / info / debug 五级；`lib/util/perf.js:28-39` 统计 `httpQps`、`tunnelQps`、`wsQps`、`maxRss`、`cpuPercent`，判断性能问题时比猜更可靠。`--mode` 开关集中在 `lib/config.js:704-885`：`debug`、`capture`（816 行）、`strict`、`pureProxy`、`network`、`rules`、`plugins` 等可组合，705 行用 `|`、`,`、`&` 分隔多个模式。

### 断点建议清单

- `lib/index.js:40-60`：四类入口的装配点（request / connect / upgrade / TLS），先看中间件链怎么拼。
- `lib/tunnel.js:168-213`：解密判定 `isIntercept()`，HTTPS 抓不到明文时第一个该停的地方。
- `lib/https/index.js:1184-1234`：`readOneChunk` 首包嗅探，区分 HTTP、HTTP/2 与 TLS 握手首字节。
- `lib/inspectors/rules.js:29-45`：规则命中 `resolveRules`，确认 `req.rules` 是否被正确填充。
- `lib/inspectors/data.js:185`：抓包上报 `proxy.emit('request', ...)`，Network 空白时查这里。
- `lib/util/data-server.js:92-95`：`request` / `frame` 事件绑定缓存，是采集与展示之间的接缝。

前两个断点分别对应「入口」与「判定」，中间两个对应「规则」与「采集」，最后两个是旁路。按这个顺序单步一次，比读十遍静态代码更能建立时序感。

## 测试体系与最小复现

`npm test` 即 `npm run lintfix && node test/index.test.js`（`package.json` 的 scripts）：先用 eslint 自动修复，再跑主测试文件。`test/index.test.js:17` 读取 `test/units/` 下的全部用例，断言用 `should`（`test/index.test.js:7`）；覆盖率脚本 `npm run cov` 才走 tape 与 istanbul。fixtures 集中在 `test/assets/`：`certs/` 下有 `root.key`、`test.crt` 等证书，`files/` 与 `rules/` 提供规则素材，另有一个顶层 `test/rules.txt`。这些证书让 HTTPS 与 MITM 用例无需联网即可复现。

复现问题的最小做法是：从 `test/units/` 里挑一个最接近的用例（例如 `reqHeaders.test.js`）复制改名，只改请求 URL 与期望值，用 `startWhistle` 返回的 `proxy` 监听 `request` 观察数据，确认失败后再回到源码定位。这样既避免启动完整浏览器，也能把问题压缩到一条链路。`npm run dev` 是 `webpack --config ./biz/webui/htdocs/src/webpack.config -w`，只做前端资源的 watch 编译，改 `biz/webui/htdocs/src/` 下的界面代码时用它，与内核调试互不干扰。

写最小用例时建议把 `storage` 设成带前缀的独立目录，避免污染日常配置；证书与 fixtures 一律复用 `test/assets/` 的现成文件，不要自行签发。若问题只在高并发或长时间运行之后才出现，可以借助 `lib/util/perf.js` 的 QPS 与内存统计观察趋势，再决定是下断点还是加日志。这样整理出来的复现步骤能直接交给他人，在同一基线上验证，而不需要复述一长串环境差异。

## 阅读方法与常见问题

推荐三步法：先按事件入口找 handler（`server.on('request')` 在 `lib/index.js:209`、`connect` 在 `lib/tunnel.js:44`、`upgrade` 在 `lib/upgrade.js:180`），再沿 `req.rules` 找规则的应用点，最后用 `proxyEvents` 把抓包、插件、统计这些旁路串起来。要警惕大文件：`lib/util/index.js` 有 4047 行、`lib/util/common.js` 有 2271 行，`lib/plugins/load-plugin.js` 也有 2642 行，通读必然迷路；正确做法是按函数名或事件名做符号搜索，只读命中附近几十行。

另一条经验是区分「主干」与「旁路」：主干是请求必须经过的 inspector 与 handler，旁路是抓包、统计、插件这类通过 `proxyEvents` 广播的监听者。读主干时按调用栈自上而下推进，读旁路时按事件名反查所有 `proxy.on(...)` 的注册点，两种手法不要混用；一旦混用，很容易把只在旁路执行的逻辑误当成必经步骤。

::: cols 50|50
| 常见问题 | 首先检查的文件 |
|---|---|
| 规则写了没效果 | lib/inspectors/rules.js |
| HTTPS 抓不到明文 | lib/tunnel.js |
| 证书不受信任 | lib/https/ca.js |
| 插件没出现在列表 | lib/plugins/index.js |
| 界面无抓包数据 | lib/util/data-server.js |
| 改前端不生效 | biz/webui/htdocs/src/ |
:::

这张表不是完整索引，只是「第一跳」。每个文件里再按导出函数和事件名下断点，就能沿着路线一或路线二继续深入；若第一跳就对不上现象，多半是版本或 `--mode` 开关的差异，先核对基线再改代码。

## 小结

- 四条路线分别回答请求主链、HTTPS 解密、规则生效与插件扩展，入口事件各不相同但汇入同一条中间件链。
- 调试以 `w2 run` 为前台入口，`--inspect` 仅它支持；`PFORK_MODE`、`w2 status`、`--mode` 与 logger / perf 是主要观测手段。
- 六个断点按「入口 → 判定 → 规则 → 采集 → 缓存」排列，配合 `test/units/` 的最小用例可以逐段验证猜想。
- 面对数千行的大文件，用符号搜索代替通读，先按事件入口定位，再沿 `req.rules` 与 `proxyEvents` 顺延。

## 下一步

[《术语、路径与配置速查》](/advanced/reference)：把本篇出现的术语、路径、配置项与阈值收拢成一页可回查的表。
