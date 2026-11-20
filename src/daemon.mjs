// Local browser bridge daemon client.
// The daemon owns the browser side (extension + tab groups); this module only
// speaks its HTTP API: POST /command {action, args, session} -> {ok, data|error}.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  acquireStartLock,
  clearOwnership,
  daemonPid,
  ensureLease,
  idleMs,
  otherLiveLeases,
  readOwnership,
  releaseLease,
  writeOwnership,
} from './lifecycle.mjs';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:10086';

export function baseUrl() {
  return (process.env.WEBBRIDGE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function daemonBinary() {
  if (process.env.WEBBRIDGE_BIN) return process.env.WEBBRIDGE_BIN;
  const name = process.platform === 'win32' ? 'kimi-webbridge.exe' : 'kimi-webbridge';
  return path.join(os.homedir(), '.kimi-webbridge', 'bin', name);
}

function releaseName() {
  if (process.platform === 'win32') return 'windows-amd64.exe';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-amd64';
}

export class DaemonError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DaemonError';
    this.code = code;
  }
}

async function getJson(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new DaemonError(`unexpected response from ${url}: ${text.slice(0, 200)}`, 'bad_response');
  }
}

export async function status(timeoutMs = 2000) {
  try {
    return await getJson(`${baseUrl()}/status`, timeoutMs);
  } catch {
    return null;
  }
}

async function postCommand(action, args, session, timeoutMs) {
  let response;
  try {
    response = await fetch(`${baseUrl()}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, args, session }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new DaemonError(`${action} did not answer within ${timeoutMs} ms`, 'timeout');
    }
    throw new DaemonError(
      `cannot reach the browser daemon at ${baseUrl()} (${error?.cause?.code || error?.message || error}). ` +
        `Run the webbridge__start tool or "${daemonBinary()} start".`,
      'daemon_unreachable',
    );
  }

  const text = await response.text();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new DaemonError(
      `${baseUrl()} answered ${response.status} with non-JSON: ${text.slice(0, 200)}`,
      'bad_response',
    );
  }
  if (envelope?.ok === true) return envelope.data;
  const code = envelope?.error?.code || `http_${response.status}`;
  throw new DaemonError(envelope?.error?.message || text.slice(0, 300), code);
}

function autoStartEnabled() {
  return process.env.WEBBRIDGE_AUTOSTART !== '0';
}

export async function call(action, args = {}, session = 'grok', timeoutMs = 120_000) {
  await ensureLease();
  touchActivity();
  try {
    return await postCommand(action, args, session, timeoutMs);
  } catch (error) {
    // A cold MCP client should get a working browser without a separate
    // start call. Only a connection failure is retried; tool timeouts and
    // daemon-side errors are real results.
    if (!(error instanceof DaemonError) || error.code !== 'daemon_unreachable' || !autoStartEnabled()) {
      throw error;
    }
    try {
      await ensureDaemon();
    } catch (startError) {
      throw new DaemonError(
        `${error.message} Automatic start failed: ${startError?.message || startError}`,
        startError?.code || 'daemon_start_failed',
      );
    }
    return postCommand(action, args, session, timeoutMs);
  }
}

let ensurePromise = null;
let idleTimer = null;
let lastActivity = Date.now();

function touchActivity() {
  lastActivity = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  const ms = idleMs();
  if (ms <= 0) {
    idleTimer = null;
    return;
  }
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    try {
      const result = await stopDaemonIfIdle();
      if (!result.stopped) scheduleIdle();
    } catch {
      scheduleIdle();
    }
  }, Math.max(1000, ms - (Date.now() - lastActivity)));
  idleTimer.unref?.();
}

function scheduleIdle() {
  touchActivity();
}

// Start the daemon if it is not already answering. `start` spawns a detached
// background process and returns immediately, so poll /status afterwards.
// Concurrent first calls share one spawn attempt; the file lock makes that
// true across MCP client processes too.
export function ensureDaemon({ timeoutMs = 30_000, managed = true } = {}) {
  if (!ensurePromise) {
    ensurePromise = startDaemon(timeoutMs, managed)
      .then((state) => {
        touchActivity();
        return state;
      })
      .finally(() => {
        ensurePromise = null;
      });
  }
  return ensurePromise;
}

async function startDaemon(timeoutMs, managed) {
  await ensureLease();
  const running = await status();
  if (running?.running) return running;

  const lock = await acquireStartLock();
  try {
    // Another client may have won the race while we waited for the lock.
    const second = await status();
    if (second?.running) return second;

    const bin = daemonBinary();
    if (!existsSync(bin)) {
      throw new DaemonError(
        `the browser daemon is not installed. Expected ${bin}. ` +
          `Download the release for this platform (${releaseName()}) and place it there, ` +
          `or set WEBBRIDGE_BIN.`,
        'daemon_missing',
      );
    }

    await new Promise((resolve, reject) => {
      const child = spawn(bin, ['start'], { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await status();
      if (state?.running) {
        if (managed) await writeOwnership(daemonPid(), baseUrl());
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new DaemonError(`daemon did not come up on ${baseUrl()} within ${timeoutMs} ms`, 'daemon_timeout');
  } finally {
    await lock.release();
  }
}

async function stopProcess() {
  const bin = daemonBinary();
  if (!existsSync(bin)) return;
  await new Promise((resolve) => {
    const child = spawn(bin, ['stop'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 10_000);
    timer.unref?.();
    child.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Stop a daemon this client started, unless another MCP client still holds a
// lease. A manually started daemon has no ownership marker and is left alone.
export async function stopDaemonIfIdle({ force = false } = {}) {
  const owner = await readOwnership();
  if (!owner && !force) return { stopped: false, reason: 'not_started_by_client' };
  if (owner?.url && owner.url !== baseUrl()) {
    return { stopped: false, reason: 'other_daemon' };
  }

  if (owner?.daemonPid) {
    const current = daemonPid();
    if (current && current !== owner.daemonPid) {
      await clearOwnership();
      return { stopped: false, reason: 'daemon_replaced' };
    }
  }

  const lock = await acquireStartLock();
  try {
    if (!force) {
      const currentOwner = await readOwnership();
      if (!currentOwner) return { stopped: false, reason: 'not_started_by_client' };
      const others = await otherLiveLeases();
      if (others.length > 0) return { stopped: false, reason: 'in_use', leases: others.length };
    }
    const state = await status();
    if (!state?.running) {
      await clearOwnership();
      return { stopped: false, reason: 'not_running' };
    }
    await stopProcess();
    await clearOwnership();
    return { stopped: true };
  } finally {
    await lock.release();
  }
}

// Called when the MCP transport ends. Release this client's lease first so a
// sole client can stop the daemon; a shared daemon stays up for the others.
export async function shutdownDaemon() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  await releaseLease();
  return stopDaemonIfIdle();
}
