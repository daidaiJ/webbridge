// Agent-facing catalog and argument checks.
//
// The core tools are listed directly so an agent can start without a lookup.
// Everything else is discovered through browser_tools: names and one-line
// signatures first, a full schema only for the tool in hand. Detailed help
// therefore costs context on use, not on every request.

import { CORE_TOOL_NAMES, TOOL_BY_NAME, TOOL_GROUPS, TOOLS } from './tools.mjs';

const CORE = new Set(CORE_TOOL_NAMES);

const SUMMARIES = {
  status: 'Check the daemon and extension before starting.',
  start: 'Start the daemon if it is not running.',
  session: 'Name the task and its tab group.',
  navigate: 'Open a URL in the real browser.',
  snapshot: 'Read the page map with @e refs.',
  click: 'Synthetic click on a ref or selector.',
  fill: 'Set an input or editor value.',
  wait: 'Wait for a concrete page condition.',
  read_page: 'Read the page text.',
  screenshot: 'Visual check of the tab or one element.',
  close_session: 'Close the tabs this task opened.',
  activate_tab: 'Bring the task tab to the front; optionally focus the window.',
  history: 'Reload, go back, or go forward in the current tab.',
  find_tab: 'Reselect a tab this task owns, by host; active borrows the foreground tab.',
  list_tabs: 'List the tabs this task owns.',
  list_browser_tabs: 'List every browser tab without attaching.',
  attach_tab: 'Claim an existing tab as borrowed; it stays open after close_session.',
  close_tab: 'Close the current task tab.',
  read_article: 'Reader mode: strip page chrome and return clean article Markdown.',
  find: 'Search page text and return matching @e refs.',
  mouse_click: 'Real pointer click; use when a synthetic click is ignored.',
  key_type: 'Type real keystrokes into the focused element.',
  hover: 'Hover to open menus, tooltips, or preview cards.',
  select_option: 'Choose native <select> options by value or label.',
  set_checked: 'Set a checkbox, radio, switch, or ARIA control.',
  scroll: 'Scroll to an element, text, page edge, or one screen.',
  drag: 'Drag one element onto another; verify with snapshot.',
  upload: 'Set absolute files on a file input.',
  send_keys: 'Send Enter, Escape, Tab, or Mod+A to the focused element.',
  evaluate: 'Run page JavaScript; wrap statements in an IIFE.',
  cdp: 'Raw CDP passthrough; Target.activateTarget is refused.',
  save_as_pdf: 'Render the current tab to PDF and return its path.',
  highlight: 'Draw a temporary box around an element for the user.',
  capture_page: 'Save the tab as Markdown with frontmatter and links.',
  extract: 'Extract repeated elements as JSON with optional fields.',
  console: 'Start, read, or stop console and error capture.',
  dialog: 'Inspect or answer an alert, confirm, or prompt.',
  network: 'Start, list, detail, or stop network capture.',
  batch: 'Run up to 40 steps in one round-trip; stops at the first error.',
  request_human: 'Hand control to the person for sign-in, 2FA, captcha, or a decision.',
};

const EXAMPLES = {
  history: { action: 'back' },
  read_article: { max_chars: 60000 },
  attach_tab: { tabId: 123 },
  find_tab: { url: 'example.com' },
  mouse_click: { selector: '@e4' },
  key_type: { text: 'search phrase' },
  hover: { selector: '@e7' },
  select_option: { selector: '#size', value: 'm' },
  set_checked: { selector: '#agree', checked: true },
  scroll: { to: 'bottom' },
  drag: { from: '#card-1', to: '#done' },
  upload: { selector: 'input[type=file]', files: ['C:/path/file.pdf'] },
  evaluate: { code: "(() => document.title)()" },
  cdp: { method: 'Network.getResponseBody', params: { requestId: '123.4' } },
  highlight: { selector: '@e9', duration_ms: 10000 },
  extract: { selector: '#rows tr', fields: [{ name: 'name', selector: '.name' }] },
  console: { action: 'start' },
  dialog: { action: 'accept' },
  network: { cmd: 'start' },
  batch: { steps: [{ tool: 'fill', args: { selector: '#q', value: 'grok' } }, { tool: 'click', args: { selector: '#go' } }] },
  request_human: { reason: 'Sign in to continue', instructions: 'Finish the login, then press Continue.' },
  capture_page: { tags: ['research'] },
  save_as_pdf: { path: 'C:/tmp/page.pdf' },
};

export const WORKFLOW = [
  'status: confirm running:true and extension_connected:true; if not, call start and ask the user to enable the extension.',
  'session: name the task once (one task = one visible tab group).',
  'navigate: open the URL; newTab:true keeps earlier pages.',
  'snapshot: read the @e refs and choose a target.',
  'click or fill: act on an @e ref (preferred) or a CSS selector.',
  'wait: wait for a concrete result (text, text_gone, or selector).',
  'snapshot, read_page, or screenshot: verify behavior, not just appearance.',
  'close_session: close the tabs this task opened; borrowed tabs stay open.',
];

function groupOf(name) {
  return TOOL_GROUPS.find((group) => group.tools.includes(name));
}

function typeOf(schema = {}) {
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (schema.type === 'array') return `${typeOf(schema.items || {})}[]`;
  if (schema.type === 'object' || schema.properties) return 'object';
  return schema.type || 'any';
}

export function signature(tool) {
  const properties = tool.inputSchema.properties || {};
  const required = new Set(tool.inputSchema.required || []);
  const entries = Object.entries(properties).map(
    ([name, schema]) => `${name}${required.has(name) ? '' : '?'}: ${typeOf(schema)}`,
  );
  return entries.length === 0 ? `${tool.name}()` : `${tool.name}({ ${entries.join(', ')} })`;
}

export function overview() {
  return {
    workflow: WORKFLOW,
    groups: TOOL_GROUPS.map(({ name, about, tools }) => ({ name, about, tools })),
    hint: 'Core tools are listed directly. browser_tools {query:"..."} searches; browser_tools {tool:"name"} returns its arguments and an example; browser_call {tool, args} runs a long-tail tool.',
  };
}

export function searchTools(query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return overview();
  const matches = TOOLS.map((tool) => {
    const core = CORE.has(tool.name);
    const group = groupOf(tool.name);
    const name = tool.name.toLowerCase();
    const summary = (SUMMARIES[tool.name] || '').toLowerCase();
    const description = tool.description.toLowerCase();
    let score = 0;
    if (name === needle) score = 100;
    else if (name.startsWith(needle)) score = 80;
    else if (name.includes(needle)) score = 60;
    else if (summary.includes(needle)) score = 40;
    else if (description.includes(needle)) score = 25;
    else if (group && group.name.includes(needle)) score = 20;
    return { tool, core, score };
  })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, 10)
    .map(({ tool, core }) => ({
      name: tool.name,
      core,
      group: core ? 'core' : groupOf(tool.name)?.name,
      summary: SUMMARIES[tool.name],
      signature: signature(tool),
    }));
  const hasCore = matches.some((match) => match.core);
  const hasLongTail = matches.some((match) => !match.core);
  return {
    query,
    matches,
    hint:
      matches.length === 0
        ? 'No match. Try a broader word, or call browser_tools with no arguments for the groups.'
        : [
            hasCore ? 'Core results are listed directly; call them without browser_call.' : '',
            hasLongTail ? 'For long-tail results, browser_tools {tool:"name"} then browser_call {tool, args}.' : '',
          ]
            .filter(Boolean)
            .join(' '),
  };
}

export function describeTool(name) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return null;
  const group = groupOf(name);
  return {
    name,
    group: group?.name,
    summary: SUMMARIES[name] || tool.description.split('. ')[0],
    signature: signature(tool),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(EXAMPLES[name] ? { example: { tool: name, args: EXAMPLES[name] } } : {}),
    related: (group?.tools || []).filter((related) => related !== name),
    ...(CORE.has(name) ? { note: 'This is a core tool; call it directly, without browser_call.' } : {}),
  };
}

export function unknownToolMessage(name) {
  const suggestion = closestName(name, [...TOOL_BY_NAME.keys()]);
  return `unknown tool "${name}".${suggestion ? ` Did you mean "${suggestion}"?` : ''} Call browser_tools with no arguments for the groups.`;
}

function join(path, key) {
  return path ? `${path}.${key}` : key;
}

export function validateArgs(tool, args) {
  const value = args == null ? {} : args;
  if (typeof value !== 'object' || Array.isArray(value)) return ['arguments must be an object'];
  const errors = [];
  checkObject('', value, tool.inputSchema, errors);
  return errors;
}

function checkObject(path, value, schema, errors) {
  const properties = schema.properties || {};
  const required = schema.required || [];
  for (const key of required) {
    if (value[key] === undefined) errors.push(`${join(path, key)} is required`);
  }
  for (const [key, child] of Object.entries(value)) {
    const childSchema = properties[key];
    if (!childSchema) {
      if (schema.additionalProperties === true) continue;
      const suggestion = closestName(key, Object.keys(properties));
      errors.push(`unknown argument "${join(path, key)}"${suggestion ? ` (did you mean "${suggestion}"?)` : ''}`);
      continue;
    }
    checkValue(join(path, key), child, childSchema, errors);
  }
}

function checkValue(path, value, schema, errors) {
  if (value === undefined) return;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
    return;
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path} must be a string`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path} must be a number`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
      return;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`);
        return;
      }
      value.forEach((item, index) => checkValue(`${path}[${index}]`, item, schema.items || {}, errors));
      return;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path} must be an object`);
        return;
      }
      checkObject(path, value, schema, errors);
      return;
    default:
      if (schema.properties) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          errors.push(`${path} must be an object`);
          return;
        }
        checkObject(path, value, schema, errors);
      }
  }
}

export function closestName(name, candidates) {
  const needle = String(name || '').toLowerCase();
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(needle, String(candidate).toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const limit = needle.length <= 4 ? 1 : 2;
  return best !== null && bestDistance <= limit ? best : null;
}

function editDistance(left, right) {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}
