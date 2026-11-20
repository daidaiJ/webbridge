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
  "extension_version": "2.1.0",
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

扩展连接 `ws://127.0.0.1:10086/ws`，消息是 JSON 文本帧。

### 握手

扩展 → daemon：

```json
{ "type": "hello", "version": "2.1.0", "extensionId": "..." }
```

daemon → 扩展：

```json
{ "type": "hello_ack", "session": "daemon" }
```

### 心跳

任一侧可发 `{ "type": "ping" }`，对端回 `{ "type": "pong" }`。扩展 worker 被唤醒后重连；
没有连接时 daemon 最多等约 34 秒。

### 工具调用

daemon → 扩展：

```json
{
  "type": "tool_call",
  "id": "call-1",
  "action": "snapshot",
  "args": {},
  "session": "agent"
}
```

扩展 → daemon：

```json
{
  "type": "tool_result",
  "id": "call-1",
  "ok": true,
  "data": { "...": "..." }
}
```

或：

```json
{
  "type": "tool_result",
  "id": "call-1",
  "ok": false,
  "error": { "code": "element_not_found", "message": "..." }
}
```

daemon 负责 session、tabId、`_ownedTabIds` 和标签组上下文；扩展按 action 执行 CDP 或注入
脚本。

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
