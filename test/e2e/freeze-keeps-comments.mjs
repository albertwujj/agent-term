// End-to-end: resuming a frozen view does not throw away unsent comments, and a
// queued batch can be sent without opening another composer.
//
// Esc while frozen used to clear the whole batch, and the pill advertised it as
// "resume" and nothing else — so the fastest key to reach was the one that
// destroyed work you had spent a while writing. Resuming and abandoning are
// different intents and only one is reversible, so only the labelled control
// does the destructive one now.
//
// The composer's Enter still flushes, but it only reaches a batch you are
// actively adding to. Queue a few comments and walk away and Enter is nowhere,
// which left Discard as the only control that still worked on the batch.

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
  const wordAt = (target) => page.evaluate((t) => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')];
    for (let i = rows.length - 1; i >= 0; i--) {
      const rowText = rows[i].textContent || '';
      if (!rowText.includes(t) || rowText.includes('printf')) continue;
      const col = rowText.indexOf(t);
      let seen = 0;
      const walker = document.createTreeWalker(rows[i], NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = n.textContent.length;
        if (seen + len > col) {
          const r = document.createRange();
          r.setStart(n, col - seen);
          r.setEnd(n, Math.min(len, col - seen + t.length));
          const b = r.getBoundingClientRect();
          return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
        }
        seen += len;
      }
    }
    return null;
  }, target);
  const state = () => page.evaluate(() => ({
    frozen: !!document.querySelector('.terminal-output-frozen-pill'),
    count: document.querySelector('.terminal-comment-footer-count')?.textContent || null,
    hasSend: !!document.querySelector('.terminal-comment-footer-send'),
    cards: document.querySelectorAll('.terminal-comment-queued-card').length,
  }));
  const screenText = () => page.evaluate(() => (
    [...document.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent || '').join('\n')
  ));

  try {
    await runCmd('clear');
    await runCmd(`printf '%s\\n' 'ANCHOR-ONE first line' 'ANCHOR-TWO second line'`);
    await sleep(900);

    console.log('two drafts left unsent');
    for (const anchor of ['ANCHOR-ONE', 'ANCHOR-TWO']) {
      const t = await wordAt(anchor);
      if (!t) throw new Error(`anchor ${anchor} not found`);
      await page.mouse.dblclick(t.x, t.y);
      await sleep(450);
      await focusTerm();
      await page.keyboard.type(`note on ${anchor}`);
      await sleep(500);
      await page.mouse.click(40, 560); // clicking away queues the draft
      await sleep(600);
    }
    let s = await state();
    check('both are queued', s.count === '2 comments' && s.cards === 2, s);
    check('the batch has a Send of its own', s.hasSend, s);

    console.log('freezing the view');
    await focusTerm();
    await page.keyboard.type('for i in $(seq 1 400); do echo "stream $i"; done');
    await page.keyboard.press('Enter');
    await sleep(150);
    await page.mouse.move(300, 200);
    await page.mouse.down();
    await sleep(500); // past the hold threshold
    await page.mouse.up();
    await sleep(400);
    s = await state();
    check('the view is frozen', s.frozen, s);
    check('and the comments are still there', s.count === '2 comments', s);

    console.log('Esc resumes without destroying the batch');
    await focusTerm();
    await page.keyboard.press('Escape');
    await sleep(700);
    s = await state();
    check('output is running again', !s.frozen, s);
    check('both comments survived', s.count === '2 comments', s);
    check('and their cards are still anchored', s.cards === 2, s);

    console.log('the batch sends from the footer');
    await page.click('.terminal-comment-footer-send');
    await sleep(1500);
    s = await state();
    check('the footer is gone once sent', s.count === null, s);
    check('no queued cards remain', s.cards === 0, s);
    const text = await screenText();
    check('and the message reached the shell', text.includes('note on ANCHOR-ONE'), text.slice(-300));
  } finally {
    await app.close().catch(() => {});
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
