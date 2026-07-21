// Pure decision logic for the work-branch / lock watcher.
//
// No git, no Electron, no terminal/CLI sniffing — just (folder state -> messages),
// so it is unit-testable in `node --test` and identical for any AI CLI (or none).
// The I/O (reading git in the session's primary folder) and the bar live in
// main.js / renderer.js; this module only DECIDES.
//
// Gate: warnings exist only inside the agent-lock world, detected by the
// branch matching work/<kebab-slug> (proceed-by-branching.md §1). Anywhere else
// (e.g. developing agent-term itself on `main`) nothing is ever emitted.

// A conformant task branch: work/<kebab-slug>. Lowercase, hyphen-joined, no
// further slashes — exactly what proceed-by-branching.md §2 produces. A
// non-conformant workflow that also uses work/ could false-positive; accepted
// (agent-lock owns the convention and can pick a more unique prefix later).
const WORK_BRANCH_RE = /^work\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isEngaged(branch) {
  return typeof branch === 'string' && WORK_BRANCH_RE.test(branch);
}

// Decide what (if anything) the bar should say, given the current folder state
// and the work branch we were tracking. Pure: returns the messages plus the next
// `tracked` value. It arms (stamps `tracked`) only when proceed-by-branching.md has
// been @-referenced (ctx.armed) AND HEAD has since SWITCHED to a work branch
// (state.branch differs from ctx.armBase — the branch we were on when armed). The
// workflow always cuts a fresh branch after it's invoked, so we wait for that switch
// rather than claim whatever branch HEAD happens to sit on. A fresh agent that boots
// already on a leftover work/ branch and never invokes the workflow is therefore never
// stamped → silent. Otherwise only Reset re-baselines (see rebaseline()).
//
//   state: { isRepo, branch, lockHeld, owner, dirtyTracked }
//   ctx:   { bootId, now, armed, armBase }
//   tracked: the work/<slug> being watched, or null
//   → { messages: [{ kind, text, ... }], tracked }
function evaluate(state, tracked, ctx) {
  ctx = ctx || {};
  if (!state || !state.isRepo) return { messages: [], tracked: tracked || null };

  let nextTracked = tracked || null;
  if (nextTracked == null && isEngaged(state.branch) && ctx.armed && state.branch !== ctx.armBase) {
    nextTracked = state.branch; // armed by the @-reference + HEAD switched to the new work branch
  }

  const messages = [];

  // Branch moved off the tracked work branch — incl. work→work (another task's
  // branch landing under you). Persists until HEAD returns or Reset re-baselines.
  // Guard on a KNOWN branch: a null/detached branch is a transient mid-operation
  // read (rebase/checkout) — preserve tracking and wait, never warn "→ HEAD".
  if (nextTracked && state.branch && state.branch !== nextTracked) {
    messages.push({
      kind: 'branch',
      from: nextTracked,
      to: state.branch,
      text: `Branch changed: ${nextTracked} → ${state.branch}`,
    });
  }

  // Lock warnings only while on a work branch (the iteration context). A different owner
  // means a collision. Stale-lock detection ("reclaim?") is intentionally removed for now:
  // age alone is an unreliable "abandoned" signal (a long but live task trips it), and the
  // owner file's pid is the transient acquire process, so there's nothing to liveness-probe.
  // It returns once the lock grows a heartbeat. "Forgot to lock" is not a git fact, so it is
  // intentionally not here either.
  if (isEngaged(state.branch) && state.lockHeld && state.owner
      && state.owner.branch && state.owner.branch !== state.branch) {
    messages.push({
      kind: 'lock-collision',
      owner: state.owner.branch,
      text: `Another task (${state.owner.branch}) holds lock/agent — would collide`,
    });
  }

  // On a work branch with uncommitted TRACKED changes but no lock held: the work
  // is exposed (a branch switch in the shared checkout could carry/lose it, and
  // the lock acquire needs a clean tree). Untracked files are excluded — matching
  // the workflow's own "dirty" definition (proceed-by-branching.md).
  if (isEngaged(state.branch) && !state.lockHeld && state.dirtyTracked) {
    messages.push({
      kind: 'lock-missing-dirty',
      text: 'Uncommitted changes with no lock/agent held — check & repair if needed',
    });
  }

  return { messages, tracked: nextTracked };
}

// Reset on the bar = re-baseline to the current branch: accept an intentional
// task switch (track the new work/<slug>), or clear tracking if we're off the
// workflow now.
function rebaseline(state) {
  return state && isEngaged(state.branch) ? state.branch : null;
}

module.exports = { WORK_BRANCH_RE, isEngaged, evaluate, rebaseline };
