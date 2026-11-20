# Go MCP 前端：等效性与收益评估

状态：**可运行的原型，尚未替换默认发布入口。** Node 仍是工具定义的唯一来源、扩展构建链和
测试基线；Go 是 MCP 运行时与 daemon 生命周期管理的替代实现。

## 1. 拆分方式

```text
Agent / MCP client
      │  MCP stdio
      ▼
MCP front end        Node src/server.mjs  或  Go cmd/webbridge-mcp
      │  HTTP /command
      ▼
Browser Bridge daemon (upstream Go binary)
      │  WebSocket /ws
      ▼
MV3 extension + page scripts (JavaScript, 必须留在浏览器侧)
      │  CDP / chrome.scripting
      ▼
the user's actual page
```

浏览器侧必须保留 JavaScript：MV3 service worker、`chrome.*`、页面 DOM 和 CDP
`Runtime.evaluate` 都在浏览器运行时里执行。Go 可以生成和发送脚本，但不能替代页面执行环境。
扩展构建仍使用 Node 的 Babel/Terser/Playwright 工具链。

共享边界：

- `src/tools.mjs` / `src/catalog.mjs`：工具定义的唯一来源。
- `scripts/export-catalog.mjs`：生成 `internal/catalog/catalog.json`，Go 二进制 `embed` 它。
- `shared/page/*.fn.js`：页面脚本的单一副本；Node 通过包装模块读取，Go 通过 `embed` 注入。
- `~/.webbridge/leases/*.json`、`daemon-start.lock`、`daemon-autostart.json`：Node 和 Go
  使用相同格式，可以共享同一个 daemon。

## 2. 等效性验证

### 2.1 协议与工具面

`test/go-parity.mjs` 用一个假 daemon 同时启动 Node 和 Go MCP server，逐项比较：

- `initialize` / `tools/list` / `tools/call`。
- `core` 13 个工具和 `full` 40 个工具的完整定义（名称、描述、JSON Schema）。
- 工具参数校验、未知参数提示、未知工具提示、隐藏工具提示。
- `browser_tools` 概览、搜索、单工具描述。
- action 映射：`history`、`hover`、`highlight`、`select_option`、`scroll` 等。
- `read_article`、`extract`、`console`、`capture_page`、`batch`、`request_human`。
- 截图内联、错误文本、捕获 Markdown、`index.jsonl`、loopback 接收器、handoff 恢复。

结果：

```text
go-parity: core ok (13 tools, 24 calls)
go-parity: full ok (40 tools, 23 calls)
go-parity: ok
```

两个档位的工具定义逐字段一致；捕获 Markdown 除 `captured_at` 外逐字节一致。

### 2.2 真实浏览器

`test/live-parity.mjs` 在真实 Edge + 扩展上分别运行 Node 和 Go，比较：

`navigate`、`read_page`、`read_article`、`snapshot {format:"aria"}`、`extract`、
`evaluate`、`console`、`activate_tab`、`screenshot`、`capture_page`、`close_session`。

结果：

```text
live-parity: ok
```

`@e` / `eNNN` 引用编号会随页面和附加顺序变化，测试会归一化后再比较。截图像素尺寸和内容
可能随窗口状态变化，测试比较格式、MIME 与非零图像数据。

注意：Edge 窗口最小化或标签页处于 hidden 状态时，Node 和 Go 的 `screenshot` 都会在 60 秒
超时。先调用 `activate_tab {focus_window:true}` 后两者都在约 0.2 秒内返回。这是浏览器
surface 的限制，与 MCP 语言无关。

### 2.3 共享 daemon

`test/live-shared.mjs` 验证迁移期混合运行：

1. Node MCP 客户端首次调用懒启动 daemon，并写入租约和所有权标记。
2. Go MCP 客户端加入，读同一个 tab，确认 `status.running = true`。
3. Node 客户端退出，Go 租约仍存在，daemon 保持运行。
4. Go 客户端退出，最后一个租约释放，daemon 停止。

结果：

```text
live-shared: ok
```

## 3. 性能对比

测试环境：Windows 11，Go 1.25.0，Node.js 24.22.2，Edge；同机、同一个假 daemon；6 次冷启动，
60 次 `evaluate` 转发调用。数字为 p50；调用 p95 在括号中。

| 指标 | Node | Go | 变化 |
|---|---:|---:|---:|
| MCP 连接完成 | 469 ms | 44 ms | -90.6% |
| `tools/list`（40 工具） | 3.8 ms | 1.6 ms | -57.2% |
| 单次转发调用 p50 | 2.30 ms | 1.26 ms | -45.5% |
| 单次转发调用 p95 | 3.51 ms | 1.87 ms | -46.7% |
| 空闲 RSS | 72.3 MB | 13.8 MB | -81.0% |
| 60 次调用后 RSS | 77.7 MB | 17.0 MB | -78.1% |
| `tools/list` 载荷 | 20 KB | 20 KB | 相同 |
| 分发体积 | Node 运行时 + 95 个生产 npm 包 + 4.5 MB SDK | 8.8 MB 单文件（`-s -w`） | 单文件 |

这些数字只覆盖 MCP 进程和本地 HTTP 转发。真实浏览器动作仍由页面加载、CDP、扩展附加和
标签组管理决定，通常以百毫秒到秒计；Go 在这里节省的是固定开销，不是 `navigate` 的主体
耗时。

复现：

```bash
npm run go:build
node test/go-parity.mjs
node test/bench-go.mjs
node test/live-parity.mjs      # 需要 Edge + 扩展
node test/live-shared.mjs      # 需要 Edge + 扩展；npm run test:shared
```

发布包包含 `test/go-parity.mjs` 和 `test/bench-go.mjs`；`test/live-*.mjs` 需要开发依赖和
真实浏览器，保留在源码仓库。

## 4. 收益

- **冷启动**：MCP 客户端从近半秒降到几十毫秒。对每次任务都新建 MCP 进程的客户端最明显。
- **内存**：空闲进程从约 72 MB 降到约 14 MB。多个 Agent 各自持有 MCP 进程时收益线性放大。
- **分发**：单文件二进制，不需要 `npm ci`、Node 运行时或 95 个生产 npm 包。扩展构建仍需要
  Node，但终端用户的 MCP 运行可以只拿一个文件。
- **进程管理**：Go 的 detached spawn、文件锁、PID 租约和 HTTP 超时控制更直接；与 Node 共享
  状态文件，迁移期可以混跑。
- **调用开销**：本地转发路径减少约一半，但浏览器动作占主导，用户通常感知不到。

## 5. 成本与风险

- **双实现漂移**：工具定义、action 映射、错误文本和捕获格式有两份代码。当前用生成 catalog
  和共享页面脚本收敛，仍需要把 `test/go-parity.mjs` 放进 CI。
- **页面脚本仍是 JavaScript**：扩展和 reader/extract/console/capture 不能 Go 化；Go 只负责
  传输和编排。
- **发布链路**：要正式发布 Go 入口，需要跨平台构建（Windows/macOS/Linux）、校验和、签名或
  GitHub Release 资产，以及 MCP 客户端配置文档。当前只提供源码构建。
- **MCP Go SDK**：`github.com/modelcontextprotocol/go-sdk` 的版本升级节奏与 Node SDK 不同，
  需要用 parity 测试锁住行为。
- **daemon 兼容性**：daemon 是上游二进制，`/status`、`/command`、PID 文件和标签组语义变化
  会同时影响两个前端。
- **未覆盖项**：真实浏览器上的 `network`、`save_as_pdf`、`upload`、`drag`、`highlight` 和
  完整 `request_human` 交互尚未纳入 live parity；假 daemon 覆盖了转发和错误路径，真实设备
  测试仍应补上。

## 6. 建议

先把 Go 作为**可选的高性能入口**发布，保留 Node 作为默认和回退路径：

1. 把 `test/go-parity.mjs` 加入 CI，工具定义变更必须同时更新 catalog。
2. 增加跨平台 Release 构建，二进制命名与 `WEBBRIDGE_BIN` 查找规则一致。
3. 在 README/INSTALL 中并列给出 Node 和 Go 两种 MCP 配置。
4. 观察一个版本周期后，再把 Go 设为默认入口；Node 继续负责扩展构建、测试和脚本维护。

当目标是“单个可执行文件、低内存、快速冷启动”时，Go 值得移植；当目标是“扩展构建和页面
脚本开发”时，Node 仍然是合适的工作环境。
