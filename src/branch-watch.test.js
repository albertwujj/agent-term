// node --test src/branch-watch.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { isEngaged, evaluate, rebaseline } = require('./branch-watch');

const NOW = 1_700_000_000_000;
const iso = (ms) => new Date(ms).toISOString();
const ctx = { bootId: 'BOOT', now: NOW };
const kinds = (r) => r.messages.map((m) => m.kind);

test('isEngaged: only work/<kebab-slug> counts', () => {
  for (const b of ['work/auth-refresh', 'work/payments-retry-backoff', 'work/orders-null-check-20260628'])
    assert.equal(isEngaged(b), true, b);
  for (const b of ['main', 'develop', 'release-2.4', 'feature/login', 'work/Foo', 'work/', 'work/a/b', '', 'HEAD'])
    assert.equal(isEngaged(b), false, b);
});

test('not engaged (e.g. agent-term on main): silent, nothing tracked', () => {
  const r = evaluate({ isRepo: true, branch: 'main' }, null, ctx);
  assert.deepEqual(r.messages, []);
  assert.equal(r.tracked, null);
});

test('not armed: a work branch is NOT stamped (fresh agent on a leftover branch)', () => {
  const r = evaluate({ isRepo: true, branch: 'work/auth-refresh' }, null, ctx); // ctx has no armed
  assert.deepEqual(r.messages, []);
  assert.equal(r.tracked, null);
});

test('armed + HEAD switched to a new work branch: stamps it', () => {
  const r = evaluate({ isRepo: true, branch: 'work/auth-refresh' }, null,
    { ...ctx, armed: true, armBase: 'develop' });
  assert.deepEqual(r.messages, []);
  assert.equal(r.tracked, 'work/auth-refresh');
});

test('armed but HEAD has not switched yet (still on armBase): wait, do not stamp', () => {
  const r = evaluate({ isRepo: true, branch: 'work/old' }, null,
    { ...ctx, armed: true, armBase: 'work/old' });
  assert.deepEqual(r.messages, []);
  assert.equal(r.tracked, null);
});

test('work -> work warns (another task branch underneath), keeps tracking the original', () => {
  const r = evaluate({ isRepo: true, branch: 'work/payments-retry' }, 'work/auth-refresh', ctx);
  assert.deepEqual(kinds(r), ['branch']);
  assert.match(r.messages[0].text, /Branch changed: work\/auth-refresh → work\/payments-retry/);
  assert.equal(r.tracked, 'work/auth-refresh');
});

test('work -> non-work warns (fell off)', () => {
  const r = evaluate({ isRepo: true, branch: 'develop' }, 'work/auth-refresh', ctx);
  assert.deepEqual(kinds(r), ['branch']);
});

test('back in sync: no message', () => {
  const r = evaluate({ isRepo: true, branch: 'work/auth-refresh' }, 'work/auth-refresh', ctx);
  assert.deepEqual(r.messages, []);
});

test('lock held by another work branch: collision', () => {
  const r = evaluate({
    isRepo: true, branch: 'work/auth-refresh', lockHeld: true,
    owner: { branch: 'work/payments-retry', boot: 'BOOT', acquired: iso(NOW - 60_000) },
  }, 'work/auth-refresh', ctx);
  assert.deepEqual(kinds(r), ['lock-collision']);
  assert.match(r.messages[0].text, /work\/payments-retry/);
});

test('lock held by self: silent', () => {
  const r = evaluate({
    isRepo: true, branch: 'work/auth-refresh', lockHeld: true,
    owner: { branch: 'work/auth-refresh', boot: 'BOOT', acquired: iso(NOW - 60_000) },
  }, 'work/auth-refresh', ctx);
  assert.deepEqual(r.messages, []);
});

// Stale-lock detection was removed (age is an unreliable "abandoned" signal; returns with a
// heartbeat). A held lock from ANOTHER branch is now just a collision, regardless of age/boot.
test('no stale heuristic: an old/rebooted lock from another branch is a plain collision', () => {
  const r = evaluate({
    isRepo: true, branch: 'work/auth-refresh', lockHeld: true,
    owner: { branch: 'work/old', boot: 'OLDBOOT', acquired: iso(NOW - 2 * 3600_000) },
  }, 'work/auth-refresh', ctx);
  assert.deepEqual(kinds(r), ['lock-collision']); // age/boot no longer escalate to lock-stale
});

// The false-positive we removed: a live long task holding its OWN lock must stay silent.
test('self-owned lock is silent even when old / boot-mismatched (no false stale)', () => {
  const r = evaluate({
    isRepo: true, branch: 'work/auth-refresh', lockHeld: true,
    owner: { branch: 'work/auth-refresh', boot: 'OLDBOOT', acquired: iso(NOW - 2 * 3600_000) },
  }, 'work/auth-refresh', ctx);
  assert.deepEqual(r.messages, []);
});

test('lock ignored when not on a work branch', () => {
  const r = evaluate({
    isRepo: true, branch: 'develop', lockHeld: true,
    owner: { branch: 'work/x', boot: 'BOOT', acquired: iso(NOW) },
  }, null, ctx);
  assert.deepEqual(r.messages, []); // not engaged, nothing tracked
});

test('branch + lock can both fire', () => {
  const r = evaluate({
    isRepo: true, branch: 'work/payments-retry', lockHeld: true,
    owner: { branch: 'work/other', boot: 'BOOT', acquired: iso(NOW - 60_000) },
  }, 'work/auth-refresh', ctx);
  assert.deepEqual(kinds(r).sort(), ['branch', 'lock-collision']);
});

test('dirty tracked tree + no lock on a work branch: warn', () => {
  const r = evaluate({ isRepo: true, branch: 'work/auth-refresh', lockHeld: false, dirtyTracked: true },
    'work/auth-refresh', ctx);
  assert.deepEqual(kinds(r), ['lock-missing-dirty']);
});

test('dirty tree but NOT on a work branch (e.g. agent-term on main): silent', () => {
  const r = evaluate({ isRepo: true, branch: 'main', lockHeld: false, dirtyTracked: true }, null, ctx);
  assert.deepEqual(r.messages, []);
});

test('dirty tree while holding the lock yourself: no dirty warning', () => {
  const r = evaluate({
    isRepo: true, branch: 'work/auth-refresh', lockHeld: true, dirtyTracked: true,
    owner: { branch: 'work/auth-refresh', boot: 'BOOT', acquired: iso(NOW) },
  }, 'work/auth-refresh', ctx);
  assert.deepEqual(r.messages, []);
});

test('clean tree + no lock: no dirty warning', () => {
  const r = evaluate({ isRepo: true, branch: 'work/auth-refresh', lockHeld: false, dirtyTracked: false },
    'work/auth-refresh', ctx);
  assert.deepEqual(r.messages, []);
});

test('unknown/detached branch (mid rebase) does not warn; tracked preserved', () => {
  const r = evaluate({ isRepo: true, branch: null, lockHeld: false }, 'work/auth-refresh', ctx);
  assert.deepEqual(r.messages, []);
  assert.equal(r.tracked, 'work/auth-refresh');
});

test('not a repo: silent, tracked preserved', () => {
  const r = evaluate({ isRepo: false }, 'work/auth-refresh', ctx);
  assert.deepEqual(r.messages, []);
  assert.equal(r.tracked, 'work/auth-refresh');
});

test('rebaseline: to current work branch, or null off-workflow', () => {
  assert.equal(rebaseline({ branch: 'work/new-task' }), 'work/new-task');
  assert.equal(rebaseline({ branch: 'develop' }), null);
});
