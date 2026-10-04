const assert = require('assert');
const { isConversationDocPath } = require('../src/conversation-doc-path');

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

console.log('conversation-doc-path');

test('a doc the continue-in-doc runbook writes is a handoff, in a subfolder too', () => {
  assert.ok(isConversationDocPath('/Users/u/repo/.git/conversation/streaming.md'));
  assert.ok(isConversationDocPath('/home/u/repo/.git/conversation/streaming/backpressure.md'));
  assert.ok(isConversationDocPath('/Users/u/repo/.git/conversation/Notes.MARKDOWN'));
});

test('only that exact place: other .git folders, look-alikes and relative paths are not', () => {
  assert.ok(!isConversationDocPath('/Users/u/repo/.git/review/main/main.md'));
  assert.ok(!isConversationDocPath('/Users/u/repo/.git-conversation/topic.md'));
  assert.ok(!isConversationDocPath('/Users/u/repo/conversation/topic.md'));
  assert.ok(!isConversationDocPath('.git/conversation/topic.md'));
  assert.ok(!isConversationDocPath('/Users/u/repo/.git/conversation/'));
  assert.ok(!isConversationDocPath('/Users/u/repo/.git/conversation/diagram.png'));
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
