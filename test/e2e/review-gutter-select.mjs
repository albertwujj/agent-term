// End-to-end: on a review, a drag down one side of a split diff copies that
// side's lines, and no selection stands in the way of a line's +.
//
// Copy took in both sides: a split row is old gutter, old code, new gutter, new
// code, so a drag down the new column picked up the old lines between. And a
// selection left the + dead: the gutter is user-select:none, so pressing it kept
// the selection, and the gutter's click bailed on any selection, a prose one
// included. Real mouse input, since a synthetic click() skips the press that
// leaves the selection standing.

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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'at-review-gutter-select-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(repo, 'wide.py'), 'a = 1\nb = 2\nc = 3\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  fs.writeFileSync(path.join(repo, 'wide.py'), 'a = 1\nb = 20000000\nc = 30000000\nd = 40000000\n');
  git('add', '.');
  git('commit', '-qm', 'two');
  const range = `${git('rev-parse', 'HEAD~1')}..${git('rev-parse', 'HEAD')}`;
  const dir = path.join(repo, '.git', 'review', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, 'main.md');
  fs.writeFileSync(pkg, `---\nrange: ${range}\n---\n\n# Review\n\nA change to wide.py worth a look.\n\n:::diff wide.py\n`);
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
  // Input events into the guest, as a user's mouse delivers them.
  const mouse = (events) => app.evaluate(async ({ webContents }, [find, evs]) => {
    const guest = eval(find);
    guest.focus();
    for (const e of evs) {
      guest.sendInputEvent(e);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }, [guestOf, events]);
  const drag = (from, to) => mouse([
    { type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 },
    { type: 'mouseMove', x: from.x + 8, y: from.y, button: 'left' },
    { type: 'mouseMove', x: to.x, y: to.y, button: 'left' },
    { type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 },
  ]);
  const click = (at) => mouse([
    { type: 'mouseMove', x: at.x, y: at.y },
    { type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 },
  ]);
  // The platform copy chord, as the keyboard delivers it.
  const copy = () => app.evaluate(async ({ webContents, clipboard }, [find, mod]) => {
    const guest = eval(find);
    clipboard.writeText('');
    guest.focus();
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: [mod] });
    guest.sendInputEvent({ type: 'char', keyCode: 'c', modifiers: [mod] });
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: [mod] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return clipboard.readText();
  }, [guestOf, process.platform === 'darwin' ? 'meta' : 'control']);
  const state = () => inReview(`({
    selection: String(getSelection()),
    composer: document.querySelector('.rv-compose-row .cu-composer') ? 1 : 0,
    anchor: (document.querySelector('.rv-compose-row') || {}).textContent || '',
  })`);

  await waitFor(() => inReview('document.body.dataset.review || ""'), 'review guest did not load');
  const geo = await waitFor(() => inReview(`(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const cell = (side, line) => document.querySelector('td.code[data-side="' + side + '"][data-line="' + line + '"]');
    const gutter = document.querySelector('td.ln[data-side="new"][data-line="1"]');
    const prose = document.querySelector('.md-render p');
    return cell('new', 4) && cell('old', 3) && gutter && prose && {
      new2: box(cell('new', 2)), new4: box(cell('new', 4)),
      old1: box(cell('old', 1)), old3: box(cell('old', 3)),
      gutter: box(gutter), prose: box(prose),
    };
  })()`), 'diff did not render');
  const at = (b, fx) => ({ x: Math.round(b.x + b.w * fx), y: Math.round(b.y + b.h / 2) });

  await drag(at(geo.new2, 0.01), at(geo.new4, 0.6));
  await sleep(200);
  const added = 'b = 20000000\nc = 30000000\nd = 40000000';
  assert.equal((await state()).selection, added, 'a drag down the new side should select only its lines');
  assert.equal(await copy(), added);
  await drag(at(geo.old1, 0.01), at(geo.old3, 0.6));
  await sleep(200);
  assert.equal(await copy(), 'a = 1\nb = 2\nc = 3', 'a drag down the old side should copy only its lines');
  console.log('PASS a drag down either side of a split diff copies just that side');

  await click(at(geo.gutter, 0.5));
  const overCode = await waitFor(async () => {
    const s = await state();
    return s.composer ? s : false;
  }, 'the + did not open a line composer over a code selection');
  assert.equal(overCode.selection, '', 'the + should clear the code selection');
  assert.match(overCode.anchor, /wide\.py:1 \(new\)/);

  await drag(at(geo.prose, 0.01), at(geo.prose, 0.3));
  await sleep(200);
  assert.ok((await state()).selection.trim(), 'the prose drag should select text');
  await click(at(geo.gutter, 0.5));
  const overProse = await waitFor(async () => {
    const s = await state();
    return s.composer ? s : false;
  }, 'the + did not open a line composer over a prose selection');
  assert.equal(overProse.selection, '', 'the + should clear the prose selection');
  console.log('PASS the + opens its line composer over a standing code or prose selection');
} finally {
  await app.close().catch(() => {});
  fs.rmSync(review.repo, { recursive: true, force: true });
}
