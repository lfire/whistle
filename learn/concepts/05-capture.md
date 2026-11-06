---
title: 第三层：抓包数据面与帧
description: 以概念词典的方式讲透抓包会话、旁路采样、帧、缓存、重放与上报，把每个名词落到真实源码与工程场景。
---

# 第三层：抓包数据面与帧

本层是「概念精解」的抓包数据面分册，前置知识是 [一次 HTTP 代理请求的旅程](/core/http-request)、[CONNECT 与 MITM](/core/connect-mitm) 与 [隧道、WebSocket 与帧拦截](/core/tunnel-websocket) 已经铺好的请求流与帧管道。这里不再沿时间线重走链路，而是把链路里冒出来的每个专业名词——会话、reqId、采样、帧、Composer、短轮询——逐个拆成定义、类比、源码落点与设计取舍。读完你能解释一个 20MB 的响应为什么只留下一行元信息、界面为何永远读得到内核刚写入的字段，以及「抓包」与「阻断」到底差在哪一层。

## 本层概念地图

抓包数据面可切成四簇：**登记**（会话与 reqId）、**采样**（inspector、旁路、阈值、零复制）、**帧**（frame、缓存、SSE、WebSocket、脚本、状态机、心跳）、**消费界面**（短轮询、Composer、重放、SAZ、Test Rules、中断）。四簇共用同一份 `data` 引用，也共用同一组有界常量；理解任意一簇，都要顺带看清它在常驻内存里的代价。下面的地图把词条与主干文件对上，读到后文每张卡片时可回来定位。

::: cols 20|30|50
| 概念簇 | 代表词条 | 主源码落点 |
|---|---|---|
| 登记 | session / reqId | `data-server.js` |
| 采样 | 旁路 / 阈值 / 零复制 | `inspectors/data.js` |
| 帧 | frame / ws-parser / 脚本 | `socket-mgr.js` |
| 消费 | 轮询 / Composer / SAZ | `service/`、`cgi-bin/` |
:::

前置概念只有一句话：请求流被四段 inspector 依次包装，抓包是夹在中间、不改道的一段旁路；所有可见数据最终由 `lib/util/data-server.js` 统一登记、裁剪并喂给 UI。带着这张地图，下面进入词条。

### 抓包 / session（会话）
> 把一次请求从发起到收尾记成一条可回看的记录。

**打个比方**：像高速路的 ETC 门架，车过一次就留一条含时间、车牌、出入口的流水，既不拦车也不改道，只做登记。事后查账靠这条流水，而不是靠把车叫回来重开一遍。
**在 Whistle 里**：`lib/inspectors/data.js:156-185` 构造 `data` 对象，并以 `proxy.emit('request', reqEmitter, data)` 把会话广播到事件总线；`lib/util/data-server.js:319-333` 再把它放进 `reqData[id]`。此后 `reqEmitter` 在请求发出、响应到达、结束、中断时分别抛 `send`、`response`、`end`、`abort` 推进状态。
**为什么这样设计**：调试要「回看」和「导出」，所以一次性登记、多处复用同一引用。把会话定义成「一次请求」而非「一条连接」，长连接上的无数帧才能归到同一个 id 下，而不至于每条帧都变成一条独立流水。
**容易混淆**：会话是请求级记录，帧是连接级分片，粒度不同，见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[复现与重放](/scenarios/reproduce-replay) 里先 Save 一条偶现 502，再反复 Replay 它。

### reqId
> 一条会话或连接在内核里的唯一编号。

**打个比方**：像快递单号，仓库、转运、派送各环节都报同一个号，才能把散落的扫描记录串成一件包裹的完整轨迹。没有这个号，每一站都只看到一段孤立动作。
**在 Whistle 里**：`lib/inspectors/rules.js:159` 或 `lib/tunnel.js:89` 分配；`lib/socket-mgr.js:10` 的 `conns` 以它为键登记连接上下文，`lib/util/data-server.js:31` 的 `framesMap[data.reqId]` 也按它归帧。
**为什么这样设计**：请求、响应、帧、隧道、UI 注入分属不同模块甚至不同进程，必须有一个跨模块的关联键；用字符串而非对象引用，才能塞进 CGI 参数在界面与内核之间传递。
**容易混淆**：`reqId` 关联一次请求，`testId` 只用于 Composer 命中查询，二者不是一套键，见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[远程调试](/scenarios/mobile-remote) 里按 id 精确定位某台手机的某次请求。

### inspector（四阶段检查器）
> 请求链路上按顺序插入的四段改写与采集中间件。

**打个比方**：像工厂流水线上四道质检工位，每道只看自己那一段、装完就传给下一道，谁也不把整条线搬回自己车间。于是加一道、去一道都不影响其它工位。
**在 Whistle 里**：`lib/inspectors/index.js:1-8` 固定 `rules → req → data → res` 的顺序，`data` 夹在请求改写与响应改写之间；`lib/inspectors/data.js:542-551` 是它的中间件本体，只调 `emitDataEvents` 再按 `reqDelay` 延时 `next()`。
**为什么这样设计**：把「改头」「采数据」「改响应」拆成独立可插拔阶段，规则与抓包互不干扰；`data` 放在两侧流被包装之后，抓到的才是改写后的字节，与「界面所见即实际发出」的调试预期一致。
**容易混淆**：`req` / `res` inspector 会改写报文，`data` inspector 只采样不改写，见 [抓包数据的采集与上报](/core/capture-data)。
**工程中的样子**：[故障注入](/scenarios/fault-injection) 的 `reqDelay`、`resSpeed` 就挂在 data 阶段。

### 旁路采样
> 覆盖流的 `write` / `end` 顺手记一份，不阻断转发。

**打个比方**：像在输油管旁接一支取样阀，油照常流向下一站，阀门只放出一小杯去化验，主管里没有多出一道闸门。观察行为因此不会改变被观察的流量。
**在 Whistle 里**：`lib/inspectors/data.js:279-323` 保存原始 `write` / `end`，包装成先累加长度、拼 Buffer 再 `write.apply` 透传；响应侧 `:364-409` 完全对称。

```js
// lib/inspectors/data.js:279-296（节选）
var write = stream.write;
stream.write = function (chunk) {
  if (chunk) {
    reqData.size += chunk.length;
    reqBody = util.joinBuffer(reqBody, chunk);
    if (reqData.size > maxReqSize) {
      reqBody = false;
    }
  }
  return write.apply(this, arguments);
};
```

**为什么这样设计**：调试最怕「观察行为改变了被观察对象」，旁路让抓包零等待、零额外跳。代价是采样与改写共用同一份被包装的流，界面看到的是改写后字节而非客户端原始报文。
**容易混淆**：抓包 ≠ 阻断转发；真正断开靠 `abort`，见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[抓包数据的采集与上报](/core/capture-data) 整篇就是这条旁路的展开。

### data 对象原地更新 / 零复制
> 内核与 UI 读同一个 `data` 引用，不做快照拷贝。

**打个比方**：像一块全员共用的白板，谁写一笔所有人立刻看见，省去复印；但也意味着谁擦掉一行就再也找不回来，没法假设自己拿到的是某一刻的存照。
**在 Whistle 里**：`lib/util/data-server.js:319-333` 的 `handleRequest` 直接 `reqData[id] = data` 并就地补 `version` / `nodeVersion`；`getItem`（`:624-631`）与 `getList`（`:283-317`）只在返回前调 `toBase64String`（`:216-220`），没有克隆。

```js
// lib/util/data-server.js:319-333（节选）
function handleRequest(req, data) {
  var id = (data.id = data.id || data.startTime + '-' + ++count);
  data.version = version;
  data.nodeVersion = nodeVersion;
  reqData[id] = data;
  ids.indexOf(id) === -1 && ids.push(id);
}
```

**为什么这样设计**：增量字段天然可见、零序列化开销，抓包列表、详情面板与导出内容天然一致。代价是这个对象整段会话常驻内存，任何字段膨胀都直接抬高 RSS，且一处修改对所有消费者立即可见——所以阈值与 `clearCache` 不是可选优化，而是这套模型的必要兜底。
**容易混淆**：与「导出才序列化」相对；导出是 `gzip(JSON.stringify(sessions))`（`lib/service/service.js:103`），见 [复现与重放](/scenarios/reproduce-replay)。
**工程中的样子**：改一条请求头后 Network 详情立即刷新，正是同一引用在生效。

### body 阈值与元信息
> 正文超过上限就丢 body，但时间、头、长度照留。

**打个比方**：像快递超重只退回大件、运单仍留着——你知道「有过一个 20MB 的包裹、几点到、谁签收」，只是看不见里面装了什么。记录还在，内容被有意舍弃。
**在 Whistle 里**：`lib/inspectors/data.js:7-11` 定 360KB、1MB、2MB、2MB、16MB 五档；`:291-296`、`:376-381` 超阈把 `reqBody` / `resBody` 置为 `false`，`reqData.size`、`headers`、`statusCode`、起止时间等元信息照常保留。
**为什么这样设计**：抓包是常驻内存的辅助功能，一个大文件就能拖垮代理；「宁可少存正文、不丢记录」比完整保存更划算，界面仍能显示「有一个大响应」，便于判断是否存在异常大包。
**容易混淆**：超阈 ≠ 丢弃整条记录；`enable://bigData` 只是把上限放宽到 16MB，见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[故障注入](/scenarios/fault-injection) 造大响应时，body 栏为空但列表仍有一行。

### 帧（frame）与帧缓存
> 长连接上按边界切出的一次收发数据片。

**打个比方**：像对讲机的一句「完毕」，一次通话由许多句组成；每句单独记、单独编号，不必等通话结束才回看。若非要等挂断才整理，长连接调试就永远看不到实时内容。
**在 Whistle 里**：`lib/socket-mgr.js:44-48` 的 `proxy.emit('frame', {...})` 定义帧结构（`reqId` / `frameId` / `closed` / `code` / `err`）；`lib/util/data-server.js:342-345` 把帧推进 `framesCache[]` 并按 `reqId` 建 `framesMap`。
**为什么这样设计**：WebSocket 与 TCP 隧道没有「请求-响应」边界，只有帧才能做交互式调试；缓存必须按 `reqId` 分组，`getFrames`（`lib/util/data-server.js:347-354`）单次最多取 16 帧，避免一次拉取把内存打满。
**容易混淆**：帧 ≠ HTTP 请求；一个会话可有成百上千帧，见 [隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。
**工程中的样子**：[远程调试](/scenarios/mobile-remote) 里逐帧看手机与服务器的往来。

### SSE 分帧
> `text/event-stream` 按 `\n\n` 切帧而非整块缓冲。

**打个比方**：像听连载广播，主持人每说完一条就停一拍，你按「空两行」分出一条条新闻，不必等整场节目播完才整理。分隔符就是那道可识别的停顿。
**在 Whistle 里**：`lib/inspectors/data.js:14` 定 `SSE_SEP = Buffer.from('\n\n')`，`:98-135` 的 `parseFrame` 默认按它切帧；`:331-355` 的 `handleResBody` 检测 `content-type` 为 `text/event-stream` 时改走分帧，`:339-343` 还支持 `x-whistle-custom-frame-separator` 自定义分隔符。
**为什么这样设计**：SSE 是永不结束的长响应，若按「连接结束才采样」界面将永远空白；按分隔符逐条切，事件才能实时呈现，同时复用同一套 `framesCache` 上报。
**容易混淆**：SSE 分帧基于文本分隔符，WebSocket 分帧基于二进制帧头，两者不是一套机制，见 [隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。
**工程中的样子**：[抓包数据的采集与上报](/core/capture-data) 把 SSE 列为阈值之外的特例。

### WebSocket 帧解析 / ws-parser
> 把裸字节流翻译成带方向的 WebSocket 帧事件。

**打个比方**：像同声传译，把连续不断的声波按「一句话」切开并标出是谁说的；上层只需听懂每句，不必处理声波本身、也不必管它分了几段送达。
**在 Whistle 里**：`lib/socket-mgr.js:291-301` 的 `getReceiver` / `getSender` 调 `wsParser.getReceiver` / `getSender`；`:325` 起的 `handleWsSend` / `handleWsReceive` 再把帧送进 `frameCtx` 过滤。
**为什么这样设计**：帧有掩码、分片、控制帧等协议细节，交给专用解析器（`package.json:64` 的 `ws-parser`）能让上层只面对「一个完整帧」；`MAX_PAYLOAD`（`lib/socket-mgr.js:17`，1MB）与 `MAX_COMPOSE_FRAME_COUNT = 5`（`:15`）在此截断超长帧与限制分片拼接。
**容易混淆**：`ws-parser` 只适用于 WebSocket；裸 TCP 要插件声明 `x-whistle-frame-parser` 自行切帧，见 [隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。
**工程中的样子**：[远程调试](/scenarios/mobile-remote) 的 Frames 面板就是它的消费端。

### 帧脚本 frameScript
> 用 JS 按方向改写、丢弃或注入单帧。

**打个比方**：像给传送带装一个可编程分拣员，每件货经过时按脚本决定放行、换标签还是塞一件新品，且不必懂传送带怎么转、货物怎么打包。
**在 Whistle 里**：`lib/socket-mgr.js:657-665` 调 `rules.getFrameScriptCtx` 取上下文，`:303-323` 的 `execHandleFrame` 按方向选 `handleSendToServerFrame` / `handleSendToClientFrame`，把脚本返回的文本转回 Buffer 并更新长度；`:624` 还会打 `opts.frameScript = true` 标记。
**为什么这样设计**：让用户改一帧而不必理解 TCP 分片与 WebSocket 掩码；脚本跑在连接上下文里，方向由两个回调区分，避免同向回调里再注入造成递归。
**容易混淆**：帧脚本改的是帧，`rulesFile` / `reqScript` 改的是规则，见 [规则引擎](/modules/rules-engine)。
**工程中的样子**：[故障注入](/scenarios/fault-injection) 用 `wss://... frameScript://{test-frame.js}` 把帧内容替换掉。

### pause / ignore 状态机
> 暂停挂起帧等放行，忽略丢弃当前分块。

**打个比方**：像水闸的「憋住」与「放空」——暂停把水拦在闸前等指令，放空则把这一段直接排掉；两者都不拆水闸，随时能恢复通水。
**在 Whistle 里**：`lib/socket-mgr.js:55-95` 的 `getStatus` / `setConnStatus` / `initStatus` 实现 `PAUSE_STATUS = 1`、`IGNORE_STATUS = 2`；`enable://pauseReceive` 与 `enable://ignoreReceive`（`docs/docs/rules/enable.md:49-52`）在 `:86-97` 初始化状态。
**为什么这样设计**：帧调试需要「卡住看一眼再放行」与「丢弃干扰帧」两种可逆操作；做成状态机而非销毁连接，才能随时恢复而不丢整条会话，也便于 UI 用 `changeStatus`（`lib/socket-mgr.js:910`）远控。
**容易混淆**：pause ≠ abort；前者可恢复，`abort`（`lib/socket-mgr.js:859`）是销毁，见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[故障注入](/scenarios/fault-injection) 用 `enable://ignoreReceive` 屏蔽服务端推送。

### 心跳 PING / PONG
> 收到对端 ping 后按 22 秒续写控制帧，暂停或忽略期间靠它保活。

**打个比方**：像长电话里每隔一阵「喂，还在吗」，不传内容，只为确认线没断、也让中间设备别把空闲连接掐掉。它本身不产生业务记录。
**在 Whistle 里**：`lib/socket-mgr.js:8` 定 `INTERVAL = 22 * 1000`，`:11-12` 定 `PING` / `PONG` 两个 Buffer；`:366-375` 收到 ping 立即回一次并起定时器，`:496-505` 按 22 秒间隔续写；`clearTimer`（`:284-289`）只在既不暂停也不忽略时清掉定时器，所以正常有数据流动时心跳会停，被挂起的连接反而持续发控制帧。
**为什么这样设计**：被 pause 的连接不能因空闲被误判或断开；固定 22 秒是「够及时」与「不制造噪声」的折中。定时器只在收到对端 ping 时启动，且 `clearTimer`（`lib/socket-mgr.js:284-289`）只在既不暂停也不忽略时才清掉它——正常有数据流动时心跳停止，暂停/忽略状态下反而持续写控制帧保活，避免挂起的连接被中间设备掐断。
**容易混淆**：心跳是 WebSocket 控制帧，不是 HTTP 请求，也不产生抓包会话，见 [隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。
**工程中的样子**：[隧道、WebSocket 与帧拦截](/core/tunnel-websocket) 把 22 秒列为帧级资源边界之一。

### Composer 与 Replay
> 手工构造请求并回打自身代理，可连发多次。

**打个比方**：像把一封旧信照着抄一遍、改几个收件人再投进同一个邮筒，于是它照常盖戳、照常归档，只是内容由你重写，而不是绕开邮局直送。
**在 Whistle 里**：`lib/service/composer.js:345-513` 的 `handleRequest` 解析 URL、头与 body，`:519-524` 的 `setup` 把 `PROXY_OPTS` 设为 Whistle 自身 host 与 port，让重放请求重新走一遍规则链；`MAX_REQ_COUNT = 100`（`:19,118-120`）由 `getReqCount` 钳制次数。
**为什么这样设计**：回打自身代理而非直连目标，才能复用规则、证书与抓包；把重活放进 `lib/service/` 子进程，避免拖慢主代理。流式响应由 `lib/service/compose-data.js:3-4` 的 `LRU({ max: 120, maxAge: 60s })`、单 reqId 1280KB 承载。
**容易混淆**：重放 ≠ 重新抓包一份；它复用同一 `data` 引用并新增一条会话，见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[复现与重放](/scenarios/reproduce-replay) 用 `Ctrl+Shift+Enter` 设置重放次数。

### SAZ / HAR 与会话保存导入导出
> 把会话打包成通用格式，在工具间往返。

**打个比方**：像把一摞票据装进标准档案盒，别家工具也能开盒验票，不必只认自家抽屉。格式是约定，盒里的票据仍是同一批记录。
**在 Whistle 里**：`lib/service/service.js:96-115` 的 `saveSessions` 对 `JSON.stringify(sessions)` 做 `gzip` 后落盘；`lib/service/extract-saz.js:108-278` 用 `AdmZip` 解析 SAZ，`lib/service/generate-saz.js:105-181` 按 `fiddlerMeta` 模板生成。
**为什么这样设计**：SAZ 是 zip 加元数据、HAR / txt / json 是文本，解析重活统一收进 service 子进程（`/service/*` 路径），主链路不受影响；支持双向互操作，才能和 Fiddler、浏览器 DevTools 协作。
**容易混淆**：界面 Composer 历史（`MAX_HISTORY_LEN = 100`，`lib/service/composer.js:24`）与 Saved 会话是两套存储，见 [复现与重放](/scenarios/reproduce-replay)。
**工程中的样子**：[复现与重放](/scenarios/reproduce-replay) 用 `Ctrl+S / I / E` 走完保存、导入、导出。

### 短轮询上报
> 界面按 100 / 900ms 自适应拉 gzip JSON。

**打个比方**：像每隔一会儿去信箱看一眼，有信就勤快点、没信就懒一点，而不是让邮差守在门口实时喊。节奏由「上次有没有新东西」自己调节。
**在 Whistle 里**：`biz/webui/cgi-bin/get-data.js:28-60` 用 `util.sendGzip` 返回压缩 JSON 并调 `proxy.getData`；`htdocs/src/js/data-center.js:1157-1159` 按 `hasNewData ? 100 : 900` 毫秒决定下次轮询。

```js
// htdocs/src/js/data-center.js:1157-1159（节选）
cgi.getData(options, function (data) {
  var hasNewData = data && data.data && data.data.hasNew;
  setTimeout(load, hasNewData ? 100 : 900);
});
```

**为什么这样设计**：HTTP 短轮询穿透代理与管理端口最稳，gzip 压掉重复字段；自适应间隔让「有新数据」时近实时、「无数据」时不空转，代价是天然存在亚秒级延迟。
**容易混淆**：短轮询 ≠ WebSocket 推送；UI 到内核走的是标准 HTTP，见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[Web 管理界面](/modules/webui) 把 `get-data` 列为约定式 CGI 之一。

### 命中规则查询（Test Rules）
> 按 `testId` 回查某次请求命中了哪些规则。

**打个比方**：像给包裹贴一张「经过哪些分拣口」的回执，事后照单核对，而不是重新走一遍传送带去猜。回执是请求期算好、事后查的。
**在 Whistle 里**：`biz/webui/cgi-bin/get-matched-rules.js:6` 调 `lib/util/data-server.js:632` 的 `proxy.getTestItem(testId)`，返回 `realUrl` 与 `rules`；`lib/util/data-server.js:642` 的 `abortRequest(id)` 则负责按会话 id 中断。
**为什么这样设计**：规则可能来自规则集、模板、远程与插件，命中结果在请求期才算得出；用 `testId` 把「一次构造请求」与「它的命中详情」关联，避免按 URL 反推时受同名请求干扰。
**容易混淆**：`getTestItem` 走 `testId`，`getItem`（`:624`）走会话 id，两者不是同一入口，见 [规则引擎](/modules/rules-engine)。
**工程中的样子**：[复现与重放](/scenarios/reproduce-replay) 用 Test Rules 验证 Composer 请求命中哪几行。

### abort 中断
> 主动断开请求与帧连接，结束一条会话。

**打个比方**：像直接挂断电话，不像「暂停」那样还能接着说；线路拆掉、记录定格在中断那一刻，之后不再有帧进来。
**在 Whistle 里**：`data.abort()`（`lib/inspectors/data.js:174-183`）断请求，`lib/socket-mgr.js:859` 的 `exports.abort = destroy` 断帧连接；`biz/webui/cgi-bin/abort.js:18-19` 同时调二者，`lib/util/data-server.js:642` 的 `abortRequest(id)` 按 id 触发。
**为什么这样设计**：抓包记录要能标记「被中断」而非「正常结束」，因此中断必须同时作用于请求流与帧管道，并让 `reqEmitter` 抛 `abort` 事件收尾，界面才能显示正确终态。
**容易混淆**：abort ≠ pause；后者可逆、前者销毁，见 [概念辨析](/concepts/08-confusions)。
**工程中的样子**：[故障注入](/scenarios/fault-injection) 用 `Ctrl+A` 强制中断选中请求。

## 次要词条速览

下面这些名词在界面与 CGI 里高频出现，不必各占一张卡片，但同样要能一眼分清它落在哪、和谁容易混。表格的「源码落点」一律写主干文件与行号锚点，便于按图索骥。

::: cols 20|30|28|22
| 名词 | 一句话 | 源码落点 | 易混淆 |
|---|---|---|---|
| Network 面板 | 抓包列表与详情界面 | `network-modal.js:5` | 非服务端缓存 |
| get-data CGI | 主界面列表数据源 | `get-data.js:60` | 非 get-session |
| get-session CGI | 按 id 批量补详情 | `get-session.js` | 不返回分页 |
| get-frames CGI | 取某连接帧列表 | `get-frames.js` | 单次 16 帧 |
| getFramesForApi | 对外帧分页查询 | `data-server.js:650` | 单次上限 120 |
| getSessionsForApi | 对外会话分页查询 | `data-server.js:818` | 非 getData |
| compose-data | 取重放流式响应 | `compose-data.js:3` | 非抓包会话 |
| Composer 历史 | 构造请求的历史记录 | `composer.js:24` | 服务端上限 100 |
| Saved 面板 | 手动保存的会话集 | `service.js:96` | 不受缓存淘汰 |
| 自定义帧解析器 | 插件切 TCP 裸流帧 | `socket-mgr.js:768` | 非 ws-parser |
| base64 | body 转文本再下发 | `data-server.js:216` | 返回前才转换 |
| gzip 保存 | 会话压缩后落盘 | `service.js:103` | 与 gzip 上报异 |
| 游标 startId | 增量拉取起点 | `data-server.js:223` | 非会话 id |
| socketStatus | 帧连接暂停忽略态 | `data-server.js:998` | 非 HTTP 状态 |
| tunnelIps | 隧道真实目标 IP | `data-server.js:980` | 非客户端 IP |
| Maximum Rows | 界面最大显示行数 | `network-modal.js:5` | 默认 1500 条 |
:::

其中 `lib/util/data-server.js:10-34` 的一组常量是理解整张表的钥匙：默认缓存 600 条（`MAX_LENGTH`）、溢出 1800 条（`OVERFLOW_LENGTH`）、先砍到 1200 条（`MAX_CACHE_SIZE`）、尾部 360 条（`PRESERVE_LEN`）改用 `MAX_CACHE_TIME`(6 分钟) 宽限、单次上报 100 条（`COUNT`）、API 分页 120 条（`MAX_COUNT`）。`PRESERVE_LEN` 并非「只保留 360 条」，而是这批尾部条目享受更长超时，清理细节见 [运行时与内核骨架](/concepts/04-runtime) 的 `clearCache`。官方 CLI 的 `-R reqCacheSize` 默认 600、`-F frameCacheSize` 默认 512（`docs/docs/cli.md:47-48`），但源码 `:10-16` 强制下限 600，512 实际不会生效；前端 `htdocs/src/js/data-center.js:1157-1159` 的 100/900ms 是轮询间隔，服务端 `lib/service/data-center.js:8` 的 `MAX_COUNT = 100` 是保存会话列表上限，与 `COUNT` 是三个不同的 100。`Maximum Rows` 是界面显示上限（默认 1500），与服务端这 600 条完全是两回事，混为一谈就会误判「列表里还有、服务端却查不到」。

## 与工程实际结合

三条最常走的工作流，把上面的名词串成可复制的动作。

**其一，帧脚本改包**。[故障注入](/scenarios/fault-injection) 与 [远程调试](/scenarios/mobile-remote) 里，给某条 WebSocket 挂上帧脚本，逐帧替换或注入内容：

```txt
# 来源：docs/docs/rules/frameScript.md
wss://echo.websocket.org/ frameScript://{test-frame.js}
```

脚本内用 `ctx.handleSendToServerFrame` / `ctx.handleSendToClientFrame` 改写、`ctx.sendToClient` 主动注入（来源同上），对应 [隧道、WebSocket 与帧拦截](/core/tunnel-websocket) 的 `execHandleFrame`（`lib/socket-mgr.js:303-323`）。

**其二，屏蔽服务端推送**。[故障注入](/scenarios/fault-injection) 里让接收帧直接丢弃、便于复现客户端超时：

```txt
# 来源：docs/docs/rules/enable.md
wss://echo.websocket.org/ enable://ignoreReceive
```

它落在 `lib/socket-mgr.js:86-97` 的 `initStatus`，是 pause/ignore 状态机而非断开连接；若要彻底挂断，用的是 `Ctrl+A` 对应的 `abort`（`lib/socket-mgr.js:859`）。

**其三，保存 → 导入导出 → 重放**。[复现与重放](/scenarios/reproduce-replay) 把偶现请求固定成可重复输入：

```txt
# 来源：docs/docs/gui/shortcut.md
Ctrl+S 保存    Ctrl+I 导入    Ctrl+E 导出
Ctrl+A 强制中断    Ctrl+Shift+Enter 设置重放次数
```

保存走 `lib/service/service.js:96-115` 的 gzip 落盘，重放回打自身代理（`lib/service/composer.js:519-524`），命中详情用 Test Rules（`biz/webui/cgi-bin/get-matched-rules.js:6`）查询。整条链路的数据源与轮询见 [抓包数据的采集与上报](/core/capture-data)、[Web 管理界面](/modules/webui)；跨工具交换格式见 [复现与重放](/scenarios/reproduce-replay)。

## 常见误解

- **抓包 ≠ 阻断转发**。旁路采样（`lib/inspectors/data.js:279-323`）覆盖 `write` / `end` 后仍 `write.apply` 原样透传，抓包不改道、不加等待；真正断开是 `abort`（`lib/socket-mgr.js:859`）。见 [概念辨析](/concepts/08-confusions)。
- **超阈丢弃 body ≠ 丢弃整条记录**。`lib/inspectors/data.js:291-296` 只把 `reqBody` 置为 `false`，`headers`、`statusCode`、时间、`size` 照留；界面仍显示「有一个 20MB 响应」，只是 body 栏为空。
- **`get-data` ≠ `get-session`**。`biz/webui/cgi-bin/get-data.js:60` 调 `proxy.getData`（`lib/util/data-server.js:886`）拉主列表，`get-session` 是按 id 批量补详情，二者的分页、过滤与返回字段完全不同。
- **帧 ≠ HTTP 请求**。帧是长连接上的分片（`lib/socket-mgr.js:44-48`），一个会话可有成百上千帧；HTTP 会话是「一次请求-响应」，二者粒度不同，见 [隧道、WebSocket 与帧拦截](/core/tunnel-websocket)。
- **短轮询 ≠ WebSocket 推送**。UI 走 gzip 压缩的标准 HTTP（`biz/webui/cgi-bin/get-data.js:28-60`），前端按 `hasNewData ? 100 : 900` 毫秒自适应（`htdocs/src/js/data-center.js:1157-1159`），天然有亚秒级延迟。
- **pause ≠ abort**。`lib/socket-mgr.js:55-95` 的 pause/ignore 是可恢复状态机，帧被挂起等放行；`abort` 销毁连接（`lib/socket-mgr.js:859`），不可逆。见 [概念辨析](/concepts/08-confusions)。
- **Composer 重放 ≠ 重新抓包一份**。`lib/service/composer.js:519-524` 把构造请求回打自身代理，于是照常命中规则、照常新增一条抓包会话；要用 `fc:` 前缀才能把它从业务流量里隔离，见 [复现与重放](/scenarios/reproduce-replay)。
- **`getFrames` 的 16 帧 ≠ 全部历史帧**。`lib/util/data-server.js:354` 单次最多取 16 帧，靠 `lastFrameId` 游标翻页；帧缓存还会按 512/256/128/64KB 分级瘦身（`:129-145`），旧帧不再完整。

## 小结

- 抓包是旁路：`lib/inspectors/data.js:279-323` 覆盖 `write` / `end` 采样后原样透传，`proxy.emit('request', reqEmitter, data)` 登记会话。
- 阈值覆盖 360KB、1MB、2MB、16MB 与帧级 1MB；超阈把 `reqBody` 置 `false` 但保留元信息，SSE 按 `\n\n` 分帧。
- 缓存是自实现的有界结构，600 / 1800 / 1200 三层阈值与 360 条宽限窗口、单次 100 条共同限流，帧按 512/256/128/64KB 瘦身。
- `data` 对象原地更新、UI 读同一引用，换来零复制，也带来常驻内存与立即可见的风险。
- 上报是 gzip 短轮询（100 / 900ms）；帧、会话、注入帧、命中规则各有独立 CGI，重放回打自身代理而非直连目标。

## 下一步

[《第四层：规则 DSL 全景》](/concepts/06-rules)：数据面已经能采集、缓存、重放与回查，下一篇转向规则的「语言」本身——一行文本怎样被拆成 pattern、operation、lineProps 与过滤器，又怎样编译成分桶的 rule 对象。
