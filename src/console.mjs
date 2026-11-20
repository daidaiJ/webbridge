import { CONSOLE_SOURCE } from '../shared/page/console.js';
// Console capture for the current tab. Injected on demand; nothing runs on the
// page until the tool is called. Bounded to 200 entries, 500 chars each.

import { call } from './daemon.mjs';

const ACTIONS = new Set(['start', 'read', 'stop']);

export async function consoleMessages(args, session, deps = { callTool: call }) {
  const action = ACTIONS.has(args.action) ? args.action : 'read';
  const code = `(${CONSOLE_SOURCE})(${JSON.stringify(action)}, ${args.clear === true})`;
  const evaluated = await deps.callTool('evaluate', { code }, session, 30000);
  const result = evaluated && typeof evaluated === 'object' && 'value' in evaluated ? evaluated.value : evaluated;
  if (!result || typeof result !== 'object') {
    throw new Error('console: unexpected page payload');
  }
  return result;
}
