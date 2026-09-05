// End-to-end regression test for select-to-comment under a mouse-captured
// alt-screen TUI (the copilot CLI shape: DECSET 1049 + 1003/1006). Two xterm
// behaviors conspire there: mouse reports count as user input, and xterm clears
// the local selection on ANY user input — so the selection behind an armed
// "Type to comment" pill vanished on the next reported mouse move, and typing
// fell through to the CLI. The pill now works off a snapshot taken while the
// selection is real, with a decoration standing in for the cleared selection.
//
// Covers:
//   1. shift+drag over a mouse-captured alt screen arms the pill.
//   2. a plain mouse move (reported to the app, selection cleared) leaves the
//      pill armed and puts up the stand-in highlight.
//   3. typing then opens the composer seeded with the key.
//   4. a plain click dismisses the armed pill (the explicit dismissal gesture,
//      since the report-clear no longer disarms).
//   5. OSC 52 from the TUI (its own "copy" action) lands on the host clipboard.
//   6. a plain drag never freezes while the app owns the mouse — the gesture is
//      the app's, and no local selection can come of it.
//   7. Cmd/Ctrl+C with the live selection already cleared copies the armed
//      snapshot (and disarms) instead of falling through to the shell — on
//      the platforms that bind a copy shortcut at all, so macOS and Windows.
//
// Run: npm run test:e2e   (builds the renderer first, then this)

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', APP_DIR],
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await sleep(1200); // let the shell print its first prompt
  if (await page.evaluate(() => !!document.querySelector('.at-picker-overlay'))) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }

  const focusTerm = () => page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    if (ta) ta.focus();
  });
  const pillShown = () => page.evaluate(() => !!document.querySelector('.terminal-comment-selection-hint'));
  const bubbleShown = () => page.evaluate(() => !!document.querySelector('.terminal-comment-bubble'));
  // The comment mark. While a selection is live it tracks the selection; once
  // the mouse report clears the selection, the only thing that can still be
  // painting it is the armed snapshot — so a mark on screen after the report
  // proves the snapshot took over.
  const standInShown = () => page.evaluate(() => (
    document.querySelectorAll('.terminal-comment-mark').length > 0
  ));

  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('')); // so the OSC 52 check can't pass on stale contents
    // Enter a copilot-shaped TUI: alt screen, any-motion mouse capture, SGR
    // encoding, an OSC 52 copy at startup, and a spinner rewriting row 1 every
    // 200ms so output stays "live" (the freeze paths are armed). -echo keeps the
    // reports the "app" receives from echoing back as junk output.
    await focusTerm();
    await page.keyboard.type(
      "stty -echo; printf '\\033[?1049h\\033[2J\\033[H\\033[?1003h\\033[?1006h'; "
      + "printf '\\033]52;c;%s\\007' \"$(printf 'osc52 payload' | base64)\"; printf '\\033[2H'; "
      + "for i in 1 2 3 4 5 6; do printf 'line %d: the quick brown fox jumps over the lazy dog\\r\\n' $i; done; "
      + 'i=0; while true; do i=$((i+1)); printf \'\\033[H\\033[2Kworking tick %d\' $i; sleep 0.2; done',
    );
    await page.keyboard.press('Enter');
    await sleep(900);

    console.log('5 — OSC 52 from the TUI reaches the host clipboard');
    check('clipboard holds the OSC 52 payload', await app.evaluate(({ clipboard }) => clipboard.readText()) === 'osc52 payload');

    console.log('6 — a plain drag never freezes while the app owns the mouse');
    const r0 = await page.evaluate(() => {
      const b = document.querySelector('.xterm-screen').getBoundingClientRect();
      return { left: b.left, top: b.top };
    });
    await page.mouse.move(Math.round(r0.left + 40), Math.round(r0.top + 45));
    await page.mouse.down();
    await page.mouse.move(Math.round(r0.left + 300), Math.round(r0.top + 45), { steps: 6 });
    await page.mouse.up();
    await sleep(450); // past the hold threshold — a leaked hold timer would freeze
    check('no freeze pill after a plain drag', await page.evaluate(() => !document.querySelector('.terminal-output-frozen-pill')));
    check('no selection pill either (the drag was the app’s)', !(await pillShown()));

    console.log('1 — shift+drag over a mouse-captured alt screen arms the pill');
    const r = await page.evaluate(() => {
      const b = document.querySelector('.xterm-screen').getBoundingClientRect();
      return { left: b.left, top: b.top, width: b.width, height: b.height };
    });
    const y = Math.round(r.top + 45); // ~line 3 of the printed text
    await page.keyboard.down('Shift');
    await page.mouse.move(Math.round(r.left + 40), y);
    await page.mouse.down();
    await page.mouse.move(Math.round(r.left + 300), y, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForSelector('.terminal-comment-selection-hint', { timeout: 3_000 }).catch(() => {});
    check('pill appears after shift+drag', await pillShown());

    console.log('2 — a reported mouse move clears the selection but not the pill');
    await page.mouse.move(Math.round(r.left + 120), Math.round(r.top + 100), { steps: 4 });
    await page.mouse.move(Math.round(r.left + 200), Math.round(r.top + 60), { steps: 4 });
    await sleep(300);
    check('pill survives the mouse move', await pillShown());
    check('stand-in highlight marks the cleared selection', await standInShown());

    // Which key copies is a per-platform question, because in a terminal
    // Ctrl+C is already SIGINT. macOS has a spare modifier, so copy is Cmd+C
    // and Ctrl+C is left alone. Windows has no such modifier and follows the
    // console rule instead: Ctrl+C copies only while something is selected,
    // otherwise it interrupts. Linux terminals settled the same clash the
    // third way, moving copy to Ctrl+Shift+C, so the app binds nothing for
    // bare Ctrl+C there — see the platform branches in terminal-keyboard.js.
    // AgentTerm ships macOS and Windows; run from inside WSL this is a linux
    // Electron, where there is no shortcut to exercise.
    const copyKey = process.platform === 'darwin' ? 'Meta+KeyC'
      : process.platform === 'win32' ? 'Control+KeyC'
      : null;
    console.log('7 — Cmd/Ctrl+C copies the armed snapshot once the live selection is gone');
    if (!copyKey) {
      console.log(`  — skipped: no copy shortcut is bound on ${process.platform}`);
    } else {
      await focusTerm();
      await page.keyboard.press(copyKey);
      await sleep(300);
      const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
      check('clipboard holds the selected text', copied.trim().length > 3
        && 'line N: the quick brown fox jumps over the lazy dog'.includes(copied.trim().replace(/\d+/g, 'N')));
      await page.waitForFunction(() => !document.querySelector('.terminal-comment-selection-hint'), { timeout: 3_000 }).catch(() => {});
      check('copying disarms the pill', !(await pillShown()));
    }

    // Re-arm for the typing flow.
    await page.keyboard.down('Shift');
    await page.mouse.move(Math.round(r.left + 40), y);
    await page.mouse.down();
    await page.mouse.move(Math.round(r.left + 300), y, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForSelector('.terminal-comment-selection-hint', { timeout: 3_000 }).catch(() => {});

    console.log('3 — typing opens the composer seeded with the key');
    await focusTerm();
    await page.keyboard.type('x');
    await page.waitForSelector('.terminal-comment-bubble', { timeout: 3_000 }).catch(() => {});
    check('composer opens', await bubbleShown());
    check('composer is seeded with the typed char', await page.evaluate(() => (
      document.querySelector('.terminal-comment-bubble textarea')?.value === 'x'
    )));
    await page.evaluate(() => {
      const el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => !document.querySelector('.terminal-comment-bubble'), { timeout: 3_000 }).catch(() => {});
    check('Esc closes the composer', !(await bubbleShown()));

    console.log('4 — a plain click dismisses an armed pill');
    await page.keyboard.down('Shift');
    await page.mouse.move(Math.round(r.left + 40), y);
    await page.mouse.down();
    await page.mouse.move(Math.round(r.left + 260), y, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForSelector('.terminal-comment-selection-hint', { timeout: 3_000 }).catch(() => {});
    check('pill re-arms on a second shift+drag', await pillShown());
    await page.mouse.click(Math.round(r.left + 200), Math.round(r.top + 120));
    await page.waitForFunction(() => !document.querySelector('.terminal-comment-selection-hint'), { timeout: 3_000 }).catch(() => {});
    check('plain click dismisses the pill', !(await pillShown()));
  } finally {
    await app.close();
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
