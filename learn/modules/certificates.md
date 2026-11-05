---
title: 证书体系的实现细节
description: 拆解本地 CA 的生成字段、域名归并、多级缓存、自愈逻辑，以及自定义证书与下载安装链路。
---

# 证书体系的实现细节

HTTPS 抓包的前提是客户端信任 Whistle 自签的根 CA，而这套能力几乎全部集中在 `lib/https/ca.js` 一个文件里。本篇面向要改签发逻辑、排查证书告警或接入自定义证书的开发者，按「生成 → 缓存与签发 → 自愈 → 自定义与分发 → 安全边界」展开，并解释那些看似奇怪的字段取值。所有行号对应当前分支源码。

![本地 CA 与两段 TLS 的签发位置](/diagrams/tls-mitm.svg)
*根 CA 在启动时就绪，每个 SNI 域名由本地 CA 现签叶证书，客户端与源站各建立一段独立 TLS。*

## 生成时机与算法字段

`lib/https/ca.js:19-33` 在模块加载时就调用 `mkdir` 建好数据目录下的 `certs` 目录，并确定根密钥与根证书文件名（优先使用 `root_new.key` / `root_new.crt`）。真正的初始化在 `ca.js:580` 的 `createRootCA()`：它先加载自定义证书（`:427-431`），再尝试读取已有的根密钥与根证书（`:435-446`），读不到才由 `resetRootCA()`（`:406-416`）新建并 `fs.writeFileSync` 落盘。也就是说根 CA 只在首次启动或校验失败时重建，重启不会换证书。

算法字段由 `createCACert`（`ca.js:476-549`）与 `createCert`（`ca.js:558-573`）给出：底层是 node-forge，RSA 密钥长度由 `ca.js:42` 的 `KEY_SIZE = 2048` 固定；CN 取 `'whistle.' + 时间戳`（`:484`），自签用 `forge.md.sha256.create()`（`:543`），并置 `cA: true`。有效期刻意分成两档：

```js
// lib/https/ca.js:565-572
  if (isShortPeriod) {
    cert.validity.notBefore = new Date(now - MIN_DATE);
    cert.validity.notAfter = new Date(now + MAX_DATE);
  } else {
    cert.validity.notBefore = new Date(now - ONE_YEAR);
    cert.validity.notAfter = new Date(now + ONE_YEAR * 10);
  }
  return cert;
```

`ca.js:46-49` 定义 `MIN_DATE = 7 天`、`MAX_DATE = 36 天`：根证书走 `ONE_YEAR * 10` 的十年档，叶证书走「提前 7 天生效、36 天后过期」的短档。这样做是为了兼容浏览器对证书最长寿命的限制，同时给时钟偏差留缓冲。叶证书由 `createSelfCert`（`ca.js:206-266`）生成：序列号是 `sha1(hostname + 随机串)`（`:207-212`），复用根公钥与根私钥（`:213-217,263`），扩展里写 SAN（IP 用 type 7、域名用 type 2，`:241-252`）、AKI（`:255-257`）与 `cA: false`（`:227-229`），最后仍以 SHA-256 签名（`:260`）。复用同一把根私钥，省去了为每个域名生成密钥对的开销。根证书还写了 `keyUsage` 的 `keyCertSign`、`extKeyUsage` 的 serverAuth / clientAuth / codeSigning 以及 `nsCertType`（`ca.js:510-541`）；叶证书只开 `digitalSignature` 与 `keyEncipherment`（`:230-239`）。这组差异正是「根只负责签、叶只负责承载流量」的分工，也解释了为什么不能拿叶证书再签下一张证书。

## 域名归并、缓存与签发

若每个子域名都单独签发，缓存会迅速膨胀。`getDomain`（`ca.js:135-163`）先把主机名首段换成 `*`，命中已有通配缓存就复用；只有两级域名或命中 CDN 特征（`:150-159`）时才保留原名。IP 地址不归并（`:136`）。

缓存分四层，职责刻意分开：`customPairs`（`ca.js:34`）是用户上传证书的普通对象，`cachePairs`（`:39`，5120 项）、`certsCache`（`:40`，256 项）、`remoteCerts`（`:41`，1280 项）是 lru-cache 实例；`getCacheCert`（`:197-203`）按 `customPairs → cachePairs → certsCache` 顺序查找。签发入口是 `getOrCreateCert`：

```js
// lib/https/ca.js:582-596
function getOrCreateCert(servername) {
  var requestCert = servername[0] === ':';
  if (requestCert) {
    servername = servername.substring(1);
  }
  var lastIndex = servername.length - 1;
  var enableEmudhra = servername[lastIndex] === '.';
  var cert = !enableEmudhra && remoteCerts.get(servername);
  if (!cert) {
    servername = getDomain(servername);
    cert = getCacheCert(servername);
    if (!cert) {
      cert = createSelfCert(enableEmudhra ? servername.substring(0, lastIndex) : servername, enableEmudhra);
      cachePairs.set(servername, cert);
    }
  }
```

`ca.js:609-611` 把它注册给 hagent，并起两个内部 TLS server（端口 42900 与 43900）分别承载 HTTP/1 与 h2。`SNICallback`（`ca.js:616-624`）拿到 `options` 后用 `createSecureContext` 生成 `_ctx` 并缓存，避免每次握手重复建上下文。`getCacheCert` 把 `customPairs` 放在最前（`:197-203`），意味着用户为某域名提供的证书优先于自签证书；这也是 `sniCallback://` 动态证书要单独存进 `remoteCerts`、并在 `getOrCreateCert` 里最先查询的原因——动态下发必须能覆盖静态自定义证书。

::: cols 26|34|40
| 对象 | 路径或缓存 | 说明 |
|---|---|---|
| 根证书 | certs/root.crt | 十年自签 |
| 根私钥 | certs/root.key | 明文落盘 |
| 自定义证书 | custom_certs/ | key + crt 成对 |
| 签发缓存 | cachePairs | 上限 5120 |
| 下载缓存 | certsCache | 上限 256 |
| 动态证书 | remoteCerts | 上限 1280 |
| 上下文 | options._ctx | 按 SNI 复用 |
:::

## 校验与自愈

旧版本或异常退出可能留下不合规格的根证书，因此启动时会自检：`checkCertificate()`（`ca.js:111-120`）读取 PEM，检查公钥位数是否达到 `KEY_SIZE`、有效期是否越界、CN 是否匹配 `/^whistle\.\d+$/`；任一不通过就返回 false，`ca.js:90-95` 删掉旧的 key 与 crt 让 `createRootCA` 重建。运行期则由 `createRootCASafe()`（`ca.js:418-425`）在每次取根证书前检查过期，必要时 `resetRootCA()` 并 `resetAllCerts()` 清空签发缓存。

```js
// lib/https/ca.js:75-84
var startTime = Date.now();
var INTERVAL = ONE_DAY;
var MAX_AGE = MAX_DATE - INTERVAL * 2;
var timer = setInterval(function () {
  var now = Date.now();
  if (now - startTime >= MAX_AGE) {
    startTime = now;
    resetAllCerts();
  }
}, INTERVAL);
```

`ca.js:25-32` 的 `useNewKey` 还维护了一套 `root_new.*` 切换机制：存在新密钥对时优先使用，旧文件保留作回退，使密钥轮换可分两步完成而不必停机。`ca.js:69-84` 的每日定时器在 36 天到期前两天触发 `resetAllCerts()`（`:69-72`），提前强制重签，避免叶证书集中过期导致批量握手失败；`timer.unref()`（`:86-88`）保证它不阻塞进程退出。自定义证书另有一条线：`checkExpired()`（`ca.js:729-741`）每 600000 ms（10 分钟）遍历一次，发现过期就置 `exports.hasInvalidCerts` 供 UI 告警。三层自愈分别对应「启动修复」「运行期根过期」「叶证书轮换」，粒度不同但互不替代。

## 自定义证书与下载安装

`custom_certs/` 目录里的文件按同名成对识别：`.key` 配 `.crt` / `.cer` / `.pem`（`ca.js:347-369`），`parseAllCustomCerts`（`ca.js:287-337`）读取每张证书的 SAN，把 type 2 / 7 的名字写进 `customPairs`（`:305-333`）；名为 `root` 的一对会覆盖根 CA 路径（`:371-377`）。目录位置由 `config.CUSTOM_CERTS_DIR`（`lib/config.js:145`）给出，可用 `--certDir`（`lib/config.js:903-904`）另指，或用 `--mode disableCustomCerts`（`lib/config.js:732-733`）整体关闭。UI 上传走 `ca.js:806` 的 `uploadCerts`，落盘由 `ca.js:764-773` 的 `writeCertFile` 异步双写并回填 mtime，CGI 在 `biz/webui/cgi-bin/certs/*`。加载顺序也有讲究：`createRootCA` 先读 `--certDir` 指定的目录再读默认 `custom_certs`（`ca.js:429-430`）；`parseAllCustomCerts` 按文件 mtime 排序后逐个写入 `customPairs`（`:291-296`），因此同名 SAN 下以较新的文件为准；`loadCustomCerts` 对同名 `.crt` / `.cer` / `.pem` 也只保留 mtime 最新的一份（`:358-366`）。

下载安装是一条独立链路：`biz/webui/cgi-bin/rootca.js:4-13` 在返回文件的同时调用 `properties.setEnableCapture(true)`（`:9-11`），即「下载根证书」顺手打开 HTTPS 抓包；`rootca.pro` 是 `lib/config.js:37` 登记的虚域名，由 `biz/webui/lib/index.js:332-341` 直接识别。`w2 ca` 的平台实现在 `bin/ca/index.js:69-81`：macOS 用 `security add-trusted-cert`（`:21-28`），Windows 用 `certutil`（`:31-37`），Linux 用 `update-ca-certificates` / `update-ca-trust`（`:39-54`）。`cgi-bin/create-cert.js` 还能用 adm-zip 把指定域名的证书与私钥打包成 zip 供手动部署。

插件也可动态下发证书：`sniCallback://` 由 `lib/https/load-cert.js:7-43` 解析，结果写进 `remoteCerts.get/set`（`:13,41`），`getOrCreateCert` 会优先取它（`:589`）。另有 `assets/emudhra.pem` 与 `lib/https/emudhra.js`：注释明确它是 mitmproxy 提交中**公开披露**的密钥与链，用 ECDSA-SHA384 签名（`:26,30`），只用于兼容特定 Android 客户端，绝不能当作可信凭据。

## 安全边界

根私钥以 PEM 明文写入数据目录（`ca.js:410-411` 的 `fs.writeFileSync` 未显式指定模式），保护完全依赖该目录的访问控制；一旦泄露，持有者就能为任意域名签发被本机信任的证书。安装根 CA 意味着该系统上所有应用的 TLS 都可能被解密，范围远不止浏览器调试页，共用开发机上用完应及时取消信任。

一个容易被忽略的隔离是「下载的证书」与「MITM 实际签发的证书」分属不同桶：`createCertificate`（`ca.js:268-276`）只从 `cachePairs` 读、回退写 `certsCache`，源码注释写得很直白——「确保使用自己生成的证书，防止把用户证书下载出去」（`:270`）；用户上传的证书只进 `customPairs`，不会出现在下载接口里。

```js
// lib/https/ca.js:268-276
exports.createCertificate = function (hostname) {
  hostname = getDomain(hostname);
  var cert = cachePairs.get(hostname); // 确保使用自己生成的证书，防止把用户证书下载出去
  if (!cert) {
    cert = createSelfCert(hostname);
    certsCache.set(hostname, cert);
  }
  return cert;
};
```

`cgi-bin/create-cert.js` 正是调这个导出函数取证书再打包，而非 `getRootCA`，所以「下载根证书」与「导出某域名证书」都不会碰到 `customPairs`。改这块代码时最危险的做法是为了省事把 `createCertificate` 直接改成调 `getCacheCert`，那会顺带把用户上传的私钥一起送出去。

最后是出站侧：`lib/config.js:65` 默认 `config.rejectUnauthorized = false`，即不校验源站证书以兼容自签名环境，代价是中间人风险被转移到代理到源站这一段；只有 `--mode safe`（`lib/config.js:809-810`）才打开校验。便利与安全的取舍在这里是显式的，改源码时不要顺手把默认值反过来。

## 小结

- 根 CA 在模块加载与 `createRootCA()`（`:580`）时就绪，RSA 2048、CN 带时间戳、SHA-256 自签、十年有效。
- 叶证书 36 天且提前 7 天生效，复用根私钥，SAN / AKI / `cA:false` 由 `createSelfCert` 写入。
- `getDomain` 归并通配域名，`customPairs` / `cachePairs` / `certsCache` / `remoteCerts` 四级缓存配合 `SNICallback` 复用上下文。
- 启动自检、运行期自愈、每日轮换与每 10 分钟过期检查构成三层防护。
- 下载接口与签发缓存刻意分离，根私钥明文落盘、默认不校验源站证书，是必须知晓的安全边界。

## 下一步

[《插件系统》](/modules/plugins)：看第三方代码如何通过 pfork 子进程、hook 头与内部端口接入上述所有链路。
