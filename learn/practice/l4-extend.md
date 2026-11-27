---
title: L4 接得上 · HTTPS、真机、共享与集成的本机练法
description: 用本机等价替代练 HTTPS 解密排障、多客户端、规则集共享与内嵌启动，不依赖真机、团队或 CI 环境。
---

# L4 接得上 · HTTPS、真机、共享与集成的本机练法

::: tip 先修知识
已完成 [L3 造得出](/practice/l3-simulate)，并能按 [第 0 站](/guide/quickstart) 第 4 步装好根证书、打开 Enable HTTPS。本关大部分任务仍可在本机完成；需要真机/团队/CI 的地方都给了等价替代。
:::

## 本关目标

把前面练熟的能力接到更复杂的接入方式上：HTTPS 明文、不同客户端、上游代理、多人共享规则、测试进程内启动、插件。做完你能判断「这个流量我能不能改、该在哪一层改、什么时候该放行」，而不是见了 `Tunnel to` 就束手无策。

## 任务

## 开始前

1. 已完成 [L3](/practice/l3-simulate)，`练习靶子` 基线仍在（`$practice.test/api` / `$practice.test/other`，ON 可随时开关）。
2. [第 0 站](/guide/quickstart) 第 4 步的根证书信任与 **Enable HTTPS** 都处于可用状态——本关第 1 步会反复开关它。若你之前按第 0 站通关自检第 11 项做过清场（取消了证书信任），进本关前先按第 0 站第 4 步恢复，否则第 1 步只会看到 `Tunnel to`。
3. 终端可用 `curl`、`node -v` 正常；若要练内嵌实例，先在项目目录 `npm i whistle`。
4. 本关会起额外实例、动证书信任，**每一节结束就按该节要求清场**，不要攒到最后。

### 第 1 步 · HTTPS：按域名控制解密，而不是一刀切

1. 确认 [第 0 站](/guide/quickstart) 第 4 步已完成：`w2 ca` 或界面 **HTTPS** → Download RootCA 并设为信任，且 **Enable HTTPS** 已勾选。
2. 用 https 版靶子发一发（域名仍不存在，`file://` 会短路，不会真的连出去）：

```sh
curl -s -i -x 127.0.0.1:8899 https://practice.test/api
```

3. 在 Network 里点开，应能看到明文请求头与响应体；把 Enable HTTPS 关掉再发一次，列表里应变成一条 `Tunnel to`（这一步是复查第 0 站，不是新内容）。
4. **真正新增的能力是「只对该解密的域名解密」**：再追加一行 `$skip.test/api disable://capture`，然后发 `curl -s -i -x 127.0.0.1:8899 https://skip.test/api`。它应保持 `Tunnel to`，而 `practice.test` 仍是明文。用两条请求做对照并留证据。

**这一步要练的是判断力**：`Tunnel to` 不是「抓包失败」，而是「代理在纯透传」。按「入口 → 信任 → 判定」三层依次查（[23](/scenarios/https-trust) 的四步排障链）。

### 第 2 步 · 证书与解密的边界

依次验证三种「看不看得见」：

| 操作 | 该看到 | 说明 |
|---|---|---|
| 对目标域名写 `practice.test disable://capture` | 回到 `Tunnel to` | 主动放行不解密，用于证书固定 / mTLS |
| 用 `enable://captureIp` 配合 IP 形式的 URL | IP 直连也能尝试解密 | 直连 IP 通常不发 SNI，需显式开启 |
| 浏览器提示证书不受信 | 页面打不开或告警 | 根证书只下载没设为信任，回第 0 站补 |

**边界**：证书固定、双向认证、生产环境流量应放行不解密，不要尝试绕过（[27](/scenarios/boundaries)）。

### 第 3 步 · 多客户端：不用真机也能练

真机调试的本质是「另一台设备的流量经过同一个代理」。本机等价做法：

```sh
# 用另一个进程/浏览器配置走同一代理，模拟「第二个客户端」
curl -s -i -x 127.0.0.1:8899 -H "X-Client: phone-sim" http://practice.test/api
```

在 Network 搜索框用 `h:x-client`（请求/响应头文本）或 `i:`（客户端 IP）筛出它，例如输入 `h:phone-sim`；再给规则加 `includeFilter://reqH.x-client:phone` 让改动只对这个客户端生效。这样就练到了「按客户端限定」这个真机场景里最核心的能力，而不需要手机和局域网。

> 真要做真机：按 [第 0 站](/guide/quickstart) 第 4 步的「手机补充」用 Wi-Fi 手动代理 + 扫码装证书，iOS 记得开「完全信任」；细节见 [24](/scenarios/mobile-remote)。

### 第 4 步 · 上游代理：理解「代理再求助另一个代理」

本机没有上级代理时，这层读懂机制即可，**不要拿 Whistle 自己造自环**：阅读 [02](/domain/proxy-basics) 的「上游代理与链式 CONNECT」，记住一条结论——出站目标地址由规则算出的地址优先于原 URL（`host://` / `proxy://` 改的就是它）。

**本机等价动作**（不需要真的有上级代理）：

1. 另开一个终端执行 `python3 -m http.server 9000`（系统自带，不装任何东西）。
2. 规则追加 `$practice.test/api host://127.0.0.1:9000`，再发一次 curl。
3. 响应应来自 9000 端口那个服务（目录列表或 404 页面），**不再是靶子的 JSON** —— 这就是「出站地址被规则改掉」的可观察证据。
4. 立刻删掉这条规则，发一发确认恢复靶子 JSON。

> 绝对不要把 `host://` 指向 Whistle 自己的端口（8899 / 18899）：请求会被重新打回代理形成无限自环，且很难一眼看出原因。

### 第 5 步 · 规则集共享：不用团队也能练

1. **导出的规则文本**：Rules → **Export** 得到文件，再用 Rules → **Import** 导入回来，确认规则集出现在列表里。`w2 add` 不是用来导入规则文本的。
2. **`.whistle.js` 方式**：在项目目录建 `.whistle.js`，导出 `name` / `rules`，执行 `w2 add`，确认 Rules 面板出现对应规则集。`w2 add` 只执行当前目录的 `.whistle.js`（或 `.whistle.mjs`，也可 `w2 add filepath` 指定文件），见 `docs/docs/cli.md`。
3. 改 `.whistle.js` 后重新执行 `w2 add`，确认规则更新——界面靠轮询感知变化，不是推送（[25](/scenarios/collab-config)）。
4. 在 Rules 里写 `@/Users/你的用户名/rules.txt` 指向一个本地规则文件（换成你自己的绝对路径），文件里写一行 `$practice.test/api file://({"from":"at"})`；保存后发一发确认命中。改文件内容，等一个刷新周期再看响应是否变化——`@` 是定时回源的规则来源（[25](/scenarios/collab-config)）。

`.whistle.js` 的最小可抄写法（放在项目目录，执行 `w2 add`）：

```js
module.exports = {
  name: '练习规则集',
  rules: '$practice.test/api file://({"from":"whistle.js"})'
}
```

`name` 会成为界面里的规则集名，`rules` 是规则文本。改完文件重新执行 `w2 add` 才会更新——它不是长连接推送。

这就练到了「配置即代码」的核心：规则可版本化、来源可切换、变更会全量重编译。

### 第 6 步 · 把 Whistle 当库用（选做，需要一点 Node.js）

> 这一步需要会运行一个 Node 脚本（`node -v` 能输出版本号即可）。第 0 站承诺主线不需要懂 Node.js，因此**本步是选做**，不计入晋级标准；只想学会用工具的话可以跳过，直接看第 7 步。

在项目目录里新建一个最小脚本（需要先 `npm i whistle`）：

```js
const whistle = require('whistle')
const instance = whistle({ port: 18899, storage: 'practice' }, (err) => {
  if (err) { console.error(err); return }
  console.log('practice ready')
})
```

执行后终端应输出 `practice ready`，用 `curl -s -i -x 127.0.0.1:18899 http://practice.test/api` 验证：因为没有配置规则，会看到 502 或连接失败，而**不是** `Connection refused`——这恰好证明流量确实到了这个内嵌实例。它不会起后台守护进程、不改系统代理、不装证书——这些都要调用方自己安排（[26](/scenarios/automation)、[28 实验三](/advanced/hands-on)）。

### 第 7 步 · 插件最小形态（选做）

按 `whistle.xxx` 命名建目录、写好 `package.json`，用 `w2 install` 安装，在 Plugins 面板确认出现。完整实验见 [28 实验二](/advanced/hands-on)，机制见 [16](/modules/plugins)、[38](/concepts/07-extension)。

## 验收

**该看到**：https 靶子能点开明文；关掉 Enable HTTPS 变成 `Tunnel to`；`disable://capture` 让指定域名退回透传；带 `X-Client` 的请求能被过滤并被规则单独限定；`w2 add` 导入后规则集出现且改动会刷新；内嵌脚本输出 `practice ready` 并能用 curl 打到。

**该看到（新增）**：`skip.test` 保持 `Tunnel to` 而 `practice.test` 是明文；`host://127.0.0.1:9000` 期间响应来自 9000 服务，删掉规则后恢复靶子 JSON。

**不该看到**：对所有 HTTPS 站点无差别解密（应只对自己有权调试的目标开）；内嵌实例改了系统代理或装了证书（它不该做这些）；`host://` 自环没清理导致后续请求全异常。

## 变式

1. **只对一个客户端解密**：给 `enable://https` 加 `includeFilter://reqH.x-client:phone`，用两个不同请求头做对照。
2. **换端口多实例**：`w2 start -p 8100 -S practice2`，用 `w2 status --all` 看到两个实例，理解端口与存储目录必须都唯一（[08](/architecture/process-config)）。
3. **规则集来回切**：Rules 里允许多选时切换两组规则，确认只有当前选中的那组生效。

## 没看到预期？按顺序查

1. 只有 `Tunnel to` → 根证书是否设为信任、Enable HTTPS 是否勾选、是否被 `disable://capture` 放行（[第 0 站](/guide/quickstart) 第 4 步 + [23](/scenarios/https-trust)）。
2. 证书告警 → 下载了没导入、导入了没设「始终信任」；Firefox 需单独导入或开 `security.enterprise_roots.enabled`。
3. 真机连不上 → 同一局域网、防火墙放行端口、iOS 两步信任（[24](/scenarios/mobile-remote)）。
4. 规则集没刷新 → 界面是轮询不是推送，等一个周期；确认导入的是当前选中的规则集。
5. 内嵌脚本端口冲突 → 换端口；`storage` 用独立目录名，避免与默认实例共用。
6. `host://` 造成自环 → 立刻删掉该规则，重启实例。

## 收尾

关掉所有演练规则；`w2 stop -S practice2` 停掉额外实例（`-S` 要与启动时的存储目录一致）；内嵌脚本用 `Ctrl+C` 结束；如不再需要，取消根证书的系统信任（[第 0 站](/guide/quickstart) 通关自检第 11 项）。

## 背后的机制

- 两段 TLS、SNI 现签、默认透传：[03](/domain/tls-mitm)、[10](/core/connect-mitm)、[15](/modules/certificates)。
- 上游代理与链式 CONNECT：[02](/domain/proxy-basics)。
- 规则来源、`@`、全量重编译与轮询：[25](/scenarios/collab-config)、[13](/modules/rules-engine)。
- 内嵌入口为什么是纯函数：[26](/scenarios/automation)、[28 实验三](/advanced/hands-on)。

## 晋级标准

不看本页，能判断一个 HTTPS 请求「能不能看明文、为什么不能、该放行还是该开解密」；能把规则限定到指定客户端；能分别用 **Rules Export → Import** 和 **`.whistle.js` + `w2 add`** 两种方式让规则集出现在界面并确认生效（两者不是一回事）；能用两条 curl 证据判断一个 HTTPS 请求该不该解密。内嵌实例是选做，不作要求。做到就进 [L5 排得清](/practice/l5-diagnose)。

## 下一步

[迁移关 · 从练习靶子到真实项目](/practice/bridge)：把本关与前面几关的规则换到真实域名、本地 dev server 与 HTTPS 站点，说清必改项与清场，再进 L5 排障。
