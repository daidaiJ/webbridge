# 客户端接入

`webbridge` 是一个本地 stdio MCP server。默认入口是 `node <repo>/src/server.mjs`；也可以
使用 Go 入口 `<repo>/dist/webbridge-mcp[.exe]`。两种实现共用同一个 daemon、扩展和
`WEBBRIDGE_*` 环境变量。

## 通用配置

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

Windows 示例：

```json
{
  "mcpServers": {
    "webbridge": {
      "command": "node",
      "args": ["D:/tools/webbridge/src/server.mjs"],
      "env": {
        "WEBBRIDGE_SESSION": "agent",
        "WEBBRIDGE_TOOLSET": "core"
      }
    }
  }
}
```

把 `toolCallTimeoutMs` / `tool_timeout_sec` / 客户端等价设置保持在 620000 ms 以上，至少高于
`request_human` 的默认 120 秒和最大 600 秒。

### Go 入口（可选）

先构建单文件二进制：

```bash
npm run go:build
```

然后把上面的 `command` / `args` 换成：

```json
{
  "mcpServers": {
    "webbridge": {
      "command": "D:/tools/webbridge/dist/webbridge-mcp.exe",
      "args": [],
      "env": {
        "WEBBRIDGE_SESSION": "agent",
        "WEBBRIDGE_TOOLSET": "core"
      }
    }
  }
}
```

macOS/Linux 使用 `dist/webbridge-mcp`。Go 入口不需要 Node 运行时；扩展构建仍需要 Node。
工具、参数校验、错误文本和捕获格式与 Node 入口一致，验证方法见
[docs/GO.md](GO.md)。

## DeepSeek Harness（dsh）

DeepSeek Harness 使用 `@deepseek-ai/dsh-mcp-client` 插件接入外部 MCP server。一个 server 是
一个插件条目，工具名会变成 `mcp__webbridge__navigate`、`mcp__webbridge__snapshot` 等。

在项目或 profile 的插件配置（常见为 `cordis.patch.yml`）中加入：

```yaml
- id: mcp-webbridge
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: webbridge
    transport: stdio
    command: node
    args:
      - D:/tools/webbridge/src/server.mjs
    env:
      WEBBRIDGE_SESSION: dsh
      WEBBRIDGE_TOOLSET: core
    toolCallTimeoutMs: 620000
    startupTimeoutMs: 30000
    toolLoading: on-demand
```

说明：

- `serverName` 只能包含字母、数字、`_`、`-`，长度 1–32。
- `toolLoading: on-demand` 会让 dsh 先列出目录，再由 Agent 用
  `mcp__webbridge__load_tools` 加载需要的工具；适合默认 13 个核心工具。
- 如果希望直接看到全部工具，删掉 `toolLoading`，或设为 `eager`。
- dsh 的 stdio 会先做一次临时 probe，再启动正式进程；两次都会触发 webbridge 的懒启动逻辑，
  但启动锁保证只拉起一个 daemon。
- 首次调用可能需要几秒等 daemon 和扩展连接；之后复用同一个 daemon。
- dsh 重连时 MCP 进程会保留，daemon 的租约也会保留；不要同时开多个指向同一扩展的
  webbridge 条目。

验证：

```text
/mcp
```

或直接让 Agent 调 `mcp__webbridge__status`，应返回 `running:true` 和
`extension_connected:true`。

## WorkBuddy / CodeBuddy

WorkBuddy 和 CodeBuddy Code 使用项目级或用户级 `.mcp.json`。把下面内容放到项目根目录的
`.mcp.json`，或 `~/.codebuddy/.mcp.json`（Windows 为 `%USERPROFILE%\.codebuddy\.mcp.json`）：

```json
{
  "mcpServers": {
    "webbridge": {
      "command": "node",
      "args": ["D:/tools/webbridge/src/server.mjs"],
      "env": {
        "WEBBRIDGE_SESSION": "workbuddy",
        "WEBBRIDGE_TOOLSET": "core"
      }
    }
  }
}
```

如果当前 WorkBuddy 版本要求显式传输类型，在条目里加：

```json
"type": "stdio"
```

然后重启 WorkBuddy 会话，或使用 MCP 面板的 reload。工具会以 `webbridge` 命名空间出现；
具体前缀由客户端决定，通常是 `webbridge__navigate` 或 `mcp__webbridge__navigate`。

验证：

```bash
node /absolute/path/to/webbridge/src/cli.mjs status
```

在 WorkBuddy 中让 Agent 调用 `status`，确认 `extension_connected` 为 true。

## Claude Code

项目级 `.mcp.json`：

```json
{
  "mcpServers": {
    "webbridge": {
      "command": "node",
      "args": ["/absolute/path/to/webbridge/src/server.mjs"],
      "env": {
        "WEBBRIDGE_SESSION": "claude-code",
        "WEBBRIDGE_TOOLSET": "core"
      }
    }
  }
}
```

或用 CLI：

```bash
claude mcp add --transport stdio \
  --env WEBBRIDGE_SESSION=claude-code \
  --env WEBBRIDGE_TOOLSET=core \
  webbridge -- node /absolute/path/to/webbridge/src/server.mjs
```

Claude Code 会把工具显示为 `mcp__webbridge__status` 等。需要逐工具权限时使用
`WEBBRIDGE_TOOLSET=full`。

## Cursor

`~/.cursor/mcp.json`（全局）或项目 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "webbridge": {
      "command": "node",
      "args": ["/absolute/path/to/webbridge/src/server.mjs"],
      "env": {
        "WEBBRIDGE_SESSION": "cursor",
        "WEBBRIDGE_TOOLSET": "core"
      }
    }
  }
}
```

保存后在 Cursor 的 MCP 设置里启用并刷新。首次调用会懒启动 daemon。

## Claude Desktop

编辑 `claude_desktop_config.json`：

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "webbridge": {
      "command": "node",
      "args": ["/absolute/path/to/webbridge/src/server.mjs"],
      "env": {
        "WEBBRIDGE_SESSION": "claude-desktop",
        "WEBBRIDGE_TOOLSET": "core"
      }
    }
  }
}
```

重启 Claude Desktop。桌面版对图片结果支持较好，适合 `screenshot` 和 `read_article`。

## Codex

`~/.codex/config.toml`：

```toml
[mcp_servers.webbridge]
command = "node"
args = ["/absolute/path/to/webbridge/src/server.mjs"]
env = { WEBBRIDGE_SESSION = "codex", WEBBRIDGE_TOOLSET = "core" }
startup_timeout_sec = 30
tool_timeout_sec = 620
```

重启 Codex 后，`codex mcp list` 或等价命令应能看到 `webbridge`。

## 其他客户端

任何支持 stdio MCP 的客户端都可以使用“通用配置”。关键点：

- `command` 用 `node`，`args` 用 `src/server.mjs` 的绝对路径。
- 工作目录不要求是仓库根目录；server 用自身路径定位 `shared/` 和 `docs/`。
- 环境变量按需设置；不设置时使用默认值。
- 不要把 `WEBBRIDGE_URL` 指向非 loopback 地址，除非你明确加了访问控制。

## 工具命名

不同客户端的命名空间不同：

| 客户端 | 典型名称 |
|---|---|
| DeepSeek Harness | `mcp__webbridge__navigate` |
| Claude Code | `mcp__webbridge__navigate` |
| Cursor | `webbridge__navigate` 或 `mcp_webbridge_navigate` |
| WorkBuddy | 由客户端 MCP 面板显示 |

工具本名始终是 `navigate`、`snapshot`、`read_article` 等；skill 里的双下划线前缀只是示例。

## 常见问题

**`daemon_missing`**

没有找到 daemon 二进制。安装到默认路径，或设置 `WEBBRIDGE_BIN`：

```bash
export WEBBRIDGE_BIN=/path/to/kimi-webbridge
```

**`extension_not_connected`**

daemon 在运行，但扩展没有连上。确认扩展已启用，并且只开了一个使用该扩展的浏览器；一个
daemon 只接一个浏览器连接。

**第一次调用很慢**

第一次浏览器工具调用包含 daemon 启动和扩展重连，通常几秒。后续调用复用。调用 `status`
可以看到 `running` 和 `extension_connected`。

**`timeout`**

区分是 daemon 启动超时还是工具超时。工具超时常见于 `snapshot` 的 JSON 过大或页面仍在加载：

- 用 `snapshot {format:"aria", max_chars:8000}`。
- 先 `wait {selector:"..."}`，再快照。
- `read_page` 的 `max_chars` 调到实际需要，续读用 `start`。
- 客户端超时设置要高于 620 秒，尤其是 `request_human`。

**daemon 一直不退出**

确认没有其他 MCP 客户端持有租约。`~/.webbridge/leases/` 里每个文件对应一个客户端 PID；
最后一个客户端退出或空闲 15 分钟后会回收。设置 `WEBBRIDGE_IDLE_MS=0` 会禁用空闲回收。
手动启动的 daemon（`node src/cli.mjs start`）不会被自动回收。

**想固定使用完整工具面**

设置 `WEBBRIDGE_TOOLSET=full`。默认 `core` 通过 `browser_call` 收敛长尾工具，能省下大量
工具定义上下文。
