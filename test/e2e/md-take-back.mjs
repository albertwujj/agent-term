// Word-level re-work through the real keyboard: ⌫ strikes a word, a struck
// word comes back whole, your typed words leave whole, a held ⌫ goes at a
// reading pace and stops where your own changes end, and the arrows move a
// word at a time. The rules themselves are unit-tested in
// test/markdown-click-modes.test.js and test/edit-marks.test.js.
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
  // on whichever copy shows it: on the char's left edge, or with side
  // 'right' on its right edge (the near half after it: a paragraph's last
  // char puts the edit caret after it).
  async function clickAt(n, offset, { side = 'left' } = {}) {
    const point = await page.evaluate(([n, offset, side]) => {
      for (const p of document.querySelectorAll('.md-viewer-body p')) {
        if (!p.textContent.startsWith(`Paragraph ${n} `)) continue;
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        let node; let left = offset;
        while ((node = walker.nextNode())) { if (left < node.data.length) break; left -= node.data.length; }
        const range = document.createRange();
        if (node) { range.setStart(node, left); range.setEnd(node, left + 1); }
        else { range.selectNodeContents(p); }
        const rect = node ? range.getBoundingClientRect() : [...range.getClientRects()].pop();
        const x = node ? (side === 'right' ? rect.right - 1 : rect.left + 1) : rect.right + 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && p.contains(hit)) return { x, y };
      }
      return null;
    }, [n, offset, side]);
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
        .replace(/<ins class="md-pending-ins"[^>]*>/g, '{').replace(/<\/ins>/g, '}')
        .replace(/<[^>]+>/g, '');
    }, n);
  }
  async function backspaces(count) {
    for (let i = 0; i < count; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
  }
  // A held key for `ms`: keydowns at the system's repeat interval, every one
  // after the first carrying repeat.
  async function holdBackspace(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await page.keyboard.down('Backspace');
      await page.waitForTimeout(33);
    }
    await page.keyboard.up('Backspace');
    await page.waitForTimeout(100);
  }
  const text = 'Paragraph 2 has some words and enough following text to keep the document flowing across lines.';
  const gapAfterWords = text.indexOf(' and');
  const commit = () => clickAt(9, 3); // a click on another paragraph's word ends the edit

  await clickAt(2, gapAfterWords);
  await backspaces(1);
  assert.match(await marks(2), /some \[words\] and/, `one ⌫ strikes the word before: ${await marks(2)}`);
  assert.equal((await marks(2)).replace(/[\][]/g, ''), text, 'the strike keeps every char on screen');
  await backspaces(1);
  assert.match(await marks(2), /has \[some words\] and/, `the next strikes on, one strike with the space between: ${await marks(2)}`);
  await commit();
  console.log('PASS ⌫ strikes a word at a time');

  await clickAt(2, gapAfterWords); // the gap just past the strike
  await backspaces(1);
  assert.match(await marks(2), /has \[some \]words and/, `⌫ on a struck word brings it back whole: ${await marks(2)}`);
  await backspaces(1);
  assert.equal(await marks(2), text, 'the next brings the word before back');
  await backspaces(1);
  assert.match(await marks(2), /2 \[has \]some/, `once the strikes are back, the next press strikes on: ${await marks(2)}`);
  await commit();
  console.log('PASS a struck word comes back whole');

  await clickAt(3, text.indexOf(' and'));
  await page.keyboard.type('very old');
  assert.match(await marks(3), /words\{ very old\} and/, await marks(3));
  await holdBackspace(900);
  assert.equal(await marks(3), text.replace('Paragraph 2', 'Paragraph 3'), `held, ⌫ takes back your words and stops at the page's text: ${await marks(3)}`);
  await commit();
  console.log('PASS held ⌫ takes back your words and stops where they end');

  await clickAt(4, text.length - 1, { side: 'right' }); // after the paragraph's last word
  await holdBackspace(600);
  const held = await marks(4);
  const struckWords = (held.match(/\[([^\]]*)\]/) || ['', ''])[1].trim().split(/\s+/).filter(Boolean).length;
  assert.ok(struckWords >= 2 && struckWords <= 6, `a held ⌫ strikes a few words a second, not a word per key repeat: ${struckWords} in 600 ms: ${held}`);
  await commit();
  console.log(`PASS held ⌫ goes at a reading pace (${struckWords} words in 600 ms)`);

  await clickAt(5, text.indexOf(' and'));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('x');
  assert.match(await marks(5), /some\{ x\} words and/, `← moves to the end of the word before, where a word gets its own space: ${await marks(5)}`);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('y');
  assert.match(await marks(5), /words and\{ y\} enough/, `→ moves a word at a time: ${await marks(5)}`);
  await commit();
  console.log('PASS arrows move a word at a time');

  await clickAt(6, text.indexOf(' and'));
  await backspaces(1); // strike "words"
  await commit();
  await clickAt(6, text.indexOf('words') + 2); // on the struck word: the edit reopens after it
  await backspaces(1);
  assert.equal(await marks(6), text.replace('Paragraph 2', 'Paragraph 6'), `a click on your strike, then ⌫, brings it back: ${await marks(6)}`);
  console.log('PASS a click on your own strike reopens the edit after the word');

  await clickAt(7, gapAfterWords);
  await backspaces(2); // strike "some words", one strike with the space between
  await commit();
  await clickAt(7, text.indexOf('words') + 2); // take back "words"
  await backspaces(1);
  await clickAt(7, text.indexOf('some') + 2); // then "some"
  await backspaces(1);
  assert.equal(await marks(7), text.replace('Paragraph 2', 'Paragraph 7'), `taking back both words brings back the space between: ${await marks(7)}`);
  console.log('PASS taking back two struck words one by one leaves no struck space');

  await commit();
  await clickAt(8, gapAfterWords);
  await backspaces(1); // strike "words": the caret rests at its start
  await page.keyboard.type('terms');
  assert.match(await marks(8), /some \{terms \}\[words\] and/, `typing where a strike left the caret makes a new word: ${await marks(8)}`);
  console.log('PASS typing at a resting caret makes a new word');

  assert.deepEqual(errors, [], 'no renderer errors');
} finally {
  await app.close();
}
