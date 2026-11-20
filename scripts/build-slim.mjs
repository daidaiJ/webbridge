// Build a slim, product-free extension from the upstream Browser Bridge bundle.
//
// Kept: the browser tool layer (background.js), on-demand page readers
//       (frame-read.js, native-pdf-read.js), icons, the WebSocket bridge.
// Removed: the sidepanel agent and its chunks, login/quota/membership UI,
//          update checks and version drift, telemetry, selection/translate
//          features, onboarding videos, locales, KaTeX styling.
//
// Every patch below is an exact string replacement and fails loudly if the
// source bundle changes underneath it.

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { EXTRACT_SOURCE } from '../src/capture.mjs';
import { VERSION } from '../src/version.mjs';
import { pruneBackground } from './prune.mjs';

const source = path.resolve('extension');
const target = path.resolve('extension-slim');

const KEEP = ['background.js', 'frame-read.js', 'native-pdf-read.js'];

const manifest = {
  manifest_version: 3,
  name: 'Browser Bridge',
  description: 'Local-only bridge that lets MCP agents drive this browser, with the user\'s real logins.',
  version: VERSION,
  icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
  permissions: [
    'tabs',
    'debugger',
    'storage',
    'alarms',
    'tabGroups',
    'windows',
    'webNavigation',
    'webRequest',
    'scripting',
    'contextMenus',
    'downloads',
  ],
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'background.js' },
  action: {
    default_title: 'Browser Bridge',
    default_popup: 'popup.html',
    default_icon: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
  },
  content_security_policy: {
    extension_pages:
      "script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*;",
  },
  // Same key as the upstream bundle, so replacing the unpacked extension keeps its ID.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnzMRxFjdhEnk03bSz6Qr1Z8HUz2XCjBy2r4bUuIv0JVdPLs3jO2VcoGW1Z5TufRtwPSqVxRnD4Zj1VXWOo6mHo0Z9gB0a6SxUgE4Ng5ajCKlb/Yl46H2X7wNjzNDWRckGaKRtrXCkuvepuvlQCd8Onqzxm2YFwehLEJV4nWBzCX5bThLszkE1gMlSjtHvR4Z9f6j/akwrOfDQI8dYfVe2a5mliD58z2564SKHFV6kNNR6AZF5OWkAiLncn6iHhSq1IzaeewNBYQ5nq0l4ND6CcjI9zpYOkwvAvy3IdpVtIzcGe+oxOUIUkcrGLLalraYGLzxVOOwtbj1/n07ZNGKRQIDAQAB',
};

const patches = [
  {
    why: 'drop selection/translate/context-menu init, history UI and the update checker from startup',
    from: ',UB(),iV(),yV(),CV(),OH(),chrome.runtime.onInstalled.addListener(',
    to: ',chrome.runtime.onInstalled.addListener(',
  },
  {
    why: 'never open the side panel on toolbar click',
    from: 'openPanelOnActionClick:!0',
    to: 'openPanelOnActionClick:!1',
    all: true,
  },
  {
    why: 'keep the side panel disabled even if something calls setOptions',
    from: 'setOptions({path:ul,enabled:!0})',
    to: 'setOptions({path:ul,enabled:!1})',
  },
  {
    why: 'expose the bridge instance to the top-level control code',
    from: 'onStateChange:(e,t)=>{e===`connected`?gH(!0,t):hH(!1,t)}}),vH=',
    to: 'onStateChange:(e,t)=>{e===`connected`?gH(!0,t):hH(!1,t)}}),__wbBridge=globalThis.__wbBridge=_H,vH=',
  },
  {
    why: 'the install popup points at our page',
    from: 'FH=`install-welcome.html`',
    to: 'FH=`popup.html`',
  },
  {
    why: 'kill the product telemetry sender (gator.volces.com) at the source',
    from: 'async function al(e){let t=',
    to: 'async function al(e){return{ok:!0,status:204};let t=',
  },
  {
    why: 'point the update manifest fetch at a dead loopback port',
    from: 'vH=`https://cdn.kimi.com/webbridge/latest/version.json`',
    to: 'vH=`http://127.0.0.1:9/version.json`',
  },
];

const appended = `
// --- slim bridge control (added by scripts/build-slim.mjs) ---
const __wbBridge = globalThis.__wbBridge;
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!__wbBridge) {
    reply({ ok: false, error: 'bridge not ready' });
    return false;
  }
  if (msg?.type === 'WEBBRIDGE_STATE') {
    reply({ state: __wbBridge.state, url: __wbBridge.getServerUrl(), connected: __wbBridge.isConnected() });
    return false;
  }
  if (msg?.type === 'WEBBRIDGE_RECONNECT') {
    __wbBridge.reconcile().then(
      () => reply({ ok: true, state: __wbBridge.state }),
      (error) => reply({ ok: false, error: String(error?.message || error) }),
    );
    return true;
  }
  if (msg?.type === 'WEBBRIDGE_DISCONNECT') {
    __wbBridge.disconnect().then(
      () => reply({ ok: true }),
      (error) => reply({ ok: false, error: String(error?.message || error) }),
    );
    return true;
  }
  return false;
});
`;

async function directorySize(dir) {
  let total = 0;
  for (const entry of await import('node:fs/promises').then((fs) => fs.readdir(dir, { withFileTypes: true }))) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size;
  }
  return total;
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const entry of KEEP) {
  await cp(path.join(source, entry), path.join(target, entry), { recursive: true });
}
await cp(path.resolve('ui/icon'), path.join(target, 'icon'), { recursive: true });

let background = await readFile(path.join(target, 'background.js'), 'utf8');
for (const patch of patches) {
  const count = background.split(patch.from).length - 1;
  if (count === 0) throw new Error(`patch target not found (${patch.why}): ${patch.from.slice(0, 80)}`);
  if (!patch.all && count !== 1) throw new Error(`patch target found ${count} times (${patch.why})`);
  background = background.split(patch.from).join(patch.to);
}
background += appended;
background += (await readFile(path.resolve('ui/capture-init.js'), 'utf8')).replace(
  '__WB_EXTRACT_SOURCE__',
  EXTRACT_SOURCE,
);

if (process.env.WEBBRIDGE_NO_PRUNE !== '1') {
  const before = background.length;
  const pruned = await pruneBackground(background);
  background = pruned.code;
  console.log(
    `prune: removed ${pruned.removed} of ${pruned.totalDeclarations} top-level declarations ` +
      `(${(before / 1024).toFixed(0)} KB -> ${(background.length / 1024).toFixed(0)} KB)`,
  );
}
await writeFile(path.join(target, 'background.js'), background);
await writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(path.join(target, 'popup.html'), await readFile(path.resolve('ui/popup.html'), 'utf8'));
await writeFile(path.join(target, 'popup.js'), await readFile(path.resolve('ui/popup.js'), 'utf8'));
await writeFile(path.join(target, 'sidepanel.html'), await readFile(path.resolve('ui/popup.html'), 'utf8'));

const before = await directorySize(source);
const after = await directorySize(target);
console.log(`extension-slim: ${(after / 1024 / 1024).toFixed(1)} MB (source ${(before / 1024 / 1024).toFixed(1)} MB)`);
