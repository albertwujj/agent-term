// node test/chrome-bar-lock.test.js — the padlock markup the chrome bar renders
// for each lock state (src/lock-status.js → src/chrome-bar.js).
const assert = require('assert');
const bar = require('../src/chrome-bar');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}
const count = (s, re) => (s.match(re) || []).length;

test('no lock state, or state none: no icon', () => {
  assert.equal(bar.renderLockMarkup(null), '');
  assert.equal(bar.renderLockMarkup({ state: 'none' }), '');
  assert.equal(bar.renderLockMarkup({ state: 'bogus' }), '');
  assert.ok(!bar.renderBarMarkup({ cli: 'claude', prompt: 'x' }).includes('at-chrome-lock'));
});

test('free: open shackle, outline body, muted grey', () => {
  const m = bar.renderLockMarkup({ state: 'free', tooltip: 'lock/agent free · on work/x' });
  assert.ok(m.includes('class="at-chrome-lock free"'));
  assert.ok(m.includes('color:#909090'));
  assert.ok(m.includes('a3 3 0 0 0-6 0'), 'open shackle');
  assert.equal(count(m, /<rect[^>]*fill="none"/g), 1, 'outline body');
  assert.ok(m.includes('title="lock/agent free · on work/x"'));
});

test('mine: filled body with the check, the working dot green', () => {
  const m = bar.renderLockMarkup({ state: 'mine', tooltip: 'lock/agent · work/a · you' });
  assert.ok(m.includes('class="at-chrome-lock mine"'));
  assert.ok(m.includes('color:#a3d977'));
  assert.ok(m.includes('fill="currentColor"'), 'filled body');
  assert.ok(m.includes('l1.7 1.7 3.3-3.5'), 'check mark');
});

test('other-active: filled body in the holder window\'s hue, no check', () => {
  const m = bar.renderLockMarkup({ state: 'other-active', hue: 330, tooltip: 't' });
  assert.ok(m.includes('color:' + bar.hueColor(330)));
  assert.ok(m.includes('fill="currentColor"'));
  assert.ok(!m.includes('l1.7 1.7 3.3-3.5'), 'no check');
});

test('other-idle: outline body in the holder window\'s hue', () => {
  const m = bar.renderLockMarkup({ state: 'other-idle', hue: 120, tooltip: 't' });
  assert.ok(m.includes('color:' + bar.hueColor(120)));
  assert.equal(count(m, /<rect[^>]*fill="none"/g), 1);
  assert.ok(!m.includes('stroke-dasharray'));
});

test('other-* without a known hue falls back to grey', () => {
  assert.ok(bar.renderLockMarkup({ state: 'other-active', hue: null, tooltip: 't' }).includes('color:#909090'));
});

test('no-window: both shackle and body dashed, grey', () => {
  const m = bar.renderLockMarkup({ state: 'no-window', tooltip: 't' });
  assert.ok(m.includes('color:#7a7a7a'));
  assert.equal(count(m, /stroke-dasharray="1.8 1.3"/g), 2, 'shackle and body both dashed');
});

test('tooltip is escaped', () => {
  const m = bar.renderLockMarkup({ state: 'free', tooltip: 'a "b" <c>' });
  assert.ok(m.includes('title="a &quot;b&quot; &lt;c&gt;"'));
});

test('renderBarMarkup places the icon after the dot', () => {
  const m = bar.renderBarMarkup({ cli: 'claude', prompt: 'fix login', isWorking: true, lock: { state: 'mine', tooltip: 'you' } });
  assert.ok(m.indexOf('at-chrome-dot working') < m.indexOf('at-chrome-lock mine'));
});

console.log(`\nchrome-bar lock: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
