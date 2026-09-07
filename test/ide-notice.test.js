// Tests for src/ide-notice.js: when a failed IDE jump says so, and what.

const assert = require('assert');
const { ideUnreachableNotice, IDE_DOC_URL } = require('../src/ide-notice');

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

const unreachable = { success: false, error: 'Cannot connect to the IDE navigator plugin (port 8765)', unreachable: true, port: 8765 };

console.log('ide-notice');

test('a result with a status is not an unreachable IDE', () => {
  const state = { shown: false };
  assert.strictEqual(ideUnreachableNotice({ status: 'not_found' }, { state }), null);
  assert.strictEqual(state.shown, false);
});

test('a TCP failure that is not "unreachable" keeps the plain error path', () => {
  assert.strictEqual(ideUnreachableNotice({ success: false, error: 'Connection error: EPIPE' }, { state: { shown: false } }), null);
});

test('a plain click says it once per window', () => {
  const state = { shown: false };
  assert.ok(ideUnreachableNotice(unreachable, { state }), 'first time');
  assert.strictEqual(state.shown, true);
  assert.strictEqual(ideUnreachableNotice(unreachable, { state }), null, 'second time');
});

test('a Ctrl/Cmd-click says it every time', () => {
  const state = { shown: true };
  assert.ok(ideUnreachableNotice(unreachable, { explicit: true, state }));
  assert.ok(ideUnreachableNotice(unreachable, { explicit: true, state }));
});

test('the notice names the port and links the IDE doc', () => {
  const n = ideUnreachableNotice(unreachable, { state: { shown: false } });
  assert.strictEqual(n.text, 'No IDE is listening on port 8765. Set up the IDE jump:');
  assert.strictEqual(n.linkLabel, 'docs/ide.md');
  assert.strictEqual(n.url, IDE_DOC_URL);
  assert.ok(/\/docs\/ide\.md$/.test(n.url));
  assert.ok(!/pycharm/i.test(n.text + unreachable.error));
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
