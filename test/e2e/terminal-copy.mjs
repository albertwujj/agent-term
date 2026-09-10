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
import { _electron as electron } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
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
  app = await electron.launch({
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
  ];
  for (const [index, { key, raw, captured }] of cases.entries()) {
    if (index) await page.reload();
    await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' });
    const size = await app.evaluate(() => globalThis.size);
    await app.evaluate(({ BrowserWindow, clipboard }, captured) => {
      clipboard.writeText('');
      BrowserWindow.getAllWindows()[0].webContents.send('pty-output',
        (captured ? '\x1b[?1049h\x1b[?1003h\x1b[?1006h' : '')
        + '⏺ selected prose\r\n  wraps here\r\n• next item');
    }, !!captured);
    // Wait for xterm to parse and paint before selecting on its cell grid.
    await page.waitForTimeout(200);
    const rect = await page.locator('.xterm-screen').boundingBox();
    const cellWidth = rect.width / size.cols;
    const cellHeight = rect.height / size.rows;
    await page.keyboard.down('Shift');
    await page.mouse.move(rect.x + cellWidth * 0.1, rect.y + cellHeight * 0.5);
    await page.mouse.down();
    await page.mouse.move(rect.x + cellWidth * 11.1, rect.y + cellHeight * 2.5, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForSelector('.terminal-comment-selection-hint');
    await page.waitForSelector('.terminal-comment-mark', { state: 'attached' });

    if (captured) {
      // xterm treats the reported mouse move as input and clears its native
      // selection. The app's saved selection must still copy and then dismiss.
      await page.mouse.move(rect.x + cellWidth * 20, rect.y + cellHeight * 4.5);
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
      raw ? '⏺ selected prose\n  wraps here\n• next item' : 'selected prose wraps here\nnext item');
    assert.deepEqual(await app.evaluate(() => globalThis.typed), [], 'copy must send no input to the PTY');

    await page.keyboard.type('x');
    assert.equal(await page.locator('.terminal-comment-bubble').count(), 0,
      'typing after copy must not open a comment on the old selection');
    await page.keyboard.press('Enter');
    assert.deepEqual(await app.evaluate(() => globalThis.typed), ['x', '\r']);
    console.log(`PASS ${key} clears ${captured ? 'saved' : 'live'} selection and leaves subsequent typing to the shell`);
  }
  assert.deepEqual(errors, [], 'the renderer must run without errors');
} finally {
  if (app) await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
