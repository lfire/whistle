---
title: 真机、移动端与远程页面调试
description: 从手机代理与根证书到 weinre、log 与帧调试，串起单端口多入口下的远程调试链路与源码落点。
---

# 真机、移动端与远程页面调试

页面在桌面浏览器一切正常，到了真机却布局错乱、控制台没有输出，这类问题必须先让设备流量经过代理，再让调试能力抵达页面内部。本篇从手机 Wi-Fi 代理与根证书安装讲起，覆盖系统代理、PAC、多入口部署，以及 weinre、log、frameScript 三类注入式调试，最后追到端口归一、内容注入与帧缓存的源码。读完你能把一台真机接进调试链路，也明白这些能力为什么都汇聚在同一个端口上。

## 场景与痛点

真机首次接入。手机需要手动把 Wi-Fi 代理指向电脑，再从代理地址下载根证书；iOS 还必须在「设置 → 通用 → 关于本机 → 证书信任设置」里开启完全信任，只装描述文件不算完成。任何一步遗漏，表现都是 HTTPS 页面打不开或抓包列表只有隧道，排查时很容易误判成规则写错。

远程页面的 DOM 与日志。真机没有开发者工具，想看元素结构和 console 输出，只能由代理把调试脚本注入页面。多个页面、多台设备并行调试时还要用分组与 debug-id 区分来源，否则日志混在一起比没有日志更难读。

长连接与弱网调试。WebSocket 帧需要逐帧查看、暂停甚至忽略，界面刷新又要跟上弱网下的节奏。这类能力既涉及服务端帧缓存，也涉及界面轮询策略，单看规则文本看不出边界在哪里。把设备接入、脚本注入与帧调试分开验证，能快速定位是网络没通还是页面没有被注入。

::: cols 20|30|50
| 能力 | 注入对象 | 查看位置 |
|---|---|---|
| weinre | HTML 与 JS | Weinre 菜单 |
| log | HTML 与 JS | Console 面板 |
| frameScript | WS 与 TCP 帧 | Frames 面板 |
:::

## 可复制的配置

先让设备连上代理。以下命令与规则按接入顺序给出，前一步不通就先停在原地排查，不要急着叠加注入规则，否则很难判断失败发生在网络层还是页面层；对无法直接设置代理的应用，可用 Proxifier 把流量导向同一个代理端口，手机侧始终只需要填写一个代理地址。

```bash
# 来源：docs/docs/cli.md
w2 proxy
w2 proxy 8100
w2 proxy 0
# 来源：docs/docs/mobile.md
# 手机 Wi-Fi 手动代理：电脑 IP:8899
# 根证书下载：http://[电脑IP]:[Whistle端口]/cgi-bin/rootca
```

需要按条件分流时，把 PAC 脚本交给规则托管，不必逐台设备改配置。

```txt
# 来源：docs/docs/rules/pac.md（远程 PAC 脚本）
* pac://https://raw.githubusercontent.com/imweb/node-pac/master/test/scripts/normal.pac
```

多入口部署把不同协议收敛到同一实例。

```bash
# 来源：docs/docs/cli.md
w2 start --socksPort 1080
w2 start --httpsPort 8001
```

DOM 调试与日志可以同时开启，日志按 id 分组即可区分多域名来源。

```txt
# 来源：docs/docs/gui/weinre.md、rules/log.md
https://www.qq.com weinre://test log://
www.example.com log://myapp
ke.qq.com log://ke
mobile.example.com weinre://mobile-debug
```

日志脱敏与帧调试同样由规则驱动。

```txt
# 来源：docs/docs/rules/log.md
www.example.com log:// jsPrepend://{handleLog.js}
# 来源：docs/docs/rules/frameScript.md、gui/network.md
wss://echo.websocket.org/ frameScript://{test-frame.js}
www.example.com/path enable://ignoreReceive
```

脱敏脚本挂在发送前的钩子上，可以直接沿用官方示例。

```js
// 来源：docs/docs/rules/log.md（handleLog.js 节选）
window.onBeforeWhistleLogSend = function (result, level) {
  result.forEach(function (msg, i) {
    if (typeof msg === 'string' && msg.includes('password')) {
      result[i] = '[SENSITIVE DATA HIDDEN]';
    }
  });
};
```

Console 面板用 All logs 切换分组，配合 Import、Export、Clear 管理日志文件（`docs/docs/gui/console.md`）；Frames 面板用 Send、Pause、Ignore 控制收发（`docs/docs/gui/network.md`）。

## 背后的设计思想

[单端口多事件](/architecture/overview)：无论客户端走 HTTP、HTTPS 还是 SOCKS，最终都被翻译成对主端口的连接，因此手机只需填写一个代理地址。端口差异在入口层消化掉，规则匹配、抓包与注入才有统一的上下文，设备侧配置也降到最低。

[注入按内容类型且可插拔](/modules/protocol-catalog)：weinre 与 log 不改写业务文件，而是在响应流上挂一个 Transform，且只在响应确实有 body、内容类型确为 HTML 或 JS 时插入脚本。注入被做成可插拔的响应阶段能力，既能与 htmlAppend、jsPrepend 共存，也不会误伤 JSON 接口。

[第三方代码必须隔离](/modules/plugins)：weinre 是独立的第三方调试服务，由 pfork 拉起单独子进程承载，主进程只负责注入脚本与转发。把重活与不可信代码挪出主进程，调试服务崩溃或占用过高都不会拖垮代理本身。

[内存有界优先](/core/capture-data)与[短轮询由客户端控制节奏](/modules/webui)：帧数据不无限堆积，服务端缓存与界面列表都设有上限；界面按上次拿到的帧编号发起下一轮查询，弱网下自然放慢，不需要服务端推送，也不会把大量帧一次性压给浏览器。

## 源码链路

1. **入口 · 代理与端口归一**：`bin/proxy.js` 的 set-global-proxy 设置系统代理，`lib/index.js:96-150` 建立 httpPort 与 httpsPort，`lib/index.js:151-207` 把 SOCKS 请求翻译成 CONNECT 回连主端口。参见[从 w2 start 到端口监听](/architecture/startup)。
2. **规则解析 · Upgrade 入口**：`lib/upgrade.js:77-177` 接管 upgrade 事件，`lib/socket-mgr.js:291-301` 用 ws-parser 建收发器，`lib/socket-mgr.js:303-323` 的 execHandleFrame 执行 frameScript。参见[隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。
3. **应用点 · 注入判定**：`lib/inspectors/weinre.js:23-51` 与 `lib/inspectors/log.js:26-79` 在 src 响应上按内容类型挂 Transform，分别注入 target-script-min.js 与 assets/js/log.js。参见[指令体系与分发链路](/modules/protocol-catalog)。
4. **应用点 · 按类型注入**：`lib/inspectors/res.js:949-979` 的 injectRules 依据 isHtml、isJs、isCss 挑选 htmlAppend、jsPrepend 等规则。参见[一次 HTTP 代理请求的旅程](/core/http-request)。
5. **回写 · 重活隔离**：`biz/weinre/index.js:11-20` 用 pfork 拉起 weinre 子进程，让第三方调试服务与主进程隔离。参见[插件系统](/modules/plugins)。
6. **上报 · 帧缓存与界面节奏**：`lib/socket-mgr.js:859`、`lib/socket-mgr.js:910`、`lib/socket-mgr.js:933` 处理界面中断与帧控制，`biz/webui/cgi-bin/get-frames.js:5` 按查询取帧，`lib/util/data-server.js:347` 写入帧缓存（单次 16 帧）。参见[Web 管理界面](/modules/webui)与[抓包数据的采集与上报](/core/capture-data)。

## 边界与坑

- iOS 装完描述文件后必须手动开启根证书完全信任（`docs/docs/mobile.md`、`docs/docs/faq.md`）；Firefox 不读系统证书库，需要单独导入（`docs/docs/faq.md`）。
- App 若做证书固定则无法抓包，官方对自研应用指向 Android 开发文档的网络安全配置（`docs/docs/faq.md`、`docs/docs/mobile.md`）。
- 手机与电脑需处于同一局域网，且防火墙不能拦截代理端口，否则证书二维码与代理都无法连通（`docs/docs/mobile.md`）。
- `log://` 注入采集的日志可能包含敏感信息，官方提供 jsPrepend 配合 `window.onBeforeWhistleLogSend` 的脱敏钩子（`docs/docs/rules/log.md`）。
- 帧缓存单次最多 16 帧（`lib/util/data-server.js:354`），界面列表上限 256 帧（`biz/webui/htdocs/src/js/data-center.js:24`）；weinre 与 log 走内置域名端口时可用 enable://useLocalHost|useSafePort（`docs/docs/rules/enable.md`）。

## 小结

- 设备侧只需一个代理地址，协议与端口差异全部在服务端入口层收敛。
- 注入式调试依赖内容类型判定，对无 body 或非 HTML、JS 的响应不会生效。
- 第三方调试服务运行在隔离子进程，主进程只保留注入与转发职责。
- 帧与日志都有明确上限，远程调试不会把弱网设备与界面拖垮。
- 注入脚本与帧控制都发生在响应阶段或帧回调里，不需要改动设备上的业务代码。

## 下一步

[《团队协作：规则集、远程规则与配置即代码》](/scenarios/collab-config)：把规则分组、Values 与多人共享的配置方式串起来；若想先回到实现，可重读[《规则引擎：解析与匹配》](/modules/rules-engine)。
