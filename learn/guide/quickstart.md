---
title: 第 0 站 · 第一次跑通 Whistle
description: 不读源码，先装好、启动、接流量、装证书、写下并验证第一条规则，再进入 01–41 的机制研读。
---

# 第 0 站 · 第一次跑通 Whistle

这一站不讲原理、不看源码，只做一件事：**把 Whistle 真正跑起来，并亲手验证一条规则生效**。本站其余 41 篇是「源码研读」，默认你已经会用这个工具；零基础读者如果跳过这一站直接读 01–41，会遇到「规则写在哪」「界面在哪」「为什么抓包列表里只有一行 `Tunnel to`（那代表代理在纯透传、还没解密）」这类根本没法往下做的问题。所以无论你走哪条学习路线，都请先完成这一站，再回头读机制。

完成这一站，你应该能：装好命令行版 Whistle、启动并打开管理界面、让浏览器与手机的流量经过它、装上根证书看到 HTTPS 明文、在 Rules 里写下并启用第一条规则、用「开启/关闭」对比确认它真的生效。

::: tip 先修知识
只需要一台能上网的电脑，以及「会打开终端敲一行命令、会用浏览器访问一个网址」这两项基本操作。不需要懂 Node.js、不需要读过源码、不需要预先装过任何抓包工具。本篇的命令与界面名称全部来自本仓库 `README.md` 与官方 `docs/docs/`（安装与启动、快速上手、HTTPS 对话框、移动端抓包），遇到版本差异时以你本机 `w2 help` 和官方使用文档为准。
:::

本篇不占 01–41 的编号：编号表示「机制研读」的阅读顺序，第 0 站是动手准备，先做后读。

## 第 1 步 · 装好 Node.js 与 Whistle

Whistle 命令行版通过 npm 分发，命令名是 `w2`。

```sh
# 1) 先确认已装 Node.js（本站源码基线要求 >= 16）
node -v

# 2) 全局安装 Whistle
npm i -g whistle
# macOS 也可用：brew install whistle

# 3) 确认装成功
w2 -V
```

**成功标志**：`node -v` 输出版本号；`w2 -V` 输出 Whistle 版本号。

**失败怎么办**：`node: command not found` → 去 `https://nodejs.org/` 装 LTS 版本后重开终端；`w2: command not found` → 确认全局 npm 目录在 PATH 里，或重新执行安装；权限报错 → macOS/Linux 用 `sudo npm i -g whistle`，Windows 用管理员身份打开终端。

## 第 2 步 · 启动并打开管理界面

```sh
w2 start        # 后台常驻启动，默认端口 8899
w2 status       # 确认实例在跑、端口是多少
# w2 start -p 8100   指定端口
# w2 stop            停止
# w2 restart         重启
```

**成功标志**：`w2 status` 显示 `whistle@... is running` 并列出含 `8899` 的访问 URL（要看 PID / Port 用 `w2 status --all`）。然后在浏览器打开 **`http://local.whistlejs.com`**（若打不开，用 `http://127.0.0.1:8899`），会看到顶部四个 Tab：

| Tab | 用来做什么 |
|---|---|
| Network | 实时抓包列表，点开一条看请求头、响应体，可 Replay / Edit |
| Rules | 写规则、建分组、保存并启用 |
| Values | 存规则要引用的文本或 JSON 内容 |
| Plugins | 管理插件 |

**失败怎么办**：端口被占用 → `w2 start -p 8100` 换端口，界面地址也换成 `http://127.0.0.1:8100`；`local.whistlejs.com` 打不开 → 直接用 `127.0.0.1:端口`；需要看日志 → 用 `w2 run` 前台启动，终端会直接打印异常。

## 第 3 步 · 让流量经过代理

工具起来了不等于流量会进来，必须让客户端把请求交给它。三选一：

- **最省事（整机）**：终端执行 `w2 proxy`，它会设置系统代理；用 `w2 proxy 0` 关闭；指定地址用 `w2 proxy "电脑IP:8899"`。
- **只让浏览器走（推荐日常）**：装 Chrome 扩展 ZeroOmega，新建一个代理情景，填 `127.0.0.1` + 端口 `8899`，切换启用。这样不影响其它程序。
- **手机**：见第 4 步末尾的移动端小节；手机与电脑必须同一局域网。

**成功标志**：随便打开一个 `http://` 开头的网站（先用明文站点最容易验证），回到 Network，列表里出现这条请求；点开能看到请求行与请求头。

**失败怎么办**：Network 空白 → 先确认代理是否真的启用（`w2 proxy` 的设置、ZeroOmega 是否切到代理情景），再确认浏览器没有走「直连」规则；仍不行就用 `curl -x 127.0.0.1:8899 http://example.com` 直接打一发，能出现在 Network 就说明代理本身是通的。

## 第 4 步 · 装根证书，看到 HTTPS 明文

HTTP 已经能看到，HTTPS 默认只显示一条 `Tunnel to`——这是正常现象，代表代理在纯透传（原理见 [03](/domain/tls-mitm)）。要看到明文，必须完成两件事：**根证书被系统信任** + **开启 HTTPS 解密**。

1. 终端执行 `w2 ca`（Windows 最后选「是(Y)」；macOS 可能需要开机密码或 Touch ID）。
2. 或者在界面点顶部 **HTTPS** 按钮打开对话框 → **Download RootCA** 下载证书（`.crt` / `.cer` / `.pem` 可切换，某种装不上就换一种）→ 导入系统信任库并设为「始终信任」。Firefox 不读系统证书库，需要单独在「设置 → 隐私与安全 → 查看证书 → 证书机构」导入并勾选信任。
3. 在同一个 HTTPS 对话框勾选 **Enable HTTPS (Capture Tunnel Traffic)**；等价的规则写法是 `enable://https`。

**成功标志**：打开一个 `https://` 站点，Network 里不再只有 `Tunnel to`，而是出现可点开的请求，能看到请求头、状态码与响应体。

**失败怎么办**：

| 现象 | 原因 | 怎么做 |
|---|---|---|
| 仍只有 `Tunnel to` | 证书没被信任，或没勾 Enable HTTPS | 回到上面第 2、3 小步逐项确认 |
| 浏览器提示「证书不受信」 | 根证书只下载没设为信任 | 在系统证书库里找到 Whistle 根 CA 设为始终信任 |
| 个别 App 报 `captureError` | 证书固定（pinning）或双向认证 | 对该域名放行不解密：`域名 disable://capture`；不要强行绕过 |
| `https://192.168.x.x` 看不到明文 | 直连 IP 不带 SNI（客户端在 TLS 握手时报出的目标域名） | 用 `enable://captureIp` 显式告知 |

**手机补充**：在 HTTPS 对话框切换「二维码地址」，用手机相机扫码下载证书；iOS 需「设置 → 通用 → VPN 与设备管理」装描述文件，**再**到「设置 → 通用 → 关于本机 → 证书信任设置」开启对根证书的完全信任（两步缺一不可）；Android 到「设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书」。然后在手机「设置 → Wi-Fi → 当前网络 → 手动代理」填电脑 IP 与端口 `8899` 并保存。详细边界见 [24《真机、移动端与远程页面调试》](/scenarios/mobile-remote)。

## 第 5 步 · 写下并启用第一条规则

规则的基本形状是 `pattern operation [lineProps...] [filters...]`：URL 命中 `pattern` 时，执行 `operation`（`协议://内容`）。后两段第一次读可以先不管——`lineProps` 是只作用于这一行的附加属性（例如提升优先级），`filters` 是对已匹配的请求再做一次筛选。现在写一条最容易验证的——给请求加一个自定义请求头。

1. 打开 **Rules** Tab → 点 **Create** 新建一个规则（或分组）并选中它。
2. 粘贴这一行：

```txt
www.example.com reqHeaders://x-whistle-hello=1
```

3. 点 **Save**（保存并启用），确认左上 **ON** 是开启状态（红色为开、灰色为关）。
4. 浏览器访问 `https://www.example.com`，回到 **Network** 点开这条请求，看 **Request Headers**。

**成功标志**：请求头里出现 `x-whistle-hello: 1`。

**这一步为什么重要**：它把「规则文本 → 请求期生效」这条链路变成肉眼可见的事实。后面 [09](/core/http-request) 讲的 16 步、[13](/modules/rules-engine) 讲的编译与匹配，都是在这一行背后发生的。

### 再进一步：用 Values 返回固定 JSON

通关自检第 9 项要用 `file://{key}`，做法就在这里：

1. 打开 **Values** Tab → **Create** 新建一个条目，命名为 `hello.json`，内容填 `{"msg":"hello from whistle"}` 并保存。
2. 回到 **Rules**，新建一组规则（或改掉刚才那行），写：

```txt
www.example.com/api file://{hello.json}
```

3. 浏览器访问 `https://www.example.com/api`，应看到你写的固定 JSON，而不是源站响应。

**成功标志**：页面显示那段 JSON；改 Values 里的内容、保存后再刷新，页面跟着变。`{key}` 的意思是「去 Values 取这个名字的内容」，规则文本和内容因此可以分开维护。这也是 [20《接口未就绪：Mock 与契约先行》](/scenarios/mock-contract) 的最小原型。

## 第 6 步 · 用「开 / 关」确认规则真的生效

只看到一次变化还不够，做一次对照实验：

1. 把 **ON** 关掉（变灰），刷新页面 → 请求头里的 `x-whistle-hello` 消失。
2. 再打开，刷新 → 字段重新出现。

**成功标志**：字段随开关出现/消失。能做出这个对照，说明你已经会「写规则 → 启用 → 发请求 → 看结果」这个最小闭环，后面所有工程场景都是它的组合。

**规则没生效按顺序查**：① ON 是否开启、是否点了 Save；② 当前选中的是不是你刚写的那组规则；③ `pattern` 是否真的匹配 URL（可先在 Network 底部搜索框确认 URL 长什么样）；④ 是否被前面某条规则先命中（默认每协议首条命中即返回，行序即优先级，见 [13](/modules/rules-engine)）；⑤ 是不是 HTTPS 还没解密（回到第 4 步）；⑥ 浏览器缓存，用强制刷新重试。

## 第 7 步 · 常用能力落在哪个界面

把「想做什么」对应到「点哪里」和「深入读哪篇」。这张表是本站 18–27 工程场景的操作索引：

| 想做什么 | 在哪操作 | 最小动作 | 深入读 |
|---|---|---|---|
| 看一条请求的细节 | Network | 点开请求，看 Headers / Response / Timeline | [12](/core/capture-data)、[36](/concepts/05-capture) |
| 把整站代理到本地 dev server | Rules | `域名 http://localhost:5173 excludeFilter://*/api` | [19](/scenarios/local-env) |
| 接口没好，先返回固定 JSON | Rules + Values | Values 里 Create 一个 key，Rules 写 `域名/api file://{key}` | [20](/scenarios/mock-contract) |
| 复现/改请求重发 | Network + Composer | 点开请求 → 右键 Replay / Edit；或 `Ctrl+S` 保存会话再导入 | [21](/scenarios/reproduce-replay) |
| 造超时/慢响应/偶发 500 | Rules | `reqDelay`、`resDelay`、`statusCode`、`includeFilter://chance:0.5` | [22](/scenarios/fault-injection) |
| HTTPS 只有隧道、证书报错 | HTTPS 对话框 | Download RootCA + Enable HTTPS | [23](/scenarios/https-trust)、[39](/concepts/08-confusions) |
| 真机调试 | 手机 Wi-Fi 代理 + 扫码证书 | 填电脑 IP:8899，iOS 开完全信任 | [24](/scenarios/mobile-remote) |
| 团队共享规则 | Rules / `@` / `w2 add` | 远程 URL 或 `.whistle.js` 导入 | [25](/scenarios/collab-config) |
| 写插件 | Plugins / 插件目录 | 按 `whistle.xxx` 命名建目录、写好 `package.json`，用 `w2 install` 安装 | [16](/modules/plugins)、[28 实验二](/advanced/hands-on)、[38](/concepts/07-extension) |
| 把代理嵌进 CI / 测试进程 | Node 代码 | `npm i whistle` 后 `require('whistle')` 传 options 启动，用事件断言规则命中 | [26](/scenarios/automation)、[28 实验三](/advanced/hands-on) |
| 用完收尾与合规检查 | 终端 + 系统证书库 | `w2 proxy 0`、`w2 stop`、取消根证书信任 | [27](/scenarios/boundaries) |

## 通关自检

按顺序做完，全部打勾就可以说自己「能把 Whistle 用起来了」，再进入机制研读才有意义：

1. `w2 -V` 输出版本号。
2. `w2 status` 显示 `is running` 并列出含 8899 的访问 URL。
3. 浏览器打开 `http://local.whistlejs.com` 看到 Network / Rules / Values / Plugins 四个 Tab。
4. 访问一个 http 站点，Network 里出现这条请求，点开能看到请求行与请求头。
5. 访问一个 https 站点，能看到明文请求头，而不是只有 `Tunnel to`。
6. 在 Rules 里 Create 一组规则、粘贴一行、Save、ON 为开启。
7. 刷新后请求头里出现你写的自定义字段。
8. 关掉 ON 刷新，字段消失；再打开，字段回来。
9. 在 Values 里 Create 一个 key，用 `file://{key}` 让浏览器拿到固定 JSON。
10. 手机（可选）：按第 4 步的「手机补充」设置 Wi-Fi 代理并完成证书完全信任，手机访问 https 站点后 Network 能看到明文。
11. 收尾：`w2 proxy 0` 关闭系统代理、`w2 stop` 停止实例，并取消不再需要的根证书系统信任。

最后一条不是形式：装了根证书等于扩大本机信任范围，用完请取消信任（原因见[27《能力边界、风险与合规》](/scenarios/boundaries)）。只对自己有权调试的流量开启解密。

## 出问题先看这里

| 现象 | 最可能的原因 | 处理 |
|---|---|---|
| `w2` 命令找不到 | 没装成功或 PATH 未包含全局 npm 目录 | 重装 `npm i -g whistle`，重开终端 |
| 界面打不开 | 实例没起来 / 端口不对 | `w2 status`、`w2 run` 看日志、换端口 |
| Network 一直空白 | 流量没经过代理 | 确认 `w2 proxy` 或 ZeroOmega 情景已启用 |
| 只有 `Tunnel to` | 未信任根证书或未开 Enable HTTPS | 回到第 4 步 |
| 规则写了没反应 | ON 关着 / 未 Save / 选错分组 / pattern 不匹配 | 按第 6 步的顺序表逐项查 |
| 手机连不上 | 不同局域网、防火墙拦端口、证书未完全信任 | 查电脑 IP、放行 8899、iOS 两步信任 |

::: warning 合规提醒
HTTPS 中间人解密只用于调试自己有权调试的流量。不要在共用开发机、生产环境或他人设备上长期开启；遇到证书固定、双向认证等场景应放行不解密，而不是尝试绕过。详见 [27](/scenarios/boundaries)。
:::

## 小结

- 先跑通再读机制：安装 → 启动 → 界面 → 接流量 → 证书 → 第一条规则 → 开关对照，第 1–6 步是六个动手环节，构成最小闭环；第 7 节「常用能力落在哪个界面」是一张查阅表，不算动手步骤。
- 四个 Tab 各管一段：Network 看结果、Rules 写决策、Values 存内容、Plugins 管扩展。
- 规则的最小形状是 `pattern operation`，验证生效最可靠的办法是「开启/关闭」对照。
- 本篇为后面的 [31–35 概念入门](/concepts/index) 与 [01 站点导览](/guide/orientation) 提供了可对照的真实操作经验；读机制时随时回到这里重做一遍实验。

## 下一步

这一站只让你「把工具跑起来」，离能独立解决问题还差一段能力训练。接下来按目标选：

- **零基础、目标是能独立用起来（推荐）**：进入 [实战通关 · L1–L5](/practice/index)，先建 [自造靶子](/practice/target)（不用后端也能练），再按 L1 观察 → L2 改写 → L3 构造 → L4 扩展 → [迁移关](/practice/bridge)（把靶子换到真实项目） → L5 排障逐关推进，最后用 [综合通关项目](/practice/final-project) 验收。每关都有任务、验收、变式与清场要求，晋级标准只认你做出来的结果。
- **已有基础、只想读源码**：按 [01 → 41](/guide/orientation) 顺读；概念精解 31–41、工程场景 18–27 与训练关都可按需回查。本篇可当作速查手册随时回来。
- 想立刻做三个实验：[28《三个动手实验》](/advanced/hands-on) 从本篇起步会更顺。
