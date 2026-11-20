// Maps the MCP tool surface onto daemon actions. Most tools forward one-to-one;
// a few combine related actions so the model gets a task-oriented vocabulary
// (history, highlight) instead of vendor-internal action names.

function selectorOf(args) {
  const value = args.selector ?? args.target;
  return value == null ? '' : String(value).trim();
}

function durationOf(args) {
  const value = Number(args.duration_ms);
  if (!Number.isFinite(value)) return 30000;
  return Math.min(Math.max(Math.round(value), 1000), 120000);
}

export function adaptToolCall(name, args = {}) {
  const input = args && typeof args === 'object' ? args : {};

  switch (name) {
    case 'history': {
      if (input.action === 'reload') return { action: 'reload', args: {} };
      if (input.action === 'back') return { action: 'go_back', args: {} };
      if (input.action === 'forward') return { action: 'go_forward', args: {} };
      throw new Error('history: action must be reload, back, or forward');
    }
    case 'highlight': {
      const action = input.action === 'clear' ? 'clear' : 'show';
      if (action === 'clear') {
        const id = typeof input.highlight_id === 'string' ? input.highlight_id.trim() : '';
        if (!id) throw new Error('highlight: highlight_id is required to clear');
        return { action: 'clear_highlight', args: { highlight_id: id } };
      }
      if (typeof input.highlight_id === 'string' && input.highlight_id.trim()) {
        return {
          action: 'highlight_region',
          args: { highlight_id: input.highlight_id.trim(), duration_ms: durationOf(input) },
        };
      }
      const target = selectorOf(input);
      if (!target) throw new Error('highlight: selector is required for action "show"');
      return { action: 'highlight_region', args: { target, duration_ms: durationOf(input) } };
    }
    case 'hover': {
      const target = selectorOf(input);
      if (!target) throw new Error('hover: selector is required');
      return {
        action: 'hover',
        args: { target, ...(input.focus_emulation === true ? { focus_emulation: true } : {}) },
      };
    }
    case 'key_type': {
      if (typeof input.text !== 'string') throw new Error('key_type: text is required');
      return {
        action: 'key_type',
        args: { text: input.text, ...(input.focus_emulation === true ? { focus_emulation: true } : {}) },
      };
    }
    case 'select_option': {
      const target = selectorOf(input);
      if (!target) throw new Error('select_option: selector is required');
      const values = Array.isArray(input.values) ? input.values.map(String) : [];
      const args = { target, ...(values.length > 0 ? { values } : {}) };
      if (values.length === 0 && typeof input.value === 'string') args.value = input.value;
      return { action: 'select_option', args };
    }
    case 'set_checked': {
      const target = selectorOf(input);
      if (!target) throw new Error('set_checked: selector is required');
      if (typeof input.checked !== 'boolean') throw new Error('set_checked: checked must be a boolean');
      return { action: 'set_checked', args: { target, checked: input.checked } };
    }
    case 'scroll': {
      const target = selectorOf(input);
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      const out = {};
      if (target) out.target = target;
      else if (text) out.text = text;
      if (input.to === 'top' || input.to === 'bottom') out.to = input.to;
      if (input.direction === 'up' || input.direction === 'down') out.direction = input.direction;
      return { action: 'scroll', args: out };
    }
    case 'drag': {
      const from = String(input.from || '').trim();
      const to = String(input.to || '').trim();
      if (!from || !to) throw new Error('drag: both from and to are required');
      return { action: 'drag', args: { from, to } };
    }
    case 'activate_tab': {
      return {
        action: 'activate_tab',
        args: input.focus_window === true ? { focus_window: true } : {},
      };
    }
    default:
      return null;
  }
}
