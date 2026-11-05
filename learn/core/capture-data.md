---
title: 抓包数据的采集与上报
description: 拆解旁路采样、大小阈值、有界缓存与 gzip 短轮询，说明数据对象原地更新的取舍。
---

前三篇把请求、隧道与帧都送到了内核，本篇回答「用户最终在界面上看到的那些数据从哪来」。关键结论有两个：采集是**旁路**的，覆盖流的 `write` / `end` 只做采样、不阻塞转发；上报是 **gzip 压缩的 HTTP JSON 短轮询**，不是 SSE 也不是 WebSocket。读完你能说清一个 body 为何会被丢弃、缓存如何瘦身，以及「UI 与内核读同一个对象」带来的便利与风险。

![抓包数据从采集到上报的通道](/diagrams/capture-data.svg)
*图注：inspectors 旁路采样后写入有界缓存，界面以 gzip 短轮询经 cgi-bin 拉取。*

## 采集是旁路：inspectors 顺序与事件

`lib/inspectors/index.js:1-8` 固定了 `rules → req → data → res` 的顺序，`data` 夹在「请求改写」与「响应改写」之间，正好能在两侧流被包装之后、真正出站之前挂上采样钩子。`lib/inspectors/data.js:542-551` 的中间件本体只做两件事：调用 `emitDataEvents(req, res, this)`，再按 `req.rules.reqDelay` 延时 `next()`。

采样的核心手法是覆盖流的写入方法，而不是让数据改走一条旁路管道。`lib/inspectors/data.js:279-323` 保存原始 `stream.write` / `stream.end`，换成先累加长度、拼接 Buffer、再 `write.apply(this, arguments)` 的包装；响应侧 `:364-409` 完全对称。因此每个数据块仍被立即转发给下游，抓包只是顺手记一份，链路上没有额外的等待点。

```js
// lib/inspectors/data.js:279-302（节选）
var write = stream.write;
var end = stream.end;
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

`lib/inspectors/data.js:55-185` 构造的 `data` 对象在 `:185` 以 `proxy.emit('request', reqEmitter, data)` 广播到事件总线；此前 `:59-61` 已用 `showPluginReq` 与 `isHide` 过滤掉不该记录的插件内部请求与隐藏请求。此后 `reqEmitter` 会在请求发出、响应到达、流结束或中断时分别抛出 `send`（`:430`）、`response`（`:439`）、`end`（`:405`）、`abort`（`:482`）四个事件。这里刻意分成两级：`proxy` 上的 `request` 只播一次用于登记会话，而 `reqEmitter` 是每条请求专属的发射器，负责后续状态迁移；否则所有监听者都要自己按 `reqId` 过滤，事件总线会被无关回调塞满。

`reqDelay` 在 `data.js:544-550` 生效，`resDelay` 则在 `lib/inspectors/res.js:1162-1173` 卡在回写之前，两者只影响时序、不影响采样结果。值得注意的是采样与规则改写共用同一份被 `PipeStream` 包装过的流：`data.js` 覆盖的是出站请求的 `write`，`res.js` 的 Transform 也在同一条链上，因此抓到的是改写后的字节，而非客户端原始报文——这与「界面所见即实际发出」的调试预期一致。

## 阈值表与超阈策略

抓包不可能无限制保存正文，一组常量划出了明确边界。

::: cols 34|18|48
| 常量 | 值 | 作用 |
|---|---|---|
| MAX_BODY_SIZE | 360KB | 默认 body 上限 |
| MAX_SIZE | 1MB | 非流式请求上限 |
| MAX_REQ_BODY_SIZE | 2MB | 流式请求体上限 |
| MAX_RES_BODY_SIZE | 2MB | 流式响应体上限 |
| BIG_DATA_SIZE | 16MB | bigData 模式上限 |
| MAX_PAYLOAD_SIZE | 256KB | 规则预读上限 |
| 帧 MAX_PAYLOAD | 1MB | 单帧截断 |
:::

```js
// lib/inspectors/data.js:7-14
var MAX_BODY_SIZE = 360 * 1024;
var MAX_SIZE = (config.strict ? 256 : 1024) * 1024;
var MAX_REQ_BODY_SIZE = (config.strict ? 256 : 2048) * 1024;
var MAX_RES_BODY_SIZE = (config.strict ? 256 : 2048) * 1024;
var BIG_DATA_SIZE = 1024 * 1024 * 16;
var LOCALHOST = '127.0.0.1';
var MAX_PAYLOAD = util.MAX_FRAME_PAYLOAD;
var SSE_SEP = Buffer.from('\n\n');
```

其中 `MAX_PAYLOAD_SIZE = 256KB` 来自 `lib/inspectors/rules.js:10`，用于规则预读；帧级 1MB 来自 `util.MAX_FRAME_PAYLOAD`（`lib/util/index.js:4012`），由 `lib/socket-mgr.js:219-221` 截断。超阈时的处理很克制：`data.js:291-296`、`:376-381` 直接把 `reqBody` / `resBody` 置为 `false`，放弃保存正文，但 `reqData.size`、`headers`、`statusCode`、时间字段等元信息照常保留。界面因此仍能看到「有一个 20MB 的响应」，只是 body 栏为空——这比让内存被大文件拖垮更划算。

还要注意这些值都随 `config.strict` 变化：严格模式下 `MAX_SIZE` 降到 256KB、两个 BODY 上限也降到 256KB，`checkBodySize`（`:37-45`）会二次裁剪超限 body。`unzipBody`（`:21-23`）先按 `content-encoding` 解压再采样，因此阈值约束的是明文长度而非压缩后的传输长度；`:305-320` 与 `:397-403` 在 `stream.end` 时统一做解压、`setUnzipSize` 与 `setRequestTime` / `setEndTime` 收尾，保证时间字段与正文长度一致。

SSE 是另一个特例。`data.js:98-135` 的 `parseFrame` 默认以 `\n\n`（`SSE_SEP`）切帧，`:331-355` 的 `handleResBody` 检测到 `content-type` 为 `text/event-stream` 时按帧解析而非整块缓冲，`:339-343` 还支持 `x-whistle-custom-frame-separator` 自定义分隔符。这样长连接上的事件流才能逐条呈现，而不必等到连接结束。

## 有界缓存：不是 LRU

`lib/util/data-server.js:87-95` 的 `enable()` 只监听 `request` 与 `frame` 两个事件，写入的是一套**自实现的有界缓存**，源码里没有 LRU 结构：`ids[]` 保存有序 id，`reqData{}` 按 id 存对象，`framesCache[]` 存帧。

```js
// lib/util/data-server.js:10-30（节选）
var CLEAR_INTERVAL = 6000;
var MAX_LENGTH = config.reqCacheSize;
var OVERFLOW_LENGTH = MAX_LENGTH * 3;
var PRESERVE_LEN = 360;
var COUNT = 100;
var ids = [];
var reqData = {};
var framesCache = [];
```

`reqCacheSize` 最小 600（`:10-12`），于是 600 条是常规水位、1800 条是溢出水位（`OVERFLOW_LENGTH`）、溢出后保留 360 条（`PRESERVE_LEN`），`proxy.getData` 单次最多返回 100 条（`COUNT`，`:904`）。`clearCache`（`:147-203`）每 `CLEAR_INTERVAL = 6000` 毫秒跑一次：按结束时间淘汰已完成会话，溢出时 `abort(true)` 并删除条目。

帧缓存另有瘦身策略。`:103-106` 定义 `MAX_BUF_LEN1..4` 为 512 / 256 / 128 / 64KB，`:129-145` 的 `clearFrames` 按帧龄分级，把旧帧的 `bin` 逐步截断；`:156-157` 在帧数溢出时直接 `splice(0, overflow + 60)`。也就是说大帧不会永久占着内存，越旧留存越少。

```js
// lib/util/data-server.js:342-345
function handleFrame(data) {
  framesCache.push(data);
  framesMap[data.reqId] = data;
}
```

## 上报通道：gzip 短轮询与原地更新

界面取数走的是标准 HTTP 请求。`biz/webui/cgi-bin/get-data.js:28-60` 用 `util.sendGzip(req, res, {...})` 返回 gzip 压缩的 JSON（底层是 `zlib.gzip`，`lib/util/common.js:1477`），其中 `:60` 调用 `proxy.getData(...)`。前端 `biz/webui/htdocs/src/js/data-center.js:1157-1159` 依据 `hasNew` 决定下一次轮询：有数据 100 毫秒、无数据 900 毫秒。

```js
// biz/webui/htdocs/src/js/data-center.js:1157-1159（节选）
cgi.getData(options, function (data) {
  var hasNewData = data && data.data && data.data.hasNew;
  setTimeout(load, hasNewData ? 100 : 900);
  // ... 后续更新界面
});
```

配套接口各司其职：`get-frames.js` 调 `proxy.getFrames(req.query)` 取帧并用 `socketMgr.exists` 判断连接是否仍活跃，`get-session.js` 按 id 列表批量 `proxy.getItem(id)` 补详情，`biz/webui/cgi-bin/socket/data.js` 用 `socketMgr.sendData(req.body)` 让 UI 反向注入帧。同一份 `get-data` 响应还捎带 `mrulesClientId` / `mrulesTime` 等修改戳（`get-data.js:41-44`），前端 `data-center.js:903` 的 `checkDataChanged` 据此决定是否重拉规则，这也是配置变更通知能搭上轮询便车的原因。`lib/util/perf.js` 另起一路，每 3 秒用 `procData` 统计请求数、QPS、内存与 CPU 并 `proxy.emit('perfDataChange', procData)`。中断能力由 `data.abort()`（`data.js:174-183`）与 `socketMgr.destroy()`（`lib/socket-mgr.js:849-857`）提供，`biz/webui/cgi-bin/abort.js:18-19` 同时调用二者，分别断开请求与帧连接。

最后强调最容易被忽略的设计取舍。`data-server.js:319-333` 的 `handleRequest` 把 `data` 对象**原地**写入 `reqData[id] = data`，随后 `:329-330` 直接给它补 `version` / `nodeVersion`；`getItem`（`:624-631`）与 `getList`（`:283-317`）也只在返回前就地 `toBase64String`。换言之，内核持续更新的对象与 UI 读到的是**同一个引用**，没有快照、没有逐次序列化拷贝。好处是零复制、增量字段天然可见；代价是这个对象在整个会话期常驻内存，任何字段膨胀都会直接抬高 RSS，且一处修改对所有消费者立即可见。理解这点，才能明白前面那些阈值与 `clearCache` 为什么不是可选优化，而是这套零复制模型的必要兜底。

## 小结

- 采集旁路于转发：`data.js:279-323` 覆盖 `write` / `end` 采样，`proxy.emit('request', reqEmitter, data)` 后由 `send` / `response` / `end` / `abort` 推进。
- 阈值覆盖 360KB、1MB、2MB、16MB、256KB 与 1MB 帧；超阈把 `reqBody` 置 `false`，保留元信息；SSE 按 `\n\n` 分帧。
- 缓存是自实现的有界结构（`ids[]` + `reqData{}` + `framesCache`），600 / 1800 / 360 与单次 100 条共同限流，帧按 512/256/128/64KB 瘦身。
- 上报是 gzip 压缩的 HTTP JSON 短轮询，有数据 100ms、无数据 900ms；帧、会话、注入帧各有独立 cgi 接口。
- `data` 对象原地更新、UI 读同一引用，换来零复制，也带来内存与可见性风险。

## 下一步

[《规则引擎：解析与匹配》](/modules/rules-engine)：核心链路到此闭环，下一篇进入第四层，看规则文本如何被解析并匹配到每一次请求。
