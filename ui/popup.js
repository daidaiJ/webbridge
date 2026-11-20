const DEFAULT_URL = 'ws://127.0.0.1:10086/ws';
const KEY_CONNECT = 'ws_should_connect';
const KEY_URL = 'local_url';

const $ = (id) => document.getElementById(id);
let noteLockUntil = 0;
const note = (text, hold = 0) => {
  if (hold > 0) noteLockUntil = Date.now() + hold;
  $('note').textContent = text || '';
};
const statusNote = (text) => {
  if (Date.now() < noteLockUntil) return;
  $('note').textContent = text || '';
};

async function daemonStatus() {
  try {
    const response = await fetch('http://127.0.0.1:10086/status', {
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    return await response.json();
  } catch {
    return null;
  }
}

async function bridgeState() {
  try {
    return await chrome.runtime.sendMessage({ type: 'WEBBRIDGE_STATE' });
  } catch {
    return null;
  }
}

async function captureHealth(endpoint) {
  const base = (endpoint || '').replace(/\/capture\/?$/, '');
  if (!base) return null;
  try {
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(800),
      cache: 'no-store',
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function activityState(base) {
  if (!base) return null;
  try {
    const response = await fetch(`${base}/activity`, { signal: AbortSignal.timeout(800), cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function handoffState(base) {
  if (!base) return null;
  try {
    const response = await fetch(`${base}/handoff`, { signal: AbortSignal.timeout(800), cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    return Array.isArray(data.pending) ? data.pending[0] || null : data.pending || null;
  } catch {
    return null;
  }
}

let lastBase = 'http://127.0.0.1:10087';
let currentHandoff = null;

async function render() {
  const settings = await chrome.storage.local.get([KEY_CONNECT, KEY_URL, 'capture_url']);
  const endpoint = settings.capture_url || 'http://127.0.0.1:10087/capture';
  lastBase = endpoint.replace(/\/capture\/?$/, '');
  const [state, daemon, health, handoff, activity] = await Promise.all([
    bridgeState(),
    daemonStatus(),
    captureHealth(endpoint),
    handoffState(lastBase),
    activityState(lastBase),
  ]);

  $('daemon').textContent = daemon?.running
    ? `running${daemon.version ? ` (${daemon.version})` : ''}`
    : 'not running';
  $('link').textContent = daemon?.extension_connected
    ? 'connected'
    : settings[KEY_CONNECT] === false
      ? 'disconnected'
      : 'waiting for daemon';
  $('version').textContent = chrome.runtime.getManifest().version;
  $('url').value = settings[KEY_URL] || DEFAULT_URL;

  const captures = $('captures');
  if (health?.dir) {
    captures.textContent = health.dir;
    captures.title = health.dir;
  } else {
    captures.textContent = 'downloads folder';
    captures.title = 'The capture receiver is not running (start the MCP server); captures go to the browser downloads folder.';
  }

  const last = Array.isArray(activity?.actions) ? activity.actions[0] : null;
  if (last) {
    $('activity').textContent = `${last.tool}${last.ok ? '' : ' (failed)'}`;
    $('activity').title = `${last.at} · ${last.tool} · ${last.ms} ms · ${last.session}`;
  } else {
    $('activity').textContent = '–';
    $('activity').title = '';
  }

  if (handoff) {
    currentHandoff = handoff;
    $('handoff').hidden = false;
    $('handoff-reason').textContent = handoff.reason || 'The agent needs you';
    $('handoff-instructions').textContent = handoff.instructions || '';
  } else {
    currentHandoff = null;
    $('handoff').hidden = true;
  }

  $('dot').className = `dot ${daemon?.extension_connected ? 'ok' : daemon?.running ? 'warn' : ''}`;

  if (!daemon?.running) {
    statusNote('Daemon is off. Start it, then press "Save & connect".');
  } else if (!daemon.extension_connected) {
    statusNote('Daemon is up but this browser is not attached yet.');
  } else {
    statusNote('');
  }
}

$('save').addEventListener('click', async () => {
  const url = $('url').value.trim() || DEFAULT_URL;
  note('Connecting…');
  await chrome.storage.local.set({ [KEY_CONNECT]: true, [KEY_URL]: url });
  // Drop an existing socket first so a changed URL takes effect immediately.
  await chrome.runtime.sendMessage({ type: 'WEBBRIDGE_DISCONNECT' }).catch(() => {});
  const result = await chrome.runtime.sendMessage({ type: 'WEBBRIDGE_RECONNECT' }).catch((error) => ({
    ok: false,
    error: String(error?.message || error),
  }));
  if (result?.ok) {
    note('Connect requested. This can take a second.', 3000);
    setTimeout(render, 700);
  } else {
    note(result?.error || 'Could not reach the extension worker.', 4000);
  }
});

$('disconnect').addEventListener('click', async () => {
  await chrome.storage.local.set({ [KEY_CONNECT]: false });
  await chrome.runtime.sendMessage({ type: 'WEBBRIDGE_DISCONNECT' }).catch(() => {});
  note('Disconnected.', 3000);
  setTimeout(render, 300);
});

function captureActive() {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'webbridge-capture' });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      port.disconnect();
      reject(new Error('capture timed out'));
    }, 20000);
    port.onMessage.addListener((reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.disconnect();
      resolve(reply);
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('capture channel closed'));
    });
    port.postMessage({ type: 'active' });
  });
}

$('capture').addEventListener('click', async () => {
  const button = $('capture');
  button.disabled = true;
  note('Capturing…');
  try {
    const result = await captureActive().catch((error) => ({ ok: false, error: String(error?.message || error) }));
    note(result?.ok ? `Captured: ${result.title || 'page'}` : result?.error || 'capture failed', 4000);
    if (result?.ok) setTimeout(render, 400);
  } finally {
    button.disabled = false;
  }
});

$('handoff-resume').addEventListener('click', async () => {
  if (!currentHandoff) return;
  await fetch(`${lastBase}/handoff/${encodeURIComponent(currentHandoff.id)}/resume`, {
    method: 'POST',
    signal: AbortSignal.timeout(1500),
  }).catch(() => {});
  currentHandoff = null;
  $('handoff').hidden = true;
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (!tab) window.close();
});

render();
// Poll only while visible; a hidden popup tab should not keep fetching.
setInterval(() => {
  if (!document.hidden) render();
}, 2000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
});
