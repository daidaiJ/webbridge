// Lifecycle unit checks. These run without a browser or daemon.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const state = await mkdtemp(path.join(os.tmpdir(), 'webbridge-lifecycle-'));
process.env.WEBBRIDGE_STATE_DIR = state;
process.env.WEBBRIDGE_IDLE_MS = '0';

const lifecycle = await import('../src/lifecycle.mjs');

try {
  const lease = await lifecycle.ensureLease();
  assert.equal(existsSync(lease), true, 'lease file exists');
  assert.deepEqual(await lifecycle.otherLiveLeases(), [], 'self lease is not another client');

  const first = await lifecycle.acquireStartLock(1000);
  await assert.rejects(
    () => lifecycle.acquireStartLock(300),
    /timed out waiting for the daemon start lock/,
    'a second cold start waits for the first',
  );
  await first.release();

  const second = await lifecycle.acquireStartLock(1000);
  await second.release();

  await lifecycle.writeOwnership(4242);
  assert.equal((await lifecycle.readOwnership())?.daemonPid, 4242, 'ownership marker round-trips');
  await lifecycle.clearOwnership();
  assert.equal(await lifecycle.readOwnership(), null, 'ownership marker clears');

  await lifecycle.releaseLease();
  assert.equal(existsSync(lease), false, 'lease file is removed');
  assert.deepEqual(await readdir(path.join(state, 'leases')), [], 'lease directory is clean');
  console.log('lifecycle: ok');
} finally {
  await rm(state, { recursive: true, force: true });
}
