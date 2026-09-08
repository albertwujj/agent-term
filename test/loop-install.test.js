// The clone prompt the terminal sends has the shape of the README's example.
//
// The README shows the reader how a loop is added (its example is another
// loop, since the terminal offers agent-threads on its own); the terminal
// sends the same words with agent-threads' URL. If the two drift, the
// terminal asks the agent for something the docs never described. The
// README wraps the prompt over lines inside a code block, so the
// comparison is whitespace-insensitive.

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

test("the README's example prompt has the same shape, after the URL", () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const shape = AGENT_THREADS_CLONE_PROMPT.replace(/^Clone \S+ /, '');
  assert.ok(shape.startsWith('into ai/'), shape);
  assert.ok(norm(readme).includes(norm(shape)),
    "README.md's example prompt no longer ends the way the terminal's does");
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
