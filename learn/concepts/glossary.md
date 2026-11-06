---
title: 全量术语索引
description: 把全站专业名词收成八类速查表，附缩写全称、内部头与数值阈值，可随时回查。
---

# 全量术语索引

本篇是「概念精解」板块的字典页，目标只有一个：让工程里出现过的每一个专业名词都能被一句话定位，并顺着链接回到讲透它的那一篇。查法有三种——按分类查，八张表按「代理入口 → 报文连接 → 证书 PKI → 运行时 → 抓包帧 → 规则 DSL → 扩展工程 → 内部常量」排列；按主题跳转，表格末列的站内链接直达 `/concepts/01-proxy` 至 `/concepts/09-walkthrough` 对应篇；按缩写回查，后文「按字母 / 缩写查」给出英文全称与中文，内部头与阈值另有两张速查。

与 [《术语、路径与配置速查》](/advanced/reference) 的分工要说清：那一页是第五层的「忘了一串数字去哪查」，按配置项、CLI 命令与阈值分组，篇幅克制；本篇是概念词典，覆盖面优先、条目远多，每条都带一句话定义与详解跳转，但**不**重复罗列命令语法与默认值的推导过程。遇到「这个数是多少」查那一页，遇到「这个名词是什么意思」查本篇。

表格「源码 / 文档落点」列沿用站内速查惯例的短相对路径（省略 `lib/`、`lib/inspectors/`、`biz/webui/htdocs/src/js/` 等前缀），例如 `data.js:279` 的完整写法是 `lib/inspectors/data.js:279`。所有引用均为仓库相对路径加行号，不含本机绝对路径；行号以 `guide` 分支 v2.10.13 为准，升级后请用函数名与事件名作锚点重新对照。末列编号对应：01 代理、02 HTTP、03 TLS、04 运行时、05 抓包、06 规则、07 扩展、08 易混淆、09 贯通。

## 一、代理与流量入口

::: cols 20|38|22|20
| 名词 | 一句话定义 | 源码/文档落点 | 详解篇 |
|---|---|---|---|
| 正向代理 | 代表客户端向源站发请求 | proxy-basics.md | [01](/concepts/01-proxy) |
| 反向代理 | 代表源站接收客户端请求 | README.md:17 | [01](/concepts/01-proxy) |
| 隧道代理 | 用 CONNECT 透传字节流 | tunnel.js:44 | [01](/concepts/01-proxy) |
| CONNECT | 请求建立隧道的方法 | tunnel.js:44 | [01](/concepts/01-proxy) |
| SOCKSv5 | 会话层代理协议 | index.js:182 | [01](/concepts/01-proxy) |
| PAC | 自动代理配置脚本 | rules/index.js:264 | [01](/concepts/01-proxy) |
| 系统代理 | 操作系统级代理设置 | bin/whistle.js:153 | [01](/concepts/01-proxy) |
| 上游代理 | 代理再转发给下一跳 | tunnel.js:501 | [01](/concepts/01-proxy) |
| 隧道 | CONNECT 后的透明字节通道 | tunnel.js:75 | [01](/concepts/01-proxy) |
| `tunnel://` | 内核给隧道的伪 URL | tunnel.js:75 | [01](/concepts/01-proxy) |
| 独立 HTTP 端口 | 单独监听的 httpPort | index.js:96 | [01](/concepts/01-proxy) |
| 独立 HTTPS 端口 | 单独监听的 httpsPort | index.js:96 | [01](/concepts/01-proxy) |
| socksPort | SOCKS 监听端口 | index.js:151 | [01](/concepts/01-proxy) |
| uiport | Web UI 监听端口 | config.js:495 | [01](/concepts/01-proxy) |
| port | 代理主端口默认 8899 | package.json:7 | [01](/concepts/01-proxy) |
| host | 监听绑定地址 | config.js:954 | [01](/concepts/01-proxy) |
| isIntercept | 是否解密隧道的总闸 | tunnel.js:202 | [01](/concepts/01-proxy) |
| 纯透传 | 不解密直接对拼字节流 | tunnel.js:304 | [01](/concepts/01-proxy) |
| rollBackTunnel | 首包识别失败后回退 | tunnel.js:276 | [01](/concepts/01-proxy) |
| setEstablished | 先回最简 200 应答 | util/index.js:373 | [01](/concepts/01-proxy) |
| 策略头 | 逐条控制隧道的内部头 | tunnel.js:144 | [01](/concepts/01-proxy) |
| CRONET_RE | 拦下 Cronet UA 的正则 | tunnel.js:26 | [01](/concepts/01-proxy) |
| SYS_HOST_RE | 放行系统域名的正则 | tunnel.js:27 | [01](/concepts/01-proxy) |
| Proxifier | 特定客户端放行场景 | tunnel.js:210 | [01](/concepts/01-proxy) |
| Web 端口 | 80/443 或自定义拦截 | tunnel.js:188 | [01](/concepts/01-proxy) |
| 客户端信息 | IP 与端口解析结果 | tunnel.js:83 | [01](/concepts/01-proxy) |
| Composer | 构造并回打请求的界面 | service/composer.js:19 | [07](/concepts/07-extension) |
| weinre | 远程调试服务 | upgrade.js:139 | [07](/concepts/07-extension) |
| 约定式路由 | CGI 文件名即接口名 | get-data.js:28 | [07](/concepts/07-extension) |
:::

这一类回答「流量从哪进来」。`lib/tunnel.js:44` 注册的 `connect` 事件是 HTTPS 与 WebSocket 代理的共用入口，而 `lib/index.js:96-151` 的三个独立端口、`lib/index.js:182` 的 SOCKS 握手各走一条支线；把「解密」与「透传」当成两种能力档位，而不是两种代理，是读这一类的关键。

## 二、HTTP 报文与连接

::: cols 20|38|22|20
| 名词 | 一句话定义 | 源码/文档落点 | 详解篇 |
|---|---|---|---|
| 请求行 | 方法 URI 版本三元组 | https/index.js:1117 | [02](/concepts/02-http) |
| 状态行 | 版本 状态码 短语 | https/index.js:1117 | [02](/concepts/02-http) |
| HTTP_RE | 识别明文首包的正则 | https/index.js:1117 | [02](/concepts/02-http) |
| HTTP2_RE | 识别 h2c preface 正则 | https/index.js:1118 | [02](/concepts/02-http) |
| CONNECT_RE | 识别 CONNECT 方法正则 | https/index.js:1119 | [02](/concepts/02-http) |
| Header | 报文键值对集合 | req.js:465 | [02](/concepts/02-http) |
| Host | 目标主机头 | biz/index.js:34 | [02](/concepts/02-http) |
| content-length | 正文长度头 | init.js:106 | [02](/concepts/02-http) |
| content-encoding | 压缩方式头 | data.js:305 | [02](/concepts/02-http) |
| chunked | 分块传输编码 | init.js:106 | [02](/concepts/02-http) |
| keep-alive | 连接复用机制 | config.js:1041 | [02](/concepts/02-http) |
| Upgrade | 请求切换协议的头 | upgrade.js:179 | [02](/concepts/02-http) |
| 101 | 协议切换成功状态码 | https/index.js:800 | [02](/concepts/02-http) |
| 101 应答 | 本地构造的切换响应 | https/index.js:153 | [02](/concepts/02-http) |
| Sec-WebSocket-Key | 握手校验随机值 | https/index.js:153 | [02](/concepts/02-http) |
| Sec-WebSocket-Accept | 握手校验应答值 | https/index.js:156 | [02](/concepts/02-http) |
| fullUrl | 还原后的完整请求 URL | biz/index.js:34 | [02](/concepts/02-http) |
| getFullUrl | 代理 URL 还原函数 | util/index.js:713 | [02](/concepts/02-http) |
| parseUrl | URL 解析工具 | rules.js:44 | [02](/concepts/02-http) |
| req / res | 请求与响应对象 | init.js:157 | [02](/concepts/02-http) |
| IncomingMessage | Node 请求对象类型 | init.js:157 | [04](/concepts/04-runtime) |
| ServerResponse | Node 响应对象类型 | init.js:160 | [04](/concepts/04-runtime) |
| writeHead | 写状态行与响应头 | res.js:1239 | [02](/concepts/02-http) |
| flushHeaders | 立即刷新响应头 | https/index.js:1094 | [02](/concepts/02-http) |
| gzip | HTTP 压缩编码 | get-data.js:28 | [02](/concepts/02-http) |
| sendGzip | 压缩 JSON 响应工具 | get-data.js:28 | [02](/concepts/02-http) |
| XFF | 来源 IP 转发头 | config.js:68 | [02](/concepts/02-http) |
| UA | 客户端标识头 | tunnel.js:199 | [02](/concepts/02-http) |
| ETag | 资源缓存校验标签 | plugins/index.js:973 | [02](/concepts/02-http) |
| CORS | 跨域资源共享 | req.js:472 | [02](/concepts/02-http) |
:::

这一类最容易被误读的是 `content-length`：`lib/init.js:106-112` 在包装流时直接删掉它，因为解压、改写、重压缩后长度必然变化，Node 会改用分块传输。另一个高频点是 `lib/https/index.js:1117-1119` 的三条正则，它们决定首包被判定为明文 HTTP、h2c 还是 CONNECT，方向读反会把整条解密链弄反。

## 三、TLS / 证书 / PKI

::: cols 20|38|22|20
| 名词 | 一句话定义 | 源码/文档落点 | 详解篇 |
|---|---|---|---|
| TLS | 传输层加密协议 | tls-mitm.md | [03](/concepts/03-tls) |
| SSL | TLS 的前身旧称 | tls-mitm.md | [03](/concepts/03-tls) |
| MITM | 两段握手换出中间明文 | tls-mitm.md | [03](/concepts/03-tls) |
| 两段 TLS | 入站伪造出站原生 | https/index.js:1102 | [03](/concepts/03-tls) |
| 信任锚 | 系统预置的根 CA | tls-mitm.md | [03](/concepts/03-tls) |
| 证书链 | 叶到根的验签链 | tls-mitm.md | [03](/concepts/03-tls) |
| 根 CA | 自签并被信任的签发根 | ca.js:580 | [03](/concepts/03-tls) |
| 根证书 | 十年有效的自签证书 | ca.js:565 | [03](/concepts/03-tls) |
| 根私钥 | 明文落盘的签发私钥 | ca.js:410 | [03](/concepts/03-tls) |
| 中间 CA | 根与叶之间的签发层 | tls-mitm.md | [03](/concepts/03-tls) |
| 叶证书 | 按域名现签的站点证书 | ca.js:582 | [03](/concepts/03-tls) |
| 自签证书 | 由自身私钥签发的证书 | ca.js:543 | [03](/concepts/03-tls) |
| SNI | 握手里明文的目标域名 | https/index.js:1295 | [03](/concepts/03-tls) |
| checkSNI | 从 ClientHello 取域名 | https/index.js:1295 | [03](/concepts/03-tls) |
| SAN | 证书里的多域名扩展 | ca.js:241 | [03](/concepts/03-tls) |
| CN | 证书通用名字段 | ca.js:484 | [03](/concepts/03-tls) |
| ALPN | 协商 h2 或 http/1.1 | h2.js:10 | [03](/concepts/03-tls) |
| h2 | 基于 TLS 的 HTTP/2 | h2.js:10 | [03](/concepts/03-tls) |
| h2c | 明文 HTTP/2 | https/index.js:1118 | [03](/concepts/03-tls) |
| mTLS | 双向校验客户端证书 | tls-mitm.md | [03](/concepts/03-tls) |
| 证书固定 | 客户端写死预期证书 | tls-mitm.md | [03](/concepts/03-tls) |
| pinning | 证书固定的英文叫法 | tls-mitm.md | [08](/concepts/08-confusions) |
| PKI | 公钥基础设施体系 | tls-mitm.md | [03](/concepts/03-tls) |
| PEM | Base64 文本证书编码 | ca.js:111 | [03](/concepts/03-tls) |
| DER | 二进制证书编码 | tls-mitm.md | [03](/concepts/03-tls) |
| PFX | PKCS#12 打包格式 | create-cert.js | [03](/concepts/03-tls) |
| RSA | 非对称加密算法 | ca.js:42 | [03](/concepts/03-tls) |
| RSA 2048 | 根密钥固定长度 | ca.js:42 | [03](/concepts/03-tls) |
| SHA-256 | 证书签名摘要算法 | ca.js:543 | [03](/concepts/03-tls) |
| SHA-1 | 叶证书序列号摘要 | ca.js:207 | [03](/concepts/03-tls) |
| ECDSA | 兼容 Android 的签名 | emudhra.js:26 | [03](/concepts/03-tls) |
| cA | 是否可作 CA 的扩展 | ca.js:227 | [03](/concepts/03-tls) |
| keyUsage | 密钥用途扩展 | ca.js:510 | [03](/concepts/03-tls) |
| extKeyUsage | 扩展密钥用途 | ca.js:510 | [03](/concepts/03-tls) |
| AKI | 授权密钥标识符 | ca.js:255 | [03](/concepts/03-tls) |
| nsCertType | 旧式证书类型扩展 | ca.js:530 | [03](/concepts/03-tls) |
| 序列号 | 证书唯一编号 | ca.js:207 | [03](/concepts/03-tls) |
| validity | 证书有效期区间 | ca.js:565 | [03](/concepts/03-tls) |
| notBefore / notAfter | 生效与失效时间 | ca.js:566 | [03](/concepts/03-tls) |
| SNICallback | 按域名选安全上下文 | ca.js:616 | [03](/concepts/03-tls) |
| createSecureContext | 生成 TLS 安全上下文 | ca.js:620 | [03](/concepts/03-tls) |
| _ctx | 按 SNI 复用的上下文 | ca.js:618 | [03](/concepts/03-tls) |
| node-forge | 纯 JS 证书生成库 | ca.js:1 | [03](/concepts/03-tls) |
| ClientHello | 握手首个客户端报文 | https/index.js:1295 | [03](/concepts/03-tls) |
| ContentType 22 | TLS 握手记录首字节 | https/index.js:1232 | [03](/concepts/03-tls) |
| rejectUnauthorized | 是否校验源站证书 | config.js:65 | [03](/concepts/03-tls) |
| requestCert | 请求客户端证书标志 | ca.js:583 | [03](/concepts/03-tls) |
| servername | SNI 回调的域名参数 | ca.js:616 | [03](/concepts/03-tls) |
| getDomain | 通配域名归并函数 | ca.js:135 | [03](/concepts/03-tls) |
| checkCertificate | 启动时根证书自检 | ca.js:111 | [03](/concepts/03-tls) |
| createSelfCert | 现签叶证书函数 | ca.js:205 | [03](/concepts/03-tls) |
| custom_certs | 用户证书目录 | ca.js:347 | [03](/concepts/03-tls) |
| cachePairs | 签发结果 LRU 缓存 | ca.js:39 | [03](/concepts/03-tls) |
| certsCache | 下载证书 LRU 缓存 | ca.js:40 | [03](/concepts/03-tls) |
| remoteCerts | 动态证书 LRU 缓存 | ca.js:41 | [03](/concepts/03-tls) |
| rootca.pro | 根证书下载虚域名 | config.js:37 | [03](/concepts/03-tls) |
:::

证书体系几乎全部集中在 `lib/https/ca.js` 一个文件：根 CA 在 `ca.js:580` 启动时就绪，叶证书由 `getOrCreateCert`（`:582-607`）按 SNI 现签，`SNICallback`（`:616-624`）把 `SecureContext` 接进握手。请把「根证书十年、叶证书 36 天」与「入站伪造、出站原生」两组对照记牢，前者是有效期分档，后者是两段独立 TLS 的分工。

## 四、Node 运行时与进程

::: cols 20|38|22|20
| 名词 | 一句话定义 | 源码/文档落点 | 详解篇 |
|---|---|---|---|
| Node.js | JavaScript 运行时环境 | package.json:77 | [04](/concepts/04-runtime) |
| cluster | 多 worker 分担同端口 | index.js:199 | [04](/concepts/04-runtime) |
| worker | cluster 拉起的子进程 | index.js:99 | [04](/concepts/04-runtime) |
| pfork | 拉起隔离子进程的模块 | index.js:17 | [04](/concepts/04-runtime) |
| 子进程 | 按功能隔离的独立进程 | service/index.js:51 | [04](/concepts/04-runtime) |
| CLI 进程 | 短命的命令行进程 | bin/whistle.js:132 | [04](/concepts/04-runtime) |
| detached 进程 | 常驻后台业务进程 | orientation.md | [04](/concepts/04-runtime) |
| IPC | 进程间消息通道 | service/index.js:61 | [04](/concepts/04-runtime) |
| PID | 进程标识符 | config.js:29 | [04](/concepts/04-runtime) |
| uid | 多实例隔离后缀 | config.js:29 | [04](/concepts/04-runtime) |
| EventEmitter | 事件发射器基类 | index.js:39 | [04](/concepts/04-runtime) |
| proxyEvents | 全局事件总线实例 | index.js:39 | [04](/concepts/04-runtime) |
| Stream | Node 流抽象 | init.js:159 | [04](/concepts/04-runtime) |
| Readable / Writable | 可读与可写流 | init.js:159 | [04](/concepts/04-runtime) |
| Duplex | 双向流 | init.js:159 | [04](/concepts/04-runtime) |
| Transform | 转换流基类 | req.js:581 | [04](/concepts/04-runtime) |
| Buffer | 二进制数据容器 | data.js:26 | [04](/concepts/04-runtime) |
| pipe | 流对接方法 | res.js:75 | [04](/concepts/04-runtime) |
| 背压 | 下游拥塞暂停上游 | res.js:648 | [04](/concepts/04-runtime) |
| highWaterMark | 流缓冲水位线 | res.js:648 | [04](/concepts/04-runtime) |
| drain | 缓冲清空事件 | res.js:69 | [04](/concepts/04-runtime) |
| EventLoop | 事件循环 | process-config.md | [04](/concepts/04-runtime) |
| setInterval / unref | 定时器与不阻塞退出 | ca.js:86 | [04](/concepts/04-runtime) |
| setTimeout | 延时调度 | data-center.js:1159 | [04](/concepts/04-runtime) |
| unhandledRejection | 未处理 Promise 拒绝 | index.js:277 | [04](/concepts/04-runtime) |
| uncaughtException | 未捕获异常兜底 | index.js:278 | [04](/concepts/04-runtime) |
| LRU | 最近最少使用缓存 | https/index.js:8 | [04](/concepts/04-runtime) |
| lru-cache | LRU 依赖包 | https/index.js:8 | [04](/concepts/04-runtime) |
| config 单例 | 就地扩展的配置对象 | config.js:16 | [04](/concepts/04-runtime) |
| middlewares | 中间件数组 | index.js:40 | [04](/concepts/04-runtime) |
| Express | Web 应用框架 | index.js:37 | [04](/concepts/04-runtime) |
| app.use | 注册中间件 | index.js:51 | [04](/concepts/04-runtime) |
| next() | 移交下一个中间件 | init.js:157 | [04](/concepts/04-runtime) |
| bind() | 绑定中间件 this | index.js:51 | [04](/concepts/04-runtime) |
| Agent | HTTP 连接代理对象 | config.js:1047 | [04](/concepts/04-runtime) |
| maxSockets | agent 最大连接数 | config.js:1040 | [04](/concepts/04-runtime) |
| httpAgent / httpsAgent | 出站连接代理 | config.js:1047 | [04](/concepts/04-runtime) |
| net.Socket | 裸 TCP 套接字 | tunnel.js:596 | [04](/concepts/04-runtime) |
| tls.connect | TLS 客户端连接 | https/index.js:557 | [04](/concepts/04-runtime) |
| http.request | 原生 HTTP 请求 | res.js:641 | [04](/concepts/04-runtime) |
| require / module.exports | 模块加载与导出 | index.js:40 | [04](/concepts/04-runtime) |
| storage | 多实例隔离目录 | config.js:1067 | [04](/concepts/04-runtime) |
| baseDir | 数据根目录 | config.js:148 | [04](/concepts/04-runtime) |
:::

这一类的两个命名陷阱值得单独记：`lib/init.js` 不是启动初始化，而是每请求中间件；`config.sockets = 256` 不是监听端口数，而是 `HttpAgent` 的 `maxSockets`，且 `lib/config.js:1046` 默认把 agent 关掉以规避 Node 11 以上的连接缓存缺陷。

## 五、抓包数据面与帧

::: cols 20|38|22|20
| 名词 | 一句话定义 | 源码/文档落点 | 详解篇 |
|---|---|---|---|
| data 对象 | 单次会话抓包记录 | data.js:156 | [05](/concepts/05-capture) |
| reqId | 会话唯一编号 | rules.js:159 | [05](/concepts/05-capture) |
| reqEmitter | 每请求专属发射器 | data.js:185 | [05](/concepts/05-capture) |
| 事件总线 | proxy 上的广播通道 | index.js:39 | [05](/concepts/05-capture) |
| request 事件 | 登记会话的广播 | data.js:185 | [05](/concepts/05-capture) |
| send / response | 发出与响应事件 | data.js:430 | [05](/concepts/05-capture) |
| end / abort | 结束与中断事件 | data.js:405 | [05](/concepts/05-capture) |
| 旁路采样 | 覆盖写入方法取样 | data.js:279 | [05](/concepts/05-capture) |
| joinBuffer | 拼接数据块工具 | data.js:26 | [05](/concepts/05-capture) |
| reqData / resData | 请求响应元信息 | data.js:156 | [05](/concepts/05-capture) |
| size | 累计正文长度 | data.js:25 | [05](/concepts/05-capture) |
| unzipBody | 按编码解压正文 | data.js:21 | [05](/concepts/05-capture) |
| ttfb | 首字节时间 | data.js:164 | [05](/concepts/05-capture) |
| SSE | 服务端单向推送流 | data.js:98 | [05](/concepts/05-capture) |
| SSE_SEP | SSE 分帧分隔符 | data.js:64 | [05](/concepts/05-capture) |
| text/event-stream | SSE 内容类型 | data.js:339 | [05](/concepts/05-capture) |
| 帧 | WebSocket 最小数据单元 | tunnel-websocket.md | [05](/concepts/05-capture) |
| ws-parser | WebSocket 帧解析依赖 | socket-mgr.js:291 | [05](/concepts/05-capture) |
| getReceiver / getSender | 帧收发器构造 | socket-mgr.js:291 | [05](/concepts/05-capture) |
| frameScript | 单帧改写脚本 | socket-mgr.js:657 | [05](/concepts/05-capture) |
| frameCtx | 帧脚本上下文 | socket-mgr.js:657 | [05](/concepts/05-capture) |
| PING / PONG | 22 秒心跳控制帧 | socket-mgr.js:11 | [05](/concepts/05-capture) |
| PAUSE_STATUS | 暂停帧的状态码 | socket-mgr.js:13 | [05](/concepts/05-capture) |
| IGNORE_STATUS | 丢弃帧的状态码 | socket-mgr.js:14 | [05](/concepts/05-capture) |
| MAX_COMPOSE_FRAME_COUNT | 分片拼接上限 5 | socket-mgr.js:15 | [05](/concepts/05-capture) |
| MAX_FRAME_PAYLOAD | 单帧 1MB 截断 | util/index.js:4012 | [05](/concepts/05-capture) |
| framesCache | 帧有界缓存数组 | data-server.js:86 | [05](/concepts/05-capture) |
| framesMap | 按 reqId 索引帧 | data-server.js:342 | [05](/concepts/05-capture) |
| conns | 按 reqId 的连接上下文 | socket-mgr.js:10 | [05](/concepts/05-capture) |
| socket-mgr | 连接与帧处理中心 | socket-mgr.js:764 | [05](/concepts/05-capture) |
| handleConnect | 连接分发入口 | socket-mgr.js:764 | [05](/concepts/05-capture) |
| handleClose | 两侧关闭才收尾 | socket-mgr.js:28 | [05](/concepts/05-capture) |
| customParser | 插件自定义帧解析器 | socket-mgr.js:768 | [05](/concepts/05-capture) |
| enable://inspect | 开启抓帧的指令 | tunnel.js:312 | [05](/concepts/05-capture) |
| 有界缓存 | ids / reqData / frames | data-server.js:84 | [05](/concepts/05-capture) |
| clearCache | 每 6 秒淘汰旧会话 | data-server.js:147 | [05](/concepts/05-capture) |
| getData | 单次拉取抓包数据 | get-data.js:60 | [05](/concepts/05-capture) |
| hasNew | 是否有新数据标记 | data-center.js:1158 | [05](/concepts/05-capture) |
| 短轮询 | 100/900ms 自适应取数 | data-center.js:1159 | [05](/concepts/05-capture) |
| 原地更新 | UI 读同一对象引用 | data-server.js:319 | [05](/concepts/05-capture) |
| toBase64String | 返回前转 base64 | data-server.js:216 | [05](/concepts/05-capture) |
| checkDataChanged | 前端比对修改戳 | data-center.js:903 | [05](/concepts/05-capture) |
| procData | 每 3 秒性能统计 | perf.js | [05](/concepts/05-capture) |
| abort | 断开请求与帧连接 | cgi-bin/abort.js:18 | [05](/concepts/05-capture) |
:::

抓包是旁路：覆盖 `write` / `end` 只做采样、不阻塞转发（`lib/inspectors/data.js:279-323`）；缓存是自实现的 `ids[]` + `reqData{}` + `framesCache`，源码里没有 LRU 结构；上报是 gzip 压缩的 HTTP JSON 短轮询，不是 SSE 也不是 WebSocket。这三点合起来，解释了界面为何「所见即实际发出的改写后字节」。

## 六、规则 DSL

::: cols 20|38|22|20
| 名词 | 一句话定义 | 源码/文档落点 | 详解篇 |
|---|---|---|---|
| pattern | 规则里的匹配表达式 | rules.js:1773 | [06](/concepts/06-rules) |
| operation | 带协议前缀的指令 | rules.js:1782 | [06](/concepts/06-rules) |
| protocol | 规则里的操作名 | protocols.js:1 | [06](/concepts/06-rules) |
| lineProps | 修饰匹配行为的属性 | rules.js:1400 | [06](/concepts/06-rules) |
| filters | 编译后的过滤条件数组 | rules.js:1549 | [06](/concepts/06-rules) |
| Values | 可复用键值素材 | rules.js:43 | [06](/concepts/06-rules) |
| Shadow Rules | 不落盘的临时规则 | rules/util.js:89 | [06](/concepts/06-rules) |
| Default / Mock | 规则集叠加顺序 | rules/util.js:89 | [06](/concepts/06-rules) |
| includeFilter | 必须命中的过滤条件 | protocols.js:151 | [06](/concepts/06-rules) |
| excludeFilter | 命中即排除的条件 | protocols.js:151 | [06](/concepts/06-rules) |
| ignore | 按协议名屏蔽规则 | util/index.js:1913 | [06](/concepts/06-rules) |
| skip | ignore 的别名归并 | protocols.js:131 | [06](/concepts/06-rules) |
| important | 插到协议数组首位 | rules.js:1400 | [06](/concepts/06-rules) |
| multiMatchs | 允许多命中的协议集 | protocols.js:186 | [06](/concepts/06-rules) |
| backRulesFirst | 后置规则反序优先 | rules/util.js:46 | [06](/concepts/06-rules) |
| filterWeakRule | 弱规则让位 host | util/index.js:3741 | [06](/concepts/06-rules) |
| parseText | 规则文本解析入口 | rules.js:1745 | [06](/concepts/06-rules) |
| parseRule | 编译并按协议分桶 | rules.js:1229 | [06](/concepts/06-rules) |
| getLines | 规则集展开入口 | rules.js:410 | [06](/concepts/06-rules) |
| formatShorthand | 裸写法补协议前缀 | rules.js:225 | [06](/concepts/06-rules) |
| indexOfPattern | 判断首个 token 类型 | rules.js:1456 | [06](/concepts/06-rules) |
| resolveValue | 命中后求值成 value | rules.js:811 | [06](/concepts/06-rules) |
| resolveRuleList | 请求期匹配入口 | rules.js:929 | [06](/concepts/06-rules) |
| checkFilter | 每次比较前短路过滤 | rules.js:986 | [06](/concepts/06-rules) |
| getPathRule | 拼接剩余路径 | rules.js:947 | [06](/concepts/06-rules) |
| isRegExp | 正则匹配分支标志 | rules.js:1007 | [06](/concepts/06-rules) |
| wildcard | 通配匹配分支 | rules.js:1034 | [06](/concepts/06-rules) |
| isExact | 精确匹配分支 | rules.js:1081 | [06](/concepts/06-rules) |
| not | 否定规则取反 | rules.js:1009 | [06](/concepts/06-rules) |
| preMatch | 通配预匹配正则 | rules.js:1162 | [06](/concepts/06-rules) |
| rule 对象 | 编译后的结构化规则 | rules.js:1335 | [06](/concepts/06-rules) |
| matcher / value | 命中前与命中后字段 | rules.js:811 | [06](/concepts/06-rules) |
| 分桶 | 每协议一个数组 | protocols.js:256 | [06](/concepts/06-rules) |
| req.rules | 各协议首条命中集合 | rules.js:12 | [06](/concepts/06-rules) |
| resolveRules | 按阶段取首条命中 | rules.js:2239 | [06](/concepts/06-rules) |
| reqProtocols | 请求阶段协议集合 | protocols.js:156 | [06](/concepts/06-rules) |
| pureResProtocols | 纯响应协议集合 | protocols.js:82 | [06](/concepts/06-rules) |
| aliasProtocols | 别名归并表 | protocols.js:131 | [06](/concepts/06-rules) |
| protocols 数组 | 73 项合法协议名 | protocols.js:1 | [06](/concepts/06-rules) |
| toolProtocols | log 与 weinre 集合 | protocols.js:76 | [06](/concepts/06-rules) |
| contains | 协议名注册表查询 | protocols.js:289 | [06](/concepts/06-rules) |
| 模板变量 | ${method} 等求值替换 | rules.js:76 | [06](/concepts/06-rules) |
| renderTpl | 模板渲染函数 | rules.js:721 | [06](/concepts/06-rules) |
| @url 远程规则 | 编译前展开的远端内容 | util/index.js:3305 | [06](/concepts/06-rules) |
| inlineValues | 规则文件内嵌值 | util/index.js:202 | [06](/concepts/06-rules) |
| regUrlCache / hostCache | 编译内普通对象缓存 | rules.js:64 | [06](/concepts/06-rules) |
| tplCache | 模板编译 LRU 缓存 | rules/index.js:20 | [06](/concepts/06-rules) |
| _mflag | 规则版本标记 | rules.js:2078 | [06](/concepts/06-rules) |
| isSpec | 短路规则的标记 | rules.js:1311 | [06](/concepts/06-rules) |
| ruleUrl | 改地址后的目标 URL | rules.js:40 | [06](/concepts/06-rules) |
| host / xhost | 改目标主机指令 | rules/index.js:150 | [06](/concepts/06-rules) |
| reqDelay | 请求延迟指令 | data.js:544 | [06](/concepts/06-rules) |
| resBody | 替换响应体指令 | res.js:950 | [06](/concepts/06-rules) |
| style:// | 样式注入协议 | protocols.js:1 | [06](/concepts/06-rules) |
| P:// / G:// | 插件与值引用前缀 | rules.js:225 | [06](/concepts/06-rules) |
:::

规则引擎把「一行文本」与「一组编译对象」分成编译期与请求期两条泳道：`parseText` 只做结构化，`resolveRuleList`（`lib/rules/rules.js:929-938`）才按当前 URL 求首条命中，`resolveValue`（`:811-852`）把 `matcher` 求值成 `value`。把 `regUrlCache` / `hostCache` 当成 LRU 是流传很广的误解，它们只是每次编译后清空的普通对象。

## 七、扩展与工程化

::: cols 20|38|22|20
| 名词 | 一句话定义 | 源码/文档落点 | 详解篇 |
|---|---|---|---|
| plugin | 第三方扩展包 | plugins/index.js:36 | [07](/concepts/07-extension) |
| whistle.xxx | 插件包名约定 | plugins/util.js:8 | [07](/concepts/07-extension) |
| whistleConfig | 插件能力声明字段 | get-plugins-sync.js:122 | [07](/concepts/07-extension) |
| 短协议 / 长协议 | 由简名与全名生成 | get-plugins-sync.js:175 | [07](/concepts/07-extension) |
| pfork | 按需拉起子进程 | plugins/index.js:633 | [07](/concepts/07-extension) |
| hook | 插件请求分发入口 | config.js:85 | [07](/concepts/07-extension) |
| PLUGIN_HOOKS | 全部 hook 名常量表 | config.js:85 | [07](/concepts/07-extension) |
| hook 头 | 携带 hook 名的内部头 | config.js:74 | [07](/concepts/07-extension) |
| ports 表 | 子进程回传端口清单 | load-plugin.js:1347 | [07](/concepts/07-extension) |
| authPort / sniPort | 认证与 SNI 端口 | load-plugin.js:1349 | [07](/concepts/07-extension) |
| uiPort | 插件界面端口 | load-plugin.js:1355 | [07](/concepts/07-extension) |
| rulesServer | 动态规则 hook 服务 | load-plugin.js:1903 | [07](/concepts/07-extension) |
| rules.txt | 插件静态规则文件 | get-plugins-sync.js:185 | [07](/concepts/07-extension) |
| _rules.txt | 请求侧静态规则文件 | get-plugins-sync.js:185 | [07](/concepts/07-extension) |
| resRules.txt | 响应侧静态规则文件 | get-plugins-sync.js:185 | [07](/concepts/07-extension) |
| resolveWhistlePlugins | 解析插件名与取值 | plugins/index.js:1436 | [07](/concepts/07-extension) |
| mergeRules | 合并插件规则 | util/index.js:2195 | [07](/concepts/07-extension) |
| sniCallback:// | 插件动态下发证书 | load-cert.js:7 | [07](/concepts/07-extension) |
| excludePlugin | 拒绝与内置协议同名 | plugins/util.js:132 | [07](/concepts/07-extension) |
| refreshPlugins | 每 6 秒增量扫描 | plugins/index.js:508 | [07](/concepts/07-extension) |
| mtime | 文件修改时间比对 | plugins/index.js:30 | [07](/concepts/07-extension) |
| custom_plugins | 插件安装目录 | bin/plugin.js:12 | [07](/concepts/07-extension) |
| w2 install | CLI 安装插件 | bin/plugin.js:124 | [07](/concepts/07-extension) |
| npm | 包管理依赖 | bin/plugin.js:139 | [07](/concepts/07-extension) |
| Storage | 插件持久化能力 | load-plugin.js:1147 | [07](/concepts/07-extension) |
| sharedStorage | 共享存储目录 | load-plugin.js:1223 | [07](/concepts/07-extension) |
| sessionStorage | 按 reqId 的会话存储 | load-plugin.js:40 | [07](/concepts/07-extension) |
| wsParser | 插件侧帧解析能力 | load-plugin.js:904 | [07](/concepts/07-extension) |
| wrapWsReader / Writer | 隧道帧包装器 | load-plugin.js:1147 | [07](/concepts/07-extension) |
| compatHeaders | 不可枚举上下文头 | compat.js:94 | [07](/concepts/07-extension) |
| constsMap | 上下文到内部头映射 | compat.js:40 | [07](/concepts/07-extension) |
| ETag / max-age | 规则 hook 缓存头 | plugins/index.js:973 | [07](/concepts/07-extension) |
| 网络闭环 | 劫持 connect 回代理 | plugins/proxy.js:261 | [07](/concepts/07-extension) |
| SPEC_HOST_RE | 特殊 host 匹配正则 | plugins/proxy.js:265 | [07](/concepts/07-extension) |
| service 子进程 | 后台重活隔离进程 | service/index.js:17 | [07](/concepts/07-extension) |
| SAZ / HAR | 抓包导入导出格式 | reproduce-replay.md:26 | [07](/concepts/07-extension) |
| CGI | Web UI 取数据接口 | get-data.js:28 | [07](/concepts/07-extension) |
| Web UI | 浏览器管理界面 | biz/index.js:133 | [07](/concepts/07-extension) |
| mode / strict / safe | 运行模式开关组合 | config.js:809 | [07](/concepts/07-extension) |
| bin / w2 | CLI 入口与命令名 | bin/whistle.js:132 | [07](/concepts/07-extension) |
| engines | Node 版本约束字段 | package.json:77 | [07](/concepts/07-extension) |
:::

插件是唯一允许第三方代码深度介入链路的入口，整套设计围绕「主进程 ↔ pfork 子进程 ↔ 内部 HTTP 端口 ↔ Web UI」四方展开。hook 名都带 `uid`（`lib/config.js:85-108`），经 `x-whistle-plugin-hook-name_` 打到 `127.0.0.1` 的 hookPort，子进程单端口按头分发；规则类 hook 还用 ETag / max-age 缓存，避免每次请求都跑一遍脚本。

## 八、内部头 / 常量 / 阈值 / 文件

::: cols 20|38|22|20
| 名词 | 一句话定义 | 源码/文档落点 | 详解篇 |
|---|---|---|---|
| x-whistle-policy | 隧道拦截策略头 | config.js:67 | [08](/concepts/08-confusions) |
| x-whistle-https-request | HTTPS 请求标记 | common.js:182 | [08](/concepts/08-confusions) |
| HTTPS_FIELD | 上者的常量名 | config.js:69 | [08](/concepts/08-confusions) |
| x-whistle-client-info-* | 客户端 IP 与端口 | config.js:70 | [08](/concepts/08-confusions) |
| CLIENT_INFO_HEADER | 上者的常量名 | config.js:70 | [08](/concepts/08-confusions) |
| CLIENT_IP_HEADER | 客户端 IP 头常量 | config.js:68 | [08](/concepts/08-confusions) |
| CLIENT_PORT_HEADER | 客户端端口头常量 | config.js:76 | [08](/concepts/08-confusions) |
| CLIENT_ID_HEADER | 客户端 id 头常量 | config.js:75 | [08](/concepts/08-confusions) |
| ALPN_PROTOCOL_HEADER | ALPN 协议内部头 | config.js:77 | [08](/concepts/08-confusions) |
| PLUGIN_HOOK_NAME_HEADER | 插件 hook 名头常量 | config.js:74 | [08](/concepts/08-confusions) |
| WEBUI_PATH | 内部 UI 路径前缀 | config.js:72 | [08](/concepts/08-confusions) |
| WEBUI_HEAD | 转发来源内部头 | config.js:80 | [08](/concepts/08-confusions) |
| RES_RULES_HEAD | 响应规则内部头 | config.js:81 | [08](/concepts/08-confusions) |
| DISABLE_RULES_HEADER | 禁用规则内部头 | config.js:78 | [08](/concepts/08-confusions) |
| PROXY_ID_HEADER | 代理实例内部头 | config.js:79 | [08](/concepts/08-confusions) |
| FROM_COM_HEADER | Composer 来源标记 | config.js:83 | [08](/concepts/08-confusions) |
| TEST_HEADER | 测试请求内部头 | config.js:84 | [08](/concepts/08-confusions) |
| SHOW_LOGIN_BOX | 登录框提示头 | config.js:71 | [08](/concepts/08-confusions) |
| TEMP_TUNNEL_DATA_HEADER | 临时隧道数据头 | https/index.js:1134 | [08](/concepts/08-confusions) |
| x-whistle-req-id | 隧道响应里的 reqId | tunnel.js:781 | [08](/concepts/08-confusions) |
| x-whistle-filter-key | 抓包过滤键头 | get-data.js:60 | [08](/concepts/08-confusions) |
| x-whistle-etag | 插件规则缓存头 | plugins/index.js:973 | [08](/concepts/08-confusions) |
| x-whistle-frame-parser | 自定义帧解析头 | compat.js:52 | [08](/concepts/08-confusions) |
| tunnel:// | 隧道伪 URL 前缀 | tunnel.js:75 | [08](/concepts/08-confusions) |
| ws:// / wss:// | WebSocket 伪 URL | common.js:1284 | [08](/concepts/08-confusions) |
| rootca.pro | 根证书下载虚域名 | config.js:37 | [08](/concepts/08-confusions) |
| uid 后缀 | 多实例头隔离串 | config.js:29 | [08](/concepts/08-confusions) |
| certs 目录 | 根密钥与证书落盘 | ca.js:19 | [08](/concepts/08-confusions) |
| custom_certs 目录 | 用户证书目录 | ca.js:347 | [08](/concepts/08-confusions) |
| .recycle_bin | 规则删除回收目录 | storage.js:63 | [08](/concepts/08-confusions) |
| .whistlerc | 用户级配置文件 | config.js:497 | [08](/concepts/08-confusions) |
| KEY_SIZE | 根密钥 2048 常量 | ca.js:42 | [08](/concepts/08-confusions) |
| MIN_DATE / MAX_DATE | 叶证书 7/36 天 | ca.js:48 | [08](/concepts/08-confusions) |
| CLEAR_INTERVAL | 缓存清理 6000ms | data-server.js:18 | [08](/concepts/08-confusions) |
| PRESERVE_LEN | 溢出后保留 360 条 | data-server.js:24 | [08](/concepts/08-confusions) |
| MAX_HISTORY_LEN | Composer 历史 100 条 | composer.js:24 | [08](/concepts/08-confusions) |
:::

这批常量集中在 `lib/config.js:63-108`：多数带 `+ uid` 后缀，用于多实例并存时避免请求串台；`PLUGIN_HOOKS` 的二十余项同样带 uid。把内部头当成对外标准头（例如把 `HTTPS_FIELD` 当成 `X-Forwarded-Proto`）或把「带 uid」误读成固定字符串，是这一组最常见的两类误判。

## 按字母 / 缩写查

以下按主题分组给出英文全称与中文释义，均为本工程源码或文档里实际出现的写法；括号内补充它在链路里的落点，便于顺着缩写回到具体篇。

**证书、加密与 PKI**

- **ALPN**（Application Layer Protocol Negotiation）：应用层协议协商，握手期决定 `h2` 还是 `http/1.1`（`lib/https/h2.js:10`）。
- **SNI**（Server Name Indication）：服务器名称指示，ClientHello 里明文带的目标域名（`lib/https/index.js:1295`）。
- **SAN**（Subject Alternative Name）：使用者可选名称，证书里的多域名扩展（`lib/https/ca.js:241`）。
- **CN**（Common Name）：通用名，证书主题里的旧式域名字段（`lib/https/ca.js:484`）。
- **CA**（Certificate Authority）：证书颁发机构，签发并背书证书的信任根（`lib/https/ca.js:580`）。
- **MITM**（Man-In-The-Middle）：中间人，用两段独立 TLS 换出可改写明文（`/domain/tls-mitm`）。
- **mTLS**（Mutual TLS）：双向 TLS，要求客户端也出示证书（`/domain/tls-mitm`）。
- **PKI**（Public Key Infrastructure）：公钥基础设施，证书链与信任锚的总体系（`/domain/tls-mitm`）。
- **PEM**（Privacy Enhanced Mail）：Base64 文本证书编码（`lib/https/ca.js:111`）。
- **DER**（Distinguished Encoding Rules）：ASN.1 的二进制证书编码（`/domain/tls-mitm`）。
- **PFX**（Personal Information Exchange）：PKCS#12 打包的证书与私钥格式（`biz/webui/cgi-bin/create-cert.js`）。
- **RSA**（Rivest–Shamir–Adleman）：非对称加密算法，根密钥 2048 位（`lib/https/ca.js:42`）。
- **SHA**（Secure Hash Algorithm）：安全散列算法，签名用 SHA-256、序列号用 SHA-1（`lib/https/ca.js:543,207`）。
- **AKI**（Authority Key Identifier）：授权密钥标识符，叶证书指向签发者的扩展（`lib/https/ca.js:255`）。

**协议、Web 与报文**

- **H2 / h2**（HTTP Version 2）：基于 TLS 的 HTTP/2（`lib/https/h2.js:10`）。
- **h2c**（HTTP/2 Cleartext）：明文 HTTP/2，以 preface 识别（`lib/https/index.js:1118`）。
- **SSE**（Server-Sent Events）：服务端单向推送的文本流，按空行分帧（`lib/inspectors/data.js:98`）。
- **WS / WSS**（WebSocket / WebSocket Secure）：明文与加密的 WebSocket 伪 URL（`lib/util/common.js:1284`）。
- **CGI**（Common Gateway Interface）：通用网关接口，此处指 Web UI 取数接口（`biz/webui/cgi-bin/get-data.js:28`）。
- **API**（Application Programming Interface）：应用程序编程接口，插件侧 CGI 即其一（`lib/plugins/load-plugin.js:1240`）。
- **SOCKS**（Socket Secure）：会话层代理协议，独立端口监听（`lib/index.js:182`）。
- **PAC**（Proxy Auto-Config）：代理自动配置脚本，按 URL 选上游（`lib/rules/index.js:264`）。
- **DNS**（Domain Name System）：域名系统，`getProxy` 把域名解析到 IP（`lib/rules/dns.js:1`）。
- **TTL**（Time To Live）：生存时间，DNS 与缓存的过期口径（`lib/util/index.js:3304`）。
- **CORS**（Cross-Origin Resource Sharing）：跨域资源共享，`reqCors` / `resCors` 规则改写（`lib/inspectors/req.js:472`）。
- **UA**（User Agent）：用户代理头，`CRONET_RE` 据此放行（`lib/tunnel.js:199`）。
- **XFF**（X-Forwarded-For）：来源 IP 转发头（`lib/config.js:68`）。
- **ETag**（Entity Tag）：实体标签，插件规则 hook 的缓存校验（`lib/plugins/index.js:973`）。
- **gzip**（GNU zip）：HTTP 压缩编码，抓包上报用 `zlib.gzip`（`biz/webui/cgi-bin/get-data.js:28`）。
- **base64**（Base 64 Encoding）：二进制转文本编码，正文返回前转换（`lib/util/data-server.js:216`）。
- **SAZ**（Fiddler Session Archive Zip）：Fiddler 会话归档，可导入导出（`/scenarios/reproduce-replay`）。
- **HAR**（HTTP Archive）：HTTP 会话归档格式，导入格式之一（`/scenarios/reproduce-replay`）。
- **URL / URI**（Uniform Resource Locator / Identifier）：统一资源定位符与标识符，`fullUrl` 即还原结果（`biz/index.js:34`）。
- **QPS**（Queries Per Second）：每秒请求数，`procData` 每 3 秒统计（`lib/util/perf.js`）。

**运行时、工程与内核命名**

- **DSL**（Domain Specific Language）：领域特定语言，此处指 Whistle 规则语法（`/concepts/06-rules`）。
- **LRU**（Least Recently Used）：最近最少使用，证书与模板缓存策略（`lib/https/index.js:8`）。
- **IPC**（Inter-Process Communication）：进程间通信，`sendData` 消息通道（`lib/service/index.js:61`）。
- **PID**（Process Identifier）：进程标识符，`uid` 生成要素之一（`lib/config.js:29`）。
- **CLI**（Command Line Interface）：命令行界面，`w2` 命令入口（`bin/whistle.js:132`）。
- **NPM**（Node Package Manager）：Node 包管理器，插件安装与依赖来源（`bin/plugin.js:139`）。
- **Buffer**（缓冲区）：Node 二进制数据容器，采样拼接用（`lib/inspectors/data.js:26`）。
- **Transform**（转换流）：Node 双工转换流，改写以它插入（`lib/inspectors/req.js:581`）。
- **EventEmitter**（事件发射器）：事件订阅发布基类，`proxyEvents` 即其（`lib/index.js:39`）。
- **hook**（钩子）：插件请求的分发入口，按名称打到内部端口（`lib/config.js:85`）。
- **port**（端口）：监听或转发的端口号，含主端口与内部 hookPort（`lib/config.js:1039`）。
- **storage**（存储隔离目录）：`--storage` 指定的多实例子目录（`lib/config.js:1067`）。
- **uid**（唯一实例串）：时间戳加 PID 生成，拼进内部头防串台（`lib/config.js:29`）。
- **isSpec**（特殊规则标记）：`statusCode` / `redirect` 的短路标记（`lib/rules/rules.js:1311`）。
- **mtime**（修改时间）：文件修改时间，插件增量扫描依据（`lib/plugins/index.js:30`）。
- **RSS**（Resident Set Size）：常驻内存集，原地更新对象的代价指标（`/core/capture-data`）。

## 内部头与伪协议速查

以下名称偏长，故用列表逐条给作用；常量定义集中在 `lib/config.js:63-108`，隧道伪 URL 见 `lib/tunnel.js:75`。

- **`x-whistle-policy`**：逐条声明隧道策略，`tunnel` / `connect` 强制透传、`intercept` / `capture` 强制解密、`weakTunnel` 可被覆盖（`lib/config.js:67`、`lib/tunnel.js:144`）。
- **`x-whistle-https-request`**：标记该请求原本来自 HTTPS 解密，仅非 h2 路径写入（`lib/util/common.js:182`、`lib/https/index.js:962`）。
- **`x-whistle-plugin-hook-name_`**：携带 hook 名打到插件内部端口，子进程读完即删（`lib/config.js:74`、`lib/plugins/load-plugin.js:851`）。
- **`x-whistle-client-info-*`**：带 uid 的客户端 IP 与端口头，回流时还原来源（`lib/config.js:70`、`lib/https/index.js:954`）。
- **`CLIENT_IP_HEADER`**：客户端 IP 头常量名，来自 `common`（`lib/config.js:68`）。
- **`ALPN_PROTOCOL_HEADER`**：把协商出的 h2 / httpH2 与 reqId 传给内部链路（`lib/config.js:77`、`lib/https/index.js:1052`）。
- **`WEBUI_PATH=/.whistle-path.5b6af7b9884e1165/`**：内部 UI 路径前缀，把管理流量挡在用户规则之前（`lib/config.js:72`、`biz/index.js:10`）。
- **`tunnel://`**：隧道流量的伪 URL 前缀，只带主机与端口、不带路径（`lib/tunnel.js:75`）。
- **`ws://` / `wss://`**：WebSocket 明密文伪 URL，由 `getFullUrl` 依 `isWs` / `isHttps` 拼出（`lib/util/common.js:1284`）。
- **`rootca.pro`**：下载根证书的虚域名，命中时顺手开启 HTTPS 抓包（`lib/config.js:37`、`biz/webui/cgi-bin/rootca.js:4`）。

## 数值阈值总表

下表把散落在各模块的硬边界收拢到一处。出处列同样用短相对路径，完整写法如 `lib/util/data-server.js:21`、`lib/inspectors/data.js:7`、`lib/https/ca.js:48`，可在 [《术语、路径与配置速查》](/advanced/reference) 与对应详解篇核对推导过程。

::: cols 20|30|28|22
| 数值 | 含义 | 出处(短) | 详解篇 |
|---|---|---|---|
| 600 条 | 抓包缓存常规水位 | data-server.js:21 | [05](/concepts/05-capture) |
| 1800 条 | 溢出清理阈值 3 倍 | data-server.js:22 | [05](/concepts/05-capture) |
| 1200 次 | abort 单次上限 | abort.js:4 | [05](/concepts/05-capture) |
| 360 条 | 溢出后保留量 | data-server.js:24 | [05](/concepts/05-capture) |
| 100 条 | 单次拉取上限 | data-server.js:26 | [05](/concepts/05-capture) |
| 120 条 | getList 计数上限 | data-server.js:34 | [05](/concepts/05-capture) |
| 360KB | 默认 body 上限 | data.js:7 | [05](/concepts/05-capture) |
| 1MB | 非流式请求上限 | data.js:8 | [05](/concepts/05-capture) |
| 2MB | 流式请求与响应体 | data.js:9 | [05](/concepts/05-capture) |
| 16MB | bigData 大对象上限 | data.js:11 | [05](/concepts/05-capture) |
| 256KB | 规则预读上限 | rules.js:10 | [06](/concepts/06-rules) |
| 1MB 帧 | 单帧截断阈值 | util/index.js:4012 | [05](/concepts/05-capture) |
| 22s | WebSocket 心跳间隔 | socket-mgr.js:8 | [05](/concepts/05-capture) |
| 5 帧 | 分片拼接上限 | socket-mgr.js:15 | [05](/concepts/05-capture) |
| 7 天 | 叶证书提前生效 | ca.js:48 | [03](/concepts/03-tls) |
| 36 天 | 叶证书有效期 | ca.js:49 | [03](/concepts/03-tls) |
| RSA 2048 | 根密钥位数 | ca.js:42 | [03](/concepts/03-tls) |
| 十年 | 根证书有效期 | ca.js:565 | [03](/concepts/03-tls) |
| sockets=256 | agent 连接上限 | config.js:1039 | [04](/concepts/04-runtime) |
| timeout=360000 | 空闲超时毫秒 | index.js:44 | [04](/concepts/04-runtime) |
| 100/900ms | 有无新数据轮询 | data-center.js:1159 | [05](/concepts/05-capture) |
| 6s | 缓存清理与插件刷新 | data-server.js:18 | [04](/concepts/04-runtime) |
| 5s/10~30s | 本地与远程规则刷新 | http-mgr.js:41 | [06](/concepts/06-rules) |
| 100 次 | Composer 重放上限 | composer.js:19 | [07](/concepts/07-extension) |
| 64/100 条 | 界面与服务端历史 | composer.js:24 | [07](/concepts/07-extension) |
| 6MB | 导入文件大小上限 | cgi-bin/util.js:10 | [05](/concepts/05-capture) |
:::

这些数值不是孤立常量，而是几套模型的边界：600 / 1800 / 360 / 100 共同约束 `lib/util/data-server.js` 的零复制有界缓存；360KB 到 16MB 一组约束 `lib/inspectors/data.js` 的旁路采样；7 天、36 天、RSA 2048、十年共同描述 `lib/https/ca.js` 的两档有效期；100 / 900ms 则把前端短轮询与 `hasNew` 绑在一起。改任何一个值之前，先确认它属于哪一套模型。

## 小结

- 八类表格覆盖代理入口、报文连接、证书 PKI、运行时、抓包帧、规则 DSL、扩展工程与内部常量，每条都带定义、落点与详解跳转。
- 表格落点用短相对路径，正文与速查章用完整 `lib/xxx.js:行号`，行号以 v2.10.13 为准、以函数名作稳定锚点。
- 缩写章给全称与中文，内部头与伪协议章给作用，数值阈值总表给硬边界出处，三者补上表格不便展开的长名称与推导。
- 最常见三类误判：把短 URL 缓存当 LRU、把 `sockets` 当端口数、把 `HTTPS_FIELD` 当对外标准头，均可顺链接回 `/concepts/08-confusions` 与 [速查表](/advanced/reference) 复核。

## 下一步

回到 [《概念精解》首页](/concepts/index) 重新按主题选篇，或对照 [《综合贯通：一次 HTTPS 请求里的全部概念》](/concepts/09-walkthrough) 把本页名词按 28 步链路串起来；只想核对配置项与默认值，则查 [《术语、路径与配置速查》](/advanced/reference)。
