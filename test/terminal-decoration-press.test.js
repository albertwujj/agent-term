const {
  DEFAULT_DRAG_THRESHOLD_PX,
  beginDecorationPress,
  resolveDecorationPress,
  decorationPressOptions,
  createDecorationPressController,
  DOUBLE_CLICK_MARGIN_MS,
} = require('../src/terminal-decoration-press');
const { createDoubleClickIntervalReader } = require('../src/double-click-interval');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assertEqual(actual, expected, msg = '') {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${msg}\n  expected: ${expectedStr}\n  actual:   ${actualStr}`);
  }
}

const MATCH = { patternName: 'symbol', text: 'foo', start: 0, end: 3 };

// --- beginDecorationPress ---------------------------------------------------

test('beginDecorationPress returns a pending record for a left press on a match', () => {
  const pending = beginDecorationPress({ button: 0, shiftKey: false, match: MATCH, x: 10, y: 20 });
  assertEqual(pending, { match: MATCH, x: 10, y: 20 });
});

test('beginDecorationPress ignores non-left buttons', () => {
  assertEqual(beginDecorationPress({ button: 1, shiftKey: false, match: MATCH, x: 1, y: 2 }), null);
  assertEqual(beginDecorationPress({ button: 2, shiftKey: false, match: MATCH, x: 1, y: 2 }), null);
});

test('beginDecorationPress ignores shift presses (shift-drag has its own path)', () => {
  assertEqual(beginDecorationPress({ button: 0, shiftKey: true, match: MATCH, x: 1, y: 2 }), null);
});

test('beginDecorationPress returns null when the press is not on navigable text', () => {
  assertEqual(beginDecorationPress({ button: 0, shiftKey: false, match: null, x: 1, y: 2 }), null);
});

test('beginDecorationPress ignores multi-click presses (word/line select)', () => {
  // The second press of a double click and the third of a triple click are
  // selection gestures; arming them would navigate once per press.
  assertEqual(beginDecorationPress({ button: 0, shiftKey: false, match: MATCH, x: 1, y: 2, detail: 2 }), null);
  assertEqual(beginDecorationPress({ button: 0, shiftKey: false, match: MATCH, x: 1, y: 2, detail: 3 }), null);
});

test('beginDecorationPress arms the first press of a click sequence', () => {
  const pending = beginDecorationPress({ button: 0, shiftKey: false, match: MATCH, x: 1, y: 2, detail: 1 });
  assertEqual(pending && pending.match, MATCH);
});

test('beginDecorationPress tolerates a missing argument object', () => {
  assertEqual(beginDecorationPress(), null);
});

// --- resolveDecorationPress -------------------------------------------------

test('resolveDecorationPress navigates on a click that stays in place', () => {
  const pending = { match: MATCH, x: 100, y: 100 };
  assertEqual(resolveDecorationPress(pending, { button: 0, x: 100, y: 100 }), 'navigate');
});

test('resolveDecorationPress navigates when movement is within the threshold', () => {
  const pending = { match: MATCH, x: 100, y: 100 };
  // Move exactly the threshold on both axes — still a click, not a drag.
  assertEqual(
    resolveDecorationPress(pending, {
      button: 0,
      x: 100 + DEFAULT_DRAG_THRESHOLD_PX,
      y: 100 - DEFAULT_DRAG_THRESHOLD_PX,
    }),
    'navigate',
  );
});

test('resolveDecorationPress selects when the press drags past the threshold (x)', () => {
  const pending = { match: MATCH, x: 100, y: 100 };
  assertEqual(
    resolveDecorationPress(pending, { button: 0, x: 100 + DEFAULT_DRAG_THRESHOLD_PX + 1, y: 100 }),
    'select',
  );
});

test('resolveDecorationPress selects when the press drags past the threshold (y)', () => {
  const pending = { match: MATCH, x: 100, y: 100 };
  assertEqual(
    resolveDecorationPress(pending, { button: 0, x: 100, y: 100 + DEFAULT_DRAG_THRESHOLD_PX + 1 }),
    'select',
  );
});

test('resolveDecorationPress ignores a release with no pending press', () => {
  assertEqual(resolveDecorationPress(null, { button: 0, x: 5, y: 5 }), 'ignore');
});

test('resolveDecorationPress ignores a non-left release even with a pending press', () => {
  const pending = { match: MATCH, x: 100, y: 100 };
  assertEqual(resolveDecorationPress(pending, { button: 1, x: 100, y: 100 }), 'ignore');
});

test('resolveDecorationPress honors a custom threshold', () => {
  const pending = { match: MATCH, x: 0, y: 0 };
  assertEqual(resolveDecorationPress(pending, { button: 0, x: 8, y: 0 }, 10), 'navigate');
  assertEqual(resolveDecorationPress(pending, { button: 0, x: 12, y: 0 }, 10), 'select');
});

// --- decorationPressOptions -------------------------------------------------
//
// These moved here from the integration suite, where they exercised a copy of
// this decision in terminal-decoration-actions that the renderer never called.

test('decorationPressOptions activates a plain press without a debug payload', () => {
  const options = decorationPressOptions({});
  assertEqual(options.copyResponse, undefined, 'a plain click should not request the debug payload');
  assertEqual(options.modifiers, { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
});

test('decorationPressOptions treats Ctrl+Alt as the debug chord', () => {
  const options = decorationPressOptions({ ctrlKey: true, altKey: true });
  assertEqual(options.copyResponse, true, 'Ctrl+Alt+click should request the debug payload');
});

test('decorationPressOptions treats Cmd+Alt as the debug chord (Mac)', () => {
  const options = decorationPressOptions({ metaKey: true, altKey: true });
  assertEqual(options.copyResponse, true, 'Cmd+Alt+click should request the debug payload');
});

test('decorationPressOptions forwards Ctrl alone as a normal activation', () => {
  const options = decorationPressOptions({ ctrlKey: true });
  assertEqual(options.copyResponse, undefined, 'plain Ctrl+click should not request the debug payload');
  assertEqual(options.modifiers.ctrlKey, true, 'ctrlKey should reach the action for branching');
});

test('decorationPressOptions forwards Alt alone for the chooser', () => {
  const options = decorationPressOptions({ altKey: true });
  assertEqual(options.copyResponse, undefined, 'Alt+click should not request the debug payload');
  assertEqual(options.modifiers.altKey, true, 'altKey should reach the action for the chooser');
});

test('decorationPressOptions tolerates a missing event', () => {
  assertEqual(decorationPressOptions().modifiers.shiftKey, false);
});

// Deterministic gesture timing: test event ordering without real sleeps.
function gestureHarness(overrides = {}) {
  let time = 0;
  let selectable = true;
  const timers = new Set();
  const navigations = [];
  const controller = createDecorationPressController({
    now: () => time,
    canNavigate: () => selectable,
    navigate: (match, options) => navigations.push({ match, options }),
    getDoubleClickMs: () => 700,
    setTimer: (fn, ms) => { const timer = { fn, at: time + ms }; timers.add(timer); return timer; },
    clearTimer: (timer) => timers.delete(timer),
    ...overrides,
  });
  const down = (opts = {}) => controller.down({ button: 0, match: MATCH, x: 10, y: 20, delayed: true, ...opts });
  const up = () => controller.up({ button: 0, x: 10, y: 20 }, decorationPressOptions());
  const tick = async (ms) => {
    await Promise.resolve(); // let the native timing lookup settle
    time += ms;
    for (const timer of [...timers]) {
      if (timer.at <= time) { timers.delete(timer); timer.fn(); }
    }
  };
  return { controller, down, up, tick, navigations, setSelectable: (value) => { selectable = value; } };
}

test('a newly enabled plain click waits for system timing and navigates exactly once', async () => {
  const h = gestureHarness();
  h.down(); h.up();
  await h.tick(699 + DOUBLE_CLICK_MARGIN_MS);
  assertEqual(h.navigations.length, 0);
  await h.tick(1);
  assertEqual(h.navigations.length, 1);
  await h.tick(2000);
  assertEqual(h.navigations.length, 1);
});

test('existing immediate targets do not read timing or schedule navigation', async () => {
  const h = gestureHarness({ getDoubleClickMs: () => { throw new Error('unexpected timing lookup'); } });
  h.down({ delayed: false }); h.up();
  assertEqual(h.navigations.length, 1);
  await h.tick(2000);
  assertEqual(h.navigations.length, 1);
});

test('the second DOWN cancels even when its release comes after the deadline', async () => {
  const h = gestureHarness();
  h.down(); h.up();
  await h.tick(650);
  h.down({ detail: 2 });
  await h.tick(1000);
  h.up();
  h.down({ detail: 3 }); h.up();
  await h.tick(1000);
  assertEqual(h.navigations.length, 0);
});

test('a drag that returns to its origin never navigates', async () => {
  for (const delayed of [true, false]) {
    const h = gestureHarness();
    h.down({ delayed });
    h.controller.move({ x: 30, y: 20 });
    h.controller.move({ x: 10, y: 20 });
    h.up();
    await h.tick(2000);
    assertEqual(h.navigations.length, 0);
  }
});

test('hold-to-freeze intent cancels the newly enabled click', async () => {
  const h = gestureHarness();
  h.down();
  await h.tick(200);
  h.up();
  await h.tick(2000);
  assertEqual(h.navigations.length, 0);
});

test('selection or comment state blocks navigation at release and at the deadline', async () => {
  for (const beforeRelease of [true, false]) {
    const h = gestureHarness();
    h.down();
    if (beforeRelease) h.setSelectable(false);
    h.up();
    h.setSelectable(false);
    await h.tick(2000);
    assertEqual(h.navigations.length, 0);
  }
});

test('cancellation while pressed or waiting prevents a later action', async () => {
  for (const beforeRelease of [true, false]) {
    const h = gestureHarness();
    h.down();
    if (beforeRelease) h.controller.cancel();
    h.up();
    await h.tick(10);
    h.controller.cancel(); // Escape, typing, scroll, blur, resize, or buffer change
    await h.tick(2000);
    assertEqual(h.navigations.length, 0);
  }
});

test('a late timing reply cannot revive a cancelled click or replace a newer one', async () => {
  let reply;
  const h = gestureHarness({ getDoubleClickMs: () => new Promise((resolve) => { reply = resolve; }) });
  h.down(); h.up();
  h.controller.cancel();
  h.down({ delayed: false }); h.up();
  reply(700);
  await h.tick(2000);
  assertEqual(h.navigations.length, 1);
});

test('a rejected native lookup preserves selection and leaves modified clicks working', async () => {
  const h = gestureHarness({ getDoubleClickMs: () => Promise.reject(new Error('unavailable')) });
  h.down(); h.up();
  await h.tick(6000);
  assertEqual(h.navigations.length, 0);
  h.down({ delayed: false }); h.up();
  assertEqual(h.navigations.length, 1);
});

test('missing or invalid native timing never guesses a shorter double-click interval', async () => {
  for (const interval of [null, undefined, 0, -1, NaN, Infinity]) {
    const h = gestureHarness({ getDoubleClickMs: () => interval });
    h.down(); h.up();
    await h.tick(6000);
    assertEqual(h.navigations.length, 0);
  }
});

test('native timing is loaded lazily and mouse setting changes are read afresh', () => {
  let loads = 0;
  let interval = 500;
  const read = createDoubleClickIntervalReader({
    platform: 'win32',
    loadKoffi: () => { loads++; return { load: () => ({ func: () => () => interval }) }; },
  });
  assertEqual(loads, 0);
  assertEqual(read(), 500);
  interval = 1500;
  assertEqual(read(), 1500);
  assertEqual(loads, 1);
});

test('native load failure or unsupported platforms leave timing unavailable', () => {
  const loadKoffi = () => { throw new Error('native module unavailable'); };
  assertEqual(createDoubleClickIntervalReader({ platform: 'win32', loadKoffi })(), null);
  assertEqual(createDoubleClickIntervalReader({ platform: 'darwin', loadKoffi })(), null);
  assertEqual(createDoubleClickIntervalReader({ platform: 'linux', loadKoffi })(), null);
});

// --- runner -----------------------------------------------------------------

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      failed += 1;
      console.error(`✗ ${name}`);
      console.error(`  ${err.message}`);
    }
  }
  console.log(`\nterminal-decoration-press: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
