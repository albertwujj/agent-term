// When each live process started, so a registry record can tell its own
// window from an unrelated process that was later handed the same pid.
//
// macOS: one `ps -axo pid=,etime=` lists every process with its elapsed time,
// which reads the same in every locale (lstart is localized) and comes from
// sysctl, so it keeps working inside a ghost (see gui-session.js). A start is
// now minus elapsed, at whole-second precision.
//
// Windows has no ps, and asking PowerShell costs most of a second per call,
// so it returns null there and the registry keeps judging a record by its pid
// alone. A failed ps returns null the same way: "unknown" never declares a
// window dead.

const { execFileSync } = require('child_process');

const CACHE_MS = 5000;

let cache = null;         // { value, at }

// "[[dd-]hh:]mm:ss" → seconds, or null.
function parseElapsed(text) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
  if (!m) return null;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  return ((days * 24 + hours) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

// `ps -axo pid=,etime=` output read at `now` → Map(pid → start ms).
function parseProcessStarts(psOutput, now) {
  const starts = new Map();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const elapsed = parseElapsed(m[2]);
    if (elapsed !== null) starts.set(Number(m[1]), now - elapsed * 1000);
  }
  return starts;
}

function readProcessStarts() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'pid=,etime='], {
      encoding: 'utf8', timeout: 2000,
    });
    return parseProcessStarts(out, Date.now());
  } catch {
    return null;
  }
}

// Start of `pid` in ms from a snapshot at most CACHE_MS old, or null when
// unknown: off macOS, a failed ps, or a pid the snapshot does not hold (it may
// have started since).
function processStartTime(pid) {
  const now = Date.now();
  if (!cache || (now - cache.at) >= CACHE_MS) cache = { value: readProcessStarts(), at: now };
  if (!cache.value) return null;
  const start = cache.value.get(pid);
  return start === undefined ? null : start;
}

function resetCache() {
  cache = null;
}

module.exports = {
  parseElapsed,
  parseProcessStarts,
  processStartTime,
  resetCache,
  CACHE_MS,
};
