// Shared preflight for browser E2E tests. The daemon accepts one extension
// connection at a time, so a daily browser running the extension would
// otherwise be driven by the test instead of the Playwright browser.

import { status } from '../src/daemon.mjs';

export async function assertNoForeignBrowser(testName, readStatus = status) {
  const state = await readStatus();
  if (!state?.extension_connected) return state;
  if (process.env.WEBBRIDGE_E2E_ALLOW_CONNECTED === '1') return state;
  throw new Error(
    `${testName}: a browser is already connected to the daemon (likely the daily browser). ` +
      'Quit that browser before running this test, or set WEBBRIDGE_E2E_ALLOW_CONNECTED=1 ' +
      'when the connected browser is the one under test.',
  );
}
