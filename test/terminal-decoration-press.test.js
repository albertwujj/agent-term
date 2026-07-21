const {
  DEFAULT_DRAG_THRESHOLD_PX,
  beginDecorationPress,
  resolveDecorationPress,
} = require('../src/terminal-decoration-press');

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
