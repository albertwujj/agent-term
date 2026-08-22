// Pure decision for the lock icon in the chrome bar: (git facts, this window's
// token, the holder's window record) -> what to draw. No git, no Electron, no
// timers, so it is unit-testable in `node --test` and identical for any AI CLI.
//
// Status only. The icon never pings, prompts, or interrupts an agent; the
// protocol's own guards (agent-lock's acquire/release/switch-work refusals,
// assert-head) are where "wrong" is caught. Design and the reasons for no
// warnings: .git/discussion/lock-warnings.md.
//
//   facts:  { lockHeld, owner: { branch, session } | null, headBranch }
//           owner is the parsed .git/agent-lock-owner record; null when the
//           lock ref exists without one (a lock made by hand).
//   me:     { token, now }   this window's AGENT_SESSION_ID and the clock
//   holder: the active-file record of the live window whose token equals
//           owner.session, or null when no live window carries it
//           ({ lastWorkingAt, hue } are the fields read)
//   opts:   { idleMs }       a holder quiet for longer than this is "idle"
//
//   -> { state, branch, hue, idleMs, tooltip }
//      state: none | free | mine | other-active | other-idle | no-window

// A task branch per proceed-by-branching.md. Only the "free" state reads it,
// to show the open padlock when there is something to coordinate.
const WORK_BRANCH_RE = /^work\//;

const LOCK_NAME = 'lock/agent';

function fmtIdle(ms) {
  if (!(ms >= 0)) return '?';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function decide(facts, me, holder, opts) {
  const f = facts || {};
  const token = (me && me.token) || '';
  const now = (me && typeof me.now === 'number') ? me.now : Date.now();
  const idleMs = (opts && opts.idleMs) || 60_000;

  if (!f.lockHeld) {
    if (typeof f.headBranch === 'string' && WORK_BRANCH_RE.test(f.headBranch)) {
      return { state: 'free', branch: f.headBranch, hue: null, idleMs: null,
        tooltip: `${LOCK_NAME} free · on ${f.headBranch}` };
    }
    return { state: 'none' };
  }

  const owner = f.owner || {};
  const branch = owner.branch || '?';
  const session = owner.session || '';
  const label = `${LOCK_NAME} · ${branch}`;

  if (session && token && session === token) {
    return { state: 'mine', branch, hue: null, idleMs: null, tooltip: `${label} · you` };
  }
  if (!session || !holder) {
    return { state: 'no-window', branch, hue: null, idleMs: null,
      tooltip: `${label} · no window open` };
  }
  const hue = (typeof holder.hue === 'number') ? holder.hue : null;
  const quiet = now - (typeof holder.lastWorkingAt === 'number' ? holder.lastWorkingAt : 0);
  if (quiet > idleMs) {
    return { state: 'other-idle', branch, hue, idleMs: quiet,
      tooltip: `${label} · other window, idle ${fmtIdle(quiet)}` };
  }
  return { state: 'other-active', branch, hue, idleMs: null,
    tooltip: `${label} · other window, active` };
}

module.exports = { WORK_BRANCH_RE, decide, fmtIdle };
