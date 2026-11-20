# webbridge 设计说明

本文说明 webbridge 的产品边界、架构、工具面、生命周期、性能和扩展构建。安装见
`INSTALL.md`，Agent 操作规范见 `skill/SKILL.md`。

## 1. 定位

webbridge 是一个本地 MCP server，把用户正在使用的真实浏览器变成 Agent 的工具层。它不启动
新的浏览器进程，不复制用户 profile，也不把页面抓成离线副本。页面就是用户看到的页面。

运行时由四层组成：

- **MCP server**（本仓库，Node 默认；Go 可选）：工具 schema、目录、参数校验、action 映射、
  本地 reader/capture/console/handoff/batch，以及 daemon 生命周期。两种实现共享
  `~/.webbridge` 状态文件，可同时连接同一个 daemon。
- **daemon**（上游 Browser Bridge 二进制，Go）：把 HTTP `/command` 转成扩展的 WebSocket
  `tool_call`，注入 session/tab 上下文，维护“任务 = session = 标签组”的语义。
- **扩展**（本仓库构建的 MV3 包）：在浏览器内执行 CDP 和按需注入脚本。
- **用户浏览器**：真实标签页、登录态、扩展和窗口。

daemon 和收藏接收器只绑定 `127.0.0.1`。

## 2. 设计来源

产品交互参考 Tabbit CLI 的以下思路：

- 任务 = session = 可见标签组。
- 认领用户已有标签页，任务结束时保留 borrowed 标签。
- 人工接管和任务收尾是显式步骤。
- daemon 生命周期由客户端管理，而不是让用户手动维护。

接口层按 MCP Agent 的工作流重新组织：首屏是 13 个核心工具，长尾按组渐进披露。浏览器执行层
和 daemon 协议复用上游 Browser Bridge 组件；本仓库不重新实现 CDP 或标签组。

## 3. 架构

```text
Agent / MCP client
      │  MCP stdio
      ▼
webbridge MCP server
      ├─ Node: src/server.mjs / tools.mjs / catalog.mjs / actions.mjs
      ├─ Go: cmd/webbridge-mcp + internal/catalog, daemon, app
      ├─ daemon.mjs / lifecycle.mjs（Go 侧为 internal/daemon）
      ├─ reader.mjs / capture.mjs / console.mjs / handoff.mjs
      └─ loopback capture receiver (HTTP + WebSocket)
      │  HTTP /command
      ▼
Browser Bridge daemon
      │  WebSocket /ws
      ▼
MV3 extension
      │  chrome.debugger + chrome.scripting
      ▼
real page
```

MCP 层保持薄：动作语义、标签和会话由 daemon 注入，浏览器执行由扩展负责。适配层只做模型需要
的参数整理、结果整形和本地能力。

## 4. 工具面

40 个浏览器工具。默认 `core` 档位列出 13 个：

- 准备：`status`、`start`、`session`。
- 打开与观察：`navigate`、`snapshot`、`read_page`、`screenshot`。
- 交互与验证：`click`、`fill`、`wait`。
- 收尾：`close_session`。
- 目录：`browser_tools`、`browser_call`。

其余 29 个工具分 7 组：`tabs`、`read`、`interact`、`output`、`history`、`script`、`flow`。
`browser_tools` 无参数返回工作流和分组；`{query}` 搜索；`{tool}` 返回完整参数和示例；
`browser_call` 执行。`WEBBRIDGE_TOOLSET=full` 直接列出 40 个。

设计原则：

1. **核心路径不用查目录。** 第一次使用的 Agent 能独立串起
   `status → session → navigate → snapshot → click/fill → wait → verify → close_session`。
2. **一个意图一个核心工具。** `snapshot` 看结构，`read_page` 看文本，`screenshot` 看外观；
   `click` 是合成点击，`fill` 是设值；升级路径放在长尾。
3. **描述写下一步。** 每个核心工具说明接下来该做什么，减少第一次使用的试错。
4. **错误可纠正。** 未知工具给最近名字，未知参数给拼写建议，缺参数指出具体字段并指向
   `browser_tools {tool}`；这些检查在 daemon 往返前完成。
5. **长尾按需付费。** 详细 schema 只在目录调用时进入上下文。
6. **完整档位保留。** 依赖逐工具权限或强类型工具面的客户端可以直接列 40 个。

## 5. 会话与标签

- `session {name}` 设置后续调用的任务名，默认来自 `WEBBRIDGE_SESSION`。
- 首次 `navigate` 可传 `group_title`，同 session 的页面进入同一可见组。
- `attach_tab` 认领用户已有标签页为 borrowed：不抢焦点，`close_session` 时保留。
- `find_tab` 按 host 选回本任务页面；`active:true` 借用用户当前页。
- `close_session` 只关闭本任务打开的页面。

## 6. Reader mode

`read_article` 在页面内执行一次自包含脚本：

1. 复制 DOM，移除 script/style/nav/aside/footer/header 等。
2. 按 class/id 的正负权重移除评论、侧栏、分享、推荐、引用列表等 boilerplate。
3. 对段落/容器打分，选择正文容器，并保留强相关兄弟节点。
4. 列表页（多个小 `<article>` 且没有长段落）输出卡片摘要。
5. 输出 Markdown，带 `url`、`title`、`byline`、`published`、`chars`、`truncated`、
   `score`、`candidates`，列表页带 `listing:true`。

脚本放在 `shared/page/reader.js`，由 Node 和后续 Go 版本共用；不需要网络，也不改变页面。

## 7. 收藏、控制台与人工接管

- `capture_page`：一次 DOM 遍历，写 `<YYYYMMDD-HHmmss>-<slug>.md` 和 `index.jsonl`；
  frontmatter 含 url、canonical、title、captured_at、lang、description、selection、tags、
  source；截图默认关闭。
- 扩展右键菜单和 popup 通过 `127.0.0.1:10087/capture` 回传同一份 Markdown；receiver 不在时
  回退浏览器下载目录。
- `console`：按需注入 hook，上限 200 条；收集 log/info/warn/error/debug、未捕获错误和
  unhandled rejection。
- `request_human`：登记 handoff，扩展通过 loopback WebSocket 立即弹窗；用户点 Continue 后
  返回。socket 断开时复用 `webbridge-reconcile` 的 30 秒 alarm 轮询 `/handoff` 兜底；socket
  在线时只保留 5 分钟一次的看门狗 GET。支付确认留给真人。

## 8. 懒启动、单例与回收

这是运行时的关键边界：

1. 第一次浏览器工具调用先 `GET /status`。
2. 连接失败时拿 `~/.webbridge/daemon-start.lock`，执行 `WEBBRIDGE_BIN start`，轮询
   `/status`，然后重试原调用一次。
3. 每个 MCP 客户端在 `~/.webbridge/leases/` 写 PID 租约；租约由进程存活判断，带 60 秒心跳。
4. 管理启动的客户端写 `~/.webbridge/daemon-autostart.json`，记录 daemon PID。
5. 最后一个客户端释放租约，或 15 分钟没有工具调用时，持有所有权标记的客户端执行 `stop`。
6. 手动 `start` 的 daemon 没有所有权标记，不会被自动回收。

启动锁减少并发冷启动的重复 spawn，daemon 的端口绑定是最终单例保证。`WEBBRIDGE_AUTOSTART=0`
关闭懒启动，`WEBBRIDGE_IDLE_MS=0` 关闭空闲回收。

## 9. 性能

2026-11-20 真实 Edge 测试的主要结论：

- `snapshot` JSON 是最大的上下文热点：Wikipedia 139.2 KB，GitHub Blog 70.4 KB，Bing 31.9 KB。
  ARIA 8k 约为 8–9 KB。
- `read_article` 在博客文章和 Wikipedia 上为 14–19 ms，比 `read_page` 快约 50–300 倍。
- `read_page` 的上限从 20k 提到 120k，Wikipedia 延迟从 677 ms 涨到 4,680 ms，输出几乎不变。
- 页面加载中的 JSON 快照可能超时；等待选择器后同一快照可降到几十毫秒。
- `navigate` 受页面加载限制（Bing 4.0 s，GitHub Blog 5.1 s，Wikipedia 7.4 s）。
- `screenshot` 1.1–2.3 s，`save_as_pdf` 9.2 s；`extract`、`capture_page`、`console`、
  `network` 是低成本路径。

完整数据见 `docs/PERFORMANCE.md`。

## 10. 扩展构建

`scripts/build-slim.mjs` 从 vendor bundle 生成 `extension/`：

- Babel 解析背景脚本，按实际执行的语句和副作用初始化做可达性裁剪。
- Terser 重新压缩。
- 精确字符串锚点补丁暴露 bridge 实例，并追加控制代码（popup 状态、重连、断开）。
- 构建失败时锚点不匹配会明确报错，避免静默产出坏扩展。
- 移除产品侧栏、账号/会员、引导、自动更新、遥测和常驻 content script。

本地 profiling 构建只存在 `extension-slim/`，发布包会检查标记并在存在时失败。

## 11. 安全边界

- daemon 和 receiver 只监听 loopback。
- `/command` 等价于本地浏览器权限；需要更强隔离时加 token 代理。
- receiver 的 CORS 只回扩展来源，`/ws` 拒绝网页 Origin。
- 扩展没有静态 content script；页面操作按需注入。
- 请求体、文本、元素、链接、截图都有上限。
- 官方 daemon 可能发送使用遥测；本仓库扩展构建移除扩展侧遥测，daemon 侧不在控制范围内。

## 12. 测试

- `test/catalog.mjs`：目录、签名、参数校验。
- `test/smoke.mjs`：假 daemon 上的两个档位、目录、转发、错误、batch、图片块。
- `test/tools.mjs`：extract/console/reader 参数构造。
- `test/capture.mjs`：Markdown、索引、receiver 路由、WebSocket、CORS。
- `test/lifecycle.mjs`：租约、启动锁、所有权标记。
- `test/e2e-edge.mjs`：真实 Edge + 扩展的完整工具面。
- `test/e2e-pdf.mjs`：PDF 文本读取。

## 13. Go 前端

`cmd/webbridge-mcp` 是 MCP 运行时的 Go 实现。工具目录由 Node 定义导出为
`internal/catalog/catalog.json` 并嵌入二进制；页面脚本通过 `shared/page/embed.go` 嵌入。
Go 与 Node 使用相同的启动锁、租约和所有权文件，迁移期可以混合运行。

等效性测试、基准数据和风险见 [docs/GO.md](docs/GO.md)。扩展和页面脚本保持 JavaScript：
MV3、`chrome.*`、DOM 和 CDP 执行环境无法由 Go 替代。

## 14. 后续

- Go MCP 前端：把协议层和 daemon 生命周期做成单个 Go 二进制，复用 `shared/page` 脚本；
  Node 版本保留完整本地能力。目前 daemon 已经是 Go，MCP 层仍是 Node。
- origin 级 allow/ask。
- 本地 token 代理。
- 多会话并行和网络响应落盘。
- 收藏的 readability 清洗和接管提示模板。
