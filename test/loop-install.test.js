// The clone prompt the terminal sends asks for the setup guide's own step.
//
// docs/setup.md's recommended setup clones each local component into ai/ and
// keeps ai/ out of .gitignore; the terminal, finding no agent-threads, asks the
// agent to do that step for agent-threads. If the two drift, the terminal asks
// the agent for something the docs never described.

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

test("the prompt asks for the setup guide's step: the same clone, into ai/, out of .gitignore", () => {
  const setup = fs.readFileSync(path.join(__dirname, '..', 'docs', 'setup.md'), 'utf8');
  const at = setup.indexOf('### Add the local components');
  assert.ok(at !== -1, 'docs/setup.md no longer has its "Add the local components" step');
  const step = norm(setup.slice(at, setup.indexOf('\n### ', at + 1)));
  const url = (AGENT_THREADS_CLONE_PROMPT.match(/^Clone (\S+) into ai\//) || [])[1];
  assert.ok(url, AGENT_THREADS_CLONE_PROMPT);
  assert.ok(step.includes(`git clone ${url} ai/${url.split('/').pop()}`),
    'the setup step no longer clones agent-threads into ai/ the way the prompt asks');
  assert.ok(/out of `\.gitignore`/.test(step), 'the setup step no longer keeps ai/ out of .gitignore');
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
