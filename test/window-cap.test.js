// Tests for src/window-cap.js — auto-hide selection, the live cap's close
// order, turn detection, and the last-window relaunch threshold.

const assert = require('assert');
const {
  MAX_LIVE,
  STALE_AFTER_MINUTES,
  MIN_VISIBLE_FOR_RELAUNCH,
  WORKING_GRACE_MS,
  TURN_MIN_MS,
  isHideCandidate,
  pickStaleWindows,
  closeOrder,
  capVictims,
  createTurnTracker,
  shouldRelaunchAfterUserClose,
} = require('../src/window-cap');

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

console.log('window-cap');

const NOW = 1_700_000_000_000;
const CLOCK = 1000;
const judged = { clock: CLOCK, now: NOW };

function rec(id, fields) {
  return { id, file: { ...fields } };
}

// ---- hiding ----

test('a window untouched for STALE_AFTER_MINUTES of the input clock is stale', () => {
  assert.strictEqual(isHideCandidate({ touchedClock: CLOCK - STALE_AFTER_MINUTES }, judged), true);
  assert.strictEqual(isHideCandidate({ touchedClock: CLOCK - STALE_AFTER_MINUTES + 1 }, judged), false);
});

test('staleness is on the input clock: wall-clock age alone never makes a window stale', () => {
  // Touched a day ago by the wall clock, but the input clock has not moved since.
  const file = { touchedClock: CLOCK, touchedAt: NOW - 86_400_000 };
  assert.strictEqual(isHideCandidate(file, judged), false);
});

test('a working window stays through the grace period after its output stops', () => {
  const stale = CLOCK - 5 * STALE_AFTER_MINUTES;
  assert.strictEqual(isHideCandidate({ touchedClock: stale, lastWorkingAt: NOW - WORKING_GRACE_MS + 1 }, judged), false);
  assert.strictEqual(isHideCandidate({ touchedClock: stale, lastWorkingAt: NOW - WORKING_GRACE_MS }, judged), true);
  assert.strictEqual(isHideCandidate({ touchedClock: stale, lastWorkingAt: NOW - 2000 }, { ...judged, workingGraceMs: 1000 }), true);
});

test('a hidden window, or one written without a timer (an older build), is no candidate', () => {
  assert.strictEqual(isHideCandidate({ touchedClock: 0, hiddenAt: NOW - 1000 }, judged), false);
  assert.strictEqual(isHideCandidate({ lastInputAt: 0, lastWorkingAt: 0 }, judged), false);
  assert.strictEqual(isHideCandidate(null, judged), false);
});

test('pickStaleWindows returns every stale window except the asker', () => {
  const records = [
    rec(1, { touchedClock: CLOCK - 200 }),                        // stale
    rec(2, { touchedClock: CLOCK - 5 }),                          // fresh
    rec(3, { touchedClock: CLOCK - 200, lastWorkingAt: NOW }),    // working
    rec(4, { touchedClock: CLOCK - 200 }),                        // stale, but asking
    rec(5, { touchedClock: CLOCK - 200, hiddenAt: NOW - 1 }),     // already hidden
    { id: 6, file: null },
  ];
  assert.deepStrictEqual(pickStaleWindows(records, { ...judged, ignoreId: 4 }), [1]);
});

// ---- the live cap ----

test('close order: oldest timer first, wall clock breaking ties, hidden windows only', () => {
  const records = [
    rec(1, { touchedClock: 50, touchedAt: 300, hiddenAt: 1 }),
    rec(2, { touchedClock: 40, touchedAt: 900, hiddenAt: 1 }),
    rec(3, { touchedClock: 50, touchedAt: 100, hiddenAt: 1 }),    // ties 1 on the clock, touched earlier
    rec(4, { touchedClock: 10, touchedAt: 100 }),                 // visible: never in the order
  ];
  assert.deepStrictEqual(closeOrder(records).map(r => r.id), [2, 3, 1]);
});

test('no victims at or under MAX_LIVE', () => {
  const records = [];
  for (let i = 0; i < MAX_LIVE; i++) records.push(rec(i, { touchedClock: i, hiddenAt: 1 }));
  assert.deepStrictEqual(capVictims(records), []);
});

test('past MAX_LIVE, the oldest hidden sessions close, one per session over', () => {
  const records = [];
  for (let i = 0; i < MAX_LIVE + 2; i++) records.push(rec(i, { touchedClock: 100 - i, hiddenAt: 1 }));
  assert.deepStrictEqual(capVictims(records), [MAX_LIVE + 1, MAX_LIVE]);
});

test('visible windows never close: with too few hidden, only the hidden ones go', () => {
  const records = [];
  for (let i = 0; i < MAX_LIVE + 3; i++) records.push(rec(i, { touchedClock: i }));
  records[5].file.hiddenAt = 1;
  assert.deepStrictEqual(capVictims(records), [5]);
});

test('MAX_LIVE is 8', () => {
  assert.strictEqual(MAX_LIVE, 8);
});

// ---- turns ----

test('a span the title called working ends a turn, however short', () => {
  const t = createTurnTracker();
  assert.strictEqual(t.update(true, true, 0), false);
  assert.strictEqual(t.update(false, false, 1000), true);
});

test('an untitled span ends a turn only when it lasted TURN_MIN_MS', () => {
  const t = createTurnTracker();
  t.update(true, null, 0);
  assert.strictEqual(t.update(false, null, TURN_MIN_MS - 1), false, 'short span is churn');
  t.update(true, null, 100_000);
  t.update(true, null, 100_000 + TURN_MIN_MS);
  assert.strictEqual(t.update(false, null, 100_000 + TURN_MIN_MS + 1), true);
});

test('only the sample that ends the turn reports it', () => {
  const t = createTurnTracker();
  t.update(true, true, 0);
  assert.strictEqual(t.update(false, false, 500), true);
  assert.strictEqual(t.update(false, false, 1000), false);
  assert.strictEqual(t.update(false, null, 1500), false);
});

// ---- relaunch threshold ----

test('relaunch fires only when no visible session remains; hidden ones do not count', () => {
  assert.strictEqual(MIN_VISIBLE_FOR_RELAUNCH, 1);
  const records = [
    rec(1, { hiddenAt: NOW - 5 * 60_000 }),
  ];
  assert.strictEqual(shouldRelaunchAfterUserClose(records), true);
});

test('relaunch threshold is satisfied by a single visible session', () => {
  const records = [
    rec(1, {}),
    rec(2, { hiddenAt: NOW - 5 * 60_000 }),
  ];
  assert.strictEqual(shouldRelaunchAfterUserClose(records), false);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
