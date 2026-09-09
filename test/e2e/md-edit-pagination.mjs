// Chromium layout regression: a resting comment row straddles the page seam.
// Typing below it must not alternately insert/remove its keep-together spacer.
// jsdom cannot catch the margin collapsing that caused this bounce.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const DOC = path.join(APP_DIR, 'test/fixtures/md-viewer-test.md');
const ANCHOR = 'Paragraph with a resolved comment.';
const TARGET = 'Edit this paragraph.';
const SOURCE = `# Pagination\n\n${ANCHOR}\n\n${TARGET}\n\n`
  + Array.from({ length: 20 }, (_, i) => `Following paragraph ${i}.`).join('\n\n');
const STORE = {
  version: 1, turn: 1,
  threads: [{
    id: 'seam-row', status: 'resolved', anchor: { snippet: ANCHOR },
    messages: [
      { author: 'user', body: 'Check this paragraph.', ts: 1, turn: 1 },
      { author: 'agent', body: 'Checked.', ts: 2, turn: 1 },
    ],
  }],
};
const app = await electron.launch({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', APP_DIR], timeout: 45_000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.xterm-helper-textarea');
  await page.waitForTimeout(1200);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow, ipcMain }, [doc, source, store]) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 950);
    for (const [channel, handler] of [
      ['read-markdown-file', () => ({ success: true, path: doc, content: source, mtimeMs: 1, size: source.length })],
      ['stat-markdown-file', () => ({ success: true, path: doc, mtimeMs: 1, size: source.length })],
      ['md-read-threads', () => ({ success: true, data: store })],
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    }
  }, [DOC, SOURCE, STORE]);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`echo ${DOC}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.primary .md-thread-resolved-line');
  await page.waitForTimeout(350);

  // Put the row's natural top two pixels before the seam. Measure the current
  // font/page geometry so this exercises the same boundary on macOS and WSLg.
  await page.evaluate((anchor) => {
    const primary = document.querySelector('.primary .md-viewer-body');
    const pane = primary.closest('.md-spread-pane');
    const style = getComputedStyle(pane);
    const height = pane.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const advance = height - parseFloat(getComputedStyle(primary).lineHeight);
    const row = primary.querySelector('.md-thread-resolved-line');
    const rowTop = row.getBoundingClientRect().top - primary.getBoundingClientRect().top;
    const block = [...primary.querySelectorAll('p')].find((el) => el.textContent === anchor);
    const blockHeight = block.getBoundingClientRect().height + advance - 2 - rowTop;
    for (const article of document.querySelectorAll('.md-viewer-body')) {
      [...article.querySelectorAll('p')].find((el) => el.textContent === anchor).style.height = `${blockHeight}px`;
    }
    primary.closest('.md-page-viewport').dispatchEvent(new Event('scroll'));
  }, ANCHOR);

  const edit = page.locator('.secondary p').filter({ hasText: TARGET });
  await edit.click();
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.secondary .md-rendered-editing');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  const settle = () => page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => {
    const surface = document.querySelector('.md-rendered-editing');
    const pane = surface.closest('.md-page-viewport');
    return {
      top: surface.getBoundingClientRect().top - pane.getBoundingClientRect().top,
      scroll: [...document.querySelectorAll('.md-page-viewport')].map((el) => el.scrollTop),
      seats: [...document.querySelectorAll('.md-keep-spacer')].map((el) => el.getBoundingClientRect().height),
    };
  });
  await settle();
  const before = await snapshot();
  assert.equal(before.seats.length, 2, 'the seam row has a spacer in each article');
  assert.ok(before.seats.every((h) => h > 0 && h < 6), 'the small spacer exposes the margin-collapse boundary');
  for (const key of ' Earlier, we assumed') {
    await page.keyboard.type(key);
    await settle();
    const after = await snapshot();
    assert.ok(Math.abs(after.top - before.top) < 0.5,
      `typing ${JSON.stringify(key)} moved the paragraph: ${before.top} → ${after.top}`);
    assert.deepEqual(after.scroll, before.scroll, 'typing preserves both scroll offsets');
    assert.deepEqual(after.seats, before.seats, 'the row keeps the same seat on both pages');
  }
  assert.equal(await edit.locator('ins.md-pending-ins').innerText(), ' Earlier, we assumed');

  // Stability must not freeze the old seat: once preceding content moves the
  // row clear of the seam, its spacer should disappear in both articles.
  await page.evaluate((anchor) => {
    for (const article of document.querySelectorAll('.md-viewer-body')) {
      const block = [...article.querySelectorAll('p')].find((el) => el.textContent === anchor);
      block.style.height = `${parseFloat(block.style.height) + 60}px`;
    }
    document.querySelector('.primary .md-page-viewport').dispatchEvent(new Event('scroll'));
  }, ANCHOR);
  await settle();
  const moved = await snapshot();
  assert.deepEqual(moved.seats, [], 'the spacer is removed once the row clears the seam');
  await page.keyboard.type('.');
  await settle();
  assert.deepEqual(await snapshot(), moved, 'typing also stays steady after the row moves');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, [], 'no renderer errors');
  console.log('PASS typing at a comment-row page boundary preserves the paragraph position');
} finally {
  await app.close().catch(() => {});
}
