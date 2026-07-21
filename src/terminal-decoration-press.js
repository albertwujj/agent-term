// Click-vs-drag disambiguation for navigable terminal text (symbols, source
// lines, file paths, URLs).
//
// A plain left press on a navigable match used to navigate immediately on
// mousedown, which made it impossible to start a text selection there — so you
// could never select (and therefore comment on) a symbol or source line. We now
// defer the decision to mouseup: a press that stays put is a click (navigate); a
// press that moves past a small threshold is a drag (leave the resulting text
// selection alone). The decision is movement-based, not time-based, so a real
// click still navigates instantly with no double-click delay.

const DEFAULT_DRAG_THRESHOLD_PX = 4;

// Decide whether a mousedown should start a deferred decoration press. Returns a
// pending record (carrying the match and the press origin) or null when the
// press is not a plain left click on navigable text. Shift presses are excluded
// because shift-drag selection is handled by its own dedicated path.
function beginDecorationPress({ button, shiftKey, match, x, y } = {}) {
  if (button !== 0) return null;
  if (shiftKey) return null;
  if (!match) return null;
  return { match, x, y };
}

// Resolve a pending press at mouseup. Returns one of:
//   'navigate' — the press stayed in place: treat it as a click and navigate.
//   'select'   — the press moved past the threshold: it became a drag, so the
//                text selection it produced should be left untouched.
//   'ignore'   — nothing to do (no pending press, or a non-left release).
function resolveDecorationPress(pending, { button, x, y } = {}, threshold = DEFAULT_DRAG_THRESHOLD_PX) {
  if (!pending) return 'ignore';
  if (button !== 0) return 'ignore';
  const draggedFar = Math.abs(x - pending.x) > threshold
    || Math.abs(y - pending.y) > threshold;
  return draggedFar ? 'select' : 'navigate';
}

module.exports = {
  DEFAULT_DRAG_THRESHOLD_PX,
  beginDecorationPress,
  resolveDecorationPress,
};
