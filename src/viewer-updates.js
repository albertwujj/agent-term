// Unseen means displayed, not literally read. Keep this separate from the
// band's automatic moves: a blocked reveal must not consume the notification.
function createUnseenTracker(onChange) {
  const unseen = new Set();
  const baselines = new Map();
  function notify() { onChange(unseen.size > 0); }
  return {
    add(key) { unseen.add(key); notify(); },
    seen(key) { unseen.delete(key); notify(); },
    reset() { unseen.clear(); baselines.clear(); notify(); },
    // A guest reload loses its DOM and local state, so the host holds these
    // content keys. The first snapshot seeds a baseline; later snapshots only
    // announce new content. Keys describe content, not line numbers/positions.
    update(scope, items, canSee, { deletions = false } = {}) {
      const prior = baselines.get(scope);
      const next = new Set(items.map((item) => item.key));
      const prefix = scope + '\0';
      let changed = false;
      if (prior) {
        for (const key of prior) if (!next.has(key)) unseen.delete(prefix + key);
        for (const key of next) if (!prior.has(key)) {
          unseen.add(prefix + key);
          changed = true;
        }
        // A deletion has no new text to display. Its nearest surviving block
        // is the place to inspect it, just like markdown's deletion anchor.
        if (deletions && !changed && items.length && [...prior].some((key) => !next.has(key))) {
          const old = [...prior];
          const index = old.findIndex((key) => !next.has(key));
          unseen.add(prefix + items[Math.min(index, items.length - 1)].key);
          changed = true;
        }
      }
      baselines.set(scope, next);
      if (canSee) for (const item of items) if (item.shown) unseen.delete(prefix + item.key);
      notify();
      return changed;
    },
  };
}

// Multi-column prose has several client rects; a bounding box can include a
// large empty gap. Require at least a line's worth of a real rect in the clip.
function elementIsShown(el, clip) {
  if (!el || !clip) return false;
  return Array.from(el.getClientRects()).some((r) =>
    Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top) >= Math.min(16, r.height)
    && Math.min(r.right, clip.right) - Math.max(r.left, clip.left) >= Math.min(16, r.width)
    && r.height > 0 && r.width > 0);
}

module.exports = { createUnseenTracker, elementIsShown };
