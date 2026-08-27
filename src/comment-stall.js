// Stall watch: after a send, detect "the agent went idle with covered threads
// still unaddressed" and decide whether to auto-remind it once.
//
// A send is the user's explicit request, so one automatic re-ping is delivery
// retry of that request rather than new intent — but only while the user has
// stayed hands-off. Any terminal input after the send means the user took the
// wheel (a Ctrl-C steer, a typed prompt), and the watch disarms for good; the
// amber cards in the viewer remain the passive indicator and typing to the
// agent is the manual reminder that always exists.
//
// Pure decision logic; main owns the IO (reading the merged store, the pty
// paste, the toast) and the clock values.

// Agent quiet this long after the send (or after its last substantial screen
// activity) with open covered threads → remind. Generous on purpose: the
// substantial-change filter can make a hard-thinking agent look quiet for a
// stretch, and a spurious paste mid-turn is worse than a late reminder.
const STALL_IDLE_MS = 60 * 1000;
// A watch this old expires unfired — beyond it a reminder answers a question
// the user has moved past.
const STALL_MAX_AGE_MS = 30 * 60 * 1000;
// The send's own paste bumps the input clock; input inside this margin of the
// send is the send itself, not the user typing afterward.
const SEND_INPUT_EPSILON_MS = 1500;

// A covered thread still needing the agent: open, with the user's word last.
// Resolved is done; an agent reply that left it open is "blocked on the user"
// — the user's move, so it never counts as a stall.
function threadUnaddressed(t) {
  if (!t || (t.status || 'open') !== 'open') return false;
  const msgs = t.messages || [];
  const last = msgs[msgs.length - 1];
  return !!last && (last.author || 'user') === 'user';
}

// One tick of one watch.
//   watch: { sendTime }
//   env:   { now, lastInputTime, lastAgentOutputTime, coveredThreads }
//          coveredThreads = the covered ids resolved against the MERGED view
//          (missing ids — discarded threads — simply drop out).
// → 'disarm-user' | 'done' | 'expire' | 'remind' | 'wait'
function decideStall(watch, env, opts = {}) {
  const idleMs = opts.idleMs || STALL_IDLE_MS;
  const maxAgeMs = opts.maxAgeMs || STALL_MAX_AGE_MS;
  if (env.lastInputTime > watch.sendTime + SEND_INPUT_EPSILON_MS) return 'disarm-user';
  const open = (env.coveredThreads || []).filter(threadUnaddressed);
  if (!open.length) return 'done';
  if (env.now - watch.sendTime > maxAgeMs) return 'expire';
  const quietSince = Math.max(watch.sendTime, env.lastAgentOutputTime || 0);
  if (env.now - quietSince >= idleMs) return 'remind';
  return 'wait';
}

function unaddressedCount(coveredThreads) {
  return (coveredThreads || []).filter(threadUnaddressed).length;
}

module.exports = {
  STALL_IDLE_MS, STALL_MAX_AGE_MS, SEND_INPUT_EPSILON_MS,
  threadUnaddressed, decideStall, unaddressedCount,
};
