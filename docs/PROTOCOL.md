# 协议

webbridge 有三段协议：MCP stdio、daemon HTTP、扩展 WebSocket。MCP 层和扩展层都只使用
loopback；daemon 是唯一的中间人。

## 1. MCP stdio

标准 MCP JSON-RPC，一行一个消息，stdout 只用于协议，日志写 stderr。

- `initialize` → server info `webbridge`，版本见 `src/version.mjs`。
- `tools/list` → 默认 13 个核心工具；`WEBBRIDGE_TOOLSET=full` 时 40 个。
- `tools/call` → `{name, arguments}`。
- 工具结果以 `content` 数组返回；截图会附加 `{type:"image", data, mimeType}`。
- 工具错误以 `{content:[{type:"text", text}], isError:true}` 返回，便于模型自我纠正。

MCP server 不保存浏览器页面，只保存当前 session 名、工具档位、收藏 receiver 和 handoff 状态。

## 2. daemon HTTP

daemon 默认监听 `http://127.0.0.1:10086`。

### `GET /status`

返回 daemon 和扩展状态，例如：

```json
{
  "running": true,
  "extension_connected": true,
  "extension_id": "...",
  "extension_version": "2.1.1",
  "port": 10086,
  "version": "v2.0.36",
  "tab_id_arg": true,
  "uptime_seconds": 1383
}
```

`running:false` 或连接失败表示 daemon 未启动；`extension_connected:false` 表示扩展未连接。

### `POST /command`

请求：

```json
{
  "action": "navigate",
  "args": { "url": "https://example.com", "newTab": true },
  "session": "agent"
}
```

响应信封：

```json
{ "ok": true, "data": { "success": true, "tabId": 123, "url": "https://example.com" } }
```

或：

```json
{ "ok": false, "error": { "code": "extension_not_connected", "message": "..." } }
```

MCP 层把 `data` 原样返回；错误转成文本并附 `[code]`。

### 超时

MCP 层按工具定义设置 HTTP 超时。`navigate` 60 秒，`snapshot` 45 秒，`read_page` /
`read_article` 90 秒，`screenshot` 60 秒，`save_as_pdf` 90 秒，`request_human` 620 秒。
daemon 自身可能在没有扩展时保持命令约 34 秒，然后返回 `extension_not_connected`。

### 懒启动

MCP 层先 `GET /status`。连接失败时：

1. 获取 `~/.webbridge/daemon-start.lock`。
2. 执行 `WEBBRIDGE_BIN start`（分离进程）。
3. 轮询 `/status`，最多 30 秒。
4. 重试原始 `/command` 一次。

`start` 本身是幂等的；启动锁只减少并发冷启动时的重复 spawn。daemon 的端口绑定是最终单例
保证。

## 3. 扩展 WebSocket

扩展连接 `ws://127.0.0.1:10086/ws`，使用 JSON 文本帧；一个浏览器只维护一条控制连接。
URL 可带 `?client=<id>` 作为客户端标识。

### 为什么是 WebSocket

MV3 service worker 能直接使用的长连接只有 WebSocket。它在 loopback 上提供全双工、事件驱动的
消息：daemon 可以主动下发工具调用，扩展可以立即回传结果；帧头只有 2–14 字节，没有 HTTP 请求头，
也没有 SSE 需要的双通道和重连逻辑。

| 方案 | 问题 |
|---|---|
| HTTP 长轮询 | 每个方向都要请求/响应，空闲时仍反复建连；工具调用延迟更高 |
| SSE + POST | 事件流只能下行，上行还要逐条 POST；仍是两条通道 |
| WebTransport / HTTP/3 | 浏览器和 daemon 支持不统一，loopback 上没有收益 |
| Unix socket / 命名管道 | 浏览器 JS 不能直接访问 |
| 原生消息 | 需要额外 host 清单和进程，和共享 daemon 的生命周期不匹配 |

JSON 文本帧对 MCP 工具参数和结果足够直接。大结果（ARIA 快照、截图 base64）的瓶颈在内容本身，
不在帧格式；二进制编码或压缩需要 daemon 端配合，收益低于调整扩展的轮询和 payload 大小，暂不引入。

### 握手

扩展 → daemon：

```json
{ "type": "hello", "payload": { "extensionVersion": "2.1.1" } }
```

daemon 可能回 `hello_ack`；扩展当前忽略它的内容。

### 心跳

扩展通过 `chrome.alarms` 的 `webbridge-reconcile` 闹钟每 30 秒唤醒自己：链路在 45 秒内有流量时
发送 `{ "type": "ping" }`，daemon 回 `{ "type": "pong" }`；45 秒无流量则断开重连。这个 30 秒节奏
同时维持 MV3 worker 存活，是低延迟工具调用的前提；没有它，daemon 的工具调用在 worker 被挂起时
无法送达。daemon 也可以主动发 `ping`，扩展回 `pong`。

### 工具调用

daemon → 扩展：

```json
{
  "type": "tool_call",
  "requestId": "call-1",
  "payload": { "name": "snapshot", "args": {} }
}
```

扩展 → daemon：

```json
{
  "type": "tool_result",
  "responseToRequestId": "call-1",
  "payload": { "data": { "...": "..." } }
}
```

失败时：

```json
{
  "type": "tool_result",
  "responseToRequestId": "call-1",
  "payload": { "error": "element not found" }
}
```

`payload.error` 是字符串；daemon 负责把它映射成 HTTP 错误码。扩展按 `payload.name` 执行
CDP 或注入脚本；session、tabId、`_ownedTabIds` 和标签组上下文由 daemon 维护。

### 资源占用

- 控制连接：30 秒一次 ping（约 15 字节），用于保活和断线检测。
- 推送连接：只在 MCP server 运行期间存在；服务端每 20 秒发 WebSocket ping 帧。
- 人工接管回退：复用 `webbridge-reconcile` 闹钟，不再单独创建 30 秒闹钟。push 连接在线时每 5 分钟
  只做一次看门狗 `/handoff` GET；push 离线时才恢复 30 秒轮询。
- 大结果：ARIA 快照和截图是主要字节来源；协议层不做额外复制。压缩或二进制编码需要 daemon 支持，
  当前版本不启用。

## 4. 收藏接收器

MCP 进程在 `127.0.0.1:10087` 启动一个 loopback HTTP/WebSocket 服务，供扩展回传收藏和
人工接管状态。

| 路由 | 方法 | 用途 |
|---|---|---|
| `/health` | GET | 返回收藏目录 |
| `/activity` | GET | 最近工具调用记录 |
| `/handoff` | GET | 待处理的人工接管 |
| `/handoff/watch?wait_ms=` | GET | 长轮询，最长 30 秒 |
| `/handoff/:id/resume` | POST | 用户点击 Continue |
| `/capture` | POST | 扩展右键菜单/popup 收藏当前页 |
| `/ws` | WebSocket | handoff 即时推送 |

CORS 只回 `chrome-extension://`、`moz-extension://`、`safari-web-extension://` 来源；
`/ws` 拒绝网页 Origin。请求体上限 4 MB。

`/ws` 是扩展到 MCP server 的第二条 loopback WebSocket，用于人工接管推送：连接建立时服务端发
`{ "type": "hello", "pending": [...] }`，状态变化时发 `{ "type": "handoff", "pending": [...] }`。
服务端每 20 秒发 WebSocket ping 帧，浏览器自动回 pong。扩展优先使用这条连接；只有它不可用时，
才在 `webbridge-reconcile` 闹钟里轮询 `/handoff`。push 在线期间只保留 5 分钟一次的看门狗 GET。

## 5. 错误码

| code | 含义 |
|---|---|
| `daemon_unreachable` | 连不上 `/command`；会触发懒启动 |
| `daemon_missing` | 找不到 daemon 二进制 |
| `daemon_timeout` | 启动后 30 秒内未就绪 |
| `daemon_start_failed` | 自动启动失败 |
| `timeout` | daemon 在工具超时内没有返回 |
| `extension_not_connected` | daemon 在运行，但扩展未连接 |
| `element_not_found` | 选择器或 `@e` 引用失效 |
| `bad_response` | daemon 返回非 JSON 或异常信封 |

## 6. 版本

MCP server、扩展和 daemon 各自报版本。扩展与 daemon 版本不匹配时 `/status` 会带
`version_mismatch`；命令仍可能工作，但行为可能不一致。升级时同时更新两者。
