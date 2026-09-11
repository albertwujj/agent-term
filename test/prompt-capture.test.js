// Tests for src/prompt-capture.js — pure JS state machine, runs in Node.

const assert = require('assert');
const { createPromptCapture } = require('../src/prompt-capture');

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

test('arrow key escape sequences are stripped', (cap, get) => {
  cap.notifyCliStarted();
  // Append-only: arrow-keys produce escape sequences which we strip; the
  // typed chars accumulate in input order regardless of caret position.
  cap.handleInput('abcdefghijklmnop\x1b[DX\r');     // 17 chars after escape strip, captured
  assert.strictEqual(get(), 'abcdefghijklmnopX');
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
