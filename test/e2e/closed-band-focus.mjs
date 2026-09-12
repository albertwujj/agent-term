// A closed or rolled-up viewer band must not keep the keyboard or the mouse.
// Seen 2026-09-11 as a "frozen" window: the md band's shell stays mounted
// after ✕ (invisible, at its last open height), the right page copy still
// hit-tested through it, and a click there ran the article's click handler,
// which focused the closed shell — from then on every key landed on a band
// whose key handler ignores a closed band. Drives the real app.
//
// Run: npm run test:e2e
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const DOC = path.join(APP_DIR, 'test/fixtures/md-viewer-test.md');
const SOURCE = '# Doc\n\n' + Array.from({ length: 40 }, (_, i) =>
  `Paragraph ${i} of the document, long enough to fill lines of a page.`).join('\n\n');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? ` (${detail})` : '')); console.log(`  FAIL ${name}${detail ? ` (${detail})` : ''}`); }
}

const app = await electron.launch({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', APP_DIR], timeout: 45_000 });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea');
  await page.waitForTimeout(1200);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow, ipcMain }, [doc, source]) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 950);
    for (const [channel, handler] of [
      ['read-markdown-file', () => ({ success: true, path: doc, content: source, mtimeMs: 1, size: source.length })],
      ['stat-markdown-file', () => ({ success: true, path: doc, mtimeMs: 1, size: source.length })],
      ['md-read-threads', () => ({ success: true, data: { version: 1, turn: 1, threads: [] } })],
    ]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
  }, [DOC, SOURCE]);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`echo ${DOC}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.secondary .md-viewer-body p');
  await page.waitForTimeout(400);

  const active = () => page.evaluate(() => {
    const el = document.activeElement;
    return el ? el.tagName.toLowerCase() + '.' + String(el.className).trim().split(/\s+/).slice(0, 3).join('.') : 'none';
  });
  const shellState = () => page.evaluate(() => {
    const shell = document.querySelector('.vb-shell.vb-md');
    const r = shell.getBoundingClientRect();
    const hit = (fx) => document.elementFromPoint(r.left + r.width * fx, r.top + r.height / 2);
    return {
      classes: shell.className,
      visibility: getComputedStyle(shell).visibility,
      rightHitInShell: shell.contains(hit(0.75)),
      leftHitInShell: shell.contains(hit(0.25)),
      right: [r.left + r.width * 0.75, r.top + r.height / 2],
    };
  });

  // A paragraph that is on the right page (the page viewport clips; strict
  // paging, so Playwright cannot scroll one into view).
  const clickRightPage = async () => {
    const point = await page.evaluate(() => {
      const pane = document.querySelector('.md-spread-pane.secondary .md-page-viewport');
      const pr = pane.getBoundingClientRect();
      for (const p of pane.querySelectorAll('p')) {
        const r = p.getBoundingClientRect();
        if (r.height > 0 && r.top >= pr.top + 4 && r.bottom <= pr.bottom - 4) return [r.left + 24, r.top + r.height / 2];
      }
      return null;
    });
    if (!point) throw new Error('no paragraph on the right page');
    await page.mouse.click(point[0], point[1]);
    await page.waitForTimeout(250);
  };

  // ---- Roll-up (Esc) hands the keyboard back ----
  console.log('Roll-up returns focus');
  await clickRightPage(); // arms a target: focus lands on the shell
  check('a click in the page focuses the band shell', (await active()).startsWith('div.vb-shell'), await active());
  await page.keyboard.press('Escape'); // clears the target
  await page.keyboard.press('Escape'); // rolls the band up
  await page.waitForTimeout(300);
  check('the band rolled up', (await shellState()).classes.includes('hidden'), (await shellState()).classes);
  check('rolling up moves focus to the terminal', (await active()) === 'textarea.xterm-helper-textarea', await active());

  // ---- Close (✕) hands the keyboard back and leaves nothing to hit ----
  console.log('Close returns focus and goes inert');
  await page.locator('.vb-md .vb-bar').click(); // tap the handle: restore
  await page.waitForTimeout(600);
  check('the band is back', (await shellState()).classes.includes('open'), (await shellState()).classes);
  await clickRightPage();
  check('focus is on the shell again', (await active()).startsWith('div.vb-shell'), await active());
  await page.locator('.vb-md .vb-close').click();
  await page.waitForTimeout(500);
  const closed = await shellState();
  check('the band is closed', !closed.classes.includes('open') && !closed.classes.includes('hidden'), closed.classes);
  check('a closed shell drops the full-size marker', !closed.classes.includes('vb-full'), closed.classes);
  check('closing moves focus to the terminal', (await active()) === 'textarea.xterm-helper-textarea', await active());
  check('the closed shell is hidden from hit-testing and focus', closed.visibility === 'hidden', closed.visibility);
  check('nothing of the closed band is under the right half', !closed.rightHitInShell);
  check('nothing of the closed band is under the left half', !closed.leftHitInShell);

  // The regression itself: a click where the right page used to be, then typing.
  await page.mouse.click(closed.right[0], closed.right[1]);
  await page.waitForTimeout(300);
  check('a click on the right half keeps the terminal focused', (await active()) === 'textarea.xterm-helper-textarea', await active());
  await page.keyboard.type('x');
  await page.waitForTimeout(200);
  check('typing after it still goes to the terminal', (await active()) === 'textarea.xterm-helper-textarea', await active());
} finally {
  await app.close();
}

console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
