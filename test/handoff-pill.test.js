// Tests for src/handoff-pill.js: when the handoff pill shows and goes.

const assert = require('assert');
const { createHandoffPillTiming } = require('../src/handoff-pill');

let testsPassed = 0, testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

// A clock the test advances, so nothing here depends on how fast it runs.
function setup() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  const events = [];
  const timing = createHandoffPillTiming({
    show: (text) => events.push(`show ${text}`),
    hide: () => events.push('hide'),
    delayMs: 250,
    lingerMs: 1000,
    setTimer: (fn, ms) => { timers.set(nextId, { fn, at: time + ms }); return nextId++; },
    clearTimer: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    const end = time + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      time = due[1].at;
      due[1].fn();
    }
    time = end;
  };
  return { timing, advance, events, timers };
}

console.log('handoff-pill');

test('a handoff still running after the delay shows the pill', () => {
  const { timing, advance, events } = setup();
  timing.begin('Opening a', 10000);
  advance(249);
  assert.deepStrictEqual(events, []);
  advance(1);
  assert.deepStrictEqual(events, ['show Opening a']);
});

test('a handoff finished before the delay never shows it', () => {
  const { timing, advance, events, timers } = setup();
  const handoff = timing.begin('Opening a', 10000);
  advance(100);
  timing.finish(handoff);
  advance(20000);
  assert.deepStrictEqual(events, []);
  assert.strictEqual(timers.size, 0);
});

test('focus leaving before the delay never shows it', () => {
  const { timing, advance, events } = setup();
  timing.begin('Opening a', 10000);
  advance(100);
  timing.dismiss();
  advance(20000);
  assert.deepStrictEqual(events, []);
});

test('however long the wait, the pill stays until it ends and hides once', () => {
  const { timing, advance, events, timers } = setup();
  const handoff = timing.begin('Opening a', 10000);
  advance(9000);
  assert.deepStrictEqual(events, ['show Opening a']);
  timing.finish(handoff);
  timing.dismiss();
  advance(20000);
  assert.deepStrictEqual(events, ['show Opening a', 'hide']);
  assert.strictEqual(timers.size, 0);
});

test('with no end reported, the timeout reaps the pill', () => {
  const { timing, advance, events } = setup();
  timing.begin('Opening a', 10000);
  advance(9999);
  assert.deepStrictEqual(events, ['show Opening a']);
  advance(1);
  assert.deepStrictEqual(events, ['show Opening a', 'hide']);
});

test('a later handoff replaces an earlier one, whose end cannot take it down', () => {
  const { timing, advance, events } = setup();
  const first = timing.begin('Opening a', 10000);
  advance(300);
  const second = timing.begin('Opening b', 10000);
  assert.deepStrictEqual(events, ['show Opening a', 'hide']);
  advance(250);
  assert.deepStrictEqual(events, ['show Opening a', 'hide', 'show Opening b']);
  timing.finish(first);
  timing.linger(first);
  advance(2000);
  assert.deepStrictEqual(events, ['show Opening a', 'hide', 'show Opening b']);
  timing.finish(second);
  assert.deepStrictEqual(events, ['show Opening a', 'hide', 'show Opening b', 'hide']);
});

test('a replaced handoff that never showed stays unseen', () => {
  const { timing, advance, events } = setup();
  timing.begin('Opening a', 10000);
  advance(100);
  timing.begin('Opening b', 10000);
  advance(250);
  assert.deepStrictEqual(events, ['show Opening b']);
});

test('nearly done before the delay cancels the pill', () => {
  const { timing, advance, events } = setup();
  const handoff = timing.begin('Opening a', 10000);
  advance(100);
  timing.linger(handoff);
  advance(20000);
  assert.deepStrictEqual(events, []);
});

test('nearly done after the delay keeps the pill until focus moves', () => {
  const { timing, advance, events } = setup();
  const handoff = timing.begin('Opening a', 10000);
  advance(300);
  timing.linger(handoff);
  advance(500);
  assert.deepStrictEqual(events, ['show Opening a']);
  timing.dismiss();
  advance(20000);
  assert.deepStrictEqual(events, ['show Opening a', 'hide']);
});

test('nearly done with no window coming takes the pill down shortly', () => {
  const { timing, advance, events } = setup();
  const handoff = timing.begin('Opening a', 10000);
  advance(300);
  timing.linger(handoff);
  advance(1000);
  assert.deepStrictEqual(events, ['show Opening a', 'hide']);
  advance(20000);
  assert.deepStrictEqual(events, ['show Opening a', 'hide']);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
