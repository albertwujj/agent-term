// Exercise the complete renderer, including its saved comment selection and
// decoration cleanup. A PTY input recorder stands in for the shell. The real
// preload exposes win32 so WSLg/macOS also test the Windows copy gestures.
// Run after npm run build: node test/e2e/terminal-copy.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launchElectron } from './electron.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const quotedCopy = require('../fixtures/quoted-copy.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-copy-'));
const preload = fs.readFileSync(path.join(repo, 'src/preload.js'), 'utf8');
fs.writeFileSync(path.join(tmp, 'preload.js'), preload.replace('platform: process.platform', "platform: 'win32'"));
fs.writeFileSync(path.join(tmp, 'main.cjs'), `
  const { app, BrowserWindow, ipcMain } = require('electron');
  globalThis.typed = [];
  ipcMain.on('pty-input', (_event, data) => globalThis.typed.push(data));
  ipcMain.on('pty-start', (_event, size) => { globalThis.size = size; });
  ipcMain.on('pty-resize', (_event, size) => { globalThis.size = size; });
  ipcMain.handle('get-double-click-interval', () => 500);
  app.whenReady().then(() => {
    const win = new BrowserWindow({ width: 1000, height: 650,
      webPreferences: { preload: require('node:path').join(__dirname, 'preload.js') } });
    win.loadFile(${JSON.stringify(path.join(repo, 'src/index.html'))});
  });
  app.on('window-all-closed', () => app.quit());
`);

let app;
try {
  app = await launchElectron({
    executablePath: require('electron'),
    args: ['--no-sandbox', path.join(tmp, 'main.cjs')],
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const cases = [
    { key: 'Enter' },
    { key: 'NumpadEnter' },
    { key: 'Control+KeyC' },
    { key: 'Control+Shift+KeyC', raw: true },
    { key: 'Enter', captured: true },
    { key: 'Control+KeyC', captured: true },
    { key: 'Control+KeyC', quoted: true },
    { key: 'Control+KeyC', quoted: true, startColumn: 3 },
    { key: 'Control+KeyC', quoted: true, startColumn: 4 },
    { key: 'Control+KeyC', quoted: true, startColumn: 45 },
    { key: 'Control+KeyC', quoted: true, captured: true },
    { key: 'Enter', quoted: true },
    { key: 'Control+Shift+KeyC', quoted: true, raw: true },
  ];
  for (const [index, { key, raw, captured, quoted, startColumn = 0 }] of cases.entries()) {
    if (index) await page.reload();
    await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' });
    let size = await app.evaluate(() => globalThis.size);
    if (quoted && size.cols !== quotedCopy.cols) {
      const width = await page.evaluate(({ cols, target }) => Math.round(window.innerWidth
        + (target - cols) * document.querySelector('.xterm-screen').getBoundingClientRect().width / cols),
      { cols: size.cols, target: quotedCopy.cols });
      // Keep the screenshot's hard wraps inside the viewport, so xterm cannot
      // hide the regression by doing its own soft-wrap joining.
      await app.evaluate(({ BrowserWindow, ipcMain }, { width, cols }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ipcMain.removeListener('pty-resize', resized);
          reject(new Error(`Terminal did not resize to ${cols} columns`));
        }, 3000);
        function resized(_event, size) {
          if (size.cols !== cols) return;
          clearTimeout(timer);
          ipcMain.removeListener('pty-resize', resized);
          resolve();
        }
        ipcMain.on('pty-resize', resized);
        const win = BrowserWindow.getAllWindows()[0];
        win.setContentSize(width, win.getContentSize()[1]);
      }), { width, cols: quotedCopy.cols });
      size = await app.evaluate(() => globalThis.size);
    }
    // The first row runs to the terminal's right edge, so smart copy reads its
    // break as a wrap; "• next item" starts a line of its own.
    let first = '⏺ selected prose';
    while (first.length + 5 <= size.cols - 2) first += ' more';
    const lines = quoted ? quotedCopy.lines : [first, '  wraps here', '• next item'];
    const expected = quoted ? quotedCopy.paragraphs.join('\n\n').slice(Math.max(0, startColumn - 4))
      : `${first.slice(2)} wraps here\nnext item`;
    await app.evaluate(({ BrowserWindow, clipboard }, { captured, lines }) => {
      clipboard.writeText('');
      BrowserWindow.getAllWindows()[0].webContents.send('pty-output',
        (captured ? '\x1b[?1049h\x1b[?1003h\x1b[?1006h' : '')
        + lines.join('\r\n'));
    }, { captured: !!captured, lines });
    // Wait for xterm to parse and paint before selecting on its cell grid.
    await page.waitForTimeout(200);
    const rect = await page.locator('.xterm-screen').boundingBox();
    const cellWidth = rect.width / size.cols;
    const cellHeight = rect.height / size.rows;
    await page.keyboard.down('Shift');
    await page.mouse.move(rect.x + cellWidth * (startColumn + 0.5), rect.y + cellHeight * 0.5);
    await page.mouse.down();
    await page.mouse.move(rect.x + cellWidth * (lines.at(-1).length + 0.1),
      rect.y + cellHeight * (lines.length - 0.5), { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForSelector('.terminal-comment-selection-hint');
    await page.waitForSelector('.terminal-comment-mark', { state: 'attached' });

    if (captured) {
      // xterm treats the reported mouse move as input and clears its native
      // selection. The app's saved selection must still copy and then dismiss.
      await page.mouse.move(rect.x + cellWidth * 20, rect.y + cellHeight * (lines.length + 1.5));
      await page.waitForTimeout(200);
      assert.ok((await app.evaluate(() => globalThis.typed)).some(data => data.startsWith('\x1b[<')),
        'the TUI must receive a mouse report before testing its saved selection');
      assert.equal(await page.locator('.terminal-comment-selection-hint').count(), 1);
    }

    await page.locator('.xterm-helper-textarea').focus();
    await app.evaluate(() => { globalThis.typed = []; });
    await page.keyboard.press(key);
    await page.waitForFunction(() => !document.querySelector('.terminal-comment-selection-hint, .terminal-comment-mark'),
      undefined, { timeout: 3000 });
    // Catch a pending hint timer or animation frame restoring the highlight.
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.terminal-comment-selection-hint, .terminal-comment-mark').count(), 0,
      'copy must clear the selection highlight and hint permanently');
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()),
      raw ? [lines[0].slice(startColumn), ...lines.slice(1)].join('\n') : expected);
    assert.deepEqual(await app.evaluate(() => globalThis.typed), [], 'copy must send no input to the PTY');

    await page.keyboard.type('x');
    assert.equal(await page.locator('.terminal-comment-bubble').count(), 0,
      'typing after copy must not open a comment on the old selection');
    await page.keyboard.press('Enter');
    assert.deepEqual(await app.evaluate(() => globalThis.typed), ['x', '\r']);
    console.log(`PASS ${key} clears ${captured ? 'saved' : 'live'} selection${quoted ? ` of quote from column ${startColumn}` : ''} and leaves subsequent typing to the shell`);
  }
  assert.deepEqual(errors, [], 'the renderer must run without errors');
} finally {
  if (app) await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
