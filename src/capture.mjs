// Page capture: turn the current tab into an agent-friendly Markdown file.
// One in-page DOM walk, bounded by max_chars; optional screenshot is off by
// default so capture stays cheap on slow machines.

import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { listActivity } from './activity.mjs';
import { call } from './daemon.mjs';
import { listHandoffs, resumeHandoff, subscribeHandoffs, waitForHandoffChange } from './handoff.mjs';

// Injected into the page through CDP Runtime.evaluate. Self-contained, no
// dependencies, bounded element and character counts.
export const EXTRACT_SOURCE = String.raw`
function (maxChars, selected) {
  var out = [];
  var used = 0;
  var limit = maxChars > 0 ? maxChars : 120000;
  function clean(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }
  function push(line) {
    if (!line || used >= limit) return false;
    var text = line + '\n';
    used += text.length;
    out.push(text);
    return used < limit;
  }
  var root = document.querySelector('article, main, [role="main"]') || document.body;
  var blocks = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote');
  for (var index = 0; index < blocks.length && used < limit; index += 1) {
    var el = blocks[index];
    if (!el || !el.innerText) continue;
    if (el.closest('nav,footer,aside,[aria-hidden="true"]')) continue;
    var tag = el.tagName;
    if (tag === 'LI') {
      push('- ' + clean(el.innerText));
    } else if (tag === 'PRE') {
      push('~~~');
      push(el.innerText.slice(0, 4000));
      push('~~~');
    } else if (tag === 'BLOCKQUOTE') {
      push('> ' + clean(el.innerText));
    } else if (tag.length === 2 && tag[0] === 'H') {
      push('#'.repeat(Number(tag[1])) + ' ' + clean(el.innerText));
    } else {
      push(clean(el.innerText));
    }
  }
  var links = [];
  var anchors = root.querySelectorAll('a[href]');
  for (var index = 0; index < anchors.length && links.length < 60; index += 1) {
    var anchor = anchors[index];
    var href = anchor.href;
    if (!href || href.indexOf('javascript:') === 0) continue;
    links.push({ text: clean(anchor.innerText).slice(0, 120), href: href });
  }
  var description = '';
  var meta = document.querySelector('meta[name="description"],meta[property="og:description"]');
  if (meta) description = meta.getAttribute('content') || '';
  var canonical = document.querySelector('link[rel="canonical"]');
  return {
    title: document.title || '',
    url: location.href,
    canonical: canonical ? canonical.href : '',
    description: description,
    lang: document.documentElement.lang || '',
    text: out.join(''),
    chars: used,
    truncated: used >= limit,
    links: links,
    selected: selected || ''
  };
}
`;

export function captureRoot(override) {
  return (
    override ||
    process.env.WEBBRIDGE_CAPTURE_DIR ||
    path.join(os.homedir(), '.webbridge', 'captures')
  );
}

function slugify(title) {
  const slug = (title || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return slug || 'capture';
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function frontmatter(page, tags, screenshot) {
  const lines = ['---'];
  lines.push(`url: ${JSON.stringify(page.url || '')}`);
  if (page.canonical && page.canonical !== page.url) {
    lines.push(`canonical: ${JSON.stringify(page.canonical)}`);
  }
  lines.push(`title: ${JSON.stringify(page.title || '')}`);
  lines.push(`captured_at: ${new Date().toISOString()}`);
  if (page.lang) lines.push(`lang: ${JSON.stringify(page.lang)}`);
  if (page.description) lines.push(`description: ${JSON.stringify(page.description)}`);
  if (page.selected) lines.push('selection: true');
  if (page.source) lines.push(`source: ${JSON.stringify(page.source)}`);
  if (tags.length > 0) lines.push(`tags: [${tags.map((tag) => JSON.stringify(tag)).join(', ')}]`);
  if (screenshot) lines.push(`screenshot: ${JSON.stringify(screenshot)}`);
  lines.push('---', '');
  return lines.join('\n');
}

export function toMarkdown(page, tags, screenshot) {
  const parts = [frontmatter(page, tags, screenshot)];
  parts.push(`# ${page.title || page.url || 'Captured page'}`, '');
  if (page.selected) parts.push('> Selected text', '', page.selected, '');
  parts.push(page.text || '', '');
  if (Array.isArray(page.links) && page.links.length > 0) {
    parts.push('## Links', '');
    for (const link of page.links) {
      parts.push(`- [${link.text || link.href}](${link.href})`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

// Two captures of the same page in the same second must not overwrite each
// other, so pick the first free suffix.
async function uniqueBase(root, title) {
  const base = `${stamp()}-${slugify(title)}`;
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    try {
      await access(path.join(root, `${name}.md`));
    } catch {
      return name;
    }
  }
  return `${base}-${Date.now()}`;
}

// Write one captured page plus its index line. Shared by the MCP tool and the
// localhost receiver that the extension's context menu posts to.
export async function persistCapture({ page, dir, tags = [], session, screenshot, base }) {
  const root = captureRoot(dir);
  await mkdir(root, { recursive: true });
  const name = base || (await uniqueBase(root, page.title));
  const markdownPath = path.join(root, `${name}.md`);
  const markdown = toMarkdown(page, tags, screenshot);
  await writeFile(markdownPath, markdown, 'utf8');
  await appendFile(
    path.join(root, 'index.jsonl'),
    `${JSON.stringify({
      at: new Date().toISOString(),
      url: page.url,
      title: page.title,
      path: markdownPath,
      screenshot,
      session,
      tags,
      chars: page.chars,
    })}\n`,
    'utf8',
  );
  return {
    path: markdownPath,
    dir: root,
    bytes: Buffer.byteLength(markdown),
    chars: page.chars,
    truncated: page.truncated === true,
    title: page.title,
    url: page.url,
    screenshot,
    session,
  };
}

// opts: { dir, tags, screenshot, maxChars, session }
export async function captureCurrentTab(opts, deps = { callTool: call }) {
  const limit = Math.min(Math.max(Number(opts.maxChars) || 120000, 1000), 400000);
  const code = `(${EXTRACT_SOURCE})(${limit}, ${JSON.stringify(opts.selection || '')})`;
  const evaluated = await deps.callTool('evaluate', { code }, opts.session, 60000);
  const page = evaluated && typeof evaluated === 'object' && 'value' in evaluated ? evaluated.value : evaluated;
  if (!page || typeof page !== 'object' || typeof page.text !== 'string') {
    throw new Error(`capture: unexpected page payload from the browser: ${JSON.stringify(evaluated).slice(0, 200)}`);
  }

  const dir = captureRoot(opts.dir);
  await mkdir(dir, { recursive: true });
  // Reserve one base for the screenshot and the Markdown so they always share
  // a name. persistCapture accepts it instead of choosing a second base.
  const base = await uniqueBase(dir, page.title);

  let screenshotName;
  if (opts.screenshot) {
    const shotPath = path.join(dir, `${base}.png`);
    try {
      const shot = await deps.callTool(
        'screenshot',
        { format: 'png', path: shotPath },
        opts.session,
        45000,
      );
      if (shot?.path) screenshotName = path.basename(shot.path);
    } catch {
      // A failed screenshot must not lose the captured text.
    }
  }

  return persistCapture({
    page,
    dir,
    base,
    tags: opts.tags || [],
    session: opts.session,
    screenshot: screenshotName,
  });
}

const MAX_RECEIVER_BODY = 4 * 1024 * 1024;

// Minimal RFC 6455 server for the extension's push channel. Only loopback
// clients connect, messages are small JSON, and the server never initiates
// subprotocols or extensions, so the frame parser handles the common cases
// and drops anything larger than a capture-sized payload.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_WS_FRAME = 1024 * 1024;

function wsAccept(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsSendFrame(state, payload, opcode = 0x1) {
  const socket = state.socket;
  if (socket.destroyed || !socket.writable) return;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  try {
    socket.write(Buffer.concat([header, body]));
  } catch {
    // The peer vanished; the close handler removes it.
  }
}

function wsReadFrames(state, chunk, onFrame) {
  state.buffer = state.buffer.length > 0 ? Buffer.concat([state.buffer, chunk]) : chunk;
  while (state.buffer.length >= 2) {
    const buffer = state.buffer;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return;
      const wide = buffer.readBigUInt64BE(2);
      if (wide > BigInt(MAX_WS_FRAME)) throw new Error('ws frame too large');
      length = Number(wide);
      offset = 10;
    }
    if (length > MAX_WS_FRAME) throw new Error('ws frame too large');
    const maskOffset = offset;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return;
    let payload = buffer.subarray(offset, offset + length);
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      const copy = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) copy[index] = payload[index] ^ mask[index % 4];
      payload = copy;
    }
    state.buffer = buffer.subarray(offset + length);
    onFrame(opcode, payload);
  }
}

function receiverHeaders(response, request) {
  // Only extension pages may read these replies. A web page that reaches
  // loopback must not be able to read handoff reasons or tool activity.
  const origin = String(request.headers.origin || '');
  response.setHeader('vary', 'origin');
  if (/^(chrome|moz|safari-web)-extension:\/\//i.test(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    response.setHeader('access-control-allow-headers', 'content-type');
    response.setHeader('access-control-allow-private-network', 'true');
  }
  response.setHeader('cache-control', 'no-store');
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_RECEIVER_BODY) {
        reject(new Error('capture: body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

// Localhost HTTP endpoint for the extension's context menu and popup button.
// It runs inside the MCP server, so captures land in the configured directory
// even when the agent never asks for one. Never exposed beyond loopback.
export function startCaptureReceiver(options = {}) {
  const host = options.host || process.env.WEBBRIDGE_CAPTURE_HOST || '127.0.0.1';
  const port = Number(options.port ?? process.env.WEBBRIDGE_CAPTURE_PORT ?? 10087);
  const dir = captureRoot(options.dir);

  const server = http.createServer(async (request, response) => {
    receiverHeaders(response, request);
    const url = new URL(request.url || '/', `http://${host}:${port}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, dir }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/activity') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ actions: listActivity() }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/handoff') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ pending: listHandoffs() }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/handoff/watch') {
      const waitMs = Math.min(Math.max(Number(url.searchParams.get('wait_ms')) || 20000, 0), 30000);
      const pending = await waitForHandoffChange(waitMs);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ pending }));
      return;
    }
    const resume = url.pathname.match(/^\/handoff\/([^/]+)\/resume$/);
    if (request.method === 'POST' && resume) {
      const ok = resumeHandoff(decodeURIComponent(resume[1]));
      response.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: 'unknown handoff' }));
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/capture') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    try {
      const body = JSON.parse(await readBody(request));
      const page = body?.page;
      if (!page || typeof page.text !== 'string') throw new Error('page.text is required');
      if (page.text.length > 400_000) page.text = page.text.slice(0, 400_000);
      page.source = typeof page.source === 'string' ? page.source : 'extension';
      const result = await persistCapture({
        page,
        dir,
        tags: Array.isArray(body.tags) ? body.tags.slice(0, 20).map(String) : [],
        session: typeof body.session === 'string' ? body.session : 'extension',
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
    }
  });

  server.on('error', (error) => {
    if (options.onError) options.onError(error);
  });

  // Push channel: the extension keeps one loopback WebSocket open, so a
  // handoff prompt appears immediately instead of waiting for the 30 s alarm.
  // The alarm remains the fallback when this server or the socket is down.
  const clients = new Set();
  const broadcast = (message) => {
    const text = JSON.stringify(message);
    for (const state of [...clients]) wsSendFrame(state, text, 0x1);
  };
  const unsubscribe = subscribeHandoffs((pending) => broadcast({ type: 'handoff', pending }));

  server.on('upgrade', (request, socket) => {
    const requestUrl = new URL(request.url || '/', `http://${host}:${port}`);
    if (requestUrl.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = request.headers['sec-websocket-key'];
    const origin = String(request.headers.origin || '');
    if (origin && !/^(chrome|moz|safari-web)-extension:\/\//i.test(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (String(request.headers.upgrade || '').toLowerCase() !== 'websocket' || typeof key !== 'string' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const state = { socket, buffer: Buffer.alloc(0) };
    clients.add(state);
    const drop = () => clients.delete(state);
    socket.on('close', drop);
    socket.on('error', drop);
    socket.on('data', (chunk) => {
      try {
        wsReadFrames(state, chunk, (opcode, payload) => {
          if (opcode === 0x8) {
            drop();
            socket.end();
            return;
          }
          if (opcode === 0x9) {
            wsSendFrame(state, payload, 0xa);
            return;
          }
          if (opcode !== 0x1) return;
          if (payload.toString('utf8').includes('"handoff"')) {
            wsSendFrame(state, JSON.stringify({ type: 'handoff', pending: listHandoffs() }), 0x1);
          }
        });
      } catch {
        drop();
        socket.destroy();
      }
    });
    wsSendFrame(state, JSON.stringify({ type: 'hello', pending: listHandoffs() }), 0x1);
  });

  const heartbeat = setInterval(() => {
    for (const state of [...clients]) wsSendFrame(state, Buffer.alloc(0), 0x9);
  }, 20000);
  heartbeat.unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    for (const state of [...clients]) state.socket.destroy();
    clients.clear();
  });

  server.listen(port, host);
  server.unref();
  return { server, host, port, dir };
}
