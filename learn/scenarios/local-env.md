---
title: 本地联调与环境切换
description: 从整站代理到本地 dev server 出发，追溯 host、proxy、file 如何改写 req.options，以及多实例隔离的装配依据。
---

# 本地联调与环境切换

前端在本机起了 `localhost:5173` 的 dev server，后端接口却部署在测试机 `10.1.0.1:8080`；测试同学只想让带某个 cookie 的流量走新配置，运维又不许改系统 hosts 或 DNS。这类「同一域名、按路径与环境把流量分到不同后端」的现场，是本地联调最常遇到的工程问题。本篇从 `docs/docs/getting-started.md`、`rules/host.md`、`proxy.md`、`cli.md` 的真实规则出发，读完你能写出可复制的整站代理与排除规则，并说清 host、proxy、file 三者怎样落进 `req.options`，以及为什么多实例必须成对指定端口与存储目录。

## 场景与痛点

- **前端工程师与 dev server**：本机 Vite 跑在 `localhost:5173`，希望线上域名 `www.example.com` 的页面整体走本地，但 `/static` 的构建产物和 `/api` 的接口必须继续回源。约束是不改业务代码里的 baseURL、不动系统 hosts，只靠一层代理完成改道。
- **测试工程师与环境切换**：同一套规则要在 dev / prod 两份配置之间切换，可用的信号只有请求 cookie 里的 `env=dev`；本地静态目录并不完整，缺文件时必须回源而不是 404。约束是切换对同一 URL 生效，且不能为每种环境各起一个域名。
- **运维与多实例**：一台机器上要并行跑「项目日常」与「专项排障」两套 Whistle，各写各的 Rules 与 Values，还要能用 `w2 add` 从仓库里的 `.whistle.js` 一键导入。约束是端口不能冲突、数据不能互相覆盖，规则分组要能命名。

## 可复制的配置

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

## 背后的设计思想

- [代理即流量路由层](/core/http-request)：Whistle 只改写 `req.options` 的目标主机、端口与 URL，业务代码、系统 hosts 与 DNS 都不动。整站代理到 `localhost:5173` 正是把代理当作一层可插拔的流量总线，前端改一行规则即可，无需重新构建或发版。
- [协议差异消化在入口层](/architecture/overview)：`lib/index.js:40-52` 把 init、biz、inspectors、handlers 收敛成一条 Express 中间件链，`http://`、`file://`、`tunnel://` 等差异在进入 `req.options` 之前被抹平。因此 `file`、`host`、`proxy` 能写在同一条规则里，而不必关心底层是本地文件还是出站 socket。
- [顺序即优先级](/modules/rules-engine)：规则按行序自上而下匹配，首条命中即返回。排除条件必须挂在整站代理那一行，或把更具体的 `/static`、`/api` 规则放在前面，否则会被更宽的域名规则先命中；`includeFilter` 的 cookie 判断也是同一顺序模型下的二次筛选。
- [装配与启动分离](/architecture/startup)：`index.js:143-148` 归一化 options，`index.js:173` 才 `config.extend(options)` 把 `-p` / `-S` 写进全局 config，随后 `index.js:175` `require('./lib')(callback, server)` 创建代理服务。`-p` 与 `-S` 因此是启动期参数，决定监听端口与存储目录，而不是运行期规则；这解释了为什么多实例隔离要在命令行解决，而不是在 Rules 里写开关。

## 源码链路

按「入口 → 规则解析 → 应用点 → 回写/上报」走一遍，每一步都能对回站内已有章节。

1. **入口**：`lib/init.js:157-163` 是 `lib/index.js:40-52` 中间件链的第一环，做 `removeSpecPath`、用 `PipeStream.wrapSrc/wrapDest` 包装读写流、挂 `req.isPluginReq`，为后续改写备好上下文。见 [一次 HTTP 代理请求的旅程](/core/http-request)。
2. **分流**：`biz/index.js:31-163` 判定请求属于内部 Web UI、插件路径还是普通代理流量，普通请求在 `:162` 调 `next()` 落入 inspectors。见 [Web 管理界面](/modules/webui)。
3. **规则解析**：`lib/inspectors/rules.js:153-214` 归一化 `req.fullUrl`、解析头部规则，最终在 `setupRules` 的 `lib/inspectors/rules.js:44` 写出 `req.options = util.parseUrl(ruleUrl || req.fullUrl)`——host 与 proxy 的结果就落在这个对象里。见 [规则引擎](/modules/rules-engine)。
4. **应用点**：`lib/rules/index.js:126-303` 的 `getProxy` 先 `delete reqRules.proxy`、`delete reqRules.pac`，再由 `rules.getHost`（`:150`）与 `resolveRulesFromList(..., 'resolveProxy')`（`:153-156`）分别取出 host、proxy 规则。`host://` 指向域名等价于 CNAME：`setHost`（`:176-191`）在主机名不是 IP 时调 `rules.lookupHost`，最终落到 `lib/rules/dns.js:163-179` 的 `lookup` 把域名解析成 IP，并回调 `callback(err, ip, host.port, host)`。`lib/rules/index.js:84-95` 的 `isProxyHost` 检查 `proxyHost` 行属性，`:158,228-231` 分别读取 `proxyHost`、`proxyFirst` 开关，决定 host 与 proxy 是只留其一还是同时生效。见 [指令体系与分发链路](/modules/protocol-catalog)。
5. **出站或短路**：`lib/handlers/http-proxy.js:13-18` 对 web 协议调 `req.request(req.options)`；`file://` 则在 `lib/handlers/file-proxy.js:233-269` 由 `isFileProxy` 判定为本地协议后 `delete rules.proxy` / `delete rules.host`，再用 `rule.value` 构造 200 响应，不再出站。见 [指令体系与分发链路](/modules/protocol-catalog)。
6. **回写与装配**：`lib/inspectors/res.js:641-644` 用 `(useHttps ? https : http).request(options, res.response)` 拨出并把响应接回，旁路采样见 [抓包数据的采集与上报](/core/capture-data)；启动期 `lib/config.js:1067-1091` 按 `config.storage` 把 rules、values、properties 分到独立目录，`lib/config.js:704-885` 的 mode 解析提供 `multiEnv`/`multiple`，正是 `-p` 加 `-S` 并行多实例的依据。见 [进程模型与配置系统](/architecture/process-config)。

## 边界与坑

- **host 只对 Final URL 生效**：`docs/docs/rules/host.md` 明确 `host` 作用于「经过规则替换后生成的 Final URL」，多段映射如 `www.example.com/api www.example.com 127.0.0.1:1234` 不会命中，必须拆成两条规则，先重写再由第二条 host 接手。
- **host 与 proxy 同时命中时 proxy 被忽略**：`docs/docs/rules/host.md`、`docs/docs/rules/proxy.md` 的默认行为是仅 host 生效——`lib/rules/index.js:221-234` 在没有 `proxyHost` / `proxyFirst` 时直接 `return setHost()`，proxy 规则根本不写进 `reqRules.proxy`。三种改法：加 `enable://proxyFirst` / `lineProps://proxyFirst` 让仅 proxy 生效（`enable.md:56`），加 `enable://proxyHost` / `lineProps://proxyHost` 让两者同时生效（`host.md:47`），或用 `ignore://host` 让 host 规则不再参与（`operation.md:516`）；源码侧开关在 `lib/rules/index.js:84-95,158,228-231`。
- **file 等协议会让 proxy 失效**：`docs/docs/rules/enable.md:74` 与 `docs/docs/rules/lineProps.md:38` 说明，配置 `file` 后 `proxy` 自动失效，需用 `enable://weakRule` 或 `lineProps://weakRule` 提升 proxy 优先级；`docs/docs/rules/file.md:112` 给出同一结论的示例。
- **pathReplace 把 `/api/` 当正则**：`docs/docs/rules/pathReplace.md:51-69` 记录 `pathReplace://(/api/=/)` 会把 `/api/` 识别为正则，产生 `///xxx` 的多余斜杠，应改用 `/^api//=` 或 `delete://pathname.0`。
- **多实例必须独立目录加不同端口**：`docs/docs/faq.md:65-72` 与 `docs/docs/cli.md:236-284` 都要求每个实例端口唯一、存储目录唯一，否则启动失败或数据互相覆盖；`w2 start -p 8010 -S 8010` 与 `w2 start -p 8010 -S 8011` 是被明确标为端口冲突的反例。

## 小结

- 本地联调的本质是「同一域名按路径与环境分流」，代理只改 `req.options`，不动代码、hosts 与 DNS。
- 整站代理要把 `excludeFilter` 挂在整站那一行；`xfile` 负责缺文件回源，`includeFilter://reqH:cookie` 负责按 cookie 切环境。
- host 换主机端口、proxy/socks 换上游、`file` 走本地短路，三者统一由 `lib/inspectors/rules.js:44` 写进 `req.options` 后在 handler 分流。
- 顺序即优先级与装配与启动分离，分别解释了「排除规则为什么这样写」和「多实例为什么用 `-p` 加 `-S`」。
- Final URL、proxyHost、weakRule、pathReplace 与端口目录唯一性，是官方明确划定的五类边界。

## 下一步

[《接口未就绪：Mock 与契约先行》](/scenarios/mock-contract)：流量改道之后，下一步是后端还没写好时如何让请求根本不出网，看 `file://`、`tpl://` 与 `statusCode://` 如何在 handler 里短路转发。
