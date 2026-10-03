const assert = require('assert');
const { isDiscussionDocPath } = require('../src/discussion-doc-path');

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

console.log('discussion-doc-path');

test('a doc the split runbook writes is a handoff, in a subfolder too', () => {
  assert.ok(isDiscussionDocPath('/Users/u/repo/.git/discussion/streaming.md'));
  assert.ok(isDiscussionDocPath('/home/u/repo/.git/discussion/streaming/backpressure.md'));
  assert.ok(isDiscussionDocPath('/Users/u/repo/.git/discussion/Notes.MARKDOWN'));
});

test('only that exact place: other .git folders, look-alikes and relative paths are not', () => {
  assert.ok(!isDiscussionDocPath('/Users/u/repo/.git/review/main/main.md'));
  assert.ok(!isDiscussionDocPath('/Users/u/repo/.git-discussion/topic.md'));
  assert.ok(!isDiscussionDocPath('/Users/u/repo/discussion/topic.md'));
  assert.ok(!isDiscussionDocPath('.git/discussion/topic.md'));
  assert.ok(!isDiscussionDocPath('/Users/u/repo/.git/discussion/'));
  assert.ok(!isDiscussionDocPath('/Users/u/repo/.git/discussion/diagram.png'));
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
