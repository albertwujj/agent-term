const assert = require('assert');
const { cleanAiTitle, aiTitleDedupeKey } = require('../src/ai-title');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try { fn(); testsPassed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('ai-title');

test('collapses repeated Claude title segments from OSC title', () => {
  assert.strictEqual(
    cleanAiTitle(
      '✳ Claude Code · Debug failing build at Jenkins pipeline · Debug failing build at Jenkins pipeline',
      'claude'
    ),
    'Debug failing build at Jenkins pipeline'
  );
});

test('spinner variants share one dedupe key', () => {
  assert.strictEqual(
    aiTitleDedupeKey('✳ Debug failing build at Jenkins pipeline', 'claude'),
    aiTitleDedupeKey('* Debug failing build at Jenkins pipeline', 'claude')
  );
  assert.strictEqual(
    aiTitleDedupeKey('⠦ Debug failing build at Jenkins pipeline', 'claude'),
    aiTitleDedupeKey('Debug failing build at Jenkins pipeline', 'claude')
  );
});

test('drops brand-only and agent-term status titles', () => {
  assert.strictEqual(cleanAiTitle('✳ Claude Code', 'claude'), '');
  assert.strictEqual(cleanAiTitle('⠦ agent-term', 'codex'), '');
});

test('keeps distinct title segments in order', () => {
  assert.strictEqual(
    cleanAiTitle('✳ Investigate CI failure · Check Gerrit patch', 'claude'),
    'Investigate CI failure · Check Gerrit patch'
  );
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
