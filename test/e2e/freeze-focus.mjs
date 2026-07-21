// End-to-end regression test for the terminal freeze / thaw / focus behavior
// around answering a running program's prompt while a viewer is open.
// Launches the REAL app via Playwright's _electron (macOS/Linux), drives real
// DOM + keyboard events against the shipped renderer, and asserts observable
// state: the freeze pill, the viewer band's open/hidden class, and
// document.activeElement. No mocks — the handlers are wired exactly as shipped.
//
// Covers three fixes:
//   1. cancelTerminalFreeze restores terminal focus (Esc out of a comment →
//      keyboard lands back on the terminal, not on nothing).
//   2. a nav-key keydown (ArrowDown) thaws a frozen view (so a codex menu is
//      visible as you navigate it).
//   3. onData withdraws an open viewer only on a printable char — a bare Enter
//      (answering a prompt) leaves the viewer up.
//
// Run: npm run test:e2e   (builds the renderer first, then this)

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(APP_DIR, 'test', 'fixtures', 'e2e-viewer.html');
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

  const focusTerm = () => page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    if (ta) ta.focus();
  });
  const runCmd = async (cmd) => {
    await focusTerm();
    await page.keyboard.type(cmd);
    await page.keyboard.press('Enter');
  };
  // Synthetic mousedown on the terminal screen (button 0). detail>=2 opens a
  // comment; detail 1 with no mouseup is a HELD press, which freezes once the
  // hold threshold elapses. Real coords so the buffer-position map works.
  const pressTerminal = (detail) => page.evaluate((d) => {
    const el = document.querySelector('.xterm-screen');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, detail: d,
      clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
    }));
  }, detail);
  // A quick click: mousedown + immediate mouseup, well under the hold threshold.
  const clickTerminal = () => page.evaluate(() => {
    const el = document.querySelector('.xterm-screen');
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, button: 0, detail: 1,
      clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
    };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
  });
  const pillShown = () => page.evaluate(() => !!document.querySelector('.terminal-output-frozen-pill'));
  const activeClass = () => page.evaluate(() => (document.activeElement && document.activeElement.className) || '');
  const webBand = () => page.evaluate(() => {
    const s = document.querySelector('.vb-shell.vb-web');
    return s ? { open: s.classList.contains('open'), hidden: s.classList.contains('hidden') } : null;
  });

  try {
    // ---- Fix 3: viewer withdraw gates on a printable char, not Enter ----
    console.log('Fix 3 — Enter keeps an open viewer up; a printable rolls it up');
    await runCmd(`echo ${url.pathToFileURL(FIXTURE).href}`);
    await sleep(400);
    // Open the web viewer on the just-printed file URL via the recent-viewer hotkey
    // path (main sends the IPC the global shortcut would).
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.webContents.send('open-recent-viewer-url');
    });
    await page.waitForSelector('.vb-shell.vb-web.open', { timeout: 10_000 });

    await focusTerm();
    await page.keyboard.press('Enter');       // answering a prompt
    await sleep(200);
    check('viewer stays up on Enter', (await webBand())?.open === true);

    await focusTerm();
    await page.keyboard.type('x');            // composing a command
    await page.waitForFunction(
      () => document.querySelector('.vb-shell.vb-web')?.classList.contains('hidden'),
      { timeout: 5_000 },
    ).catch(() => {});
    check('viewer rolls up on a printable char', (await webBand())?.hidden === true);
    await focusTerm();
    await page.keyboard.press('Control+c');   // clear the shell input line

    // ---- keep output "live" so a press on the terminal freezes ----
    await runCmd('while true; do echo tick; sleep 0.3; done');
    await sleep(700);

    // ---- Quick click on live output does NOT freeze ----
    // Freeze needs declared text intent: a drag or a held press. A fast click
    // (e.g. opening a link) leaves the stream running.
    console.log('Quick click on live output does NOT freeze');
    await clickTerminal();
    await sleep(400); // past the hold threshold — a leaked timer would freeze here
    check('quick click leaves output live (no pill)', !(await pillShown()));

    // ---- Fix 2: a nav-key keydown thaws a frozen view ----
    console.log('Fix 2 — ArrowDown thaws a frozen terminal');
    await pressTerminal(1);
    await page.waitForSelector('.terminal-output-frozen-pill', { timeout: 5_000 });
    check('press on live output freezes (pill shown)', await pillShown());
    await focusTerm();
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(
      () => !document.querySelector('.terminal-output-frozen-pill'),
      { timeout: 5_000 },
    ).catch(() => {});
    check('ArrowDown thaws (pill gone)', !(await pillShown()));

    // ---- Fix 1: dismissing a comment restores terminal focus ----
    console.log('Fix 1 — Esc out of a comment refocuses the terminal');
    await pressTerminal(2); // freeze + open comment
    await page.waitForSelector('.terminal-comment-bubble', { timeout: 5_000 });
    check('double-press opens a comment', (await activeClass()).includes('cu-ta'));
    await page.evaluate(() => {
      const el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(
      () => !document.querySelector('.terminal-comment-bubble') && !document.querySelector('.terminal-output-frozen-pill'),
      { timeout: 5_000 },
    ).catch(() => {});
    check('Esc closes the comment and unfreezes', !(await pillShown()));
    check('focus returns to the terminal', (await activeClass()).includes('xterm-helper-textarea'));

    // ---- Prompt-area suppression: a press in the bottom input box doesn't freeze ----
    // The while-loop is still streaming, so a press is "live"; a press low in the
    // screen (where an AI CLI pins its input box) must leave output running.
    console.log('Prompt-area press on live output does NOT freeze');
    await page.evaluate(() => {
      const el = document.querySelector('.xterm-screen');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 0, detail: 1,
        clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.bottom - 3),
      }));
    });
    await sleep(300);
    check('press in the prompt region leaves output live (no pill)', !(await pillShown()));

    // ---- Idle auto-thaw: a freeze nobody acts on resumes on its own ----
    console.log('Idle freeze auto-thaws with no commenting action');
    await pressTerminal(1);
    await page.waitForSelector('.terminal-output-frozen-pill', { timeout: 5_000 });
    check('center press on live output freezes (pill shown)', await pillShown());
    // No key, no mouse move, no selection — let the idle timer elapse and thaw.
    await page.waitForFunction(
      () => !document.querySelector('.terminal-output-frozen-pill'),
      { timeout: 8_000 },
    ).catch(() => {});
    check('idle freeze auto-thaws (pill gone)', !(await pillShown()));
  } finally {
    await app.close();
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
