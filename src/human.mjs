// Request human intervention through the extension prompt and wait for it.
// Meant for sign-in, 2FA, captcha, consent, or any step the person must do.
// Payment is out of scope by design: the agent stops before checkout.

import { call } from './daemon.mjs';
import { openHandoff } from './handoff.mjs';

const MIN_TIMEOUT = 5000;
const MAX_TIMEOUT = 600000;

export async function requestHuman(args, session, deps = { callTool: call }) {
  const reason = String(args.reason || '').trim() || 'The agent needs you in the browser';
  const instructions = String(args.instructions || '').trim();
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 120000, MIN_TIMEOUT), MAX_TIMEOUT);

  let url = '';
  try {
    const current = await deps.callTool('evaluate', { code: 'location.href' }, session, 5000);
    url = typeof current?.value === 'string' ? current.value : '';
  } catch {
    // The tab may be gone; the prompt still explains what to do.
  }

  const { id, wait, finish } = openHandoff({ reason, instructions, session, url, timeoutMs });
  const timer = setTimeout(() => finish({ resumed: false, handoff_id: id, timeout: true }), timeoutMs);

  // Register the handoff before touching the tab: this daemon call wakes the
  // extension worker, whose startup check can then surface the prompt.
  try {
    await deps.callTool('cdp', { method: 'Page.bringToFront', params: {} }, session, 5000);
  } catch {
    // A background tab can still be handled by the person.
  }

  const outcome = await wait;
  clearTimeout(timer);
  return { ...outcome, url, session };
}
