// review-sync.js — when the open review re-renders. main.js owns the IO (the
// probes through the POSIX seam, the renderer, the reload message); this owns
// the order of reads and renders, which decides whether the page can go stale.
//
// A render reads the package and the repo as they stand while it runs, so the
// baseline the next poll compares against must be what was read BEFORE the
// render began. A baseline read after it takes a change that landed mid-render
// as already shown: the agent commits, the poll starts a render on the new
// HEAD, the agent bumps the package's range a second later, and every later
// poll matches while the page keeps its pre-bump banners until it is reopened.

'use strict';

// The scope ref the package's diff rests on (front matter `range: A..B`, or a
// `base:` ref), so `git diff <scope>` reproduces the embedded diff. null when
// the front matter names neither.
function parseScopeArg(text) {
  const fm = (String(text || '').match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
  const r = fm.match(/^\s*range:\s*(.+?)\s*$/m);
  if (r) return r[1].trim();
  const b = fm.match(/^\s*base:\s*(.+?)\s*$/m);
  if (b) return b[1].trim();
  return null;
}

// The render inputs that moved since `base`, by name; empty when in sync.
//   md    — hash of the package .md (prose, ordering, the range itself)
//   diff  — hash of `git diff <scope>` for the scope the package names now
//   dirty — uncommitted tracked changes (the out-of-date banner)
//   head  — HEAD's sha (the behind / diverged banners)
// An unreadable probe (null) is no news rather than a change; dirty is a
// plain boolean, so any flip counts.
function changedInputs(base, now) {
  const moved = [];
  if (now.md && now.md !== base.md) moved.push('md');
  if (now.diff && now.diff !== base.diff) moved.push('diff');
  if (now.dirty !== base.dirty) moved.push('dirty');
  if (now.head && now.head !== base.head) moved.push('head');
  return moved;
}

// One open review's refresh loop, starting from `inputs`: what the open
// render was made from, read before it ran.
//   readInputs()  → the inputs above, read now
//   render(moved) → re-render the page; resolves false when no render took
//                   (the package is gone, the render threw), which keeps the
//                   baseline so the next tick tries again
// tick() reads the inputs and renders when any moved, unless a render is
// already running: that one's baseline predates the change, so the tick after
// it sees the change too. Resolves to the moved names, empty when in sync.
function createReviewSync({ readInputs, render }, inputs) {
  let baseline = inputs;
  let rendering = false;
  async function tick() {
    const now = await readInputs();
    const moved = changedInputs(baseline, now);
    if (!moved.length || rendering) return moved;
    rendering = true;
    try {
      if ((await render(moved)) !== false) baseline = now;
    } finally {
      rendering = false;
    }
    return moved;
  }
  return { tick };
}

module.exports = { parseScopeArg, changedInputs, createReviewSync };
