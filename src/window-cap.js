// Auto-hide and the live-session cap (docs/dev/auto-hide.md is the UX this
// answers to).
//
// A window the user has stopped using hides when they open a window: a new
// one, or a hidden one brought back from the picker. "Stopped using" is
// measured on the input clock (src/input-clock.js), which only moves while the
// user works in AgentTerm, so time away never makes a window stale. Hidden
// windows stay alive and come back instantly; at most MAX_LIVE sessions live
// at once, and past that the hidden one whose timer restarted longest ago
// closes, to resume through its CLI like any closed session.
//
// Cross-process coordination is file-based: each window has an active file
// (active/<id>.json) advertising pid, bootTime, its timer on the input clock,
// last-activity timestamps, and whether it is hidden. Control messages are
// dropped as small JSON files in cap-control/<id>.json by whichever process
// is asking; the addressed window watches the directory and acts on receipt,
// re-checking its own state first.

const fs = require('fs');
const path = require('path');
const sessionsLog = require('./sessions-log');
const { writeFileAtomicSync } = require('./atomic-file');

// The most sessions alive at once, hidden and visible together: the most one
// would want as windows if none were hidden. Screen space and attention set
// it, so it does not scale with RAM.
const MAX_LIVE = 8;
// Minutes of the input clock without a touch before a window is stale.
const STALE_AFTER_MINUTES = 60;
// User-close auto-relaunch replaces only the last taskbar-visible AgentTerm
// session, so closing the final window never leaves the user with nothing.
// Hidden-but-running sessions do not satisfy this threshold. Additional
// windows are opened deliberately via Cmd/Ctrl+Shift+N.
const MIN_VISIBLE_FOR_RELAUNCH = 1;
const WORKING_GRACE_MS = 5 * 60 * 1000;     // any window that worked in the last 5 min is "working", never hidden
const ACTIVITY_REFRESH_MS = 30 * 1000;      // throttle: how often a window writes its activity timestamps
// A working span shorter than this, with no title saying the agent worked,
// is status churn (a spinner, a clock) rather than a turn.
const TURN_MIN_MS = 15 * 1000;

function controlDir(userDataDir) {
  return path.join(userDataDir, 'cap-control');
}

function controlFile(userDataDir, id) {
  return path.join(controlDir(userDataDir), `${id}.json`);
}

function ensureControlDir(userDataDir) {
  try { fs.mkdirSync(controlDir(userDataDir), { recursive: true }); } catch {}
}

// ---- Hiding ----

// Whether the window behind an active-file record may hide: visible, idle
// through the working grace, and untouched for STALE_AFTER_MINUTES of the
// input clock. `clock` is the input clock's reading.
function isHideCandidate(file, { clock, now, workingGraceMs = WORKING_GRACE_MS }) {
  if (!file || file.hiddenAt) return false;
  if (now - (file.lastWorkingAt || 0) < workingGraceMs) return false;
  return clock - file.touchedClock >= STALE_AFTER_MINUTES;
}

// `records`: array of { id, file } where file is the parsed active/<id>.json
// payload (or null if unreadable). Returns the ids of the windows to ask to
// hide, leaving out `ignoreId` (the window doing the asking).
function pickStaleWindows(records, { clock, now, ignoreId, workingGraceMs } = {}) {
  const out = [];
  for (const r of records) {
    if (!r || r.id === ignoreId) continue;
    if (isHideCandidate(r.file, { clock, now, workingGraceMs })) out.push(r.id);
  }
  return out;
}

// ---- The live cap ----

// Hidden records, the first to close at the front: the timer that restarted
// longest ago, wall-clock time breaking ties among restarts while the user was
// away (the input clock stands still then), and the id as a last resort so
// every window computes the same order.
function closeOrder(records) {
  return records
    .filter((r) => r && r.file && r.file.hiddenAt)
    .sort((a, b) => (a.file.touchedClock - b.file.touchedClock)
      || (a.file.touchedAt - b.file.touchedAt) || (a.id - b.id));
}

// The hidden session used most recently, or null: the last in the close
// order. Pressing Cmd/Ctrl+Shift+N in the picker brings it back.
function lastHiddenSession(records) {
  const order = closeOrder(records);
  return order.length ? order[order.length - 1].id : null;
}

// Ids of the hidden sessions to close so that at most MAX_LIVE stay alive.
// Visible windows are the user's and never close here, so while too many are
// visible nothing closes until some hide.
function capVictims(records, { maxLive = MAX_LIVE } = {}) {
  const live = records.filter((r) => r && r.file);
  const excess = live.length - maxLive;
  if (excess <= 0) return [];
  return closeOrder(live).slice(0, excess).map((r) => r.id);
}

// ---- Turns ----

// Tells a finished turn from the working indicator's samples. A turn ends
// when the window stops working after a span in which the CLI's title said it
// was working, or which lasted TURN_MIN_MS; shorter untitled spans are status
// churn. `update` returns true on the sample that ends a turn.
function createTurnTracker({ minMs = TURN_MIN_MS } = {}) {
  let startedAt = null;
  let titled = false;
  return {
    update(working, titleWorking, now) {
      if (working) {
        if (startedAt === null) {
          startedAt = now;
          titled = false;
        }
        if (titleWorking === true) titled = true;
        return false;
      }
      if (startedAt === null) return false;
      const ended = titled || now - startedAt >= minMs;
      startedAt = null;
      titled = false;
      return ended;
    },
  };
}

// ---- Registry reads ----

// Read every live active record into the { id, file } shape used above.
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
// `action` is one of: 'hide' | 'show'.
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
  MAX_LIVE,
  STALE_AFTER_MINUTES,
  MIN_VISIBLE_FOR_RELAUNCH,
  WORKING_GRACE_MS,
  ACTIVITY_REFRESH_MS,
  TURN_MIN_MS,
  isHideCandidate,
  pickStaleWindows,
  closeOrder,
  lastHiddenSession,
  capVictims,
  createTurnTracker,
  listLiveRecords,
  countVisible,
  shouldRelaunchAfterUserClose,
  sendControl,
  startCapControlWatcher,
};
