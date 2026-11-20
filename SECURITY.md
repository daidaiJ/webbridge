# Security

## Trust boundary

webbridge drives the browser the user is already signed into. A tool call can read pages, click,
type, upload files, run page JavaScript, and capture screenshots or PDFs. Treat the MCP server and
the daemon as local browser privileges.

- The daemon listens on `127.0.0.1:10086` by default. Keep it on loopback. Binding to `0.0.0.0`
  exposes browser control to the network.
- The capture/handoff receiver listens on `127.0.0.1:10087` by default. Its CORS headers echo
  extension origins only, and its WebSocket rejects web origins.
- Any local process that can reach `/command` can drive the browser. Add an authenticating proxy
  in front of the daemon if local processes are not mutually trusted.

## Data handling

- Page content stays local. `read_article`, `extract`, `read_page`, `capture_page`, screenshots,
  and PDFs are written only to the configured local paths.
- Captures go to `WEBBRIDGE_CAPTURE_DIR` (default `~/.webbridge/captures`). Keep that directory
  out of shared or synced folders if pages contain sensitive data.
- The MCP server logs only to stderr; stdout is reserved for MCP JSON-RPC.
- Lifecycle state in `~/.webbridge` contains PIDs and timestamps, not page content.

## Browser permissions

- The extension requests `debugger` for CDP and `<all_urls>` for arbitrary navigation and
  on-demand scripting. Both are required for a general browser bridge.
- There are no statically declared content scripts. Scripts are injected only when a tool runs.
- The extension's CSP keeps the MV3 default `script-src 'self'` and restricts connections to
  loopback.

## Human-in-the-loop

- `request_human` is for sign-in, 2FA, captcha, consent, and decisions. The model should stop at
  the order page and let the person confirm payment.
- `highlight` shows the target control before a handoff.

## Third-party components

The browser execution layer and daemon are upstream Browser Bridge components. This repository
does not include their source in git; release bundles include a built extension. Review
`NOTICE.md` and the upstream terms before redistributing.

## Reporting

Open a private security advisory on GitHub, or contact the repository owner through the profile
listed on the repository page. Include the affected version, a minimal reproduction, and whether
the issue requires local access.
