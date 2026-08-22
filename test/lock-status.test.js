// node test/lock-status.test.js
const assert = require('assert');
const { decide, fmtIdle } = require('../src/lock-status');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

const NOW = 1_700_000_000_000;
const me = { token: 'aaaa11', now: NOW };
const opts = { idleMs: 60_000 };

test('free, HEAD on a work branch: open padlock', () => {
  const r = decide({ lockHeld: false, headBranch: 'work/login-fix' }, me, null, opts);
  assert.equal(r.state, 'free');
  assert.match(r.tooltip, /free · on work\/login-fix/);
});

test('free, HEAD elsewhere (develop, detached): nothing', () => {
  for (const b of ['develop', 'main', 'HEAD', null, undefined, 'feature/x'])
    assert.equal(decide({ lockHeld: false, headBranch: b }, me, null, opts).state, 'none', String(b));
});

test('held by this window (token match): mine, no holder lookup needed', () => {
  const r = decide({ lockHeld: true, owner: { branch: 'work/a', session: 'aaaa11' }, headBranch: 'work/a' }, me, null, opts);
  assert.equal(r.state, 'mine');
  assert.equal(r.tooltip, 'lock/agent · work/a · you');
});

test('held by another window that is working: other-active with its hue', () => {
  const holder = { lastWorkingAt: NOW - 10_000, hue: 330 };
  const r = decide({ lockHeld: true, owner: { branch: 'work/b', session: 'bbbb22' } }, me, holder, opts);
  assert.equal(r.state, 'other-active');
  assert.equal(r.hue, 330);
  assert.equal(r.tooltip, 'lock/agent · work/b · other window, active');
});

test('held by another window that went quiet: other-idle with the duration', () => {
  const holder = { lastWorkingAt: NOW - 12 * 60_000, hue: 120 };
  const r = decide({ lockHeld: true, owner: { branch: 'work/b', session: 'bbbb22' } }, me, holder, opts);
  assert.equal(r.state, 'other-idle');
  assert.equal(r.idleMs, 12 * 60_000);
  assert.equal(r.tooltip, 'lock/agent · work/b · other window, idle 12m');
});

test('idle threshold is exclusive: exactly idleMs quiet still counts as active', () => {
  const holder = { lastWorkingAt: NOW - 60_000, hue: 120 };
  assert.equal(decide({ lockHeld: true, owner: { branch: 'work/b', session: 'bbbb22' } }, me, holder, opts).state, 'other-active');
});

test('held, no live window carries the token: no-window', () => {
  const r = decide({ lockHeld: true, owner: { branch: 'work/b', session: 'bbbb22' } }, me, null, opts);
  assert.equal(r.state, 'no-window');
  assert.equal(r.tooltip, 'lock/agent · work/b · no window open');
});

test('held with no session in the record (no host), or no record at all: no-window', () => {
  assert.equal(decide({ lockHeld: true, owner: { branch: 'work/b', session: '' } }, me, { lastWorkingAt: NOW }, opts).state, 'no-window');
  const r = decide({ lockHeld: true, owner: null }, me, null, opts);
  assert.equal(r.state, 'no-window');
  assert.equal(r.tooltip, 'lock/agent · ? · no window open');
});

test('this window has no token yet: a held lock is never "mine"', () => {
  const r = decide({ lockHeld: true, owner: { branch: 'work/b', session: '' } }, { token: '', now: NOW }, null, opts);
  assert.equal(r.state, 'no-window');
});

test('a loop launched from this window inherits the token, so its lock is mine', () => {
  // Same token in the record as this window's; the holder lookup would find this very window.
  const r = decide({ lockHeld: true, owner: { branch: 'work/a', session: 'aaaa11' } }, me, { lastWorkingAt: 0, hue: 1 }, opts);
  assert.equal(r.state, 'mine');
});

test('fmtIdle', () => {
  assert.equal(fmtIdle(30_000), '<1m');
  assert.equal(fmtIdle(5 * 60_000), '5m');
  assert.equal(fmtIdle(125 * 60_000), '2h 5m');
  assert.equal(fmtIdle(120 * 60_000), '2h');
  assert.equal(fmtIdle(-1), '?');
});

console.log(`\nlock-status: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
