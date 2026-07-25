// End-to-end: an unsent terminal comment can be found again after its anchor
// scrolls out of the viewport.
//
// A queued draft's card is anchored to its terminal row and hides when that row
// leaves the screen, so once output scrolled past there was no trace left but a
// count in the footer — and that count was inert text. You could see that unsent
// work existed and not reach it, while the one control that always worked was
// Discard. The count is now the way back, and each unsent comment also leaves a
// tick in the overview ruler so the scrollbar maps where they sit.

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`); }
}

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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 620));

  const focusTerm = () => page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus());
  const runCmd = async (cmd) => {
    await focusTerm();
    await page.keyboard.type(cmd);
    await page.keyboard.press('Enter');
    await sleep(700);
  };
  const wordAt = (needle, word) => page.evaluate(([t, target]) => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')];
    for (let i = rows.length - 1; i >= 0; i--) {
      const rowText = rows[i].textContent || '';
      if (!rowText.includes(t) || rowText.includes('printf')) continue;
      const col = rowText.indexOf(target);
      if (col < 0) continue;
      let seen = 0;
      const walker = document.createTreeWalker(rows[i], NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = n.textContent.length;
        if (seen + len > col) {
          const r = document.createRange();
          r.setStart(n, col - seen);
          r.setEnd(n, Math.min(len, col - seen + target.length));
          const b = r.getBoundingClientRect();
          return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
        }
        seen += len;
      }
    }
    return null;
  }, [needle, word]);
  const state = () => page.evaluate(() => {
    const c = document.querySelector('.terminal-comment-footer-count');
    const card = document.querySelector('.terminal-comment-queued-card');
    const ruler = document.querySelector('canvas.xterm-decoration-overview-ruler');
    return {
      count: c ? c.textContent : null,
      countIsControl: !!c && c.tagName === 'BUTTON' && !c.disabled,
      cardVisible: !!card && getComputedStyle(card).display !== 'none',
      cardText: card ? card.textContent : null,
      hasRuler: !!ruler,
    };
  });

  try {
    await runCmd('clear');
    await runCmd(`printf '%s\\n' 'ANCHOR-ALPHA the first line worth commenting on'`);
    await sleep(900);

    console.log('a draft left unsent is queued and shown');
    const t = await wordAt('ANCHOR-ALPHA', 'ANCHOR-ALPHA');
    if (!t) throw new Error('anchor row not found');
    await page.mouse.dblclick(t.x, t.y);
    await sleep(500);
    await focusTerm();
    await page.keyboard.type('this needs a rewrite');
    await sleep(600);
    // Clicking away from the composer commits the draft to the queue.
    await page.mouse.click(40, 560);
    await sleep(700);

    let s = await state();
    check('the footer counts it', s.count === '1 comment', s.count);
    check('and the count is a live control', s.countIsControl, s);
    check('the card is on screen while its anchor is', s.cardVisible, s);
    check('the overview ruler exists to mark it', s.hasRuler, s);

    console.log('scrolling the anchor away hides the card');
    await runCmd(`for i in $(seq 1 60); do echo "filler line $i"; done`);
    await sleep(1200);
    s = await state();
    check('the card is gone', !s.cardVisible, s);
    check('but the count still reports the unsent work', s.count === '1 comment', s.count);

    console.log('the count is the way back');
    await page.click('.terminal-comment-footer-count');
    await sleep(900);
    s = await state();
    check('clicking it brings the comment back into view', s.cardVisible, s);
    check('with the draft intact', !!s.cardText && s.cardText.includes('this needs a rewrite'), s.cardText);
  } finally {
    await app.close().catch(() => {});
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
