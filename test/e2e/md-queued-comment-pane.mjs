// A queued mark exists in both article copies. Resizing the band can move it
// to the other page; reopening must seat the composer in the clicked copy.
import assert from 'node:assert/strict';
import { launchElectron } from './electron.mjs';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const DOC = path.join(APP_DIR, 'test/fixtures/md-viewer-test.md');
const SOURCE = '# Queued comments\n\n' + Array.from({ length: 40 }, (_, i) =>
  `Paragraph ${i} has a selected word and enough following text to keep the document flowing.`).join('\n\n');
const DRAFT = 'Keep this queued comment.';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const app = await launchElectron({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', APP_DIR], timeout: 45_000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.xterm-helper-textarea');
  await page.waitForTimeout(1200);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow, ipcMain }, [doc, source]) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 950);
    globalThis.__queuedSends = [];
    for (const [channel, handler] of [
      ['read-markdown-file', () => ({ success: true, path: doc, content: source, mtimeMs: 1, size: source.length })],
      ['stat-markdown-file', () => ({ success: true, path: doc, mtimeMs: 1, size: source.length })],
      ['md-read-threads', () => ({ success: true, data: { threads: [] } })],
      ['md-runbook-preflight', () => ({ runbook: '/stub/agent-threads/md/user-intent.md' })],
      ['md-add-threads', (_event, payload) => {
        globalThis.__queuedSends.push(payload);
        return { success: true, data: { threads: [] } };
      }],
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    }
  }, [DOC, SOURCE]);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`echo ${DOC}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);

  async function size(full) {
    if (await page.locator('.vb-shell.vb-md').evaluate((el) => el.classList.contains('vb-full')) !== full) {
      await page.locator('.vb-shell.vb-md .vb-bar').dblclick({ position: { x: 200, y: 10 } });
      await page.waitForTimeout(350);
    }
    assert.equal(await page.locator('.vb-shell.vb-md').evaluate((el) => el.classList.contains('vb-full')), full);
  }

  async function assertComposer(pane, draft) {
    const geometry = await page.locator('.md-comment-card').evaluate((card) => {
      const rect = card.getBoundingClientRect();
      const viewport = card.closest('.md-page-viewport').getBoundingClientRect();
      const textarea = card.querySelector('textarea');
      return {
        pane: card.closest('.md-spread-pane').classList.contains('primary') ? 'primary' : 'secondary',
        top: rect.top - viewport.top,
        bottom: rect.bottom - viewport.bottom,
        draft: textarea.value,
        focused: document.activeElement === textarea,
      };
    });
    assert.equal(geometry.pane, pane, `composer follows the clicked mark: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.top >= -1 && geometry.bottom <= 1, `composer fits the visible page: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.draft, draft);
    assert.equal(geometry.focused, true);
    const heights = await page.locator('.md-viewer-body').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    assert.ok(Math.abs(heights[0] - heights[1]) < 0.5, 'the counterpart spacer keeps the articles aligned');
  }

  for (const from of ['secondary', 'primary']) {
    for (const selection of [false, true]) {
      if (await page.locator('.vb-shell.vb-md .vb-close').count()) await page.locator('.vb-shell.vb-md .vb-close').click();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
      await page.waitForSelector('.vb-shell.vb-md.open .md-viewer-body h1');
      await page.waitForTimeout(350);
      const fullHeight = await page.locator('.primary .md-page-viewport').evaluate((el) => el.clientHeight);
      await size(false);
      // Choose prose on the golden right page which fits on the full left
      // page. Measure instead of pinning a font/platform-specific paragraph.
      const targetText = await page.evaluate((fullHeight) => {
        const article = document.querySelector('.secondary .md-viewer-body');
        const articleTop = article.getBoundingClientRect().top;
        const viewportTop = article.closest('.md-page-viewport').getBoundingClientRect().top;
        const block = [...article.querySelectorAll('p')].find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.top > viewportTop + 40 && rect.bottom - articleTop < fullHeight - 100;
        });
        return block?.textContent;
      }, fullHeight);
      assert.ok(targetText, 'a paragraph moves between pages when the band changes size');
      await size(from === 'primary');
      const target = page.locator(`.${from} p`).filter({ hasText: targetText });
      if (selection) {
        const point = await target.evaluate((el) => {
          const range = document.createRange();
          const offset = el.firstChild.textContent.indexOf('selected');
          range.setStart(el.firstChild, offset);
          range.setEnd(el.firstChild, offset + 8);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
        await page.mouse.dblclick(point.x, point.y);
      } else {
        await target.click();
      }
      await page.keyboard.type(DRAFT);
      await assertComposer(from, DRAFT);
      await page.locator('.primary h1').click(); // queue the draft
      assert.equal(await page.locator('.md-queued-comment-mark').count(), 2);
      await page.keyboard.press('Escape');
      await size(from === 'secondary');
      const to = from === 'secondary' ? 'primary' : 'secondary';
      await page.locator(`.${to} .md-queued-comment-mark`).click();
      await assertComposer(to, DRAFT);

      // Escape preserves the original draft, then a further revisit can be
      // edited, requeued, and sent without losing the selection or block.
      await page.keyboard.type(' Unsaved');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.md-queued-comment-mark').count(), 2);
      await page.locator(`.${to} .md-queued-comment-mark`).click();
      await assertComposer(to, DRAFT);
      await page.keyboard.type(' Revised');
      await page.locator('.primary h1').click();
      await page.locator(`.${to} .md-queued-comment-mark`).click();
      await assertComposer(to, `${DRAFT} Revised`);
      await page.keyboard.press(`${MOD}+Enter`); // capture the payload, never send to an agent
      await page.waitForSelector('.md-comment-card', { state: 'detached' });
      const payload = await app.evaluate(() => globalThis.__queuedSends.at(-1));
      assert.equal(payload.threads.length, 1);
      assert.equal(payload.threads[0].body, `${DRAFT} Revised`);
      assert.equal(payload.threads[0].anchor.snippet, selection ? 'selected' : targetText);
      assert.equal(payload.threads[0].anchor.wholeBlock, !selection);
      console.log(`PASS queued ${selection ? 'selection' : 'block'} comment follows ${from} → ${to}, retaining its draft and anchor`);
    }
  }
  assert.deepEqual(errors, [], 'no renderer errors');
} finally {
  await app.close().catch(() => {});
}
