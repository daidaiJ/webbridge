import { READER_SOURCE } from '../shared/page/reader.js';
export { READER_SOURCE };
// Clean article extraction: a reader-mode pass injected on demand.
//
// Chromium's reading mode is a browser UI feature and has no CDP entry point,
// so this is the scriptable equivalent: strip chrome, score text containers
// the way reader modes do, keep the winning subtree, and emit Markdown. It
// runs in one evaluate call, needs no network, and works in any Chromium
// profile.

import { call } from './daemon.mjs';

export function readerLimit(value) {
  return Math.min(Math.max(Number(value) || 60000, 1000), 200000);
}

// One evaluate call, then a shaped result. The daemon stays unaware of reader
// mode, so every client gets the same output regardless of extension version.
export async function readArticle(args, session, deps = { callTool: call }) {
  const limit = readerLimit(args.max_chars);
  const code = `(${READER_SOURCE})(${limit})`;
  const evaluated = await deps.callTool('evaluate', { code }, session, 60000);
  const payload = evaluated && typeof evaluated === 'object' && 'value' in evaluated ? evaluated.value : evaluated;
  if (!payload || typeof payload !== 'object' || typeof payload.text !== 'string') {
    throw new Error(`reader: unexpected page payload: ${JSON.stringify(evaluated).slice(0, 200)}`);
  }
  return { ...payload, mode: 'reader' };
}
