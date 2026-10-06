// A thread card taller than its page keeps still while you type a reply.
// Every keystroke refits the card onto its page; with no scroll position that
// clears both margins, the fit used to correct whichever edge was out and push
// the other out, so the page bounced between two positions on each key.
import assert from 'node:assert/strict';
import { launchElectron } from './electron.mjs';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const DOC = path.join(APP_DIR, 'test/fixtures/md-viewer-test.md');
const SOURCE = '# Reply fit\n\n' + Array.from({ length: 30 }, (_, i) =>
  `Paragraph ${i} carries enough ordinary text to wrap across a couple of lines in the page.`).join('\n\n');
const THREADS = [{
  id: 'tall-thread',
  status: 'open',
  anchor: { snippet: 'Paragraph 14 carries enough ordinary text', context: '', wholeBlock: false, heading: 'Reply fit' },
  messages: [
    { author: 'user', body: 'Is this clear?', ts: 1 },
    { author: 'agent', body: Array.from({ length: 30 }, () => 'The agent answer runs long enough to make the card taller than a page.').join(' '), ts: 2 },
  ],
}];

const app = await launchElectron({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', APP_DIR], timeout: 45_000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.xterm-helper-textarea');
  await page.waitForTimeout(1200);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow, ipcMain }, [doc, source, threads]) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 950);
    for (const [channel, handler] of [
      ['read-markdown-file', () => ({ success: true, path: doc, content: source, mtimeMs: 1, size: source.length })],
      ['stat-markdown-file', () => ({ success: true, path: doc, mtimeMs: 1, size: source.length })],
      ['md-read-threads', () => ({ success: true, data: { threads } })],
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    }
  }, [DOC, SOURCE, THREADS]);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`echo ${DOC}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.vb-shell.vb-md.open .md-viewer-body h1');
  await page.waitForTimeout(500);

  // The card runs past its first page, so its Reply may sit pages later: flip
  // until a copy of it is really on screen.
  let reply = null;
  for (let flips = 0; flips < 12 && !reply; flips++) {
    reply = await page.evaluate(() => {
      for (const button of document.querySelectorAll('.md-thread-actions button')) {
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (rect.width && document.elementFromPoint(x, y) === button) return { x, y };
      }
      return null;
    });
    if (reply) break;
    const center = await page.locator('.primary .md-page-viewport').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(500);
  }
  assert.ok(reply, 'the Reply button comes on screen');
  await page.mouse.click(reply.x, reply.y);
  await page.waitForTimeout(400);

  const placement = () => page.evaluate(() => {
    const textarea = document.querySelector('.md-thread-reply textarea');
    const card = textarea.closest('.md-thread-card');
    const viewport = card.closest('.md-page-viewport').getBoundingClientRect();
    const composer = textarea.closest('.cu-composer').getBoundingClientRect();
    return {
      scrollTop: document.querySelector('.primary .md-page-viewport').scrollTop,
      secondary: document.querySelector('.secondary .md-viewer-body').style.transform,
      cardTaller: card.getBoundingClientRect().height > viewport.height,
      composerShown: composer.top >= viewport.top - 1 && composer.bottom <= viewport.bottom + 1,
      focused: document.activeElement === textarea,
    };
  });
  const opened = await placement();
  assert.equal(opened.cardTaller, true, `the card is taller than its page: ${JSON.stringify(opened)}`);
  assert.equal(opened.focused, true);
  assert.equal(opened.composerShown, true, `the composer is on the page: ${JSON.stringify(opened)}`);
  for (const key of 'abcdef') {
    await page.keyboard.type(key);
    await page.waitForTimeout(120);
    const now = await placement();
    assert.deepEqual(
      { scrollTop: now.scrollTop, secondary: now.secondary, composerShown: now.composerShown },
      { scrollTop: opened.scrollTop, secondary: opened.secondary, composerShown: true },
      `typing "${key}" leaves the pages still`,
    );
  }
  assert.deepEqual(errors, []);
  console.log('md reply fit stable: ok');
} finally {
  await app.close();
}
