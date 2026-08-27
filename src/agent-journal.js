// Agent-side event journal: `<stem>-agent.jsonl` beside `<stem>-comments.json`.
//
// The comments store has exactly one writer (main); the agent appends events
// here — one JSON object per line — and never touches the store itself. Every
// reader merges the two files at read time, so the merged truth is derivable
// by anything that can read files, with no process required to fold it.
//
// Event shape (one line each): { "thread": "<id>", …one or more of:
//   "body": "…"                     → an agent reply on that thread
//   "status": "open" | "resolved"   → the thread's disposition
//   "title": "…"                    → the thread's short intent summary
//   "anchor": { … }                 → fields merged into the thread's anchor
//   "anchor_status": "ok|moved|lost"→ repointed a lost anchor
//   with "ts" (epoch ms) and "turn" (the store turn read at write time). }
//
// Events apply in file order. A torn final line — an interrupted append — is
// skipped, never an error: that tolerance is what makes appending safe to
// interrupt. Events naming a thread the store doesn't hold are skipped the
// same way (a discarded thread, or a typo'd id).

const JOURNAL_SUFFIX = '-agent.jsonl';
const STORE_SUFFIX_RE = /-comments\.json$/i;

// The journal sits beside its store, same stem. null for a non-store path so
// callers can't accidentally derive a journal for an arbitrary file.
function journalPathForStore(storePath) {
  const p = String(storePath || '');
  if (!STORE_SUFFIX_RE.test(p)) return null;
  return p.replace(STORE_SUFFIX_RE, JOURNAL_SUFFIX);
}

function parseJournal(text) {
  const events = [];
  if (typeof text !== 'string' || !text) return events;
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    let e;
    try { e = JSON.parse(raw); } catch { continue; } // torn/garbled line
    if (!e || typeof e !== 'object' || typeof e.thread !== 'string' || !e.thread) continue;
    const hasAction = typeof e.body === 'string'
      || e.status === 'open' || e.status === 'resolved'
      || typeof e.title === 'string'
      || (e.anchor && typeof e.anchor === 'object')
      || e.anchor_status === 'ok' || e.anchor_status === 'moved' || e.anchor_status === 'lost';
    if (hasAction) events.push(e);
  }
  return events;
}

// Insert an agent message into a thread's messages by ts, so journal replies
// interleave with user follow-ups written to the store after them (a thread
// can go user → user follow-up → agent reply → user follow-up; file order
// alone would misplace the reply). Messages without a finite ts append.
function insertByTs(messages, msg) {
  if (!Number.isFinite(msg.ts)) { messages.push(msg); return; }
  let i = messages.length;
  while (i > 0) {
    const prev = messages[i - 1];
    if (!Number.isFinite(prev && prev.ts) || prev.ts <= msg.ts) break;
    i -= 1;
  }
  messages.splice(i, 0, msg);
}

// store + events → a NEW merged view (deep copy; the caller's store object is
// never mutated, so write paths can keep operating on the raw store).
function mergeStoreWithJournal(store, events) {
  const view = JSON.parse(JSON.stringify(store && typeof store === 'object' ? store : { threads: [] }));
  if (!Array.isArray(view.threads)) view.threads = [];
  if (!Array.isArray(events) || !events.length) return view;
  const byId = new Map(view.threads.map((t) => [t.id, t]));
  const statusTs = new Map(); // thread id → newest journal status event's ts
  for (const e of events) {
    const t = byId.get(e.thread);
    if (!t) continue;
    if (typeof e.body === 'string' && e.body.trim()) {
      if (!Array.isArray(t.messages)) t.messages = [];
      const msg = { author: 'agent', body: e.body, ts: Number.isFinite(e.ts) ? e.ts : undefined };
      if (Number.isFinite(e.turn)) msg.turn = e.turn;
      insertByTs(t.messages, msg);
    }
    if (e.status === 'open' || e.status === 'resolved') {
      t.status = e.status;
      statusTs.set(t.id, Math.max(statusTs.get(t.id) || 0, Number.isFinite(e.ts) ? e.ts : 0));
    }
    if (typeof e.title === 'string') t.title = e.title;
    if (e.anchor && typeof e.anchor === 'object') t.anchor = { ...(t.anchor || {}), ...e.anchor };
    if (e.anchor_status === 'ok' || e.anchor_status === 'moved' || e.anchor_status === 'lost') {
      t.anchor_status = e.anchor_status;
    }
  }
  // Status is a race between the two files, settled by time: a user follow-up
  // written to the store AFTER the agent's journal `resolved` is the reopen
  // (the follow-up IS the reopen — contract.md), while a `resolved` that came
  // after the follow-up answers it and stands. A status event without ts
  // counts as old, so the user's newer words win the ambiguous case.
  for (const t of view.threads) {
    if (t.status !== 'resolved' || !statusTs.has(t.id)) continue;
    const msgs = t.messages || [];
    const last = msgs[msgs.length - 1];
    if (last && (last.author || 'user') === 'user'
        && Number.isFinite(last.ts) && last.ts > statusTs.get(t.id)) {
      t.status = 'open';
    }
  }
  return view;
}

// Has the agent said or set anything on this thread? What seals a thread
// against Discard: journal events mean the agent has it, even when the
// store's own messages are still wholly the user's.
function threadHasAgentEvents(events, threadId) {
  return Array.isArray(events) && events.some((e) => e.thread === threadId);
}

module.exports = { journalPathForStore, parseJournal, mergeStoreWithJournal, threadHasAgentEvents };
