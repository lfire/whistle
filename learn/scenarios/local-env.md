---
title: 本地联调与环境切换
description: 从整站代理到本地 dev server 出发，追溯 host、proxy、file 如何改写 req.options，以及多实例隔离的装配依据。
---

# 本地联调与环境切换

前端在本机起了 `localhost:5173` 的 dev server，后端接口却部署在测试机 `10.1.0.1:8080`；测试同学只想让带某个 cookie 的流量走新配置，运维又不许改系统 hosts 或 DNS。这类「同一域名、按路径与环境把流量分到不同后端」的现场，是本地联调最常遇到的工程问题。本篇从 `docs/docs/getting-started.md`、`rules/host.md`、`proxy.md`、`cli.md` 的真实规则出发，读完你能写出可复制的整站代理与排除规则，并说清 host、proxy、file 三者怎样落进 `req.options`，以及为什么多实例必须成对指定端口与存储目录。[《工程场景总览》](/scenarios/index)（18）给出了五层追溯法与 9 篇场景地图，却还没拿任何一条真实规则走完这条链；[《规则引擎：解析与匹配》](/modules/rules-engine)（13）讲清了一行规则如何编译命中，却把「命中之后流量到底去哪」留给了具体场景。本篇作为 19 号第一站，就挑最日常的「整站改道」把这两处空白合上。

::: tip 先修知识
本篇承接 [《工程场景总览》](/scenarios/index)（18）与 [《规则引擎：解析与匹配》](/modules/rules-engine)（13），需要你已经理解五层追溯法的读法、规则按行序首条命中即返回，以及 `req.options` 是规则产物的落点。18 给的是「怎么找」的尺子，13 给的是「一行规则怎么被编译命中」，本篇把它们合起来回答「命中之后流量去哪」。

若某个名词卡住，按主题回查 [概念精解总览](/concepts/index) 与 [《全量术语索引》](/concepts/glossary)；正文在术语首次出现处也给了对应链接。

给完全没读过源码的读者：把 `req.options` 先当成代理内部的一张「派送单」——上面记着这次请求该连哪台机器、哪个端口、走什么 URL。本篇所有改道，本质都是往这张单子上改一两个字段，业务代码、系统 hosts 与 DNS 一概不碰；后面「源码链路」才说明这张单子由谁写、谁读。
:::

## 场景与痛点

- **前端工程师与 dev server**：本机 Vite 跑在 `localhost:5173`，希望线上域名 `www.example.com` 的页面整体走本地，但 `/static` 的构建产物和 `/api` 的接口必须继续回源。约束是不改业务代码里的 baseURL、不动系统 hosts，只靠一层代理完成改道。
- **测试工程师与环境切换**：同一套规则要在 dev / prod 两份配置之间切换，可用的信号只有请求 cookie 里的 `env=dev`；本地静态目录并不完整，缺文件时必须回源而不是 404。约束是切换对同一 URL 生效，且不能为每种环境各起一个域名。
- **运维与多实例**：一台机器上要并行跑「项目日常」与「专项排障」两套 Whistle，各写各的 Rules 与 [Values](/concepts/06-rules)，还要能用 `w2 add` 从仓库里的 `.whistle.js` 一键导入。约束是端口不能冲突、数据不能互相覆盖，规则分组要能命名。

三条现场的「输入 → 动作 → 输出」其实同构：输入各不相同（页面整体走本地但静态与接口要回源、按 cookie 切环境、一台机器跑两套实例），动作都收敛成同一件——在不改代码、hosts 与 DNS 的前提下改写 `req.options` 里的目标；输出则是下面四段可直接复制的规则或命令。把三条约束并列写出来，是为了先框定「只能在代理层解决」这个前提。

为什么这样设计：约束不是背景铺垫，而是推理的边界。若允许改 baseURL 或配 hosts，直接改代码反而更短，本篇的整套规则就没有存在必要；正因为「什么都不许动」，才逼出「只改 `req.options`」这一条路。先讲清不能做什么，后面的写法才不是一堆无从取舍的技巧。

代价与边界：这些约束把问题限制在「HTTP 层可改写的目标」内。像隧道建立前的纯 TCP 转发、或需要客户端先信任证书才能看到明文的加密流量，光改目标不够，得配合 23、24 两篇的前提。换句话说，本篇能解决「流量去哪」，还解决不了「流量看不看得见」。

类比：像快递分拣，收件地址（域名）不变，分拣员（代理）只按面单备注（路径、cookie）把包裹改投到不同网点，不拆包也不碰内容。

最小自验：把整站代理那行的 `excludeFilter://*/static` 去掉，再想 `/static` 的去向——按「首条命中即返回」，更宽的整站行会先命中，静态资源也会被送去 `localhost:5173`。用这一增一减就能自证「排除条件必须挂在整站那一行」，不必真的启动服务。

三条现场与后文四段配置是一一对应的：前端的「整站走本地、静态与接口回源」对应第一段整站代理加 `excludeFilter`；测试的「按 cookie 切环境、缺文件回源」对应 `xfile` 与 `includeFilter://reqH:cookie` 那段；运维的「两套实例各写各的」对应 `w2 start -p ... -S ...` 那段。先看痛点再看配置，就不会觉得四段是随手堆的示例，也能按自己的角色直接跳到该看的那段。

换个角度按角色看：前端最在意「不改 baseURL」，测试最在意「同一 URL 上切换且不 404」，运维最在意「端口与数据不互相踩」。三种诉求挤在同一个代理上却不冲突，是因为它们分别落在目标主机、本地短路、启动装配三个不同层面——这也预告了后面「装配与启动分离」为什么要单独成一条原则，而不是并进「顺序即优先级」里。

## 可复制的配置


> **动手前**：本节的规则写在界面的 **Rules** 面板（Create → 粘贴 → Save → ON），另有 `w2 start -p` / `w2 add` 需要在终端执行。若还没把工具跑起来，先完成 [第 0 站 · 第一次跑通](/guide/quickstart)；示例里的域名与 IP 请换成你自己能访问的站点。下面示例里的域名、IP、路径与 `{key}` 都是占位，请替换成你自己的目标；引用 `{key}` 之前，先在 Values 里 Create 好同名条目。

整站代理的关键是把排除条件挂在整站那一行，而不是另写一条兜底规则；下面四段都可直接复制到 Rules 面板。

```txt
# 来源：docs/docs/getting-started.md
# 整站代理到本地 dev server，排除静态与接口路径
www.example.com http://localhost:5173 excludeFilter://*/static excludeFilter://*/api
# 静态资源映射到本地目录
www.example.com/static file:///User/xxx/statics
# 接口转发到测试服务器
www.example.com/api 10.1.0.1:8080
```

`file` 的「穿透版」`xfile` 与按 cookie 过滤，解决本地目录不全与环境切换两个约束。

```txt
# 来源：docs/docs/rules/file.md
# 本地不存在则回源，不返回 404
www.example.com xfile:///Users/username/static-files
# 通过 cookie：env=dev 判断是否为开发环境
www.example.com/config file://{dev-config} includeFilter://reqH:cookie=/env=dev/
```

host 只换主机与端口，proxy 与 socks 换成上游代理，写法不同但都在改 `req.options`。

```txt
# 来源：docs/docs/rules/host.md、proxy.md、socks.md
# 仅替换主机端口，服务端仍见原始 URL
www.example.com/test1 127.0.0.1:5173
# 指向域名相当于 CNAME
www.example.com/test2 host://www.test.com
# 走上游 HTTP / SOCKS 代理
www.example.com proxy://127.0.0.1:8080
www.example.com socks://127.0.0.1:8080
```

多实例与规则导入属于启动期装配，用命令而不是规则表达。

```bash
# 来源：docs/docs/cli.md、docs/docs/faq.md
# 每个实例独立目录 + 不同端口
w2 start -p 8010 -S 8010
w2 start -p 8011 -S 8011
# .whistle.js 可写：exports.groupName = '项目开发环境'
w2 add            # 导入当前目录 .whistle.js
w2 add --force    # 强制覆盖已有规则
```

这四段覆盖四类改道方式：`http://localhost:5173` 与 `10.1.0.1:8080` 属于目标 URL 与主机替换，`file` / `xfile` 属于本地协议短路，`host` / `proxy` / `socks` 属于目标与上游改写，`-p` / `-S` 属于启动期装配。它们最终都落到同一个 `req.options`，区别只在规则引擎把哪一类协议写进去；理解这一点，就能解释为什么排除条件必须挂在整站代理那一行，以及为什么换协议并不需要改匹配写法。

把这段结论拆成「输入 → 动作 → 输出」：输入是一行 pattern 加一个协议值；动作是规则引擎把该协议写进 `req.options` 的对应字段，handler 再据此决定是拨出站 socket 还是走本地短路；输出是一个不再需要业务代码参与的请求去向。四类写法不同、落点相同，正是「换协议不用改匹配写法」的由来——pattern 只负责选谁，协议值只负责去哪。

为什么这样设计：排除条件与过滤器是挂在「一行规则」上的，命中判定也以行为单位。若把 `/static`、`/api` 另写成兜底行，它排在整站行之后，按首条命中即返回根本轮不到执行——所以「把排除条件挂在整站那一行」不是风格建议，而是顺序模型下的必然。同理，`includeFilter://reqH:cookie=/env=dev/` 也只是同一行上的二次筛选，而不是另起一条规则。

代价与边界：共用同一匹配模型的好处是换协议零成本，代价是「看起来能叠加」的多条规则其实互斥。初学者容易以为写了两条都会生效，实际只有最上面那条命中；需要同时作用时得靠过滤器或开关，而不是多写几行。四类改道之间也有优先级暗坑，后面「边界与坑」会逐条点出。

类比：像同一个插座（pattern）上换不同插头（协议），插座位置不变，变的是电流去向（目标主机 / 本地文件 / 上游代理）。

最小自验：对照 `www.example.com/test1 127.0.0.1:5173` 与 `www.example.com/test2 host://www.test.com` 两行，pattern 写法没变、只有协议值不同；再对照 `www.example.com xfile:///Users/username/static-files` 与 `file` 的差别，就能看出「同一 pattern 换协议」和「同一协议换穿透行为」是两个独立维度，不必真起服务。

把四段配置的「输入 → 落点」摊开看更清楚：目标 URL 与主机替换那类，输入是 `http://localhost:5173` 或 `10.1.0.1:8080`，落点是 `req.options` 的主机与端口；本地协议短路那类，输入是 `file://` / `xfile://` 加一个路径，落点是 handler 直接构造响应；目标与上游改写那类，输入是 `host` / `proxy` / `socks`，落点仍是同一个 options；启动装配那类，输入是 `-p` / `-S`，落点是进程级 config。四类输入形态不同，但前三类的落点完全相同，这正是「换协议不需要改匹配写法」的底层原因。

四段里 `xfile` 与 `file` 只差一个字母，行为却差在「本地缺文件」这一刻：`file` 按本地协议短路、缺文件就 404，`xfile` 则回源。把这两行并排看，能直观体会总览里「同一机制在不同约束下的不同用法」那句话——规则结构没变，变的是失败时怎么办；约束一变，同一条协议就得换个兄弟指令来接。

## 背后的设计思想

- [代理即流量路由层](/core/http-request)：Whistle 只改写 `req.options` 的目标主机、端口与 URL，业务代码、系统 hosts 与 DNS 都不动。整站代理到 `localhost:5173` 正是把代理当作一层可插拔的流量总线，前端改一行规则即可，无需重新构建或发版。
- [协议差异消化在入口层](/architecture/overview)：`lib/index.js:40-52` 把 init、biz、inspectors、handlers 收敛成一条 Express 中间件链，`http://`、`file://`、`tunnel://` 等差异在进入 `req.options` 之前被抹平。因此 `file`、`host`、`proxy` 能写在同一条规则里，而不必关心底层是本地文件还是出站 socket。
- [顺序即优先级](/modules/rules-engine)：规则按行序自上而下匹配，首条命中即返回。排除条件必须挂在整站代理那一行，或把更具体的 `/static`、`/api` 规则放在前面，否则会被更宽的域名规则先命中；`includeFilter` 的 cookie 判断也是同一顺序模型下的二次筛选。
- [装配与启动分离](/architecture/startup)：`index.js:143-148` 归一化 options，`index.js:173` 才 `config.extend(options)` 把 `-p` / `-S` 写进全局 config，随后 `index.js:175` `require('./lib')(callback, server)` 创建代理服务。`-p` 与 `-S` 因此是启动期参数，决定监听端口与存储目录，而不是运行期规则；这解释了为什么多实例隔离要在命令行解决，而不是在 Rules 里写开关。

四条原则对应同一条链的四个位置：入口层先抹平协议差异（解释为什么 `file`、`host`、`proxy` 能混写），顺序即优先级再决定哪一行说了算（解释排除条件为什么挂同一行），代理即路由层把结果只写进 `req.options`（解释为什么不动代码、hosts 与 DNS），装配与启动分离则把端口与目录提前到启动期定妥（解释多实例为什么用 `-p` 加 `-S`）。把它们摊在同一条链上看，就不会觉得是四条互不相干的口号。

输入 → 动作 → 输出：输入一行规则或一个启动参数 → 规则引擎归一化 / config 合并 → `req.options` 或一个独立存储目录。两条输入走的是不同阶段，却都汇到「请求最终去哪」这一个问题上，也正因为汇到一处，四类改道才可能共用一套写法。

为什么这样设计：把「运行期规则」与「启动期装配」分开，是因为端口和存储目录属于进程级资源，必须在监听前定妥，运行中改会牵动已建立的连接；规则则是每个请求重新求值，天生适合热替换。把两类东西塞进同一个面板，只会让「改了没生效」更难排查——你会分不清是规则没命中，还是参数压根不属于规则。

代价与边界：分开的代价是 `-p` / `-S` 不能写进 Rules、必须重启才生效，而运行期规则也改不了端口与目录，两者不可互相替代；一边追求「即时生效」，一边就得接受「进程级参数即时不了」。理解这个分工，也能顺带解释为什么 `w2 add` 导的是规则、而不是端口配置。

类比：运行期规则像导航软件，可以边开边改目的地；启动期装配像出厂时定好的车身与油箱，只能停车重装。

最小自验：对照 `w2 start -p 8010 -S 8010` 与 `w2 start -p 8011 -S 8011`，把第二条命令的 `-S` 改成和第一条相同，按「存储目录唯一」的结论即可判断两套实例的 Rules 与 Values 会互相覆盖——用已有命令就能自验「端口与目录必须成对唯一」，不必真的并行启动两个进程。

把四条原则放回 18 给的五层尺子：「代理即流量路由层」与「协议差异消化在入口层」回答的是设计原则与内核机制，「顺序即优先级」是规则怎么被解析与生效的约束，「装配与启动分离」则把话题推到进程与边界。也就是说，本篇「背后的设计思想」一节不是在罗列优点，而是在五层里逐格填空；读任何一篇场景的设计思想时，都可以拿这把尺子去量它填了哪几格。

若把 `-p` / `-S` 也做成运行期规则，会立刻撞上语义错位：端口在监听前就已绑定、存储目录在启动时就已打开，运行中改这两个值既动不了已建立的连接，也无法凭空搬走已落盘的数据。反过来，若把「整站代理到哪」也做成启动参数，每换一个联调目标就要重启一次，热替换的便利就没了。两边都不能挪，正是「装配与启动分离」这条原则约束住的结果，而不是谁拍脑袋定的风格。

## 源码链路

按「入口 → 规则解析 → 应用点 → 回写/上报」走一遍，每一步都能对回站内已有章节。

1. **入口**：`lib/init.js:157-163` 是 `lib/index.js:40-52` 中间件链的第一环，做 `removeSpecPath`、用 `PipeStream.wrapSrc/wrapDest` 包装读写流、挂 `req.isPluginReq`，为后续改写备好上下文。见 [一次 HTTP 代理请求的旅程](/core/http-request)。
2. **分流**：`biz/index.js:31-163` 判定请求属于内部 Web UI、[插件](/concepts/07-extension)路径还是普通代理流量，普通请求在 `:162` 调 `next()` 落入 inspectors。见 [Web 管理界面](/modules/webui)。
3. **规则解析**：`lib/inspectors/rules.js:153-214` 归一化 `req.fullUrl`、解析头部规则，最终在 `setupRules` 的 `lib/inspectors/rules.js:44` 写出 `req.options = util.parseUrl(ruleUrl || req.fullUrl)`——host 与 proxy 的结果就落在这个对象里。见 [规则引擎](/modules/rules-engine)。
4. **应用点**：`lib/rules/index.js:126-303` 的 `getProxy` 先 `delete reqRules.proxy`、`delete reqRules.pac`，再由 `rules.getHost`（`:150`）与 `resolveRulesFromList(..., 'resolveProxy')`（`:153-156`）分别取出 host、proxy 规则。`host://` 指向域名等价于 CNAME：`setHost`（`:176-191`）在主机名不是 IP 时调 `rules.lookupHost`，最终落到 `lib/rules/dns.js:163-179` 的 `lookup` 把域名解析成 IP，并回调 `callback(err, ip, host.port, host)`。`lib/rules/index.js:84-95` 的 `isProxyHost` 检查 `proxyHost` 行属性，`:158,228-231` 分别读取 `proxyHost`、`proxyFirst` 开关，决定 host 与 proxy 是只留其一还是同时生效。见 [指令体系与分发链路](/modules/protocol-catalog)。
5. **出站或短路**：`lib/handlers/http-proxy.js:13-18` 对 web 协议调 `req.request(req.options)`；`file://` 则在 `lib/handlers/file-proxy.js:233-269` 由 `isFileProxy` 判定为本地协议后 `delete rules.proxy` / `delete rules.host`，再用 `rule.value` 构造 200 响应，不再出站。见 [指令体系与分发链路](/modules/protocol-catalog)。
6. **回写与装配**：`lib/inspectors/res.js:641-644` 用 `(useHttps ? https : http).request(options, res.response)` 拨出并把响应接回，旁路采样见 [抓包数据的采集与上报](/core/capture-data)；启动期 `lib/config.js:1067-1091` 按 `config.storage` 把 rules、values、properties 分到独立目录，`lib/config.js:704-885` 的 mode 解析提供 `multiEnv`/`multiple`，正是 `-p` 加 `-S` 并行多实例的依据。见 [进程模型与配置系统](/architecture/process-config)。

把 1–6 收拢成「输入 → 动作 → 输出」：输入一个普通代理请求 → 入口中间件链包装读写流、归一化全 URL、解析规则把协议写进 `req.options`、getProxy 取 host 与 proxy、handler 决定出站或本地短路 → 输出一个拨出或被短路的响应，再由 res 回写并旁路采样。六步不是六个独立模块，而是同一个请求对象被逐段加工的过程。

为什么这样设计：把「规则解析」与「规则应用」拆成两步，是为了让同一份编译产物既服务改道、又服务抓包与上报。若在解析阶段就直接拨出，旁路采样便拿不到完整的请求与响应上下文；先定稿 `req.options`、再交给 handler，各工位才能各取所需，观测与改道也就不会互相抢请求。

代价与边界：链路越长，一个靠后的开关（如 `proxyHost` / `proxyFirst`）越容易让人忽略前面的步骤。排查「规则写了却没生效」时，要按 1→6 逐段确认是没解析、没命中、还是被 handler 短路，而不能只盯着 Rules 面板。第 6 步按 `useHttps` 选择 `http` 或 `https` 拨出时，[TLS](/concepts/03-tls) 握手与目标校验都发生在这次出站里，属于「改道之后」才轮到的环节，也说明改道只决定去哪、不负责怎么建连。

类比：像一条流水线，原料进、贴标签（规则）、分流（getProxy）、加工（handler）、质检（旁路采样）出；任一工位改了参数，都会反映在成品上，但站在成品这一端看不出是哪个工位改的，所以才需要按 1→6 回头定位。

最小自验：按 1→6 的顺序，把「规则解析写出 `req.options`」这一步与「file 协议删掉 proxy 与 host、直接构造响应」这一步对照看——同一个 `req.options`，前者写、后者改，就能理解为什么「出站与短路」是同一条链上的两种分支，而不是两套独立逻辑。

六步与七段模板里「源码链路」一节是同一件事的两种粒度：模板那节给的是结论级的「入口 → 规则解析 → 应用点 → 回写」，本篇把它细到 init、biz、rules、getProxy、handler、res 六个具体工位。读的时候可以先记粗粒度，再按 1→6 对回站内已有章节，不必一上来就记文件名；粗线记牢了，细节才有地方挂。

按 1→6 排查「规则写了没生效」可以这样问：入口有没有把请求当成普通代理流量（第 2 步分流）→ `req.options` 有没有被写成预期目标（第 3 步解析）→ host 与 proxy 有没有被优先级开关互相顶掉（第 4 步应用）→ 是不是被 `file` 短路、压根没出站（第 5 步）。逐段问下来，比在 Rules 面板里反复改写法快得多，也能顺带定位到该翻站内哪一篇。

> **验收点**：配置生效后，访问示例域名应看到本地 dev server 的页面；关掉 ON 再刷新应回到原站。按 [第 0 站](/guide/quickstart) 第 6 步的开关对照法确认。

## 边界与坑

- **host 只对 Final URL 生效**：`docs/docs/rules/host.md` 明确 `host` 作用于「经过规则替换后生成的 Final URL」，多段映射如 `www.example.com/api www.example.com 127.0.0.1:1234` 不会命中，必须拆成两条规则，先重写再由第二条 host 接手。
- **host 与 proxy 同时命中时 proxy 被忽略**：`docs/docs/rules/host.md`、`docs/docs/rules/proxy.md` 的默认行为是仅 host 生效——`lib/rules/index.js:221-234` 在没有 `proxyHost` / `proxyFirst` 时直接 `return setHost()`，proxy 规则根本不写进 `reqRules.proxy`。三种改法：加 `enable://proxyFirst` / `lineProps://proxyFirst` 让仅 proxy 生效（`enable.md:56`），加 `enable://proxyHost` / `lineProps://proxyHost` 让两者同时生效（`host.md:47`），或用 `ignore://host` 让 host 规则不再参与（`operation.md:516`）；源码侧开关在 `lib/rules/index.js:84-95,158,228-231`。
- **file 等协议会让 proxy 失效**：`docs/docs/rules/enable.md:74` 与 `docs/docs/rules/lineProps.md:38` 说明，配置 `file` 后 `proxy` 自动失效，需用 `enable://weakRule` 或 `lineProps://weakRule` 提升 proxy 优先级；`docs/docs/rules/file.md:112` 给出同一结论的示例。
- **pathReplace 把 `/api/` 当正则**：`docs/docs/rules/pathReplace.md:51-69` 记录 `pathReplace://(/api/=/)` 会把 `/api/` 识别为正则，产生 `///xxx` 的多余斜杠，应改用 `/^api//=` 或 `delete://pathname.0`。
- **多实例必须独立目录加不同端口**：`docs/docs/faq.md:65-72` 与 `docs/docs/cli.md:236-284` 都要求每个实例端口唯一、存储目录唯一，否则启动失败或数据互相覆盖；`w2 start -p 8010 -S 8010` 与 `w2 start -p 8010 -S 8011` 是被明确标为端口冲突的反例。

- **容易以为整站代理另写一条兜底规则就能把 `/static` 拉回源，其实首条命中即返回**，兜底行排在后面根本轮不到执行，排除条件只能挂在整站那一行。
- **容易以为 `host://` 和 `proxy://` 写在一起会叠加上游，其实默认仅 host 生效、proxy 被忽略**，要 `enable://proxyFirst` / `enable://proxyHost` 这类开关才改变结果。
- **容易以为 `file://` 命中后还会再走一遍上游代理，其实本地协议短路会删掉 proxy 与 host、直接构造 200**；这也正是下一篇 Mock 能「根本不出网」的伏笔。
- **容易以为多实例只要端口不同就行，其实存储目录也必须唯一**，否则 rules 与 values 会互相覆盖。这几条的共性，是把「多条规则可叠加」当成了默认；更细的对照可见 [《概念精解 · 易混淆概念辨析》](/concepts/08-confusions)。

把这一节的五条既有坑与上面四条辨析分开看，会更清楚该记什么：五条坑是官方或源码划定的事实边界（Final URL、proxy 被忽略、file 让 proxy 失效、pathReplace 正则、端口目录唯一），改法明确、照做即可；四条辨析是读者心里容易默认错的模型（多条规则可叠加、host 与 proxy 会叠加、file 还会走上游、端口唯一就够了）。前者查文档能补，后者得靠把链路走通才能纠正——这也是本层坚持「源码链路」与「边界与坑」两节并存的原因。

## 小结

- 本地联调的本质是「同一域名按路径与环境分流」，代理只改 `req.options`，不动代码、hosts 与 DNS。
- 整站代理要把 `excludeFilter` 挂在整站那一行；`xfile` 负责缺文件回源，`includeFilter://reqH:cookie` 负责按 cookie 切环境。
- host 换主机端口、proxy/socks 换上游、`file` 走本地短路，三者统一由 `lib/inspectors/rules.js:44` 写进 `req.options` 后在 handler 分流。
- 顺序即优先级与装配与启动分离，分别解释了「排除规则为什么这样写」和「多实例为什么用 `-p` 加 `-S`」。
- Final URL、proxyHost、weakRule、pathReplace 与端口目录唯一性，是官方明确划定的五类边界。
- 本篇为 [《接口未就绪：Mock 与契约先行》](/scenarios/mock-contract) 准备了「改道之后请求去了哪」的底座：既然 `file` 能删掉 proxy 与 host 直接短路，20 就把这条短路从「读本地文件」推到「内联值与 Values 固定返回」，并把 2MB 容量边界讲透。

## 下一步

[《接口未就绪：Mock 与契约先行》](/scenarios/mock-contract)：流量改道之后，下一步是后端还没写好时如何让请求根本不出网，看 `file://`、`tpl://` 与 `statusCode://` 如何在 handler 里短路转发。之所以紧接着读它，是因为 19 的四种改道都默认「目标存在、会应答」——`localhost:5173`、测试机或本地文件都真实在那里；一旦后端根本没写好，改道就无处可去，只能让 handler 自己造响应，这正是 20 要回答的未解问题。
