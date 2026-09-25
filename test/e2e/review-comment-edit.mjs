// End-to-end: split-review gutters stay narrow, and a comment parked by
// click-away remains an editable draft until it is sent.

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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'at-review-comment-edit-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(repo, 'base.py'), 'base = True\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  fs.writeFileSync(path.join(repo, 'wide.py'), 'value = 2\n');
  git('add', '.');
  git('commit', '-qm', 'two');
  const range = `${git('rev-parse', 'HEAD~1')}..${git('rev-parse', 'HEAD')}`;
  const dir = path.join(repo, '.git', 'review', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, 'main.md');
  fs.writeFileSync(pkg, `---\nrange: ${range}\n---\n\n# Review\n\nA change to wide.py.\n\n:::diff wide.py\n`);
  return { repo, pkg, store: path.join(dir, 'main-comments.json') };
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

  const inReview = (source) => app.evaluate(({ webContents }, code) => {
    const guest = webContents.getAllWebContents().find((w) =>
      w.getType() === 'webview' && /[/\\]\.git[/\\]review[/\\]main[/\\]main\.html(?:$|[?#])/.test(w.getURL()));
    if (!guest) return null;
    return guest.executeJavaScript(code);
  }, source);

  await waitFor(() => inReview('document.body.dataset.review || ""'), 'review guest did not load');
  const geometry = await inReview(`(() => {
    const table = document.querySelector('table.d-split');
    const code = table && table.querySelector('td.code.add');
    const gutter = table && table.querySelector('td.ln.add[data-side="new"]');
    const tr = table && code && code.closest('tr');
    const tableRect = table?.getBoundingClientRect();
    const codeRect = code?.getBoundingClientRect();
    const gutterRect = gutter?.getBoundingClientRect();
    const dataCells = tr ? tr.children.length : 0;
    document.querySelector('td.ln[data-side="new"][data-line]').click();
    return { tableLeft: tableRect?.left || 0, tableRight: tableRect?.right || 0,
      tableWidth: tableRect?.width || 0, codeLeft: codeRect?.left || 0,
      codeRight: codeRect?.right || 0, codeWidth: codeRect?.width || 0,
      gutterLeft: gutterRect?.left || 0, gutterWidth: gutterRect?.width || 0, dataCells };
  })()`);
  const midpoint = geometry && geometry.tableLeft + geometry.tableWidth / 2;
  assert.ok(geometry && geometry.dataCells === 4
    && Math.abs(geometry.gutterLeft - midpoint) < 2
    && geometry.gutterWidth <= 50
    && Math.abs(geometry.codeRight - geometry.tableRight) < 2
    && geometry.codeWidth >= geometry.tableWidth / 2 - 55,
  `new code should fill the right pane after its narrow gutter: ${JSON.stringify(geometry)}`);
  console.log('PASS new code stays on the right and fills that pane after a 48px gutter');

  const original = 'Log where the resolver factory is populated.';
  await inReview(`(() => {
    const ta = document.querySelector('.rv-compose-row textarea');
    ta.value = ${JSON.stringify(original)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('section.file h2').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  })()`);
  await waitFor(() => {
    if (!fs.existsSync(review.store)) return false;
    const data = JSON.parse(fs.readFileSync(review.store, 'utf8'));
    return data.threads?.[0]?.messages?.[0]?.body === original;
  }, 'click-away did not park the comment');

  const parked = await waitFor(() => inReview(`(() => {
    const card = document.querySelector('.rv-thread');
    return card && {
      action: card.querySelector('[data-act="edit"]')?.textContent,
      commentAction: card.querySelector('[data-act="comment"]')?.textContent || '',
      messages: card.querySelectorAll('.rv-msg').length,
    };
  })()`), 'parked comment did not render');
  assert.deepEqual(parked, { action: 'Edit', commentAction: '', messages: 1 });

  const seed = await inReview(`(() => {
    document.querySelector('.rv-thread [data-act="edit"]').click();
    return document.querySelector('.rv-thread textarea')?.value || '';
  })()`);
  assert.equal(seed, original);

  const revised = `${original} It currently returns None.`;
  await inReview(`(() => {
    const ta = document.querySelector('.rv-thread textarea');
    ta.value = ${JSON.stringify(revised)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('section.file h2').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  })()`);
  const saved = await waitFor(() => {
    const data = JSON.parse(fs.readFileSync(review.store, 'utf8'));
    const messages = data.threads?.[0]?.messages;
    return messages?.length === 1 && messages[0].body === revised ? data : false;
  }, 'edited draft did not replace the original comment');
  assert.equal(saved.threads.length, 1);
  assert.equal(await inReview(`document.querySelector('.rv-thread [data-act="edit"]')?.textContent || ''`), 'Edit');
  console.log('PASS a click-away comment reopens and saves as one revised draft');
} finally {
  await app.close().catch(() => {});
  fs.rmSync(review.repo, { recursive: true, force: true });
}
