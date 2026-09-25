// Tests for src/input-clock.js — the shared clock that advances only with
// the user's input in AgentTerm.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInputClock, MINUTE_MS } = require('../src/input-clock');

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

console.log('input-clock');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-input-clock-'));
}

function fakeTime(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const T0 = 1_700_000_000_000 - (1_700_000_000_000 % MINUTE_MS);

test('reads 0 before any input', () => {
  assert.strictEqual(createInputClock(tmpDir()).read(), 0);
});

test('input counts its minute once, however many keystrokes it holds', () => {
  const dir = tmpDir();
  const time = fakeTime(T0);
  const clock = createInputClock(dir, time);
  assert.strictEqual(clock.note(), 1);
  time.advance(20_000);
  assert.strictEqual(clock.note(), 1);
  time.advance(30_000);
  assert.strictEqual(clock.note(), 1);
  assert.strictEqual(clock.read(), 1);
});

test('minutes without input do not count: the clock stands still while away', () => {
  const dir = tmpDir();
  const time = fakeTime(T0);
  const clock = createInputClock(dir, time);
  clock.note();
  time.advance(8 * 60 * MINUTE_MS);      // a night away
  assert.strictEqual(clock.read(), 1);
  assert.strictEqual(clock.note(), 2);   // the first input back counts one minute
});

test('windows share the clock, and a minute counted by one is not counted again by another', () => {
  const dir = tmpDir();
  const time = fakeTime(T0);
  const a = createInputClock(dir, time);
  const b = createInputClock(dir, time);
  assert.strictEqual(a.note(), 1);
  time.advance(10_000);
  assert.strictEqual(b.note(), 1, 'same minute, other window');
  time.advance(MINUTE_MS);
  assert.strictEqual(b.note(), 2);
  assert.strictEqual(a.read(), 2);
});

test('a wall clock stepping back does not rewind or double-count', () => {
  const dir = tmpDir();
  const time = fakeTime(T0 + 10 * MINUTE_MS);
  const a = createInputClock(dir, time);
  a.note();
  const b = createInputClock(dir, fakeTime(T0));
  assert.strictEqual(b.note(), 1);
});

test('a corrupt file reads as a fresh clock', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'input-clock.json'), '{not json');
  const clock = createInputClock(dir, fakeTime(T0));
  assert.strictEqual(clock.read(), 0);
  assert.strictEqual(clock.note(), 1);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
