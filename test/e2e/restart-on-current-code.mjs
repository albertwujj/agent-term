// End-to-end test: the older-code notice restarts its session on the current
// code in one click. Launches the REAL app against an isolated userData dir.
// The window under test loads main with the successor spawn stubbed, so the
// click's launch is recorded and leaves no detached child; the test then
// starts the successor itself, with the environment the click asked for.
//
//   1. the notice carries the restart, and a click launches a window that is
//      told which session to carry on; the old window stays up meanwhile
//   2. that window takes the session over: the old one closes, the session
//      resumes there through its CLI, and no picker shows
//   3. a working agent keeps its window: the click is refused and says why
//   4. an agent that starts working before the new window is up keeps its
//      window too, and the new window closes
//
// Run: node test/e2e/restart-on-current-code.mjs

import { followMainLog, launchElectron } from './electron.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const sessionsLog = require(path.join(APP_DIR, 'src', 'sessions-log.js'));
const guiSession = require(path.join(APP_DIR, 'src', 'gui-session.js'));
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
// realpath: Electron reports userData resolved through /var -> /private/var.
const UD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-restart-e2e-')));
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-restart-boot-')));
const SHOTS = process.env.AGENT_TERM_E2E_SHOTS || null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0; const failures = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const BOOTSTRAP = path.join(T, 'bootstrap.cjs');
fs.writeFileSync(BOOTSTRAP, `
  const { EventEmitter } = require('node:events');
  globalThis.__newInstanceLaunches = [];
  require(${JSON.stringify(path.join(APP_DIR, 'src/relaunch.js'))}).spawnNewInstance = (argv, execPath, options) => {
    globalThis.__newInstanceLaunches.push({ resume: (options.env || {}).AGENT_TERM_RESUME_SESSION || null });
    const child = new EventEmitter();
    child.pid = 12345;
    return child;
  };
  require(${JSON.stringify(path.join(APP_DIR, 'src/main.js'))});
`);

for (const [id, prompt] of [[6, 'idle one'], [8, 'working one']]) {
  sessionsLog.appendEvent(UD, { e: 'started', id, hue: id * 30, token: 'tok' + id });
  sessionsLog.appendEvent(UD, { e: 'cli', id, cli: 'true' });
  sessionsLog.appendEvent(UD, { e: 'prompt', id, prompt });
  sessionsLog.appendEvent(UD, { e: 'cwd', id, cwd: UD });
}
// A visible session held by this node process, so a window that closes leaves
// one visible and no fresh window opens.
sessionsLog.writeActiveFile(UD, 7, { pid: process.pid, bootTime: sessionsLog.currentBootTime(), guiSession: guiSession.currentGuiSession(), touchedClock: 0, touchedAt: Date.now(), lastWorkingAt: 0, hiddenAt: null });

async function launch({ entry = APP_DIR, env = {} } = {}) {
  const app = await launchElectron({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', `--user-data-dir=${UD}`, entry],
    env: { ...process.env, ...env },
    timeout: 45_000,
  });
  const mainLog = await followMainLog(app);
  const w = { app, get log() { return mainLog.text; } };
  w.exited = new Promise(r => app.process().once('exit', (code) => r(code)));
  w.page = await app.firstWindow();
  await w.page.waitForSelector('.xterm-helper-textarea', { state: 'attached', timeout: 30_000 });
  return w;
}
async function waitFor(fn, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(200);
  }
}
// Resume `id` in window `w` and run `command` in its shell as its CLI: one
// foreground job that holds the terminal.
async function session(w, id, command) {
  await w.page.waitForSelector('.at-picker-input', { timeout: 30_000 });
  await w.app.evaluate(({ ipcMain }, id) => { ipcMain.emit('picker-pick', {}, id); }, id);
  await sleep(2000);
  await w.page.keyboard.press('Escape');   // the armed /resume intercept
  await w.page.evaluate(() => { const ta = document.querySelector('.xterm-helper-textarea'); if (ta) ta.focus(); });
  await w.page.keyboard.type(command);
  await w.page.keyboard.press('Enter');
}
const olderCode = (w) => w.app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0].webContents.send('older-code-notice');
});
const launches = (w) => w.app.evaluate(() => globalThis.__newInstanceLaunches);
const button = (w) => w.page.locator('.at-notice-standalone .at-notice-action');
const shot = async (w, name) => { if (SHOTS) await w.page.screenshot({ path: path.join(SHOTS, name) }); };
const cleanup = [];

try {
  console.log('1 — the notice restarts its session in one click');
  const a = await launch({ entry: BOOTSTRAP }); cleanup.push(a);
  await session(a, 6, 'sleep 600');
  await sleep(6000);   // past the 5s of output that reads as working
  await olderCode(a);
  await button(a).waitFor({ timeout: 5000 });
  check('the notice offers the restart', (await button(a).textContent()) === 'Restart on the new code');
  await shot(a, 'restart-notice.png');
  await button(a).click();
  const asked = await waitFor(async () => (await launches(a)).length, 5000);
  check('one window is launched', asked === 1, JSON.stringify(await launches(a)));
  check('told which session to carry on', (await launches(a))[0].resume === '6', JSON.stringify(await launches(a)));
  check('the button waits', await button(a).isDisabled() && (await button(a).textContent()) === 'Restarting…');
  check('the old window still holds the session', sessionsLog.isSessionActive(sessionsLog.readActiveFile(UD, 6)));

  console.log('2 — the new window takes the session over');
  const READY = path.join(UD, 'window-ready-e2e');
  const b = await launch({ env: { AGENT_TERM_RESUME_SESSION: '6', AGENT_TERM_READY_FILE: READY } }); cleanup.push(b);
  check('a window asked to say when it is up does', !!(await waitFor(() => fs.existsSync(READY), 5000)));
  check('and does not pass the request on', await b.app.evaluate(() => process.env.AGENT_TERM_READY_FILE === undefined));
  const bPid = await b.app.evaluate(() => process.pid);
  const aCode = await Promise.race([a.exited, sleep(10_000).then(() => 'timeout')]);
  check('the old window closes', aCode !== 'timeout', String(aCode));
  check('it says why', /session 6 closes; its new window resumes it/.test(a.log));
  const rec = await waitFor(() => { const r = sessionsLog.readActiveFile(UD, 6); return r && r.pid === bPid ? r : null; }, 8000);
  check('the session resumes in the new window', !!rec, JSON.stringify(sessionsLog.readActiveFile(UD, 6)));
  check('through its CLI', !!(await waitFor(() => /armed intercept after picker-pick id=6/.test(b.log), 5000)));
  check('with the resume band, and no banner', !!(await waitFor(() => b.page.evaluate(() => {
    const el = document.querySelector('.at-resume-hint');
    return !!el && !el.querySelector('.at-resume-hint-note');
  }), 5000)));
  check('and no picker', !(await b.page.evaluate(() => !!document.querySelector('.at-picker-input'))));
  check('the id does not reach the windows it opens', await b.app.evaluate(() => process.env.AGENT_TERM_RESUME_SESSION === undefined));
  await shot(b, 'restart-resumed.png');
  await b.app.close();
  cleanup.length = 0;

  console.log('3 — a working agent keeps its window');
  const c = await launch({ entry: BOOTSTRAP }); cleanup.push(c);
  await session(c, 8, '(for i in $(seq 60); do echo work $i; sleep 1; done)');
  await sleep(1500);
  await olderCode(c);
  await button(c).waitFor({ timeout: 5000 });
  await button(c).click();
  const toast = await waitFor(() => c.page.evaluate(() => document.body.innerText.includes('The agent is working. Restart once it is idle.')), 5000);
  check('the click says why it did not restart', !!toast);
  check('nothing is launched', (await launches(c)).length === 0);
  check('the button is back', !(await button(c).isDisabled()) && (await button(c).textContent()) === 'Restart on the new code');

  console.log('4 — an agent that started working before the new window is up');
  const d = await launch({ env: { AGENT_TERM_RESUME_SESSION: '8' } }); cleanup.push(d);
  check('the old window keeps the session', !!(await waitFor(() => /session 8 keeps its window: its agent started working/.test(c.log), 8000)));
  check('and says so', !!(await waitFor(() => c.page.evaluate(() => document.body.innerText.includes('The agent started working, so this window stays.')), 3000)));
  const dCode = await Promise.race([d.exited, sleep(15_000).then(() => 'timeout')]);
  check('the new window closes', dCode !== 'timeout', String(dCode));
  const cPid = await c.app.evaluate(() => process.pid);
  check('the session is still the old window\'s', (sessionsLog.readActiveFile(UD, 8) || {}).pid === cPid);
} catch (err) {
  failures.push('exception: ' + (err && err.stack || err));
  console.log('  ✗ ' + (err && err.stack || err));
} finally {
  for (const w of cleanup) { try { await w.app.close(); } catch {} }
  fs.rmSync(UD, { recursive: true, force: true });
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
