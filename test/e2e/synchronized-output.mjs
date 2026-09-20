// Exercise the shipped renderer through PTY IPC on both rendering paths:
// macOS uses DOM; Windows (including WSL launches) uses WebGL. No agent or
// shell is started. DSR replies prove the bytes have been parsed before we
// compare the painted screen, so a held redraw cannot pass by reading too soon.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launchElectron } from './electron.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-sync-output-'));
const preload = fs.readFileSync(path.join(repo, 'src/preload.js'), 'utf8');
const BEGIN = '\x1b[?2026h';
const END = '\x1b[?2026l';

async function exercise(platform) {
  const dir = path.join(tmp, platform);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'preload.js'),
    preload.replace('platform: process.platform', `platform: '${platform}'`));
  fs.writeFileSync(path.join(dir, 'main.cjs'), `
    const { app, BrowserWindow, ipcMain } = require('electron');
    globalThis.typed = [];
    globalThis.diagnostics = [];
    ipcMain.on('pty-input', (_event, data) => globalThis.typed.push(data));
    ipcMain.on('pty-start', (_event, size) => { globalThis.size = size; });
    ipcMain.on('pty-resize', (_event, size) => { globalThis.size = size; });
    ipcMain.on('renderer-diagnostic', (_event, data) => globalThis.diagnostics.push(data));
    ipcMain.handle('get-double-click-interval', () => 500);
    app.whenReady().then(() => {
      const win = new BrowserWindow({ width: 1000, height: 650,
        webPreferences: { preload: require('node:path').join(__dirname, 'preload.js'),
          backgroundThrottling: false } });
      win.loadFile(${JSON.stringify(path.join(repo, 'src/index.html'))});
    });
    app.on('window-all-closed', () => app.quit());
  `);

  const app = await launchElectron({
    executablePath: require('electron'),
    args: ['--no-sandbox', path.join(dir, 'main.cjs')],
    timeout: 30_000,
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' });
    await page.locator('.xterm-helper-textarea').focus();
    const screen = page.locator('.xterm-screen');
    const size = await app.evaluate(() => globalThis.size);
    const row = size.rows - 3;
    const home = `\x1b[${row};3H`;
    const paint = () => page.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const raw = data => app.evaluate(({ BrowserWindow }, chunk) => {
      BrowserWindow.getAllWindows()[0].webContents.send('pty-output', chunk);
    }, data);
    const send = data => app.evaluate(({ BrowserWindow, ipcMain }, chunk) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ipcMain.removeListener('pty-input', onData);
          reject(new Error('No terminal cursor-position reply'));
        }, 3000);
        function onData(_event, reply) {
          if (!/^\x1b\[\d+;\d+R$/.test(reply)) return;
          clearTimeout(timeout);
          ipcMain.removeListener('pty-input', onData);
          resolve(reply);
        }
        ipcMain.on('pty-input', onData);
        BrowserWindow.getAllWindows()[0].webContents.send('pty-output', chunk + '\x1b[6n');
      }), data);

    await send(`\x1b[2J\x1b[HPrevious complete frame\x1b[${row};1H> Ask Codex to do anything${home}\x1b[2 q\x1b[?25h`);
    await paint();
    // Refuse a silent WebGL fallback: both renderers must actually be exercised.
    assert.equal(await page.locator('.xterm-rows').count(), platform === 'darwin' ? 1 : 0,
      `${platform}: expected ${platform === 'darwin' ? 'DOM' : 'WebGL'} rendering`);
    if (platform === 'win32') assert.ok(await screen.locator('canvas').count());
    await send('\x1b[?2026$p');
    assert.ok(await app.evaluate(() => globalThis.typed.includes('\x1b[?2026;2$y')),
      'the terminal must advertise synchronized-output support');

    const before = await screen.screenshot();
    // Split a control sequence itself, as well as the redraw, across IPC chunks.
    await raw('\x1b[?20');
    await paint();
    const reply = await send(`26h\x1b[1;1HNext complete frame    \x1b[${row + 1};47H.`);
    assert.equal(reply, `\x1b[${row + 1};48R`, 'the parser reached the temporary cursor position');
    await paint();
    assert.ok(before.equals(await screen.screenshot()),
      'neither partial text nor the cursor at the drawing position may be painted');
    await page.keyboard.type('x');
    assert.ok(await app.evaluate(() => globalThis.typed.includes('x')),
      'input remains responsive while output painting is held');
    await send(home + END);
    await paint();
    assert.ok(!before.equals(await screen.screenshot()), 'the completed frame must be painted');
    if (platform === 'darwin') {
      const cursor = await page.locator('.xterm-cursor').evaluate(el => ({
        row: [...el.parentElement.parentElement.children].indexOf(el.parentElement),
        text: el.textContent,
      }));
      assert.deepEqual(cursor, { row: row - 1, text: 'A' }, 'the cursor returns to the input');
    }
    console.log(`PASS ${platform}: split redraw holds text and cursor; completion paints; input stays live`);

    // A missing end marker must recover rather than freezing output forever.
    const complete = await screen.screenshot();
    await send(BEGIN + '\x1b[1;1HRecovered after timeout' + home);
    await paint();
    assert.ok(complete.equals(await screen.screenshot()), 'unfinished redraw initially stays hidden');
    await page.waitForTimeout(1200);
    assert.ok(!complete.equals(await screen.screenshot()), 'the safety timeout releases an unfinished redraw');
    await send(END);
    console.log(`PASS ${platform}: unfinished redraw recovers on timeout`);

    // Sustained Codex-shaped redraws: a visible frame counter, moving sparkle,
    // and cursor restoration. Split each frame's body/end across PTY events.
    await app.evaluate(({ BrowserWindow }, { row, home }) => {
      const win = BrowserWindow.getAllWindows()[0];
      globalThis.frame = 0;
      globalThis.animation = setInterval(() => {
        const frame = ++globalThis.frame;
        win.webContents.send('pty-output', '\x1b[?2026h\x1b[1;1HFrame ' + String(frame).padStart(5, '0')
          + '\x1b[K\x1b[' + (row + 1) + ';1H\x1b[2K\x1b[' + (row + 1) + ';' + (20 + frame % 30) + 'H.');
        globalThis.frameEnd = setTimeout(() => {
          win.webContents.send('pty-output', home + '\x1b[?2026l');
        }, 2);
      }, 16);
    }, { row, home });
    const frames = new Set();
    try {
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(60);
        frames.add((await screen.screenshot()).toString('base64'));
      }
    } finally {
      await app.evaluate(() => { clearInterval(globalThis.animation); clearTimeout(globalThis.frameEnd); });
      await send(home + END);
    }
    assert.ok(frames.size >= 8, `animation stalled: only ${frames.size} distinct paints in 12 samples`);
    console.log(`PASS ${platform}: sustained animation (${frames.size}/12 distinct paints)`);

    await app.evaluate(() => { globalThis.typed = []; });
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      await page.keyboard.press(`Alt+${key}`);
    }
    // A protocol round trip also drains the preceding keyboard IPC messages.
    await send('');
    const arrowInput = await app.evaluate(() => globalThis.typed.filter(data => !/^\x1b\[\d+;\d+R$/.test(data)));
    assert.deepEqual(arrowInput, platform === 'darwin'
      ? ['\x1bb', '\x1bf', '\x1b[1;3A', '\x1b[1;3B']
      : ['\x1b[1;5D', '\x1b[1;5C', '\x1b[1;5A', '\x1b[1;5B'],
    'Alt/Option arrows must emit the existing platform sequences exactly once');
    console.log(`PASS ${platform}: Alt/Option arrow navigation`);

    await send(Array.from({ length: 100 }, (_, i) => `\r\nScrollback row ${i}`).join(''));
    await paint();
    const bottom = await screen.screenshot();
    await screen.hover();
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(150);
    const scrolled = await screen.screenshot();
    assert.ok(!bottom.equals(scrolled), 'wheel scroll reaches scrollback');
    await send('\r\nNew output while reading history\r\nMore output\r\n');
    await paint();
    assert.ok(scrolled.equals(await screen.screenshot()),
      'new output must not steal the viewport from manual scrollback');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 560));
    await page.waitForTimeout(150);
    const resized = await app.evaluate(() => globalThis.size);
    assert.ok(resized.cols < size.cols && resized.rows < size.rows, 'fit and PTY resize follow the window');
    assert.equal(await page.locator('.xterm-decoration-overview-ruler').count(), 1, 'comment ruler remains available');
    assert.deepEqual(errors, [], 'no renderer exceptions');
    const diagnostics = await app.evaluate(() => globalThis.diagnostics);
    assert.ok(!diagnostics.some(message => /webgl (load-failed|context-lost)/.test(message)));
    console.log(`PASS ${platform}: scrollback, resize, and overview ruler`);
  } finally {
    await app.close();
  }
}

try {
  await exercise('darwin');
  await exercise('win32');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
