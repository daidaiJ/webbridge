// Appended to the slim background worker by scripts/build-slim.mjs.
// Adds one context-menu item and one popup action that turn the page the user
// is looking at into Markdown, either through the local capture receiver
// (configurable directory) or, when the receiver is not running, through the
// browser's normal download folder.

const __wbExtract = __WB_EXTRACT_SOURCE__;
const __WB_CAPTURE_DEFAULT = 'http://127.0.0.1:10087/capture';
const __WB_MENU_ID = 'webbridge-capture';

function __wbStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function __wbSlug(title) {
  const slug = (title || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return slug || 'capture';
}

function __wbFrontmatter(page, tags) {
  const lines = ['---', `url: ${JSON.stringify(page.url || '')}`];
  if (page.canonical && page.canonical !== page.url) {
    lines.push(`canonical: ${JSON.stringify(page.canonical)}`);
  }
  lines.push(`title: ${JSON.stringify(page.title || '')}`);
  lines.push(`captured_at: ${new Date().toISOString()}`);
  if (page.lang) lines.push(`lang: ${JSON.stringify(page.lang)}`);
  if (page.description) lines.push(`description: ${JSON.stringify(page.description)}`);
  if (page.selected) lines.push('selection: true');
  if (tags.length > 0) lines.push(`tags: [${tags.map((tag) => JSON.stringify(tag)).join(', ')}]`);
  lines.push('source: context-menu', '---', '');
  return lines.join('\n');
}

function __wbMarkdown(page, tags) {
  const parts = [__wbFrontmatter(page, tags), `# ${page.title || page.url || 'Captured page'}`, ''];
  if (page.selected) parts.push('> Selected text', '', page.selected, '');
  parts.push(page.text || '', '');
  if (Array.isArray(page.links) && page.links.length > 0) {
    parts.push('## Links', '');
    for (const link of page.links) parts.push(`- [${link.text || link.href}](${link.href})`);
    parts.push('');
  }
  return parts.join('\n');
}

function __wbBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function __wbBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color: color || '#2e7d32' });
  chrome.action.setBadgeText({ text });
  if (text) setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
}

let __wbCapturing = false;

async function __wbCapture(tabId, selected) {
  if (__wbCapturing) return { ok: false, error: 'a capture is already running' };
  __wbCapturing = true;
  try {
    return await __wbCaptureOnce(tabId, selected);
  } finally {
    __wbCapturing = false;
  }
}

async function __wbCaptureOnce(tabId, selected) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: __wbExtract,
    args: [120000, selected || ''],
  });
  const page = injection?.result;
  if (!page || typeof page.text !== 'string') throw new Error('nothing to capture on this page');

  const name = `${__wbStamp()}-${__wbSlug(page.title)}`;
  let saved = false;
  try {
    const settings = await chrome.storage.local.get('capture_url');
    const endpoint = settings.capture_url || __WB_CAPTURE_DEFAULT;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page, tags: ['bookmark'], session: 'extension' }),
      signal: AbortSignal.timeout(2500),
    });
    saved = response.ok;
  } catch {
    // Receiver not running: fall through to a normal download.
  }
  if (!saved) {
    const markdown = __wbMarkdown(page, ['bookmark']);
    await chrome.downloads.download({
      url: `data:text/markdown;charset=utf-8;base64,${__wbBase64(markdown)}`,
      filename: `webbridge/${name}.md`,
      conflictAction: 'uniquify',
      saveAs: false,
    });
  }
  __wbBadge('✓');
  return { ok: true, title: page.title, saved };
}

function __wbEnsureMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: __WB_MENU_ID,
      title: 'Capture page for agent',
      contexts: ['page', 'selection'],
    });
  });
}

chrome.runtime.onInstalled.addListener(__wbEnsureMenu);
chrome.runtime.onStartup.addListener(__wbEnsureMenu);
__wbEnsureMenu();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== __WB_MENU_ID || !tab?.id) return;
  __wbCapture(tab.id, info.selectionText || '').catch((error) => {
    console.warn('webbridge: capture failed', error);
    __wbBadge('!', '#b3541e');
  });
});

// Ports carry capture replies: another listener in the bundle already answers
// unknown runtime messages, so runtime.sendMessage cannot be used here.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'webbridge-capture') return;
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'check') {
      __wbEnsurePush();
      __wbCheckHandoff().then(
        () => port.postMessage({ ok: true }),
        (error) => port.postMessage({ ok: false, error: String(error?.message || error) }),
      );
      return;
    }
    const task = Number.isInteger(msg?.tabId)
      ? __wbCapture(msg.tabId, msg.selection || '')
      : __wbCaptureActive(msg?.selection || '');
    task.then(
      (result) => port.postMessage(result),
      (error) => port.postMessage({ ok: false, error: String(error?.message || error) }),
    );
  });
});

async function __wbCaptureActive(selected) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || /^(chrome|edge|about|chrome-extension):/i.test(tab.url || '')) {
    throw new Error('switch to the page you want to capture first');
  }
  return __wbCapture(tab.id, selected);
}

// --- human handoff prompt ------------------------------------------------
// chrome.alarms is the documented way to wake a Manifest V3 worker: the
// minimum period for a released extension is 30 s (0.5 min). The bridge
// already owns a 30 s reconcile alarm, so reuse it rather than registering a
// second timer. The push WebSocket delivers handoffs immediately; the alarm
// polls only when that socket is down, with a slow watchdog while it is up.

const __WB_RECONCILE_ALARM = 'webbridge-reconcile';
const __WB_RECONCILE_PERIOD_MIN = 0.5;
const __WB_PUSH_WATCHDOG_TICKS = 10; // 5 min at the reconcile cadence
let __wbReconcileTicks = 0;
let __wbHandoffChecking = false;

async function __wbSettings() {
  const stored = await chrome.storage.local.get(['capture_url', 'handoff_auto_open']);
  const endpoint = stored.capture_url || __WB_CAPTURE_DEFAULT;
  return {
    base: endpoint.replace(/\/capture\/?$/, ''),
    autoOpen: stored.handoff_auto_open !== false,
  };
}

async function __wbWindowAlive(id) {
  if (!id) return false;
  try {
    await chrome.windows.get(id);
    return true;
  } catch {
    return false;
  }
}

async function __wbCloseHandoffWindow() {
  const stored = await chrome.storage.session.get('handoff_window');
  await chrome.storage.session.remove('handoff_window');
  if (!stored.handoff_window) return;
  try {
    await chrome.windows.remove(stored.handoff_window);
  } catch {
    // The person may have closed it already.
  }
}

async function __wbOpenHandoff(id) {
  const stored = await chrome.storage.session.get('handoff_window');
  if (await __wbWindowAlive(stored.handoff_window)) {
    await chrome.windows.update(stored.handoff_window, { focused: true });
    return;
  }
  const created = await chrome.windows.create({
    url: `popup.html?handoff=${encodeURIComponent(id)}`,
    type: 'popup',
    width: 380,
    height: 380,
    focused: true,
  });
  await chrome.storage.session.set({ handoff_window: created.id });
}

async function __wbApplyHandoff(pending) {
  const { autoOpen } = await __wbSettings();
  const stored = await chrome.storage.session.get(['handoff_id', 'handoff_window']);
  if (stored.handoff_window && !(await __wbWindowAlive(stored.handoff_window))) {
    await chrome.storage.session.remove('handoff_window');
    stored.handoff_window = undefined;
  }

  if (!pending) {
    if (stored.handoff_id || stored.handoff_window) {
      await chrome.storage.session.remove(['handoff_id']);
      chrome.action.setBadgeText({ text: '' });
      await __wbCloseHandoffWindow();
    }
    return;
  }

  if (pending.id !== stored.handoff_id) {
    await chrome.storage.session.set({ handoff_id: pending.id });
    __wbBadge('!', '#d99b1e');
  }
  if (autoOpen && !stored.handoff_window) await __wbOpenHandoff(pending.id);
}

async function __wbCheckHandoff() {
  if (__wbHandoffChecking) return true;
  __wbHandoffChecking = true;
  try {
    const { base } = await __wbSettings();
    let pending = null;
    try {
      const response = await fetch(`${base}/handoff`, {
        signal: AbortSignal.timeout(2500),
        cache: 'no-store',
      });
      const data = await response.json();
      pending = Array.isArray(data.pending) ? data.pending[0] || null : data.pending || null;
    } catch {
      return false; // Receiver is off; the alarm retries on its next tick.
    }
    await __wbApplyHandoff(pending);
    return true;
  } finally {
    __wbHandoffChecking = false;
  }
}

function __wbPushOpen() {
  return Boolean(__wbPush && __wbPush.readyState === WebSocket.OPEN);
}

async function __wbHandoffTick() {
  __wbReconcileTicks += 1;
  if (__wbPushOpen()) {
    // The socket is the primary channel. Probe the receiver occasionally so a
    // silently dead socket cannot hide a pending handoff forever.
    if (__wbReconcileTicks % __WB_PUSH_WATCHDOG_TICKS !== 0) return;
    const alive = await __wbCheckHandoff();
    if (!alive && __wbPush) {
      try {
        __wbPush.close();
      } catch {
        // Already closing.
      }
    }
    return;
  }
  await __wbCheckHandoff();
  await __wbEnsurePush();
}

// --- push channel --------------------------------------------------------
// A loopback WebSocket to the MCP server delivers handoffs immediately. An
// open WebSocket keeps a Manifest V3 worker alive (Chrome 116+), which removes
// the alarm's latency while the server is running. Reconnects back off, and
// the 30 s alarm retries independently when this is down.

let __wbPush = null;
let __wbPushTimer = null;
let __wbPushFailures = 0;

async function __wbPushUrl() {
  const { base } = await __wbSettings();
  return `${base.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws`;
}

async function __wbEnsurePush() {
  if (__wbPush && (__wbPush.readyState === WebSocket.OPEN || __wbPush.readyState === WebSocket.CONNECTING)) {
    return;
  }
  let url;
  try {
    url = await __wbPushUrl();
  } catch {
    return;
  }
  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    return;
  }
  __wbPush = socket;
  socket.onopen = () => {
    __wbPushFailures = 0;
  };
  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type !== 'hello' && message?.type !== 'handoff') return;
    const pending = Array.isArray(message.pending) ? message.pending[0] || null : message.pending || null;
    __wbApplyHandoff(pending).catch(() => {});
  };
  socket.onclose = () => {
    if (__wbPush === socket) __wbPush = null;
    __wbPushFailures += 1;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(__wbPushFailures - 1, 4));
    if (__wbPushTimer) clearTimeout(__wbPushTimer);
    __wbPushTimer = setTimeout(() => {
      __wbPushTimer = null;
      __wbEnsurePush();
    }, delay);
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      // Already closing.
    }
  };
}

async function __wbEnsureReconcileAlarm() {
  const existing = await chrome.alarms.get(__WB_RECONCILE_ALARM);
  if (!existing) {
    chrome.alarms.create(__WB_RECONCILE_ALARM, { periodInMinutes: __WB_RECONCILE_PERIOD_MIN });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== __WB_RECONCILE_ALARM) return;
  __wbHandoffTick();
});

chrome.runtime.onInstalled.addListener(__wbEnsureReconcileAlarm);
chrome.runtime.onStartup.addListener(__wbEnsureReconcileAlarm);
__wbEnsureReconcileAlarm();
__wbCheckHandoff();
__wbEnsurePush();
