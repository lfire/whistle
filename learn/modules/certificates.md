---
title: 证书体系的实现细节
description: 拆解本地 CA 的生成字段、域名归并、多级缓存、自愈逻辑，以及自定义证书与下载安装链路。
---

# 证书体系的实现细节

HTTPS [抓包](/concepts/05-capture)的前提是客户端信任 Whistle 自签的根 [CA](/concepts/03-tls)，而这套能力几乎全部集中在 `lib/https/ca.js` 一个文件里。本篇面向要改签发逻辑、排查证书告警或接入自定义证书的开发者，按「生成 → 缓存与签发 → 自愈 → 自定义与分发 → 安全边界」展开，并解释那些看似奇怪的字段取值。所有行号对应当前分支源码。前面 [《CONNECT 判定与 TLS 解密》](/core/connect-mitm) 讲清了什么情况下拆开 CONNECT、[《HTTPS、证书链与中间人》](/domain/tls-mitm) 讲清了两段 TLS 与信任链如何建立，而紧邻的 [《指令体系与分发链路》](/modules/protocol-catalog) 把指令一路分发到各个改写点，却把几项握手阶段指令只标成「TLS 参数」、没交代它们生效的前提；本篇就补上这个前提——先有客户端信任的本地根 CA、再由它为每个域名签发叶证书，那条「匹配 → 改写 → 出站」的链才接得上加密流量。读完你能独立看懂签发链路、排查证书告警或接入自定义证书。

::: tip 先修知识
先做 [第 0 站](/guide/quickstart)：本篇讲的是你在 Rules 与界面背后动过的那套机制。

若某个名词卡住，按主题回查 [概念精解总览](/concepts/index) 与 [《全量术语索引》](/concepts/glossary)；正文在术语首次出现处也给了对应链接。

不要求预先读过 Whistle 源码，但知道「证书 = 公钥 + 主体信息 + 上级签名」会更轻松。

给不熟悉证书的读者补一句：所谓「根 CA 被信任」，是客户端把这张自签证书放进自己的信任名单；此后代理用它的私钥为任意域名现签的叶证书，客户端都会当成「该域名的合法证书」接受。这正是 HTTPS 明文得以被读取的起点，也是本篇后面所有签发、缓存与自愈逻辑的前提。
:::

![本地 CA 与两段 TLS 的签发位置](/diagrams/tls-mitm.svg)
*根 CA 在启动时就绪，每个 [SNI](/concepts/03-tls) 域名由本地 CA 现签叶证书，客户端与源站各建立一段独立 [TLS](/concepts/03-tls)。*

## 生成时机与算法字段

`lib/https/ca.js:19-33` 在模块加载时就调用 `mkdir` 建好数据目录下的 `certs` 目录，并确定根密钥与[根证书](/concepts/03-tls)文件名（优先使用 `root_new.key` / `root_new.crt`）。真正的初始化在 `ca.js:580` 的 `createRootCA()`：它先加载自定义证书（`:427-431`），再尝试读取已有的根密钥与根证书（`:435-446`），读不到才由 `resetRootCA()`（`:406-416`）新建并 `fs.writeFileSync` 落盘。也就是说根 CA 只在首次启动或校验失败时重建，重启不会换证书。

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

`ca.js:46-49` 定义 `MIN_DATE = 7 天`、`MAX_DATE = 36 天`：根证书走 `ONE_YEAR * 10` 的十年档，叶证书走「提前 7 天生效、36 天后过期」的短档。这样做是为了兼容浏览器对证书最长寿命的限制，同时给时钟偏差留缓冲。叶证书由 `createSelfCert`（`ca.js:206-266`）生成：序列号是 `sha1(hostname + 随机串)`（`:207-212`），复用根公钥与根私钥（`:213-217,263`），扩展里写 [SAN](/concepts/03-tls)（IP 用 type 7、域名用 type 2，`:241-252`）、AKI（`:255-257`）与 `cA: false`（`:227-229`），最后仍以 SHA-256 签名（`:260`）。复用同一把根私钥，省去了为每个域名生成密钥对的开销。根证书还写了 `keyUsage` 的 `keyCertSign`、`extKeyUsage` 的 serverAuth / clientAuth / codeSigning 以及 `nsCertType`（`ca.js:510-541`）；叶证书只开 `digitalSignature` 与 `keyEncipherment`（`:230-239`）。这组差异正是「根只负责签、叶只负责承载流量」的分工，也解释了为什么不能拿叶证书再签下一张证书。

**输入 → 动作 → 输出**：输入是「首次启动、或已有根证书校验失败」这一状态；`createRootCA()` 先加载自定义证书、再尝试读已有根密钥与根证书，读不到才 `resetRootCA()` 新建并落盘；输出是一对十年有效的根密钥 / 根证书，以及随后现签叶证书所需的算法参数（RSA 2048、SHA-256、CN 带时间戳、根十年 / 叶 36 天两档有效期）。

**为什么这样设计**：根证书只在首次启动或校验失败时重建，是为了让「客户端信任过的那张证书」保持稳定——否则每重启一次，用户就得重新下载、重新安装、重新信任一遍。有效期分两档，是把「根要长期稳定」和「叶要短命以兼容浏览器对证书寿命的限制」分开：叶证书短到几十天，即使泄露也很快失效，还顺带给客户端时钟偏差留了「提前 7 天生效」的缓冲。

**代价与边界**：复用同一把根私钥为每个域名签叶证书，省去了逐域名生成密钥对的开销，代价是这把私钥一旦泄露，影响面覆盖本机信任它的所有域名；根私钥又是以 PEM 明文写入数据目录的，保护完全依赖目录权限。十年档只适用于根证书——把它套到叶证书上会直接被现代浏览器拒绝，这正是两档不能互换的边界。

**打个比方**：根 CA 像一枚刻好就锁进抽屉的公章，十年不换；叶证书像用这枚章现盖的通行条，每张只管一个域名、三十六天就作废。换公章要惊动所有已信任它的人，重盖一张通行条却几乎零成本。

**自己验证**：翻回上面 `createCert` 的有效期代码，数一数两档分别写了什么——根是 `ONE_YEAR * 10`、叶是 `now - MIN_DATE` 到 `now + MAX_DATE`（7 天 / 36 天）；再对照下面表格「根证书 | 十年自签」一行，不用跑任何命令就能确认「根长期稳定、叶短命轮换」这条分工，也就能理解为什么重建根是件大事。

**把结论展开**：`cA: true` 与 `keyUsage` 的 `keyCertSign` 只写在根证书上、叶证书是 `cA: false`，意味着整条链里只有这一张根能往下签发；客户端校验时认的是「叶证书由某张被信任的根签过」，所以根不变、叶随便换都不会破坏信任。把这点和「重启不换证书」放在一起看就通了：换叶是日常操作，换根却要惊动所有已信任它的客户端。

**这一段在整篇里的位置**：这里只负责「造出根、定好规格」，证书按什么名字发、发过怎么缓存、旧了怎么换，分别交给下面三段。把「生成」独立成第一段，是因为根证书是后面所有签发的信任锚，必须先稳定下来，缓存与自愈才有意义。

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

`ca.js:609-611` 把它注册给 hagent，并起两个内部 server：42900 承载 h2c 明文（非 TLS）、43900 承载 HTTPS。`SNICallback`（`ca.js:616-624`）拿到 `options` 后用 `createSecureContext` 生成 `_ctx` 并缓存，避免每次握手重复建上下文。`getCacheCert` 把 `customPairs` 放在最前（`:197-203`），意味着用户为某域名提供的证书优先于自签证书；这也是 [`sniCallback://`](/concepts/07-extension) 动态证书要单独存进 `remoteCerts`、并在 `getOrCreateCert` 里最先查询的原因——动态下发必须能覆盖静态自定义证书。

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

**输入 → 动作 → 输出**：输入是一次 TLS 握手带来的 `servername`（可能带 `:` 前缀表示要求证书、带 `.` 后缀走 emudhra 分支）；`getOrCreateCert` 先查动态证书 `remoteCerts`，再用 `getDomain` 把主机名归并成通配域名，按 `customPairs → cachePairs → certsCache` 顺序找现成证书，找不到才 `createSelfCert` 现签并写进 `cachePairs`；输出是一张可交给 `SNICallback` 复用的叶证书与上下文。

**为什么这样设计**：把子域名归并成 `*` 通配再缓存，是因为「每个子域名单独签一张」会让缓存迅速膨胀——同一父域下的大量子域共用一张通配证书即可。四级缓存按「谁优先」刻意分层：用户上传的 `customPairs` 压过自签证书，`sniCallback://` 这类动态下发的证书又存进 `remoteCerts` 被最先查询，保证「后下发、更具体的配置能覆盖静态默认」。`SNICallback` 把 `createSecureContext` 的结果缓存进 `options._ctx`，则是为了避免每次握手都重建安全上下文。

**代价与边界**：归并的边界写在 `getDomain` 里——只有两级域名或命中 CDN 特征时才保留原名，IP 地址完全不归并；这是「缓存命中率」与「证书必须匹配主机名」之间的折中，归并过头会让证书 SAN 对不上、客户端直接报域名不符。`customPairs` 是普通对象、其余三层是 lru-cache，容量分别卡在 5120 / 256 / 1280，超出即按 LRU 淘汰，因此高频新域名场景下会不断触发重签，这是有界缓存换来的必然代价。

**打个比方**：四级缓存像前台的四个抽屉——最上层放「客户自己带来的通行证」（自定义证书），中间放「常用访客的临时证」（签发缓存），再往下是「供下载的副本」与「刚下发的特批」；来人先开最上层的抽屉，找不到才逐层往下，还找不到才现场制作一张。

**自己验证**：拿 `getOrCreateCert` 的代码顺着读一遍——先 `remoteCerts.get(servername)`，再 `getDomain(servername)`，最后 `getCacheCert(servername)`；对照上面表格四个缓存对象的「上限」列，就能自己确认「先查动态、再归并、再按优先级找缓存」这条查找顺序，不需要任何额外工具。

**把结论展开**：`getCacheCert` 的 `customPairs → cachePairs → certsCache` 与 `getOrCreateCert` 里先查 `remoteCerts` 合起来，才构成完整优先级：动态下发 > 用户上传 > 自签缓存 > 下载缓存。少读任何一层，都会出现「刚下发的证书不生效」或「用户上传的证书被自签证书盖过」这类难查的问题；也正因优先级写在查找顺序里而非一张配置表，改动时得连两处一起看。

**和上一段的接口**：`createSelfCert` 复用根私钥，所以缓存里的每张叶证书都自动挂在同一张根证书之下；归并只改变「为哪个名字签」，不改变「由谁签」。这正是四级缓存能安全复用、而 `customPairs` 里用户自带的证书也能被直接采纳的前提。

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

**输入 → 动作 → 输出**：输入是「启动时读到的旧证书」或「运行期推进的时间」；启动时 `checkCertificate()` 读 PEM，逐一核对公钥位数、有效期与 CN 格式，任一不通过就删掉旧 key / crt 让 `createRootCA` 重建；运行期 `createRootCASafe()` 每次取根证书前查过期，必要时重置根并清空签发缓存，每日定时器则在 36 天到期前两天提前触发 `resetAllCerts()`；输出是「始终有一张合规的根证书、且叶证书不会集中过期」的稳态。

**为什么这样设计**：三层自愈按时间粒度分工——启动自检修的是「旧版本或异常退出留下的历史遗留」，运行期检查修的是「用着用着根证书过期了」，每日轮换防的是「大批叶证书撞在同一刻失效导致握手雪崩」。提前两天强制重签，是把一次可能集中的批量失败摊平到日常；`timer.unref()` 让这个每日定时器不阻塞进程退出，是「后台维护不能拖住关闭」的常见取舍。

**代价与边界**：自检的判定是硬编码的（`KEY_SIZE` 位数、`/^whistle\.\d+$/` 的 CN 格式），换一套签发规格就得连校验规则一起改，否则旧证书会被误判为不合规而反复重建。`useNewKey` 的 `root_new.*` 切换保留旧文件作回退，让密钥轮换能分两步完成，代价是目录里会短期并存两套文件名；自定义证书的过期检查另走 `checkExpired()` 每 10 分钟一次、只置 `hasInvalidCerts` 告警而不自动修复，是「用户上传的东西不擅自替换」的边界。

**打个比方**：像大楼的三班巡检——交班时查一遍消防证照是否齐全（启动自检），值班时盯着证件到期日（运行期自愈），每月提前安排换证避免所有证件同一天作废（每日轮换）；三班各管一段时间尺度，谁也替不了谁。

**自己验证**：数一数上面定时器代码里的三个量——`INTERVAL = ONE_DAY`、`MAX_AGE = MAX_DATE - INTERVAL * 2`、`resetAllCerts()`；把 `MAX_DATE = 36 天` 代进去，就能自己算出「触发点落在到期前两天」，正好对上正文说的「提前强制重签」。

**把结论展开**：每日定时器为什么用 `MAX_DATE - INTERVAL * 2` 而不是「到期当天再换」？叶证书是批量现签的，若都等到过期那一刻才重签，短时间内会涌入大量握手请求，客户端还可能同时撞上「旧证刚失效、新证还没好」的窗口。把触发点提前两天、且只 `resetAllCerts()` 清空缓存而非立刻全量重签，重签就被后续请求自然摊开了。

**为什么清的是缓存而不是根**：`resetAllCerts()` 清掉签发缓存，根证书仍在、客户端的信任也还在，因此自愈触发后旧连接能继续握手，只是叶证书会被重签。把「换根」和「重签叶」分成两种动作，是这套机制不打断在线调试的关键；真要换根，只发生在启动自检不通过那种更重的场景。

## 自定义证书与下载安装

`custom_certs/` 目录里的文件按同名成对识别：`.key` 配 `.crt` / `.cer` / `.pem`（`ca.js:347-369`），`parseAllCustomCerts`（`ca.js:287-337`）读取每张证书的 SAN，把 type 2 / 7 的名字写进 `customPairs`（`:305-333`）；名为 `root` 的一对会覆盖根 CA 路径（`:371-377`）。目录位置由 `config.CUSTOM_CERTS_DIR`（`lib/config.js:145`）给出，可用 `--certDir`（`lib/config.js:903-904`）另指，或用 `--mode disableCustomCerts`（`lib/config.js:732-733`）整体关闭。UI 上传走 `ca.js:806` 的 `uploadCerts`，落盘由 `ca.js:764-773` 的 `writeCertFile` 异步双写并回填 mtime，CGI 在 `biz/webui/cgi-bin/certs/*`。加载顺序也有讲究：`createRootCA` 先读 `--certDir` 指定的目录再读默认 `custom_certs`（`ca.js:429-430`）；`parseAllCustomCerts` 按文件 mtime 排序后逐个写入 `customPairs`（`:291-296`），因此同名 SAN 下以较新的文件为准；`loadCustomCerts` 对同名 `.crt` / `.cer` / `.pem` 也只保留 mtime 最新的一份（`:358-366`）。

下载安装是一条独立链路：`biz/webui/cgi-bin/rootca.js:4-13` 在返回文件的同时调用 `properties.setEnableCapture(true)`（`:9-11`），即「下载根证书」顺手打开 HTTPS 抓包；`rootca.pro` 是 `lib/config.js:37` 登记的虚域名，由 `biz/webui/lib/index.js:332-341` 直接识别。`w2 ca` 的平台实现在 `bin/ca/index.js:69-81`：macOS 用 `security add-trusted-cert`（`:21-28`），Windows 用 `certutil`（`:31-37`），Linux 用 `update-ca-certificates` / `update-ca-trust`（`:39-54`）。`cgi-bin/create-cert.js` 还能用 adm-zip 把指定域名的证书与私钥打包成 zip 供手动部署。

[插件](/concepts/07-extension)也可动态下发证书：`sniCallback://` 由 `lib/https/load-cert.js:7-43` 解析，结果写进 `remoteCerts.get/set`（`:13,41`），`getOrCreateCert` 会优先取它（`:589`）。另有 `assets/emudhra.pem` 与 `lib/https/emudhra.js`：注释明确它是 mitmproxy 提交中**公开披露**的密钥与链，用 ECDSA-SHA384 签名（`:26,30`），只用于兼容特定 Android 客户端，绝不能当作可信凭据。

**输入 → 动作 → 输出**：输入是 `custom_certs/` 里同名成对的 `.key` / `.crt` 文件，或一次「下载根证书 / 导出域名证书」的界面请求；`parseAllCustomCerts` 读每张证书的 SAN 把名字写进 `customPairs`，名为 `root` 的一对覆盖根 CA 路径，下载链路则由返回证书文件的 CGI 在响应里顺手 `properties.setEnableCapture(true)`、`w2 ca` 调各平台的信任命令完成安装；输出是「自定义证书进入签发优先级最高层」或「根证书被装进系统信任存储」。

**为什么这样设计**：同名成对识别 + 按 mtime 排序，是为了让「同一 SAN 有多份文件」时有确定结果——较新的覆盖较旧的，不必再引入一份优先级配置。`--certDir` 与 `--mode disableCustomCerts` 把「从哪读、读不读」都交给启动参数，是同一份二进制适配不同部署的惯例。下载根证书时顺手打开 HTTPS 抓包，把「装证书」和「开始解密」这两个必然连在一起的动作合成一次点击，省得用户装完还去别处找开关。

**代价与边界**：加载顺序上 `customPairs` 优先于自签证书，因此一张放错的自签证书会让该域名一直用到它、排查时容易误以为是签发逻辑坏了；同名文件只保留 mtime 最新的一份，意味着「改了旧文件却没更新 mtime」可能不生效。`w2 ca` 依赖 macOS 的 `security add-trusted-cert`、Windows 的 `certutil`、Linux 的 `update-ca-certificates` 等系统工具，换平台就得换实现；`assets/emudhra.pem` 是公开披露的密钥，只用于兼容特定 Android 客户端，边界写得很明确——绝不能当可信凭据。

**打个比方**：`custom_certs/` 像前台的「指定通道」名单，凡在名单里的域名一律走客户自带的证件，不再用前台现做的临时证；`w2 ca` 则像把前台的公章拿到物业备案一次，之后整栋楼都认它。

**自己验证**：顺着 `createRootCA` 的加载顺序读——先读 `--certDir` 指定目录、再读默认 `custom_certs`，又看 `loadCustomCerts` 对同名 `.crt` / `.cer` / `.pem` 只保留 mtime 最新的一份；不用执行任何命令，就能确认「同名以较新为准、自定义优先」这两条规则。

**把结论展开**：为什么「同名 SAN 以 mtime 较新为准」值得写进加载逻辑？自定义证书常由脚本覆盖写入，用户能控制的往往只有「重新上传」这一个动作，未必会显式删旧文件；用 mtime 当唯一裁决，就不必再引入一份「哪张生效」的清单。`createRootCA` 先读 `--certDir` 再读默认目录，也是同一思路——显式指定天然压过默认，顺序即优先级。

**两处要对着读**：`customPairs` 在这里被写入，却在上一节的 `getCacheCert` 里被最先读取——本节负责「装进优先级最高层」，上一节负责「按这个优先级取用」。只改其中一处，就会奇怪「自定义证书到底在哪生效」，这也是本篇把生成、签发、分发拆成几段却要反复互相回指的原因。

## 安全边界

根私钥以 PEM 明文写入数据目录（`ca.js:410-411` 的 `fs.writeFileSync` 未显式指定模式），保护完全依赖该目录的访问控制；一旦泄露，持有者就能为任意域名签发被本机信任的证书。安装根 CA 意味着该系统上所有应用的 TLS 都可能被解密，范围远不止浏览器调试页，共用开发机上用完应及时取消信任。

一个容易被忽略的隔离是「下载的证书」与「[MITM](/concepts/03-tls) 实际签发的证书」分属不同桶：`createCertificate`（`ca.js:268-276`）只从 `cachePairs` 读、回退写 `certsCache`，源码注释写得很直白——「确保使用自己生成的证书，防止把用户证书下载出去」（`:270`）；用户上传的证书只进 `customPairs`，不会出现在下载接口里。

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

这里要分清两段 TLS 是**互相独立的信任边界**。入站这一段（客户端 ↔ Whistle）能否解密，取决于客户端是否信任本地根 CA：`getOrCreateCert`（`ca.js:582-607`）产出的叶证书由 `createSelfCert`（`ca.js:205-266`）复用 `ROOT_KEY` 并以 SHA-256 签发（`:213-217,260`），只要根 CA 被信任，客户端就认为对面是目标站点，与源站真实证书无关。出站这一段（Whistle ↔ 源站）是否校验对方证书，才由 `rejectUnauthorized` 控制。所以 `--mode safe` 打开出站校验，并不会让入站伪造「更可信」；反过来默认关闭出站校验，也不影响客户端对本地 CA 的信任。两者各自承担不同的风险面，不能互相替代或抵消——排查证书告警时若只盯 `rejectUnauthorized`，就会找错方向。

**输入 → 动作 → 输出**：输入是「一次下载 / 导出证书的请求」与「一次出站连接」；`createCertificate` 只从 `cachePairs` 读、回退写 `certsCache`，绝不碰 `customPairs`，输出的是代理自己生成的证书；出站是否校验源站证书则由 `rejectUnauthorized` 决定，默认 `false`、只有 `--mode safe` 打开；两段 TLS 各自独立地决定「入站能不能解密」与「出站要不要验对方」。

**为什么这样设计**：把「下载的证书」和「MITM 实际签发的证书」分桶，是一条防泄漏设计——用户上传的私钥只进 `customPairs`，下载接口若顺手调 `getCacheCert` 就会把它一起送出去。源码那句「确保使用自己生成的证书，防止把用户证书下载出去」把动机写死了，所以 `createCertificate` 绝不能被「顺手」改成走通用查找。两段 TLS 分开控制，是因为它们防的是不同风险：入站靠客户端是否信任本地根 CA，出站靠是否校验源站证书，谁也替不了谁。

**代价与边界**：默认 `rejectUnauthorized = false` 换取「自签名环境也能连」，代价是中间人风险被转移到代理到源站这一段；反过来 `--mode safe` 打开出站校验，也不会让入站伪造「更可信」。根私钥明文落盘、安装根 CA 后本机所有应用的 TLS 都可能被解密，是这套便利最重的两块代价——排查证书告警时若只盯 `rejectUnauthorized`，方向就错了。

**打个比方**：入站像「访客是否认得前台这枚公章」，出站像「前台要不要核验对面公司寄来的回执」；前者由客户端的信任存储决定，后者由 `rejectUnauthorized` 决定，改后者的开关不会让前者的公章变得更真。

**自己验证**：对照 `createCertificate` 那段代码，看它取的是 `cachePairs.get(hostname)` 还是 `getCacheCert(servername)`——答案是前者，且回退写 `certsCache`；再回看表格里「自定义证书 | custom_certs/」一行，就能自己确认「用户私钥不会出现在下载接口」这条隔离。

**把结论展开**：为什么「下载接口不能调 `getCacheCert`」值得单独写一句注释？`getCacheCert` 的第一层就是 `customPairs`，里面存的正是用户上传的 key + crt 成对内容；下载接口一旦改走它，返回的证书里就带着用户私钥，等于把不该外泄的东西通过浏览器下载了出去。`createCertificate` 只认 `cachePairs` 这一只桶，是用「限定数据来源」而不是「事后过滤字段」来堵这条路——后者漏掉一个字段就前功尽弃。

**排查时的顺序**：`rejectUnauthorized` 管的是「代理到源站」这一段，与入站能否解密毫无耦合。所以界面上报证书告警时，先问「客户端信不信本地根 CA」，再问「出站有没有开 `--mode safe`」；顺序反了，就会在错误的链路上找半天，这也是本篇反复强调「两段 TLS 互相独立」的实用价值。

## 常见误解

1. **容易以为每次启动都会换一张根证书，其实根 CA 只在首次启动或校验失败时重建**：`createRootCA()` 先读已有根密钥与根证书，读不到才 `resetRootCA()`；正因如此，客户端一次信任之后不必反复下载安装，对照见 [《易混淆概念辨析》](/concepts/08-confusions)。
2. **容易以为叶证书和根证书一样是十年有效，其实叶证书只有 36 天且提前 7 天生效**：两档有效期是为兼容浏览器对证书寿命的限制并给时钟偏差留缓冲，根走 `ONE_YEAR * 10`、叶走 `MIN_DATE` / `MAX_DATE` 短档，不能互换。
3. **容易以为 `--mode safe` 能让「伪造站点证书」变得更可信，其实它只打开出站校验**：入站能否解密取决于客户端是否信任本地根 CA，出站是否校验源站证书才由 `rejectUnauthorized` 控制，两段 TLS 是互相独立的信任边界。
4. **容易以为「下载根证书」和「MITM 签发用的证书」是同一批，其实它们分属不同桶**：`createCertificate` 只从 `cachePairs` 读、回退写 `certsCache`，用户上传的证书只进 `customPairs`，下载接口刻意碰不到它，否则会把用户私钥一起送出去。

## 小结

- 根 CA 在模块加载与 `createRootCA()`（`:580`）时就绪，RSA 2048、CN 带时间戳、SHA-256 自签、十年有效。
- 叶证书 36 天且提前 7 天生效，复用根私钥，SAN / AKI / `cA:false` 由 `createSelfCert` 写入。
- `getDomain` 归并通配域名，`customPairs` / `cachePairs` / `certsCache` / `remoteCerts` 四级缓存配合 `SNICallback` 复用上下文。
- 启动自检、运行期自愈、每日轮换与每 10 分钟过期检查构成三层防护。
- 下载接口与签发缓存刻意分离，根私钥明文落盘、默认不校验源站证书，是必须知晓的安全边界。
- 本篇为 [《插件系统》](/modules/plugins) 准备了「证书也能被外部能力动态下发」这个入口：`sniCallback://` 写进 `remoteCerts`、优先于静态自定义证书被查询，16 才能接着回答「这段代码跑在哪里、又怎么被隔离而不拖垮代理」。

## 下一步

[《插件系统》](/modules/plugins)：看第三方代码如何通过 pfork 子进程、hook 头与内部端口接入上述所有链路。 紧接着读它，是因为本篇结尾停在「证书可由 `sniCallback://` 动态下发」这个未展开的口子上——是谁在下发、这段代码跑在哪里、又怎么被隔离而不拖垮代理，16 才回答。
