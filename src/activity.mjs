// In-memory activity ring for the popup. Lets the person see what the agent is
// doing without reading logs; capped so it never grows with session length.

const MAX_ENTRIES = 30;
const entries = [];

export function recordActivity({ tool, session, ok, ms, detail }) {
  entries.push({
    at: new Date().toISOString(),
    tool: String(tool || ''),
    session: String(session || ''),
    ok: ok !== false,
    ms: Number(ms) || 0,
    ...(detail ? { detail: String(detail).slice(0, 200) } : {}),
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function listActivity(limit = 20) {
  return entries.slice(-Math.min(Math.max(Number(limit) || 20, 1), MAX_ENTRIES)).reverse();
}
