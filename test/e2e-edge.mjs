// End-to-end test: launch Edge with the unpacked companion extension, let it
// attach to the local daemon, then drive the browser through the MCP server.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

import { status } from '../src/daemon.mjs';
import { assertNoForeignBrowser } from './preflight.mjs';

const extensionDir = path.resolve(process.env.WEBBRIDGE_EXT_DIR || 'extension-slim');
const pageHtml = `<!doctype html><html><head><title>WebBridge E2E</title></head><body>
  <h1 id="title">Hello webbridge</h1>
  <p id="out">idle</p>
  <input id="name" aria-label="Name">
  <input id="typed" aria-label="Typed">
  <input id="file" type="file" aria-label="File">
  <input id="agree" type="checkbox" aria-label="Agree">
  <select id="size" aria-label="Size" onchange="this.dataset.changed='1'">
    <option value="s">Small</option>
    <option value="m">Medium</option>
    <option value="l">Large</option>
  </select>
  <div id="menu" onmouseover="this.dataset.hovered='1'">Menu
    <div id="menu-panel" hidden>Panel</div>
  </div>
  <div id="drag-src" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','x')">drag me</div>
  <div id="drop-zone" ondragover="event.preventDefault()" ondrop="document.getElementById('out').textContent='dropped'">drop here</div>
  <button id="go" onclick="document.getElementById('out').textContent='clicked:' + document.getElementById('name').value">Go</button>
  <table id="rows"><tbody>
    <tr><td class="name">Alpha</td><td class="qty">1</td></tr>
    <tr><td class="name">Beta</td><td class="qty">2</td></tr>
  </tbody></table>
  <div style="height:1600px"></div>
  <p id="bottom-anchor">Bottom anchor</p>
</body></html>`;

const web = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(pageHtml);
});
await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${web.address().port}/`;

await assertNoForeignBrowser('e2e-edge');

const profile = await mkdtemp(path.join(tmpdir(), 'webbridge-edge-'));
const captureDir = await mkdtemp(path.join(tmpdir(), 'webbridge-captures-'));
const CAPTURE_PORT = 10187;
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

const log = (message) => console.log(`e2e: ${message}`);

async function waitForPage(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = context.pages().find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}
const requests = new Set();
context.on('request', (request) => {
  try {
    requests.add(new URL(request.url()).hostname);
  } catch {
    // data:, blob:, about: and friends have no hostname.
  }
});
try {
  const deadline = Date.now() + 30_000;
  let state = null;
  while (Date.now() < deadline) {
    state = await status();
    if (state?.extension_connected) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(state?.extension_connected, `extension did not connect (last status: ${JSON.stringify(state)})`);
  log(`extension connected, version ${state.extension_version}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('src/server.mjs')],
    env: {
      ...process.env,
      WEBBRIDGE_SESSION: 'e2e-test',
      WEBBRIDGE_CAPTURE_DIR: captureDir,
      WEBBRIDGE_CAPTURE_PORT: String(CAPTURE_PORT),
      WEBBRIDGE_TOOLSET: 'full',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${result.content.at(-1).text}`);
    return result;
  };

  const nav = await call('navigate', { url: pageUrl, newTab: true, group_title: 'WebBridge E2E' });
  const navId = JSON.parse(nav.content.at(-1).text).tabId;
  log(`navigate ok, tabId ${navId}`);

  const snap = await call('snapshot', { format: 'aria', max_chars: 20000 });
  const snapText = snap.content.at(-1).text;
  assert.match(snapText, /Hello webbridge/);
  log('snapshot contains page heading');

  const read = await call('read_page', {});
  assert.match(read.content.at(-1).text, /Hello webbridge/);
  log('read_page ok');

  await call('console', { action: 'start' });
  await call('evaluate', { code: "console.log('hello-log'); console.warn('warn-1'); 'logged'" });
  const logs = JSON.parse((await call('console', { action: 'read', clear: true })).content.at(-1).text);
  assert.ok(logs.messages.some((m) => m.text.includes('hello-log')), JSON.stringify(logs));
  assert.ok(logs.messages.some((m) => m.level === 'warn' && m.text.includes('warn-1')));
  log('console capture ok');

  const rows = JSON.parse(
    (
      await call('extract', {
        selector: '#rows tr',
        fields: [{ name: 'name', selector: '.name' }, { name: 'qty', selector: '.qty' }],
      })
    ).content.at(-1).text,
  );
  assert.deepEqual(rows.items, [
    { name: 'Alpha', qty: '1' },
    { name: 'Beta', qty: '2' },
  ]);
  log('extract structured rows ok');

  const dialogState = JSON.parse((await call('dialog', { action: 'status' })).content.at(-1).text);
  assert.equal(typeof dialogState.open, 'boolean');
  log(`dialog status ok (open: ${dialogState.open})`);

  await call('find', { query: 'Hello' });
  await call('wait', { selector: '#go', timeout_ms: 5000 });
  const cdpEval = await call('cdp', {
    method: 'Runtime.evaluate',
    params: { expression: 'document.title', returnByValue: true },
  });
  assert.match(cdpEval.content.at(-1).text, /WebBridge E2E/);
  await call('network', { cmd: 'start' });
  await call('network', { cmd: 'list' });
  await call('network', { cmd: 'stop' });
  await call('find_tab', { url: '127.0.0.1' });
  assert.match((await call('list_browser_tabs', {})).content.at(-1).text, /tabId/);
  await call('upload', { selector: '#file', files: [path.resolve('test/sample.pdf')] });
  log('find/wait/cdp/network/find_tab/list_browser_tabs/upload ok');

  await call('fill', { selector: '#name', value: 'grok' });
  await call('click', { selector: '#go' });
  await call('mouse_click', { selector: '#go' });
  const after = await call('evaluate', {
    code: "(() => document.getElementById('out').textContent)()",
  });
  assert.match(after.content.at(-1).text, /clicked:grok/);
  log('fill + click + evaluate ok');

  await call('hover', { selector: '#menu' });
  const hoverState = await call('evaluate', { code: "(() => document.getElementById('menu').dataset.hovered || '')()" });
  assert.match(hoverState.content.at(-1).text, /"value": "1"/);

  await call('mouse_click', { selector: '#typed' });
  await call('key_type', { text: 'typed-ok' });
  const typed = await call('evaluate', { code: "(() => document.getElementById('typed').value)()" });
  assert.match(typed.content.at(-1).text, /typed-ok/);

  await call('select_option', { selector: '#size', value: 'm' });
  const selectState = await call('evaluate', {
    code: "(() => ({ value: document.getElementById('size').value, changed: document.getElementById('size').dataset.changed }))()",
  });
  assert.match(selectState.content.at(-1).text, /"value": "m"/);
  assert.match(selectState.content.at(-1).text, /"changed": "1"/);

  await call('set_checked', { selector: '#agree', checked: true });
  const checkedOn = await call('evaluate', { code: "(() => document.getElementById('agree').checked)()" });
  assert.match(checkedOn.content.at(-1).text, /"value": true/);
  await call('set_checked', { selector: '#agree', checked: false });
  const checkedOff = await call('evaluate', { code: "(() => document.getElementById('agree').checked)()" });
  assert.match(checkedOff.content.at(-1).text, /"value": false/);

  await call('scroll', { to: 'bottom' });
  const scrolled = JSON.parse((await call('evaluate', { code: '(() => window.scrollY)()' })).content.at(-1).text);
  assert.ok(scrolled.value > 100, `scrollY ${scrolled.value}`);
  await call('scroll', { text: 'Bottom anchor' });
  const anchored = JSON.parse((await call('evaluate', { code: '(() => window.scrollY)()' })).content.at(-1).text);
  assert.ok(anchored.value > 500, `scroll-to-text Y ${anchored.value}`);
  await call('scroll', { selector: '#title' });
  log('hover + key_type + select_option + set_checked + scroll ok');

  const dragged = JSON.parse((await call('drag', { from: '#drag-src', to: '#drop-zone' })).content.at(-1).text);
  assert.equal(dragged.mode, 'html5', JSON.stringify(dragged));
  assert.equal(dragged.dropAccepted, true);
  const dropped = await call('evaluate', { code: "(() => document.getElementById('out').textContent)()" });
  assert.match(dropped.content.at(-1).text, /dropped/);
  log('drag html5 ok');

  const marked = JSON.parse((await call('highlight', { selector: '#go' })).content.at(-1).text);
  assert.ok(marked.highlight_id, JSON.stringify(marked));
  const cleared = JSON.parse(
    (await call('highlight', { action: 'clear', highlight_id: marked.highlight_id })).content.at(-1).text,
  );
  assert.equal(cleared.cleared, true);
  log('highlight show + clear ok');

  const activated = JSON.parse((await call('activate_tab', { focus_window: true })).content.at(-1).text);
  assert.equal(activated.active, true);

  await call('navigate', { url: `${pageUrl}?next=1` });
  await call('wait', { selector: '#title', timeout_ms: 5000 });
  await call('history', { action: 'back' });
  assert.match((await call('evaluate', { code: '(() => location.search)()' })).content.at(-1).text, /"value": ""/);
  await call('history', { action: 'forward' });
  assert.match((await call('evaluate', { code: '(() => location.search)()' })).content.at(-1).text, /next=1/);
  await call('history', { action: 'reload' });
  await call('wait', { selector: '#title', timeout_ms: 5000 });
  await call('navigate', { url: pageUrl });
  log('activate_tab + history ok');

  const shot = await call('screenshot', { format: 'png' });
  const image = shot.content.find((part) => part.type === 'image');
  assert.ok(image && image.data.length > 100, 'screenshot image block missing');
  log(`screenshot ok (${image.data.length} base64 chars)`);

  const pdf = await call('save_as_pdf', { path: path.join(captureDir, 'page.pdf') });
  assert.match(pdf.content.at(-1).text, /page\.pdf/);
  log('save_as_pdf ok');

  const cap = await call('capture_page', { tags: ['e2e'] });
  const capData = JSON.parse(cap.content.at(-1).text);
  assert.ok(capData.path.startsWith(captureDir), `capture path outside test dir: ${capData.path}`);
  const captured = await readFile(capData.path, 'utf8');
  assert.match(captured, /Hello webbridge/);
  assert.match(captured, /tags: \["e2e"\]/);
  assert.match(captured, /url: "http:\/\/127\.0\.0\.1:\d+\/"/);
  log(`capture_page wrote ${path.basename(capData.path)} (${capData.bytes} bytes)`);

  const worker =
    context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null));
  if (worker) {
    const extensionId = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.evaluate(
      async ({ port }) => {
        await chrome.storage.local.set({
          capture_url: `http://127.0.0.1:${port}/capture`,
          handoff_auto_open: false,
        });
        const [target] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            await chrome.tabs.update(target.id, { active: true });
            break;
          } catch (error) {
            if (attempt === 3) throw error;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
      },
      { port: CAPTURE_PORT },
    );
    await popup.evaluate(() => document.getElementById('capture').click());

    const deadline = Date.now() + 8000;
    let menuCapture = null;
    while (Date.now() < deadline && !menuCapture) {
      const files = (await readdir(captureDir)).filter((name) => name.endsWith('.md'));
      for (const file of files) {
        const text = await readFile(path.join(captureDir, file), 'utf8');
        if (/source: "extension"/.test(text)) menuCapture = { file, text };
      }
      if (!menuCapture) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.ok(menuCapture, 'extension capture did not reach the receiver');
    assert.match(menuCapture.text, /Hello webbridge/);
    const popupNote = await popup.locator('#note').textContent();
    assert.match(popupNote, /Captured:/);
    await popup.waitForTimeout(2400);
    const shownDir = await popup.locator('#captures').textContent();
    assert.ok(shownDir.includes(path.basename(captureDir)), `popup capture dir line: ${shownDir}`);
    const captureFiles = (await readdir(captureDir)).filter((name) => name.endsWith('.md'));
    assert.notEqual(menuCapture.file, path.basename(capData.path), 'extension capture overwrote the tool capture');
    log(`extension capture ok: ${menuCapture.file} (files: ${captureFiles.join(', ')})`);

    const humanCall = client.callTool({
      name: 'request_human',
      arguments: {
        reason: 'E2E sign-in',
        instructions: 'Press Continue in this test.',
        timeout_ms: 30000,
      },
    });
    await popup.waitForSelector('#handoff:not([hidden])', { timeout: 8000 });
    assert.match(await popup.locator('#handoff-reason').textContent(), /E2E sign-in/);
    await popup.evaluate(() => document.getElementById('handoff-resume').click());
    const humanResult = await humanCall;
    const humanData = JSON.parse(humanResult.content.at(-1).text);
    assert.equal(humanData.resumed, true);
    assert.equal(humanData.url, pageUrl);
    log('human handoff resumed from the popup');

    // Push channel: clear the alarm so only the loopback WebSocket can open
    // the prompt, then require it within a few seconds.
    await popup.evaluate(() => chrome.storage.local.set({ handoff_auto_open: true }));
    const alarmCleared = await popup.evaluate(() => chrome.alarms.clear('webbridge-handoff'));
    assert.equal(alarmCleared, true);
    await popup.evaluate(
      () =>
        new Promise((resolve) => {
          const channel = chrome.runtime.connect({ name: 'webbridge-capture' });
          channel.onMessage.addListener(() => {
            resolve();
            channel.disconnect();
          });
          channel.postMessage({ type: 'check' });
        }),
    );
    await popup.waitForTimeout(1500);
    const pushCall = client.callTool({
      name: 'request_human',
      arguments: { reason: 'Push handoff', instructions: 'Press Continue.', timeout_ms: 30000 },
    });
    const pushPrompt = await waitForPage((page) => page.url().includes('popup.html?handoff='), 5000);
    assert.ok(pushPrompt, 'push handoff prompt did not open');
    await pushPrompt.waitForFunction(
      () => document.getElementById('handoff-reason')?.textContent.includes('Push handoff'),
      { timeout: 5000 },
    );
    await pushPrompt.evaluate(() => document.getElementById('handoff-resume').click()).catch(() => {});
    const pushResult = JSON.parse((await pushCall).content.at(-1).text);
    assert.equal(pushResult.resumed, true);
    await pushPrompt.close().catch(() => {});
    await popup.waitForTimeout(500);
    log('push handoff prompt opened without an alarm tick');

    // Poll fallback: the same check the 30 s alarm runs.
    const autoCall = client.callTool({
      name: 'request_human',
      arguments: { reason: 'Auto handoff', instructions: 'Press Continue.', timeout_ms: 30000 },
    });
    let autoPrompt = null;
    for (let attempt = 0; attempt < 20 && !autoPrompt; attempt += 1) {
      await popup.evaluate(
        () =>
          new Promise((resolve) => {
            const channel = chrome.runtime.connect({ name: 'webbridge-capture' });
            channel.onMessage.addListener(() => {
              resolve();
              channel.disconnect();
            });
            channel.postMessage({ type: 'check' });
          }),
      );
      autoPrompt = await waitForPage((page) => page.url().includes('popup.html?handoff='), 300);
    }
    assert.ok(autoPrompt, 'auto handoff prompt window did not open');
    await autoPrompt.waitForFunction(
      () => document.getElementById('handoff-reason')?.textContent.includes('Auto handoff'),
      { timeout: 5000 },
    );
    assert.match(await autoPrompt.locator('#handoff-reason').textContent(), /Auto handoff/);
    await autoPrompt.evaluate(() => document.getElementById('handoff-resume').click()).catch(() => {});
    const autoResult = JSON.parse((await autoCall).content.at(-1).text);
    assert.equal(autoResult.resumed, true);
    log('poll fallback handoff prompt opened and resumed');

    await popup.close();
  } else {
    log('extension capture skipped: no service worker handle');
  }

  const tabs = await call('list_tabs', {});
  assert.match(tabs.content.at(-1).text, /e2e-test|WebBridge E2E|tabId/);
  log('list_tabs ok');

  // Core profile: the same browser through the reduced surface and the
  // on-demand catalog. This is the path a first-time agent sees by default.
  const core = new Client({ name: 'e2e-core', version: '0.0.0' }, { capabilities: {} });
  await core.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('src/server.mjs')],
      env: {
        ...process.env,
        WEBBRIDGE_SESSION: 'e2e-test',
        WEBBRIDGE_CAPTURE_DIR: captureDir,
        WEBBRIDGE_CAPTURE_PORT: '0',
        WEBBRIDGE_TOOLSET: 'core',
      },
      stderr: 'pipe',
    }),
  );
  const coreCall = async (name, args = {}) => {
    const result = await core.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`core ${name}: ${result.content.at(-1).text}`);
    return result;
  };
  const coreList = await core.listTools();
  assert.equal(coreList.tools.length, 13, `core listed ${coreList.tools.length} tools`);
  const coreOverview = JSON.parse((await coreCall('browser_tools')).content.at(-1).text);
  assert.equal(coreOverview.workflow.length, 8);
  const extractHelp = JSON.parse((await coreCall('browser_tools', { tool: 'extract' })).content.at(-1).text);
  assert.ok(extractHelp.inputSchema.properties.selector);
  const coreRows = JSON.parse(
    (
      await coreCall('browser_call', {
        tool: 'extract',
        args: { selector: '#rows tr', fields: [{ name: 'name', selector: '.name' }, { name: 'qty', selector: '.qty' }] },
      })
    ).content.at(-1).text,
  );
  assert.deepEqual(coreRows.items, [
    { name: 'Alpha', qty: '1' },
    { name: 'Beta', qty: '2' },
  ]);
  const coreHover = await coreCall('browser_call', { tool: 'hover', args: { selector: '#menu' } });
  assert.match(coreHover.content.at(-1).text, /hover|success/);
  const coreStatus = JSON.parse((await coreCall('status')).content.at(-1).text);
  assert.equal(coreStatus.toolset, 'core');
  assert.equal(coreStatus.tools, 13);
  await core.close();
  log('core profile: catalog + browser_call + 13 tools ok');

  const closed = await call('close_session', {});
  const closedData = JSON.parse(closed.content.at(-1).text);
  assert.ok(closedData.closed >= 1, `close_session closed ${closedData.closed}`);
  log(`close_session closed ${closedData.closed}`);

  if (process.env.EXPECT_NO_PRODUCT_TRAFFIC === '1') {
    const productHosts = [...requests].filter((host) =>
      /(^|\.)(kimi\.(com|ai)|volces\.com|moonshot\.(ai|cn))$/.test(host),
    );
    assert.deepEqual(productHosts, [], `product traffic found: ${productHosts.join(', ')}`);
    log(`no product traffic (hosts seen: ${[...requests].sort().join(', ')})`);

    const worker = context.serviceWorkers()[0];
    if (worker) {
      const extensionId = new URL(worker.url()).host;
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.waitForTimeout(1500);
      const daemonText = await popup.locator('#daemon').textContent();
      const linkText = await popup.locator('#link').textContent();
      assert.match(daemonText, /running/, `popup daemon line: ${daemonText}`);
      assert.match(linkText, /connected/, `popup link line: ${linkText}`);
      log(`popup ok: ${daemonText} / ${linkText}`);
      await popup.close();
    }
  }

  await client.close();
  log('ok');
} finally {
  await context.close().catch(() => {});
  web.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(captureDir, { recursive: true, force: true }).catch(() => {});
}
