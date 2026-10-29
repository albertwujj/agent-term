// Click-vs-drag disambiguation for navigable terminal text (symbols, source
// lines, file paths, URLs).
//
// A plain left press on a navigable match used to navigate immediately on
// mousedown, which made it impossible to start a text selection there — so you
// could never select (and therefore comment on) a symbol or source line. We now
// defer the decision to mouseup: a press that stays put is a click (navigate); a
// press that moves past a small threshold is a drag (leave the resulting text
// selection alone). Existing viewer clicks stay immediate; newly enabled plain
// clicks use the cancellable controller below to protect multi-click selection.

const DEFAULT_DRAG_THRESHOLD_PX = 4;
const DOUBLE_CLICK_MARGIN_MS = 50;

// Decide whether a mousedown should start a deferred decoration press. Returns a
// pending record (carrying the match and the press origin) or null when the
// press is not a plain left click on navigable text. Shift presses are excluded
// because shift-drag selection is handled by its own dedicated path. So are
// multi-click presses (detail >= 2): the second and third press of a
// double/triple click are the terminal's word- and line-select gestures, and
// arming them would navigate again on every press of the sequence.
function beginDecorationPress({ button, shiftKey, match, x, y, detail = 1 } = {}) {
  if (button !== 0) return null;
  if (shiftKey) return null;
  if (detail >= 2) return null;
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

// The options a resolved press hands to its match's action.
//
// Modifier state is forwarded so actions can branch on it: a web URL opens the
// system browser on a plain click and the embedded viewer band under any
// modifier, and Alt on a path raises the search-everywhere chooser.
//
// Ctrl+Alt (Cmd+Alt on Mac) is the developer debug chord, which copies the
// navigation JSON instead of acting. It is the deliberately obscure combination
// because Ctrl, Cmd and Alt each carry a meaning of their own now. Cmd is
// accepted alongside Ctrl because macOS converts Ctrl+click into a right-click
// before the app ever sees it, a conversion trackpad users rely on.
function decorationPressOptions(event = {}) {
  const modifiers = {
    ctrlKey: !!event.ctrlKey,
    metaKey: !!event.metaKey,
    altKey: !!event.altKey,
    shiftKey: !!event.shiftKey,
  };
  const debugChord = (modifiers.ctrlKey || modifiers.metaKey) && modifiers.altKey;
  return debugChord ? { copyResponse: true, modifiers } : { modifiers };
}

// Own both the held press and the released click. Cancellation invalidates the
// timing lookup as well as the timer, so a late IPC reply cannot re-arm a click.
//
// onPending(match, ms) reports an armed click and how long it will wait, so the
// link can show it was taken; onPending(null) reports that the wait ended,
// whether the click fired or a second press, a key or a scroll cancelled it.
function createDecorationPressController({
  navigate,
  onPending = () => {},
  getDoubleClickMs = () => null,
  canNavigate = () => true,
  holdMs = 200,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let press = null;
  let pendingClick = null;

  function settle(click) {
    if (click && click.timer) onPending(null);
  }

  function cancel() {
    press = null;
    if (pendingClick) clearTimer(pendingClick.timer);
    settle(pendingClick);
    pendingClick = null;
  }

  function down(input) {
    cancel();
    const next = beginDecorationPress(input);
    if (next) press = { ...next, delayed: !!input.delayed, startedAt: now(), dragged: false };
  }

  function move({ x, y }) {
    // Remember the entire drag, including one that returns to its origin.
    if (press && resolveDecorationPress(press, { button: 0, x, y }) === 'select') {
      press.dragged = true;
    }
  }

  function up(input, options) {
    const released = press;
    press = null;
    if (!released || released.dragged || resolveDecorationPress(released, input) !== 'navigate') return;
    if (!released.delayed) {
      navigate(released.match, options);
      return;
    }
    // A hold is reading/freezing intent, even if released at the original cell.
    if (now() - released.startedAt >= holdMs || !canNavigate(released.match)) return;
    const click = { timer: null };
    pendingClick = click;
    async function arm() {
      let interval;
      try { interval = await getDoubleClickMs(); } catch {}
      if (pendingClick !== click) return;
      // Without system timing, retain the old Ctrl/Cmd-only behavior. Guessing
      // a shorter interval could turn an accessibility-speed double click into
      // an application switch. Selection is the primary interaction.
      if (!Number.isFinite(interval) || interval <= 0) { pendingClick = null; return; }
      const wait = interval + DOUBLE_CLICK_MARGIN_MS;
      click.timer = setTimer(() => {
        if (pendingClick !== click) return;
        pendingClick = null;
        settle(click);
        if (canNavigate(released.match)) navigate(released.match, options);
      }, wait);
      onPending(released.match, wait);
    }
    void arm();
  }

  return { down, move, up, cancel };
}

module.exports = {
  DEFAULT_DRAG_THRESHOLD_PX,
  DOUBLE_CLICK_MARGIN_MS,
  beginDecorationPress,
  resolveDecorationPress,
  decorationPressOptions,
  createDecorationPressController,
};
