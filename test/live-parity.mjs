// Live parity check for the Node and Go MCP servers. This opens one real
// browser tab per runtime, exercises the content and capture tools, and
// compares the normalized results.
//
// Requires Edge with the Browser Bridge extension enabled:
//   npm run test:parity:live

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const work = await mkdtemp(path.join(tmpdir(), 'webbridge-live-parity-'));
const goBinary = path.resolve('dist', process.platform === 'win32' ? 'webbridge-mcp.exe' : 'webbridge-mcp');
const stateDir = path.join(work, 'state');
await mkdir(stateDir, { recursive: true });

// A daemon killed between runs leaves a pid file that blocks the next start.
// Clear it only when nothing is listening, so a real daemon is left alone.
try {
  await fetch('http://127.0.0.1:10086/status');
} catch {
  await rm(path.join(homedir(), '.kimi-webbridge', 'daemon.pid'), { force: true });
  await rm(path.join(homedir(), '.webbridge', 'daemon-start.lock'), { force: true });
}

async function connect(kind, captureDir, session) {
  const env = {
    ...process.env,
    WEBBRIDGE_TOOLSET: 'full',
    WEBBRIDGE_SESSION: session,
    WEBBRIDGE_CAPTURE_PORT: '0',
    WEBBRIDGE_CAPTURE_DIR: captureDir,
    WEBBRIDGE_STATE_DIR: stateDir,
    WEBBRIDGE_IDLE_MS: '0',
  };
  const transport = new StdioClientTransport({
    command: kind === 'go' ? goBinary : process.execPath,
    args: kind === 'go' ? [] : [path.resolve('src/server.mjs')],
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: `live-${kind}`, version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function parse(result) {
  const text = result.content.at(-1)?.text || '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  assert.notEqual(result.isError, true, `${name}: ${result.content.at(-1)?.text}`);
  return parse(result);
}

async function run(kind, captureDir, session) {
  await mkdir(captureDir, { recursive: true });
  const client = await connect(kind, captureDir, session);
  try {
    await call(client, 'session', { name: session });
    const navigation = await call(client, 'navigate', {
      url: 'https://example.com',
      newTab: true,
      group_title: 'webbridge live parity',
    });
    assert.equal(navigation.success, true);

    const page = await call(client, 'read_page', { max_chars: 2000 });
    const article = await call(client, 'read_article', { max_chars: 5000 });
    const aria = await call(client, 'snapshot', { format: 'aria', max_chars: 3000 });
    const extraction = await call(client, 'extract', { selector: 'a' });
    const evaluated = await call(client, 'evaluate', {
      code: '(() => ({ title: document.title, url: location.href, h1: document.querySelector("h1")?.textContent || "" }))()',
    });

    await call(client, 'activate_tab', { focus_window: true });
    const shot = await client.callTool({ name: 'screenshot', arguments: {} }, undefined, { timeout: 90_000 });
    assert.notEqual(shot.isError, true, `screenshot: ${shot.content.at(-1)?.text}`);
    const shotImage = shot.content.find((part) => part.type === 'image');
    assert.ok(shotImage, 'screenshot should include an image');
    const shotData = parse(shot);
    const screenshot = {
      format: shotData.format,
      mimeType: shotImage.mimeType,
      imageBytes: Buffer.from(shotImage.data, 'base64').length,
    };

    await call(client, 'console', { action: 'start' });
    await call(client, 'evaluate', { code: "(() => { console.log('live-parity'); return true; })()" });
    const consoleRead = await call(client, 'console', { action: 'read', clear: true });

    const capture = await call(client, 'capture_page', {
      dir: captureDir,
      tags: ['live-parity'],
      max_chars: 5000,
    });
    const markdown = await readFile(capture.path, 'utf8');
    await call(client, 'close_session');
    return {
      page,
      article,
      aria: typeof aria === 'string' ? aria : aria.tree_text ?? aria.text,
      extraction,
      evaluated,
      screenshot,
      consoleRead,
      capture: {
        title: capture.title,
        url: capture.url,
        chars: capture.chars,
        truncated: capture.truncated,
      },
      markdown: markdown.replace(/^captured_at: .*$/m, 'captured_at: <time>'),
    };
  } finally {
    await client.close();
  }
}

try {
  await readFile(goBinary);
} catch {
  console.error(`live-parity: build ${goBinary} first (npm run go:build)`);
  process.exit(1);
}

const nodeDir = path.join(work, 'node-captures');
const goDir = path.join(work, 'go-captures');
const node = await run('node', nodeDir, 'live-parity-node');
await new Promise((resolve) => setTimeout(resolve, 2000));
const go = await run('go', goDir, 'live-parity-go');

assert.equal(go.page.url, node.page.url);
assert.equal(go.page.title, node.page.title);
assert.equal(go.page.text, node.page.text);
assert.equal(go.article.text, node.article.text);
assert.equal(go.article.title, node.article.title);
assert.equal(go.article.url, node.article.url);
assert.equal(go.aria.replace(/e\d+/g, 'e'), node.aria.replace(/e\d+/g, 'e'));
assert.deepEqual(go.extraction.items, node.extraction.items);
assert.deepEqual(go.evaluated, node.evaluated);
assert.equal(go.screenshot.format, node.screenshot.format);
assert.equal(go.screenshot.mimeType, node.screenshot.mimeType);
assert.ok(go.screenshot.imageBytes > 0);
assert.ok(Math.abs(go.screenshot.imageBytes - node.screenshot.imageBytes) < 20_000, 'screenshot sizes should be close');
assert.deepEqual(
  go.consoleRead.messages.map((message) => ({ level: message.level, text: message.text })),
  node.consoleRead.messages.map((message) => ({ level: message.level, text: message.text })),
);
assert.deepEqual(go.capture, node.capture);
assert.equal(go.markdown, node.markdown);

console.log('live-parity: ok');
await rm(work, { recursive: true, force: true });
