---
title: HTTPS、证书链与中间人
description: 用证书链与信任锚解释 MITM，再落到 Whistle 的解密判定、SNI 与证书签发。
---

# HTTPS、证书链与中间人

上一篇的结论是：纯 CONNECT 透传时，代理看不进 HTTPS 的一个字节。本节回答「那抓包工具凭什么能看到明文」——先补齐 TLS 握手、证书链与信任锚的知识，再拆解 Whistle 把一条连接变成两段 TLS 的完整判定链。读完你能说清楚根证书为什么必须安装、哪些流量会被放行、以及这套能力的边界在哪里。

::: tip 先修知识
已理解 CONNECT 隧道与 `HTTP/1.1 200 Connection Established` 的含义，知道对称加密与非对称加密的区别。不需要密码学细节，但「公钥可公开、私钥必须保密」这一点要先接受。
:::

## 从握手到信任锚

TLS 握手要同时确认对方身份、并协商出只有双方知道的会话密钥。非对称加密负责认证与密钥交换，代价高；真正承载 HTTP 报文的是对称加密，因为加解密快、适合流式数据。所以握手的重点是安全地把对称密钥交到对方手里，而不是用 RSA 加密每一个字节。

### 证书链与信任锚

服务器发来的不是一张孤立证书，而是一条链：叶证书 → 中间 CA → 根 CA。浏览器逐层验签，直到遇到信任库里预置的根证书，这个根就是**信任锚**。根私钥长期离线，日常由中间 CA 签发，出问题时可单独吊销，不必惊动根。

证书里域名匹配靠 SAN（subjectAltName），而不是早期只填 CN 的写法；Whistle 签发叶证书时正是设置这个扩展（`lib/https/ca.js:241-242`）。SNI 则是客户端在第一个 ClientHello 里明文带上的目标域名，让同一 IP 上的多个站点能各自出示证书。ALPN 同样在握手里协商应用层协议，例如 `h2` 还是 `http/1.1`（`lib/https/h2.js:10` 的 `SUPPORTED_PROTOS = ['h2', 'http/1.1', 'http/1.0']`）。

### pinning 与「装根证书」为何是前提

证书固定（pinning）指应用把预期证书或公钥写死在代码里，不理会系统信任库；mTLS 则反过来要求客户端也出示证书。两者都会让「换一张证书」立刻失败。而普通浏览器默认信任系统根 CA，这正是 HTTPS 抓包的唯一入口：把工具生成的根 CA 装进信任库，它签发的叶证书才被认作合法；不装，代理一解密客户端就会告警。

## 两段 TLS 的 MITM 模型

中间人不是「破解 TLS」，而是**让客户端和代理、代理和源站各做一次独立握手**。左侧客户端以为在和 `example.com` 说话，对面其实是 Whistle 用本地 CA 现签的叶证书；右侧 Whistle 以普通客户端身份与源站握手。两段之间的代理拿到明文，规则改写、抓包、重放由此可能。

对照纯 CONNECT 透传：透传只有一条 TCP 管道、零解密零改写；MITM 是两条加密连接加一段明文桥，代价是必须持有客户端信任的签发权，且每多一段握手就多一份延迟与失败面。

![装根证书后两段独立 TLS 与中间明文](/diagrams/tls-trust.svg)
*图注：客户端信任本地根 CA 后，代理分别向两侧握手，中间是可供规则处理的明文。*

## Whistle 何时决定解密

解密很贵也有风险，所以默认不是「所有 CONNECT 都拆」。总闸门是 `lib/tunnel.js:168-213` 的 `isIntercept()`，它把几类信号组合起来：

- **策略头**：`lib/tunnel.js:144-148` 读取 `x-whistle-policy`（`lib/config.js:67`），`tunnel` / `connect` 要求纯透传，`weakTunnel` 只在显式要求时解密；`intercept` / `capture` 则强制解密（`lib/tunnel.js:179-187`）。
- **规则与开关**：`filter.https` / `filter.capture` / `filter.intercept` 以及 `disable.https` / `disable.capture` 决定这一条是否豁免（`lib/tunnel.js:168-177`）。
- **全局抓包开关**：`lib/tunnel.js:195` 检查 `properties.isEnableCapture()`，未开启时不主动解密。
- **系统流量黑名单**：即使开启抓包，`lib/tunnel.js:199-200` 也会放行 Cronet UA 与 Apple、Microsoft 等系统域名（`lib/tunnel.js:26-27` 的 `CRONET_RE` / `SYS_HOST_RE`），避免破坏系统服务与证书固定流量。
- **自定义证书**：`lib/tunnel.js:190-197`、`lib/tunnel.js:207-212` 在存在自定义证书或配置了 Proxifier 时仍可能放行解密。

为什么黑名单这么保守？这些客户端大量使用 pinning，换证书会整片失败，宁可看不到也不能让设备断网。

## 首包识别、SNI 与证书签发

决定解密后，代理还不知道隧道里跑的是 TLS、明文 HTTP 还是 h2c。`lib/https/index.js:1184-1234` 用 `util.readOneChunk` 读第一个数据包再分流：`HTTP_RE` 命中说明是明文 HTTP（`lib/https/index.js:1117`），由 `:1215-1226` 把它作为 `connection` 事件塞回 HTTP 解析器；`HTTP2_RE` 命中说明是 h2c preface（`lib/https/index.js:1118`）。其余情况在 `:1232` 用的是**反向判定** `if (!isHttpH2 && chunk[0] != 22) return next(chunk);`：首字节不是 22 且不是 h2c preface 就回退透传，换言之只有 TLS 握手记录（首字节 22，handshake 类型）或 h2c preface 才继续往下解密。

```js
// lib/https/index.js:1231-1234
var isHttpH2 = HTTP2_RE.test(headersStr);
if (!isHttpH2 && chunk[0] != 22) {
  return next(chunk);
}
```

确认是 TLS 后，`lib/https/index.js:1295` 调用 `checkSNI(chunk)`（`lib/https/index.js:9` 引入 `sni` 包）从 ClientHello 里取出域名，据此签发对应叶证书。根 CA 在启动时就绪：`lib/https/ca.js:427-441` 的 `createRootCA()` 先读取本地已有的根密钥与根证书，读不到则由 `lib/https/ca.js:471-473` 的 `resetRootCA()` 新建，调用点在 `lib/https/ca.js:580`。

有效期分两档，不可混为一谈：`lib/https/ca.js:46-49` 定义 `MIN_DATE = ONE_DAY * 7`、`MAX_DATE = ONE_DAY * 36`，`:558-573` 的 `createCert` 在 `isShortPeriod` 分支给**叶证书**设 `notBefore = now - 7 天`、`notAfter = now + 36 天`——提前 7 天生效是为容忍客户端时钟回拨，36 天上限则顺应 Apple / Chromium 对证书寿命的限制（`:563-564` 的注释）。`createSelfCert`（`:213-217`）正是传 `true` 走这一档；根证书由 `createCACert`（`:479`）不传该参数，落到 else 分支 `notAfter = now + ONE_YEAR * 10`，即约十年。

另有一条兼容路径：`lib/https/index.js:1324` 在 `enable://emudhra` 生效时置 `enableEmudhra`，`lib/https/ca.js:224,264` 改用 `emudhra.subject` 作签发者、由 `emudhra.sign` 签名；`lib/https/emudhra.js:6` 注明这套密钥与链来自 mitmproxy 公开披露的提交，只用于兼容特定 Android 客户端，**不是可信根证书，也不应视作安全实践**，详见[《TLS 概念精解》](/concepts/03-tls)。

握手完成后，`lib/https/index.js:1102-1111` 的 `handlers.request` 用 `server.emit('request', req, res)` 把明文请求塞回 Express 中间件链：HTTPS 与明文 HTTP 最终共用同一套规则与改写逻辑，前面所有复杂性只为还原出 `req` / `res`。

这里其实是**两个互不影响的信任边界**：入站一侧，客户端是否信任代理伪造的叶证书，只取决于本地根 CA 有没有装进系统信任库（上一节「装根证书」）；出站一侧，`lib/config.js:65` 默认 `config.rejectUnauthorized = false`，代理作为普通客户端连源站时不校验对方证书，以便处理自签名环境，只有 `--mode safe`（或 `rejectUnauthorized`）才在 `lib/config.js:809-810` 打开校验。装好根 CA 并不会顺带让出站校验变严，`--mode safe` 打开的也只是出站这一段；两段各管各的信任，互不传递。这是便利与安全的取舍。

## 合规与风险

- **私钥本地生成与保存**：根密钥在本机生成并存于数据目录的 `certs` 下（`lib/https/ca.js:19`、`lib/https/ca.js:27-30`、`lib/https/ca.js:427-441`），不会上传。一旦泄露，持有者就能为任意域名签发被你信任的证书，切勿备份到网盘或共享仓库。
- **根证书信任范围**：安装根 CA 意味着该系统上**所有应用**的 TLS 都可能被这台机器上的 Whistle 解密，不只是浏览器里的调试页面。用完及时取消信任，尤其在共用开发机上。
- **不要在生产或他人设备上滥用**：仅在自己可控的开发、测试环境，且对相关流量有明确授权时启用；未经同意解密他人通信既不合规也可能触犯法律。
- **pinning 与 mTLS 场景**：遇到证书固定或双向认证，换证书会直接导致握手失败，应改用纯透传、让客户端直连，或由业务方提供专用调试构建，而不是强行绕过。

## 小结

- 非对称加密负责认证与密钥交换，对称加密承载正文；信任锚是系统预置根 CA。
- SAN 匹配域名、SNI 指示目标站点、ALPN 协商协议，pinning 与 mTLS 会拒绝替换证书。
- MITM 用两段独立 TLS 换出中间明文，与纯透传是两种能力档位。
- `isIntercept()` 综合策略头、规则、全局开关、系统黑名单与自定义证书决定是否解密。
- 首包以「非 22 且非 h2c preface 就透传」反向分流，SNI 驱动本地 CA 签发短周期叶证书（7 天提前生效 / 36 天有效，根证书约十年），明文回流 Express。

## 下一步

[《HTTP/2、WebSocket 与流量形态》](/domain/web-protocols)：解密之后还要面对不同协议的帧结构，下一篇看它们各自从哪个入口进入、能否被改写。
