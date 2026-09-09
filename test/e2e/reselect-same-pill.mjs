// End-to-end regression test: the "Type to comment" pill returns when the same
// cells are selected again after a keyboard clear.
//
// xterm 5.5.0 fires onSelectionChange from the mouse path only when the
// released selection differs from the last one it fired, and clearSelection()
// fires without updating that memory. So after Esc (or a copy) cleared a
// selection, the identical drag painted a selection and fired nothing, and the
// pill stayed away. A plain click in between resets the memory (its release
// fires the "had a selection, now none" branch), which is why clicking away and
// re-selecting always worked. The renderer now schedules the pill from the
// mouse release as well.
//
// Covers:
//   1. a drag arms the pill; Esc disarms it and clears the selection; the
//      identical drag arms the pill again.
//   2. the same after a copy chord cleared the selection first.
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
  await sleep(1200);
  if (await page.evaluate(() => !!document.querySelector('.at-picker-overlay'))) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }

  const focusTerm = () => page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    if (ta) ta.focus();
  });
  const pillShown = () => page.evaluate(() => !!document.querySelector('.terminal-comment-selection-hint'));
  const selectionPainted = () => page.evaluate(() => !!document.querySelector('.xterm-selection div'));
  const waitPill = () => page.waitForSelector('.terminal-comment-selection-hint', { timeout: 3_000 }).catch(() => {});
  const waitNoPill = () => page.waitForFunction(() => !document.querySelector('.terminal-comment-selection-hint'), { timeout: 3_000 }).catch(() => {});
  const copyKey = process.platform === 'darwin' ? 'Meta+KeyC'
    : process.platform === 'win32' ? 'Control+KeyC'
    : null;

  try {
    await focusTerm();
    await page.keyboard.type('clear; for i in 1 2 3 4 5 6; do echo "line $i: the quick brown fox jumps over the lazy dog"; done');
    await page.keyboard.press('Enter');
    await sleep(800);

    const r = await page.evaluate(() => {
      const b = document.querySelector('.xterm-screen').getBoundingClientRect();
      const rows = document.querySelector('.xterm-rows');
      return { left: b.left, top: b.top, width: b.width, height: b.height, rowCount: rows ? rows.children.length : 24 };
    });
    const rowH = r.height / r.rowCount;
    const rowY = (row) => Math.round(r.top + rowH * (row + 0.5));
    // Rows 1..6 carry the echoed lines (row 0 is the command itself). The same
    // pixels every time, so the selection lands on the same cells.
    const drag = async () => {
      await page.mouse.move(Math.round(r.left + 30), rowY(2));
      await page.mouse.down();
      await page.mouse.move(Math.round(r.left + 300), rowY(4), { steps: 6 });
      await page.mouse.up();
    };
    const escape = async () => {
      await focusTerm();
      await page.keyboard.press('Escape');
      await waitNoPill();
      await sleep(120); // xterm repaints the cleared selection on the next frame
    };

    console.log('1 — drag, Esc, the identical drag');
    await drag();
    await waitPill();
    check('pill appears after the first drag', await pillShown());
    await escape();
    check('Esc dismisses the pill', !(await pillShown()));
    check('Esc clears the selection', !(await selectionPainted()));
    await drag();
    await waitPill();
    check('pill appears after the same drag', await pillShown());
    await escape();

    console.log('2 — drag, copy, Esc, the identical drag');
    if (!copyKey) {
      console.log(`  — skipped: no copy shortcut is bound on ${process.platform}`);
    } else {
      await drag();
      await waitPill();
      check('pill appears after the drag', await pillShown());
      await focusTerm();
      await page.keyboard.press(copyKey);
      await sleep(200);
      check('copy clears the selection', !(await selectionPainted()));
      await escape();
      check('Esc after the copy dismisses the pill', !(await pillShown()));
      await drag();
      await waitPill();
      check('pill appears after the same drag following a copy', await pillShown());
    }
  } finally {
    await app.close().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
