# webbridge

[简体中文](README.md) | English

Give any MCP agent control of the browser the user is already using: real tabs, real logins,
real extensions, and the real window. No headless browser, no separate profile, no page copies.
Traffic stays on `127.0.0.1`.

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

## Why

- **The real page.** Signed-in sites, SSO, captcha, intranets, and sites that depend on browser
  extensions work because the agent drives the user's own browser.
- **Agent-shaped surface.** 13 core tools follow `status → session → navigate → snapshot →
  click/fill → wait → verify → close_session`; the other tools are discovered on demand.
- **Small default context.** The core profile costs about 6.2k characters of tool definitions;
  the full profile lists 40 tools.
- **Clean article text.** `read_article` runs a reader-mode pass in the page and returns Markdown.
- **Lazy and singleton.** The daemon starts on the first browser tool call, one instance is shared
  by all clients, and the last client or an idle timeout stops it.
- **Bounded by design.** Snapshots, captures, extraction, screenshots, PDFs, network capture,
  console capture, and human handoff are exposed as explicit tools with size limits.

## Tools

40 browser tools total. The default `core` profile lists 13:

| Stage | Tools |
|---|---|
| Prepare | `status`, `start`, `session` |
| Open and observe | `navigate`, `snapshot`, `read_page`, `screenshot` |
| Act and verify | `click`, `fill`, `wait` |
| Finish | `close_session` |
| On-demand catalog | `browser_tools`, `browser_call` |

The other 29 tools are grouped as `tabs`, `read`, `interact`, `output`, `history`, `script`, and
`flow`:

1. `browser_tools` returns the workflow and groups.
2. `browser_tools {query:"table"}` searches names and signatures.
3. `browser_tools {tool:"extract"}` returns the full schema and an example.
4. `browser_call {tool:"extract", args:{selector:"#rows tr"}}` runs it.

`WEBBRIDGE_TOOLSET=full` lists all 40 directly. See [docs/TOOLS.md](docs/TOOLS.md).

### Useful long-tail tools

| Tool | Purpose |
|---|---|
| `read_article` | Reader mode: strip chrome, return clean Markdown |
| `extract` | CSS-selector extraction of repeated rows and cards |
| `capture_page` | Save the page as Markdown with frontmatter and an index |
| `network` | Start, list, inspect, stop network capture |
| `console` | Collect logs, uncaught errors, and unhandled rejections |
| `batch` | Up to 40 steps in one round trip |
| `request_human` | Hand control to the person for sign-in, 2FA, or consent |
| `attach_tab` | Borrow an existing user tab; it survives `close_session` |
| `highlight` | Draw a box around a target for the person |

## Quick start

### 1. Install the daemon

The daemon is the upstream Browser Bridge binary. Download it for your platform from the
[Browser Bridge product page](https://www.kimi.com/products/kimi-webbridge) and place it at:

```text
Windows: %USERPROFILE%\.kimi-webbridge\bin\kimi-webbridge.exe
macOS/Linux: ~/.kimi-webbridge/bin/kimi-webbridge
```

Or set `WEBBRIDGE_BIN` to an existing binary. On macOS/Linux, make it executable.

### 2. Load the extension

The release bundle includes a built `extension/` directory:

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable Developer mode.
3. Choose "Load unpacked" and select `extension/`.
4. Check the connection with `node src/cli.mjs status` or the `status` tool.

The extension connects to `ws://127.0.0.1:10086/ws` and needs no account.

### 3. Configure the MCP client

Generic stdio configuration:

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

Client-specific examples for DeepSeek Harness (`dsh`), WorkBuddy / CodeBuddy, Claude Code,
Cursor, Claude Desktop, Codex, and generic stdio are in
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

### 4. Install the skill (optional)

`skill/SKILL.md` teaches the workflow, sessions, tab borrowing, performance tradeoffs, and human
handoff. Copy it into the client's skill directory. The release bundle also has `SKILL.md` at its
root.

## Lazy lifecycle and singleton

The daemon does not run all the time. The first browser tool call:

1. Probes `127.0.0.1:10086/status`.
2. If nothing answers, runs `webbridge start` in the background.
3. Waits for the daemon and retries the tool call.

Concurrent cold clients serialize on `~/.webbridge/daemon-start.lock`; each client keeps a PID
lease in `~/.webbridge/leases/`. When the last lease is released, or after 15 minutes without a
tool call, the client that started the daemon stops it. The next call starts it again.

| Variable | Default | Meaning |
|---|---|---|
| `WEBBRIDGE_AUTOSTART` | `1` | Set to `0` to require an explicit `start` |
| `WEBBRIDGE_IDLE_MS` | `900000` | Idle shutdown; `0` disables it |
| `WEBBRIDGE_STATE_DIR` | `~/.webbridge` | Lock, lease, and ownership state |
| `WEBBRIDGE_BIN` | `~/.kimi-webbridge/bin/kimi-webbridge[.exe]` | Daemon binary |
| `WEBBRIDGE_URL` | `http://127.0.0.1:10086` | Daemon URL |
| `WEBBRIDGE_SESSION` | `grok` | Default task/tab-group name |
| `WEBBRIDGE_GROUP_TITLE` | empty | Default visible group title |
| `WEBBRIDGE_TOOLSET` | `core` | `core` or `full` |
| `WEBBRIDGE_CAPTURE_DIR` | `~/.webbridge/captures` | Capture directory |
| `WEBBRIDGE_CAPTURE_PORT` | `10087` | Loopback capture receiver port |

Manual control:

```bash
node src/cli.mjs status
node src/cli.mjs start      # manual start; excluded from idle shutdown
node src/cli.mjs stop
node src/cli.mjs call read_page '{}' --session demo
```

## Performance

Measured on 2026-11-20 against a real Edge browser. Page load and network conditions dominate
`navigate`; compare relative costs within a page.

| Action | Latency | Output |
|---|---:|---:|
| `status` | 26 ms | 0.5 KB |
| `navigate` Bing | 3,984 ms | — |
| `snapshot` Bing JSON | 128 ms | 31.9 KB |
| `snapshot` Bing ARIA 8k | 50 ms | 7.9 KB |
| `extract` Bing 10 items | 13 ms | 5.4 KB |
| `read_page` Bing 20k | 1,340 ms | 3.3 KB |
| `read_article` blog article | 14 ms | 10.4 KB |
| `read_article` Wikipedia | 19 ms | 10.6 KB |
| `navigate` Wikipedia | 7,412 ms | — |
| `snapshot` Wikipedia JSON | 326 ms | 139.2 KB |
| `snapshot` Wikipedia ARIA 8k | 290 ms | 8.8 KB |
| `read_page` Wikipedia 20k | 677 ms | 20.1 KB |
| `read_page` Wikipedia 120k | 4,680 ms | 20.2 KB |
| `screenshot` PNG | 1,115–2,285 ms | 69–110 KB |
| `save_as_pdf` | 9,164 ms | path |

Takeaways:

- JSON snapshots are the largest context cost. Prefer `format:"aria"` with `max_chars`, or
  `snapshot(ref)`.
- `read_article` is roughly 50–300x faster than `read_page` on the same article and has no
  navigation or sidebars.
- Keep `read_page`'s `max_chars` near what you need; 120k can cost seconds for almost no extra text.
  Use `start` to continue.
- `navigate` is page-load bound; reuse the task tab when possible.
- `extract`, `capture_page`, `console`, and `network` are cheap paths.
- Screenshots and PDFs are expensive; use an element selector or JPEG when possible.

See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for methodology and more data.

## Optional Go MCP front end

`cmd/webbridge-mcp` is a functionally equivalent Go implementation of the MCP runtime. It talks
to the same daemon, shares the generated tool catalog, page scripts, and `~/.webbridge` lifecycle
files, and leaves the extension and page scripts in JavaScript.

Fixed-overhead measurements on the same Windows machine with the same fake daemon:

| Metric | Node | Go |
|---|---:|---:|
| MCP connect | 469 ms | 44 ms |
| Forwarded call p50 | 2.30 ms | 1.26 ms |
| Idle RSS | 72 MB | 14 MB |
| Distribution | Node + 95 production npm packages | one 8.8 MB binary |

Browser actions remain dominated by page load and CDP; Go reduces process startup, memory, and
local forwarding cost. Build and verify:

```bash
npm run go:build          # dist/webbridge-mcp[.exe], stripped
npm run go:test           # catalog, lifecycle, handoff, capture
npm run test:go           # Node/Go parity against a fake daemon
npm run test:parity:live  # real Edge + extension
npm run bench:go          # startup, call latency, RSS
```

The full matrix, risks, and recommendation are in [docs/GO.md](docs/GO.md). The release bundle
still uses the Node entry by default; the Go binary is built from source.

## Security

- The daemon and capture receiver bind to `127.0.0.1` only. Do not use `0.0.0.0`.
- `/command` is effectively a local browser privilege: any local process that can reach
  `127.0.0.1:10086` can drive the browser. Add a token proxy if you need stronger isolation.
- Capture CORS echoes extension origins only; `/ws` rejects web origins, so a page cannot read
  handoff text.
- No static content scripts; page work uses on-demand `chrome.scripting.executeScript`.
- Images larger than 6 MiB are returned as a path.
- Payment confirmation stays with the person; the agent stops at the order page.

## Repository layout

```text
src/server.mjs          MCP stdio server
src/tools.mjs           Tool schemas, core list, groups
src/catalog.mjs         On-demand catalog, signatures, search, validation
src/actions.mjs          Tool-to-daemon action mapping
src/daemon.mjs          HTTP client, lazy start, singleton, idle shutdown
src/lifecycle.mjs        Cross-process start lock, leases, ownership
src/reader.mjs          read_article: in-page reader mode
src/capture.mjs         Page capture + loopback receiver
src/handoff.mjs         request_human state and long-poll
shared/page/            Self-contained page scripts (reader/extract/console/capture)
cmd/webbridge-mcp/      Optional Go MCP entry point
internal/               Go catalog, daemon lifecycle, capture, handoff, app
scripts/export-catalog.mjs  Export Node tool definitions for Go
scripts/build-slim.mjs  Build extension/ from the vendor bundle
scripts/package-release.mjs  Build the release zip
skill/SKILL.md          Agent operating guide
docs/                   Integrations, tools, protocol, performance, Go evaluation
test/                   Browser-free tests, Node/Go parity, real Edge E2E
```

## Build and test

Requires Node.js 22+.

```bash
npm ci
npm test                       # catalog, smoke, tools, capture, lifecycle
npm run go:test                # Go catalog, lifecycle, handoff, capture
npm run test:go                # Node/Go MCP parity (fake daemon)
npm run build:slim             # build extension/
npm run package:extension      # dist/browser-bridge-<version>.zip
npm run package:release        # dist/webbridge-<version>.zip
npm run test:e2e               # real Edge + extension
npm run test:e2e:pdf
npm run test:parity:live       # Node/Go parity on real Edge
npm run test:shared            # Node/Go share one daemon lifecycle
npm run bench:go               # startup, call, memory benchmark
```

`npm test` needs no browser. E2E starts its own Edge profile and refuses to run when another
browser is already connected to the daemon.

## Release bundle

`dist/webbridge-<version>.zip` contains:

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
  cmd/              # optional Go MCP entry point
  internal/         # Go catalog, daemon lifecycle, local tools
  scripts/          # Go catalog export and build scripts
  test/             # Go parity test and benchmark
  docs/
  extension/        # load unpacked
```

Run `npm ci --omit=dev` in the extracted directory to install the MCP server's production
dependencies; run `npm run go:build` to build the optional Go entry point. The release excludes the
local profiling build, debug patches, and browser E2E temporary artifacts.

## Known limits

- One daemon accepts one browser connection at a time; Chrome and Edge extensions compete for it.
- The browser execution layer comes from upstream Browser Bridge components. Re-check the exact
  patch anchors in `scripts/build-slim.mjs` when updating the vendor bundle; the build fails
  loudly if an anchor moves.
- The default `core` profile collapses long-tail tools behind `browser_call`; use
  `WEBBRIDGE_TOOLSET=full` when per-tool approval matters.
- Instant human-handoff delivery uses a loopback WebSocket in the MCP process. When that socket
  is down, the extension reuses the 30-second `webbridge-reconcile` alarm as a fallback; while it
  is up, a 5-minute watchdog check is the only poll.
- `snapshot` can time out while a page is still loading. Wait for a selector or use ARIA with
  `max_chars`.
- The upstream daemon may send usage telemetry (OS, architecture, versions, session name, tool
  name). This repo's extension build removes extension-side telemetry; daemon-side telemetry is
  outside this repo.
- The Go front end is optional; the release bundle still defaults to the Node entry. Live parity
  for `network`, PDF, upload, drag, and the full human-handoff interaction is still pending.

## Credits and license

The browser execution layer and daemon protocol come from upstream Browser Bridge components.
This repo provides the MCP surface, the slim extension build, reader mode, capture/handoff/batch,
the lazy lifecycle, and documentation. Product interaction draws on Tabbit CLI's
task = session = visible tab group, tab borrowing, human handoff, and daemon lifecycle ideas; the
MCP interface is reorganized around an agent workflow.

This repo's code is MIT licensed; see [LICENSE](LICENSE). The built extension in release bundles
includes upstream components; read [NOTICE.md](NOTICE.md) before redistributing.
