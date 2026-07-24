// Generation stamp for the OS compositor session that owns our window.
//
// macOS: a WindowServer crash (or a logout) destroys every window on the
// machine, but an Electron main process can survive it — event loop alive,
// PTY and CLI alive, no window and no LaunchServices registration. Electron
// never delivers 'closed' for that window, so the session's active/<id>.json
// is never cleaned up and its cap timers keep refreshing it. The picker then
// lists a session as active forever, and its row is disabled, so the user can
// neither see the window nor resume the session. `bootTime` does not catch
// this: nothing rebooted.
//
// The stamp is WindowServer's pid + start time. It changes exactly when every
// window on the machine is destroyed, which is the event we need to detect.
//
// Other platforms return null and every consumer skips the check:
//   · Windows tears down a session's processes on logoff, and a dwm.exe crash
//     restarts the compositor with the windows intact — there is no equivalent
//     survivor state to detect, so nothing is stamped and liveness stays
//     exactly the pid + bootTime test it has always been.
// A null on macOS (probe failed) is treated the same way — "unknown" never
// reaps a session.

const { execFileSync } = require('child_process');

const CACHE_MS = 5000;

let cache = null;         // { value, at }
let probeFailureLogged = false;

// One process spawn each for the pid and its start time; both outputs are a
// single short line. Called at most once per CACHE_MS via currentGuiSession.
function readGuiSession() {
  if (process.platform !== 'darwin') return null;
  try {
    const pid = execFileSync('/usr/bin/pgrep', ['-x', 'WindowServer'], {
      encoding: 'utf8', timeout: 2000,
    }).split('\n')[0].trim();
    if (!/^\d+$/.test(pid)) return null;
    const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', pid], {
      encoding: 'utf8', timeout: 2000,
    }).trim();
    if (!started) return null;
    return `ws:${pid}:${started}`;
  } catch (err) {
    if (!probeFailureLogged) {
      probeFailureLogged = true;
      console.warn('[gui-session] WindowServer probe failed, falling back to pid+boot liveness only:', err && err.message);
    }
    return null;
  }
}

// TTL-cached read. Liveness checks run over every active file in a loop, so
// the cache keeps a picker open or a gc sweep to a single probe.
function currentGuiSession(opts = {}) {
  const maxAgeMs = (typeof opts.maxAgeMs === 'number') ? opts.maxAgeMs : CACHE_MS;
  const now = Date.now();
  if (cache && (now - cache.at) < maxAgeMs) return cache.value;
  const value = readGuiSession();
  cache = { value, at: now };
  return value;
}

function resetCache() {
  cache = null;
}

module.exports = {
  readGuiSession,
  currentGuiSession,
  resetCache,
  CACHE_MS,
};
