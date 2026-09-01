// Cap visible agent-term windows at MAX_VISIBLE. When the count exceeds the
// cap, the stalest non-working visible window is hidden via Electron's
// setSkipTaskbar — its taskbar button vanishes, freeing real estate so the
// remaining buttons stay wide and readable. The window stays alive (CLI +
// PTY + scrollback intact); it can be brought back via the sessions picker
// or when the AI auto-shows it on new output.
//
// Hidden + idle (no user input AND no AI working) for IDLE_CLOSE_MS triggers
// a graceful app.quit() — bounds resource use so hidden windows don't
// accumulate forever. Sessions are still resumable from the on-disk log.
//
// Cross-process coordination is file-based: each window has an active file
// (active/<id>.json) advertising pid, bootTime, last-activity timestamps,
// and the hide-state flag. Cap-control messages are dropped as small JSON
// files in cap-control/<id>.json by whichever process is asking; the
// addressed window watches the directory and acts on receipt.

const fs = require('fs');
const path = require('path');
const sessionsLog = require('./sessions-log');
const { writeFileAtomicSync } = require('./atomic-file');

const MAX_VISIBLE = 10;
// User-close auto-relaunch replaces only the last taskbar-visible AgentTerm
// session, so closing the final window never leaves the user with nothing.
// Hidden-but-running sessions do not satisfy this threshold. Additional
// windows are opened deliberately via Cmd/Ctrl+Shift+N.
const MIN_VISIBLE_FOR_RELAUNCH = 1;
const WORKING_GRACE_MS = 5 * 60 * 1000;     // any window that worked in the last 5 min is "working", never evict
const IDLE_CLOSE_MS = 4 * 60 * 60 * 1000;   // hidden + idle 4h → auto-close (Tier 2 → Tier 3)
const ACTIVITY_REFRESH_MS = 30 * 1000;      // throttle: how often a window writes its activity timestamps

function controlDir(userDataDir) {
  return path.join(userDataDir, 'cap-control');
}

function controlFile(userDataDir, id) {
  return path.join(controlDir(userDataDir), `${id}.json`);
}

function ensureControlDir(userDataDir) {
  try { fs.mkdirSync(controlDir(userDataDir), { recursive: true }); } catch {}
}

// ---- Eviction selection ----

// `records`: array of { id, file } where file is the parsed active/<id>.json
// payload (or null if unreadable). `now`: Date.now() for testability.
//
// Returns the id of the visible (hiddenAt == null) non-working session that
// has been quietest the longest, or null if there's nothing safe to evict.
//
// "Working" excludes both currently-running AI output and very recent output
// — the WORKING_GRACE_MS window covers a long tool call that briefly pauses.
// "Quietest" is judged by max(lastInputAt, lastPromptAt) — recent typing
// without an Enter still counts (mid-prompt edits, scrolling, paste).
function pickEvictionVictim(records, opts = {}) {
  const now = opts.now || Date.now();
  const ignoreId = opts.ignoreId;     // typically the spawning window's own id
  const visible = [];
  for (const r of records) {
    if (!r || !r.file) continue;
    if (r.id === ignoreId) continue;
    if (r.file.hiddenAt) continue;     // already hidden, doesn't count toward cap
    const lastWork = r.file.lastWorkingAt || 0;
    if (now - lastWork < WORKING_GRACE_MS) continue;   // currently working: do not evict
    const lastActivity = Math.max(
      r.file.lastInputAt || 0,
      r.file.lastPromptAt || 0,
    );
    visible.push({ id: r.id, lastActivity });
  }
  if (visible.length === 0) return null;
  // Stalest first.
  visible.sort((a, b) => a.lastActivity - b.lastActivity);
  return visible[0].id;
}

// Read every live active record into the shape pickEvictionVictim wants.
// Skips records whose pid is dead or whose bootTime mismatches the current
// boot — those are stale on-disk droppings, not real windows.
function listLiveRecords(userDataDir, opts = {}) {
  const bootTime = opts.bootTime || sessionsLog.currentBootTime();
  const ids = sessionsLog.listActiveIds(userDataDir);
  const out = [];
  for (const id of ids) {
    const file = sessionsLog.readActiveFile(userDataDir, id);
    if (!sessionsLog.isSessionActive(file, { bootTime, guiSession: opts.guiSession })) continue;
    out.push({ id, file });
  }
  return out;
}

function countVisible(records) {
  let n = 0;
  for (const r of records) if (r && r.file && !r.file.hiddenAt) n++;
  return n;
}

function shouldRelaunchAfterUserClose(records) {
  return countVisible(records) < MIN_VISIBLE_FOR_RELAUNCH;
}

// ---- Control messages ----

// Drop a control message for the addressed window. The target's file watcher
// will pick it up on its next fs event (millisecond-scale latency).
// `action` is one of: 'hide' | 'show' | 'close'.
function sendControl(userDataDir, id, action) {
  ensureControlDir(userDataDir);
  writeFileAtomicSync(controlFile(userDataDir, id), JSON.stringify({ action, t: Date.now() }));
}

// Watcher: each window calls this with its own id and a handler map. The
// returned function tears down the watcher when the window is closing.
function startCapControlWatcher(userDataDir, ownId, handlers = {}) {
  ensureControlDir(userDataDir);
  const myFile = controlFile(userDataDir, ownId);

  const tryDispatch = () => {
    let payload;
    try { payload = JSON.parse(fs.readFileSync(myFile, 'utf8')); }
    catch { return; }
    // Consume the message before invoking the handler — if the handler
    // throws, we don't want to fire it again on the next watcher tick.
    try { fs.unlinkSync(myFile); } catch {}
    const fn = handlers[payload && payload.action];
    if (typeof fn === 'function') {
      try { fn(payload); } catch (err) {
        console.warn('[window-cap] handler threw:', err && err.message);
      }
    }
  };

  // Initial check — we may have arrived after a control file was written.
  tryDispatch();

  let watcher = null;
  try {
    watcher = fs.watch(controlDir(userDataDir), (eventType, filename) => {
      if (filename && filename === `${ownId}.json`) tryDispatch();
    });
  } catch (err) {
    console.warn('[window-cap] fs.watch on cap-control failed:', err && err.message);
  }

  return () => {
    if (watcher) { try { watcher.close(); } catch {} }
  };
}

module.exports = {
  MAX_VISIBLE,
  MIN_VISIBLE_FOR_RELAUNCH,
  WORKING_GRACE_MS,
  IDLE_CLOSE_MS,
  ACTIVITY_REFRESH_MS,
  pickEvictionVictim,
  listLiveRecords,
  countVisible,
  shouldRelaunchAfterUserClose,
  sendControl,
  startCapControlWatcher,
};
