// End-to-end: in a review, a drag across prose selects, wherever in a letter
// the press lands; a drag on a diff's code line covers whole words, as one in
// prose does.
//
// In the review's <webview>, Chromium could lose a drag's starting point when
// the press landed at a sub-pixel position under half a pixel (Windows
// display scaling of 125% or 150% produces those): each move re-placed a
// collapsed caret under the pointer and the drag selected nothing. The host
// window never had it. The page now keeps the press point (keepDragAnchor in
// web-viewer-preload.js). Mouse input goes through the host window, as a
// user's does, at the fractional positions that failed.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { launchElectron } from './electron.mjs';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeReviewRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'at-review-drag-select-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(repo, 'a.py'), 'total = add(first)\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  fs.writeFileSync(path.join(repo, 'a.py'), 'total = add(first, second)\n');
  git('add', '.');
  git('commit', '-qm', 'Fix limiter rounding');
  const range = `${git('rev-parse', 'HEAD~1')}..${git('rev-parse', 'HEAD')}`;
  const dir = path.join(repo, '.git', 'review', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, 'main.md');
  fs.writeFileSync(pkg, `---\nrange: ${range}\n---\n\n# Review\n\nThe limiter now rounds tokens before refilling them.\n\n:::diff a.py L1-1\n`);
  return { repo, pkg };
}

const review = makeReviewRepo();
const app = await launchElectron({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', APP_DIR], timeout: 45_000 });

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await sleep(1200);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1500, height: 900 });

  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`echo review://${review.pkg}`);
  await page.keyboard.press('Enter');
  await sleep(700);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.vb-shell.vb-web.open', { timeout: 10_000 });

  const inReview = (source) => app.evaluate(({ webContents }, code) => {
    const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && /main\.html/.test(w.getURL()));
    return guest ? guest.executeJavaScript(code) : null;
  }, source);
  for (let i = 0; i < 100 && !(await inReview('!!document.querySelector(".md-render p")')); i++) await sleep(200);
  await sleep(600);
  const webview = await page.evaluate(() => {
    const r = [...document.querySelectorAll('webview')].map((e) => e.getBoundingClientRect()).find((b) => b.width > 0);
    return { x: r.x, y: r.y };
  });
  // The middle of the `i`th letter of `word`, in the window's coordinates.
  const letter = async (word, i) => {
    const at = await inReview(`(() => {
      const node = [...document.querySelectorAll('.md-render p')].map((p) => p.firstChild).find((n) => n.data.includes(${JSON.stringify(word)}));
      const k = node.data.indexOf(${JSON.stringify(word)}) + ${i};
      const r = document.createRange(); r.setStart(node, k); r.setEnd(node, k + 1);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`);
    return { x: webview.x + at.x, y: webview.y + at.y };
  };

  // Raw layout positions, and whole pixels plus the fractions Windows
  // scaling makes, rounded and floored.
  const placements = [{ name: 'raw', at: (p) => p }];
  for (const frac of [0.2, 0.25, 0.3333, 0.4]) {
    placements.push({ name: `round+${frac}`, at: (p) => ({ x: Math.round(p.x) + frac, y: Math.round(p.y) + frac }) });
    placements.push({ name: `floor+${frac}`, at: (p) => ({ x: Math.floor(p.x) + frac, y: Math.floor(p.y) + frac }) });
  }
  const failures = [];
  for (const { name, at } of placements) {
    for (const i of [0, 1, 2, 3]) {
      await inReview('getSelection().removeAllRanges(); 1');
      const from = await letter('rounds', i);
      const to = await letter('tokens', 3);
      await page.mouse.move(at(from).x, at(from).y);
      await page.mouse.down();
      await page.mouse.move(at(to).x, at(to).y, { steps: 6 });
      await page.mouse.up();
      await sleep(300);
      const selected = await inReview('String(getSelection())');
      if (selected !== 'rounds tokens') failures.push({ placement: name, letter: i, selected });
      await sleep(600); // past the double-click interval
    }
  }
  assert.deepEqual(failures, [], 'every drag from inside "rounds" to inside "tokens" selects "rounds tokens"');
  console.log('PASS a drag selects wherever in a letter the press lands, sub-pixel positions included');

  // A drag on a code line, from inside "total" to inside "second".
  const codeLetter = async (word, i) => {
    const at = await inReview(`(() => {
      const cell = [...document.querySelectorAll('td.code')].reverse().find((c) => c.textContent.includes('second'));
      const w = document.createTreeWalker(cell, 4, null);
      let node; let k = -1;
      while ((node = w.nextNode())) { k = node.data.indexOf(${JSON.stringify(word)}); if (k >= 0) break; }
      const r = document.createRange(); r.setStart(node, k + ${i}); r.setEnd(node, k + ${i} + 1);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`);
    return { x: webview.x + at.x, y: webview.y + at.y };
  };
  await inReview('getSelection().removeAllRanges(); 1');
  const codeFrom = await codeLetter('total', 2);
  const codeTo = await codeLetter('second', 3);
  await page.mouse.move(codeFrom.x, codeFrom.y);
  await page.mouse.down();
  await page.mouse.move(codeTo.x, codeTo.y, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
  const codeSelected = await inReview('String(getSelection())');
  assert.equal(codeSelected, 'total = add(first, second', 'a drag on a code line covers whole words');
  console.log('PASS a drag on a code line covers whole words');
} finally {
  await app.close();
}
