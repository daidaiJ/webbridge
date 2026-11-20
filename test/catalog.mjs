// Focused tests for the on-demand catalog and argument checks. No browser.

import assert from 'node:assert/strict';

import {
  closestName,
  describeTool,
  overview,
  searchTools,
  signature,
  unknownToolMessage,
  validateArgs,
} from '../src/catalog.mjs';
import { CORE_TOOLS, TOOL_BY_NAME, TOOL_GROUPS, TOOLS } from '../src/tools.mjs';

assert.equal(TOOLS.length, 40);
assert.equal(CORE_TOOLS.length, 13);
assert.equal(overview().workflow.length, 8);
assert.equal(TOOL_GROUPS.reduce((count, group) => count + group.tools.length, 0), 29);

const click = TOOL_BY_NAME.get('click');
assert.deepEqual(validateArgs(click, { selector: '@e1' }), []);
assert.match(validateArgs(click, {})[0], /selector is required/);
assert.match(validateArgs(click, { selctor: '#x' }).join(' '), /did you mean "selector"/);
assert.match(validateArgs(click, { selector: '#x', extra: 1 }).join(' '), /unknown argument "extra"/);

const history = TOOL_BY_NAME.get('history');
assert.deepEqual(validateArgs(history, { action: 'back' }), []);
assert.match(validateArgs(history, { action: 'sideways' }).join(' '), /must be one of/);

const extract = TOOL_BY_NAME.get('extract');
assert.match(
  validateArgs(extract, { selector: '#rows', fields: [{ selector: '.name' }] }).join(' '),
  /fields\[0\]\.name is required/,
);
assert.deepEqual(validateArgs(extract, { selector: '#rows', fields: [{ name: 'n', selector: '.name' }] }), []);

assert.equal(signature(click), 'click({ selector: string })');
assert.match(signature(TOOL_BY_NAME.get('scroll')), /to\?: "top" \| "bottom"/);

const longTail = searchTools('extract');
assert.equal(longTail.matches[0].name, 'extract');
assert.equal(longTail.matches[0].core, false);
assert.match(longTail.hint, /browser_call/);

const reader = searchTools('reader');
assert.ok(reader.matches.some((match) => match.name === 'read_article'));
assert.match(signature(TOOL_BY_NAME.get('read_article')), /max_chars\?/);

const coreHit = searchTools('click');
assert.ok(coreHit.matches.some((match) => match.name === 'click' && match.core));
assert.match(coreHit.hint, /Core results are listed directly/);

const described = describeTool('extract');
assert.equal(described.example.tool, 'extract');
assert.ok(described.related.includes('console'));
assert.match(describeTool('click').note, /core tool/);

assert.equal(closestName('clik', [...TOOL_BY_NAME.keys()]), 'click');
assert.match(unknownToolMessage('clik'), /Did you mean "click"/);

console.log('catalog: ok');
