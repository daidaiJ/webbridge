---
name: webbridge
description: >
  Drive the user's real browser (their tabs, logins, extensions) through a local
  Browser Bridge daemon and its companion extension. Use for any web task that needs
  a real page: checking a UI you just changed, reading or extracting data from
  a signed-in site, filling forms, taking screenshots, capturing network
  traffic, saving a page for later, handing a step to the person, or verifying
  a web app end to end. The default toolset lists 11 core tools plus
  webbridge__browser_tools and webbridge__browser_call for everything else.
---

# webbridge

The browser is the user's real browser: their profile, cookies, logins and
window. Pages behave as the user sees them. Everything stays on `127.0.0.1`.

## The loop

1. `webbridge__status` — check `running` and `extension_connected`. A cold
   daemon is fine: the first browser tool starts it automatically, once, and
   shares it with other MCP clients. Call `webbridge__start` only to prewarm.
   If the extension is missing, ask the user to enable it, then retry once.
2. `webbridge__session {name}` — name the task once. One task = one session =
   one visible tab group. Skip only for a single quick page.
3. `webbridge__navigate {url, newTab?, group_title?}` — open the page. Use
   `newTab: true` when earlier pages must stay. Pass `group_title` on the
   first navigation. On a heavy page, `webbridge__wait` for a concrete
   selector before snapshotting.
4. `webbridge__snapshot` — the page map. Read the `@e` refs before clicking
   anything. Re-snapshot after navigation or any DOM change. If the JSON tree
   is large or the call times out, use `format:"aria"` with `max_chars`, or
   `snapshot(ref)` to narrow it.
5. `webbridge__click {selector: "@e12"}` or
   `webbridge__fill {selector: "@e7", value: "..."}` — act on a ref (preferred)
   or a CSS selector.
6. `webbridge__wait {selector | text | text_gone, timeout_ms}` — wait for a
   concrete result. A duration alone is not a condition.
7. Verify with `webbridge__snapshot`, `webbridge__read_page` or
   `webbridge__screenshot`. A successful click is not proof the page changed.
8. `webbridge__close_session` — close the tabs this task opened. Borrowed user
   tabs stay open.

## The rest of the suite

The core set is deliberately small. When the task needs something else:

1. `webbridge__browser_tools` with no arguments — the workflow and tool groups.
2. `webbridge__browser_tools {query: "table"}` — matching tools with signatures.
3. `webbridge__browser_tools {tool: "extract"}` — full arguments and an example.
4. `webbridge__browser_call {tool: "extract", args: {selector: "#rows tr"}}` —
   run it.

Groups:

- `tabs` — list, borrow, find, activate, close.
- `read` — find, extract, console, network, dialog.
- `interact` — real mouse, keyboard, select, hover, scroll, drag, upload.
- `output` — PDF, capture_page, highlight.
- `history` — reload, back, forward.
- `script` — evaluate, cdp.
- `flow` — batch, request_human.

Call core tools directly. `browser_call` only accepts tools listed by
`browser_tools`; it rejects core names with a reminder.

## Recipes

**Fill and submit**

`navigate` → `snapshot` → `fill` on the input ref → `click` on the button ref →
`wait` for the result text or selector → `snapshot` to confirm.

**Extract a table or card list**

`browser_tools {tool: "extract"}` → `browser_call` with `selector` for the
repeated item and optional `fields`. This is cheaper than a full snapshot.

**Verify a UI change**

`navigate` to the page → `screenshot` for layout and appearance → `read_page`
or `snapshot` for content and structure. Re-check the routes and states the
change touches, not only the happy path.

**Use a tab the user already has open**

`browser_tools {query: "tabs"}` → `list_browser_tabs` → `attach_tab`. A
borrowed tab stays open after `close_session` and does not steal focus.

**Debug page behavior**

`console {action:"start"}` before the interaction, then
`console {action:"read", clear:true}`. For requests, `network {cmd:"start"}`,
`network {cmd:"list"}`, `network {cmd:"detail"}` before `network {cmd:"stop"}`
(stopping drops response bodies).

**Hand a step to the person**

`highlight` the control, then `request_human` with a one-line reason and
instructions. The call returns when they press Continue or the timeout passes;
re-read the page after it resumes. Payment confirmation stays with the person:
stop at the order page.

**Tight sequences**

`batch` runs up to 40 steps in one round-trip (`fill → click → wait`) and
returns per-step results. Reach it through `browser_tools` + `browser_call`.

## Daemon lifecycle

The daemon is on demand and singleton. The first browser tool call probes
`127.0.0.1:10086`; if nothing answers, it starts the daemon in the background
and retries. A per-client lease and a start lock keep concurrent editor windows
from spawning duplicates. When the last MCP client exits, or after 15 minutes
with no calls, the client that manages the daemon stops it. The next call starts
it again. Set `WEBBRIDGE_IDLE_MS=0` to disable idle shutdown, or
`WEBBRIDGE_AUTOSTART=0` to require an explicit `start`.

## Performance

- The first browser call includes daemon startup (usually a few seconds). Later
  calls reuse the running daemon and its extension connection.
- Prefer `extract` for repeated rows and cards; it is much cheaper than a full snapshot.
- `snapshot` JSON is the biggest common output: 30–140 KB on search and article pages.
  `format:"aria"` with `max_chars: 8000` returns about 8–9 KB.
- `read_page` with `max_chars: 20000` is usually fast; a much larger cap can add
  seconds of scanning for little extra text. Continue with `start` instead.
- `navigate` is dominated by page load. Reuse tabs and skip a second navigation
  when the page is already open.
- `batch` removes MCP/HTTP round trips for tight sequences; it does not make the
  browser action itself faster.
- `screenshot` and `save_as_pdf` are the expensive output paths; use an element
  selector or JPEG for a smaller screenshot, and save PDFs only when needed.

## Rules that prevent mistakes

- `@e` refs go stale after navigation or a DOM replacement. Call `snapshot`
  again instead of reusing an old ref.
- A snapshot taken while the page is still loading can time out. Wait for a
  selector, then snapshot; fall back to `format:"aria"` on very large pages.
- `fill` replaces the value. Read the field first when appending matters.
- `click` is synthetic. If the page ignores it, use `mouse_click`.
- Use `select_option` for a native `<select>`; for a custom dropdown, `click`
  to open it and `click` the option.
- After an action, wait for a condition, then verify. Do not report success
  from the action's return value alone.
- A blocking JavaScript dialog stalls other commands. Answer it with `dialog`
  as soon as it appears.
- Keep one session for the whole task. Switching per site splits the tab group.
- Never confirm a payment. Stop before the final pay button and let the person
  finish.
