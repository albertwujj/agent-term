// Tests for promptHoldsInput: real xterm cells, since the answer turns on the
// cursor, the dim and inverse attributes, and soft wraps. Each screen is the
// shape a live CLI drew inside AgentTerm, which differs from what it draws
// elsewhere (recorded 2026-10-30: claude 2.1.314, copilot 1.0.105, cursor-agent
// 2026.10.22). Which CLI runs at all is main's check, not this function's.

const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', {
  pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
});
global.window = dom.window;
global.document = dom.window.document;
global.self = dom.window;
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;

const { Terminal } = require('@xterm/xterm');
const { promptHoldsInput } = require('../src/prompt-completion');

const DIM = (text) => `\x1b[2m${text}\x1b[22m`;
const HIDE_CURSOR = '\x1b[?25l';
const COLS = 60;
const at = (row, col) => `\x1b[${row};${col}H`;

let passed = 0;
let failed = 0;

async function check(name, screen, expected) {
  const term = new Terminal({ cols: COLS, rows: 12, allowProposedApi: true });
  await new Promise((resolve) => term.write(screen, resolve));
  try {
    assert.strictEqual(promptHoldsInput(term), expected);
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
  term.dispose();
}

// The composer between its rules, its status line below, as claude draws it.
const claude = (rows, caret) => [
  'older output\r\n',
  `${'─'.repeat(COLS)}\r\n`,
  rows.join('\r\n'),
  '\r\n',
  `${'─'.repeat(COLS)}\r\n`,
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
  at(caret[0], caret[1]),
].join('');

(async () => {
  console.log('promptHoldsInput');

  await check('claude: empty, the placeholder follows the caret',
    claude([`❯\u00a0${DIM('Try "fix typecheck errors"')}`], [3, 3]), false);
  await check('claude: typed text',
    claude(['❯\u00a0hello'], [3, 8]), true);
  await check('claude: a trailing space still leaves text before the caret',
    claude(['❯\u00a0hello '], [3, 9]), true);
  await check('claude: caret home, nothing precedes it',
    claude(['❯\u00a0hello'], [3, 3]), false);
  await check('claude: an earlier To prompt left the caret on its own row',
    claude(['❯\u00a0[Pasted text #1 +11 lines]', '', '  '], [5, 3]), false);
  await check('claude: typed after that earlier To prompt',
    claude(['❯\u00a0[Pasted text #1 +11 lines]', '', '  world'], [5, 8]), true);
  await check('claude: a long line on its second row',
    claude(['❯\u00a0hello wrap wrap', '  wrap wrap'], [4, 12]), true);
  await check('claude: a prompt echoed above the empty composer is not its text',
    `❯\u00a0fix the bug\r\n\r\n● Done\r\n\r\n${claude([`❯\u00a0${DIM('Try something')}`], [7, 3])}`, false);

  // Copilot's composer rows open with a box edge and carry no marker at all.
  const copilot = (rows, caret) => [
    '\x1b[?1049h',
    '  ~/repo [main]\r\n',
    `${'▄'.repeat(COLS)}\r\n`,
    rows.join('\r\n'),
    '\r\n',
    `${'▀'.repeat(COLS)}\r\n`,
    ' Interactive · Manual Approval',
    at(caret[0], caret[1]),
  ].join('');
  await check('copilot: empty', copilot(['┃  '], [3, 3]), false);
  await check('copilot: typed text', copilot(['┃ hello typed'], [3, 14]), true);
  await check('copilot: an earlier To prompt left the caret on its own row',
    copilot(['┃ hello [Paste #1 - 12 lines]', '┃'], [4, 3]), false);
  await check('copilot: typed after that earlier To prompt',
    copilot(['┃ hello [Paste #1 - 12 lines]', '┃ more'], [4, 7]), true);

  await check('copilot unfocused: empty, the cursor hidden',
    `${HIDE_CURSOR}${copilot(['┃  '], [3, 3])}`, false);
  await check('copilot unfocused: typed text, the cursor hidden',
    `${HIDE_CURSOR}${copilot(['┃ hello typed'], [3, 14])}`, true);
  await check('copilot unfocused: an earlier To prompt left an empty last row',
    `${HIDE_CURSOR}${copilot(['┃ hello [Paste #1 - 12 lines]', '┃'], [4, 3])}`, false);

  // Cursor Agent parks a hidden cursor under its footer and draws a caret itself.
  const INV = (text) => `\x1b[7m${text}\x1b[27m`;
  const agent = (rows) => `${HIDE_CURSOR}\r\n\r\n${rows.join('\r\n')}\r\n\r\n${DIM('  ~/repo · main')}\r\n`;
  await check('cursor-agent focused: empty, the caret on the placeholder',
    agent([`  ${DIM('→ ')}${INV('P')}${DIM('lan, search, build anything')}`]), false);
  await check('cursor-agent focused: typed text',
    agent([`  → hello typed${INV(' ')}`]), true);
  await check('cursor-agent focused: caret home',
    agent([`  → ${INV('h')}ello typed`]), false);
  await check('cursor-agent focused: the scrolled composer, caret on its own row',
    agent(['  → BODY line 8', '    BODY line 9', '', `    ${INV(' ')}`]), false);
  await check('cursor-agent focused: typed on that row',
    agent(['  → BODY line 8', '    BODY line 9', '', `    more${INV(' ')}`]), true);
  await check('cursor-agent unfocused: empty, the placeholder is all dim',
    agent([DIM('  → Plan, search, build anything')]), false);
  await check('cursor-agent unfocused: typed text, no caret drawn',
    agent(['  → hello']), true);
  await check('a boxed composer unfocused: its right border is not text',
    `${HIDE_CURSOR}│ → ${DIM('Plan anything')}${' '.repeat(40)}│\r\n`, false);
  await check('a hidden cursor and no prompt row anywhere',
    `${HIDE_CURSOR}some output`, false);

  await check('a soft-wrapped row, caret at its very start',
    `> ${'x'.repeat(COLS - 2)}y\x1b[2;1H`, true);

  await check('nothing on screen', '', false);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
