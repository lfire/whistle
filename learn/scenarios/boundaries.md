---
title: 能力边界、风险与合规
description: 把解密判定、证书信任、抓包阈值、插件隔离与管理面鉴权串成一张边界清单，给出可勾选的合规实践。
---

# 能力边界、风险与合规

前面几篇都在讲「能做什么」，本篇专门讲「不该做什么」。当调试代理被装进共用开发机、被接进流水线、甚至被误当成生产网关时，生产误用、敏感数据泄露、根证书信任范围扩大这几类风险就会同时出现。本篇把散落在各章的边界点收拢成一张清单，读完你能说清解密在哪一步被挡住、证书信任扩大到什么范围、抓包数据如何落盘，以及管理面靠什么收敛权限。所有结论都来自官方 FAQ、源码阈值与测试代码。

## 场景与痛点

**一、把调试代理当生产网关。** Whistle 是单点、带解密开销的调试工具，不是为流量治理设计的网关。一旦把生产或预发流量引到它上面，性能、可用性与故障半径都会成为问题，而它默认宽松的出站校验更会把风险放大。

**二、敏感数据随抓包扩散。** 抓包列表里会出现完整请求头、Cookie、令牌与响应正文；导出的会话文件还会 gzip 落盘。若把会话文件随手放进网盘或共享仓库，等于把一批真实凭据一并交了出去。

**三、证书信任范围扩大与解密边界被误绕过。** 安装根 CA 影响整机所有应用的 TLS，而不只是浏览器里的调试标签页；用完不取消信任，共用开发机上的其它进程都暴露在这份信任之下。遇到证书固定（pinning）或双向认证，若再强行换证书解密，既破坏业务又踩合规红线，正确做法是退回纯透传。

## 可复制的配置

出站默认不校验源站证书，`--mode safe` 才打开严格校验（来源 `docs/docs/cli.md`、`docs/docs/rules/cipher.md`）：

```bash
# 来源：docs/docs/cli.md / docs/docs/rules/cipher.md
w2 start --mode safe   # 置 rejectUnauthorized=true，校验源站证书
```

证书固定或握手失败时，跳过解密改纯透传，而不是强行替换证书（来源 `docs/docs/faq.md`）：

```txt
# 来源：docs/docs/faq.md（captureError / ssl pinning）
域名 disable://capture
```

用管理员账号与只读游客账号区分「能改」与「只能看」，并把管理面放到独立端口（来源 `docs/docs/cli.md`）：

```bash
# 来源：docs/docs/cli.md（-n/-w/-N/-W、-P/--uiport）
w2 start -n abc -w 123 -N test -W 123 -P 8889
# 管理员 abc/123 可改配置；游客 test/123 只读；管理面走 8889
```

`--allowOrigin *` 敞开跨域读管理接口，仅限隔离环境临时使用（来源 `docs/docs/cli.md`）：

```bash
# 来源：docs/docs/cli.md（--allowOrigin）
w2 start --allowOrigin *   # 风险：任意来源站点可跨域访问管理接口
w2 start -P 8889           # 配合 --uiport 收敛管理面入口
```

## 背后的设计思想

**默认透传、显式才解密。** 见 [CONNECT 判定与 TLS 解密](/core/connect-mitm)。`lib/tunnel.js:191-213` 的 `isIntercept()` 综合抓包开关、自定义证书、策略头与 `lib/tunnel.js:26-27` 的系统域名黑名单，只有显式命中才进入解密分支；否则走 `net.connect` 纯透传。解密是需要逐次授权的例外，而非默认能力。

**两段 TLS 信任边界独立。** 见 [HTTPS、证书链与中间人](/domain/tls-mitm)。入站由本地 CA 现签叶证书、依赖客户端已信任根 CA；出站走 Node 原生校验，`lib/config.js:65` 默认 `rejectUnauthorized = false` 只放宽出站这一段。把两侧混为一谈，是「装了证书就以为全程安全」误判的根源。

**信任范围最小化。** 见 [信任范围最小化](/modules/certificates) 与 [第三方代码必须隔离](/modules/plugins)。根私钥只落在本机 `certs` 目录，`lib/https/ca.js:268-276` 的 `createCertificate` 刻意只从 `cachePairs` 取自签证书，避免把用户上传的私钥打包下载出去；插件同样是第三方 npm 代码，必须跑在隔离子进程里，不能默认可信。

**内存有界优先于数据完整。** 见 [内存有界优先](/core/capture-data)。`lib/inspectors/data.js:7-11,291-296` 在 body 超阈时直接丢弃内容只留元信息，`lib/util/data-server.js:21-26` 用定长缓存回收旧会话。这套取舍说明它定位是调试采样器而非审计系统，不应被当作完整流量留存的合规依据。

## 源码链路

沿一次请求的生命周期，从入口解密判定走到管理面，八处边界依次是：解密判定 `lib/tunnel.js:191-213` 与系统黑名单 `lib/tunnel.js:26-27`（[CONNECT 判定与 TLS 解密](/core/connect-mitm)）；证书分桶 `lib/https/ca.js:268-276`（[证书体系的实现细节](/modules/certificates)）；出站校验 `lib/config.js:65,809-810`；抓包阈值 `lib/inspectors/data.js:7-11,291-296`（[抓包数据的采集与上报](/core/capture-data)）；有界缓存 `lib/util/data-server.js:21-26`；插件隔离 `lib/plugins/index.js:633-647`（[插件系统](/modules/plugins)）；CGI 白名单 `biz/webui/lib/index.js:387-418` 与管理面鉴权 `biz/webui/lib/index.js:39-43,154-210`（[Web 管理界面](/modules/webui)）。

::: cols 14|24|30|32
| 边界 | 机制 | 源码 | 若被绕过的后果 |
|---|---|---|---|
| [解密判定](/core/connect-mitm) | 开关/证书/黑名单综合判定 | `tunnel.js:191-213` | 未授权解密他人 HTTPS |
| [证书分桶](/modules/certificates) | 下载只取自签缓存 | `ca.js:268-276` | 用户私钥被打包外泄 |
| [出站校验](/core/connect-mitm) | 默认 false，safe 才开启 | `config.js:65,809-810` | 代理到源站遭中间人 |
| [抓包阈值](/core/capture-data) | 超阈丢弃 body 保元信息 | `data.js:7-11,291-296` | 大响应撑高内存 |
| [有界缓存](/core/capture-data) | 定长数组与溢出回收 | `data-server.js:21-26` | 长跑会话撑爆 RSS |
| [插件隔离](/modules/plugins) | pfork 子进程加载 | `plugins:633-647` | 第三方代码入主进程 |
| [CGI 白名单](/modules/webui) | 路径映射且校验上跳 | `webui/lib:387-418` | 目录穿越读任意文件 |
| [管理面鉴权](/modules/webui) | 管理员/游客/免检路径 | `webui:39-43,154-210` | 未授权改规则配置 |
:::

## 边界与坑

- **证书固定与 mTLS 不应被绕过。** `docs/docs/faq.md` 的 `captureError` 问答给的方案是 `域名 disable://capture` 改纯透传，或由业务方提供专用调试构建；双向认证客户端证书应走 `docs/docs/rules/cipher.md` 的 `tlsOptions`，而非强行替换证书让握手蒙混过关。
- **根证书信任范围扩大到整机。** `docs/docs/cli.md` 说明 `w2 ca` 在 macOS 与 Windows 自动安装根证书；源码 `bin/ca/index.js:15-28` 用 `security add-trusted-cert -k <默认钥匙串>` 与 `certutil -addstore -user Root` 写入系统信任库，意味着这台机器上所有应用的 TLS 都可能被解密，用完必须取消信任。
- **抓包含敏感数据且会话会落盘。** 请求头里的 Cookie、令牌与响应正文都在采集范围内，`lib/service/service.js:103,109` 把 `sessions` 经 `gzip` 写入 `SAVED_SESSIONS_PATH`；会话文件应按敏感数据管理，禁止上传网盘或共享仓库，并定期清理。
- **出站默认宽松，且代理是单点。** `lib/config.js:65` 的 `rejectUnauthorized = false` 只为兼容自签名源站，`docs/docs/rules/cipher.md` 明确「谨慎使用，仅限开发环境」，生产应 `--mode safe`（`lib/config.js:809-810`）；调试代理有单点与解密开销，不适合承担生产流量治理。
- **插件是第三方代码，根证书不能随手上传。** 插件来自 npm（`docs/docs/extensions/usage.md`、`lib/plugins/index.js:633-647`），应只装可信来源；`docs/docs/gui/https.md` 明确「不支持直接上传根证书，需放到自定义证书目录并重启 Whistle 才能生效」，界面上传入口只接收成对的业务证书。

## 合规清单

- [ ] 仅在自己有权调试的设备与流量上启用，未经同意不解密他人通信。
- [ ] 用完关闭全局抓包开关（Enable HTTPS）与相关规则集，避免长期敞口。
- [ ] 用完取消根证书的系统信任，尤其在共用开发机与临时调试机上。
- [ ] 会话文件按敏感数据管理、定期清理，不上传网盘、仓库或聊天工具。
- [ ] 生产与预发流量不走调试代理；证书固定与 mTLS 域名一律改纯透传。
- [ ] 管理面设置强口令与只读游客账号，收敛 `--allowOrigin` 并用 `--uiport` 隔离端口。
- [ ] 只安装可信来源插件，禁用长期不用的全局插件，出站校验在准生产环境开启。

## 小结

- 解密是例外而非默认：`isIntercept()` 未命中就纯透传，pinning 与 mTLS 应退回透传而不是强行绕过。
- 两段 TLS 信任边界独立；`--mode safe` 只收紧出站校验，根 CA 信任影响的是整机所有应用。
- 抓包含 Cookie 与令牌、会话 gzip 落盘，按敏感数据管理；有界缓存与阈值说明它是采样器而非审计系统。
- 八处边界覆盖解密、证书、出站、采集、缓存、插件、CGI 与管理面，任何一处被绕过都会放大风险。
- 插件是第三方 npm 代码，根证书不支持直接上传，需放目录并重启才生效。

## 下一步

[《三个动手实验》](/advanced/hands-on)：边界厘清之后，进入进阶实践层，用可复现的实验把解密、规则与抓包链路亲手跑一遍。
