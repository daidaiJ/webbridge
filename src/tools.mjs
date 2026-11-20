// Tool surface exposed over MCP. Every definition forwards to the daemon's
// /command action of the same name; only the args documented by the daemon are
// declared, so the model cannot drift into extension-internal parameters.

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const strList = (description) => ({ type: 'array', items: { type: 'string' }, description });

const noArgs = { type: 'object', properties: {} };

export const TOOLS = [
  {
    name: 'navigate',
    description:
      'Open a URL in the user\'s real browser. Reuses the task tab by default; newTab:true keeps the current page open. ' +
      'Pass group_title on the first call so the task tabs are labeled together.',
    inputSchema: {
      type: 'object',
      properties: {
        url: str('Absolute URL including the scheme, e.g. https://example.com'),
        newTab: bool('Open in a new tab instead of reusing the current task tab'),
        group_title: str('Human-readable tab-group label, set once per task'),
      },
      required: ['url'],
    },
    timeoutMs: 60_000,
  },
  {
    name: 'activate_tab',
    description:
      'Bring the current task tab to the front so the person can see it. Set focus_window:true to also focus the browser window. ' +
      'Use before request_human and whenever the human needs to look at the page.',
    inputSchema: {
      type: 'object',
      properties: { focus_window: bool('Also focus the browser window') },
    },
    timeoutMs: 30_000,
  },
  {
    name: 'history',
    description:
      'Reload the current tab, or move back or forward in its history. The bound is the tab\'s own history, ' +
      'so back at the first entry returns a daemon error.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['reload', 'back', 'forward'], description: 'History operation' },
      },
      required: ['action'],
    },
    timeoutMs: 60_000,
  },
  {
    name: 'find_tab',
    description:
      'Select a tab already owned by this task, matched by host. Use active:true to borrow the tab the user is currently viewing. ' +
      'If it fails, the page is not open in this task: call navigate with newTab:true.',
    inputSchema: {
      type: 'object',
      properties: {
        url: str('URL or host keyword'),
        active: bool('Borrow the foreground tab the user is viewing'),
      },
      required: ['url'],
    },
  },
  {
    name: 'list_tabs',
    description: 'List the tabs owned by this task, with tabId, url, title, active, groupTitle and borrowed.',
    inputSchema: noArgs,
  },
  {
    name: 'list_browser_tabs',
    description: 'List every tab in the browser across windows, without attaching or focusing. Use before attach_tab.',
    inputSchema: noArgs,
  },
  {
    name: 'attach_tab',
    description:
      'Attach an existing tab (from list_browser_tabs) to this task. Borrowed tabs are spared by close_session. ' +
      'This does not focus the tab, so the user keeps their foreground page.',
    inputSchema: {
      type: 'object',
      properties: { tabId: num('Chrome tab id') },
      required: ['tabId'],
    },
  },
  {
    name: 'close_tab',
    description: 'Close the current task tab. Use only when closing that page is intended.',
    inputSchema: noArgs,
  },
  {
    name: 'close_session',
    description:
      'Finish the task: close the tabs it opened. Borrowed user tabs stay open. Call when results are saved ' +
      'or the user asks to clean up. Returns the number closed.',
    inputSchema: noArgs,
    timeoutMs: 60_000,
  },
  {
    name: 'snapshot',
    description:
      'Page map: the accessibility tree with @e refs for clicking and filling. Call after navigate and after ' +
      'every page change; refs go stale. Default returns JSON {url, title, tree}; format:"aria" returns text with max_chars and cursor. ' +
      'On large or still-loading pages, use format:"aria" with max_chars, snapshot(ref), or wait for a selector first; JSON can be big or slow. Next: click or fill with a ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: str('Optional @e ref to narrow the snapshot to one subtree'),
        format: { type: 'string', enum: ['json', 'aria'], description: 'json (default) or aria text' },
        max_chars: num('ARIA text cap, 1-60000'),
        cursor: str('Continuation cursor from a previous ARIA response'),
      },
    },
    timeoutMs: 45_000,
  },
  {
    name: 'read_article',
    description:
      'Reader mode: strip navigation, sidebars, comments, and ads, then return the article as clean Markdown ' +
      'with title, byline, and date. Use it to quote, summarize, or save an article without page chrome. ' +
      'On pages without an article container, it falls back to the winning text block.',
    inputSchema: {
      type: 'object',
      properties: {
        max_chars: num('Markdown cap, 1000-200000, default 60000'),
      },
    },
    timeoutMs: 90_000,
  },
  {
    name: 'find',
    description: 'Search the page text and return matching @e refs; narrow a large page with snapshot(ref).',
    inputSchema: {
      type: 'object',
      properties: { query: str('Text or phrase to find') },
      required: ['query'],
    },
  },
  {
    name: 'read_page',
    description:
      'Read the page\'s main text when you need content rather than structure. Keep max_chars near the amount you need; ' +
      'a much larger cap can add scan time. Use start to page through long documents. For clicking, use snapshot; ' +
      'for embedded documents, pass the frame handle from snapshot.frames.',
    inputSchema: {
      type: 'object',
      properties: {
        max_chars: num('Maximum characters to return'),
        start: num('Character offset to continue from'),
        frame: str('Frame handle from snapshot.frames, e.g. #f1'),
      },
    },
    timeoutMs: 90_000,
  },
  {
    name: 'wait',
    description:
      'Wait for a concrete page condition after an action: visible text, text that disappears, or a selector. ' +
      'Any one ends the wait; timeout_ms is 500-60000 and defaults to 10000. Set snapshot:true to get the page map in the same call. Next: snapshot or read_page to confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('Visible text to wait for (case-insensitive)'),
        text_gone: str('Visible text to wait to disappear'),
        selector: str('CSS selector to wait for'),
        frame: str('Wait for an embedded document, or pass "any"'),
        timeout_ms: num('Timeout in ms, 500-60000'),
        snapshot: bool('Include a snapshot when the condition matches'),
      },
    },
    timeoutMs: 90_000,
  },
  {
    name: 'click',
    description:
      'Click an element by @e ref from the latest snapshot (preferred) or a CSS selector. This is a synthetic click; ' +
      'if the page ignores it, use browser_tools to find mouse_click. Next: wait, then snapshot or read_page to verify.',
    inputSchema: {
      type: 'object',
      properties: { selector: str('@e ref or CSS selector') },
      required: ['selector'],
    },
    timeoutMs: 45_000,
  },
  {
    name: 'mouse_click',
    description: 'Real pointer click (mousedown/mouseup) at the element center. For sites that ignore synthetic clicks.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: str('@e ref or CSS selector'),
        focus_emulation: bool('Enable focus emulation first, required for background tabs'),
      },
      required: ['selector'],
    },
    timeoutMs: 60_000,
  },
  {
    name: 'key_type',
    description:
      'Type text into the focused element as real keystrokes (Input.insertText). Focus the field first with mouse_click ' +
      'when click does not, then call this for search boxes with autocomplete, masked inputs, or editors that reject set values.',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('Text to insert'),
        focus_emulation: bool('Enable focus emulation for a background tab'),
      },
      required: ['text'],
    },
    timeoutMs: 45_000,
  },
  {
    name: 'hover',
    description:
      'Move the pointer over an element to open hover menus, tooltips, and preview cards. Pairs with a following ' +
      'snapshot (or read_page) that sees the revealed content.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: str('@e ref or CSS selector'),
        focus_emulation: bool('Enable focus emulation for a background tab'),
      },
      required: ['selector'],
    },
    timeoutMs: 45_000,
  },
  {
    name: 'select_option',
    description:
      'Choose options in a native <select> by value or visible label, firing input and change events. ' +
      'For custom dropdown widgets, click to open the menu and click the option instead. ' +
      'With no value and no values, returns the available options.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: str('@e ref or CSS selector for the <select>'),
        value: str('One option value or visible label'),
        values: strList('Several options for a multiple select'),
      },
      required: ['selector'],
    },
    timeoutMs: 45_000,
  },
  {
    name: 'set_checked',
    description:
      'Set a checkbox, radio, switch, or ARIA checkbox/switch to a given state, including indeterminate handling. ' +
      'Use when click would toggle an already-correct state or the control is a styled label.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: str('@e ref or CSS selector'),
        checked: bool('Desired state, true or false'),
      },
      required: ['selector', 'checked'],
    },
    timeoutMs: 45_000,
  },
  {
    name: 'scroll',
    description:
      'Scroll to an element, to visible text, to the page top/bottom, or one screen up/down. ' +
      'Use it to load lazy content before snapshot, or to bring a target into view. ' +
      'When several inputs are given, target wins over text, and to/direction scroll the page.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: str('@e ref or CSS selector to scroll into view'),
        text: str('Visible text to find and scroll to'),
        to: { type: 'string', enum: ['top', 'bottom'], description: 'Scroll the page to an edge' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll one screen, default down' },
      },
    },
    timeoutMs: 45_000,
  },
  {
    name: 'drag',
    description:
      'Drag from one element to another using HTML5 drag events or a pointer sequence. The result states which mode ' +
      'ran; a pointer drag reports dispatched without verification, so confirm the outcome with snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        from: str('@e ref or CSS selector for the drag source'),
        to: str('@e ref or CSS selector for the drop target'),
      },
      required: ['from', 'to'],
    },
    timeoutMs: 60_000,
  },
  {
    name: 'fill',
    description:
      'Set an input, textarea, or rich-editor value in one step. Pass an @e ref from the latest snapshot or a CSS ' +
      'selector. For autocomplete, masked inputs, or keystroke-driven editors, use browser_tools to find key_type. Next: wait, then verify.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: str('@e ref or CSS selector'),
        value: str('Text to set'),
      },
      required: ['selector', 'value'],
    },
    timeoutMs: 45_000,
  },
  {
    name: 'send_keys',
    description:
      'Dispatch keyboard keys to the focused element: Enter, Escape, Tab, ArrowDown, or Mod+A / Control+C. ' +
      'Use focus_emulation for background tabs. Verify page state afterwards; dispatch alone does not prove submission.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: str('Key sequence, e.g. "Enter", "Escape", "Mod+A", "Shift+Tab Enter"'),
        repeat: num('Repeat count, 1-100'),
        focus_emulation: bool('Enable focus emulation for a background tab'),
      },
      required: ['keys'],
    },
    timeoutMs: 60_000,
  },
  {
    name: 'evaluate',
    description:
      'Run page JavaScript and return {type, value}. Wrap statements or async work in an IIFE: ' +
      '(() => {...})() or (async () => {...})(). Keep returned data compact.',
    inputSchema: {
      type: 'object',
      properties: { code: str('JavaScript source') },
      required: ['code'],
    },
    timeoutMs: 30_000,
  },
  {
    name: 'cdp',
    description:
      'Raw Chrome DevTools Protocol passthrough for actions the higher-level tools cannot express. ' +
      'Target.activateTarget is refused; use Page.bringToFront, or Emulation.setFocusEmulationEnabled for background input.',
    inputSchema: {
      type: 'object',
      properties: {
        method: str('CDP method, e.g. Network.getResponseBody'),
        params: { type: 'object', description: 'CDP parameters', additionalProperties: true },
      },
      required: ['method'],
    },
    timeoutMs: 60_000,
  },
  {
    name: 'screenshot',
    description:
      'Visual check of the tab or one element; returns the image plus a file path. Use it for layout and appearance; ' +
      'use snapshot or read_page for content. PNG by default; format:"jpeg" with quality for smaller captures.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'png (default) or jpeg' },
        quality: num('JPEG quality 0-100'),
        selector: str('Optional @e ref or CSS selector for one element'),
        path: str('Optional absolute output path; omit to use the daemon default directory'),
      },
    },
    timeoutMs: 60_000,
    image: true,
  },
  {
    name: 'save_as_pdf',
    description: 'Render the current tab to PDF and return the saved file path.',
    inputSchema: {
      type: 'object',
      properties: {
        paper_format: { type: 'string', enum: ['letter', 'legal', 'a4', 'a3', 'tabloid'], description: 'Paper size, default letter' },
        landscape: bool('Landscape orientation'),
        scale: num('Scale 0.1-2, default 1'),
        print_background: bool('Print background graphics, default true'),
        path: str('Optional absolute output path'),
      },
    },
    timeoutMs: 90_000,
  },
  {
    name: 'highlight',
    description:
      'Draw a temporary box around an element in the real page so the person can see exactly where to look or click. ' +
      'Use it with request_human for sign-in fields, consent buttons, and any hand-off. ' +
      'action:"show" returns a highlight_id; action:"clear" removes it. Highlights expire after duration_ms (default 30 s, max 120 s).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['show', 'clear'], description: 'show (default) or clear' },
        selector: str('@e ref or CSS selector to highlight'),
        highlight_id: str('Highlight to renew or clear'),
        duration_ms: num('Lifetime in ms, 1000-120000, default 30000'),
      },
    },
    timeoutMs: 30_000,
  },
  {
    name: 'capture_page',
    description:
      'Bookmark the current tab as agent-friendly Markdown with YAML frontmatter (url, title, captured_at, tags) ' +
      'plus a links section. One bounded DOM walk, no extra network traffic. Writes <YYYYMMDD-HHmmss>-<slug>.md and ' +
      'appends a line to index.jsonl in the capture directory (WEBBRIDGE_CAPTURE_DIR or ~/.webbridge/captures).',
    inputSchema: {
      type: 'object',
      properties: {
        dir: str('Absolute output directory; overrides WEBBRIDGE_CAPTURE_DIR'),
        tags: strList('Tags stored in the frontmatter and index line'),
        screenshot: bool('Also save a PNG next to the Markdown; off by default for speed'),
        max_chars: num('Text cap, 1000-400000, default 120000'),
      },
    },
    timeoutMs: 90_000,
  },
  {
    name: 'extract',
    description:
      'Extract structured data with CSS selectors: matching elements become JSON objects. Without fields, each item ' +
      'returns text plus href for links, src for images, or value for inputs. With fields, each item returns only ' +
      'the named sub-selectors/attributes. Use for tables, cards, lists and search results; cheaper than a full ' +
      'snapshot when you know the markup.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: str('CSS selector for the repeated items, e.g. "table tbody tr"'),
        fields: {
          type: 'array',
          description: 'Optional per-item fields, up to 12',
          items: {
            type: 'object',
            properties: {
              name: str('Output key'),
              selector: str('Selector inside each item; omit for the item itself'),
              attr: str('Read this attribute instead of text'),
            },
            required: ['name'],
          },
        },
        max_items: num('Maximum items to return, 1-500, default 50'),
        include_empty: bool('Keep items whose fields are all empty'),
      },
      required: ['selector'],
    },
    timeoutMs: 60_000,
  },
  {
    name: 'console',
    description:
      'Read console output and page errors for the current tab. Call action:"start" before the interaction, then ' +
      'action:"read" (optionally clear:true) to collect log/info/warn/error/debug plus uncaught errors and ' +
      'unhandled rejections. Bounded to 200 entries; action:"stop" removes the hook.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'read', 'stop'], description: 'start, read (default), or stop' },
        clear: bool('With read, clear messages after returning them'),
      },
    },
    timeoutMs: 30_000,
  },
  {
    name: 'dialog',
    description:
      'Inspect or answer a JavaScript dialog (alert/confirm/prompt). A blocking dialog stalls other commands, ' +
      'so use action:"accept" or "dismiss" when one is open. text supplies the prompt answer.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'accept', 'dismiss'], description: 'Dialog operation' },
        text: str('Prompt answer for accept, when the dialog asks for text'),
      },
      required: ['action'],
    },
    timeoutMs: 30_000,
  },
  {
    name: 'upload',
    description: 'Set files on a file input. Files must be absolute local paths readable by the daemon.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: str('CSS selector for the input[type=file]'),
        files: strList('Absolute file paths'),
      },
      required: ['selector', 'files'],
    },
    timeoutMs: 60_000,
  },
  {
    name: 'network',
    description:
      'Capture network requests for the current tab. cmd:"start" begins capture, "list" lists requests (filter by URL substring), ' +
      '"detail" returns headers/body for one requestId, "stop" ends capture (and drops response bodies, so read details first).',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', enum: ['start', 'stop', 'list', 'detail'], description: 'Operation' },
        filter: str('URL substring filter for list'),
        requestId: str('Request id for detail'),
      },
      required: ['cmd'],
    },
    timeoutMs: 45_000,
  },
  {
    name: 'status',
    description:
      'Preflight. Report whether the local daemon and the browser extension are connected, plus the active toolset. ' +
      'Call this first. Browser tools start the daemon lazily when needed; if extension_connected is false, ask the user to enable the extension, then retry once.',
    inputSchema: noArgs,
  },
  {
    name: 'start',
    description:
      'Start the local daemon if it is not running, then report status. Safe to call repeatedly. Browser tools also do this lazily; start is only for prewarming.',
    inputSchema: noArgs,
    timeoutMs: 60_000,
  },
  {
    name: 'session',
    description:
      'Name this task; its pages form one visible tab group. Call once at the start of a multi-step task ' +
      '(e.g. "compare-phones"). Skip it for a single quick page.',
    inputSchema: {
      type: 'object',
      properties: { name: str('Session name for this task') },
      required: ['name'],
    },
  },
  {
    name: 'batch',
    description:
      'Run several tool calls in one round-trip and return per-step results. Use for tight sequences ' +
      '(fill → click → wait) and flash-sale timing, where extra calls add latency. Steps stop at the first ' +
      'failure unless stop_on_error is false. Images are not returned; use the screenshot tool directly.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Up to 40 steps, executed in order',
          items: {
            type: 'object',
            properties: {
              tool: str('Tool name, e.g. click'),
              args: { type: 'object', description: 'Arguments for that tool', additionalProperties: true },
            },
            required: ['tool'],
          },
        },
        stop_on_error: bool('Stop after the first failure, default true'),
      },
      required: ['steps'],
    },
    timeoutMs: 300_000,
  },
  {
    name: 'request_human',
    description:
      'Hand control back to the person and wait: sign-in, 2FA, captcha, consent, or any step that needs their ' +
      'judgment. The extension opens a small prompt with the reason; the call returns when they press Continue ' +
      'or the timeout passes, then re-check the page. Never use this to confirm payment; stop at the order page ' +
      'and let the person finish.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: str('One short line shown to the person'),
        instructions: str('What they should do, in their language'),
        timeout_ms: num('Wait limit in ms, 5000-600000, default 120000'),
      },
      required: ['reason'],
    },
    timeoutMs: 620_000,
  },
];

// Core tools are listed directly so a first-time agent can act without a
// discovery step. The order is the workflow order.
export const CORE_TOOL_NAMES = [
  'status',
  'start',
  'session',
  'navigate',
  'snapshot',
  'click',
  'fill',
  'wait',
  'read_page',
  'screenshot',
  'close_session',
];

const META_TOOLS = [
  {
    name: 'browser_tools',
    description:
      'The rest of the browser suite: tabs, extraction, network, console, files, PDF, JavaScript, batch, and human ' +
      'handoff. No arguments returns the workflow and tool groups; query searches names and descriptions; tool returns ' +
      'one tool\'s full arguments and an example. Use it before browser_call.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('Words to match in tool names or descriptions'),
        tool: str('Exact tool name, e.g. "extract"'),
      },
    },
  },
  {
    name: 'browser_call',
    description:
      'Run a long-tail tool by name with its argument object. Call browser_tools {tool} first to get the arguments. ' +
      'Core tools are listed directly; prefer them.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: str('Tool name from browser_tools'),
        args: { type: 'object', description: 'Arguments for that tool', additionalProperties: true },
      },
      required: ['tool'],
    },
  },
];

// Groups keep the on-demand catalog scannable: an agent that needs a dropdown
// or a network trace sees the relevant cluster instead of 29 unrelated names.
export const TOOL_GROUPS = [
  {
    name: 'tabs',
    about: 'Find, borrow, activate, or close tabs',
    tools: ['list_tabs', 'list_browser_tabs', 'find_tab', 'attach_tab', 'activate_tab', 'close_tab'],
  },
  {
    name: 'read',
    about: 'Reader mode, search, extract, console, network, and dialogs',
    tools: ['read_article', 'find', 'extract', 'console', 'network', 'dialog'],
  },
  {
    name: 'interact',
    about: 'Real pointer, keyboard, select, hover, scroll, drag, and upload',
    tools: ['mouse_click', 'key_type', 'send_keys', 'hover', 'select_option', 'set_checked', 'scroll', 'drag', 'upload'],
  },
  {
    name: 'output',
    about: 'PDF, page capture, and highlights',
    tools: ['save_as_pdf', 'capture_page', 'highlight'],
  },
  {
    name: 'history',
    about: 'Reload, go back, or go forward',
    tools: ['history'],
  },
  {
    name: 'script',
    about: 'Page JavaScript and raw CDP',
    tools: ['evaluate', 'cdp'],
  },
  {
    name: 'flow',
    about: 'Batch steps and human handoff',
    tools: ['batch', 'request_human'],
  },
];

const CORE_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const CORE_TOOLS_ONLY = CORE_TOOL_NAMES.map((name) => CORE_BY_NAME.get(name));

export const CORE_TOOLS = [...CORE_TOOLS_ONLY, ...META_TOOLS];

export const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
