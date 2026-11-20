// Cross-process lifecycle state for the local daemon.
//
// The daemon is started on demand, but an MCP client is a separate process for
// every editor window. A lease file per client keeps one window from stopping
// a daemon another window is still using; a start lock keeps cold clients from
// racing to spawn it. Both live in ~/.webbridge and contain only PIDs.

import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.webbridge');
const DAEMON_STATE_DIR = path.join(os.homedir(), '.kimi-webbridge');
const LEASE_DIR = path.join(stateDir(), 'leases');
const START_LOCK = path.join(stateDir(), 'daemon-start.lock');
const OWNER_FILE = path.join(stateDir(), 'daemon-autostart.json');

let leasePath = '';
let leasePromise = null;
let leaseHeartbeat = null;
let exitHookInstalled = false;

export function stateDir() {
  return process.env.WEBBRIDGE_STATE_DIR || DEFAULT_STATE_DIR;
}

export function idleMs() {
  const raw = process.env.WEBBRIDGE_IDLE_MS;
  if (raw === undefined || raw === '') return 15 * 60_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 15 * 60_000;
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function removeQuietly(file) {
  try {
    await rm(file, { force: true });
  } catch {
    // Best effort: a stale lock or lease must not block the next call.
  }
}

// One lease per MCP process. PID liveness is the source of truth, so a crashed
// client is reaped without waiting for a TTL.
export function ensureLease() {
  if (!leasePromise) {
    leasePromise = (async () => {
      await mkdir(LEASE_DIR, { recursive: true });
      leasePath = path.join(LEASE_DIR, `${process.pid}-${randomBytes(4).toString('hex')}.json`);
      await writeFile(leasePath, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      leaseHeartbeat = setInterval(() => {
        if (!leasePath) return;
        writeFile(leasePath, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8').catch(() => {});
      }, 60_000);
      leaseHeartbeat.unref?.();
      installExitCleanup();
      return leasePath;
    })().catch((error) => {
      leasePromise = null;
      throw error;
    });
  }
  return leasePromise;
}

function stopHeartbeat() {
  if (leaseHeartbeat) {
    clearInterval(leaseHeartbeat);
    leaseHeartbeat = null;
  }
}

export function releaseLeaseSync() {
  stopHeartbeat();
  if (!leasePath) return;
  try {
    rmSync(leasePath, { force: true });
  } catch {
    // The process is exiting; a stale file is harmless and gets reaped.
  }
  leasePath = '';
  leasePromise = null;
}

export async function releaseLease() {
  stopHeartbeat();
  const file = leasePath;
  leasePath = '';
  leasePromise = null;
  if (file) await removeQuietly(file);
}

export function installExitCleanup() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', releaseLeaseSync);
}

export async function otherLiveLeases() {
  let entries = [];
  try {
    entries = await readdir(LEASE_DIR);
  } catch {
    return [];
  }
  const live = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(LEASE_DIR, entry);
    try {
      const info = JSON.parse(await readFile(file, 'utf8'));
      const pid = Number(info?.pid);
      if (pid !== process.pid && pidAlive(pid)) {
        live.push({ file, pid });
      } else if (pid !== process.pid) {
        await removeQuietly(file);
      }
    } catch {
      await removeQuietly(file);
    }
  }
  return live;
}

// Atomic create-exclusive lock. A crashed holder leaves a lock whose PID is
// dead; the next waiter removes it immediately.
export async function acquireStartLock(timeoutMs = 10_000) {
  await mkdir(stateDir(), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const handle = await open(START_LOCK, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      return {
        async release() {
          try {
            await handle.close();
          } catch {
            // Already closed.
          }
          await removeQuietly(START_LOCK);
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = true;
      try {
        const info = JSON.parse(await readFile(START_LOCK, 'utf8'));
        stale = !pidAlive(Number(info?.pid)) || Date.now() - Number(info?.at || 0) > 60_000;
      } catch {
        stale = true;
      }
      if (stale) {
        await removeQuietly(START_LOCK);
        continue;
      }
      await sleep(150);
    }
  }
  throw new Error(`timed out waiting for the daemon start lock at ${START_LOCK}`);
}

export function daemonPid() {
  try {
    const text = readFileSync(path.join(DAEMON_STATE_DIR, 'daemon.pid'), 'utf8').trim();
    let pid = 0;
    try {
      pid = Number(JSON.parse(text)?.pid);
    } catch {
      // The daemon writes a bare PID; older builds may write JSON.
      pid = Number(text);
    }
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

export async function writeOwnership(daemonPidValue, url = '') {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(
    OWNER_FILE,
    JSON.stringify({ pid: process.pid, daemonPid: daemonPidValue || 0, url, at: Date.now() }),
    'utf8',
  );
}

export async function readOwnership() {
  try {
    return JSON.parse(await readFile(OWNER_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export async function clearOwnership() {
  await removeQuietly(OWNER_FILE);
}

export { OWNER_FILE, LEASE_DIR, START_LOCK };
