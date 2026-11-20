// Focused tests for page capture: Markdown shape, file/index output, and the
// localhost receiver the extension posts to.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { captureCurrentTab, persistCapture, startCaptureReceiver, toMarkdown } from '../src/capture.mjs';
import { openHandoff } from '../src/handoff.mjs';

const page = {
  title: 'Capture: test / page',
  url: 'https://example.com/post?a=1',
  canonical: 'https://example.com/post',
  description: 'A page about capturing.',
  lang: 'en',
  text: '# Heading\n\nBody text.\n',
  chars: 24,
  truncated: false,
  links: [{ text: 'More', href: 'https://example.com/more' }],
  selected: '',
};

const markdown = toMarkdown(page, ['docs', 'note'], undefined);
assert.match(markdown, /^---\n/);
assert.match(markdown, /url: "https:\/\/example\.com\/post\?a=1"/);
assert.match(markdown, /canonical: "https:\/\/example\.com\/post"/);
assert.match(markdown, /tags: \["docs", "note"\]/);
assert.match(markdown, /captured_at: \d{4}-\d{2}-\d{2}T/);
assert.match(markdown, /# Capture: test \/ page/);
assert.match(markdown, /## Links\n\n- \[More\]\(https:\/\/example\.com\/more\)/);

const dir = await mkdtemp(path.join(tmpdir(), 'webbridge-capture-'));
try {
  // 1. Tool path: one evaluate call produces a file plus an index line.
  const calls = [];
  const fakeCall = async (action, args) => {
    calls.push({ action, args });
    return { value: page };
  };
  const saved = await captureCurrentTab(
    { dir, tags: ['unit'], session: 'test', maxChars: 5000 },
    { callTool: fakeCall },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'evaluate');
  assert.match(calls[0].args.code, /^\(\s*function \(maxChars, selected\)/);
  assert.ok(saved.path.startsWith(dir), saved.path);
  assert.match(path.basename(saved.path), /^\d{8}-\d{6}-Capture-test-page\.md$/);
  assert.equal(saved.chars, 24);
  assert.equal(saved.truncated, false);

  const body = await readFile(saved.path, 'utf8');
  assert.match(body, /tags: \["unit"\]/);
  assert.match(body, /# Capture: test \/ page/);
  const indexLines = (await readFile(path.join(dir, 'index.jsonl'), 'utf8')).trim().split('\n');
  const entry = JSON.parse(indexLines.at(-1));
  assert.equal(entry.url, page.url);
  assert.deepEqual(entry.tags, ['unit']);
  assert.equal(entry.session, 'test');
  assert.equal(entry.path, saved.path);

  // 2. Receiver path: the extension posts JSON, the same writer persists it.
  const receiver = startCaptureReceiver({ port: 0, dir });
  await new Promise((resolve, reject) => {
    receiver.server.once('listening', resolve);
    receiver.server.once('error', reject);
  });
  const { port } = receiver.server.address();
  const response = await fetch(`http://127.0.0.1:${port}/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: { ...page, title: 'From the menu' }, tags: ['bookmark'], session: 'extension' }),
  });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.ok, true);
  assert.match(path.basename(receipt.path), /From-the-menu\.md$/);
  assert.match(await readFile(receipt.path, 'utf8'), /source: "extension"/);

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.dir, dir);

  const rejected = await fetch(`http://127.0.0.1:${port}/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: { title: 'no text' } }),
  });
  assert.equal(rejected.status, 400);

  // 2b. Same title in the same second must produce two files.
  const firstCapture = await persistCapture({ page: { ...page, title: 'Same second' }, dir, tags: [] });
  const secondCapture = await persistCapture({ page: { ...page, title: 'Same second' }, dir, tags: [] });
  assert.notEqual(firstCapture.path, secondCapture.path, 'collision suffix missing');
  assert.ok((await readFile(secondCapture.path, 'utf8')).includes('Same second'));

  // 3. A selection is recorded in the frontmatter, not silently dropped.
  await persistCapture({ page: { ...page, selected: 'quoted words', title: 'Selection' }, dir, tags: [] });
  const selectionFile = (await readdir(dir)).filter((name) => name.endsWith('-Selection.md')).at(-1);
  assert.match(await readFile(path.join(dir, selectionFile), 'utf8'), /selection: true\n[\s\S]*quoted words/);

  // 4. Handoff: listed, long-polled, resumed over HTTP, and cleared.
  const base = `http://127.0.0.1:${port}`;
  const handoff = openHandoff({
    reason: 'Sign in',
    instructions: 'Use your account, then press Continue.',
    session: 'test',
    url: 'https://example.com/private',
    timeoutMs: 5000,
  });
  const listed = await fetch(`${base}/handoff`).then((r) => r.json());
  assert.equal(listed.pending.length, 1);
  assert.equal(listed.pending[0].id, handoff.id);
  assert.equal(listed.pending[0].reason, 'Sign in');

  const watched = await fetch(`${base}/handoff/watch?wait_ms=5000`).then((r) => r.json());
  assert.equal(watched.pending[0].id, handoff.id);

  const resumed = await fetch(`${base}/handoff/${handoff.id}/resume`, { method: 'POST' }).then((r) => r.json());
  assert.equal(resumed.ok, true);
  const outcome = await handoff.wait;
  assert.equal(outcome.resumed, true);
  assert.equal(outcome.handoff_id, handoff.id);
  assert.deepEqual((await fetch(`${base}/handoff`).then((r) => r.json())).pending, []);

  const unknownHandoff = await fetch(`${base}/handoff/nope/resume`, { method: 'POST' });
  assert.equal(unknownHandoff.status, 404);

  // The long-poll wakes when a new handoff appears.
  const watching = fetch(`${base}/handoff/watch?wait_ms=5000`).then((r) => r.json());
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = openHandoff({ reason: 'Captcha', session: 'test', url: '', timeoutMs: 5000 });
  const woken = await watching;
  assert.equal(woken.pending[0].id, second.id);
  second.finish({ resumed: false, timeout: true });

  // 5. Push channel: the extension's WebSocket receives current state on
  // connect (hello) and a new frame whenever the pending list changes.
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  socket.addEventListener('message', (event) => messages.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('push socket did not open')), { once: true });
  });
  const waitForPush = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const hit = messages.find(predicate);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  };
  assert.ok(await waitForPush((message) => message.type === 'hello'), 'ws hello missing');
  const pushed = openHandoff({ reason: 'Pushed', session: 'test', url: '', timeoutMs: 5000 });
  const pushedFrame = await waitForPush(
    (message) => message.type === 'handoff' && message.pending?.some((item) => item.id === pushed.id),
  );
  assert.ok(pushedFrame, 'handoff push missing');
  pushed.finish({ resumed: false, timeout: true });
  socket.close();

  // 6. Origin gate: a web page cannot read handoff state or open the socket.
  const webProbe = await fetch(`http://127.0.0.1:${port}/handoff`, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(webProbe.status, 200);
  assert.equal(webProbe.headers.get('access-control-allow-origin'), null);
  const extensionProbe = await fetch(`http://127.0.0.1:${port}/handoff`, {
    headers: { origin: 'chrome-extension://abcdefghijklmnop' },
  });
  assert.equal(extensionProbe.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnop');

  const upgradeStatus = (origin) =>
    new Promise((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/ws',
        agent: false,
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          origin,
        },
      });
      request.on('upgrade', (response, upgradeSocket) => {
        upgradeSocket.destroy();
        resolve(response.statusCode);
      });
      request.on('response', (response) => resolve(response.statusCode));
      request.on('error', reject);
      request.end();
    });
  assert.equal(await upgradeStatus('https://evil.example'), 403);
  assert.equal(await upgradeStatus('chrome-extension://abcdefghijklmnop'), 101);

  receiver.server.close();
  console.log('capture: ok');
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
