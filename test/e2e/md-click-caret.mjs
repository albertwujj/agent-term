// A click in a markdown doc arms the block under it, with the caret where the
// click landed, even when the click also closes something open. Two closers
// re-lay the page under the pointer: committing an open edit rebuilds the
// article (the pressed node detaches, so the click used to vanish, focus
// falling to the prompt) and folds its strip; closing a comment composer
// lifts the text below it (the caret used to fall back to the block's end).
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

  // Press at the start of `word` in paragraph n, on whichever copy shows it.
  async function clickWord(n, word) {
    const point = await page.evaluate(([n, word]) => {
      for (const p of document.querySelectorAll('.md-viewer-body p')) {
        if (!p.textContent.startsWith(`Paragraph ${n} `)) continue;
        const text = p.firstChild;
        const at = text.data.indexOf(word);
        const range = document.createRange();
        range.setStart(text, at);
        range.setEnd(text, at + 1);
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

  async function assertArmedAt(n, word, why) {
    const state = await page.evaluate(() => {
      const caret = document.querySelector('.md-edit-caret');
      const block = caret && caret.closest('p');
      return {
        block: block ? block.textContent.split(' has')[0] : null,
        after: caret && caret.nextSibling ? caret.nextSibling.textContent : '',
        focusInBand: !!(document.activeElement && document.activeElement.closest('.vb-shell')),
        editing: !!document.querySelector('.md-rendered-editing'),
      };
    });
    assert.equal(state.block, `Paragraph ${n}`, `${why}: the clicked block holds the caret ${JSON.stringify(state)}`);
    assert.ok(state.after.startsWith(word), `${why}: the caret sits at the clicked word ${JSON.stringify(state)}`);
    assert.equal(state.focusInBand, true, `${why}: keys go to the doc, not the prompt`);
    assert.equal(state.editing, false, `${why}: the edit committed`);
  }

  await clickWord(4, 'enough');
  await page.keyboard.press('Backspace');
  assert.equal(await page.locator('.md-rendered-editing').count(), 1, 'Backspace opens the editor');
  await clickWord(6, 'following');
  await assertArmedAt(6, 'following', 'click past an open edit');
  assert.equal(await page.locator('.md-pending-del').count() >= 2, true, 'the strike survives the commit in both copies');
  console.log('PASS a click past an open edit commits it and arms the clicked word');

  await clickWord(9, 'some');
  await page.keyboard.type('h');
  assert.equal(await page.locator('.md-comment-card textarea').count(), 1, 'a letter opens the composer');
  await clickWord(10, 'following');
  await assertArmedAt(10, 'following', 'click past an open composer');
  console.log('PASS a click past an open composer queues it and arms the clicked word');

  assert.deepEqual(errors, [], 'no renderer errors');
} finally {
  await app.close();
}
