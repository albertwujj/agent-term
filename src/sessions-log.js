// Sessions log + active-window registry + pending-recovery snapshot.
//
// Three on-disk artifacts under <userData>/:
//
//   sessions.jsonl
//     Append-only newline-delimited JSON event log. Events:
//       { e:"started",  id, hue,    t }
//       { e:"cli",      id, cli,    t }
//       { e:"title",    id, title,  t }
//       { e:"prompt",   id, prompt, t }
//       { e:"branches", id, repo, branch, t }   // git branch captured from a review://
//       { e:"closed",   id,         t }
//     Reading the log and folding by id yields the current state of every
//     session ever recorded. Newer events override older for fields like title.
//
//   active/<id>.json
//     Per-live-window file: { pid, bootTime, ... } where bootTime is rounded
//     to the nearest minute (cross-boot reuse of pids becomes detectable).
//     Schema is open for extensions (e.g., a TCP port for future flash-focus).
//     Created on window start, deleted on graceful close.
//
//   pending-recovery.json
//     { bootTime, pendingIds: [number...] }
//     Initialized at first read after a reboot — populated with all session
//     ids that have started+cli+prompt but no closed event AND aren't currently
//     active. Decremented as the user picks/dismisses sessions in the picker.
//     Auto-recovery picker auto-shows while this set is non-empty (and the
//     current Agent Term wasn't launched with --auto-relaunch).
//
// All operations are file-system based (no in-process state) so multiple
// Agent Term instances can read/write concurrently. Writes use either
// atomic-rename or POSIX append-O_APPEND semantics, both of which serialize
// correctly across processes on the platforms we ship to.

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  normalizeSearchText,
  parseSearchTerms,
  textMatchesSearchTerms,
  findAllTermRanges,
} = require('./search-terms');
const { currentGuiSession } = require('./gui-session');

const RECENT_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;   // 4 weeks (display + compaction window)

// Round to the nearest minute so os.uptime()'s second-resolution ticks don't
// break equality comparisons across rapid-fire reads/writes within one boot.
function currentBootTime() {
  return Math.round((Date.now() - os.uptime() * 1000) / 60000) * 60000;
}

// How far two boot stamps may drift and still mean the same boot.
//
// The stamp is derived (now − uptime), so it inherits the platform's uptime
// source. macOS reads kern.boottime, a wall-clock instant, so every process
// computes the same stamp for the whole boot. Windows derives uptime from a
// performance counter that does not advance across sleep/hibernate and drifts
// as the wall clock resyncs, so the derived stamp walks forward while the
// machine stays up — two live windows can hold stamps hours apart. Rounding
// adds its own flip when the true value sits near a 30s boundary.
//
// Equality therefore read live Windows windows as dead: they were skipped by
// the cap and the picker, gc deleted their records, and a user close saw zero
// visible sessions and relaunched even with other windows on screen.
//
// Live windows restamp on every activity heartbeat (ACTIVITY_REFRESH_MS), so
// the tolerance only has to cover one refresh interval plus the rounding flip.
// A record from an earlier boot is a whole boot session away.
const BOOT_TIME_TOLERANCE_MS = 5 * 60 * 1000;

function isSameBoot(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return Math.abs(a - b) <= BOOT_TIME_TOLERANCE_MS;
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && e.code === 'EPERM'; }   // EPERM means process exists but signal denied
}

// ---- paths ----

function paths(userDataDir) {
  return {
    log:     path.join(userDataDir, 'sessions.jsonl'),
    active:  path.join(userDataDir, 'active'),
    pending: path.join(userDataDir, 'pending-recovery.json'),
  };
}

function ensureDirs(userDataDir) {
  const p = paths(userDataDir);
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch {}
  try { fs.mkdirSync(p.active, { recursive: true }); } catch {}
}

// ---- log: append-only events ----

function appendEvent(userDataDir, event) {
  ensureDirs(userDataDir);
  const p = paths(userDataDir);
  const enriched = { t: Date.now(), ...event };
  // O_APPEND on POSIX guarantees atomic appends < PIPE_BUF; on Windows, fs.appendFile
  // calls WriteFile under FILE_APPEND_DATA which is also atomic for small writes.
  fs.appendFileSync(p.log, JSON.stringify(enriched) + '\n');
}

function readLog(userDataDir) {
  const p = paths(userDataDir);
  let raw;
  try { raw = fs.readFileSync(p.log, 'utf8'); }
  catch { return []; }
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed)); } catch {}
  }
  return events;
}

function normalizePromptForSearch(value) {
  return normalizeSearchText(value);
}

// Fold the event log into a {id -> session} map. Newer events override older
// fields. Sessions are kept regardless of completeness; callers filter as needed.
function listSessions(userDataDir) {
  const events = readLog(userDataDir);
  const map = new Map();
  for (const ev of events) {
    if (typeof ev.id !== 'number') continue;
    let s = map.get(ev.id);
    if (!s) {
      s = { id: ev.id, startedAt: null, lastEventAt: ev.t, hue: null, cli: null, title: null, initialTitle: null, prompt: null, lastPrompt: null, capturedBranches: [], closedAt: null };
      map.set(ev.id, s);
    }
    s.lastEventAt = ev.t;
    switch (ev.e) {
      case 'started': s.startedAt = ev.t; if (typeof ev.hue === 'number') s.hue = ev.hue; break;
      case 'cli':     if (ev.cli) s.cli = ev.cli; break;
      // Title fold: `s.title` is LAST-WINS (the most recent OSC title from
      // the CLI; drifts as the conversation evolves). `s.initialTitle` is
      // FIRST-WINS on the `initial:true` flag — the first *meaningful* title
      // that arrived within the title-grace window after the first prompt.
      // initialTitle is the session's frozen subject and drives the icon
      // letters / picker italic line; title is what the CLI says right now.
      case 'title':
        if (ev.title) {
          s.title = ev.title;
          if (ev.initial && !s.initialTitle) s.initialTitle = ev.title;
        }
        break;
      // Prompt fold: s.prompt is FIRST-WINS (the session's identity — matches
      // the in-memory `firstPrompt` semantics used by the chrome bar, icon
      // letters, and window title). s.lastPrompt is LAST-WINS (recency — what
      // the user was most recently working on). Previously this overwrote
      // s.prompt with every event, so listSessions returned the last prompt
      // as if it were the session's identity, and resumeFromSession's
      // `firstPrompt = picked.prompt` inherited the wrong value.
      case 'prompt':
        if (ev.prompt) {
          if (!s.prompt) s.prompt = ev.prompt;
          s.lastPrompt = ev.prompt;
        }
        break;
      // Every branch captured from a review:// in this session, deduped — kept
      // as history so the picker's search can match a session by any of them.
      case 'branches':
        if (ev.branch && !s.capturedBranches.includes(ev.branch)) s.capturedBranches.push(ev.branch);
        break;
      case 'closed':  s.closedAt = ev.t; break;
      // 'runid' and 'blockid' events are no-ops in the union model — the
      // hub auto-generates fresh runIds per process and the block concept
      // is gone. We don't strip them from disk (forward-compat); the fold
      // just ignores them.
    }
  }
  return Array.from(map.values());
}

// ---- active-window registry ----

function activeFilePath(userDataDir, id) {
  return path.join(paths(userDataDir).active, `${id}.json`);
}

// active/<id>.json schema (open for extensions):
//   pid           process id of the window (required for liveness check)
//   bootTime      OS boot time when this record was written (cross-boot pid reuse guard)
//   guiSession    compositor-session stamp (macOS only; see src/gui-session.js)
//   hiddenAt      timestamp when the window was setSkipTaskbar(true), or null/missing
//   lastInputAt   timestamp of the most recent user keystroke into this window
//   lastWorkingAt timestamp of the most recent PTY output (proxy for "AI working")
//   lastPromptAt  timestamp of the most recent captured prompt event
// The window-cap module uses the last three to score visible windows for
// eviction when a new window pushes over the cap.

function writeActiveFile(userDataDir, id, payload) {
  ensureDirs(userDataDir);
  const file = activeFilePath(userDataDir, id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
}

// Merge a partial update into an existing active file. Used by windows to
// refresh their lastInputAt / lastWorkingAt / hiddenAt without rewriting the
// whole record. If the file is missing, this is a no-op (the window may
// have been destroyed or its active file gc'd).
function updateActiveFile(userDataDir, id, partial) {
  const existing = readActiveFile(userDataDir, id);
  if (!existing) return false;
  writeActiveFile(userDataDir, id, { ...existing, ...partial });
  return true;
}

function readActiveFile(userDataDir, id) {
  try {
    return JSON.parse(fs.readFileSync(activeFilePath(userDataDir, id), 'utf8'));
  } catch { return null; }
}

function deleteActiveFile(userDataDir, id) {
  try { fs.unlinkSync(activeFilePath(userDataDir, id)); } catch {}
}

function listActiveIds(userDataDir) {
  const dir = paths(userDataDir).active;
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const ids = [];
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n);
    if (m) ids.push(parseInt(m[1], 10));
  }
  return ids;
}

// `record` is the result of readActiveFile (may be null). Returns true iff the
// recorded process is still alive, was created during the current boot, and
// its window still belongs to the live compositor session.
//
// The compositor guard is what catches a window that died out from under a
// surviving process (macOS WindowServer crash): the pid is alive and nothing
// rebooted, so pid + bootTime alone would call that ghost active forever. It
// is only decisive when both sides are stamped — an unstamped record (written
// by an older build) or an unstamped platform (Windows, Linux; see
// src/gui-session.js) falls through to the pid check unchanged.
function isSessionActive(record, opts = {}) {
  const bootTime = opts.bootTime || currentBootTime();
  if (!record || typeof record.pid !== 'number') return false;
  if (!isSameBoot(record.bootTime, bootTime)) return false;
  const guiSession = (opts.guiSession !== undefined) ? opts.guiSession : currentGuiSession();
  if (guiSession && record.guiSession && record.guiSession !== guiSession) return false;
  return isPidAlive(record.pid);
}

// Whether a record may be deleted, which is a stricter question than whether
// its session is active. Deleting is destructive across processes: the owning
// window only merges into an existing file, so a wrongly reaped record leaves a
// live window invisible to the cap, the picker, and the last-window relaunch
// check. Reap only on evidence the window is gone — a malformed record, a dead
// pid, or a live pid whose window died with an earlier compositor session. A
// boot-stamp mismatch is not evidence (see BOOT_TIME_TOLERANCE_MS); such a
// record is already skipped by isSessionActive and is reaped once its pid dies.
function isSessionReapable(record, opts = {}) {
  if (!record || typeof record.pid !== 'number') return true;
  const guiSession = (opts.guiSession !== undefined) ? opts.guiSession : currentGuiSession();
  if (guiSession && record.guiSession && record.guiSession !== guiSession) return true;
  return !isPidAlive(record.pid);
}

// Sweep the active/ directory and remove records whose window is provably gone.
// Called on app start and before the last-window relaunch check.
function gcActiveFiles(userDataDir, opts = {}) {
  for (const id of listActiveIds(userDataDir)) {
    const rec = readActiveFile(userDataDir, id);
    if (isSessionReapable(rec, opts)) {
      deleteActiveFile(userDataDir, id);
    }
  }
}

// ---- pending-recovery snapshot ----

// Read the snapshot. Returns { bootTime, pendingIds }; if absent or stale,
// the caller is expected to re-initialize via initPendingRecoveryIfNeeded.
function readPendingRecovery(userDataDir) {
  const p = paths(userDataDir);
  try { return JSON.parse(fs.readFileSync(p.pending, 'utf8')); }
  catch { return null; }
}

function writePendingRecovery(userDataDir, snapshot) {
  ensureDirs(userDataDir);
  const p = paths(userDataDir);
  const tmp = p.pending + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot));
  fs.renameSync(tmp, p.pending);
}

// If the on-disk snapshot's bootTime differs from current, recompute the set:
//   eligible = sessions with started + cli + prompt, no closed event,
//              and not currently active (per active/<id>.json check).
// Returns the (possibly newly initialized) snapshot.
function initPendingRecoveryIfNeeded(userDataDir, opts = {}) {
  const bootTime = opts.bootTime || currentBootTime();
  const existing = readPendingRecovery(userDataDir);
  if (existing && isSameBoot(existing.bootTime, bootTime)) return existing;

  const sessions = listSessions(userDataDir);
  const pendingIds = [];
  for (const s of sessions) {
    if (s.closedAt) continue;
    if (!s.cli || !s.prompt) continue;
    const rec = readActiveFile(userDataDir, s.id);
    if (isSessionActive(rec, { bootTime, guiSession: opts.guiSession })) continue;
    pendingIds.push(s.id);
  }
  const snapshot = { bootTime, pendingIds };
  writePendingRecovery(userDataDir, snapshot);
  return snapshot;
}

function removeFromPendingRecovery(userDataDir, id) {
  const snap = readPendingRecovery(userDataDir);
  if (!snap || !Array.isArray(snap.pendingIds)) return;
  const next = snap.pendingIds.filter(x => x !== id);
  if (next.length === snap.pendingIds.length) return;
  writePendingRecovery(userDataDir, { ...snap, pendingIds: next });
}

// ---- compaction ----

// Drop log entries older than RECENT_WINDOW_MS (or override via opts.maxAgeMs).
// Atomic rewrite — we only touch the file if something was dropped. Returns
// the number of events removed. Called at app start to keep load time bounded
// for long-lived installs.
function compactSessionsLog(userDataDir, opts = {}) {
  const cutoff = Date.now() - (opts.maxAgeMs || RECENT_WINDOW_MS);
  const events = readLog(userDataDir);
  if (events.length === 0) return 0;
  const kept = events.filter(e => (e.t || 0) >= cutoff);
  if (kept.length === events.length) return 0;
  const p = paths(userDataDir);
  const tmp = p.log + '.tmp';
  const body = kept.length ? kept.map(JSON.stringify).join('\n') + '\n' : '';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, p.log);
  return events.length - kept.length;
}

// ---- public picker queries ----

// Sessions visible in the auto-recovery picker: pending set, intersected with
// the actual log (so a stale id in pending-recovery.json is dropped). Newest first.
function autoRecoveryList(userDataDir, opts = {}) {
  const snap = initPendingRecoveryIfNeeded(userDataDir, opts);
  if (!snap.pendingIds || snap.pendingIds.length === 0) return [];
  const want = new Set(snap.pendingIds);
  const out = listSessions(userDataDir)
    .filter(s => want.has(s.id))
    .filter(s => s.cli && s.prompt && !s.closedAt);
  out.sort((a, b) => b.lastEventAt - a.lastEventAt);
  return out;
}

// Read all `title` events for a session id from the log, filtered for the
// live-preview timeline:
//   · t >= afterTime  — drop boot-banner / pre-first-prompt titles (they're
//                       not "the session's title," they're the CLI's startup
//                       banner). Caller passes firstPrompt.t.
//   · meaningfully shaped — length ≥ 8 chars, contains whitespace. Same
//                       intent as isMeaningfulTitleIdentity in main.js but
//                       inlined here so the getter is self-contained.
//   · deduped consecutive identical titles — CLIs sometimes re-emit the
//                       same title; we only want CHANGES in the timeline.
// Each returned entry is `{ title, t }`. Chronological (oldest first).
function getRecentTitlesForSession(userDataDir, id, opts = {}) {
  const afterTime = opts.afterTime || 0;
  const events = readLog(userDataDir);
  const out = [];
  // Dedupe by VALUE, not just consecutive repeats. CLIs frequently re-emit
  // the same OSC title many times during a session (every time the user
  // returns to the input prompt, on internal state changes, etc.). The
  // timeline only wants the FIRST occurrence of each distinct title —
  // i.e., the moment the title actually changed to that string.
  const seen = new Set();
  for (const ev of events) {
    if (ev.id !== id) continue;
    if (ev.e !== 'title') continue;
    if (typeof ev.title !== 'string') continue;
    const t = ev.title.trim();
    if (t.length < 8) continue;
    if (!/\s/.test(t)) continue;
    if (ev.t && ev.t < afterTime) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ title: t, t: ev.t || 0 });
  }
  return out;
}

// Read all `prompt` events for a session id from the log, in chronological
// order. Caps the returned list by total chars (`maxChars`, default 600) by
// dropping oldest entries — the activity-timeline thumbnail prefers showing
// the most recent prompts, and an old long paste should not crowd out a
// newer short one. Each entry is `{ prompt, t }`.
function getRecentPromptsForSession(userDataDir, id, opts = {}) {
  const maxChars = opts.maxChars || 600;
  const events = readLog(userDataDir);
  const prompts = [];
  for (const ev of events) {
    if (ev.id !== id) continue;
    if (ev.e !== 'prompt') continue;
    if (typeof ev.prompt !== 'string' || ev.prompt.length === 0) continue;
    prompts.push({ prompt: ev.prompt, t: ev.t || 0 });
  }
  let total = prompts.reduce((acc, p) => acc + p.prompt.length, 0);
  while (total > maxChars && prompts.length > 1) {
    total -= prompts.shift().prompt.length;
  }
  return prompts;
}

function searchHiddenPromptMatchesForSession(session, promptEvents, query, opts = {}) {
  const normalizedQuery = normalizePromptForSearch(query);
  const terms = parseSearchTerms(normalizedQuery);
  const minChars = opts.minChars || 1;
  if (normalizedQuery.length < minChars || terms.length === 0) return null;
  if (!session || typeof session.id !== 'number' || !session.prompt) return null;

  const firstPrompt = normalizePromptForSearch(session.prompt).toLowerCase();
  const matches = [];
  for (const ev of promptEvents || []) {
    if (ev.e !== 'prompt') continue;
    if (ev.id !== session.id) continue;
    if (typeof ev.prompt !== 'string' || ev.prompt.length === 0) continue;

    const text = normalizePromptForSearch(ev.prompt);
    if (!text) continue;
    const lower = text.toLowerCase();
    if (lower === firstPrompt) continue;

    if (!textMatchesSearchTerms(text, terms)) continue;
    const ranges = findAllTermRanges(text, terms);
    if (ranges.length === 0) continue;
    matches.push({
      text,
      ranges,
      t: ev.t || 0,
    });
  }

  if (matches.length === 0) return null;
  return { id: session.id, matchCount: matches.length, matches };
}

// Search saved follow-up prompt events that are not already represented by
// the picker's primary prompt line. Returns session-grouped match evidence,
// with each match carrying a normalized one-line copy of the full prompt and
// every matched term range inside that normalized text.
function searchHiddenPromptMatches(userDataDir, query, opts = {}) {
  const normalizedQuery = normalizePromptForSearch(query);
  const terms = parseSearchTerms(normalizedQuery);
  const minChars = opts.minChars || 1;
  if (normalizedQuery.length < minChars || terms.length === 0) return [];

  const cutoff = Date.now() - (opts.maxAgeMs || RECENT_WINDOW_MS);
  const sessions = listSessions(userDataDir)
    .filter(s => s.cli && s.prompt && (s.lastEventAt || 0) >= cutoff);
  const sessionsById = new Map(sessions.map(s => [s.id, s]));
  const eventsById = new Map();
  for (const ev of readLog(userDataDir)) {
    if (ev.e !== 'prompt') continue;
    if (typeof ev.id !== 'number') continue;
    if (!sessionsById.has(ev.id)) continue;
    if (!eventsById.has(ev.id)) eventsById.set(ev.id, []);
    eventsById.get(ev.id).push(ev);
  }

  const out = [];
  for (const session of sessions) {
    const group = searchHiddenPromptMatchesForSession(
      session,
      eventsById.get(session.id) || [],
      normalizedQuery,
      { minChars },
    );
    if (group) out.push(group);
  }
  return out;
}

// Sessions visible in the startup all-past picker: everything from the
// last RECENT_WINDOW_MS that has both a CLI and a captured prompt — sessions
// without a prompt have no recognizable content to resume against, and
// "Start new <cli>" already covers the empty-launch case.
function menuList(userDataDir, opts = {}) {
  const bootTime = opts.bootTime || currentBootTime();
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const out = [];
  for (const s of listSessions(userDataDir)) {
    if (!s.cli || !s.prompt) continue;
    if (s.lastEventAt < cutoff) continue;
    const rec = readActiveFile(userDataDir, s.id);
    const isActive = isSessionActive(rec, { bootTime, guiSession: opts.guiSession });
    out.push({ ...s, isActive });
  }
  out.sort((a, b) => b.lastEventAt - a.lastEventAt);
  return out;
}

module.exports = {
  // basic
  currentBootTime,
  isSameBoot,
  paths,
  ensureDirs,
  // log
  appendEvent,
  readLog,
  listSessions,
  // active
  writeActiveFile,
  updateActiveFile,
  readActiveFile,
  deleteActiveFile,
  listActiveIds,
  isSessionActive,
  isSessionReapable,
  gcActiveFiles,
  // pending
  readPendingRecovery,
  writePendingRecovery,
  initPendingRecoveryIfNeeded,
  removeFromPendingRecovery,
  // queries
  autoRecoveryList,
  menuList,
  getRecentPromptsForSession,
  getRecentTitlesForSession,
  searchHiddenPromptMatchesForSession,
  searchHiddenPromptMatches,
  // maintenance
  compactSessionsLog,
  // constants
  RECENT_WINDOW_MS,
  BOOT_TIME_TOLERANCE_MS,
};
