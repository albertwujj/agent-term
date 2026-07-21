// Tests for src/window-cap.js — pure-function pickEvictionVictim selector.

const assert = require('assert');
const {
  MIN_VISIBLE_FOR_RELAUNCH,
  WORKING_GRACE_MS,
  pickEvictionVictim,
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

function rec(id, fields) {
  return { id, file: { ...fields } };
}

test('picks the stalest non-working visible session', () => {
  const records = [
    rec(1, { lastInputAt: NOW - 10 * 60_000, lastWorkingAt: NOW - 10 * 60_000 }),  // 10m ago
    rec(2, { lastInputAt: NOW - 60 * 60_000, lastWorkingAt: NOW - 60 * 60_000 }),  // 60m ago — stalest
    rec(3, { lastInputAt: NOW - 30 * 60_000, lastWorkingAt: NOW - 30 * 60_000 }),  // 30m ago
  ];
  const victim = pickEvictionVictim(records, { now: NOW });
  assert.strictEqual(victim, 2);
});

test('skips currently-working sessions even if they are stalest by input', () => {
  const records = [
    // Stale by input but worked very recently → skip.
    rec(1, { lastInputAt: NOW - 60 * 60_000, lastWorkingAt: NOW - 30_000 }),
    rec(2, { lastInputAt: NOW - 20 * 60_000, lastWorkingAt: NOW - 20 * 60_000 }),  // candidate
    rec(3, { lastInputAt: NOW - 5  * 60_000, lastWorkingAt: NOW - 5  * 60_000 }),
  ];
  const victim = pickEvictionVictim(records, { now: NOW });
  assert.strictEqual(victim, 2);
});

test('returns null when every visible session is currently working', () => {
  const records = [
    rec(1, { lastInputAt: NOW - 60 * 60_000, lastWorkingAt: NOW - 30_000 }),
    rec(2, { lastInputAt: NOW - 20 * 60_000, lastWorkingAt: NOW - 60_000 }),
  ];
  const victim = pickEvictionVictim(records, { now: NOW });
  assert.strictEqual(victim, null);
});

test('hidden sessions do not count for eviction', () => {
  const records = [
    rec(1, { lastInputAt: NOW - 60 * 60_000, lastWorkingAt: NOW - 60 * 60_000, hiddenAt: NOW - 50 * 60_000 }),
    rec(2, { lastInputAt: NOW - 20 * 60_000, lastWorkingAt: NOW - 20 * 60_000 }),
  ];
  // Hidden 1 is older, but it's already hidden — visible 2 is the only candidate.
  const victim = pickEvictionVictim(records, { now: NOW });
  assert.strictEqual(victim, 2);
});

test('ignoreId excludes the spawning window from its own eviction', () => {
  const records = [
    rec(1, { lastInputAt: NOW - 60 * 60_000, lastWorkingAt: NOW - 60 * 60_000 }),
    rec(2, { lastInputAt: NOW - 30 * 60_000, lastWorkingAt: NOW - 30 * 60_000 }),
  ];
  // Without ignoreId, 1 is stalest. With ignoreId=1, only 2 is left.
  const victim = pickEvictionVictim(records, { now: NOW, ignoreId: 1 });
  assert.strictEqual(victim, 2);
});

test('lastPromptAt counts as activity (a recent prompt-only session is not stale)', () => {
  const records = [
    // Old input, but a prompt event came through more recently → not the stalest.
    rec(1, { lastInputAt: NOW - 60 * 60_000, lastPromptAt: NOW - 2 * 60_000, lastWorkingAt: NOW - 60 * 60_000 }),
    rec(2, { lastInputAt: NOW - 30 * 60_000, lastPromptAt: NOW - 30 * 60_000, lastWorkingAt: NOW - 30 * 60_000 }),
  ];
  const victim = pickEvictionVictim(records, { now: NOW });
  assert.strictEqual(victim, 2);
});

test('records with missing file (null) are skipped silently', () => {
  const records = [
    { id: 1, file: null },
    rec(2, { lastInputAt: NOW - 20 * 60_000, lastWorkingAt: NOW - 20 * 60_000 }),
  ];
  const victim = pickEvictionVictim(records, { now: NOW });
  assert.strictEqual(victim, 2);
});

test('sessions with no activity timestamps at all are treated as fully stale (lastActivity = 0)', () => {
  // A window that has never typed/worked/prompted is treated as the most
  // disposable thing — fine to hide first.
  const records = [
    rec(1, {}),  // no timestamps at all
    rec(2, { lastInputAt: NOW - 30 * 60_000, lastWorkingAt: NOW - 30 * 60_000 }),
  ];
  const victim = pickEvictionVictim(records, { now: NOW });
  assert.strictEqual(victim, 1);
});

test('grace boundary: a session that worked exactly WORKING_GRACE_MS ago is still working', () => {
  const records = [
    rec(1, { lastInputAt: NOW - 60 * 60_000, lastWorkingAt: NOW - WORKING_GRACE_MS + 1 }),  // grace, skip
    rec(2, { lastInputAt: NOW - 10 * 60_000, lastWorkingAt: NOW - 10 * 60_000 }),
  ];
  const victim = pickEvictionVictim(records, { now: NOW });
  assert.strictEqual(victim, 2);
});

test('relaunch threshold counts visible sessions, not hidden running sessions', () => {
  assert.strictEqual(MIN_VISIBLE_FOR_RELAUNCH, 3);
  const records = [
    rec(1, {}),
    rec(2, {}),
    rec(3, { hiddenAt: NOW - 5 * 60_000 }),
  ];
  assert.strictEqual(shouldRelaunchAfterUserClose(records), true);
});

test('relaunch threshold is satisfied by three visible sessions', () => {
  const records = [
    rec(1, {}),
    rec(2, {}),
    rec(3, {}),
  ];
  assert.strictEqual(shouldRelaunchAfterUserClose(records), false);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
