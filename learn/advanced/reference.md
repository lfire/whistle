---
title: 术语、路径与配置速查
description: 把术语、源码路径、配置项、CLI 命令、阈值与内部头收拢成一页可回查的速查表。
---

# 术语、路径与配置速查

第五层的前两篇解决「动手」与「怎么读」，本篇只解决「忘了去哪查」。内容全部来自 `guide` 分支 `3b85cebc4`（v2.10.13）的当前源码——其后提交仅涉及文档站，业务源码零改动，行号与阈值仍然有效；按术语、路径、配置、命令、阈值与内部头分组，每组拆成小表并标注列宽，避免一张巨表把长短列挤在一起。默认值随版本可能调整，遇到不一致时以 `package.json` 与 `lib/config.js` 为最终依据。

> 本页是**速查表**：只给术语的一句话对齐与数值。若要建立完整理解（形象类比、设计取舍、易混淆辨析、工程实例），请看 [概念精解](/concepts/index)；那里另有 [全量术语索引](/concepts/glossary) 覆盖 360 余条。

## 术语速查

以下 27 条按主题拆成四张小表，读源码或读官方文档时用来对齐概念，不展开原理。

::: cols 26|74
| 术语 | 一句话解释 |
|---|---|
| 正向代理 | 代表客户端向目标发起请求 |
| CONNECT | 请求建立隧道的 HTTP 方法 |
| 隧道 | CONNECT 后的透明字节通道 |
| Upgrade | 请求切换协议的头部 |
| 101 | 协议切换成功的状态码 |
| 帧 | WebSocket 的最小数据单元 |
| SSE | 服务端单向推送的文本流 |
| PIPE | 把流交给插件处理的机制 |
:::

::: cols 26|74
| 术语 | 一句话解释 |
|---|---|
| MITM | 中间人代签证书解密流量 |
| SNI | TLS 握手里的域名扩展 |
| ALPN | 协商 h2 与 http1.1 的扩展 |
| SAN | 证书里的多域名扩展 |
| CA | 签发证书的信任根机构 |
| 根证书 | 需手动安装的自签 CA |
| 证书固定 | 客户端只认指定证书 |
| mTLS | 双向校验客户端证书 |
:::

::: cols 26|74
| 术语 | 一句话解释 |
|---|---|
| pfork | 拉起隔离子进程的模块 |
| cluster | 多 worker 分担同一端口 |
| inspector | 请求四阶段的中间件 |
| handler | 出站阶段的分发函数 |
| reqId | 单次请求的唯一编号 |
:::

::: cols 26|74
| 术语 | 一句话解释 |
|---|---|
| protocol | 规则里的操作名 |
| pattern | 规则里的匹配表达式 |
| Values | 可复用的键值素材 |
| Shadow Rules | 不落盘的临时规则 |
| plugin hook | 插件请求的分发入口 |
| CGI | Web UI 取数据的接口 |
:::

前两组是网络与 TLS 的领域词，对应第一层；后两组是 Whistle 自己的内核词，`pfork` 见 `lib/plugins/index.js:2`、`inspector` 见 `lib/inspectors/`、`reqId` 由 `lib/inspectors/rules.js:159` 生成。把「领域概念」与「实现命名」分开记，读代码时不会把 SNI 与 SAN 这类相邻缩写混用。

术语表按「领域词 / 内核词」分组，是为了和五层路径对齐：前两组对应领域基础与 TLS 章节，后两组对应进程模型、规则引擎与插件系统。遇到英文缩写先在这里确认中文含义，再回源码看它作为变量名出现在哪一段，比在数千行的工具文件里盲搜更有效；同一概念在文档与代码里往往用不同写法，先对齐称呼能省下大量来回跳转。

## 源码路径速查

按九个分组给出每类的主路径与次路径，均为仓库相对路径；需要精确到函数时再配合行号跳转。

::: cols 14|28|28|30
| 分组 | 主路径 | 次路径 | 职责 |
|---|---|---|---|
| 入口 | index.js | bin/whistle.js | npm 与 CLI 入口 |
| 协议 | lib/tunnel.js | lib/upgrade.js | CONNECT 与 Upgrade |
| 规则 | lib/rules/ | lib/inspectors/ | 解析与四阶段 |
| 证书 | lib/https/ca.js | bin/ca/ | 根 CA 与安装 |
| 插件 | lib/plugins/ | bin/plugin.js | 加载与安装 |
| UI | biz/webui/ | biz/webui/cgi-bin/ | 界面与 CGI |
| 工具 | lib/util/index.js | lib/util/common.js | 通用工具集 |
| 存储 | lib/config.js | lib/util/data-server.js | 配置与缓存 |
| 测试 | test/index.test.js | test/units/ | 用例集 |
:::

几个高频落点值得单独记：请求装配在 `lib/index.js:36-60`，解密判定在 `lib/tunnel.js:168-213`，规则命中在 `lib/inspectors/rules.js:29-45`，抓包上报在 `lib/inspectors/data.js:185`，缓存事件绑定在 `lib/util/data-server.js:92-95`，插件 hook 分发在 `lib/plugins/load-plugin.js:2012-2031`。`lib/util/index.js` 与 `lib/util/common.js` 都是数千行的大文件，只按符号检索，不要通读。

九个分组里，「入口」与「协议」决定请求从哪进来，「规则」与「证书」决定要不要解密、怎么改写，「插件」「UI」「工具」是外围能力，「存储」与「测试」支撑配置与验证。按这个层次记路径，比背目录树更稳；行号会随提交漂移，但 `lib/index.js:36`、`lib/tunnel.js:44` 这类函数名与事件名相对稳定，值得优先记住。

## 配置项与 CLI

### 配置项 · 网络与端口

::: cols 26|26|48
| 配置项 | 默认值 | 作用 |
|---|---|---|
| `port` | 8899 | 代理主端口 |
| `uiport` | 同 port | Web UI 端口 |
| `sockets` | 256 | 每域名 maxSockets |
| `timeout` | 360000(ms) | 连接空闲超时 |
| `host` | 不绑定 | 监听地址 |
| `httpPort` | 未启用 | 独立 HTTP 端口 |
| `httpsPort` | 未启用 | 独立 HTTPS 端口 |
| `socksPort` | 未启用 | SOCKSv5 端口 |
:::

### 配置项 · 存储与运行

::: cols 26|26|48
| 配置项 | 默认值 | 作用 |
|---|---|---|
| `storage` | 空 | 多实例隔离子目录 |
| `baseDir` | `~/.WhistleAppData` | 数据根目录 |
| `certDir` | 空 | 自定义证书目录 |
| `cluster` | 关闭 | 多 worker 分担 |
| `mode` | 空 | 模式开关组合 |
| `username` | 空 | UI 鉴权用户名 |
| `password` | 空 | UI 鉴权密码 |
| `reqCacheSize` | 600 | 抓包缓存条数 |
| `frameCacheSize` | 600 | 帧缓存条数 |
| `middlewares` | 空 | 启动中间件列表 |
:::

默认值主要取自 `package.json:7-9`（`port`、`sockets`、`timeout`）与 `lib/config.js:1035-1048`（`sockets` 到 agent 的换算）、`lib/util/data-server.js:10-35`（缓存下限）。`uiport` 默认等于 `port`（`lib/config.js:495`）；`httpPort`、`httpsPort`、`socksPort` 不传即不创建独立监听（`lib/index.js:96-124,151`）。

两个数值开关最易读错。`sockets=256` 不是监听端口数：`lib/config.js:1039-1048` 把它换算成 `HttpAgent` / `HttpsAgent` 的 `maxSockets`（每目标域名可复用的连接池上限），而 `:1046` 的 `disableAgent = !newAgentConf && !useAgent` 在默认路径把 agent 直接置为 `false`，以规避 Node 11 以上的连接缓存缺陷——即这个值默认并不生效，监听端口另由上面三个选项决定。`timeout=360000` 在 `bin/whistle.js:170` 的帮助里写作 request timeout，实际由 `lib/index.js:44-45` 写进 `server.timeout`（连接空闲超时）并把 `requestTimeout` 置 0，不是单个请求的总时限。

缓存也要两处对照：官方 CLI（`docs/docs/cli.md:47-48`、`bin/whistle.js:174-175`）把 `-R reqCacheSize` 标为 600、`-F frameCacheSize` 标为 512，但源码 `lib/util/data-server.js:10-16` 给两者都设了下限——`reqCacheSize < 600` 校正为 600，`frameCacheSize < 720` 校正为 600。所以 `-F` 的 512 不会生效，两条缓存实际都是 600 起步；命令行侧对应开关集中在 `bin/whistle.js:153-189`。

### CLI · 进程与状态

::: cols 20|44|36
| 命令 | 作用 | 要点 |
|---|---|---|
| `start` | 后台启动 | detached 常驻 |
| `stop` | 停止实例 | 可用 `-S` 指定 |
| `restart` | 重启实例 | 复用上次选项 |
| `run` | 前台运行 | 支持 `--inspect` |
| `status` | 查看运行实例 | 读 `~/.startingAppData` |
| `help` | 查看帮助 | 由 starting 提供 |
:::

### CLI · 配置与扩展

::: cols 20|44|36
| 命令 | 作用 | 要点 |
|---|---|---|
| `root` | 输出安装根目录 | 可带子路径 |
| `proxy` | 设置系统代理 | `proxy 0` 关闭 |
| `ca` | 安装管理根证书 | HTTPS 前置 |
| `install` | 安装插件 | 支持本地 tgz |
| `uninstall` | 卸载插件 | 按包名 |
| `use` | 加载规则文件 | 同 `add` |
| `exec` | 执行插件命令 | 注入 .bin |
:::

命令注册在 `bin/whistle.js:132-263`：`w2`、`whistle`、`wproxy` 三个 bin 都指向 `bin/whistle.js`（`package.json` 的 `bin` 字段）。`--config` 由 `index.js:79-83` 载入配置文件，`--inspect` 与 `--inspectBrk` 仅 `w2 run` 有效（`bin/whistle.js:93-103`）。`start` 与 `run` 的差别见源码阅读篇，这里不重复。

配置项的优先级值得单独留意：CLI 选项经 `bin/whistle.js:153-189` 解析后交给 `lib/config.js` 合并，`package.json` 提供兜底默认值，`--config` 载入的文件又会覆盖同名项；`storage` 一旦不同，规则、值与证书就分别落在不同子目录，多实例之间互不干扰。排查「改了没生效」时，先确认改动确实写进了当前实例的那一份配置，而不是另一个 `storage` 目录。

## 关键阈值与内部常量

### 关键阈值

下面这些数值都是硬边界而非可调优参数：越界后或丢数据、或回退透传、或拒绝请求。表内只留结论，机制与代价放在表后注记，便于一页查完再去深究。

::: cols 22|46|32
| 数值 | 含义 | 出处(短) |
|---|---|---|
| 600 条 | 请求抓包缓存上限 | `data-server.js:10,21` |
| 1800 条 | 溢出清理阈值(3×) | `data-server.js:22` |
| 100 条 | 单次拉取上限 | `data-server.js:26` |
| 100/900 ms | 有/无新数据轮询间隔 | `data-center.js:1159` |
| 1 MB | 单帧最大负载 | `util/index.js:4012` |
| 2 MB | 抓包请求/响应体 | `inspectors/data.js:9` |
| 16 MB | 大数据体上限 | `inspectors/data.js:11` |
| 256 KB | 规则 payload 上限 | `inspectors/rules.js:10` |
| 36 天 | 叶证书有效期 | `https/ca.js:49` |
| 22 s | 插件 ws 心跳 | `load-plugin.js:38` |
| 6 s | 插件发现刷新 | `plugins/index.js:36` |
:::

出处列是短相对路径，省略了 `lib/`、`biz/webui/htdocs/src/js/` 等前缀，完整路径见前文各表。600 / 1800 / 100 由 `lib/util/data-server.js:10-26` 共同决定：缓存水位 600，达到 `OVERFLOW_LENGTH = MAX_LENGTH * 3`（1800）触发溢出清理——前 `len - MAX_CACHE_SIZE`（1200）条强制淘汰，最新 `PRESERVE_LEN = 360` 条改用更长的 `MAX_CACHE_TIME` 保留（`:21-24,176-188`）；单次 `getData` 最多返回 `COUNT = 100` 条（`:904`），另有 `MAX_COUNT = 120`（`:34`）作为 `formatApiOptions` 的分页默认。前端 100 / 900ms 是 `biz/webui/htdocs/src/js/data-center.js:1157-1159` 的短轮询间隔（有新数据加快、空闲放慢），与 `lib/service/data-center.js:8` 的 `MAX_COUNT = 100`（临时文件批量上限）是两回事，两个同名 `data-center.js` 不可混为一谈。

1MB 帧对应 `MAX_FRAME_PAYLOAD`，定义在 `lib/util/index.js:4012`，`lib/inspectors/data.js:13` 只是引用；2MB 体与 16MB 大数据分别是 `MAX_REQ_BODY_SIZE` / `MAX_RES_BODY_SIZE`（`:9-10`）与 `BIG_DATA_SIZE`（`:11`），都在 `lib/inspectors/data.js` 定义，且 `--mode strict` 下 2MB 会收紧到 256KB。36 天是叶证书：`lib/https/ca.js:558-573` 的短周期分支取 `notBefore = now - 7 天`、`notAfter = now + 36 天`，为绕开浏览器对长有效期证书的限制；根证书走另一分支（`notBefore = now - 1 年`、`notAfter = now + 10 年`），不要混写。22s 是 `lib/plugins/load-plugin.js:1158-1160` 的 `socket.ping()` 心跳间隔，用来保活插件 ws 连接；6s 是 `lib/plugins/index.js:544-550` 的 `setTimeout(refreshPlugins, INTERVAL)`，插件目录改动靠它重新发现，两者一个管连接、一个管目录。

### 内部头与常量

```js
// lib/config.js:63-108 · 内部头与常量（节选）
config.WHISTLE_POLICY_HEADER = 'x-whistle-policy';
config.HTTPS_FIELD = common.HTTPS_FIELD; // x-whistle-https-request
config.CLIENT_INFO_HEADER = 'x-whistle-client-info-' + uid;
config.PLUGIN_HOOK_NAME_HEADER = 'x-whistle-plugin-hook-name_';
config.WEBUI_PATH = '/.whistle-path.5b6af7b9884e1165/';
```

::: cols 40|60
| 名称 | 说明 |
|---|---|
| x-whistle-policy | 隧道与拦截策略标记 |
| x-whistle-https-request | HTTPS 请求标记 |
| x-whistle-client-info-* | 客户端 IP 与端口 |
| CLIENT_INFO_HEADER | 上者的常量名 |
| WEBUI_PATH | 内部 UI 路径前缀 |
:::

这些头定义在 `lib/config.js:63-108`。`CLIENT_INFO_HEADER`、`SHOW_LOGIN_BOX`、`DISABLE_RULES_HEADER` 等多数带 `+ uid` 后缀（78-84 行），`uid` 由 `lib/config.js:29` 用时间戳与进程号生成，作用是多实例并存时避免请求串台；`PLUGIN_HOOKS` 里的各项同样带 uid（85-107 行）。`x-whistle-plugin-hook-name_` 由 `lib/plugins/load-plugin.js:851-853` 读取后交给 `2012-2031` 的 switch 分发。`x-whistle-https-request` 的真实值来自 `lib/util/common.js:182`，由 `lib/util/http-mgr.js:132` 写入。

本页所有数值与行号以 `guide` 分支 `3b85cebc4`（v2.10.13）为准；升级版本后请重新对照 `package.json` 与 `lib/config.js`。

## 小结

本页把五层研读所需的术语、路径、配置、命令与阈值收拢成一页可回查的表，[回到首页](/) 可重新选择学习路径。
