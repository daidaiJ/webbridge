# webbridge

[English](README.EN.md) | 简体中文

把用户**正在使用的真实浏览器**接给任意 MCP Agent：真实标签页、真实登录态、真实扩展和窗口。
没有 headless 浏览器，没有独立 profile，也不抓取网页副本。所有流量留在 `127.0.0.1`。

```text
Agent / MCP client
      │  MCP (stdio)
      ▼
webbridge MCP server (Node default; Go optional, this repo)
      │  HTTP  POST http://127.0.0.1:10086/command
      ▼
Browser Bridge daemon (upstream binary, Go)
      │  WebSocket  ws://127.0.0.1:10086/ws
      ▼
Browser Bridge extension (MV3, this repo's build)
      │  chrome.debugger / CDP + on-demand scripting
      ▼
the user's actual page
```

## 为什么

- **真实页面**：需要登录、验证码、SSO、企业内网或浏览器扩展的页面，直接操作用户当前浏览器。
- **Agent 友好的工具面**：默认 13 个核心工具按 `status → session → navigate → snapshot →
  click/fill → wait → verify → close_session` 排列；其余工具按需发现。
- **省上下文**：核心档位约 6.2k 字符的工具定义；完整档位列出 40 个工具。
- **干净正文**：`read_article` 在页面内做 reader-mode 抽取，返回 Markdown，不依赖网络服务。
- **懒启动、单例**：首次工具调用才拉起 daemon；多个 MCP 客户端共享一个实例；最后一个客户端
  退出或空闲后回收。
- **可回放**：页面快照、结构化抽取、网络、控制台、截图、PDF、页面收藏和人工接管都在同一套
  工具里。

## 工具面

共 40 个浏览器工具。

默认 `core` 档位列出 13 个：

| 阶段 | 工具 |
|---|---|
| 准备 | `status`, `start`, `session` |
| 打开与观察 | `navigate`, `snapshot`, `read_page`, `screenshot` |
| 交互与验证 | `click`, `fill`, `wait` |
| 收尾 | `close_session` |
| 按需目录 | `browser_tools`, `browser_call` |

其余 29 个工具按 7 组收纳：`tabs`、`read`、`interact`、`output`、`history`、`script`、
`flow`。使用方式：

1. `browser_tools`：返回工作流和分组。
2. `browser_tools {query:"table"}`：搜索工具，返回一行签名。
3. `browser_tools {tool:"extract"}`：返回完整参数和示例。
4. `browser_call {tool:"extract", args:{selector:"#rows tr"}}`：执行。

`WEBBRIDGE_TOOLSET=full` 会直接列出 40 个工具，适合依赖逐工具权限或偏好强类型工具面的
客户端。完整清单见 [docs/TOOLS.md](docs/TOOLS.md)。

### 常用长尾工具

| 工具 | 用途 |
|---|---|
| `read_article` | Reader mode：去掉导航、侧栏、评论和广告，返回干净 Markdown |
| `extract` | 用 CSS 选择器抽取重复行/卡片，返回 JSON |
| `capture_page` | 把当前页保存为带 frontmatter 的 Markdown 和索引 |
| `network` | 抓请求、查详情；`stop` 前读 body |
| `console` | 收集日志、未捕获错误和 unhandled rejection |
| `batch` | 一次往返最多 40 步，适合 `fill → click → wait` |
| `request_human` | 登录、2FA、验证码、授权确认时把控制权交给人 |
| `attach_tab` | 借用用户已有标签页，`close_session` 时保留 |
| `highlight` | 在页面上框出目标控件，配合人工接管 |

## 快速开始

### 1. 安装 daemon

daemon 是上游的 Browser Bridge 二进制，负责 HTTP `/command`、WebSocket 和标签组语义。
从 [Browser Bridge 产品页](https://www.kimi.com/products/kimi-webbridge) 下载对应平台的文件，
放到：

```text
Windows: %USERPROFILE%\.kimi-webbridge\bin\kimi-webbridge.exe
macOS/Linux: ~/.kimi-webbridge/bin/kimi-webbridge
```

也可以设置 `WEBBRIDGE_BIN` 指向已有二进制。macOS/Linux 需要 `chmod +x`。

### 2. 加载扩展

发布包里的 `extension/` 是已经构建好的 MV3 扩展：

1. Edge/Chrome 打开 `edge://extensions` 或 `chrome://extensions`。
2. 打开开发者模式。
3. “Load unpacked” 选择解压后的 `extension/` 目录。
4. 确认扩展已连接：`node src/cli.mjs status`，或让 Agent 调 `status`。

扩展只连接 `ws://127.0.0.1:10086/ws`，不需要账号。

### 3. 配置 MCP 客户端

通用 stdio 配置：

```json
{
  "mcpServers": {
    "webbridge": {
      "command": "node",
      "args": ["/absolute/path/to/webbridge/src/server.mjs"],
      "env": {
        "WEBBRIDGE_SESSION": "agent",
        "WEBBRIDGE_TOOLSET": "core"
      }
    }
  }
}
```

各客户端的完整写法见 [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)，包括 DeepSeek Harness
（`dsh`）、WorkBuddy / CodeBuddy、Claude Code、Cursor、Claude Desktop、Codex 和通用 stdio。

### 4. 安装 skill（可选）

`skill/SKILL.md` 教 Agent 使用工作流、会话、标签接管、性能取舍和人工接管。复制到客户端读取的
skill 目录即可；发布包的根目录也放了一份 `SKILL.md`。

## 懒启动与单例

daemon 不会常驻。第一次浏览器工具调用会：

1. 探测 `127.0.0.1:10086/status`。
2. 如果没有响应，在后台执行 `webbridge start`。
3. 等待 daemon 就绪，然后重试原工具调用。

多个 MCP 客户端同时冷启动时，`~/.webbridge/daemon-start.lock` 只允许一个进程拉起 daemon；
每个客户端在 `~/.webbridge/leases/` 放一个 PID 租约。最后一个租约释放，或 15 分钟没有工具
调用时，由管理该 daemon 的客户端执行 `stop`。下一次调用会重新懒启动。

相关环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEBBRIDGE_AUTOSTART` | `1` | 设为 `0` 后必须显式 `start` |
| `WEBBRIDGE_IDLE_MS` | `900000` | 空闲回收时间；`0` 关闭空闲回收 |
| `WEBBRIDGE_STATE_DIR` | `~/.webbridge` | 启动锁、租约和所有权标记的目录 |
| `WEBBRIDGE_BIN` | `~/.kimi-webbridge/bin/kimi-webbridge[.exe]` | daemon 二进制路径 |
| `WEBBRIDGE_URL` | `http://127.0.0.1:10086` | daemon 地址 |
| `WEBBRIDGE_SESSION` | `grok` | 默认任务名/标签组 |
| `WEBBRIDGE_GROUP_TITLE` | 空 | 默认可见标签组名 |
| `WEBBRIDGE_TOOLSET` | `core` | `core` 或 `full` |
| `WEBBRIDGE_CAPTURE_DIR` | `~/.webbridge/captures` | 页面收藏目录 |
| `WEBBRIDGE_CAPTURE_PORT` | `10087` | 扩展回传收藏的 loopback 端口 |

显式管理：

```bash
node src/cli.mjs status
node src/cli.mjs start      # 手动启动，不参与空闲回收
node src/cli.mjs stop       # 强制停止
node src/cli.mjs call read_page '{}' --session demo
```

## 性能

2026-11-20 在真实 Edge 上测得的端到端延迟（毫秒）和输出大小。页面加载和网络条件会显著影响
`navigate`。

| 场景 | 延迟 | 输出 |
|---|---:|---:|
| `status` | 26 ms | 0.5 KB |
| `navigate` Bing | 3,984 ms | — |
| `snapshot` Bing JSON | 128 ms | 31.9 KB |
| `snapshot` Bing ARIA 8k | 50 ms | 7.9 KB |
| `extract` Bing 10 条 | 13 ms | 5.4 KB |
| `read_page` Bing 20k | 1,340 ms | 3.3 KB |
| `read_article` 博客文章 | 14 ms | 10.4 KB |
| `read_article` Wikipedia | 19 ms | 10.6 KB |
| `navigate` Wikipedia | 7,412 ms | — |
| `snapshot` Wikipedia JSON | 326 ms | 139.2 KB |
| `snapshot` Wikipedia ARIA 8k | 290 ms | 8.8 KB |
| `read_page` Wikipedia 20k | 677 ms | 20.1 KB |
| `read_page` Wikipedia 120k | 4,680 ms | 20.2 KB |
| `screenshot` PNG | 1,115–2,285 ms | 69–110 KB |
| `save_as_pdf` | 9,164 ms | 路径 |

结论：

- `snapshot` 的 JSON 是最大的上下文热点；优先用 `format:"aria"` 加 `max_chars`，或
  `snapshot(ref)` 缩小范围。
- `read_article` 比 `read_page` 快约 50–300 倍，且不含导航和侧栏；读文章优先用它。
- `read_page` 的 `max_chars` 接近实际需要即可；把上限从 20k 提到 120k 可能多花数秒却只多
  几百字符。用 `start` 续读。
- `navigate` 主要受页面加载限制；能复用标签页时不要重复导航。
- `extract`、`capture_page`、`console`、`network` 是低成本路径。
- `screenshot` 和 `save_as_pdf` 是昂贵的输出路径；截图尽量选元素或 JPEG。

更完整的测试方法和数据见 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)。

## Go MCP 前端（可选）

MCP 运行时有一份功能等效的 Go 实现：`cmd/webbridge-mcp`。它直接读 daemon 的
`/status`、`/command`，与 Node 版本共享工具目录、页面脚本和 `~/.webbridge` 生命周期文件；
扩展和页面脚本仍保持 JavaScript。

在同一台 Windows 机器、同一个假 daemon 上测得的固定开销：

| 指标 | Node | Go |
|---|---:|---:|
| MCP 连接完成 | 469 ms | 44 ms |
| 单次转发调用 p50 | 2.30 ms | 1.26 ms |
| 空闲 RSS | 72 MB | 14 MB |
| 分发 | Node + 95 个生产 npm 包 | 8.8 MB 单文件 |

真实浏览器动作仍受页面加载和 CDP 限制，Go 主要降低进程启动、内存和本地转发开销。构建与
验证：

```bash
npm run go:build          # dist/webbridge-mcp[.exe]，-s -w
npm run go:test           # catalog、lifecycle、handoff、capture
npm run test:go           # Node/Go 假 daemon 逐项对比
npm run test:parity:live  # 真实 Edge + 扩展
npm run bench:go          # 冷启动、调用延迟、RSS
```

完整等效性矩阵、风险和建议见 [docs/GO.md](docs/GO.md)。当前发布包仍以 Node 为默认入口；
Go 二进制从源码构建。

## 安全边界

- daemon 和收藏接收器只绑定 `127.0.0.1`；不要把 daemon 改成 `0.0.0.0`。
- `/command` 等价于本地浏览器权限：任何能访问 `127.0.0.1:10086` 的本地进程都能驱动浏览器。
  需要更强隔离时，在前面加 token 代理。
- 收藏接收器的 CORS 只回扩展来源；`/ws` 拒绝网页 Origin，网页读不到 handoff 内容。
- 扩展没有静态 content script；页面操作按需 `chrome.scripting.executeScript`。
- 截图超过 6 MiB 只返回路径，不内联进上下文。
- 支付确认留给真人；Agent 停在下单页。

## 仓库结构

```text
src/server.mjs          MCP stdio server
src/tools.mjs           工具 schema、核心工具和分组
src/catalog.mjs         按需目录、签名、搜索、参数校验
src/actions.mjs         工具到 daemon action 的映射
src/daemon.mjs          HTTP 客户端、懒启动、单例、空闲回收
src/lifecycle.mjs       跨进程启动锁、租约、所有权标记
src/reader.mjs          read_article：页面内 reader-mode 抽取
src/capture.mjs         页面收藏 + loopback 接收器
src/handoff.mjs         request_human 的状态和长轮询
shared/page/            注入页面的自包含脚本（reader/extract/console/capture）
cmd/webbridge-mcp/      Go MCP 入口（可选）
internal/               Go catalog、daemon 生命周期、capture、handoff、app
scripts/export-catalog.mjs  Node 工具定义导出为 Go catalog
scripts/build-slim.mjs  从 vendor bundle 构建 extension/
scripts/package-release.mjs  生成发布 zip
skill/SKILL.md          Agent 使用规范
docs/                   集成、工具、协议、性能、Go 评估文档
test/                   无浏览器测试、Node/Go 对比和真实 Edge E2E
```

## 构建与测试

要求 Node.js 22+。

```bash
npm ci
npm test                       # catalog, smoke, tools, capture, lifecycle
npm run go:test                # Go catalog、lifecycle、handoff、capture
npm run test:go                # Node/Go MCP 功能对比（假 daemon）
npm run build:slim             # 构建 extension/
npm run package:extension      # dist/browser-bridge-<version>.zip
npm run package:release        # 发布包 dist/webbridge-<version>.zip
npm run test:e2e               # 真实 Edge + 扩展（需要先退出已连接的浏览器）
npm run test:e2e:pdf
npm run test:parity:live       # 真实 Edge 上的 Node/Go 对比
npm run test:shared            # Node/Go 共享一个 daemon 的生命周期
npm run bench:go               # Go/Node 启动、调用、内存基准
```

`npm test` 不需要浏览器。E2E 会启动独立的 Edge profile，并拒绝在已有浏览器连接 daemon 时
运行，避免抢占用户的标签页。

## 发布包

`dist/webbridge-<version>.zip` 解压后：

```text
webbridge-<version>/
  SKILL.md
  README.md
  README.EN.md
  INSTALL.md
  NOTICE.md
  DESIGN.md
  LICENSE
  package.json
  package-lock.json
  go.mod
  go.sum
  skill/
  src/
  shared/
  cmd/              # 可选 Go MCP 入口
  internal/         # Go catalog、daemon 生命周期和本地工具
  scripts/          # Go catalog 导出与构建脚本
  test/             # Go 等效性测试与基准
  docs/
  extension/        # 可直接 Load unpacked
```

使用发布包时，先在解压目录执行 `npm ci --omit=dev` 安装 MCP server 的生产依赖；需要 Go
入口时再执行 `npm run go:build`。发布包不包含本地 profiling 构建、`extension-slim/` 的调试
补丁或浏览器 E2E 临时产物。

## 已知限制

- 一个 daemon 同时只接一个浏览器连接；Chrome 和 Edge 同时装扩展会互相抢连接。
- 扩展的浏览器执行层来自上游 Browser Bridge 组件；升级扩展可能需要重新检查
  `scripts/build-slim.mjs` 的锚点。构建会在锚点变化时明确失败。
- 默认 `core` 档位通过 `browser_call` 收敛长尾工具；需要逐工具权限时用
  `WEBBRIDGE_TOOLSET=full`。
- 人工接管的即时推送依赖 MCP 进程内的 loopback WebSocket；socket 断开时扩展复用
  `webbridge-reconcile` 的 30 秒 alarm 轮询兜底，socket 在线时只做 5 分钟看门狗。
- 页面加载没有完成时调用 `snapshot` 可能超时；先 `wait` 一个选择器，或用
  `format:"aria"` 加 `max_chars`。
- 上游 daemon 可能发送使用遥测（OS、架构、版本、session 名、工具名）；本仓库的扩展构建
  移除了扩展侧遥测，daemon 侧不在本仓库控制范围内。
- Go 前端是可选原型；发布包默认仍用 Node 入口。`network`、PDF、上传、拖拽和完整人工接管
  的 live parity 尚未覆盖。

## 设计来源与许可

浏览器执行层和 daemon 协议来自上游 Browser Bridge 组件；本仓库提供 MCP 工具面、扩展瘦身
构建、reader mode、收藏/接管/批处理、懒启动生命周期和文档。产品交互参考了 Tabbit CLI 的
“任务 = session = 可见标签组”、已有标签接管、人工接管和 daemon 生命周期思路；接口层按 MCP
Agent 的工作流重新设计。

本仓库代码以 MIT 许可发布，见 [LICENSE](LICENSE)。发布包中的扩展构建涉及上游组件，使用前
请阅读 [NOTICE.md](NOTICE.md)。
