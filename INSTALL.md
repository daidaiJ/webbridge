# 安装

有两种安装方式：使用 GitHub Release 里的 zip，或从源码构建。两种方式都需要上游的 Browser
Bridge daemon 二进制和 Chromium 浏览器（Edge/Chrome）。

## 方式 A：Release zip

1. 从 [Releases](https://github.com/daidaiJ/webbridge/releases) 下载
   `webbridge-<version>.zip` 和对应平台的 daemon。
2. 解压到一个固定目录，例如：

   ```text
   Windows: D:\tools\webbridge
   macOS/Linux: ~/tools/webbridge
   ```

3. 放置 daemon：

   ```text
   Windows: %USERPROFILE%\.kimi-webbridge\bin\kimi-webbridge.exe
   macOS/Linux: ~/.kimi-webbridge/bin/kimi-webbridge
   ```

   或设置 `WEBBRIDGE_BIN` 指向任意位置。

4. 安装 MCP server 的生产依赖：

   ```bash
   cd webbridge-<version>
   npm ci --omit=dev
   ```

5. 加载扩展：浏览器打开 `edge://extensions` / `chrome://extensions`，启用开发者模式，
   “Load unpacked” 选择解压目录里的 `extension/`。
6. 配置 MCP 客户端，见下一节。
7. 可选：把根目录的 `SKILL.md` 复制到客户端的 skill 目录。

解压后的目录：

```text
webbridge-<version>/
  extension/        # 可直接加载
  src/
  shared/
  docs/
  skill/
  SKILL.md
  README.md
  README.EN.md
  INSTALL.md
  NOTICE.md
  DESIGN.md
  SECURITY.md
  CONTRIBUTING.md
```

## 方式 B：源码

要求 Node.js 22+。

```bash
git clone https://github.com/daidaiJ/webbridge.git
cd webbridge
npm ci
npm test
npm run build:slim
```

`npm run build:slim` 会从本地 vendor bundle 生成 `extension/`。如果仓库里没有 vendor
bundle，使用 Release 里的 `extension/`，或从上游 Browser Bridge 产品安装扩展。

## daemon

daemon 是上游 Browser Bridge 的二进制，负责 HTTP `/command`、WebSocket 和标签组语义。
从 [产品页](https://www.kimi.com/products/kimi-webbridge) 下载对应平台：

```text
windows-amd64.exe
darwin-arm64
darwin-amd64
linux-amd64
linux-arm64
```

默认路径：

```text
Windows: %USERPROFILE%\.kimi-webbridge\bin\kimi-webbridge.exe
macOS/Linux: ~/.kimi-webbridge/bin/kimi-webbridge
```

macOS/Linux：

```bash
chmod +x ~/.kimi-webbridge/bin/kimi-webbridge
```

覆盖路径：

```bash
export WEBBRIDGE_BIN=/path/to/kimi-webbridge
```

daemon 不需要常驻。第一次浏览器工具调用会懒启动；手动管理用：

```bash
node src/cli.mjs status
node src/cli.mjs start
node src/cli.mjs stop
```

## 扩展

1. 打开扩展管理页。
2. 启用开发者模式。
3. “Load unpacked” 选择 `extension/`。
4. 确认扩展已启用，且没有第二个浏览器同时连接同一个 daemon。

扩展 ID 在 `manifest.json` 中固定。扩展只连接 `ws://127.0.0.1:10086/ws`，不需要账号。

## MCP 客户端

### 通用 stdio

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

### TOML（Codex 等）

```toml
[mcp_servers.webbridge]
command = "node"
args = ["D:/tools/webbridge/src/server.mjs"]
env = { WEBBRIDGE_SESSION = "codex", WEBBRIDGE_TOOLSET = "core" }
startup_timeout_sec = 30
tool_timeout_sec = 620
```

### DeepSeek Harness / WorkBuddy

见 [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) 的完整 YAML/JSON 示例。

## Skill

`skill/SKILL.md` 是 Agent 操作规范。复制到客户端读取的目录，例如：

```text
~/.grok/skills/webbridge/SKILL.md
```

或客户端支持的任意 skill 目录。发布包根目录的 `SKILL.md` 是同一份文件的副本。

## 验证

```bash
node src/cli.mjs status
```

期望：

```json
{
  "running": true,
  "extension_connected": true
}
```

第一次 `status` 不会启动 daemon；调用真实浏览器工具或 `start` 才会。

```bash
node src/cli.mjs call navigate '{"url":"https://example.com"}' --session demo
node src/cli.mjs call read_page '{"max_chars":2000}' --session demo
```

MCP 客户端里让 Agent 调 `status`，再调 `read_article`。如果工具名带命名空间（例如
`mcp__webbridge__status`），以客户端显示为准。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEBBRIDGE_BIN` | `~/.kimi-webbridge/bin/kimi-webbridge[.exe]` | daemon 路径 |
| `WEBBRIDGE_URL` | `http://127.0.0.1:10086` | daemon 地址 |
| `WEBBRIDGE_SESSION` | `grok` | 默认任务名/标签组 |
| `WEBBRIDGE_GROUP_TITLE` | 空 | 默认可见组名 |
| `WEBBRIDGE_TOOLSET` | `core` | `core` / `full` |
| `WEBBRIDGE_AUTOSTART` | `1` | `0` 关闭懒启动 |
| `WEBBRIDGE_IDLE_MS` | `900000` | 空闲回收；`0` 关闭 |
| `WEBBRIDGE_STATE_DIR` | `~/.webbridge` | 锁/租约目录 |
| `WEBBRIDGE_CAPTURE_DIR` | `~/.webbridge/captures` | 收藏目录 |
| `WEBBRIDGE_CAPTURE_PORT` | `10087` | 收藏接收器端口 |

## 常见问题

**daemon 没装**

`daemon_missing: the browser daemon is not installed`。把二进制放到默认路径或设置
`WEBBRIDGE_BIN`。

**扩展没连上**

`extension_not_connected`。确认扩展已启用、只开了一个浏览器、没有另一个 webbridge 客户端
占着连接。`node src/cli.mjs status` 可看 `extension_connected`。

**端口被占用**

默认 `10086`。用 `WEBBRIDGE_URL` 指向另一个端口，并让 daemon 用
`kimi-webbridge start --addr 127.0.0.1:<port>` 启动。注意 `--addr` 只对本次运行有效。

**第一次调用慢**

冷启动包含 daemon 启动和扩展重连，通常几秒。后续调用复用。空闲 15 分钟后会回收，下次再
启动。

**客户端看不到工具**

确认 `command`/`args` 是绝对路径，Node 版本 ≥22，客户端重启或 reload MCP。先用
`node src/server.mjs` 看 stderr 是否报错。

**想固定常驻 daemon**

`WEBBRIDGE_IDLE_MS=0` 关闭空闲回收；或者手动 `node src/cli.mjs start`，手动启动的 daemon
没有自动回收标记。

## 卸载

```bash
node src/cli.mjs stop
```

然后删除仓库/解压目录、扩展，以及可选的 `~/.webbridge` 和 `~/.kimi-webbridge`。删除
`~/.kimi-webbridge` 会同时移除上游 daemon 和它的配置。
