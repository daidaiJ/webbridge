// Verify that the Node and Go MCP servers can share one lazily started daemon.
// A Node client starts it, a Go client joins with its own lease, the Node client
// leaves without stopping it, and the Go client stops it on exit.
//
//   npm run go:build && node test/live-shared.mjs

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const work = await mkdtemp(path.join(tmpdir(), 'webbridge-live-shared-'));
const stateDir = path.join(work, 'state');
const goBinary = path.resolve('dist', process.platform === 'win32' ? 'webbridge-mcp.exe' : 'webbridge-mcp');
const daemonURL = 'http://127.0.0.1:10086';

try {
  await fetch(`${daemonURL}/status`);
} catch {
  await rm(path.join(homedir(), '.kimi-webbridge', 'daemon.pid'), { force: true });
  await rm(path.join(homedir(), '.webbridge', 'daemon-start.lock'), { force: true });
}

async function connect(kind) {
  const env = {
    ...process.env,
    WEBBRIDGE_TOOLSET: 'full',
    WEBBRIDGE_SESSION: 'live-shared',
    WEBBRIDGE_CAPTURE_PORT: '0',
    WEBBRIDGE_STATE_DIR: stateDir,
    WEBBRIDGE_IDLE_MS: '0',
  };
  const transport = new StdioClientTransport({
    command: kind === 'go' ? goBinary : process.execPath,
    args: kind === 'go' ? [] : [path.resolve('src/server.mjs')],
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: `shared-${kind}`, version: '0.0.0' }, { capabilities: {} });
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

async function daemonState() {
  try {
    const response = await fetch(`${daemonURL}/status`);
    return await response.json();
  } catch {
    return { running: false };
  }
}

const nodeClient = await connect('node');
await call(nodeClient, 'navigate', {
  url: 'https://example.com',
  newTab: true,
  group_title: 'webbridge live shared',
});
const started = await daemonState();
assert.equal(started.running, true);

const goClient = await connect('go');
const joined = await call(goClient, 'status');
assert.equal(joined.running, true);
assert.equal(joined.extension_connected, true);
const page = await call(goClient, 'read_page', { max_chars: 1000 });
assert.match(page.text, /This domain is for use in documentation/);
assert.match(page.text, /Source: https:\/\/example\.com\//);

await nodeClient.close();
await new Promise((resolve) => setTimeout(resolve, 1500));
const survivor = await daemonState();
assert.equal(survivor.running, true, 'daemon should stay alive while the Go lease exists');

const state = await call(goClient, 'status');
assert.equal(state.running, true);
await call(goClient, 'close_session');
await goClient.close();
await new Promise((resolve) => setTimeout(resolve, 2000));
const stopped = await daemonState();
assert.equal(stopped.running, false, 'last lease should stop the daemon');

console.log('live-shared: ok');
await rm(work, { recursive: true, force: true });
