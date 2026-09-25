const assert = require('assert');
const { cleanAiTitle, aiTitleDedupeKey, isConversationTitle, aiCliLaunchCommand } = require('../src/ai-title');

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
      '✳ Claude Code · Debug failing build at CI pipeline · Debug failing build at CI pipeline',
      'claude'
    ),
    'Debug failing build at CI pipeline'
  );
});

test('spinner variants share one dedupe key', () => {
  assert.strictEqual(
    aiTitleDedupeKey('✳ Debug failing build at CI pipeline', 'claude'),
    aiTitleDedupeKey('* Debug failing build at CI pipeline', 'claude')
  );
  assert.strictEqual(
    aiTitleDedupeKey('⠦ Debug failing build at CI pipeline', 'claude'),
    aiTitleDedupeKey('Debug failing build at CI pipeline', 'claude')
  );
});

test('drops brand-only and agent-term status titles', () => {
  assert.strictEqual(cleanAiTitle('✳ Claude Code', 'claude'), '');
  assert.strictEqual(cleanAiTitle('⠦ agent-term', 'codex'), '');
});

test('keeps distinct title segments in order', () => {
  assert.strictEqual(
    cleanAiTitle('✳ Investigate CI failure · Check the patch', 'claude'),
    'Investigate CI failure · Check the patch'
  );
});

test('Cursor startup banners cannot become conversation titles', () => {
  assert.strictEqual(cleanAiTitle('Cursor Agent', 'agent'), '');
  assert.strictEqual(aiTitleDedupeKey('⠙ Cursor Agent', 'agent'), '');
  assert.strictEqual(isConversationTitle('Cursor Agent', 'agent'), false);
  assert.strictEqual(isConversationTitle('Root Cause Triage', 'agent'), true);
});

test('Codex accepts its named thread output, not project or unnamed-thread labels', () => {
  for (const title of ['agent-term-debug', '⠙ agent-term-debug', 'codex',
    'codex | 01a072c1-544f-7153-9da1-a39c29e6e9b9', 'codex | ']) {
    assert.strictEqual(isConversationTitle(title, 'codex'), false, title);
  }
  const title = 'codex | Investigate WSL launch failures';
  assert.strictEqual(isConversationTitle(title, 'codex'), true);
  assert.strictEqual(cleanAiTitle(title, 'codex'), 'Investigate WSL launch failures');
  assert.strictEqual(cleanAiTitle('codex | Investigate A | B', 'codex'), 'Investigate A | B');
});

test('Codex trailing spinner frames cannot turn a thread UUID into a name', () => {
  for (const frame of '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏') {
    assert.strictEqual(isConversationTitle(`codex | 01a0bacf-9f1a-7c22-926f-1a2db761b353 ${frame}`, 'codex'), false);
    const title = `codex | Check Codex GUID display ${frame}`;
    assert.strictEqual(isConversationTitle(title, 'codex'), true);
    assert.strictEqual(cleanAiTitle(title, 'codex'), 'Check Codex GUID display');
    assert.strictEqual(aiTitleDedupeKey(title, 'codex'), aiTitleDedupeKey('codex | Check Codex GUID display', 'codex'));
  }
  assert.strictEqual(cleanAiTitle('codex | Investigate A | B ⠸', 'codex'), 'Investigate A | B');
  assert.strictEqual(cleanAiTitle('codex | Explain ⠸ notation', 'codex'), 'Explain ⠸ notation');
});

test('Claude title cleanup and resumed topic acceptance stay unchanged', () => {
  assert.strictEqual(isConversationTitle('✳ Claude Code', 'claude'), false);
  assert.strictEqual(isConversationTitle('✳ Fix window titles', 'claude'), true);
  assert.strictEqual(isConversationTitle('agent-term-debug', 'claude'), true);
  assert.strictEqual(cleanAiTitle('Fix A | B', 'claude'), 'Fix A | B');
});

test('only Codex launches get inline rendering and the thread-title override', () => {
  const prefix = 'codex --no-alt-screen -c \'tui.terminal_title=["status","app-name","thread","spinner"]\'';
  assert.strictEqual(aiCliLaunchCommand('codex'), prefix);
  assert.strictEqual(aiCliLaunchCommand('codex --resume abc'), prefix + ' --resume abc');
  for (const command of ['claude', 'claude --resume abc', 'agent', 'copilot',
    'echo codex', 'codex-tools', 'cd /tmp && codex']) {
    assert.strictEqual(aiCliLaunchCommand(command), command);
  }
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
