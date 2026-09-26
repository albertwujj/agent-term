// End-to-end test for auto-hide (docs/dev/auto-hide.md) against an isolated
// userData dir. Launches the REAL app; the other "windows" are active records
// held by this node process, so they read as live without being windows.
//
//   1. opening a window asks stale windows to hide, and only those: a working
//      one and one written by an older build are left alone
//   2. a stale window asked to hide leaves the screen (and, on macOS, the Dock)
//   3. a picker's 'show' brings it back in front with its timer restarted
//   4. a turn its agent finishes while hidden brings it back without focus
//   5. past MAX_LIVE live sessions, a hidden window whose timer is among the
//      oldest closes itself and is recorded as closed
//   6. a fresh window whose picker brings a live session forward closes once
//      that session's window is back
//   7. closing a session's window hides it, even while its agent works; a
//      window with no session closes, and closing the last visible window
//      opens a fresh one
//
// The input clock is advanced by rewriting its file; the working grace is
// shortened through AGENT_TERM_WORKING_GRACE_MS. The cap check runs on the
// once-a-minute health timer, so the last step waits up to ~70s.
// Run: node test/e2e/auto-hide.mjs

import { launchElectron } from './electron.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const sessionsLog = require(path.join(APP_DIR, 'src', 'sessions-log.js'));
const guiSession = require(path.join(APP_DIR, 'src', 'gui-session.js'));
const { MAX_LIVE } = require(path.join(APP_DIR, 'src', 'window-cap.js'));
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
// realpath: Electron reports userData resolved through /var -> /private/var.
const UD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-auto-hide-e2e-')));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0; const failures = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const CLOCK_FILE = path.join(UD, 'input-clock.json');
const readClock = () => JSON.parse(fs.readFileSync(CLOCK_FILE, 'utf8')).minutes;
// Move the input clock far past every timer, as an hour of work elsewhere would.
const advanceClock = () => {
  const minutes = readClock() + 1000;
  fs.writeFileSync(CLOCK_FILE, JSON.stringify({ minutes, minute: Math.floor(Date.now() / 60_000) }));
  return minutes;
};
const control = (id, action) => {
  fs.mkdirSync(path.join(UD, 'cap-control'), { recursive: true });
  fs.writeFileSync(path.join(UD, 'cap-control', `${id}.json`), JSON.stringify({ action, t: Date.now() }));
};
const readControl = (id) => { try { return JSON.parse(fs.readFileSync(path.join(UD, 'cap-control', `${id}.json`), 'utf8')); } catch { return null; } };
const heldHere = (fields) => ({ pid: process.pid, bootTime: sessionsLog.currentBootTime(), guiSession: guiSession.currentGuiSession(), ...fields });

fs.writeFileSync(CLOCK_FILE, JSON.stringify({ minutes: 500, minute: 0 }));
for (const [id, prompt] of [[5, 'stale one'], [6, 'resumable one'], [7, 'working one'], [8, 'older build']]) {
  sessionsLog.appendEvent(UD, { e: 'started', id, hue: id * 30, token: 'tok' + id });
  sessionsLog.appendEvent(UD, { e: 'cli', id, cli: 'true' });
  sessionsLog.appendEvent(UD, { e: 'prompt', id, prompt });
  sessionsLog.appendEvent(UD, { e: 'cwd', id, cwd: UD });
}
sessionsLog.writeActiveFile(UD, 5, heldHere({ token: 'tok5', touchedClock: 100, touchedAt: Date.now(), lastWorkingAt: 0, hiddenAt: null }));
sessionsLog.writeActiveFile(UD, 7, heldHere({ token: 'tok7', touchedClock: 100, touchedAt: Date.now(), lastWorkingAt: Date.now() + 3600e3, hiddenAt: null }));
sessionsLog.writeActiveFile(UD, 8, heldHere({ token: 'tok8', lastWorkingAt: 0, hiddenAt: null }));

const app = await launchElectron({
  executablePath: ELECTRON_BIN,
  args: ['--no-sandbox', `--user-data-dir=${UD}`, APP_DIR],
  env: { ...process.env, AGENT_TERM_WORKING_GRACE_MS: '2000' },
  timeout: 45_000,
});
let mainLog = '';
const proc = app.process();
proc.stdout.on('data', (d) => { mainLog += d.toString(); });
if (proc.stderr) proc.stderr.on('data', (d) => { mainLog += d.toString(); });
const exited = new Promise(r => proc.once('exit', (code) => r(code)));
async function waitForLog(re, timeoutMs, from = 0) {
  const t0 = Date.now();
  for (;;) {
    const m = mainLog.slice(from).match(re);
    if (m) return m;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(200);
  }
}
const windowState = () => app.evaluate(({ app, BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  return { visible: w.isVisible(), focused: w.isFocused(), dock: app.dock ? app.dock.isVisible() : null };
});
const blur = () => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].blur(); });

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  const ud = await app.evaluate(({ app }) => app.getPath('userData'));
  check('userData is the isolated dir', ud === UD, ud);

  // 1. The opening asks the stale window, and only it.
  check('opening asks the stale window to hide', !!(await waitForLog(/asked stale sessions to hide: 5\b/, 10_000)));
  check('stale window got a hide message', (readControl(5) || {}).action === 'hide');
  check('working window left alone', readControl(7) === null);
  check('older-build window left alone', readControl(8) === null);

  // This window becomes session 6.
  await app.evaluate(({ ipcMain }) => { ipcMain.emit('picker-pick', {}, 6); });
  await sleep(2000);
  await page.keyboard.press('Escape');   // the picker, and the armed /resume intercept
  let rec6 = sessionsLog.readActiveFile(UD, 6);
  check('the session record carries its timer', rec6 && typeof rec6.touchedClock === 'number', JSON.stringify(rec6));

  // 2. Stale, idle, unfocused: it hides when asked.
  const hideNow = async () => {
    advanceClock();
    await blur();
    const from = mainLog.length;
    control(6, 'hide');
    return waitForLog(/hiding session 6|staying: [a-z ]+/, 5000, from);
  };
  await sleep(7000);                     // past the 5s idle and the 2s grace since the shell's last output
  let hid = await hideNow();
  check('stale window hides when asked', hid && /hiding/.test(hid[0]), hid && hid[0]);
  await sleep(500);
  let state = await windowState();
  check('hidden window is off screen', state.visible === false, JSON.stringify(state));
  if (process.platform === 'darwin') check('hidden window is off the Dock', state.dock === false, JSON.stringify(state));
  rec6 = sessionsLog.readActiveFile(UD, 6);
  check('registry marks it hidden', rec6 && rec6.hiddenAt, JSON.stringify(rec6));

  // 3. Brought forward from a picker.
  control(6, 'show');
  await sleep(1500);
  state = await windowState();
  rec6 = sessionsLog.readActiveFile(UD, 6);
  check('shown window is on screen', state.visible === true, JSON.stringify(state));
  if (process.platform === 'darwin') check('shown window is back on the Dock', state.dock === true, JSON.stringify(state));
  check('registry marks it visible', rec6 && !rec6.hiddenAt, JSON.stringify(rec6));
  check('bringing it forward restarted its timer', rec6 && rec6.touchedClock === readClock(), `${rec6 && rec6.touchedClock} vs ${readClock()}`);
  check('bringing it forward focused it', state.focused === true, JSON.stringify(state));
  {
    advanceClock();
    const from = mainLog.length;
    control(6, 'hide');
    const m = await waitForLog(/hiding session 6|staying: [a-z ]+/, 5000, from);
    check('the focused window stays when asked to hide', m && m[0] === 'staying: focused', m && m[0]);
  }

  // 4. A turn that ends while hidden brings it back, without focus. The
  //    command stays quiet long enough to hide, then works ~20s untitled
  //    (past TURN_MIN_MS) and stops.
  await page.evaluate(() => { const ta = document.querySelector('.xterm-helper-textarea'); if (ta) ta.focus(); });
  await page.keyboard.type('sleep 9; for i in $(seq 20); do echo tick $i; sleep 1; done');
  await page.keyboard.press('Enter');
  await sleep(6500);
  hid = await hideNow();
  check('hides before the turn starts', hid && /hiding/.test(hid[0]), hid && hid[0]);
  const from = mainLog.length;
  const back = await waitForLog(/turn ended while hidden; bringing session 6 back/, 45_000, from);
  check('a finished turn brings the hidden window back', !!back);
  await sleep(1000);
  state = await windowState();
  rec6 = sessionsLog.readActiveFile(UD, 6);
  check('it is on screen again', state.visible === true, JSON.stringify(state));
  check('it came back without taking focus', state.focused === false, JSON.stringify(state));
  check('registry marks it visible again', rec6 && !rec6.hiddenAt, JSON.stringify(rec6));

  // A working window stays, however stale.
  await page.evaluate(() => { const ta = document.querySelector('.xterm-helper-textarea'); if (ta) ta.focus(); });
  await page.keyboard.type('for i in $(seq 6); do echo work $i; sleep 1; done');
  await page.keyboard.press('Enter');
  await sleep(3000);
  hid = await hideNow();
  check('a working window stays when asked to hide', hid && hid[0] === 'staying: working', hid && hid[0]);

  // 7a. Closing it hides it all the same. Sessions 7 and 8 read as visible,
  //     so no fresh window opens.
  {
    const from = mainLog.length;
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await sleep(800);
    state = await windowState();
    rec6 = sessionsLog.readActiveFile(UD, 6);
    check('closing a session window hides it', /window closed; hiding session 6/.test(mainLog.slice(from)));
    check('the closed window is off screen, its session alive', state.visible === false && rec6 && rec6.hiddenAt, JSON.stringify(state));
    check('with other windows visible, no fresh window opens', !/no visible window left/.test(mainLog.slice(from)));
    control(6, 'show');
    await sleep(1500);
    state = await windowState();
    check('the picker brings the closed session back', state.visible === true, JSON.stringify(state));
  }

  // 5. The live cap. Session 6 hides again; the fake session 5 is hidden with
  //    an older timer. Two sessions over the cap: 5 and 6 are the victims,
  //    and 6 closes itself at its next health check.
  await sleep(10000);
  hid = await hideNow();
  check('hides again', hid && /hiding/.test(hid[0]), hid && hid[0]);
  sessionsLog.writeActiveFile(UD, 5, heldHere({ token: 'tok5', touchedClock: 1, touchedAt: 1, lastWorkingAt: 0, hiddenAt: Date.now() }));
  const live = 4;                        // 5, 6, 7, 8
  for (let i = 0; i < MAX_LIVE + 2 - live; i++) {
    sessionsLog.writeActiveFile(UD, 20 + i, heldHere({ touchedClock: 0, touchedAt: 0, lastWorkingAt: 0, hiddenAt: null }));
  }
  const code = await Promise.race([exited, sleep(75_000).then(() => 'timeout')]);
  check('a hidden session past the cap closes itself', code !== 'timeout', String(code));
  check('the log says why', /closing hidden session 6: more than 8 sessions are live/.test(mainLog));
  const ended = sessionsLog.readLog(UD).filter(e => e.id === 6).map(e => e.e);
  check('it is recorded as closed', ended.includes('closed'), JSON.stringify(ended));
} finally {
  try { await app.close(); } catch {}
}

// 6. A picker window hands over to the session it found, then closes. The
//    fake session 7 reads as back at once (its record is not hidden).
{
  const b = await launchElectron({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', `--user-data-dir=${UD}`, APP_DIR],
    timeout: 45_000,
  });
  let bLog = '';
  b.process().stdout.on('data', (d) => { bLog += d.toString(); });
  const bExited = new Promise(r => b.process().once('exit', (code) => r(code)));
  try {
    const page = await b.firstWindow();
    await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
    try { fs.unlinkSync(path.join(UD, 'cap-control', '7.json')); } catch {}
    await b.evaluate(({ ipcMain }) => { ipcMain.emit('picker-bring-forward', {}, 7); });
    const code = await Promise.race([bExited, sleep(10_000).then(() => 'timeout')]);
    check('the found session is asked to show', (readControl(7) || {}).action === 'show');
    check('the picker window closes once it is back', code !== 'timeout', String(code));
    check('the log says so', /session 7 is back; closing the picker window/.test(bLog));
  } finally {
    try { await b.close(); } catch {}
  }
}

// 7b. A window with no session closes for real, and with every other session
//     hidden it is replaced by a fresh window.
{
  for (const id of sessionsLog.listActiveIds(UD)) {
    const rec = sessionsLog.readActiveFile(UD, id);
    if (rec && rec.pid === process.pid) sessionsLog.writeActiveFile(UD, id, { ...rec, hiddenAt: Date.now() });
  }
  const c = await launchElectron({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', `--user-data-dir=${UD}`, APP_DIR],
    timeout: 45_000,
  });
  let cLog = '';
  c.process().stdout.on('data', (d) => { cLog += d.toString(); });
  const cExited = new Promise(r => c.process().once('exit', (code) => r(code)));
  try {
    const page = await c.firstWindow();
    await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
    await c.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); }).catch(() => {});
    const code = await Promise.race([cExited, sleep(10_000).then(() => 'timeout')]);
    check('a window with no session closes for real', code !== 'timeout', String(code));
    check('the last visible window is replaced by a fresh one', /no visible window left; opening a fresh one/.test(cLog), cLog.slice(-400));
    const spawned = cLog.match(/\[new-instance\] spawned pid (\d+)/);
    check('the fresh window was spawned', !!spawned);
    if (spawned) { try { process.kill(Number(spawned[1]), 'SIGTERM'); } catch {} }
  } finally {
    try { await c.close(); } catch {}
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(mainLog.split('\n').filter(l => /auto-hide|resume/.test(l)).join('\n'));
  process.exit(1);
}
