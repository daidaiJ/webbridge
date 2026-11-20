// PDF reading check for the slim extension: serve test/sample.pdf, navigate to
// it, and read its text through the MCP bridge.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

import { status } from '../src/daemon.mjs';
import { assertNoForeignBrowser } from './preflight.mjs';

const extensionDir = path.resolve(process.env.WEBBRIDGE_EXT_DIR || 'extension-slim');
const pdf = await readFile('test/sample.pdf');

const web = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length });
  response.end(pdf);
});
await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
const pdfUrl = `http://127.0.0.1:${web.address().port}/sample.pdf`;

await assertNoForeignBrowser('e2e-pdf');

const profile = await mkdtemp(path.join(tmpdir(), 'webbridge-pdf-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'msedge',
  headless: false,
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});
try {
  const deadline = Date.now() + 30_000;
  let state;
  while (Date.now() < deadline) {
    state = await status();
    if (state?.extension_connected) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(state?.extension_connected, 'extension did not connect');

  const client = new Client({ name: 'pdf-e2e', version: '0.0.0' }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('src/server.mjs')],
      env: { ...process.env, WEBBRIDGE_SESSION: 'pdf-e2e' },
      stderr: 'pipe',
    }),
  );
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${result.content.at(-1).text}`);
    return result;
  };

  await call('navigate', { url: pdfUrl, newTab: true });
  await call('wait', { text: 'Hello PDF webbridge', timeout_ms: 15000 });
  const read = await call('read_page', {});
  const text = read.content.at(-1).text;
  assert.match(text, /Hello PDF webbridge/, `PDF text missing: ${text.slice(0, 400)}`);
  console.log('pdf: ok');
  await call('close_session', {});
  await client.close();
} finally {
  await context.close().catch(() => {});
  web.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
