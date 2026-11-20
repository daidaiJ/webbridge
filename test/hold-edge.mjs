// Keep Edge open with the extension attached for manual / fork-level checks.
// Prints the test page URL, then stays open until killed or 10 minutes pass.

import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

const extensionDir = path.resolve(process.env.WEBBRIDGE_EXT_DIR || 'extension-slim');
const html = `<!doctype html><html><head><title>Fork E2E</title></head><body>
<h1>Fork E2E heading</h1><p>webbridge is driving the real browser.</p>
<button onclick="this.textContent='clicked'">Press</button></body></html>`;

const web = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise((resolve) => web.listen(18777, '127.0.0.1', resolve));

const profile = await mkdtemp(path.join(tmpdir(), 'webbridge-hold-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1280, height: 860 },
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});
console.log('PAGE_URL=http://127.0.0.1:18777/');
await new Promise((resolve) => setTimeout(resolve, 600_000));
await context.close().catch(() => {});
web.close();
