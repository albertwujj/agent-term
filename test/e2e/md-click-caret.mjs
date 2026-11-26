// A click on a markdown block's words arms that block for a comment, even when
// the click also closes something open. Two closers
// re-lay the page under the pointer: committing an open edit rebuilds the
// article (the pressed node detaches, so the click used to vanish, focus
// falling to the prompt) and folds its strip; closing a comment composer
// lifts the text below it, so the click is read on the layout it was aimed at.
import assert from 'node:assert/strict';
import { launchElectron } from './electron.mjs';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const DOC = path.join(APP_DIR, 'test/fixtures/md-viewer-test.md');
const SOURCE = '# Click caret\n\n' + Array.from({ length: 30 }, (_, i) =>
  `Paragraph ${i} has some words and enough following text to keep the document flowing across lines.`).join('\n\n');

const app = await launchElectron({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', APP_DIR], timeout: 45_000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.xterm-helper-textarea');
  await page.waitForTimeout(1200);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1500, height: 900 });
  await app.evaluate(({ ipcMain }, [doc, source]) => {
    for (const [channel, handler] of [
      ['read-markdown-file', () => ({ success: true, path: doc, content: source, mtimeMs: 1, size: source.length })],
      ['stat-markdown-file', () => ({ success: true, path: doc, mtimeMs: 1, size: source.length })],
      ['md-read-threads', () => ({ success: true, data: { threads: [] } })],
      ['md-runbook-preflight', () => ({ runbook: '/stub/agent-threads/md/user-intent.md' })],
      ['md-add-threads', () => ({ success: true, data: { threads: [] } })],
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    }
  }, [DOC, SOURCE]);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`echo ${DOC}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.vb-shell.vb-md.open .md-viewer-body h1');
  await page.waitForTimeout(400);

  // Press just inside `word` in paragraph n (on its second letter, so the caret
  // lands between its first two letters: a word's edges belong to the gap
  // beside them, where a click edits), on whichever copy shows it.
  async function clickWord(n, word) {
    const point = await page.evaluate(([n, word]) => {
      for (const p of document.querySelectorAll('.md-viewer-body p')) {
        if (!p.textContent.startsWith(`Paragraph ${n} `)) continue;
        const text = p.firstChild;
        const at = text.data.indexOf(word);
        const range = document.createRange();
        range.setStart(text, at + 1);
        range.setEnd(text, at + 2);
        const rect = range.getBoundingClientRect();
        const x = rect.left + 1;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && p.contains(hit)) return { x, y };
      }
      return null;
    }, [n, word]);
    assert.ok(point, `paragraph ${n} is on a page`);
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(250);
  }

  // Press the middle of the space before `word` in paragraph n: an edit there.
  async function clickSpaceBefore(n, word) {
    const point = await page.evaluate(([n, word]) => {
      for (const p of document.querySelectorAll('.md-viewer-body p')) {
        if (!p.textContent.startsWith(`Paragraph ${n} `)) continue;
        const text = p.firstChild;
        const at = text.data.indexOf(word) - 1;
        const range = document.createRange();
        range.setStart(text, at);
        range.setEnd(text, at + 1);
        const rect = range.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && p.contains(hit)) return { x, y };
      }
      return null;
    }, [n, word]);
    assert.ok(point, `paragraph ${n} is on a page`);
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(250);
  }

  async function assertArmedAt(n, why) {
    const state = await page.evaluate(() => {
      const armed = document.querySelector('.md-comment-target-active');
      return {
        block: armed ? armed.textContent.split(' has')[0] : null,
        focusInBand: !!(document.activeElement && document.activeElement.closest('.vb-shell')),
        editing: !!document.querySelector('.md-rendered-editing'),
      };
    });
    assert.equal(state.block, `Paragraph ${n}`, `${why}: the clicked block is armed for a comment ${JSON.stringify(state)}`);
    assert.equal(state.focusInBand, true, `${why}: keys go to the doc, not the prompt`);
    assert.equal(state.editing, false, `${why}: the edit committed`);
  }

  await clickSpaceBefore(4, 'enough');
  assert.equal(await page.locator('.md-rendered-editing').count(), 1, 'a click on a space opens the editor');
  await page.keyboard.press('Backspace');
  await clickWord(6, 'following');
  await assertArmedAt(6, 'click past an open edit');
  assert.equal(await page.locator('.md-pending-del').count() >= 2, true, 'the strike survives the commit in both copies');
  console.log('PASS a click past an open edit commits it and arms the clicked word');

  await clickWord(9, 'some');
  await page.keyboard.type('h');
  assert.equal(await page.locator('.md-comment-card textarea').count(), 1, 'a letter opens the composer');
  await clickWord(10, 'following');
  await assertArmedAt(10, 'click past an open composer');
  console.log('PASS a click past an open composer queues it and arms the clicked word');

  assert.deepEqual(errors, [], 'no renderer errors');
} finally {
  await app.close();
}
