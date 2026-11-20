# 工具参考

webbridge 2.1.1，共 40 个浏览器工具。默认 `core` 档位列出 13 个，`WEBBRIDGE_TOOLSET=full` 直接列出 40 个。

## 默认核心工具

| 工具 | 作用 | 签名 |
|---|---|---|
| `status` | Check the daemon and extension before starting. | `status()` |
| `start` | Start the daemon if it is not running. | `start()` |
| `session` | Name the task and its tab group. | `session({ name: string })` |
| `navigate` | Open a URL in the real browser. | `navigate({ url: string, newTab?: boolean, group_title?: string })` |
| `snapshot` | Read the page map with @e refs. | `snapshot({ ref?: string, format?: "json" \| "aria", max_chars?: number, cursor?: string })` |
| `click` | Synthetic click on a ref or selector. | `click({ selector: string })` |
| `fill` | Set an input or editor value. | `fill({ selector: string, value: string })` |
| `wait` | Wait for a concrete page condition. | `wait({ text?: string, text_gone?: string, selector?: string, frame?: string, timeout_ms?: number, snapshot?: boolean })` |
| `read_page` | Read the page text. | `read_page({ max_chars?: number, start?: number, frame?: string })` |
| `screenshot` | Visual check of the tab or one element. | `screenshot({ format?: "png" \| "jpeg", quality?: number, selector?: string, path?: string })` |
| `close_session` | Close the tabs this task opened. | `close_session()` |

## 长尾工具

### tabs — Find, borrow, activate, or close tabs

| 工具 | 作用 | 签名 | 超时 |
|---|---|---|---:|
| `list_tabs` | List the tabs this task owns. | `list_tabs()` | 默认 |
| `list_browser_tabs` | List every browser tab without attaching. | `list_browser_tabs()` | 默认 |
| `find_tab` | Reselect a tab this task owns, by host; active borrows the foreground tab. | `find_tab({ url: string, active?: boolean })` | 默认 |
| `attach_tab` | Claim an existing tab as borrowed; it stays open after close_session. | `attach_tab({ tabId: number })` | 默认 |
| `activate_tab` | Bring the task tab to the front; optionally focus the window. | `activate_tab({ focus_window?: boolean })` | 30s |
| `close_tab` | Close the current task tab. | `close_tab()` | 默认 |

### read — Reader mode, search, extract, console, network, and dialogs

| 工具 | 作用 | 签名 | 超时 |
|---|---|---|---:|
| `read_article` | Reader mode: strip page chrome and return clean article Markdown. | `read_article({ max_chars?: number })` | 90s |
| `find` | Search page text and return matching @e refs. | `find({ query: string })` | 默认 |
| `extract` | Extract repeated elements as JSON with optional fields. | `extract({ selector: string, fields?: object[], max_items?: number, include_empty?: boolean })` | 60s |
| `console` | Start, read, or stop console and error capture. | `console({ action?: "start" \| "read" \| "stop", clear?: boolean })` | 30s |
| `network` | Start, list, detail, or stop network capture. | `network({ cmd: "start" \| "stop" \| "list" \| "detail", filter?: string, requestId?: string })` | 45s |
| `dialog` | Inspect or answer an alert, confirm, or prompt. | `dialog({ action: "status" \| "accept" \| "dismiss", text?: string })` | 30s |

### interact — Real pointer, keyboard, select, hover, scroll, drag, and upload

| 工具 | 作用 | 签名 | 超时 |
|---|---|---|---:|
| `mouse_click` | Real pointer click; use when a synthetic click is ignored. | `mouse_click({ selector: string, focus_emulation?: boolean })` | 60s |
| `key_type` | Type real keystrokes into the focused element. | `key_type({ text: string, focus_emulation?: boolean })` | 45s |
| `send_keys` | Send Enter, Escape, Tab, or Mod+A to the focused element. | `send_keys({ keys: string, repeat?: number, focus_emulation?: boolean })` | 60s |
| `hover` | Hover to open menus, tooltips, or preview cards. | `hover({ selector: string, focus_emulation?: boolean })` | 45s |
| `select_option` | Choose native <select> options by value or label. | `select_option({ selector: string, value?: string, values?: string[] })` | 45s |
| `set_checked` | Set a checkbox, radio, switch, or ARIA control. | `set_checked({ selector: string, checked: boolean })` | 45s |
| `scroll` | Scroll to an element, text, page edge, or one screen. | `scroll({ selector?: string, text?: string, to?: "top" \| "bottom", direction?: "up" \| "down" })` | 45s |
| `drag` | Drag one element onto another; verify with snapshot. | `drag({ from: string, to: string })` | 60s |
| `upload` | Set absolute files on a file input. | `upload({ selector: string, files: string[] })` | 60s |

### output — PDF, page capture, and highlights

| 工具 | 作用 | 签名 | 超时 |
|---|---|---|---:|
| `save_as_pdf` | Render the current tab to PDF and return its path. | `save_as_pdf({ paper_format?: "letter" \| "legal" \| "a4" \| "a3" \| "tabloid", landscape?: boolean, scale?: number, print_background?: boolean, path?: string })` | 90s |
| `capture_page` | Save the tab as Markdown with frontmatter and links. | `capture_page({ dir?: string, tags?: string[], screenshot?: boolean, max_chars?: number })` | 90s |
| `highlight` | Draw a temporary box around an element for the user. | `highlight({ action?: "show" \| "clear", selector?: string, highlight_id?: string, duration_ms?: number })` | 30s |

### history — Reload, go back, or go forward

| 工具 | 作用 | 签名 | 超时 |
|---|---|---|---:|
| `history` | Reload, go back, or go forward in the current tab. | `history({ action: "reload" \| "back" \| "forward" })` | 60s |

### script — Page JavaScript and raw CDP

| 工具 | 作用 | 签名 | 超时 |
|---|---|---|---:|
| `evaluate` | Run page JavaScript; wrap statements in an IIFE. | `evaluate({ code: string })` | 30s |
| `cdp` | Raw CDP passthrough; Target.activateTarget is refused. | `cdp({ method: string, params?: object })` | 60s |

### flow — Batch steps and human handoff

| 工具 | 作用 | 签名 | 超时 |
|---|---|---|---:|
| `batch` | Run up to 40 steps in one round-trip; stops at the first error. | `batch({ steps: object[], stop_on_error?: boolean })` | 300s |
| `request_human` | Hand control to the person for sign-in, 2FA, captcha, or a decision. | `request_human({ reason: string, instructions?: string, timeout_ms?: number })` | 620s |

## 目录与调用

- `browser_tools`：无参数返回工作流和分组；`query` 搜索；`tool` 返回完整 schema 和示例。
- `browser_call`：`{tool, args}` 执行长尾工具；拒绝核心工具名、未知工具、未知参数和缺失必填参数。

## 完整档位

设置 `WEBBRIDGE_TOOLSET=full` 后，客户端会直接看到 40 个工具。适合逐工具权限、强类型工具面或大量长尾调用的客户端。

## 超时

工具定义里的超时是 MCP server 一侧的上限。客户端自己的 `tool_timeout_sec` / `toolCallTimeoutMs` 要更高；`request_human` 默认 120 秒，最大 600 秒。
