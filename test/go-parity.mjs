// Compare the Node and Go MCP servers against one fake daemon. The test
// exercises the same calls in both profiles and checks the tool list, schema,
// forwarded actions, local tools, errors, screenshots, and capture output.
//
// Run after `npm run catalog:export && npm run go:build`:
//   node test/go-parity.mjs

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const work = await mkdtemp(path.join(tmpdir(), 'webbridge-parity-'));
const imagePath = path.join(work, 'shot.png');
await writeFile(imagePath, PNG);

const seen = [];
const pagePayload = {
  url: 'https://example.com/article',
  canonical: 'https://example.com/article',
  title: 'Parity & <Test>',
  text: 'Hello <world> & friends',
  chars: 24,
  truncated: false,
  lang: 'en',
  description: 'A page used by the parity test',
  links: [{ text: 'Docs', href: 'https://example.com/docs' }],
  messages: [{ level: 'log', text: 'hello' }],
  items: [{ name: 'one' }],
};

const fake = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/status') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ running: true, extension_connected: true, port: 1, version: 'test' }));
    return;
  }
  if (request.method === 'POST' && request.url === '/command') {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const payload = JSON.parse(body);
      seen.push(payload);
      response.writeHead(200, { 'content-type': 'application/json' });
      if (payload.action === 'navigate' && payload.args?.url === 'fail') {
        response.end(JSON.stringify({ ok: false, error: { code: 'extension_not_connected', message: 'no extension' } }));
        return;
      }
      if (payload.action === 'evaluate') {
        const code = String(payload.args?.code || '');
        if (code === 'location.href') {
          response.end(JSON.stringify({ ok: true, data: { value: 'https://example.com/current' } }));
          return;
        }
        response.end(JSON.stringify({ ok: true, data: { value: pagePayload } }));
        return;
      }
      if (payload.action === 'screenshot') {
        response.end(JSON.stringify({ ok: true, data: { path: imagePath, mimeType: 'image/png', sizeBytes: PNG.length } }));
        return;
      }
      response.end(JSON.stringify({ ok: true, data: { success: true, action: payload.action } }));
    });
    return;
  }
  response.writeHead(404).end();
});

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const fakePort = fake.address().port;

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function connect(kind, toolset, captureDir, stateDir, port) {
  const env = {
    ...process.env,
    WEBBRIDGE_URL: `http://127.0.0.1:${fakePort}`,
    WEBBRIDGE_SESSION: 'parity',
    WEBBRIDGE_TOOLSET: toolset,
    WEBBRIDGE_CAPTURE_PORT: String(port),
    WEBBRIDGE_CAPTURE_DIR: captureDir,
    WEBBRIDGE_STATE_DIR: stateDir,
    WEBBRIDGE_IDLE_MS: '0',
    WEBBRIDGE_AUTOSTART: '0',
  };
  const transport =
    kind === 'go'
      ? new StdioClientTransport({
          command: goBinary,
          args: [],
          env,
          stderr: 'ignore',
        })
      : new StdioClientTransport({
          command: process.execPath,
          args: [path.resolve('src/server.mjs')],
          env,
          stderr: 'ignore',
        });
  const client = new Client({ name: `parity-${kind}`, version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, port };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resumeFirstHandoff(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/handoff`);
    const { pending } = await response.json();
    if (pending.length > 0) {
      const id = pending[0].id;
      const resumed = await fetch(`http://127.0.0.1:${port}/handoff/${encodeURIComponent(id)}/resume`, {
        method: 'POST',
      });
      assert.equal(resumed.status, 200);
      return id;
    }
    await sleep(50);
  }
  throw new Error('handoff did not appear');
}

function parse(result) {
  const text = result.content.at(-1).text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizedTools(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

async function exercise(client, port, kind, captureDir, toolset) {
  const calls = [];
  const record = async (label, request) => {
    const result = await client.callTool(request);
    calls.push({ label, result });
    return result;
  };
  const direct = new Set(['status', 'session', 'navigate', 'screenshot', 'browser_tools', 'network']);
  const invoke = (name, args = {}) =>
    toolset === 'core' && !direct.has(name)
      ? client.callTool({ name: 'browser_call', arguments: { tool: name, args } })
      : client.callTool({ name, arguments: args });

  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  const watch = await (await fetch(`http://127.0.0.1:${port}/handoff/watch?wait_ms=50`)).json();
  assert.equal(health.ok, true);
  assert.deepEqual(watch.pending, []);

  const listed = normalizedTools((await client.listTools()).tools);
  await record('status', { name: 'status', arguments: {} });
  await record('start', { name: 'start', arguments: {} });
  await record('overview', { name: 'browser_tools', arguments: {} });
  await record('search', { name: 'browser_tools', arguments: { query: 'extract' } });
  await record('describe', { name: 'browser_tools', arguments: { tool: 'extract' } });
  if (toolset === 'core') {
    await record('describe-core', { name: 'browser_tools', arguments: { tool: 'click' } });
  }
  await record('session', { name: 'session', arguments: { name: 'parity-two' } });
  await record('navigate', { name: 'navigate', arguments: { url: 'https://example.com' } });
  calls.push({ label: 'history', result: await invoke('history', { action: 'back' }) });
  await record('hover', { name: 'browser_call', arguments: { tool: 'hover', args: { selector: '#menu' } } });
  await record('missing', { name: 'browser_call', arguments: { tool: 'hover', args: {} } });
  await record('typo', { name: 'browser_call', arguments: { tool: 'clik' } });
  await record('args-array', { name: 'browser_call', arguments: { tool: 'hover', args: [] } });
  await record('hidden', { name: 'network', arguments: { cmd: 'start' } });
  await record('fail', { name: 'navigate', arguments: { url: 'fail' } });
  calls.push({ label: 'reader', result: await invoke('read_article', { max_chars: 5000 }) });
  calls.push({ label: 'extract', result: await invoke('extract', { selector: '.item' }) });
  calls.push({ label: 'extract-invalid', result: await invoke('extract', { selector: '.item', fields: [{ selector: '.x' }] }) });
  calls.push({ label: 'console', result: await invoke('console', { action: 'read' }) });
  calls.push({
    label: 'batch',
    result: await invoke('batch', {
      steps: [
        { tool: 'navigate', args: { url: 'https://example.com/a' } },
        { tool: 'click', args: { selector: '#go' } },
        { tool: 'definitely_not_a_tool', args: {} },
        { tool: 'click', args: { selector: '#never' } },
      ],
    }),
  });
  calls.push({
    label: 'batch-invalid',
    result: await invoke('batch', { steps: [{ tool: 'click', args: {} }] }),
  });
  const screenshot = await record('screenshot', { name: 'screenshot', arguments: {} });
  const image = screenshot.content.find((part) => part.type === 'image');
  calls.push({
    label: 'capture',
    result: await invoke('capture_page', { tags: ['parity'], max_chars: 5000, screenshot: true }),
  });
  const capture = calls.at(-1).result;
  const humanCall = invoke('request_human', { reason: 'Parity check', instructions: 'Press Continue' });
  const handoffID = await resumeFirstHandoff(port);
  const human = await humanCall;
  calls.push({ label: 'human', result: human, handoffID });

  const captureData = parse(capture);
  const markdown = await readFile(captureData.path, 'utf8');
  const normalizedMarkdown = markdown.replace(/^captured_at: .*$/m, 'captured_at: <time>');
  const index = (await readFile(path.join(captureDir, 'index.jsonl'), 'utf8')).trim().split('\n').at(-1);
  const indexData = JSON.parse(index);
  return { listed, calls, image, captureData, normalizedMarkdown, indexData };
}

function comparableCall(call) {
  if (call.label === 'human') {
    const data = parse(call.result);
    return {
      label: call.label,
      isError: call.result.isError === true,
      data: { resumed: data.resumed, timeout: data.timeout, url: data.url, session: data.session },
    };
  }
  if (call.label === 'capture') {
    const data = parse(call.result);
    return {
      label: call.label,
      isError: call.result.isError === true,
      data: {
        chars: data.chars,
        truncated: data.truncated,
        title: data.title,
        url: data.url,
        bytes: data.bytes,
        screenshot: data.screenshot,
      },
    };
  }
  if (call.label === 'screenshot') {
    return {
      label: call.label,
      isError: call.result.isError === true,
      text: parse({ content: [call.result.content.at(-1)] }),
      hasImage: call.result.content.some((part) => part.type === 'image'),
    };
  }
  return { label: call.label, isError: call.result.isError === true, value: parse(call.result) };
}

const goBinary = path.resolve('dist', process.platform === 'win32' ? 'webbridge-mcp.exe' : 'webbridge-mcp');
try {
  await readFile(goBinary);
} catch {
  console.error(`go-parity: build ${goBinary} first (npm run go:build)`);
  process.exit(1);
}

for (const toolset of ['core', 'full']) {
  const nodeDir = path.join(work, `node-${toolset}-captures`);
  const goDir = path.join(work, `go-${toolset}-captures`);
  await mkdir(nodeDir, { recursive: true });
  await mkdir(goDir, { recursive: true });

  const nodePort = await freePort();
  const nodeConn = await connect('node', toolset, nodeDir, path.join(work, `node-${toolset}-state`), nodePort);
  const node = await exercise(nodeConn.client, nodePort, 'node', nodeDir, toolset);
  await nodeConn.client.close();

  const goPort = await freePort();
  const goConn = await connect('go', toolset, goDir, path.join(work, `go-${toolset}-state`), goPort);
  const go = await exercise(goConn.client, goPort, 'go', goDir, toolset);
  await goConn.client.close();

  assert.deepEqual(go.listed, node.listed, `${toolset}: tool definitions differ`);
  const expected = toolset === 'core' ? 13 : 40;
  assert.equal(go.listed.length, expected, `${toolset}: expected ${expected} tools`);

  assert.equal(node.calls.length, go.calls.length, `${toolset}: call count differs`);
  for (let index = 0; index < node.calls.length; index += 1) {
    const left = comparableCall(node.calls[index]);
    const right = comparableCall(go.calls[index]);
    assert.deepEqual(right, left, `${toolset}: ${node.calls[index].label} differs`);
  }

  assert.ok(node.image, `${toolset}: Node screenshot should include an image`);
  assert.ok(go.image, `${toolset}: Go screenshot should include an image`);
  assert.equal(go.image.mimeType, node.image.mimeType);
  assert.equal(go.image.data, node.image.data);

  assert.equal(go.normalizedMarkdown, node.normalizedMarkdown, `${toolset}: capture Markdown differs`);
  assert.equal(go.indexData.title, node.indexData.title);
  assert.equal(go.indexData.url, node.indexData.url);
  assert.equal(go.indexData.session, node.indexData.session);
  assert.deepEqual(go.indexData.tags, node.indexData.tags);

  console.log(`go-parity: ${toolset} ok (${go.listed.length} tools, ${go.calls.length} calls)`);
}

console.log('go-parity: ok');
fake.close();
await rm(work, { recursive: true, force: true });
