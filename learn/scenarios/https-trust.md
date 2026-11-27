---
title: HTTPS、证书与鉴权的排障现场
description: 从根证书安装到解密判定、双向认证与跨域鉴权，串起 HTTPS 排障的规则、设计取舍与源码路径。
---

# HTTPS、证书与鉴权的排障现场

接口联调时最常见的停顿不是代码写错，而是[抓包](/concepts/05-capture)列表里只有 Tunnel to，或者浏览器反复提示证书不受信任。本篇按「装证书 → 开解密 → 处理证书固定与双向认证 → 补鉴权与跨域头」的现场顺序，把官方 FAQ、CLI 与界面说明中的操作固化为可复制配置，再向下追到解密判定与证书签发的源码。读完你能判断某条 HTTPS 为什么没被解密，也知道解密之后哪些规则才真正作用在明文上。[《弱网与异常注入：把偶发变成必现》](/scenarios/fault-injection)（22）把超时、错误码与限流都注入成了确定性规则，但那些规则默认作用在「看得见」的请求上；本篇承接这个未解问题，先回答「流量走 HTTPS 隧道时规则究竟有没有落到明文」，前面这套排障顺序也正是为 22 补上可验证的前提。

::: tip 先修知识
本篇承接 [《弱网与异常注入：把偶发变成必现》](/scenarios/fault-injection)（22）、[《HTTPS、证书链与中间人》](/domain/tls-mitm)（03）与 [《证书体系的实现细节》](/modules/certificates)（15），本篇会讲清（不需要预先掌握）：CONNECT 隧道默认只做字节转发、两段 TLS 各自独立、客户端信任本地根 CA 之后代理才能为任意域名现签叶证书、以及注入规则必须作用在解密后的明文上才有意义。22 解决的是「失败怎么稳定复现」，03 与 15 已经把「信任从哪来、证书怎么签」铺好；本篇把这两条线合到一次排障现场，回答「为什么明明开了抓包，列表里仍只有 Tunnel to」。

若某个名词卡住，按主题回查 [概念精解总览](/concepts/index) 与 [《全量术语索引》](/concepts/glossary)；正文在术语首次出现处也给了对应链接。
:::

## 场景与痛点

新机器首次接入。[根证书](/concepts/03-tls)装了、Enable HTTPS 也开了，列表却仍显示加密隧道。常见原因有三类：Firefox 不读系统证书库、iOS 装完描述文件没有开启完全信任、以及直接用 IP 访问时客户端不发 [SNI](/concepts/03-tls)。三者的处理方式完全不同，逐一试错会浪费大量时间。

特定 App 抓不到包。App 做了证书固定或要求双向认证，代理替换证书后握手直接失败，界面上表现为 captureError。此时继续强开解密只会让设备断网，正确做法是对该域名跳过解密，或改用兼容方案。

解密后的接口联调。明文可见之后，还要给请求补 Basic 凭证、给响应放开跨域并允许携带 cookie、给上游加自定义头。这些规则都作用在解密之后的 HTTP 层，把它们与证书问题分开排查，才能定位到真正的失败点。把证书问题、握手问题与 HTTP 层改写分开记录，也便于多人协作时快速交接。

::: cols 20|30|50
| 现象 | 优先检查 | 对应规则 |
|---|---|---|
| 只显示 Tunnel to | 根证书信任 | enable://https |
| IP 直连不解密 | 缺少 SNI | enable://captureIp |
| captureError | 证书固定 | disable://capture |
:::

三条现场的「输入 → 动作 → 输出」是同构的：输入都是「HTTPS 相关、但根因不同的停顿」（列表只有 Tunnel to、特定 App 抓不到包、明文可见后接口仍不通）；动作统一为按「信任根 → 解密开关 → 证书固定 / 双向认证 → HTTP 层改写」分层定位，而不是逐条试错；输出是「确定这条连接到底停在哪一层」以及对应的一类规则。三者只在「卡在哪一层」上分叉。

为什么这样设计：三类现象表面都像「抓包没生效」，根因却分处信任存储、握手与 HTTP 层；不先分层就把三类处理混着试，会在「装了证书仍不解密」和「解密了但鉴权头没补」之间来回打转。本篇把证书问题、握手问题与 HTTP 层改写分开记录，也是为了让多人协作时能一句话交接「卡在哪一层」，而不是把三种现象搅成一团。

代价与边界：这套顺序有严格前提——信任根没装好之前，任何解密规则都不会生效；反过来，抓不到某条流量也未必是证书问题，可能是命中了系统域名黑名单、或 IP 直连根本没带 SNI。分层能缩小范围，但不能替代逐条核对判定链；把「分层」当成「跳过核对」的借口，反而会在最基础的一环上翻车。

类比：像排查一盏灯不亮，先问「总闸有没有合」（根证书）、再问「这路灯是不是被特意关了」（解密开关与黑名单）、最后才查「灯泡和接线」（HTTP 层改写）；顺序反了就会在灯泡上白忙，而问题其实在总闸。

最小自验：对照表格「只显示 Tunnel to → 根证书信任 → enable://https」这一行，先在心里问「这台机器 / 这个浏览器读不读系统证书库」，就能自己解释 Firefox 与 iOS 两类「装了却仍不解密」；不用真的换设备试，表格里三行现象已把分层写清。再看「IP 直连不解密 → 缺少 SNI → enable://captureIp」那行，就能自验「同一现象、不同根因、不同规则」这条分层思路。

三条痛点与后文四段配置也对得上：新机器首次接入对应 `w2 ca` 与根证书下载那一段，特定 App 抓不到包对应 `disable://capture` 与 mTLS 那一段，解密后的接口联调对应 auth / resCors / reqHeaders 那一段，Firefox 单独放行又是信任存储的延伸。先看痛点，就知道四段不是四种并列语法，而是四层各管一段；表格的「优先检查」一列，正是后文「默认透传、显式才解密」那条原则的提前预告。

按角色看也清楚：新机器接入要的是「一次把信任根建对」，特定 App 要的是「换证书会不会把它弄断网」，联调要的是「明文可见之后头改对了没有」。三者能同时满足，是因为它们分别压在信任存储、握手、HTTP 层三个不同层面；表格按「优先检查」而非按规则名分列，也是为了先把层面摆正。

反过来想，若不做「先分层」这一步，三类现象都会被归成「证书没装好」，于是反复重装根证书、反复强开解密，而 iOS 的「完全信任」或 App 的证书固定根本不在这条路径上；本篇把证书问题、握手问题与 HTTP 层改写分开记录写进痛点，正是为了避免这种在一个层面上反复打转的排查。

## 可复制的配置


> **动手前**：这一节混合了命令行（`w2 ca`、`sudo`）、**Rules** 里的 `enable://https` / `disable://capture`、以及浏览器证书设置，不都在 Rules 面板。零基础请先完成 [第 0 站](/guide/quickstart) 第 4 步，那里把下载根证书、设为信任、勾 Enable HTTPS 的顺序与成功标志都列全了；下面代码块里的域名与 IP 都是示例，请换成你自己要调试的目标。下面示例里的域名、IP、路径与 `{key}` 都是占位，请替换成你自己的目标；引用 `{key}` 之前，先在 Values 里 Create 好同名条目。

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
192.168.1.10:8443 enable://captureIp
# 来源：docs/docs/rules/disable.md（官方示例 wwww 系笔误，本站用 www）
www.test.com/path disable://capture
```

证书固定与双向认证是解密的反面：要么跳过，要么提供客户端证书。

```txt
# 来源：docs/docs/faq.md（SSL Pinning 时跳过解密）
pin.example.com disable://capture
pin.example.com disable://capture includeFilter://reqH.user-agent=/xiaomi/i
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

把命令与规则收拢成「输入 → 动作 → 输出」：输入是 `w2 ca` / `w2 start --mode safe` 一类命令，或 `enable://https`、`disable://capture`、`tlsOptions://` 一类规则；动作是按排障顺序先建立信任根、再显式开解密、对证书固定与 mTLS 跳过或提供客户端证书、最后在明文阶段补 Basic 凭证与跨域头；输出是「能看见明文」的连接，以及作用在明文上的鉴权与跨域改写。前一步没生效就不要急着做后一步，是这套配置唯一的硬约束。

为什么这样设计：顺序之所以严格，是因为后一步都以前一步为前提——根证书没进信任库，`enable://https` 打开也只会让客户端告警；隧道没拆开，`auth://` 与 `resCors://` 根本没机会碰到请求。把 `w2 start --mode safe` 单独列为「另一件事」，也是在提醒出站校验与入站信任互不牵连：它改的是代理到源站那一段是否校验证书，与客户端信不信任本地根 CA 没有传递关系。

把「解密必须显式开启」这句展开：官方 enable.md 的示例误写成 enale://https、本站一律用正确写法 enable，这处笔误本身就说明「开解密」是一个需要明确写对的开关，而不是系统默认行为。默认透传、显式才解密，让不该碰的系统流量保持原样；代价是多一道人工步骤——新机器上哪怕证书装好了，不写 `enable://https` 也依旧只看到 Tunnel to，排查时最容易在这一步误判成「证书没装好」。

代价与边界：`disable://capture` 一类跳过规则会让该域名彻底看不到明文，是「宁可看不到也不让设备断网」的取舍；`enable://emudhra` 用的是已公开泄露的密钥，只是兼容特定 Android 客户端的兜底，不能推广到普通 HTTPS 流量。明文阶段的改写也有边界：Basic 只支持一种凭证、`resCors://*` 不支持带 cookie（详见「边界与坑」），把「能看见明文」当成「所有规则都能生效」就会踩空。

类比：像进一栋楼要依次过三道门——先在前台备案身份（装根证书）、再刷开要去的楼层（开解密）、最后才在房间里办事（改头与跨域）；前两道没过，第三道的手续根本递不进去，硬闯只会触发告警。

最小自验：把 `www.example.com enable://https` 与 `192.168.1.10:8443 enable://captureIp` 两行对照——前者给正常带域名的站点开解密，后者专门补「IP 直连客户端不发 SNI」这一种拿不到域名的情形；两条现成规则就能自验「开解密」并不是一个开关管所有流量。再把 `w2 ca` 与 `sudo update-ca-certificates` 放一起看，理解「下载证书」和「让系统信任它」是两步，Linux 上后一步得手动做。

反过来想，若把「装证书」和「开解密」合成一步会怎样：证书刚下载、还没进系统信任库时客户端就会先撞上告警，代理也会被误判成「解密配置写错了」。拆成 `w2 ca` → `enable://https` 两步，才让每一步的失败各有一个明确归属——装完仍不解密，问题在开关或判定；没装就告警，问题在信任根。这条顺序不是操作习惯，而是排障时的归因依据。

把「每条规则都可以叠加 includeFilter 把范围收窄到单台设备或单个域名」这句展开：解密、跳过、鉴权本身不挑设备，真正决定「这次排障影响谁」的是过滤器；所以同一批规则既能只在自己这台开发机上验证、又不误伤同事的流量，靠的是把作用范围与作用动作拆成两层。若把范围写死在域名里，证书固定与 mTLS 的例外就得复制一整批规则，改一处很容易漏掉另一处。

## 背后的设计思想

[默认透传、显式才解密](/core/connect-mitm)：隧道默认只做字节转发，只有根证书已信任且 enable://https、Enable HTTPS 或自定义证书命中时才拆开。判定被写成层层收窄的条件，每多开一个解密入口都要有明确理由，避免把不该碰的系统流量也纳入中间人范围。

[信任范围最小化](/modules/certificates)：根证书下载接口只读取自签缓存文件并交给下载响应，用户自定义证书放在独立目录与独立数据结构里，界面不参与根证书私钥的写入。可下载的只有公钥证书，私钥始终留在进程内，把信任材料的暴露面压到最小。

[协议差异消化在入口层](/architecture/overview)：[CONNECT](/concepts/01-proxy)、WebSocket 与普通 HTTP 在 tunnel.js 被归一成统一的伪 URL 与规则上下文，首包嗅探与 SNI 提取都在 https/index.js 的入口完成。上层 inspector 只面对明文 HTTP，才不用为每种入口形态重复实现鉴权与跨域逻辑。

[两段 TLS 信任边界互不混淆](/domain/tls-mitm)：客户端到代理这一段信任 Whistle 根证书，代理到源站是另一段独立连接。出站默认值在 `lib/config.js:65` 写死 `config.rejectUnauthorized = false`，只有 `--mode safe` / `rejectUnauthorized` 在 `lib/config.js:809-810` 把它改成 true，即开启严格的源站证书校验、会拒绝自签名证书；默认 false 才是兼容内网自签名证书的状态；入站能否被信任取决于客户端是否安装并完全信任本地根 [CA](/concepts/03-tls)（iOS 还要开「完全信任」，`docs/docs/faq.md:92-94`），与出站校验开关互不牵连。

四条原则拼起来正好是一条链：默认透传、显式才解密解释「为什么大多数 CONNECT 仍是 Tunnel to」，信任范围最小化解释「为什么可下载的只有公钥证书」，协议差异消化在入口层解释「为什么明文规则不必为每种入口重写一套」，两段 TLS 信任边界互不混淆解释「为什么装根证书不会让出站校验变严」。少任何一条，前面那些可复制的配置就退回到「照着抄」。

输入 → 动作 → 输出：输入一条 CONNECT 隧道与客户端的信任状态 → isIntercept() 层层收窄判定是否拆开、入口层把 CONNECT / 明文 HTTP / h2c 归一成统一上下文、本地 CA 按 [SAN](/concepts/03-tls) 现签叶证书 → 输出两段独立 TLS 之间的明文 HTTP，上层 inspector 只需面对一种请求形态。

为什么这样设计：默认透传、显式才解密，是因为 [MITM](/concepts/03-tls) 每拆一条隧道就多一次握手、多一份失败面，还可能撞上证书固定；把判定写成层层收窄的条件，才能让「不该碰的系统流量」保持透传——宁可看不到，也不让设备断网。协议差异消化在入口层，则让 auth、reqHeaders、resCors 这些明文规则不必为 CONNECT、WebSocket、普通 HTTP 各写一套；若每种入口各自实现一遍，一处鉴权逻辑改动就得同步三份。

代价与边界：信任范围最小化把私钥始终留在进程内、可下载的只有公钥证书，代价是自定义根证书不支持界面上传、要放进证书目录并重启；两段 TLS 独立也意味着「装好根证书」并不会顺带让出站校验变严，排查证书告警时若只盯 `rejectUnauthorized` 就会找错方向。分层越清楚，越要记住每层各自的开关：入站看信任库与解密开关，出站看 `--mode safe`，两者不互相传递。

类比：像海关只在持特定通行证的旅客那一道开箱（显式解密），其余原箱放行（透传）；开箱后的检查流程（明文规则）对所有旅客通用，不必为「坐船来的、坐车来的」各设一套，而「查验对面公司回执」是另一条独立通道，跟旅客手里的通行证无关。

最小自验：把「两段 TLS 信任边界互不混淆」那条与配置里的 `w2 start --mode safe` 对照——一个管出站是否校验源站证书、一个管入站是否信任本地根 CA；用这两处现成内容就能自验「装根证书不会让出站校验变严」，不必真去切换启动参数。再对照「只显示 Tunnel to → 根证书信任 → enable://https」那行表格，就能自己说出「默认透传」为什么是这一节的第一条原则。

把四条原则按「判定 / 材料 / 形态 / 边界」归位会更清楚：默认透传管「拆不拆」，信任范围最小化管「私钥放哪」，协议差异消化管「明文长什么样」，两段 TLS 互不混淆管「两侧开关各管谁」。四者不重叠，所以开一道解密规则不必动证书目录，改出站校验也不必重签叶证书。

再把「默认透传」往反面推一步：若把解密改成「默认全拆」，黑名单、策略头与显式开关就都失去了意义，系统域名与证书固定流量会整片握手失败，设备直接断网；正因为默认是不拆，每多开一个解密入口才都要有明确理由（enable://https、Enable HTTPS 或自定义证书命中），判定链才写成层层收窄的条件。便利与安全在这里是同一枚硬币：少一分收窄，就多一分误伤面。

把「协议差异消化在入口层」也推一步：CONNECT、WebSocket 与普通 HTTP 若在各自入口里分别实现一遍 auth 与 resCors，一处跨域逻辑变更就得同步三份，还容易出现「HTTPS 能改、WebSocket 不能改」的错位；归一成统一伪 URL 与规则上下文之后，上层 inspector 只面对明文 HTTP，改写能力对三种入口才一致。代价是入口层要承担首包嗅探与 SNI 提取这些额外工作，这份复杂度被集中在一处，而不是摊给每个 inspector。

## 源码链路

1. **入口 · CONNECT 登记**：`lib/tunnel.js:38-44` 注册 connect 事件，`lib/tunnel.js:26-27` 定义黑名单正则，`lib/tunnel.js:144-148` 读取策略头，为判定准备上下文。参见[CONNECT 判定与 TLS 解密](/core/connect-mitm)。
2. **规则解析 · 解密判定**：`lib/tunnel.js:168-213` 的 isIntercept() 汇总开关、黑名单、自定义证书与策略头，决定是否拆开隧道。参见[CONNECT 判定与 TLS 解密](/core/connect-mitm)。
3. **应用点 · 先回 200 再嗅探**：`lib/tunnel.js:264-282` 先 `dispatch` 读首包，再由 `util.setEstablished(reqSocket)`（`:281`）回写固定的 `HTTP/1.1 200 Connection Established`（常量 `ESTABLISHED_CTN` 见 `lib/util/index.js:369-375`）；`lib/https/index.js:1184-1234` 借 `readOneChunk`（`lib/util/index.js:3618-3635`）拿到首包后依次判断 CONNECT、明文 HTTP，最后在 `:1232` 用反向条件 `if (!isHttpH2 && chunk[0] != 22) return next(chunk)` 回退——即只有 TLS 握手记录（首字节 0x16 = 22）或 h2c preface 才继续解密，源码里并没有 `chunk[0] === 22` 的正面分支；`lib/https/index.js:1295-1338` 再 `checkSNI(chunk)` 提取域名，无 SNI 时回退到 `tunnelHostname`。参见[隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。
4. **应用点 · 证书签发**：`lib/https/ca.js:582-607` 的 `getOrCreateCert` 先查 `remoteCerts` / `cachePairs`，未命中才 `createSelfCert` 签发；叶证书有效期按 `lib/https/ca.js:48-49,558-573` 的 `MIN_DATE` / `MAX_DATE` 定为「提前 7 天生效、36 天后过期」。`lib/https/ca.js:616-624` 的 `SNICallback` 再用 `createSecureContext` 把它挂到 TLS 服务端。参见[证书体系](/modules/certificates)。
5. **回写 · 根证书与出站策略**：`biz/webui/cgi-bin/rootca.js:4-12` 只提供证书下载；`lib/config.js:65` 默认 rejectUnauthorized 为 false，`lib/config.js:809-810` 在 --mode safe 时置为 true。参见[Web 管理界面](/modules/webui)与[进程模型与配置系统](/architecture/process-config)。
6. **回写 · 明文阶段改写**：`lib/inspectors/req.js:150-152` 与 `lib/inspectors/req.js:465-467` 应用 auth 与 reqHeaders，`lib/inspectors/res.js:833`、`lib/inspectors/res.js:868` 应用 resCors。参见[指令体系与分发链路](/modules/protocol-catalog)。

把 1–6 收拢成「输入 → 动作 → 输出」：输入一次 CONNECT 与它的策略头 → 入口登记、isIntercept() 汇总开关与黑名单判定是否拆 → 先回 200 再读首包嗅探、按首字节与 SNI 分流 → 本地 CA 现签叶证书、挂到 TLS 服务端 → 明文请求回流到 inspector，应用 auth / reqHeaders / resCors → 输出「可抓到明文、可改写」的一条 HTTPS 请求。六步不是六个并列模块，而是同一条隧道从进来到变成明文请求的六个工位。

为什么这样设计：第 3 步「先回 200 再嗅探」是 CONNECT 语义决定的——客户端要等代理回 `HTTP/1.1 200 Connection Established` 才把后续字节当隧道内容发进来，代理也才能读到第一个数据包去判断里面是 TLS 握手、明文 HTTP 还是 h2c；用「非 22 且非 h2c preface 就回退」的反向条件，只让真正像握手的流量继续解密，其余一律当普通字节放走，避免误拆不该碰的连接。第 4 步按 SNI 现签叶证书，则让同一 IP 上的多个站点各自拿到对得上域名的证书。

代价与边界：首包必须被缓冲一小段才能判定，判定又依赖首字节这种约定而非强校验；无 SNI 时只能回退到 `tunnelHostname`，这也是 IP 直连默认不解密、要靠 `enable://captureIp` 单独补的原因。叶证书「提前 7 天生效、36 天后过期」与根证书约十年分两档，安装根证书时看到的过期时间与浏览器校验的叶证书不是同一张，别混写；第 6 步的明文改写也只对拆开后的请求生效，隧道没拆就谈不上命中。

类比：像快递站先给寄件人回一句「通道已建好」，再拆开第一层包装看里面是文件还是包裹，据此决定走安检线还是普通线；标签（SNI）上写着收件城市，才现做一张对应门牌的临时通行证，标签缺失就只能按默认地址处理。

最小自验：把第 3 步「首字节 0x16 = 22 才继续解密」与配置里的 `192.168.1.10:8443 enable://captureIp` 对照——前者解释了「握手能被认出来」，后者解释了「连域名都拿不到时怎么办」；两处都用本篇已有内容即可自验，不必去抓真实首包。再把第 4 步「本地 CA 现签叶证书」与第 6 步「明文阶段改写 auth / resCors」对照，就能理解为什么鉴权与跨域规则要排在证书问题之后排查。

按 1→6 排查「某条 HTTPS 没被解密」可以这样问：策略头有没有要求纯透传（第 1 步）→ isIntercept() 有没有因全局开关或系统域名黑名单放行（第 2 步）→ 首包是不是握手记录、SNI 有没有取到域名（第 3 步）→ 本地根 CA 是否就绪、叶证书有没有签出来（第 4 步）→ 根证书下载 / 出站策略有没有配错（第 5 步）→ 明文阶段的改写是不是被误当成「没解密」（第 6 步）。逐段问下来，比反复重装证书有效得多。

六步与七段模板里「源码链路」一节是同一条链的两种粒度：模板给的是「入口 → 规则解析 → 应用点 → 回写/上报」的粗线，本篇细到 CONNECT 登记、解密判定、首包嗅探、证书签发、根证书与出站策略、明文改写六个工位。其中第 3 步最容易被跳过——「先回 200 再嗅探」和「非 22 且非 h2c preface 就回退」共同决定了一条隧道到底会不会被拆开；读的时候要特意停一下，别把它当成普通的「转发一个连接」扫过去。

按层次归位也更清楚：第 1–2 步管「这条隧道拆不拆」，第 3–4 步管「拆开之后怎么认出协议、怎么签证书」，第 5 步管「信任材料与出站策略怎么给」，第 6 步管「明文到手后改什么」。四层互不重叠，所以排查「Tunnel to」只需看前两层，排查「明文里鉴权没生效」只需看第 6 步；把两层混着查，就会在证书目录里找一个其实写在 reqHeaders 上的问题。

六步与「可复制的配置」那四段也是一一对应的：`w2 ca` 对应第 5 步的信任材料，`enable://https` 对应第 1–2 步的解密判定，`disable://capture` 对应黑名单与跳过那层，auth / resCors / reqHeaders 对应第 6 步的明文改写。读的时候把两张表叠起来看，就能明白「可复制的配置」并不是四段孤立语法，而是同一条判定链上四个不同工位的外部开关。

## 边界与坑

- 证书固定或 mTLS 客户端换证书会握手失败，官方建议对该pin.example.com disable://capture，或按客户端 UA 只跳过特定设备（`docs/docs/faq.md`）；Android 可试 enable://emudhra（同文档）。
- 系统域名与 Cronet UA 命中硬编码黑名单后一律跳过解密，宁可看不到也不让设备断网（`lib/tunnel.js:26-27`、`lib/tunnel.js:199-200`）。
- 证书有效期分两套：动态签发的叶证书 `notBefore = now - 7 天`、`notAfter = now + 36 天`（`lib/https/ca.js:48-49,558-573` 的 `MIN_DATE` / `MAX_DATE`），是为避开 Apple / Chromium 对长期证书的限制；根证书走另一分支（`:569-570`）为 `now - 1 年` 到 `now + 10 年`，有效期约十年。安装根证书时看到的过期时间与浏览器校验的叶证书不是同一张，不要混写。
- `enable://emudhra` 不是安全实践：`lib/https/emudhra.js:6-8` 注释明确所用的是 mitmproxy 公开披露的 eMudhra 中间 CA 私钥与证书链（`assets/emudhra.pem`），`docs/docs/rules/enable.md:26`、`docs/docs/faq.md:98` 也写明是「已公开泄露」的密钥。它只是为兼容特定 Android 客户端证书固定而签发动态证书的兜底方案，既不是可信根证书，也不应推广到普通 HTTPS 流量。
- 出站 rejectUnauthorized 默认 false 仅限开发环境（`docs/docs/rules/cipher.md`），生产应加 --mode safe 开启校验（`lib/config.js:65`、`lib/config.js:809-810`）。
- auth 只支持 Basic，Bearer 与 OAuth 需用 reqHeaders 自行设置（`docs/docs/rules/auth.md`）；resCors://* 不支持带 cookie，启用凭证时不得用 *，应改用 resCors://enable（`docs/docs/rules/resCors.md`）。
- 自定义根证书不支持界面上传，需放入证书目录并重启（`docs/docs/gui/https.md:14`）；官方 `docs/docs/rules/enable.md:82` 示例的 `enale://https` 是笔误（应为 `enable://https`），`docs/docs/rules/disable.md` 示例里的 `wwww.*` 域名同样是照抄笔误，本站可复制配置一律用正确写法。

- **容易以为「根证书装好 + Enable HTTPS 打开」= 所有 HTTPS 都会变明文，其实解密是例外而非常态**：策略头要求纯透传、系统域名黑名单、以及缺 SNI 的 IP 直连都会继续走隧道，表格里三行现象对应的正是三类不同根因。
- **容易以为抓包列表里出现 Tunnel to 是抓包失败，其实那表示该连接被判定为纯透传、代理没拆隧道**：要先回头查信任根与解密开关，而不是继续重装证书或强开解密。
- **容易以为 `auth://` 能带 Bearer / OAuth，其实它只支持 Basic**：其余凭证要用 `reqHeaders` 自己设置；`resCors://*` 也不支持带 cookie，启用凭证时应改用 `resCors://enable`。
- **容易以为 `--mode safe` 能让客户端更信任代理签发的证书，其实它只打开出站对源站的校验**：入站信任取决于本地根 CA 是否装进信任库，两段 TLS 互不牵连；更细的对照可见 [《概念精解 · 易混淆概念辨析》](/concepts/08-confusions)。

把这一节七条既有坑与上面四条辨析分开看，会更清楚该记什么：七条坑是官方或源码划定的事实边界（证书固定 / mTLS 跳过、系统域名黑名单、叶证书与根证书两档有效期、emudhra 不可信、出站默认不校验、auth 与 resCors 的写法、自定义根证书与官方笔误），照着改就能绕过；四条辨析是读者心里默认错的模型（装好就全解密、Tunnel to 是抓包失败、auth 通吃凭证、--mode safe 让入站更可信）。前者是「怎么写才对」，后者是「这条链究竟怎么走」，后者只能靠把源码链路走通来纠正，光看配置文本改不出来。

## 小结

- 先确认根证书信任，再开解密，最后处理鉴权与跨域，顺序颠倒会得出错误结论。
- 解密是例外而非常态，判定链上的每一层收窄都对应一类真实故障。
- 两段 TLS 各自独立，客户端信任根证书与出站是否校验源站证书是两件事。
- 证书固定流量应主动跳过，而不是继续尝试替换证书。
- 排障时先区分「没有解密」与「解密后规则未命中」，两者对应的源码路径完全不同。
- 本篇为 [《真机、移动端与远程页面调试》](/scenarios/mobile-remote) 准备了「证书信任与解密判定」这套可搬用的流程：既然一套操作就能把某台机器上的 HTTPS 拆成明文，24 就顺势回答「手机与远程设备的流量怎么接进来、又怎么在同一条明文链路上做页面内调试」。

## 下一步

[《真机、移动端与远程页面调试》](/scenarios/mobile-remote)：把这套证书与解密流程搬到手机与远程设备，再看注入式调试能力如何落在同一条明文链路上。之所以紧接着读它，是因为 23 把「装证书 → 开解密 → 明文改写」都在一台开发机上走通了，却没回答「流量怎么来」——手机、远程设备不在同一台机器上，证书要怎么装、流量要怎么指到这台代理、页面内调试又怎么落在同一条明文链路上；24 正是把这套流程搬到真机与远程场景要补的一段。
