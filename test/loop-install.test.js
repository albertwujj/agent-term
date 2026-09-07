// The clone prompt the dialog sends is the README's prompt, word for word.
//
// The README is what a reader follows and the dialog is what the terminal
// sends on their behalf; if the two drift, the terminal asks the agent for
// something the docs never described. The README wraps the prompt over
// lines inside a code block, so the comparison is whitespace-insensitive.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { AGENT_THREADS_CLONE_PROMPT } = require('../src/loop-install');

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

const norm = (s) => s.replace(/\s+/g, ' ').trim();

console.log('loop-install');

test('the README carries the same prompt the dialog sends', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(norm(readme).includes(norm(AGENT_THREADS_CLONE_PROMPT)),
    'README.md no longer contains the agent-threads clone prompt verbatim');
});

test('the prompt names the repo, the folder, and the .gitignore rule', () => {
  assert.ok(AGENT_THREADS_CLONE_PROMPT.includes('https://github.com/albertwujj/agent-threads'));
  assert.ok(AGENT_THREADS_CLONE_PROMPT.includes('into ai/'));
  assert.ok(AGENT_THREADS_CLONE_PROMPT.includes('.gitignore'));
});

test('the prompt is one line, since it is pasted and submitted as one', () => {
  assert.ok(!/\n/.test(AGENT_THREADS_CLONE_PROMPT));
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
