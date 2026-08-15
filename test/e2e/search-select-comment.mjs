// End-to-end regression test for commenting out of a Ctrl+F search session.
// The type-to-comment capture used to bail whenever the search bar was merely
// visible, so selecting a search hit armed the pill but the keystroke fell
// through to the shell prompt. The capture is focus-based now, and the freeze
// knows search activity as engagement.
//
// Covers:
//   1. with the search bar open, selecting a hit and typing opens the composer
//      seeded with the key (and the search session survives it).
//   2. typing in the search field over a frozen view re-arms the idle thaw —
//      the freeze outlives the 4s bare-freeze window while you search.
//   3. Esc in the search field closes search FIRST and leaves the freeze up;
//      the next Esc (focus handed back to the terminal) cancels the freeze.
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
  const runCmd = async (cmd) => {
    await focusTerm();
    await page.keyboard.type(cmd);
    await page.keyboard.press('Enter');
  };
  const searchBarOpen = () => page.evaluate(() => {
    const bar = document.getElementById('search-bar');
    return !!bar && bar.style.display !== 'none';
  });
  const pillShown = () => page.evaluate(() => !!document.querySelector('.terminal-comment-selection-hint'));
  const bubbleShown = () => page.evaluate(() => !!document.querySelector('.terminal-comment-bubble'));
  const frozenPillShown = () => page.evaluate(() => !!document.querySelector('.terminal-output-frozen-pill'));
  // Screen-pixel drag range across a rendered row containing `text` (DOM renderer).
  const findRowRect = (text) => page.evaluate((needle) => {
    const rows = Array.from(document.querySelectorAll('.xterm-rows > div'));
    const row = rows.find((r) => (r.textContent || '').includes(needle));
    if (!row) return null;
    const b = row.getBoundingClientRect();
    return { left: b.left, y: Math.round(b.top + b.height / 2) };
  }, text);
  const dragAcross = async (rect, px) => {
    await page.mouse.move(Math.round(rect.left + 5), rect.y);
    await page.mouse.down();
    await page.mouse.move(Math.round(rect.left + px), rect.y, { steps: 6 });
    await page.mouse.up();
  };

  try {
    console.log('1 — select a search hit, type, get the composer');
    await runCmd('for i in 1 2 3 4 5 6 7 8; do echo "needle line $i: alpha beta gamma"; done');
    await sleep(500);
    await focusTerm();
    await page.keyboard.press('Control+f');
    await page.waitForFunction(() => {
      const bar = document.getElementById('search-bar');
      return !!bar && bar.style.display !== 'none';
    }, { timeout: 5_000 });
    check('Ctrl+F opens the search bar', await searchBarOpen());
    await page.keyboard.type('needle'); // lands in the focused search input
    await page.waitForFunction(
      () => /[1-9]/.test(document.getElementById('search-count')?.textContent || ''),
      { timeout: 5_000 },
    ).catch(() => {});
    check('query finds matches', await page.evaluate(() => /[1-9]/.test(document.getElementById('search-count')?.textContent || '')));

    const hitRow = await findRowRect('needle line 4');
    check('a hit row is on screen', !!hitRow);
    await dragAcross(hitRow, 220);
    await page.waitForSelector('.terminal-comment-selection-hint', { timeout: 5_000 }).catch(() => {});
    check('pill arms with the search bar open', await pillShown());
    check('selecting leaves the search session up', await searchBarOpen());

    await focusTerm();
    await page.keyboard.type('q');
    await page.waitForSelector('.terminal-comment-bubble', { timeout: 5_000 }).catch(() => {});
    check('typing opens the composer (not the prompt)', await bubbleShown());
    check('composer is seeded with the typed char', await page.evaluate(() => (
      document.querySelector('.terminal-comment-bubble textarea')?.value === 'q'
    )));
    check('the search session survives the composer', await searchBarOpen());

    // Tear down: Esc closes the composer, then Esc in the input closes search.
    await page.evaluate(() => {
      const el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => !document.querySelector('.terminal-comment-bubble'), { timeout: 5_000 }).catch(() => {});
    await page.evaluate(() => document.getElementById('search-input')?.focus());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('search-bar')?.style.display === 'none', { timeout: 5_000 }).catch(() => {});
    check('Esc in the input closes search', !(await searchBarOpen()));

    console.log('2 — search typing holds a bare freeze past the idle window');
    await runCmd('while true; do echo tick; sleep 0.3; done');
    await sleep(700);
    const tickRow = await findRowRect('tick');
    await dragAcross(tickRow, 60); // drag on live output declares text intent → freeze
    await page.waitForSelector('.terminal-output-frozen-pill', { timeout: 5_000 });
    check('drag on live output freezes', await frozenPillShown());
    await focusTerm();
    await page.keyboard.press('Control+f');
    await page.waitForFunction(() => document.getElementById('search-bar')?.style.display !== 'none', { timeout: 5_000 });
    // The bare-freeze idle thaw fires at 4s; keep typing past it. Each keystroke
    // must re-arm the timer or the pill vanishes mid-search.
    for (const ch of ['z', 'z', 'q', 'x', 'w']) {
      await page.keyboard.type(ch);
      await sleep(1100);
    }
    check('freeze survives 5s of search typing', await frozenPillShown());

    console.log('3 — Esc ladder: search closes first, freeze second');
    await page.keyboard.press('Escape'); // focus is in the search input
    await sleep(300);
    check('Esc in the input closes search, freeze stays', !(await searchBarOpen()) && (await frozenPillShown()));
    await page.keyboard.press('Escape'); // closeSearchBar handed focus back to the terminal
    await page.waitForFunction(() => !document.querySelector('.terminal-output-frozen-pill'), { timeout: 5_000 }).catch(() => {});
    check('next Esc cancels the freeze', !(await frozenPillShown()));
  } finally {
    await app.close();
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
