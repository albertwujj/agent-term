// End-to-end regression: a viewer band is an overlay, so the terminal rows it
// covers are still in xterm's viewport — the type-to-comment pill (and a queued
// card) is anchored to such a row and outranks the band in z-order, so expanding
// the viewer left the pill floating over the viewer, pointing at output nobody
// could see, while still owning the next printable key.
//
// Covers:
//   1. a drag over terminal output arms the pill.
//   2. opening the markdown viewer over that output takes the pill down.
//   3. rolling the band back up brings it back — the selection is visible again.
//
// Run: npm run test:e2e

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const MD_FIXTURE = path.join(APP_DIR, 'test', 'fixtures', 'md-viewer-test.md');
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

  const pillShown = () => page.evaluate(() => !!document.querySelector('.terminal-comment-selection-hint'));
  // The pill's own geometry against the band's: the bug was a visible pill
  // hanging over viewer content, which "is the pill gone" alone would miss if a
  // future change parked it somewhere instead of taking it down.
  const pillOverBand = () => page.evaluate(() => {
    const pill = document.querySelector('.terminal-comment-selection-hint');
    const band = document.querySelector('.vb-shell.open, .vb-shell.hidden');
    if (!pill || !band) return false;
    return pill.getBoundingClientRect().top < band.getBoundingClientRect().bottom;
  });

  try {
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`echo ${MD_FIXTURE}; for i in 1 2 3 4 5 6; do echo "line $i: the quick brown fox"; done`);
    await page.keyboard.press('Enter');
    await sleep(600);

    console.log('1 — a drag over terminal output arms the pill');
    const r = await page.evaluate(() => {
      const b = document.querySelector('.xterm-screen').getBoundingClientRect();
      return { left: b.left, top: b.top };
    });
    const y = Math.round(r.top + 45); // a few rows down — well inside the band's reach
    await page.mouse.move(Math.round(r.left + 40), y);
    await page.mouse.down();
    await page.mouse.move(Math.round(r.left + 260), y, { steps: 6 });
    await page.mouse.up();
    await page.waitForSelector('.terminal-comment-selection-hint', { timeout: 3_000 }).catch(() => {});
    check('pill appears after the drag', await pillShown());

    console.log('2 — opening the viewer over that output takes the pill down');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url');
    });
    await page.waitForSelector('.vb-shell.vb-md.open', { timeout: 10_000 });
    await sleep(600); // the band's height transition
    check('pill is gone while the band covers its row', !(await pillShown()));
    check('no pill floating over the viewer', !(await pillOverBand()));

    console.log('3 — rolling the band up brings the pill back');
    await page.locator('.vb-shell.vb-md .vb-bar').click();
    await page.waitForSelector('.vb-shell.vb-md.hidden', { timeout: 5_000 });
    await sleep(600); // the roll-up transition, then the pill re-arms
    check('pill returns once the row is visible again', await pillShown());
    check('and it sits below the collapsed handle', !(await pillOverBand()));
  } finally {
    await app.close();
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
