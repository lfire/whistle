---
title: 第二层：TLS、证书与信任
description: 把对称加密、X.509 证书、SNI、证书链、两段 TLS 与信任锚逐个拆成对照源码的词典式词条。
---

# 第二层：TLS、证书与信任

本层是「概念精解」的密码学与信任篇，前置是 [代理与 CONNECT](/concepts/01-proxy)、[HTTP 报文与隧道](/concepts/02-http) 建立的连接模型。这里把 HTTPS 抓包背后那一长串专业名词——从对称加密、公钥私钥，到 X.509、证书链、SNI、两段 TLS——逐个拆成可对照源码的卡片。读完你能说清「装了根证书为什么还不解密」，能判断证书固定与 mTLS 属于哪一层问题，也能把 [TLS 中间人领域篇](/domain/tls-mitm) 与 [证书体系模块篇](/modules/certificates) 真正串起来。

## 本层概念地图

这些词不是并列的一堆缩写，而是一条自下而上的依赖链：先有加密算法，才有握手；握手要证明身份，于是有证书与信任锚；证书要挂到具体域名，于是有 CN、SAN 与 SNI；最后才谈得上代理把一条连接拆成两段 TLS 并做校验。读源码时按这个顺序定位，比在数千行文件里盲搜有效得多。

::: cols 20|40|40
| 层次 | 词条群 | 主要源码落点 |
|---|---|---|
| 密码学底座 | 对称/非对称、公钥私钥 | `lib/https/ca.js:42` |
| 握手协商 | 握手、Hello、套件 | `lib/https/index.js:9` |
| 证书与信任 | CA、链、锚、X.509 | `lib/https/ca.js:476` |
| 域名与协议 | CN、SAN、SNI、ALPN | `lib/https/ca.js:241` |
| 校验与解密 | 校验、MITM、两段 TLS | `lib/tunnel.js:168` |
:::

表中落点是各层的粗略锚点，逐个词条的真实行号见下方卡片。想按工程链路反查，可配合 [CONNECT 判定与 TLS 解密](/core/connect-mitm) 与 [证书体系的实现细节](/modules/certificates)；想只查缩写含义，可跳到 [术语速查](/advanced/reference) 或 [概念索引](/concepts/index)。

## 一、密码学底座

### 对称/非对称加密（Symmetric / Asymmetric Encryption）
> 对称加密双方共用一把密钥，非对称加密用公钥加密、私钥解密。

**打个比方**：对称加密像两人共用同一把保险箱钥匙，开箱关箱都快，难的是先把钥匙安全交到对方手里；非对称加密像街边邮筒，人人都能从投口把信塞进去（公钥），只有邮差拿钥匙开箱取信（私钥）。前者适合搬运大批货物，后者只适合先约定「货箱钥匙」这一件小事。

**在 Whistle 里**：握手阶段用非对称算法完成身份认证与密钥交换，真正承载 HTTP 报文的是对称加密；一旦 MITM 成立，代理拿到的是解密后的明文，规则改写全部作用在明文层（`lib/https/index.js:1102-1111`）。

**为什么这样设计**：非对称运算慢、只适合极小数据，对称运算快、适合长连接上的每一个字节。把昂贵运算压进一次握手，是 TLS 兼顾安全与吞吐的根本原因；代价是多出往返延迟与一整套失败面。

**容易混淆**：非对称并不「更安全」，只是解决密钥如何安全送达；与证书校验的区别见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：装好根证书后，浏览器到代理、代理到源站各做一次独立握手，见 [HTTPS 排障现场](/scenarios/https-trust)。

### 公钥/私钥（Public Key / Private Key）
> 公钥可公开分发，私钥必须严格保密，二者数学配对。

**打个比方**：公钥像一把可以随便复制的挂锁，谁都能用它把箱子锁上；私钥是唯一那把开锁钥匙，只留在主人手里。别人锁上的箱子，路上谁都打不开，只有主人能开。

**在 Whistle 里**：`lib/https/ca.js:214` 用 `pki.setRsaPublicKey(ROOT_KEY.n, ROOT_KEY.e)` 把根公钥塞进叶证书，`:260` 再用根私钥 `cert.sign(ROOT_KEY, ...)` 签名；根私钥由 `lib/https/ca.js:410-411` 以 PEM 明文写入数据目录。

**为什么这样设计**：签发任意域名证书只需持有同一把根私钥，省去为每个域名重新生成密钥对的开销；代价是这把私钥一旦泄露，持有者就能为任意域名签发被本机信任的证书。

**容易混淆**：公钥不等于证书，证书是「公钥 + 身份信息 + 签名」的封装；私钥落盘风险见 [能力边界](/scenarios/boundaries)。

**工程中的样子**：`w2 ca` 之后根私钥始终留在本机，切勿随数据目录备份到共享仓库，见 [证书体系](/modules/certificates)。

### TLS 握手（TLS Handshake）
> 通信前确认身份、协商算法并约定会话密钥的一次协商过程。

**打个比方**：像两个陌生人接头，先对暗号确认彼此身份，再商量用哪套密码本、把这次通话的临时密钥定下来。暗号对完，后面说正事就不必每次再自我介绍。

**在 Whistle 里**：首包判定是反向回退（`lib/https/index.js:1231-1234`）：先算 `isHttpH2`（是否为 h2c preface），若既不是 h2c、首字节又不是 `22`（TLS 握手记录），就 `return next(chunk)` 把字节交回纯透传；只有 TLS 握手记录或 h2c preface 才继续往下解密。随后 `lib/https/index.js:1295` 的 `checkSNI(chunk)` 从 ClientHello 里取域名；根 `index.js:32-41` 覆写 `tls.checkServerIdentity`，把校验异常改成可返回的错误对象而非抛出。

**为什么这样设计**：一次协商换来整条连接的安全上下文，避免每个请求重复认证；代价是握手失败会直接断连，且首包必须被代理读走才能识别形态——`lib/https/index.js:1184` 用 `readOneChunk` 嗅探第一包，判定后再由 `lib/https/index.js:1190` 把这段字节原样写回，否则客户端的 ClientHello 就丢了。

**容易混淆**：握手不是「每个请求一次」，一条 keep-alive 连接只握一次；与 HTTP 请求头的差别见 [HTTP 词条](/concepts/02-http)。

**工程中的样子**：用 `--mode safe` 打开严格校验后，握手期的证书错误会直接暴露，见 [HTTPS 排障现场](/scenarios/https-trust)。

### ClientHello/ServerHello（Client Hello / Server Hello）
> 握手最初两个消息：客户端报能力，服务端选定参数。

**打个比方**：像进餐厅点菜，客人先报「我会说这些语言、能吃这些菜」（ClientHello），店家回「那就定这套、用这把钥匙」（ServerHello）。第一句话里就写明了要找哪家店，店家才好去后厨取对应的菜牌。

**在 Whistle 里**：代理读到的第一个数据包就是 ClientHello，`lib/https/index.js:1184-1234` 用 `readOneChunk` 嗅探它，`lib/https/index.js:1295` 交给 `sni` 包解析域名，再据此签发证书。

**为什么这样设计**：域名、套件列表、ALPN 都必须在明文阶段的第一个消息里带出，服务端才能在握手早期选对证书；代价是这部分信息不加密，SNI 因此可被旁观察者看到。

**容易混淆**：ClientHello 不是 HTTP 请求头，它属于 TLS 记录层；与 SAN 的分工见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：首包嗅探与回退逻辑集中在 [CONNECT 判定与 TLS 解密](/core/connect-mitm)，IP 直连无 SNI 时需在规则侧显式放行。

### 密码套件（Cipher Suite）
> 一组约定好的认证、密钥交换、对称加密与摘要算法组合。

**打个比方**：像餐厅的套餐，把「怎么验身份、怎么换钥匙、用什么密码本、怎么校验没被改」打包成一份固定搭配。双方各报自己支持的套餐，选一份都有的。

**在 Whistle 里**：出站侧套件可由 `tlsOptions://` 规则指定；入站侧 ALPN 与协议档位由 `lib/https/ca.js:713-714` 的 `allowHTTP1` 配合 h2 支持列表决定（`lib/https/h2.js:10`）。

**为什么这样设计**：把互操作的算法选择标准化，老旧客户端与新浏览器可各取所支持的组合；代价是套件协商失败要能回退——`lib/https/h2.js:174-181` 在 `util.isCiphersError(e)` 时用 `tlsOptions` 规则里的套件重建连接，`lib/rules/index.js:682-735` 把 `tlsOptions://` 的 `ciphers`、`secureProtocol` 等字段解析成 TLS options。套件过多会拉长协商，弱套件还须主动禁用。

**容易混淆**：套件是「算法清单」，证书是「身份凭据」，二者不在同一层；规则写法见 [指令体系](/modules/protocol-catalog)。

**工程中的样子**：`tlsOptions://ECDHE-ECDSA-AES256-GCM-SHA384:...` 可限定套件，见 [HTTPS 排障现场](/scenarios/https-trust)。

## 二、证书与信任体系

### CA（Certificate Authority / 证书颁发机构）
> 负责签发证书、为证书持有者身份背书的可信主体。

**打个比方**：像公证处，它不替你办事，只在你的材料上盖章，让陌生人因为信这个章而信你。章本身的可信度，来自更上一级已公认的权威。

**在 Whistle 里**：Whistle 自己就是一个本地 CA，`lib/https/ca.js:476-549` 的 `createCACert()` 生成带 `cA: true` 的自签根证书，之后所有叶证书都由它签发。

**为什么这样设计**：调试工具不可能让公共 CA 为任意域名签证书，只能在本机造一个信任源；代价是这个信任源必须被手动装进系统，且信任范围会覆盖整机所有应用。

**容易混淆**：CA 是「机构/角色」，根证书是它的「凭据文件」；二者关系见 [证书体系](/modules/certificates)。

**工程中的样子**：`w2 ca` 安装的就是这个本地 CA 的根证书，见 [HTTPS 排障现场](/scenarios/https-trust)。

### 根证书（Root Certificate）
> 自签的 CA 证书，是整条证书链最终被信任的起点。

**打个比方**：像一枚封存的总章母版，平时锁在保险柜里不轻易动，下面所有分章都靠它授权。别人认不认你，只看最后能不能追到这枚母版。

**在 Whistle 里**：`lib/https/ca.js:484` 把 CN 设为 `'whistle.' + 时间戳`，`:543` 用 SHA-256 自签，`lib/https/ca.js:558-573` 给它十年有效期；启动时 `lib/https/ca.js:113-120` 的 `checkCertificate()` 会校验公钥位数、有效期与 CN 格式。

**为什么这样设计**：根长期有效、尽量少变动，才能作为稳定信任起点；代价是根私钥长期驻留本机，一旦泄露影响面最大，所以自检失败会删文件重建（`lib/https/ca.js:90-95`）。

**容易混淆**：根证书不是叶证书，前者 `cA:true` 只负责签，后者 `cA:false` 只承载流量；详见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：`bin/ca/index.js:69-81` 分 macOS、Windows、Linux 三平台把根证书装进系统信任库，见 [移动端与远程调试](/scenarios/mobile-remote)。

### 中间证书（Intermediate Certificate）
> 由根签发、再向下签发叶证书的中间层 CA 证书。

**打个比方**：像总公司的地区分部公章，总部把签发权授给分部，日常办证由分部盖；某家分部出问题，只吊销它的章，不必惊动总部母版。

**在 Whistle 里**：常规签发是「根 → 叶」两级，不设中间层；唯一例外是兼容特定 Android 客户端的 emudhra 链，`lib/https/emudhra.js:9-17` 从 pem 解码出证书并拼成完整链，`lib/https/emudhra.js:38` 把这条链附在叶证书之后返回。

**为什么这样设计**：公共 PKI 靠中间层把根私钥隔离离线、按需吊销；Whistle 为简化实现选择直签，只在兼容场景引入现成链，代价是少了一层吊销粒度。

**容易混淆**：中间证书不是根证书，它有上级签发者；链层级见 [TLS 中间人](/domain/tls-mitm)。

**工程中的样子**：`enable://emudhra` 走这条兼容链，见 [HTTPS 排障现场](/scenarios/https-trust)。

### 叶证书（Leaf Certificate / End-Entity Certificate）
> 挂在具体域名上、直接参与服务器身份认证的那张证书。

**打个比方**：像每家门店挂出来的营业执照，写明「本店叫这个名字」，由总公司盖章颁发。顾客验的是这张照，追的是背后那枚总章。

**在 Whistle 里**：`lib/https/ca.js:205-266` 的 `createSelfCert()` 按域名现签：`:221` 把 CN 设为该域名，`:227-229` 置 `cA: false`，`:241-252` 写 SAN，`:263` 复用根私钥 PEM；有效期由 `lib/https/ca.js:48-49,565-567` 定为 `notBefore` 提前 7 天、`notAfter` 为 36 天。

**为什么这样设计**：按域名即时签发、短寿命、复用同一把根私钥，兼顾缓存命中与浏览器寿命限制；代价是每个新域名首次访问都要生成一次证书。

**容易混淆**：叶证书不是根证书，它 `cA:false` 不能再签下一张；两者的字段差异见 [证书体系](/modules/certificates)。

**工程中的样子**：`lib/https/ca.js:582-607` 的 `getOrCreateCert()` 按 SNI 域名取缓存或签发，见 [证书体系的实现细节](/modules/certificates)。

### 自签证书（Self-Signed Certificate）
> 签发者与持有者相同、不依赖上级 CA 背书的证书。

**打个比方**：像自己给自己写的一封推荐信，内容可以写得很正式，但别人没有理由天然相信，除非他先明确表示「我认这个人的字」。

**在 Whistle 里**：根证书 `lib/https/ca.js:508-509` 用同一组属性既 `setSubject` 又 `setIssuer`，构成严格自签；叶证书则由根签发，并非自签，只是常被笼统称作「自签证书」。

**为什么这样设计**：无需向外部 CA 申请即可立刻拥有签发能力，代价是它默认不被任何系统信任，必须由用户主动安装才能生效。

**容易混淆**：自签不等于不安全，只是「信任需要手动建立」。别把「源站自签证书」与「本地自签根 CA」混为一谈：前者是代理 → 源站这一段的对端证书，`rejectUnauthorized=false` 时默认放行；后者是 Whistle 自己造的信任锚，决定入站伪造证书能否被客户端信任。与证书固定的差别见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：`w2 ca` 的本质就是把这张自签根证书变成受信任的锚，见 [能力边界](/scenarios/boundaries)。

### 证书链（Certificate Chain）
> 从叶证书逐级回溯到根证书的一串签名关系。

**打个比方**：像一串介绍信：门店拿分部开的信，分部拿总部开的信，验信人一路往上核对每级盖章，直到见到自己本来就认的那枚总章。

**在 Whistle 里**：浏览器侧逐层验签至信任锚；服务端侧 emudhra 兼容链由 `lib/https/emudhra.js:38` 把中间证书链拼在叶证书 PEM 之后一并返回。

**为什么这样设计**：把「验证」拆成可逐级追溯的签名关系，根就能长期离线、中间层可独立吊销；代价是服务端必须把整条链发全，缺一段就会告警。

**容易混淆**：链不是「多张证书随便堆」，顺序与签发关系必须正确；排障见 [HTTPS 排障现场](/scenarios/https-trust)。

**工程中的样子**：浏览器报「证书不受信任」时，先查根是否装好、链是否完整，见 [HTTPS 排障现场](/scenarios/https-trust)。

### 信任锚（Trust Anchor）
> 客户端信任库里预置、验证链条到此终止的根证书。

**打个比方**：像你心里那份「我本来就认的人」名单，介绍信追到名单上的人就停止核对，不再追问谁给他背书。名单之外，写再多介绍信也没用。

**在 Whistle 里**：`w2 ca` 把本地根证书写进系统信任库（`bin/ca/index.js:69-81`），从此该证书成为整机所有应用的信任锚；Firefox 用独立信任库，需另行放行。

**为什么这样设计**：信任必须有终点，否则验签会无限上溯；把终点收敛到一小撮预置根，是可管理的安全模型，代价是装一个根等于扩大整机信任面。

**容易混淆**：信任锚不是中间证书，它没有被谁签发；与「装了根证书」的差别见 [能力边界](/scenarios/boundaries)。

**工程中的样子**：手机与远程设备安装根证书走下载接口，见 [真机、移动端与远程页面调试](/scenarios/mobile-remote)。

### X.509（X.509 标准）
> 规定证书字段、扩展与签名结构的国际标准格式。

**打个比方**：像各国通用的护照版式，姓名、有效期、签发机关、防伪区都印在固定位置，边检才能用同一套流程验任何国家的护照。

**在 Whistle 里**：`lib/https/ca.js:559` 用 node-forge 的 `pki.createCertificate()` 建对象，`:225-258` 通过 `setExtensions` 写入 basicConstraints、keyUsage、subjectAltName 等标准扩展。

**为什么这样设计**：统一结构让浏览器、操作系统、Node 的 TLS 栈能互认同一张证书；Whistle 在 `lib/https/ca.js:225-258` 用 `setExtensions` 一次写入 basicConstraints、keyUsage、extKeyUsage、subjectAltName 与 authorityKeyIdentifier，少了 SAN 或 basicConstraints 就会校验失败。代价是字段名晦涩、顺序固定，改动必须严格合标准，否则直接被拒。

**容易混淆**：X.509 是「内容结构」，PEM/DER 是「编码格式」，不是一回事；见 [术语速查](/advanced/reference)。

**工程中的样子**：`lib/https/ca.js` 全篇都在按 X.509 拼字段，见 [证书体系的实现细节](/modules/certificates)。

### CN（Common Name / 通用名）
> 证书 subject 里写明主体名称的历史字段。

**打个比方**：像营业执照上印的店名，早年大家只看这一个名字对不对得上；后来店多了、分店多了，就改看背面附注的清单。

**在 Whistle 里**：根证书 CN 为 `'whistle.' + 时间戳`（`lib/https/ca.js:484`），叶证书 CN 直接取域名（`:221`）；启动自检 `lib/https/ca.js:117` 用正则 `/^whistle\.\d+$/` 校验根 CN。

**为什么这样设计**：保留 CN 只为兼容老客户端与自检逻辑；真正的域名匹配早已交给 SAN。代价是只填 CN 的旧写法在新浏览器里会被判为不匹配。

**容易混淆**：CN 不是 SAN，现代校验只认 SAN；二者差别见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：自定义证书若只写了 CN 没写 SAN，界面能导入却不生效，见 [证书体系](/modules/certificates)。

### SAN（Subject Alternative Name / 使用者可选名称）
> 证书扩展里列出该证书可匹配的全部域名与 IP。

**打个比方**：像执照背面附注的「本照同时适用于这三家分店、这个门牌号」，验照人按这份清单逐项比对，而不是只看封面店名。

**在 Whistle 里**：`lib/https/ca.js:241-252` 按 `net.isIP(hostname)` 分别写 `type:7`（IP）或 `type:2`（域名），`lib/https/ca.js:305-306` 解析自定义证书时也只认这两种 SAN。

```js
// lib/https/ca.js:241-252
{
  name: 'subjectAltName',
  altNames: [
    net.isIP(hostname)
      ? { type: 7, ip: hostname }       // IP 地址
      : { type: 2, value: hostname }    // 普通域名
  ]
}
```

**为什么这样设计**：一证多域、同时覆盖域名与 IP，且现代浏览器只以 SAN 判匹配；代价是漏写某个别名就会对该别名告警。

**容易混淆**：SAN 是证书里「能对上哪些名字」，SNI 是握手里「我要找哪个名字」，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：`tlsOptions://key=...&cert=...` 是 Whistle 出站时作为客户端向源站出示的证书，服务端按签发链与 `clientAuth` 用途校验，并不按 SAN 比对域名；SAN 只在客户端校验服务端证书时用于匹配域名。写法见 `docs/docs/rules/cipher.md`，现场见 [HTTPS 排障现场](/scenarios/https-trust)。

## 三、域名指示与协议协商

### SNI（Server Name Indication / 服务器名称指示）
> 客户端在 ClientHello 里明文带上的目标域名扩展。

**打个比方**：像信封上写的收件人姓名，邮局不必拆信就知道该把信投进哪家的信箱；一栋楼里住着很多户，全靠这个姓名分信。

**在 Whistle 里**：`lib/https/index.js:9` 引入 `sni` 包，`:1295` 的 `checkSNI(chunk)` 从首包取出域名；`lib/https/ca.js:616-624` 的 `SNICallback` 拿到 servername 后调 `getOrCreateCert` 取缓存或现签证书，首次用 `createSecureContext`（`lib/https/ca.js:620`）把 key/cert 编译成 `_ctx` 挂在证书对象上，再 `cb(null, ctx)` 交回 TLS 层，后续同域名直接复用 `_ctx`。

**为什么这样设计**：同一 IP 托管多个站点时，服务端必须在握手早期知道域名才能选对证书；代价是域名以明文暴露，且 IP 直连的客户端往往不发 SNI。

**容易混淆**：SNI 不是 SAN，一个在握手消息里、一个在证书里；这是全站最易混的一对，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：IP 直连默认不解密，需 `enable://captureIp` 显式放行，见 [HTTPS 排障现场](/scenarios/https-trust)。

### ALPN（Application-Layer Protocol Negotiation）
> 在 TLS 握手里顺带协商上层用 h2 还是 http/1.1 的扩展。

**打个比方**：像两人见面先约好「接下来用中文还是英文聊」，话一开头就定好，免得说到一半再换语言。语言定完，正题才开始。

**在 Whistle 里**：`lib/https/ca.js:713-714` 用 `SNICallback` 与 `allowHTTP1` 控制是否启用 h2，`lib/init.js:207` 从内部头读出 ALPN 结果并推断 `req.isH2`。

**为什么这样设计**：h2 与 http/1.1 共用 443 端口，必须在握手期决定，不能等收到 HTTP 报文再猜；代价是协商结果要一路透传到请求中间件。

**容易混淆**：ALPN 不是 SNI，前者定「说什么协议」，后者定「找哪个站点」；见 [HTTP/2、WebSocket 与流量形态](/domain/web-protocols)。

**工程中的样子**：`disable://http2` 可强制退回 http/1.1，见 [指令体系与分发链路](/modules/protocol-catalog)。

## 四、校验、解密与能力边界

### 证书校验（Certificate Verification）
> 按信任库逐级验签，并核对域名、有效期与用途。

**打个比方**：像门卫查验证件：先看是不是可信机关发的、章对不对，再看名字是不是本人、有没有过期、这本证能不能用于进这扇门。

**在 Whistle 里**：出站侧默认不校验源站证书（`lib/config.js:65` 的 `rejectUnauthorized = false`），根 `index.js:32-41` 覆写 `tls.checkServerIdentity` 把校验异常改成返回值而非抛出。

**为什么这样设计**：调试环境常有内网自签证书，默认严格校验会让大量请求直接失败；代价是代理到源站这一段失去了对假冒服务端的防护。

**容易混淆**：证书校验是「按信任库验链」，证书固定是「只认写死的那张」，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：需要严格校验时用 `--mode safe`，见 [能力边界、风险与合规](/scenarios/boundaries)。

### rejectUnauthorized（拒绝未授权证书）
> Node TLS 连接里控制「是否校验对端证书」的布尔开关。

**打个比方**：像门卫手里那个总开关：拨到关，任何人递张证件都放行；拨到开，才按上一节那套流程认真查证。

**在 Whistle 里**：`lib/config.js:65` 默认置为 `false`，`lib/config.js:809-810` 在 `--mode safe`（或 `rejectUnauthorized`）时置为 `true`；`lib/https/ca.js:602` 在请求客户端证书分支里又单独设了一次 `false`。

**为什么这样设计**：把便利与安全的取舍显式化成一个开关，默认偏向「能连上」，需要时一键收紧；代价是默认值偏向宽松，生产环境必须主动改。

**容易混淆**：它只管「代理 → 源站」这一段，与入站伪造证书无关，两段信任独立，见 [TLS 中间人](/domain/tls-mitm)。

**工程中的样子**：`w2 start --mode safe` 打开校验，见 [HTTPS 排障现场](/scenarios/https-trust)。

### MITM（Man-in-the-Middle / 中间人）
> 代理分别与客户端、源站握手，在中间取得明文的做法。

**打个比方**：像同声传译坐在两国代表之间，对左边说自己是对方、对右边也说自己是对方，两边都以为在直接谈，实际上每句话都经传译转述、也可被改写。

**在 Whistle 里**：`lib/tunnel.js:168-213` 的 `isIntercept()` 决定是否拆开隧道，拆开后 `lib/https/index.js:1102-1111` 把解密后的明文请求重新 `server.emit('request', req, res)` 塞回 Express 链。

**为什么这样设计**：规则改写、抓包、重放都只能在明文上做，所以必须换出明文；代价是必须持有客户端信任的签发权，且多一段握手就多一份延迟与失败面。

**容易混淆**：MITM 不是破解加密算法，而是两次合法握手；与纯透传的区别见 [CONNECT 判定与 TLS 解密](/core/connect-mitm)。

**工程中的样子**：`enable://capture` 强制解密、`disable://capture` 跳过，见 [HTTPS 排障现场](/scenarios/https-trust)。

### 两段 TLS（Two Independent TLS Segments）
> 客户端到代理、代理到源站各自独立建立的加密连接。

**打个比方**：像两段接力路程，第一段你把货交给本地驿站、第二段驿站再装车发往远方；两段各查各的证件、各用各的钥匙，中间的驿站短暂看得到货。

**在 Whistle 里**：入站由 `lib/https/ca.js:610-611` 起在 42900、43900 的内部 TLS server 承载，出站是代理以普通客户端身份另起连接；两段之间的明文由 `lib/https/index.js:1105` 回流。

**为什么这样设计**：把「客户端信任谁」与「代理信任谁」彻底分开，才能一侧用本地根证书、另一侧按需决定是否校验源站；代价是任何一侧失败都会让整条请求失败。

**容易混淆**：两段 TLS 不是「一条隧道加密两次」，而是两条独立连接加一段明文桥，见 [TLS 中间人](/domain/tls-mitm)。

**工程中的样子**：系统流量黑名单命中时整条放行、不拆两段（`lib/tunnel.js:26-27`），见 [能力边界](/scenarios/boundaries)。

### 证书固定/SSL Pinning（Certificate / Public Key Pinning）
> 客户端把预期证书或公钥写死在代码里，不理会系统信任库。

**打个比方**：像只认熟人脸的门卫，哪怕来人拿着最权威机关开的最新介绍信，只要脸对不上就一律不放行。换一张再合法的证书也没用。

**在 Whistle 里**：这类客户端换证书必然握手失败，因此 `lib/tunnel.js:26-27` 把 Cronet UA 与 Apple、Microsoft 等系统域名列入黑名单；`lib/tunnel.js:199-200` 命中时让 `isEnableIntercept()` 返回 `false`，`lib/tunnel.js:202-213` 的 `isIntercept()` 随之返回 `false`，隧道不拆开、按纯字节透传——这是「避开」而不是解密。

**为什么这样设计**：应用用 pinning 主动防御中间人，安全收益很高；代价是证书轮换必须随应用发版。代理无法为这类连接换发被信任的证书，唯一可行的是识别并放行、退回纯透传，而不是突破 pinning。

**容易混淆**：pinning 不是证书校验，前者只认写死的凭据、后者按信任库验链，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：对这类域名用 `disable://capture` 跳过解密，见 [HTTPS 排障现场](/scenarios/https-trust)。

### mTLS/客户端证书（Mutual TLS / Client Certificate）
> 服务端也要求客户端出示证书，形成双向身份认证。

**打个比方**：像进保密单位，不只门卫要出示证件证明「这里是真单位」，访客也得掏出自己的证件证明「我是被允许的人」，少任何一张都进不去。

**在 Whistle 里**：入站侧（浏览器 → 代理，Whistle 充当服务端索要客户端证书）由 `lib/https/index.js:1315-1318` 依据 `enable.clientCert` 计算 `requestCert`，再经 `lib/https/ca.js:715-722` 写进内部 TLS server 的 `options`，`lib/https/index.js:1270` 用 serverKey 前置 `:` 标记需要客户端证书、`lib/https/ca.js:583` 再据此解析。出站侧（代理 → 源站，Whistle 充当客户端出示证书）是另一条链：`lib/rules/index.js:742` 的 `getClientCert` 解析 `tlsOptions://key=...&cert=...`，`lib/https/index.js:368` 的 `setClientCert` 把凭据写进出站 TLS 的 `options`。

**为什么这样设计**：高安全接口要求双方都持证，单向 TLS 只验证服务端不够；代价是两段 TLS 各自都要处理证书——入站要备好 `requestCert` 与信任设置（`lib/https/ca.js:715-722`），出站要持有源站认可的客户端证书（`lib/https/index.js:368`），任一侧拿不出凭据就握手失败。

**容易混淆**：mTLS 不是单向 TLS 的加强版开关，它多了一整条客户端证书校验链；更要分清「客户端证书」与「服务端证书」——前者由客户端持有、供服务端验，后者由服务端持有、客户端按 SAN 与信任链验，两张证书的方向与校验者正好相反，见 [易混淆辨析](/concepts/08-confusions)。

**工程中的样子**：`www.example.com/path tlsOptions://key=/certs/client.key&cert=/certs/client.crt`，见 [HTTPS 排障现场](/scenarios/https-trust)。

## 五、速览表：证书工程词

以下词条不单独展开，读代码时用来对齐称呼；落点列给出 Whistle 中最接近的实现位置，纯格式类词（PEM、DER、PFX）对应 node-forge 编码或出站客户端证书分支。CSR 在本工程没有对应实现——动态签发直接用根私钥签名（`lib/https/ca.js:260`），不经过证书申请。

::: cols 16|30|30|24
| 名词 | 一句话 | 源码落点 | 易混淆 |
|---|---|---|---|
| CSR | 签发申请，本工程未用 | 无直接实现 | 非证书本身 |
| Basic Constraints | 标明能否签发 | `lib/https/ca.js:227` | 非密钥用途 |
| AKI/SKI | 标识签发与主体密钥 | `lib/https/ca.js:186,255` | 非序列号 |
| 有效期 | 证书生效与过期区间 | `lib/https/ca.js:558` | 非会话时长 |
| 上下文缓存 | 复用 SecureContext 结果 | `lib/https/ca.js:618` | 非会话 ticket |
| PEM | 文本编码的证书 | `lib/https/ca.js:264` | 与 DER 不同 |
| DER | 二进制 ASN.1 编码 | `lib/https/emudhra.js:14` | 与 PEM 不同 |
| PFX/P12 | 含私钥的打包格式 | `lib/util/index.js:3551` | 非 PEM 明文库 |
| SHA-256 | 证书签名摘要算法 | `lib/https/ca.js:543` | 非对称密钥 |
:::

::: cols 16|30|30|24
| 名词 | 一句话 | 源码落点 | 易混淆 |
|---|---|---|---|
| RSA 2048 | 根密钥固定长度 | `lib/https/ca.js:42` | 非签名算法 |
| node-forge | 纯 JS 的 PKI 库 | `lib/https/ca.js:1` | 非 Node 内置 |
| createSecureContext | 生成 TLS 上下文 | `lib/https/ca.js:10` | 非签发证书 |
| SNICallback | 按域名回证书上下文 | `lib/https/ca.js:616` | 非 SNI 解析 |
| 信任库 | 系统预置根的集合 | `bin/ca/index.js:69` | 非签发缓存 |
| 证书序列号 | 证书唯一编号 | `lib/https/ca.js:207` | 非 AKI/SKI |
| ECDSA | 椭圆曲线签名 | `lib/https/emudhra.js:26` | 非 RSA |
| emudhra | 公开披露的兼容链 | `lib/https/emudhra.js:6` | 非可信凭据 |
| `--mode safe` | 打开出站严格校验 | `lib/config.js:809` | 非解密开关 |
:::

`lib/https/ca.js:42` 的 `KEY_SIZE = 2048` 与 `:543` 的 `forge.md.sha256.create()` 分别定死根密钥长度与签名摘要；`:48-49` 定义 `MIN_DATE = 7 天`、`MAX_DATE = 36 天`，`:558-573` 据此把有效期分成两档——叶证书 `notBefore` 提前 7 天（容忍客户端时钟偏差）、`notAfter` 为 36 天，根证书 `notBefore` 提前 1 年、`notAfter` 为十年；`:618` 把生成过的 `_ctx` 挂在证书对象上避免重复建上下文。emudhra 一行注释明确它是 mitmproxy 提交中公开披露的密钥与链，只用于兼容特定 Android 客户端，绝不能当作可信凭据，详见 [证书体系](/modules/certificates)。

## 与工程实际结合

**新机器首次抓 HTTPS。** 顺序是「先建立信任锚，再开启解密」：证书没装好之前，任何解密规则都不会生效。

```bash
# 来源：docs/docs/cli.md
w2 ca
w2 start --mode safe
```

`w2 ca` 走 `bin/ca/index.js:69-81` 的三平台安装；`--mode safe` 对应 `lib/config.js:809-810`，把出站 `rejectUnauthorized` 打开。完整排障顺序见 [HTTPS、证书与鉴权的排障现场](/scenarios/https-trust)。

**IP 直连、证书固定与 mTLS。** 三类问题都发生在「要不要拆开」与「拆开后证书对不对」这两层，规则各不一样。

```txt
# 来源：docs/docs/faq.md、docs/docs/rules/cipher.md
www.example.com enable://https
ip[:port] enable://captureIp
www.example.com disable://capture
www.example.com/path tlsOptions://key=/certs/client.key&cert=/certs/client.crt
```

`enable://captureIp` 补的是 IP 直连不发 SNI 的缺口（`lib/https/index.js:1295`）；`disable://capture` 让 pinning 与 mTLS 流量退回纯透传（`lib/tunnel.js:168-213`）；`tlsOptions` 提供的是出站客户端证书，由 `lib/rules/index.js:742` 的 `getClientCert` 解析、再由 `lib/https/index.js:368` 的 `setClientCert` 应用到出站 TLS 连接，与入站 `requestCert`（`lib/https/index.js:1315-1318`）不是一回事。逐条现象对应表见 [HTTPS 排障现场](/scenarios/https-trust)，判定链源码见 [CONNECT 判定与 TLS 解密](/core/connect-mitm)。

**手机与远程设备。** 根证书要从下载接口取回再手动信任，装完还需在 iOS 上开启完全信任、在 Firefox 上单独放行系统证书库；这一步对应 [信任锚](#信任锚trust-anchor) 词条。操作见 [真机、移动端与远程页面调试](/scenarios/mobile-remote)，安装入口源码见 `bin/ca/index.js:69-81`。

**两段 TLS 的边界。** 入站伪造证书与出站是否校验是两件事：`lib/config.js:65` 的默认宽松只影响代理到源站那一段，客户端到代理那一段始终依赖本地根证书。把根证书装进信任库会扩大整机信任面，pinning 与 mTLS 也不应被强行绕过，合规与风险见 [能力边界、风险与合规](/scenarios/boundaries) 与 [TLS 中间人](/domain/tls-mitm)。

## 常见误解

1. **装了根证书 ≠ 一定解密。** `w2 ca` 只建立了信任锚，解密还要过 `lib/tunnel.js:168-213` 的 `isIntercept()`：策略头、`disable://capture`、全局抓包开关、`lib/tunnel.js:26-27` 的系统黑名单，以及 `lib/https/index.js:1231-1234` 的首包回退，任一命中都会退回纯透传。抓包列表只有 `Tunnel to` 时应先查这几层，见 [CONNECT 判定与 TLS 解密](/core/connect-mitm)。
2. **SNI ≠ SAN。** SNI 是客户端在 ClientHello 里明文写「我要找谁」（`lib/https/index.js:1295`），SAN 是证书里写「我能对上哪些名字」（`lib/https/ca.js:241-252`）。前者驱动选证书，后者用于校验匹配，方向相反、载体不同，详见 [易混淆辨析](/concepts/08-confusions)。
3. **证书校验 ≠ 证书固定。** 校验是「按信任库逐级验签」（`lib/config.js:65`、`lib/config.js:809-810`），固定是「只认写死的那张」；`lib/tunnel.js:199-200` 的黑名单只是让这些域名避开解密、退回透传，并不能绕过固定。前者可被 `--mode safe` 收紧，后者换任何合法证书都失败。
4. **根证书 ≠ 叶证书。** 根 `cA:true`、`notAfter` 十年、只负责签（`lib/https/ca.js:512-513`、`:570`）；叶 `cA:false`、`notBefore` 提前 7 天 / `notAfter` 36 天、只承载流量（`lib/https/ca.js:227-229`、`:565-567`）。拿叶证书再签下一张会直接被拒，字段差异见 [证书体系](/modules/certificates)。
5. **入站伪造证书 ≠ 出站不校验。** 两段 TLS 各自独立信任：入站靠本地根证书（`lib/https/ca.js:630-636`），出站由 `rejectUnauthorized` 单独决定（`lib/config.js:65`）。开了 `--mode safe` 不会改变入站签发，装了根证书也不会替出站把关，见 [TLS 中间人](/domain/tls-mitm)。
6. **MITM ≠ 破解加密，mTLS ≠ 单向 TLS。** MITM 是两次合法握手换出中间明文（`lib/https/index.js:1102-1111`），没有破解任何算法；mTLS 多了一整条客户端证书校验链（入站 `lib/https/index.js:1315-1318`、出站 `lib/https/index.js:368`），代理若无合法客户端证书，换证书会立刻握手失败，见 [HTTPS 排障现场](/scenarios/https-trust)。

## 小结

- 对称加密承载正文、非对称加密负责握手认证与密钥交换，性能取舍决定了 TLS 的基本形态。
- X.509 证书把公钥与身份封装成可验签的凭据，根证书 → 叶证书经信任锚逐级校验，SAN 才是现代域名匹配的依据。
- SNI 驱动按域名现签叶证书，ALPN 决定上层协议；CN 只保留兼容作用，不再是匹配依据。
- MITM 用两段独立 TLS 换出中间明文，`isIntercept()` 与首包嗅探层层收窄，装根证书只是前提而非充分条件。
- 证书校验、证书固定、mTLS 分属不同层：一个管验链、一个只认写死凭据、一个要求双向持证，排障时不能混为一谈。
- 出站默认宽松、入站依赖本地根证书，两段信任边界分离，风险与合规见 [能力边界](/scenarios/boundaries)。

## 下一步

[《第三层：Node 运行时与内核骨架》](/concepts/04-runtime)：证书与握手讲清了「明文怎么来」，下一篇回到 Node 本身，看 `http.Server` 的四类事件、Stream 与 `pipe`、事件总线、进程模型和配置单例如何把这份明文接住并送进规则链。
