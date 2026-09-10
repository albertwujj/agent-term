const assert = require('assert');
const { detectCli, parseLaunch } = require('../src/cli-detect');

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

console.log('cli-detect');

test('a shell command names the CLI it starts, by its leading word', () => {
  assert.strictEqual(detectCli('claude'), 'claude');
  assert.strictEqual(detectCli('  codex --model gpt-5 '), 'codex');
  assert.strictEqual(detectCli('gh copilot suggest'), 'copilot');
  assert.strictEqual(detectCli('copilot'), 'copilot');
  assert.strictEqual(detectCli('cursor-agent'), 'agent');
  assert.strictEqual(detectCli('agent --resume'), 'agent');
});

test('a command that merely mentions a CLI is not its launch', () => {
  for (const cmd of ['echo codex', 'cd /tmp && codex', 'codex-tools', 'claudee', 'git status', '', null]) {
    assert.strictEqual(detectCli(cmd), null, JSON.stringify(cmd));
  }
});

test('the picker reads a name or a unique prefix as a launch, options carried', () => {
  assert.deepStrictEqual(parseLaunch('cl'), { cli: 'claude', command: 'claude', typed: 'cl', args: '' });
  assert.deepStrictEqual(parseLaunch('Codex'), { cli: 'codex', command: 'codex', typed: 'Codex', args: '' });
  assert.deepStrictEqual(parseLaunch('cl --resume'),
    { cli: 'claude', command: 'claude --resume', typed: 'cl', args: '--resume' });
  assert.deepStrictEqual(parseLaunch('codex  --model gpt-5 -a never '),
    { cli: 'codex', command: 'codex --model gpt-5 -a never', typed: 'codex', args: '--model gpt-5 -a never' });
});

test('an invocation the patterns know in full is a launch as typed', () => {
  assert.deepStrictEqual(parseLaunch('gh copilot'), { cli: 'copilot', command: 'gh copilot', typed: '', args: '' });
  assert.deepStrictEqual(parseLaunch('cursor-agent --x'), { cli: 'agent', command: 'cursor-agent --x', typed: '', args: '' });
});

test('an ambiguous prefix or a shell command is not a launch', () => {
  for (const text of ['c', 'co --model x', 'make test', 'cd ~/repo', 'echo claude', '', '   ']) {
    assert.strictEqual(parseLaunch(text), null, JSON.stringify(text));
  }
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
