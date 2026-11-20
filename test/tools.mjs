// Focused tests for local tool helpers: extraction, console, and the
// MCP-to-daemon action mapping, without a browser.

import assert from 'node:assert/strict';

import { adaptToolCall } from '../src/actions.mjs';
import { consoleMessages } from '../src/console.mjs';
import { extractItems } from '../src/extract.mjs';
import { readArticle } from '../src/reader.mjs';
import { assertNoForeignBrowser } from './preflight.mjs';

const calls = [];
const fake = async (action, args) => {
  calls.push({ action, args });
  return {
    value: {
      url: 'https://example.com/list',
      matched: 2,
      returned: 1,
      items: [{ name: 'Alpha', qty: '1' }],
      messages: [{ at: 1, level: 'log', text: 'hello' }],
      count: 1,
    },
  };
};

const extracted = await extractItems(
  {
    selector: '#rows tr',
    fields: [{ name: 'name', selector: '.name' }, { name: 'qty', selector: '.qty', attr: 'data-qty' }],
    max_items: 5,
  },
  'test',
  { callTool: fake },
);
assert.equal(calls[0].action, 'evaluate');
assert.match(calls[0].args.code, /#rows tr/);
assert.match(calls[0].args.code, /"name"/);
assert.match(calls[0].args.code, /"attr":"data-qty"/);
assert.equal(extracted.items[0].name, 'Alpha');
assert.equal(extracted.matched, 2);

const consoleRead = await consoleMessages({ action: 'read', clear: true }, 'test', { callTool: fake });
assert.match(calls.at(-1).args.code, /"read", true\)/);
assert.equal(consoleRead.messages[0].text, 'hello');

await consoleMessages({}, 'test', { callTool: fake });
assert.match(calls.at(-1).args.code, /"read", false\)/);

await assert.rejects(() => extractItems({}, 'test', { callTool: fake }), /selector is required/);

const article = await readArticle(
  { max_chars: 5000 },
  'test',
  {
    callTool: async (action, args) => {
      calls.push({ action, args });
      return { value: { title: 'A title', text: '# A title\n\nBody text', chars: 20, truncated: false } };
    },
  },
);
assert.equal(article.mode, 'reader');
assert.match(article.text, /Body text/);
assert.match(calls.at(-1).args.code, /function \(maxChars\)/);
assert.match(calls.at(-1).args.code, /\(5000\)/);

// Action mapping: vendor-internal names stay out of the tool surface, and
// validation happens before any daemon round-trip.
assert.deepEqual(adaptToolCall('history', { action: 'back' }), { action: 'go_back', args: {} });
assert.deepEqual(adaptToolCall('history', { action: 'forward' }), { action: 'go_forward', args: {} });
assert.throws(() => adaptToolCall('history', {}), /action must be reload, back, or forward/);

assert.deepEqual(adaptToolCall('select_option', { selector: '#size', value: 'm' }), {
  action: 'select_option',
  args: { target: '#size', value: 'm' },
});
assert.deepEqual(adaptToolCall('select_option', { selector: '#tags', values: ['a', 'b'] }), {
  action: 'select_option',
  args: { target: '#tags', values: ['a', 'b'] },
});
assert.deepEqual(adaptToolCall('select_option', { selector: '#size' }), {
  action: 'select_option',
  args: { target: '#size' },
});

assert.deepEqual(adaptToolCall('set_checked', { selector: '#agree', checked: false }), {
  action: 'set_checked',
  args: { target: '#agree', checked: false },
});
assert.throws(() => adaptToolCall('set_checked', { selector: '#agree' }), /checked must be a boolean/);

assert.deepEqual(adaptToolCall('scroll', { text: 'Pricing' }), { action: 'scroll', args: { text: 'Pricing' } });
assert.deepEqual(adaptToolCall('scroll', { selector: '#end', direction: 'up' }), {
  action: 'scroll',
  args: { target: '#end', direction: 'up' },
});

assert.deepEqual(adaptToolCall('drag', { from: '#a', to: '#b' }), {
  action: 'drag',
  args: { from: '#a', to: '#b' },
});
assert.throws(() => adaptToolCall('drag', { from: '#a' }), /both from and to/);

assert.deepEqual(adaptToolCall('highlight', { selector: '.signin' }), {
  action: 'highlight_region',
  args: { target: '.signin', duration_ms: 30000 },
});
assert.deepEqual(adaptToolCall('highlight', { selector: '.signin', duration_ms: 999999 }), {
  action: 'highlight_region',
  args: { target: '.signin', duration_ms: 120000 },
});
assert.deepEqual(adaptToolCall('highlight', { action: 'clear', highlight_id: 'h1' }), {
  action: 'clear_highlight',
  args: { highlight_id: 'h1' },
});
assert.throws(() => adaptToolCall('highlight', { action: 'clear' }), /highlight_id is required/);

assert.deepEqual(adaptToolCall('hover', { selector: '#menu' }), {
  action: 'hover',
  args: { target: '#menu' },
});
assert.deepEqual(adaptToolCall('activate_tab', { focus_window: true }), {
  action: 'activate_tab',
  args: { focus_window: true },
});
assert.equal(adaptToolCall('fill', { selector: '#a', value: 'b' }), null);

// E2E preflight: a foreign browser (the daily one) must stop the run before
// Playwright starts, unless explicitly overridden.
await assert.doesNotReject(() =>
  assertNoForeignBrowser('unit', async () => ({ extension_connected: false })),
);
await assert.rejects(
  () => assertNoForeignBrowser('unit', async () => ({ extension_connected: true })),
  /already connected to the daemon/,
);
process.env.WEBBRIDGE_E2E_ALLOW_CONNECTED = '1';
await assert.doesNotReject(() =>
  assertNoForeignBrowser('unit', async () => ({ extension_connected: true })),
);
delete process.env.WEBBRIDGE_E2E_ALLOW_CONNECTED;

console.log('tools: ok');
