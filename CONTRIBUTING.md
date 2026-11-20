# Contributing

Thanks for improving webbridge. Keep changes small, local, and testable.

## Setup

```bash
git clone https://github.com/daidaiJ/webbridge.git
cd webbridge
npm ci
npm test
```

Node.js 22+ is required. Browser E2E tests need Microsoft Edge and the built extension:

```bash
npm run build:slim
npm run test:e2e
```

Quit other browsers connected to the daemon first; the daemon accepts one browser connection at a
time. `WEBBRIDGE_E2E_ALLOW_CONNECTED=1` allows using the already-connected browser when that is
the browser under test.

## Before opening a pull request

- Run `npm test`.
- For UI or extension changes, exercise the affected flow in a real browser and check desktop and
  mobile viewports where layout changes.
- Update `docs/TOOLS.md` if tool names, groups, or schemas change.
- Update `skill/SKILL.md` if the agent workflow changes.
- Update `docs/PERFORMANCE.md` only with measured numbers; state the date, browser, and method.
- Keep public docs free of local machine paths and personal state.

## Code style

- ESM, Node built-ins first; avoid new runtime dependencies unless they clearly pay for themselves.
- Comments explain non-obvious constraints, not implementation narration.
- Keep tool descriptions action-oriented: what it does, when to use it, and what to do next.
- Bound output sizes and validate arguments before a daemon round trip.

## Extension build

`scripts/build-slim.mjs` patches exact strings in the vendor bundle. If an anchor moves, the build
must fail loudly rather than ship a broken worker. When updating the vendor baseline, re-check
every patch and rerun the full E2E sweep and PDF test.

Do not commit `extension/`, `extension-slim/`, `dist/`, local profiling artifacts, or machine
state. The release packager builds the extension from the local vendor source and includes only
the clean output.

## Commit and release

Use `feat:`, `fix:`, `docs:`, `test:`, or `chore:` prefixes. Release notes should list user-facing
changes, lifecycle changes, performance findings, and any new limits.
