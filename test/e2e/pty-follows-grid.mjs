// The pty must be told every size the terminal grid takes, not only the sizes
// a window resize produces. The launcher strip takes rows from the grid when
// it mounts and gives them back when it goes, with the window unchanged; a
// window resized while the strip is up used to leave the pty at the short
// height once a CLI started and the strip went. The CLI (and ConPTY behind
// it, on Windows) then drew for a shorter screen than the one shown: scrolls
// landed short, so new lines painted over the ones before them, until the
// next window resize. A recorder stands in for main; the grid's own size is
// read back from the terminal with a cursor-position report.
// Run after npm run build: node test/e2e/pty-follows-grid.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launchElectron } from './electron.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-pty-size-'));
const preload = fs.readFileSync(path.join(repo, 'src/preload.js'), 'utf8');
fs.writeFileSync(path.join(tmp, 'preload.js'), preload.replace('platform: process.platform', "platform: 'win32'"));
fs.writeFileSync(path.join(tmp, 'main.cjs'), `
  const { app, BrowserWindow, ipcMain } = require('electron');
  ipcMain.on('pty-start', (_event, size) => { globalThis.size = size; });
  ipcMain.on('pty-resize', (_event, size) => { globalThis.size = size; });
  ipcMain.handle('get-double-click-interval', () => 500);
  app.whenReady().then(() => {
    const win = new BrowserWindow({ width: 1000, height: 650,
      webPreferences: { preload: require('node:path').join(__dirname, 'preload.js'),
        backgroundThrottling: false } });
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
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' });

  const send = (channel, payload) => app.evaluate(({ BrowserWindow }, [c, p]) => {
    BrowserWindow.getAllWindows()[0].webContents.send(c, p);
  }, [channel, payload]);
  // Park the cursor past the bottom-right corner, which the grid clamps, and
  // ask where it is. The reply also proves every earlier message was handled.
  const gridSize = () => app.evaluate(({ BrowserWindow, ipcMain }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener('pty-input', onInput);
      reject(new Error('No cursor-position reply'));
    }, 3000);
    function onInput(_event, reply) {
      const m = /^\x1b\[(\d+);(\d+)R$/.exec(reply);
      if (!m) return;
      clearTimeout(timer);
      ipcMain.removeListener('pty-input', onInput);
      resolve({ cols: Number(m[2]), rows: Number(m[1]) });
    }
    ipcMain.on('pty-input', onInput);
    BrowserWindow.getAllWindows()[0].webContents.send('pty-output', '\x1b7\x1b[999;999H\x1b[6n\x1b8');
  }));
  const ptySize = () => app.evaluate(() => globalThis.size);
  // A re-fit and its pty message can trail the event that caused them by a
  // frame or a timer tick, so settle on the grid before comparing.
  async function expectSameSize(label) {
    let grid;
    let pty;
    for (let i = 0; i < 20; i++) {
      grid = await gridSize();
      pty = await ptySize();
      if (grid.rows === pty.rows && grid.cols === pty.cols) return grid;
      await page.waitForTimeout(100);
    }
    assert.deepEqual(pty, grid, `${label}: the pty must have the grid's size`);
  }

  const full = await expectSameSize('at start');

  await send('show-picker', { sessions: [], activeIds: [], cwd: tmp });
  await page.waitForSelector('.at-launcher');
  const withStrip = await expectSameSize('launcher strip shown');
  assert.ok(withStrip.rows < full.rows, 'the strip takes rows from the grid');

  await page.keyboard.press('Escape');
  await page.waitForSelector('.at-picker-overlay', { state: 'detached' });
  assert.equal(await page.locator('.at-launcher').count(), 1, 'the strip stays when the picker goes');

  // A window resize while the strip is up: the pty gets the strip's height.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1000, win.getContentSize()[1] + 120);
  });
  let resized;
  for (let i = 0; i < 20 && !(resized && resized.rows > withStrip.rows); i++) {
    await page.waitForTimeout(100);
    resized = await gridSize();
  }
  assert.ok(resized.rows > withStrip.rows, 'the grid follows the window');
  const resizedWithStrip = await expectSameSize('window resized under the strip');

  // A CLI starting takes the strip with it, and its rows return to the grid.
  await send('chrome-state', { cli: 'agent' });
  await page.waitForSelector('.at-launcher', { state: 'detached' });
  const afterStrip = await expectSameSize('strip gone after the CLI started');
  assert.ok(afterStrip.rows > resizedWithStrip.rows, "the strip's rows return to the grid");

  assert.deepEqual(errors, [], 'no renderer exceptions');
  console.log(`PASS pty follows the grid: ${full.rows} rows, ${withStrip.rows} with the strip, `
    + `${resizedWithStrip.rows} -> ${afterStrip.rows} after a resize under the strip and a CLI start`);
} finally {
  if (app) await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
