// End-to-end: on a review, a right-click on a symbol highlights its every
// whole-word, case-matching occurrence, with a mark per place on the rail; a
// right-click inside a selection searches exactly the selection; the scan
// survives the agent's re-render (a full reload); Esc or a right-click off any
// word clears it. Real mouse input, since the menu event is the engine's own
// reaction to a right press (on macOS it also selects the word under it, which
// must not arm a prose comment).

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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'at-review-symbol-scan-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(repo, 'load.js'), 'function load(id) {\n  return fetchById(id);\n}\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  fs.writeFileSync(path.join(repo, 'load.js'),
    'function load(id) {\n  const width = id * 2;\n  return fetchById(id, width);\n}\n');
  git('add', '.');
  git('commit', '-qm', 'two');
  const range = `${git('rev-parse', 'HEAD~1')}..${git('rev-parse', 'HEAD')}`;
  const dir = path.join(repo, '.git', 'review', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, 'main.md');
  fs.writeFileSync(pkg, `---\nrange: ${range}\n---\n\n# Review\n\nA change to load.js worth a look.\n\n:::diff load.js\n`);
  return { repo, pkg };
}

async function waitFor(fn, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`${message}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

const review = makeReviewRepo();
const app = await launchElectron({
  executablePath: ELECTRON_BIN,
  args: ['--no-sandbox', APP_DIR],
  timeout: 45_000,
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await sleep(1200);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1700, 950));

  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`echo review://${review.pkg}`);
  await page.keyboard.press('Enter');
  await sleep(700);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url');
  });
  await page.waitForSelector('.vb-shell.vb-web.open', { timeout: 10_000 });

  const guestOf = `webContents.getAllWebContents().find((w) =>
    w.getType() === 'webview' && /[/\\\\]\\.git[/\\\\]review[/\\\\]main[/\\\\]main\\.html(?:$|[?#])/.test(w.getURL()))`;
  const inReview = (source) => app.evaluate(({ webContents }, [find, code]) => {
    const guest = eval(find);
    return guest ? guest.executeJavaScript(code) : null;
  }, [guestOf, source]);
  const send = (events) => app.evaluate(async ({ webContents }, [find, evs]) => {
    const guest = eval(find);
    guest.focus();
    for (const e of evs) {
      guest.sendInputEvent(e);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }, [guestOf, events]);
  const press = (at, button) => send([
    { type: 'mouseMove', x: at.x, y: at.y },
    { type: 'mouseDown', x: at.x, y: at.y, button, clickCount: 1 },
    { type: 'mouseUp', x: at.x, y: at.y, button, clickCount: 1 },
  ]);
  const rightClick = (at) => press(at, 'right');
  const state = () => inReview(`({
    hits: CSS.highlights.has('rv-sym') ? CSS.highlights.get('rv-sym').size : 0,
    focus: CSS.highlights.has('rv-sym-focus') ? CSS.highlights.get('rv-sym-focus').size : 0,
    pill: (document.querySelector('.rv-sym-pill code') || {}).textContent || '',
    count: (document.querySelector('.rv-sym-count') || {}).textContent || '',
    marks: document.querySelectorAll('.rv-sym-mark').length,
    focusMarks: document.querySelectorAll('.rv-sym-mark-focus').length,
    selection: String(getSelection()),
    quoteArmed: (document.getElementById('rv-quote-btn') || { style: {} }).style.display === 'block',
  })`);
  // The box of the n-th occurrence of `word` in a new-side code cell (or prose).
  const boxOf = (selector, word, n = 0) => inReview(`(() => {
    const hits = [];
    document.querySelectorAll(${JSON.stringify(selector)}).forEach((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        let at = node.data.indexOf(${JSON.stringify(word)});
        while (at !== -1) { hits.push([node, at]); at = node.data.indexOf(${JSON.stringify(word)}, at + 1); }
      }
    });
    const hit = hits[${n}];
    if (!hit) return null;
    const r = document.createRange();
    r.setStart(hit[0], hit[1]);
    r.setEnd(hit[0], hit[1] + ${word.length});
    const b = r.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);

  await waitFor(() => inReview('document.body.dataset.review || ""'), 'review guest did not load');
  await waitFor(() => inReview(`!!document.querySelector('td.code[data-side="new"][data-line="3"]')`), 'diff did not render');

  // `id` is whole-word 5 times (old 1-2, new 1-3); `width` and `fetchById` hold it only inside.
  await rightClick(await boxOf('td.code[data-side="new"][data-line="2"]', 'id', 1)); // the 0th is inside width
  const scanned = await waitFor(async () => {
    const s = await state();
    return s.hits ? s : false;
  }, 'a right-click on a symbol did not light up its occurrences');
  assert.equal(scanned.pill, 'id');
  assert.equal(scanned.hits, 5, 'every whole-word, case-matching occurrence');
  assert.equal(scanned.count, '5');
  assert.equal(scanned.focus, 1, 'the right-clicked occurrence is marked as picked');
  assert.ok(scanned.marks >= 1 && scanned.focusMarks === 1, `the rail marks the occurrences: ${JSON.stringify(scanned)}`);
  assert.equal(scanned.selection, '', 'a word pick leaves no selection behind');
  console.log('PASS a right-click on a symbol highlights its whole-word occurrences and marks the rail');

  await app.evaluate(({ webContents }, find) => { eval(find).reload(); }, guestOf);
  const reloaded = await waitFor(async () => {
    const s = await state();
    return s && s.hits ? s : false;
  }, 'the scan did not survive the reload');
  assert.equal(reloaded.pill, 'id');
  assert.equal(reloaded.hits, 5);
  console.log('PASS the scan survives a full reload of the review');

  await send([
    { type: 'keyDown', keyCode: 'Escape' },
    { type: 'keyUp', keyCode: 'Escape' },
  ]);
  const cleared = await state();
  assert.equal(cleared.hits, 0, 'Esc clears the highlights');
  assert.equal(cleared.pill, '', 'Esc removes the pill');
  console.log('PASS Esc clears the scan');

  // A selection of part of a name: `Id` inside fetchById, exact and case-sensitive.
  await inReview(`(() => {
    const cell = document.querySelector('td.code[data-side="new"][data-line="3"]');
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.data.indexOf('fetchById');
      if (at === -1) continue;
      const r = document.createRange();
      r.setStart(node, at + 7);
      r.setEnd(node, at + 9);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return true;
    }
    return false;
  })()`);
  const selBox = await inReview(`(() => {
    const b = getSelection().getRangeAt(0).getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  await rightClick(selBox);
  const bySelection = await waitFor(async () => {
    const s = await state();
    return s.hits ? s : false;
  }, 'a right-click inside a selection did not search it');
  assert.equal(bySelection.pill, 'Id');
  assert.equal(bySelection.hits, 2, 'the selection matches inside words, case-sensitively');
  assert.equal(bySelection.selection, 'Id', 'the selection stays');
  console.log('PASS a right-click inside a selection searches exactly the selection');

  // A right-click on a prose word scans it and leaves no comment armed.
  await rightClick(await boxOf('.md-render p', 'change'));
  const prose = await waitFor(async () => {
    const s = await state();
    return s.pill === 'change' ? s : false;
  }, 'a right-click on a prose word did not scan it');
  assert.equal(prose.quoteArmed, false, 'a word pick in prose arms no comment');
  console.log('PASS a prose word scans without arming a comment');

  // Off any word: the empty right end of a short code line.
  const blank = await inReview(`(() => {
    const b = document.querySelector('td.code[data-side="new"][data-line="4"]').getBoundingClientRect();
    return { x: Math.round(b.right - 12), y: Math.round(b.top + b.height / 2) };
  })()`);
  await rightClick(blank);
  const off = await waitFor(async () => {
    const s = await state();
    return s.hits === 0 ? s : false;
  }, 'a right-click off any word did not clear the scan');
  assert.equal(off.pill, '');
  console.log('PASS a right-click off any word clears the scan');
} finally {
  await app.close().catch(() => {});
  fs.rmSync(review.repo, { recursive: true, force: true });
}
