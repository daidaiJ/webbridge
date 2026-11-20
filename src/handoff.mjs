// Human-in-the-loop handoffs. The MCP server opens a handoff, the extension
// shows it to the person, and the blocked tool call resumes when they press
// Continue. State is process-local on loopback only.

const pending = new Map();
const watchers = new Set();
const subscribers = new Set();
let sequence = 0;

function publicView(entry) {
  return {
    id: entry.id,
    reason: entry.reason,
    instructions: entry.instructions,
    session: entry.session,
    url: entry.url,
    createdAt: entry.createdAt,
    deadline: entry.deadline,
  };
}

function notify() {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(listHandoffs());
    } catch {
      // A broken push client must not block the waiting tool call.
    }
  }
  for (const wake of [...watchers]) {
    watchers.delete(wake);
    wake();
  }
}

// Push channel for the extension's WebSocket. The listener receives the full
// pending list on every change, and once immediately so a fresh connection
// starts from current state.
export function subscribeHandoffs(listener) {
  subscribers.add(listener);
  try {
    listener(listHandoffs());
  } catch {
    // ignored, same as above
  }
  return () => subscribers.delete(listener);
}

export function openHandoff({ reason, instructions, session, url, timeoutMs = 120000 }) {
  const id = `${Date.now().toString(36)}h${++sequence}`;
  let resolveWait;
  const wait = new Promise((resolve) => {
    resolveWait = resolve;
  });
  const entry = {
    id,
    reason,
    instructions,
    session,
    url,
    createdAt: Date.now(),
    deadline: Date.now() + timeoutMs,
    done: false,
  };
  const finish = (value) => {
    if (entry.done) return;
    entry.done = true;
    pending.delete(id);
    resolveWait(value);
    notify();
  };
  entry.finish = finish;
  pending.set(id, entry);
  notify();
  return { id, wait, finish };
}

export function resumeHandoff(id) {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.finish({ resumed: true, handoff_id: id, at: new Date().toISOString() });
  return true;
}

export function listHandoffs() {
  return [...pending.values()].map(publicView);
}

// Long-poll used by the extension. Resolves on the next change or after
// waitMs, whichever comes first, so the worker does one tiny local request
// per window instead of spinning.
export function waitForHandoffChange(waitMs = 20000) {
  if (pending.size > 0) return Promise.resolve(listHandoffs());
  return new Promise((resolve) => {
    let timer;
    const wake = () => {
      clearTimeout(timer);
      resolve(listHandoffs());
    };
    watchers.add(wake);
    timer = setTimeout(() => {
      watchers.delete(wake);
      resolve(listHandoffs());
    }, waitMs);
  });
}
