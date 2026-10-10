// One-click confirmation of a review decision heading ("[unconfirmed] Decision: …",
// authoring.md in agent-threads).
//
// Ticking the heading's circle is a user message in the comment store; the
// package stays wholly the agent's, and the agent records the choice by
// writing `[confirmed]` (produce-review.md). The message is an envelope like
// [Edit]'s, naming the decision in the heading's own words, so the agent reads
// exactly which choice was kept.
//
// Until the agent acts on it, the viewer shows the decision confirmed on the
// message alone. "Acts" is any reply or status the agent wrote after the
// confirm: from then on the authored marker is the truth again, which is what
// lets a later `[unconfirmed]` reopen the decision.

const CONFIRM_TAG = '[Confirm]';
const CONFIRM_RE = /^\[Confirm\] Decision:\s*\S/;

// headingText is the rendered heading (its marker already stripped), so it
// starts with "Decision:".
function confirmBody(headingText) {
  return `${CONFIRM_TAG} ${headingText}`;
}

function isConfirmMessage(m) {
  return !!m && (m.author || 'user') === 'user' && CONFIRM_RE.test(String(m.body || ''));
}

// The thread's confirm the agent has not acted on, or null. Read on the merged
// view: no agent reply after it, and no journal status at or after its ts.
// status_ts outlives the status itself (a newer follow-up takes the status
// back), which is what keeps a confirm the agent already recorded from
// counting again once the thread reopens.
function pendingConfirm(t) {
  const msgs = (t && t.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if ((m.author || 'user') !== 'user') return null;
    if (!isConfirmMessage(m)) continue;
    if (Number.isFinite(t.status_ts) && !(Number.isFinite(m.ts) && m.ts > t.status_ts)) return null;
    return m;
  }
  return null;
}

module.exports = { confirmBody, isConfirmMessage, pendingConfirm };
