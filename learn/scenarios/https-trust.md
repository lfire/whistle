---
title: HTTPS、证书与鉴权的排障现场
description: 从根证书安装到解密判定、双向认证与跨域鉴权，串起 HTTPS 排障的规则、设计取舍与源码路径。
---

# HTTPS、证书与鉴权的排障现场

接口联调时最常见的停顿不是代码写错，而是抓包列表里只有 Tunnel to，或者浏览器反复提示证书不受信任。本篇按「装证书 → 开解密 → 处理证书固定与双向认证 → 补鉴权与跨域头」的现场顺序，把官方 FAQ、CLI 与界面说明中的操作固化为可复制配置，再向下追到解密判定与证书签发的源码。读完你能判断某条 HTTPS 为什么没被解密，也知道解密之后哪些规则才真正作用在明文上。

## 场景与痛点

新机器首次接入。根证书装了、Enable HTTPS 也开了，列表却仍显示加密隧道。常见原因有三类：Firefox 不读系统证书库、iOS 装完描述文件没有开启完全信任、以及直接用 IP 访问时客户端不发 SNI。三者的处理方式完全不同，逐一试错会浪费大量时间。

特定 App 抓不到包。App 做了证书固定或要求双向认证，代理替换证书后握手直接失败，界面上表现为 captureError。此时继续强开解密只会让设备断网，正确做法是对该域名跳过解密，或改用兼容方案。

解密后的接口联调。明文可见之后，还要给请求补 Basic 凭证、给响应放开跨域并允许携带 cookie、给上游加自定义头。这些规则都作用在解密之后的 HTTP 层，把它们与证书问题分开排查，才能定位到真正的失败点。把证书问题、握手问题与 HTTP 层改写分开记录，也便于多人协作时快速交接。

::: cols 20|30|50
| 现象 | 优先检查 | 对应规则 |
|---|---|---|
| 只显示 Tunnel to | 根证书信任 | enable://https |
| IP 直连不解密 | 缺少 SNI | enable://captureIp |
| captureError | 证书固定 | disable://capture |
:::

## 可复制的配置

以下命令与规则按排障顺序给出，前一步没有生效就不要急着做后一步；每条规则都可以叠加 includeFilter 把范围收窄到单台设备或单个域名，验证完注释掉即可还原现场。先解决信任根：证书装好之前，任何解密规则都不会生效，Linux 还需要手动把证书放进系统目录。

```bash
# 来源：docs/docs/cli.md
w2 ca
# 来源：docs/docs/mobile.md（手机与远程下载根证书）
# http://[电脑IP]:[Whistle端口]/cgi-bin/rootca
# 来源：docs/docs/cli.md（Linux 手动安装）
sudo cp rootCA.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
# 来源：lib/config.js:809-810（另一件事：出站严格校验证书，启动期加 --mode safe）
w2 start --mode safe
```

解密必须显式开启。官方 enable.md 的示例误写成 enale://https，本站一律采用正确写法。

```txt
# 来源：docs/docs/rules/enable.md
# 官方示例误写 enale://https，此处用正确写法 enable
www.example.com enable://https
# 来源：docs/docs/faq.md（IP 直连默认不解密）
ip[:port] enable://captureIp
# 来源：docs/docs/rules/disable.md（官方示例 wwww 系笔误，本站用 www）
www.test.com/path disable://capture
```

证书固定与双向认证是解密的反面：要么跳过，要么提供客户端证书。

```txt
# 来源：docs/docs/faq.md（SSL Pinning 时跳过解密）
域名 disable://capture
域名 disable://capture includeFilter://reqH.user-agent=/xiaomi/i
# 来源：docs/docs/faq.md（Android 兼容）
www.example.com enable://emudhra
# 来源：docs/docs/rules/cipher.md（mTLS 与加密套件）
www.example.com/path tlsOptions://key=/User/xxx/test.key&cert=/User/xxx/test.crt
www.example.com/path tlsOptions://ECDHE-ECDSA-AES256-GCM-SHA384:DH-RSA-AES256-GCM-SHA384
```

明文阶段的鉴权与跨域改写。

```txt
# 来源：docs/docs/rules/auth.md（仅 Basic）
https://api.example.com/ auth://admin:secret
# 来源：docs/docs/rules/resCors.md
www.example.com/path resCors://*
www.example.com/path resCors://enable
# 来源：docs/docs/rules/reqHeaders.md
www.example.com/path reqHeaders://x-proxy=Whistle
```

Firefox 需单独放行系统证书，改完重启浏览器生效。

```txt
# 来源：docs/docs/faq.md（Firefox about:config）
security.enterprise_roots.enabled=true
```

## 背后的设计思想

[默认透传、显式才解密](/core/connect-mitm)：隧道默认只做字节转发，只有根证书已信任且 enable://https、Enable HTTPS 或自定义证书命中时才拆开。判定被写成层层收窄的条件，每多开一个解密入口都要有明确理由，避免把不该碰的系统流量也纳入中间人范围。

[信任范围最小化](/modules/certificates)：根证书下载接口只读取自签缓存文件并交给下载响应，用户自定义证书放在独立目录与独立数据结构里，界面不参与根证书私钥的写入。可下载的只有公钥证书，私钥始终留在进程内，把信任材料的暴露面压到最小。

[协议差异消化在入口层](/architecture/overview)：CONNECT、WebSocket 与普通 HTTP 在 tunnel.js 被归一成统一的伪 URL 与规则上下文，首包嗅探与 SNI 提取都在 https/index.js 的入口完成。上层 inspector 只面对明文 HTTP，才不用为每种入口形态重复实现鉴权与跨域逻辑。

[两段 TLS 信任边界互不混淆](/domain/tls-mitm)：客户端到代理这一段信任 Whistle 根证书，代理到源站是另一段独立连接。出站默认值在 `lib/config.js:65` 写死 `config.rejectUnauthorized = false`，只有 `--mode safe` / `rejectUnauthorized` 在 `lib/config.js:809-810` 把它改成 true，以兼容内网自签名证书；入站能否被信任取决于客户端是否安装并完全信任本地根 CA（iOS 还要开「完全信任」，`docs/docs/faq.md:92-94`），与出站校验开关互不牵连。

## 源码链路

1. **入口 · CONNECT 登记**：`lib/tunnel.js:38-44` 注册 connect 事件，`lib/tunnel.js:26-27` 定义黑名单正则，`lib/tunnel.js:144-148` 读取策略头，为判定准备上下文。参见[CONNECT 判定与 TLS 解密](/core/connect-mitm)。
2. **规则解析 · 解密判定**：`lib/tunnel.js:168-213` 的 isIntercept() 汇总开关、黑名单、自定义证书与策略头，决定是否拆开隧道。参见[CONNECT 判定与 TLS 解密](/core/connect-mitm)。
3. **应用点 · 先回 200 再嗅探**：`lib/tunnel.js:264-282` 先 `dispatch` 读首包，再由 `util.setEstablished(reqSocket)`（`:281`）回写固定的 `HTTP/1.1 200 Connection Established`（常量 `ESTABLISHED_CTN` 见 `lib/util/index.js:369-375`）；`lib/https/index.js:1184-1234` 借 `readOneChunk`（`lib/util/index.js:3618-3635`）拿到首包后依次判断 CONNECT、明文 HTTP，最后在 `:1232` 用反向条件 `if (!isHttpH2 && chunk[0] != 22) return next(chunk)` 回退——即只有 TLS 握手记录（首字节 0x16 = 22）或 h2c preface 才继续解密，源码里并没有 `chunk[0] === 22` 的正面分支；`lib/https/index.js:1295-1338` 再 `checkSNI(chunk)` 提取域名，无 SNI 时回退到 `tunnelHostname`。参见[隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。
4. **应用点 · 证书签发**：`lib/https/ca.js:582-607` 的 `getOrCreateCert` 先查 `remoteCerts` / `cachePairs`，未命中才 `createSelfCert` 签发；叶证书有效期按 `lib/https/ca.js:48-49,558-573` 的 `MIN_DATE` / `MAX_DATE` 定为「提前 7 天生效、36 天后过期」。`lib/https/ca.js:616-624` 的 `SNICallback` 再用 `createSecureContext` 把它挂到 TLS 服务端。参见[证书体系](/modules/certificates)。
5. **回写 · 根证书与出站策略**：`biz/webui/cgi-bin/rootca.js:4-12` 只提供证书下载；`lib/config.js:65` 默认 rejectUnauthorized 为 false，`lib/config.js:809-810` 在 --mode safe 时置为 true。参见[Web 管理界面](/modules/webui)与[进程模型与配置系统](/architecture/process-config)。
6. **回写 · 明文阶段改写**：`lib/inspectors/req.js:150-152` 与 `lib/inspectors/req.js:465-467` 应用 auth 与 reqHeaders，`lib/inspectors/res.js:833`、`lib/inspectors/res.js:868` 应用 resCors。参见[指令体系与分发链路](/modules/protocol-catalog)。

## 边界与坑

- 证书固定或 mTLS 客户端换证书会握手失败，官方建议对该域名 disable://capture，或按客户端 UA 只跳过特定设备（`docs/docs/faq.md`）；Android 可试 enable://emudhra（同文档）。
- 系统域名与 Cronet UA 命中硬编码黑名单后一律跳过解密，宁可看不到也不让设备断网（`lib/tunnel.js:26-27`、`lib/tunnel.js:199-200`）。
- 证书有效期分两套：动态签发的叶证书 `notBefore = now - 7 天`、`notAfter = now + 36 天`（`lib/https/ca.js:48-49,558-573` 的 `MIN_DATE` / `MAX_DATE`），是为避开 Apple / Chromium 对长期证书的限制；根证书走另一分支（`:569-570`）为 `now - 1 年` 到 `now + 10 年`，有效期约十年。安装根证书时看到的过期时间与浏览器校验的叶证书不是同一张，不要混写。
- `enable://emudhra` 不是安全实践：`lib/https/emudhra.js:6-8` 注释明确所用的是 mitmproxy 公开披露的 eMudhra 中间 CA 私钥与证书链（`assets/emudhra.pem`），`docs/docs/rules/enable.md:26`、`docs/docs/faq.md:98` 也写明是「已公开泄露」的密钥。它只是为兼容特定 Android 客户端证书固定而签发动态证书的兜底方案，既不是可信根证书，也不应推广到普通 HTTPS 流量。
- 出站 rejectUnauthorized 默认 false 仅限开发环境（`docs/docs/rules/cipher.md`），生产应加 --mode safe 开启校验（`lib/config.js:65`、`lib/config.js:809-810`）。
- auth 只支持 Basic，Bearer 与 OAuth 需用 reqHeaders 自行设置（`docs/docs/rules/auth.md`）；resCors://* 不支持带 cookie，启用凭证时不得用 *，应改用 resCors://enable（`docs/docs/rules/resCors.md`）。
- 自定义根证书不支持界面上传，需放入证书目录并重启（`docs/docs/gui/https.md:14`）；官方 `docs/docs/rules/enable.md:82` 示例的 `enale://https` 是笔误（应为 `enable://https`），`docs/docs/rules/disable.md` 示例里的 `wwww.*` 域名同样是照抄笔误，本站可复制配置一律用正确写法。

## 小结

- 先确认根证书信任，再开解密，最后处理鉴权与跨域，顺序颠倒会得出错误结论。
- 解密是例外而非常态，判定链上的每一层收窄都对应一类真实故障。
- 两段 TLS 各自独立，客户端信任根证书与出站是否校验源站证书是两件事。
- 证书固定流量应主动跳过，而不是继续尝试替换证书。
- 排障时先区分「没有解密」与「解密后规则未命中」，两者对应的源码路径完全不同。

## 下一步

[《真机、移动端与远程页面调试》](/scenarios/mobile-remote)：把这套证书与解密流程搬到手机与远程设备，再看注入式调试能力如何落在同一条明文链路上。
