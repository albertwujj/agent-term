// Tests for src/prompt-capture.js — pure JS state machine, runs in Node.

const assert = require('assert');
const { createPromptCapture } = require('../src/prompt-capture');
const { readPromptSnapshot } = require('../src/prompt-completion');
const { extractPathsAndUrls } = require('../src/icon-render');

const snapshot = (text, extra = [], { prefix = '  → ', row = 10, type = 'normal' } = {}) => ({
  type,
  lines: [{ row, text: prefix + text }, { row: row + 1, text: '' },
    ...extra.map((text, index) => ({ row: row + 2 + index, text }))],
});

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    const all = [];
    const shell = [];
    const cap = createPromptCapture({
      onPrompt: p => { all.push(p); },
      onShellCommand: c => { shell.push(c); },
    });
    const get = () => (all.length === 0 ? null : all[all.length - 1]);
    const getAll = () => all;
    fn(cap, get, () => shell, getAll);
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('prompt-capture');

test('typed CLI invocation before cliStarted is ignored', (cap, get) => {
  cap.handleInput('claude\r');
  assert.strictEqual(get(), null);
  assert.strictEqual(cap.isLocked(), false);
});

test('multiple shell commands before cliStarted are ignored', (cap, get) => {
  cap.handleInput('cd ~/projects/foo\r');
  cap.handleInput('ls -la\r');
  cap.handleInput('claude\r');
  assert.strictEqual(get(), null);
});

test('first long-enough Enter after cliStarted is captured', (cap, get) => {
  cap.handleInput('claude\r');                    // shell, ignored
  cap.notifyCliStarted();                          // CLI booted
  cap.handleInput('Fix the auth bug\r');           // 16 chars, captured
  assert.strictEqual(get(), 'Fix the auth bug');
  // Capture stays open — the machine keeps emitting follow-up prompts so the
  // thumbnail timeline stays current.
  assert.strictEqual(cap.isLocked(), false);
});

test('one-key and one-word answers are skipped, a short prompt is captured', (cap, get, _s, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('y\r');                          // 1 char, a dialog answer, skipped
  cap.handleInput('ok\r');                         // 2 chars, skipped
  cap.handleInput('yes\r');                        // 3 chars, skipped
  cap.handleInput('fix bug\r');                    // 7 chars: a prompt, and the first
  assert.deepStrictEqual(getAll(), ['fix bug']);
});

test('mention-picker Enter does not become the identity before the submitted URL', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('@pr-rev');
  cap.handleInput('\x1b[B\r');                     // choose the completion
  assert.deepStrictEqual(getAll(), []);
  const url = 'https://review.example/c/team/repo/+/10427036/2';
  cap.handleInput('\x1b[200~' + url + '\x1b[201~\r');
  assert.deepStrictEqual(getAll(), [url]);
});

test('bare mention queries are filtered by shape, without raising the prose length floor', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('  @long-workflow-query\r');
  cap.handleInput('generate more\r');
  cap.handleInput('@next-query\r');
  cap.handleInput('fix bug\r');
  assert.deepStrictEqual(getAll(), ['generate more', 'fix bug']);
});

test('explicit file mentions and prose containing mentions remain prompts', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  const prompts = ['@review.md', '@ai/review', '@./Makefile', '@.env', 'read @pr-rev', '@pr-rev explain this'];
  for (const prompt of prompts) cap.handleInput(prompt + '\r');
  assert.deepStrictEqual(getAll(), prompts);
});

test('a pasted bare mention is intentional prompt content', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('\x1b[200~@pr-rev\x1b[201~\r');
  cap.handleInput('next task\r');
  assert.deepStrictEqual(getAll(), ['@pr-rev', 'next task']);
});

test('a registered clipboard image is attachment metadata, not prompt text', () => {
  const seen = [];
  const imagePath = '/mnt/c/Users/me/AppData/Local/Temp/clipboard-123.png';
  const cap = createPromptCapture({
    classifyPaste: text => text === imagePath ? { kind: 'image', path: text } : null,
    onPrompt: (prompt, mentions, attachments) => seen.push({ prompt, mentions, attachments }),
  });
  cap.notifyCliStarted();
  cap.handleInput(`\x1b[200~${imagePath}\x1b[201~`);
  cap.handleInput('Review this layout\r');
  assert.deepStrictEqual(seen, [{
    prompt: 'Review this layout',
    mentions: null,
    attachments: [{ kind: 'image', path: imagePath }],
  }]);
});

test('a registered image is classified when the CLI has not enabled bracketed paste', () => {
  const seen = [];
  const imagePath = '/tmp/clipboard-raw.png';
  let pending = true;
  const cap = createPromptCapture({
    classifyPaste: text => pending && text === imagePath
      ? (pending = false, { kind: 'image', path: text }) : null,
    onPrompt: (prompt, _mentions, attachments) => seen.push({ prompt, attachments }),
  });
  cap.notifyCliStarted();
  cap.handleInput(imagePath);
  cap.handleInput('Review the raw paste\r');
  assert.deepStrictEqual(seen, [{
    prompt: 'Review the raw paste',
    attachments: [{ kind: 'image', path: imagePath }],
  }]);
});

test('ordinary pasted text remains semantic prompt text', () => {
  const seen = [];
  const cap = createPromptCapture({
    classifyPaste: () => null,
    onPrompt: (prompt, _mentions, attachments) => seen.push({ prompt, attachments }),
  });
  cap.notifyCliStarted();
  const url = 'https://review.example/c/repo/+/42';
  cap.handleInput(`\x1b[200~${url}\x1b[201~ review it\r`);
  assert.deepStrictEqual(seen, [{ prompt: url + ' review it', attachments: [] }]);
});

test('an image-only submission gets a short identity and keeps its attachment', () => {
  const seen = [];
  const imagePath = '/tmp/clipboard-456.png';
  const cap = createPromptCapture({
    classifyPaste: text => text === imagePath ? { kind: 'image', path: text } : null,
    onPrompt: (prompt, _mentions, attachments) => seen.push({ prompt, attachments }),
  });
  cap.notifyCliStarted();
  cap.handleInput(`\x1b[200~${imagePath}\x1b[201~\r`);
  assert.deepStrictEqual(seen, [{
    prompt: 'Image', attachments: [{ kind: 'image', path: imagePath }],
  }]);
});

test('backspace removes an image attachment before a replacement prompt', () => {
  const seen = [];
  const imagePath = '/tmp/clipboard-789.png';
  const cap = createPromptCapture({
    classifyPaste: text => text === imagePath ? { kind: 'image', path: text } : null,
    onPrompt: (prompt, _mentions, attachments) => seen.push({ prompt, attachments }),
  });
  cap.notifyCliStarted();
  cap.handleInput(`\x1b[200~${imagePath}\x1b[201~`);
  cap.handleInput('\x7f');
  cap.handleInput('Use the replacement prompt\r');
  assert.deepStrictEqual(seen, [{ prompt: 'Use the replacement prompt', attachments: [] }]);
});

test('an image before an @ completion stays separate from the recovered reference', () => {
  const seen = [];
  const imagePath = '/tmp/clipboard-987.png';
  const cap = createPromptCapture({
    classifyPaste: text => text === imagePath ? { kind: 'image', path: text } : null,
    onPrompt: (prompt, _mentions, attachments) => seen.push({ prompt, attachments }),
  });
  cap.notifyCliStarted();
  cap.handleInput(`\x1b[200~${imagePath}\x1b[201~`);
  cap.handleInput('@guide');
  cap.handleInput('\r', snapshot('[Image #1] @guide'));
  cap.handleInput('compare this');
  cap.handleInput('\r', snapshot('[Image #1] @docs/guide.md compare this'));
  assert.deepStrictEqual(seen, [{
    prompt: '@docs/guide.md compare this',
    attachments: [{ kind: 'image', path: imagePath }],
  }]);
});

test('selected filename is recovered only into the submitted prompt, excluding suggestions', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('@pr-rev');
  cap.handleInput('\r', snapshot('@pr-rev', ['   → pr-review.md  ai/gerrit', '     produce-review.md  ai/tasks']));
  assert.deepStrictEqual(getAll(), []);
  const url = 'https://review.example/c/team/repo/+/10427036/2';
  cap.handleInput('\x1b[200~' + url + '\x1b[201~');
  cap.handleInput('\r', snapshot('@ai/gerrit/pr-review.md ' + url));
  assert.deepStrictEqual(getAll(), ['@ai/gerrit/pr-review.md ' + url]);
  assert.deepStrictEqual(extractPathsAndUrls(getAll()[0]).refs, [
    { kind: 'url', full: url }, { kind: 'mention', full: '@ai/gerrit/pr-review.md' },
  ]);
});

test('a mention-only prompt is recorded on the second Enter after its selected path appears', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('@pr-rev');
  cap.handleInput('\r', snapshot('@pr-rev'));
  cap.handleInput('\r', snapshot('@ai/gerrit/pr-review.md'));
  assert.deepStrictEqual(getAll(), ['@ai/gerrit/pr-review.md']);
});

test('Tab completion can recover a path inside prose without altering the rest of a paste', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('read @pr-rev');
  cap.handleInput('\t', snapshot('read @pr-rev'));
  cap.handleInput('\x1b[200~then explain\n  the risks\x1b[201~');
  cap.handleInput('\r', snapshot('read @ai/gerrit/pr-review.md then explain'));
  assert.deepStrictEqual(getAll(), ['read @ai/gerrit/pr-review.md then explain\n  the risks']);
});

test('Tab then Enter records a completed extensionless filename', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('@make');
  cap.handleInput('\t', snapshot('@make'));
  cap.handleInput('\r', snapshot('@Makefile'));
  assert.deepStrictEqual(getAll(), ['@Makefile']);
});

// The reported case: a Tab accepted the completion, but by the submission the
// composer had moved a row, so nothing on screen could name the path. The
// query the Tab handed over used to reach the log fused to the next word
// ("@pr-reviereview this file only").
test('a Tab completion the screen cannot confirm drops its query instead of fusing it', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('@pr-revie');
  cap.handleInput('\t', snapshot('@pr-revie'));
  cap.handleInput('review this file only');
  cap.handleInput('\r', snapshot('@ai/gerrit/pr-review.md review this file only', [], { row: 12 }));
  assert.deepStrictEqual(getAll(), ['review this file only']);
});

test('a Tab taken with no snapshot to sample drops its query too', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('read @pr-rev');
  cap.handleInput('\t');                           // a queued redraw: no snapshot
  cap.handleInput('then explain the risks');
  cap.handleInput('\r');
  assert.deepStrictEqual(getAll(), ['read then explain the risks']);
});

test('a Tab that completed nothing keeps the bytes the composer still shows', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('@pr-rev');
  cap.handleInput('\t', snapshot('@pr-rev'));      // nothing matched; the line is unchanged
  cap.handleInput('iew.md and the diff');
  cap.handleInput('\r', snapshot('@pr-review.md and the diff'));
  assert.deepStrictEqual(getAll(), ['@pr-review.md and the diff']);
});

test('what became of a Tab query is reported with the prompt', () => {
  const seen = [];
  const cap = createPromptCapture({ onPrompt: (p, mentions) => seen.push([p, mentions]) });
  cap.notifyCliStarted();
  cap.handleInput('@pr-rev');
  cap.handleInput('\t', snapshot('@pr-rev'));
  cap.handleInput('read this');
  cap.handleInput('\r', snapshot('@ai/pr-review.md read this'));
  cap.handleInput('@guide');
  cap.handleInput('\t', snapshot('@guide'));
  cap.handleInput('and this');
  cap.handleInput('\r', snapshot('@docs/guide.md and this', [], { row: 12 }));
  cap.handleInput('plain follow-up\r');
  assert.deepStrictEqual(seen, [
    ['@ai/pr-review.md read this', { recovered: true, dropped: [] }],
    ['and this', { recovered: false, dropped: ['@guide'] }],
    ['plain follow-up', null],
  ]);
});

test('two Enter-selected references stay in the same prompt', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('@pr-rev');
  cap.handleInput('\r', snapshot('@pr-rev'));
  cap.handleInput('@guide');
  cap.handleInput('\r', snapshot('@ai/pr-review.md @guide'));
  assert.deepStrictEqual(getAll(), []);
  cap.handleInput('compare them');
  cap.handleInput('\r', snapshot('@ai/pr-review.md @docs/guide.md compare them'));
  assert.deepStrictEqual(getAll(), ['@ai/pr-review.md @docs/guide.md compare them']);
});

test('recovery works for different prompt gutters and buffers without a CLI type', (_cap, _get) => {
  for (const prefix of ['> ', '  › ', '❯ ', '│ > ']) {
    for (const type of ['normal', 'alternate']) {
      const all = [];
      const cap = createPromptCapture({ onPrompt: p => all.push(p) });
      cap.notifyCliStarted();
      cap.handleInput('@guide');
      cap.handleInput('\r', snapshot('@guide', [], { prefix, type }));
      cap.handleInput('read this');
      cap.handleInput('\r', snapshot('@docs/guide.md read this', [], { prefix, type }));
      assert.deepStrictEqual(all, ['@docs/guide.md read this']);
    }
  }
});

test('files in output, another row, an unrelated prompt, or a menu never enrich a prompt', () => {
  for (const final of [
    snapshot('read this', ['  Read @ai/pr-review.md']),
    snapshot('@ai/pr-review.md read this', [], { row: 11 }),
    snapshot('@ai/pr-review.md unrelated text'),
    snapshot('@ai/other.md read this'),
    snapshot('@pr-rev', ['  → @ai/pr-review.md read this']),
    snapshot('@ai/pr-review.md read this', [], { type: 'alternate' }),
  ]) {
    const all = [];
    const cap = createPromptCapture({ onPrompt: p => all.push(p) });
    cap.notifyCliStarted();
    cap.handleInput('@pr-rev');
    cap.handleInput('\r', snapshot('@pr-rev'));
    cap.handleInput('read this');
    cap.handleInput('\r', final);
    assert.deepStrictEqual(all, ['read this']);
  }
});

test('ambiguous query rows cannot establish a completion anchor', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('@pr-rev');
  cap.handleInput('\r', snapshot('@pr-rev', ['  → @pr-rev']));
  cap.handleInput('read this');
  cap.handleInput('\r', snapshot('@ai/pr-review.md read this'));
  assert.deepStrictEqual(getAll(), ['read this']);
});

test('edits, cursor movement, and cancellation discard completion evidence', () => {
  for (const key of ['\x7f', '\x17', '\x15', '\x03', '\x1b', '\x1b[D', '\x1b[3~', '\x01', '\x12']) {
    const all = [];
    const cap = createPromptCapture({ onPrompt: p => all.push(p) });
    cap.notifyCliStarted();
    cap.handleInput('@pr-rev');
    cap.handleInput('\r', snapshot('@pr-rev'));
    cap.handleInput(key);
    cap.handleInput('read this');
    cap.handleInput('\r', snapshot('@ai/pr-review.md read this'));
    assert.deepStrictEqual(all, ['read this']);
  }
});

test('CRLF completion acceptance counts as one Enter', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('@pr-rev');
  cap.handleInput('\r\n', snapshot('@pr-rev'));
  cap.handleInput('read this');
  cap.handleInput('\r\n', snapshot('@ai/pr-review.md read this'));
  assert.deepStrictEqual(getAll(), ['@ai/pr-review.md read this']);
});

test('a hard-wrapped partial filename is not recovered', (cap, _get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('@pr-rev');
  cap.handleInput('\r', snapshot('@pr-rev'));
  cap.handleInput('read this');
  const wrapped = snapshot('@ai/pr-review.m');
  wrapped.lines[1].text = '    d read this';
  cap.handleInput('\r', wrapped);
  assert.deepStrictEqual(getAll(), ['read this']);
});

test('renderer snapshot rejoins soft wraps and reads only the live viewport', () => {
  const data = [
    ['old scrollback', false], ['> @docs/guide.md ', false], ['read this', true], ['', false],
  ];
  const terminal = { rows: 3, buffer: { active: {
    type: 'normal', baseY: 1, length: data.length,
    getLine: row => data[row] && {
      isWrapped: data[row][1],
      translateToString: trim => trim ? data[row][0].trimEnd() : data[row][0],
    },
  } } };
  assert.deepStrictEqual(readPromptSnapshot(terminal), {
    type: 'normal', lines: [{ row: 1, text: '> @docs/guide.md read this' }, { row: 3, text: '' }],
  });
});

test('selector type-filter ("old proj") is the pick, not a prompt', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('/resume\r');                    // skipped (slash), opens the dialog
  cap.handleInput('old proj\r');                   // typed in the selector filter, Enter picks: skipped
  cap.handleInput('Continue with the refactor\r'); // captured
  assert.strictEqual(get(), 'Continue with the refactor');
});

// The reported case: a manual /resume, a filter, the pick, then a first
// prompt of 13 characters. The old 15-char floor dropped it and the session
// took the prompt after it as its identity.
test('a short first prompt after the resume pick is the identity', (cap, get, _s, getAll) => {
  cap.handleInput('claude\r');
  cap.notifyCliStarted();
  cap.handleInput('/resume\r');
  cap.handleInput('stuck\r');                      // filter + pick
  cap.handleInput('generate more\r');              // 13 chars, the first prompt
  cap.handleInput('also, stories site is down. check and bring it up\r');
  assert.deepStrictEqual(getAll(), ['generate more', 'also, stories site is down. check and bring it up']);
});

test('a long filter typed in the resume dialog is still the pick, not a prompt', (cap, get, _s, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('/resume\r');
  cap.handleInput('check if process is stuck\r');  // 25 chars, but it is the pick
  cap.handleInput('generate more\r');
  assert.deepStrictEqual(getAll(), ['generate more']);
});

test('/resume with arguments opens the dialog too', (cap, get, _s, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('/resume stuck\r');
  cap.handleInput('\x1b[B\r');                     // arrow to it, pick
  cap.handleInput('generate more\r');
  assert.deepStrictEqual(getAll(), ['generate more']);
});

test('Esc closes the resume dialog: the next Enter is a prompt again', (cap, get, _s, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('/resume\r');
  cap.handleInput('\x1b');                          // bare Esc, dialog closed
  cap.handleInput('generate more\r');
  assert.deepStrictEqual(getAll(), ['generate more']);
});

test('Ctrl+C closes the resume dialog: the next Enter is a prompt again', (cap, get, _s, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('/resume\r');
  cap.handleInput('stu\x03');                       // half a filter, then Ctrl+C
  cap.handleInput('generate more\r');
  assert.deepStrictEqual(getAll(), ['generate more']);
});

test('arrow keys in the resume dialog do not close it', (cap, get, _s, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('/resume\r');
  cap.handleInput('\x1b[B');
  cap.handleInput('\x1b[B');
  cap.handleInput('old proj\r');                   // still the pick
  cap.handleInput('generate more\r');
  assert.deepStrictEqual(getAll(), ['generate more']);
});

test('the Enter after an inline slash command is a prompt, even a short one', (cap, get, _s, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('/clear\r');
  cap.handleInput('generate more\r');
  assert.deepStrictEqual(getAll(), ['generate more']);
});

test('a resume dialog opened before cliStarted is not tracked', (cap, get, _s, getAll) => {
  cap.handleInput('/resume\r');                    // a shell command, whatever it is
  cap.notifyCliStarted();
  cap.handleInput('generate more\r');
  assert.deepStrictEqual(getAll(), ['generate more']);
});

test('empty Enter after cliStarted is skipped, next prompt captured', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('\r');                       // banner dismiss, empty
  cap.handleInput('Update the README docs\r'); // 22 chars, captured
  assert.strictEqual(get(), 'Update the README docs');
});

test('backspace edits buffer correctly', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('Frx\b\bix the auth bug\r');     // 16 chars after edits, captured
  assert.strictEqual(get(), 'Fix the auth bug');
});

test('subsequent prompts are also captured (timeline mode)', (cap, get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('Investigate the timeout\r');    // first, captured
  cap.handleInput('Now do something else here\r'); // follow-up, also captured
  cap.handleInput('And another long enough one\r');
  assert.deepStrictEqual(getAll(), [
    'Investigate the timeout',
    'Now do something else here',
    'And another long enough one',
  ]);
  assert.strictEqual(get(), 'And another long enough one');
});

test('markLocked stops further capture', (cap, get, _shell, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('Investigate the timeout issue\r');
  cap.markLocked();
  cap.handleInput('This should be ignored entirely\r');
  assert.deepStrictEqual(getAll(), ['Investigate the timeout issue']);
  assert.strictEqual(cap.isLocked(), true);
});

test('bracketed paste is captured on Enter, even before cliStarted', (cap, get) => {
  // Paste before cliStarted primes the buffer; once the CLI starts and the
  // user submits, the pasted prompt is captured. (Realistic flow: paste
  // arrives during the CLI's banner / loading screen, user presses Enter
  // once the input prompt is ready.)
  cap.handleInput('\x1b[200~Please refactor the auth module\x1b[201~');
  cap.notifyCliStarted();
  cap.handleInput('\r');
  assert.strictEqual(get(), 'Please refactor the auth module');
});

test('bracketed paste preserves multi-line content on Enter', (cap, get) => {
  cap.notifyCliStarted();
  const pasted = 'Line 1\nLine 2\nLine 3';
  cap.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  cap.handleInput('\r');
  assert.strictEqual(get(), pasted);
});

test('bracketed paste with empty content is ignored', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('\x1b[200~\x1b[201~');
  cap.handleInput('Real prompt content\r');     // 19 chars, captured
  assert.strictEqual(get(), 'Real prompt content');
});

test('bracketed paste split across chunks, captured on Enter', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('\x1b[200~Hello ');
  cap.handleInput('world!\x1b[201~');
  cap.handleInput('\r');
  assert.strictEqual(get(), 'Hello world!');
});

test('typed prefix is preserved when paste follows', (cap, get) => {
  // Real-world bug: user types "Investigate " then pastes a URL.
  // The captured prompt must include both.
  cap.notifyCliStarted();
  cap.handleInput('Investigate ');
  cap.handleInput('\x1b[200~https://example.com/issues/42\x1b[201~');
  cap.handleInput('\r');
  assert.strictEqual(get(), 'Investigate https://example.com/issues/42');
});

test('typed prefix + paste + continued typing all captured on Enter', (cap, get) => {
  // Paste primes the buffer; subsequent typing extends it; Enter submits.
  // (Used to be auto-emit-on-paste, which dropped anything typed after.)
  cap.notifyCliStarted();
  cap.handleInput('Look at ');
  cap.handleInput('\x1b[200~this issue\x1b[201~');
  cap.handleInput(' please\r');
  assert.strictEqual(get(), 'Look at this issue please');
});

test('erase-after-paste then retype reflects the final buffer', (cap, get) => {
  // The motivating bug: user pastes one thing, erases it, types a new
  // prompt. Old behavior auto-emitted the paste before the erase — old
  // content appeared in the timeline, new content was lost. Now: nothing
  // is captured until Enter, so the visible buffer wins.
  cap.notifyCliStarted();
  cap.handleInput('\x1b[200~old pasted prompt\x1b[201~');
  // 17 backspaces wipes the paste
  cap.handleInput('\b'.repeat(17));
  cap.handleInput('actually use this longer prompt\r');
  assert.strictEqual(get(), 'actually use this longer prompt');
});

test('Ctrl+U clears the buffer (paste then Cmd+Backspace then retype)', (cap, get) => {
  // macOS Cmd+Backspace maps to Ctrl+U (0x15) in most line editors —
  // covers the "user wiped the line and started over" case.
  cap.notifyCliStarted();
  cap.handleInput('\x1b[200~stale paste content\x1b[201~');
  cap.handleInput('\x15');                                 // Ctrl+U
  cap.handleInput('the real prompt I meant to send\r');
  assert.strictEqual(get(), 'the real prompt I meant to send');
});

test('Ctrl+W deletes the trailing word (preceding space kept, matching bash/zsh)', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('Investigate the wrong\x17timeout issue please\r');
  assert.strictEqual(get(), 'Investigate the timeout issue please');
});

test('inserting a prefix after a CLI resume preserves the submitted order', (cap, _get, _shell, getAll) => {
  cap.handleInput('codex\r');
  cap.notifyCliStarted();
  cap.handleInput('/resume\r');
  cap.handleInput('Fix xterm npm vulnerability\r');
  cap.handleInput('push using github data api');
  cap.handleInput('\x01');                         // Ctrl+A: back to the start
  cap.handleInput('commit and \r');
  cap.handleInput('check the result\r');
  assert.deepStrictEqual(getAll(), ['commit and push using github data api', 'check the result']);
});

test('left arrow inserts at the caret', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('abcdefghijklmnop\x1b[DX\r');
  assert.strictEqual(get(), 'abcdefghijklmnoXp');
});

test('Home/End variants preserve typed and pasted edits', () => {
  for (const [home, end] of [['\x1b[H', '\x1b[F'], ['\x1bOH', '\x1bOF'],
    ['\x1b[1~', '\x1b[4~'], ['\x1b[7~', '\x1b[8~'], ['\x01', '\x05']]) {
    const prompts = [];
    const cap = createPromptCapture({ onPrompt: p => prompts.push(p) });
    cap.notifyCliStarted();
    cap.handleInput('push using github data api' + home);
    cap.handleInput('\x1b[200~commit and \x1b[201~');
    cap.handleInput(end + ' please\r');
    assert.deepStrictEqual(prompts, ['commit and push using github data api please']);
  }
});

test('backspace and forward delete edit at the caret', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('fix teh bug\x1b[5D\x7f\x1b[3~he\r');
  assert.strictEqual(get(), 'fix the bug');
});

test('Ctrl+B/F/D and application arrows edit at the caret', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('fix tXhe bug\x01\x1b[6C\x02\x06\x1bOD\x04\x1bOC');
  cap.handleInput('\x05 now\r');
  assert.strictEqual(get(), 'fix the bug now');
});

test('word navigation keeps insertions in place', () => {
  for (const [back, forward] of [['\x1bb', '\x1bf'], ['\x1b[1;5D', '\x1b[1;5C'],
    ['\x1b[1;3D', '\x1b[1;3C']]) {
    const prompts = [];
    const cap = createPromptCapture({ onPrompt: p => prompts.push(p) });
    cap.notifyCliStarted();
    cap.handleInput('fix bug' + back + 'the ' + forward + ' now\r');
    assert.deepStrictEqual(prompts, ['fix the bug now']);
  }
});

test('Ctrl+W, Ctrl+U, and Ctrl+K preserve text on the other side of the caret', (cap, _get, _s, getAll) => {
  cap.notifyCliStarted();
  cap.handleInput('fix wrong bug\x1b[4D\x17the\r');
  cap.handleInput('wrong suffix\x01\x1b[6C\x15correct \r');
  cap.handleInput('keep this wrong\x1b[5D\x0bcorrect\r');
  assert.deepStrictEqual(getAll(), ['fix the bug', 'correct suffix', 'keep this correct']);
});

test('navigation and erases keep Unicode characters intact', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('fix 😀 bug\x1b[5D\x1b[C\x7f🚀\r');
  assert.strictEqual(get(), 'fix 🚀 bug');
});

test('Home and End address the current line in a multiline paste', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('\x1b[200~first line\nsecond line\x1b[201~');
  cap.handleInput('\x1b[Hnew \x1b[F end\r');
  assert.strictEqual(get(), 'first line\nnew second line end');
});

test('caret movement is clamped at the buffer edges and reset after cancellation', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('old prompt\x1b[99D\x03');
  cap.handleInput('real prompt\x1b[99D\x1b[99C here\r');
  assert.strictEqual(get(), 'real prompt here');
});

test('OSC sequences embedded in input are stripped', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('Fix \x1b]0;some-title\x07the auth bug\r');
  assert.strictEqual(get(), 'Fix the auth bug');
});

test('tab characters are dropped from buffer', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('Fix\tthe auth bug now\r');
  assert.strictEqual(get(), 'Fixthe auth bug now');
});

test('non-ASCII printable characters are kept', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('Café — résumé du week-end\r');
  assert.strictEqual(get(), 'Café — résumé du week-end');
});

test('shell command longer than 20 chars before cliStarted still ignored', (cap, get) => {
  // This is the case the OSC-title gate fixes vs a naive char-threshold approach.
  cap.handleInput('git log --oneline --all -20 | grep deploy\r');
  assert.strictEqual(get(), null);
});

test('input received before notifyCliStarted, Enter after, ignored', (cap, get) => {
  cap.handleInput('partial input');
  cap.handleInput('\r');
  assert.strictEqual(get(), null);
});

test('input typed before cliStarted lingers and counts on next Enter', (cap, get) => {
  // Consequence of the design: the buffer doesn't reset when cliStarted flips,
  // so a half-typed line that straddles the gate becomes part of the prompt.
  // In practice the user finishes typing `claude\r` before the CLI flips the
  // gate, so this rarely matters, but we document it here.
  cap.handleInput('partial input');             // 13 chars
  cap.notifyCliStarted();
  cap.handleInput(' rest of prompt\r');         // total 28 chars after merge, captured
  assert.strictEqual(get(), 'partial input rest of prompt');
});

// --- Slash-command skip (resume/help/clear/etc.) ---

test('/resume after cliStarted is skipped without locking', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('/resume\r');
  assert.strictEqual(get(), null);
  assert.strictEqual(cap.isLocked(), false);
});

test('/resume then real prompt: real prompt captured', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('/resume\r');
  // user arrow-key-navigates the selector, presses Enter on a session
  cap.handleInput('\x1b[B\x1b[B\r');               // down, down, Enter — stripped/skipped
  cap.handleInput('Continue the refactor work\r'); // 25 chars, captured
  assert.strictEqual(get(), 'Continue the refactor work');
});

test('multiple slash commands in a row, then real prompt', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('/clear\r');
  cap.handleInput('/help\r');
  cap.handleInput('/cost\r');
  cap.handleInput('Now the actual real prompt\r');
  assert.strictEqual(get(), 'Now the actual real prompt');
});

test('whitespace before slash still detected as command', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('  /resume\r');
  assert.strictEqual(cap._state().inResumeDialog, true);   // recognised as /resume: the dialog is open
  cap.handleInput('\r');                                   // the pick
  cap.handleInput('Real prompt content here\r');           // captured
  assert.strictEqual(get(), 'Real prompt content here');
});

test('paste of slash-prefixed text is captured on Enter (bypasses slash filter)', (cap, get) => {
  cap.notifyCliStarted();
  // Pasted content that happens to start with "/" is still intentional
  // prompt material, so the hadPaste flag bypasses the slash-command filter.
  cap.handleInput('\x1b[200~/resume needs to be documented\x1b[201~');
  cap.handleInput('\r');
  assert.strictEqual(get(), '/resume needs to be documented');
});

test('short paste captured on Enter (paste bypasses length threshold)', (cap, get) => {
  cap.notifyCliStarted();
  cap.handleInput('\x1b[200~hi\x1b[201~');         // 2-char paste
  cap.handleInput('\r');
  assert.strictEqual(get(), 'hi');
});

// --- Shell command emission (used by main.js to detect CLI invocation) ---

test('shell commands typed before cliStarted are emitted via onShellCommand', (cap, _get, getShell) => {
  cap.handleInput('cd ~/projects/foo\r');
  cap.handleInput('claude\r');
  assert.deepStrictEqual(getShell(), ['cd ~/projects/foo', 'claude']);
});

test('shell command emission stops once cliStarted', (cap, _get, getShell) => {
  cap.handleInput('claude\r');
  cap.notifyCliStarted();
  cap.handleInput('First long enough prompt now\r');
  assert.deepStrictEqual(getShell(), ['claude']);   // post-cliStarted Enter is a prompt, not a shell cmd
});

test('empty Enter pre-cliStarted does not emit shell command', (cap, _get, getShell) => {
  cap.handleInput('\r');
  cap.handleInput('   \r');                          // whitespace-only
  cap.handleInput('claude\r');
  assert.deepStrictEqual(getShell(), ['claude']);
});

test('a launch line fed as keystrokes is reported whole, with options typed after it', (cap, _get, getShell) => {
  // main types the picker's launch line through handleInput (writeTyped),
  // so the user's Enter reports the line plus what they added.
  cap.handleInput('codex -c \'tui.terminal_title=["app-name","thread"]\' ');
  cap.handleInput('--model gpt-5\r');
  assert.deepStrictEqual(getShell(), ['codex -c \'tui.terminal_title=["app-name","thread"]\' --model gpt-5']);
});

test('Ctrl+C abandons the line, so a cancelled launch line is not read at the next Enter', (cap, _get, getShell) => {
  cap.handleInput('codex -c \'tui.terminal_title=["app-name","thread"]\' ');
  cap.handleInput('\x03');                          // Ctrl+C
  cap.handleInput('ls\r');
  assert.deepStrictEqual(getShell(), ['ls']);
  assert.strictEqual(cap._state().buf, '');
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
