// Erasing struck text brings it back, through the real keyboard: the
// browser's own target ranges, key repeat, and the first key after a click
// (a click just past a strike holds the caret past it, struck text counts).
// The rules themselves are unit-tested in test/edit-marks.test.js.
import assert from 'node:assert/strict';
import { launchElectron } from './electron.mjs';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const DOC = path.join(APP_DIR, 'test/fixtures/md-viewer-test.md');
const SOURCE = '# Take back\n\n' + Array.from({ length: 12 }, (_, i) =>
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

  // Click at an on-screen text offset of paragraph n (struck text counts),
  // on whichever copy shows it.
  async function clickAt(n, offset) {
    const point = await page.evaluate(([n, offset]) => {
      for (const p of document.querySelectorAll('.md-viewer-body p')) {
        if (!p.textContent.startsWith(`Paragraph ${n} `)) continue;
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        let node; let left = offset;
        while ((node = walker.nextNode())) { if (left < node.data.length) break; left -= node.data.length; }
        const range = document.createRange();
        if (node) { range.setStart(node, left); range.setEnd(node, left + 1); }
        else { range.selectNodeContents(p); }
        const rect = node ? range.getBoundingClientRect() : [...range.getClientRects()].pop();
        const x = node ? rect.left + 1 : rect.right + 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && p.contains(hit)) return { x, y };
      }
      return null;
    }, [n, offset]);
    assert.ok(point, `paragraph ${n} is on a page`);
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(200);
  }
  // Paragraph n's marks: [struck] {inserted}, from the copy being edited.
  async function marks(n) {
    return page.evaluate((n) => {
      const copies = [...document.querySelectorAll('.md-viewer-body p')].filter((p) => p.textContent.startsWith(`Paragraph ${n} `));
      const p = copies.find((c) => c.classList.contains('md-rendered-editing')) || copies[0];
      return p.innerHTML
        .replace(/<del class="md-pending-del">/g, '[').replace(/<\/del>/g, ']')
        .replace(/<ins class="md-pending-ins">/g, '{').replace(/<\/ins>/g, '}')
        .replace(/<[^>]+>/g, '');
    }, n);
  }
  async function backspaces(count) {
    for (let i = 0; i < count; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
  }
  // A held key: every keydown after the first carries repeat.
  async function holdBackspace(count) {
    for (let i = 0; i < count; i++) await page.keyboard.down('Backspace');
    await page.keyboard.up('Backspace');
    await page.waitForTimeout(100);
  }
  const text = 'Paragraph 2 has some words and enough following text to keep the document flowing across lines.';
  const afterWords = text.indexOf(' and');

  await clickAt(2, afterWords);
  await backspaces(5);
  assert.match(await marks(2), /some \[words\] and/, 'five erases strike "words"');
  assert.equal((await marks(2)).replace(/[\][]/g, ''), text, 'the strike keeps every char on screen');
  await clickAt(5, 3); // commit
  console.log('PASS erasing strikes in place');

  await clickAt(2, afterWords); // just past the strike: the caret holds there
  await backspaces(1);
  assert.match(await marks(2), /\]s and/, `the first erase past a strike brings its last char back: ${await marks(2)}`);
  await holdBackspace(8);
  assert.equal(await marks(2), text, 'held, the erase takes the whole strike back and stops at its start');
  await backspaces(1);
  assert.match(await marks(2), /some\[ \]words/, `the next press strikes on: ${await marks(2)}`);
  console.log('PASS erasing a strike takes it back, stopping at its start while held');

  await clickAt(5, 3); // commit, then revisit and take the last strike back
  await clickAt(2, text.indexOf('words'));
  await backspaces(1);
  await clickAt(5, 3);
  assert.equal(await marks(2), text, 'every mark taken back');
  const rest = await page.evaluate(() => [...document.querySelectorAll('.md-viewer-body p')]
    .filter((p) => p.textContent.startsWith('Paragraph 2 '))
    .map((p) => p.nextElementSibling && p.nextElementSibling.className));
  assert.ok(rest.every((cls) => !/md-pending/.test(cls || '')), `a block with every mark taken back rests with no edit: ${rest}`);
  console.log('PASS a revisit with every mark taken back commits to no edit');

  await clickAt(5, 3);
  const end = text.length;
  await clickAt(4, text.indexOf(' the document'));
  await backspaces(4); // strike "keep" (an older strike, mid-line)
  await clickAt(5, 3);
  await clickAt(4, end); // the paragraph's end
  // Erase back through " the document flowing across lines.", hop "keep" (one
  // strike, though erased char by char) in one press, then strike two more.
  await holdBackspace(' the document flowing across lines.'.length + 1 + 2);
  const through = await marks(4);
  assert.match(through, /text t\[o keep the document flowing across lines\.\]$/, `a striking run hops the older strike and strikes on: ${through}`);
  console.log('PASS a striking run hops an older strike instead of bringing it back');

  await clickAt(5, 3);
  await clickAt(6, end);
  await backspaces(6); // strike "lines." at the paragraph's end
  await clickAt(5, 3);
  await clickAt(6, end); // past the trailing strike
  await backspaces(1);
  assert.match(await marks(6), /\[lines\]\.$/, `a click past a trailing strike erases it back: ${await marks(6)}`);
  console.log('PASS a click just past a trailing strike holds the caret there');

  assert.deepEqual(errors, [], 'no renderer errors');
} finally {
  await app.close();
}
