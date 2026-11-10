// Ctrl/Cmd+Shift+N must work while a review's webview owns the keyboard.
// Drive real input through Electron; stub only the successor process spawn.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchElectron } from './electron.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'at-new-window-shortcut-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'e2e');
git('config', 'user.email', 'e2e@example.invalid');
fs.writeFileSync(path.join(repo, 'f.js'), 'export const a = 1;\n');
git('add', '.');
git('commit', '-qm', 'Base');
const base = git('rev-parse', 'HEAD');
fs.appendFileSync(path.join(repo, 'f.js'), 'export const b = 2;\n');
git('commit', '-qam', 'Add b');
const dir = path.join(repo, '.git', 'review', 'main');
fs.mkdirSync(dir, { recursive: true });
const pkg = path.join(dir, 'main.md');
fs.writeFileSync(pkg, `---\nrange: ${base}..HEAD\n---\n\n# Review\n\nA change to f.js.\n\n:::diff f.js\n`);

// Load the real main process with its spawn dependency replaced before it is
// imported. Every shortcut still runs launchNewInstance, including its cwd
// selection and launch announcement, without leaving detached children.
const bootstrap = path.join(tmp, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
  const { EventEmitter } = require('node:events');
  globalThis.__newInstanceLaunches = [];
  require(${JSON.stringify(path.join(APP_DIR, 'src/relaunch.js'))}).spawnNewInstance = (argv, execPath, options) => {
    globalThis.__newInstanceLaunches.push({ cwd: options.env.AGENT_TERM_START_CWD });
    const child = new EventEmitter();
    child.pid = 12345;
    process.nextTick(() => child.emit('exit', 0));
    return child;
  };
  require(${JSON.stringify(path.join(APP_DIR, 'src/main.js'))});
`);

let app;
try {
  app = await launchElectron({
    executablePath: require('electron'),
    args: ['--no-sandbox', `--user-data-dir=${path.join(tmp, 'userdata')}`, bootstrap],
    env: { ...process.env, AGENT_TERM_START_CWD: repo, AGENT_STREAM_HUB_URL: '/', TMUX: '', STY: '', ZELLIJ: '' },
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea');
  await page.waitForSelector('.at-picker-overlay');
  await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`echo review://${pkg}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.vb-shell.vb-web.open.vb-full');

  const guestCode = code => app.evaluate(({ webContents }, code) => {
    const guest = webContents.getAllWebContents().find(w => w.getType() === 'webview');
    return guest.executeJavaScript(code);
  }, code);
  await guestCode(`new Promise(resolve => {
    const ready = () => {
      if (document.body?.dataset.review) resolve(true);
      else setTimeout(ready, 50);
    };
    ready();
  })`);

  const launches = () => app.evaluate(() => globalThis.__newInstanceLaunches);
  const press = (surface, modifiers, keyCode = 'N', types = ['keyDown', 'keyUp']) =>
    app.evaluate(({ BrowserWindow, webContents }, { surface, modifiers, keyCode, types }) => {
      const contents = surface === 'guest'
        ? webContents.getAllWebContents().find(w => w.getType() === 'webview')
        : BrowserWindow.getAllWindows()[0].webContents;
      contents.focus();
      for (const type of types) contents.sendInputEvent({ type, keyCode, modifiers });
    }, { surface, modifiers, keyCode, types });
  const checkLaunch = async (name, surface, modifiers) => {
    const before = (await launches()).length;
    await press(surface, modifiers);
    await page.waitForTimeout(200);
    const after = await launches();
    assert.equal(after.length, before + 1, `${name}: exactly one launch per press`);
    assert.equal(after.at(-1).cwd, repo, `${name}: launch directory is preserved`);
    console.log(`PASS ${name}`);
  };

  await checkLaunch('Ctrl+Shift+N in a full review', 'guest', ['control', 'shift']);
  await checkLaunch('Cmd+Shift+N in a full review', 'guest', ['meta', 'shift']);

  const beforeOrdinary = (await launches()).length;
  await guestCode(`
    window.__ordinaryN = 0;
    document.addEventListener('keydown', e => {
      if (e.key.toLowerCase() === 'n') window.__ordinaryN++;
    });
  `);
  await press('guest', []);
  await press('guest', ['control']);
  await press('guest', ['shift']);
  await press('guest', ['control', 'shift'], 'N', ['keyUp']);
  await page.waitForTimeout(200);
  assert.equal((await launches()).length, beforeOrdinary, 'ordinary input and key-up must not launch');
  assert.equal(await guestCode('window.__ordinaryN'), 3, 'ordinary keys still reach the review');
  console.log('PASS ordinary input remains in the review; key-up does not launch');

  // The existing guest-to-host viewer shortcut must keep working too.
  await press('guest', ['control', 'shift'], 'I');
  await page.waitForFunction(() => {
    const shell = document.querySelector('.vb-shell.vb-web');
    return shell.classList.contains('open') && !shell.classList.contains('vb-full');
  });
  await checkLaunch('Ctrl+Shift+N in a split review', 'guest', ['control', 'shift']);
  await press('guest', ['control', 'shift'], 'I');
  await page.waitForSelector('.vb-shell.vb-web.open.vb-full');
  await page.locator('.xterm-helper-textarea').focus();
  await checkLaunch('Ctrl+Shift+N on the host with the full review open', 'host', ['control', 'shift']);

  // A newly created generic webview needs the same app shortcut without any
  // review preload or privileged page-to-host IPC.
  await page.locator('.vb-web .vb-close').click();
  await page.locator('.xterm-helper-textarea').focus();
  const ordinaryPage = pathToFileURL(path.join(APP_DIR, 'test/fixtures/e2e-link-popup.html')).href;
  await page.keyboard.type(`echo ${ordinaryPage}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.vb-shell.vb-web.open');
  await guestCode('document.readyState');
  await checkLaunch('Ctrl+Shift+N in a generic webview', 'guest', ['control', 'shift']);
} finally {
  try { if (app) await app.close(); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
