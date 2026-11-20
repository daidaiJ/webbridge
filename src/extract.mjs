import { EXTRACT_SOURCE } from '../shared/page/extract.js';
// Structured page extraction: the analogue of Stagehand's extract() primitive.
// One evaluate call, bounded items and field lengths, no extra DOM passes.

import { call } from './daemon.mjs';

export async function extractItems(args, session, deps = { callTool: call }) {
  const selector = String(args.selector || '').trim();
  if (!selector) throw new Error('extract: selector is required');
  const maxItems = Math.min(Math.max(Number(args.max_items) || 50, 1), 500);

  let fields = [];
  if (Array.isArray(args.fields)) {
    fields = args.fields.slice(0, 12).map((field, index) => {
      if (!field || typeof field !== 'object') throw new Error('extract: fields must be objects');
      const name = String(field.name || `field${index + 1}`).slice(0, 80);
      return {
        name,
        selector: field.selector ? String(field.selector) : '',
        attr: field.attr ? String(field.attr) : '',
      };
    });
  }

  const code = `(${EXTRACT_SOURCE})(${JSON.stringify(selector)}, ${maxItems}, ${JSON.stringify(fields)}, ${args.include_empty === true})`;
  const evaluated = await deps.callTool('evaluate', { code }, session, 60000);
  const result = evaluated && typeof evaluated === 'object' && 'value' in evaluated ? evaluated.value : evaluated;
  if (!result || typeof result !== 'object' || result.error) {
    throw new Error(`extract: ${result?.error || 'unexpected page payload'}`);
  }
  return result;
}
