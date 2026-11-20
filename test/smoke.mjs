// Protocol-level smoke test without a browser: a fake daemon on a random port
// verifies both tool profiles, the on-demand catalog, argument checks, and
// direct forwarding.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const seen = [];
const imageDir = await mkdtemp(path.join(tmpdir(), 'webbridge-smoke-'));
const imagePath = path.join(imageDir, 'shot.png');
// 1x1 transparent PNG.
await writeFile(
  imagePath,
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

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
      if (payload.action === 'navigate' && payload.args.url === 'fail') {
        response.end(JSON.stringify({ ok: false, error: { code: 'extension_not_connected', message: 'no extension' } }));
      } else if (payload.action === 'screenshot') {
        response.end(JSON.stringify({ ok: true, data: { path: imagePath, mimeType: 'image/png', sizeBytes: 70 } }));
      } else {
        response.end(JSON.stringify({ ok: true, data: { success: true, echo: payload.action } }));
      }
    });
    return;
  }
  response.writeHead(404).end();
});

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const port = fake.address().port;

async function connect(toolset) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('src/server.mjs')],
    env: {
      ...process.env,
      WEBBRIDGE_URL: `http://127.0.0.1:${port}`,
      WEBBRIDGE_SESSION: 'smoke',
      WEBBRIDGE_CAPTURE_PORT: '0',
      WEBBRIDGE_TOOLSET: toolset,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: `smoke-${toolset}`, version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

const parse = (result) => JSON.parse(result.content.at(-1).text);

async function coreChecks() {
  const client = await connect('core');
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  assert.equal(tools.length, 13, `core should list 13 tools, got ${tools.length}`);
  for (const expected of [
    'status',
    'start',
    'session',
    'navigate',
    'snapshot',
    'click',
    'fill',
    'wait',
    'read_page',
    'screenshot',
    'close_session',
    'browser_tools',
    'browser_call',
  ]) {
    assert.ok(names.has(expected), `missing core tool ${expected}`);
  }
  for (const hidden of ['network', 'extract', 'evaluate', 'batch', 'request_human']) {
    assert.ok(!names.has(hidden), `core should hide ${hidden}`);
  }

  const overview = parse(await client.callTool({ name: 'browser_tools', arguments: {} }));
  assert.equal(overview.workflow.length, 8);
  assert.ok(overview.groups.some((group) => group.name === 'tabs'));
  assert.ok(overview.groups.some((group) => group.name === 'read'));
  assert.match(overview.hint, /browser_call/);

  const found = parse(await client.callTool({ name: 'browser_tools', arguments: { query: 'extract' } }));
  assert.equal(found.matches[0].name, 'extract');
  assert.match(found.matches[0].signature, /selector/);

  const described = parse(await client.callTool({ name: 'browser_tools', arguments: { tool: 'extract' } }));
  assert.ok(described.inputSchema.properties.selector);
  assert.ok(described.example.args.selector);

  const coreDescription = parse(await client.callTool({ name: 'browser_tools', arguments: { tool: 'click' } }));
  assert.match(coreDescription.note, /core tool/);

  const viaCall = await client.callTool({
    name: 'browser_call',
    arguments: { tool: 'hover', args: { selector: '#menu' } },
  });
  assert.match(viaCall.content.at(-1).text, /success/);
  assert.equal(seen.at(-1).action, 'hover');
  assert.deepEqual(seen.at(-1).args, { target: '#menu' });

  const typo = await client.callTool({ name: 'browser_call', arguments: { tool: 'clik' } });
  assert.equal(typo.isError, true);
  assert.match(typo.content[0].text, /Did you mean "click"/);

  const missing = await client.callTool({ name: 'browser_call', arguments: { tool: 'hover', args: {} } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /selector is required/);
  assert.match(missing.content[0].text, /browser_tools/);

  const badArg = await client.callTool({
    name: 'browser_call',
    arguments: { tool: 'hover', args: { selctor: '#x' } },
  });
  assert.equal(badArg.isError, true);
  assert.match(badArg.content[0].text, /unknown argument "selctor"/);

  const recursive = await client.callTool({ name: 'browser_call', arguments: { tool: 'browser_tools' } });
  assert.equal(recursive.isError, true);
  assert.match(recursive.content[0].text, /manages the catalog/);

  const hiddenCall = await client.callTool({ name: 'network', arguments: { cmd: 'start' } });
  assert.equal(hiddenCall.isError, true);
  assert.match(hiddenCall.content[0].text, /not in the core toolset/);

  const navigate = await client.callTool({ name: 'navigate', arguments: { url: 'https://example.com', newTab: true } });
  assert.match(navigate.content.at(-1).text, /success/);
  assert.equal(seen.at(-1).action, 'navigate');
  assert.equal(seen.at(-1).session, 'smoke');
  assert.deepEqual(seen.at(-1).args, { url: 'https://example.com', newTab: true });

  await client.callTool({ name: 'session', arguments: { name: 'second-task' } });
  await client.callTool({ name: 'click', arguments: { selector: '@e3' } });
  assert.equal(seen.at(-1).session, 'second-task');

  const batch = await client.callTool({
    name: 'browser_call',
    arguments: {
      tool: 'batch',
      args: {
        steps: [
          { tool: 'navigate', args: { url: 'https://example.com/a' } },
          { tool: 'click', args: { selector: '#go' } },
          { tool: 'definitely_not_a_tool', args: {} },
          { tool: 'click', args: { selector: '#never' } },
        ],
      },
    },
  });
  const batchData = parse(batch);
  assert.equal(batchData.steps.length, 3, 'batch should stop at the first failure');
  assert.equal(batchData.steps[0].ok, true);
  assert.equal(batchData.steps[1].ok, true);
  assert.equal(batchData.steps[2].ok, false);
  assert.equal(seen.at(-1).action, 'click');
  assert.equal(seen.at(-1).args.selector, '#go');

  const errored = await client.callTool({ name: 'navigate', arguments: { url: 'fail' } });
  assert.equal(errored.isError, true);
  assert.match(errored.content.at(-1).text, /extension_not_connected/);

  const screenshot = await client.callTool({ name: 'screenshot', arguments: {} });
  const image = screenshot.content.find((part) => part.type === 'image');
  assert.ok(image, 'screenshot should return an image block');
  assert.equal(image.mimeType, 'image/png');
  assert.ok(image.data.length > 0);

  const state = parse(await client.callTool({ name: 'status', arguments: {} }));
  assert.equal(state.toolset, 'core');
  assert.equal(state.tools, 13);
  assert.equal(state.extension_connected, true);

  await client.callTool({ name: 'close_session', arguments: {} });
  assert.equal(seen.at(-1).action, 'close_session');

  await client.close();
  console.log('smoke: core ok');
}

async function fullChecks() {
  const client = await connect('full');
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  assert.equal(tools.length, 40, `full should list 40 tools, got ${tools.length}`);
  for (const expected of ['navigate', 'network', 'extract', 'batch', 'request_human', 'evaluate']) {
    assert.ok(names.has(expected), `missing full tool ${expected}`);
  }
  assert.ok(!names.has('browser_tools'), 'full lists tools directly');
  assert.ok(!names.has('browser_call'), 'full lists tools directly');

  const navigate = await client.callTool({ name: 'navigate', arguments: { url: 'https://example.com' } });
  assert.match(navigate.content.at(-1).text, /success/);

  const history = await client.callTool({ name: 'history', arguments: { action: 'back' } });
  assert.match(history.content.at(-1).text, /success/);
  assert.equal(seen.at(-1).action, 'go_back');

  const batch = await client.callTool({
    name: 'batch',
    arguments: { steps: [{ tool: 'click', args: { selector: '#go' } }] },
  });
  assert.equal(parse(batch).steps[0].ok, true);

  const invalid = await client.callTool({ name: 'click', arguments: { selector: '#x', selctor: '#y' } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /unknown argument "selctor"/);

  const state = parse(await client.callTool({ name: 'status', arguments: {} }));
  assert.equal(state.toolset, 'full');
  assert.equal(state.tools, 40);

  await client.close();
  console.log('smoke: full ok');
}

await coreChecks();
await fullChecks();

fake.close();
await rm(imageDir, { recursive: true, force: true });
console.log('smoke: ok');
