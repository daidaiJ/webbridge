// Measure the Go and Node MCP front ends against one fake daemon. The numbers
// cover process startup, tools/list, per-call forwarding overhead, and RSS.
//
//   node test/bench-go.mjs
//
// The fake daemon answers immediately, so the call latency shows MCP and HTTP
// overhead rather than browser or page-load time.

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RUNS = Number(process.env.WEBBRIDGE_BENCH_RUNS || 6);
const CALLS = Number(process.env.WEBBRIDGE_BENCH_CALLS || 60);
const work = await mkdtemp(path.join(tmpdir(), 'webbridge-bench-'));
const goBinary = path.resolve('dist', process.platform === 'win32' ? 'webbridge-mcp.exe' : 'webbridge-mcp');

const fake = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/status') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ running: true, extension_connected: true, port: 1, version: 'bench' }));
    return;
  }
  if (request.method === 'POST' && request.url === '/command') {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data: { value: 'ok' } }));
    });
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const fakePort = fake.address().port;

function transportFor(kind, index, capturePort) {
  const env = {
    ...process.env,
    WEBBRIDGE_URL: `http://127.0.0.1:${fakePort}`,
    WEBBRIDGE_TOOLSET: 'full',
    WEBBRIDGE_SESSION: 'bench',
    WEBBRIDGE_CAPTURE_PORT: String(capturePort),
    WEBBRIDGE_STATE_DIR: path.join(work, `${kind}-state-${index}`),
    WEBBRIDGE_IDLE_MS: '0',
    WEBBRIDGE_AUTOSTART: '0',
  };
  return new StdioClientTransport({
    command: kind === 'go' ? goBinary : process.execPath,
    args: kind === 'go' ? [] : [path.resolve('src/server.mjs')],
    env,
    stderr: 'ignore',
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function rssBytes(pid) {
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`],
      { encoding: 'utf8' },
    );
    return Number(output.trim()) || 0;
  } catch {
    return 0;
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

async function coldRun(kind, index) {
  const capturePort = await freePort();
  const transport = transportFor(kind, index, capturePort);
  const client = new Client({ name: `bench-${kind}`, version: '0.0.0' }, { capabilities: {} });
  const started = performance.now();
  await client.connect(transport);
  const connected = performance.now();
  const { tools } = await client.listTools();
  const listed = performance.now();
  const pid = transport.pid;
  const rss = rssBytes(pid);
  const payloadBytes = Buffer.byteLength(JSON.stringify(tools));
  await client.close();
  return {
    connect: connected - started,
    list: listed - connected,
    rss,
    payloadBytes,
    tools: tools.length,
  };
}

async function callRun(kind, index) {
  const capturePort = await freePort();
  const transport = transportFor(kind, index, capturePort);
  const client = new Client({ name: `bench-call-${kind}`, version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  await client.listTools();
  const idleRss = rssBytes(transport.pid);
  const samples = [];
  for (let callIndex = 0; callIndex < CALLS; callIndex += 1) {
    const started = performance.now();
    const result = await client.callTool({ name: 'evaluate', arguments: { code: '1' } });
    samples.push(performance.now() - started);
    if (result.isError) throw new Error(`${kind}: evaluate failed`);
  }
  const loadedRss = rssBytes(transport.pid);
  await client.close();
  return { samples, idleRss, loadedRss };
}

const results = { node: { cold: [], calls: null }, go: { cold: [], calls: null } };
for (let index = 0; index < RUNS; index += 1) {
  results.node.cold.push(await coldRun('node', index));
  results.go.cold.push(await coldRun('go', index));
}
results.node.calls = await callRun('node', 100);
results.go.calls = await callRun('go', 101);

function fileSize(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function summarize(kind) {
  const cold = results[kind].cold;
  const calls = results[kind].calls;
  return {
    connectP50: percentile(cold.map((run) => run.connect), 0.5),
    listP50: percentile(cold.map((run) => run.list), 0.5),
    callP50: percentile(calls.samples, 0.5),
    callP95: percentile(calls.samples, 0.95),
    idleRss: calls.idleRss,
    loadedRss: calls.loadedRss,
    payload: cold[0].payloadBytes,
    tools: cold[0].tools,
  };
}

const node = summarize('node');
const go = summarize('go');
const goBinarySize = await stat(goBinary);
const nodeServer = await stat(path.resolve('src/server.mjs'));
const packageJSON = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));

console.log('runtime | connect p50 | tools/list p50 | call p50 | call p95 | RSS idle | RSS loaded | tools payload');
console.log('--- | --- | --- | --- | --- | --- | --- | ---');
for (const [name, value] of [
  ['node', node],
  ['go', go],
]) {
  console.log(
    `${name} | ${value.connectP50.toFixed(1)} ms | ${value.listP50.toFixed(1)} ms | ` +
      `${value.callP50.toFixed(2)} ms | ${value.callP95.toFixed(2)} ms | ` +
      `${(value.idleRss / 1048576).toFixed(1)} MB | ${(value.loadedRss / 1048576).toFixed(1)} MB | ` +
      `${fileSize(value.payload)} (${value.tools} tools)`,
  );
}
console.log('');
console.log(`Go binary: ${fileSize(goBinarySize.size)}`);
console.log(`Node server file: ${fileSize(nodeServer.size)}; runtime dependency: ${packageJSON.dependencies['@modelcontextprotocol/sdk']}`);
console.log(`calls: ${CALLS} per runtime; cold runs: ${RUNS}`);

function improvement(from, to) {
  return `${(((from - to) / from) * 100).toFixed(1)}% lower`;
}
console.log('');
console.log(`cold start: ${improvement(node.connectP50, go.connectP50)}`);
console.log(`tools/list: ${improvement(node.listP50, go.listP50)}`);
console.log(`call p50: ${improvement(node.callP50, go.callP50)}`);
console.log(`idle RSS: ${improvement(node.idleRss, go.idleRss)}`);
console.log(`loaded RSS: ${improvement(node.loadedRss, go.loadedRss)}`);

fake.close();
await rm(work, { recursive: true, force: true });
