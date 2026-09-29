// End-to-end test: a hidden session brought back from the picker runs the
// current code (docs/dev/auto-hide.md). Launches the REAL app against an
// isolated userData dir.
//
//   1. a hidden window whose process started before the checkout last changed
//      closes when picked, and its session resumes in the picker's window
//   2. one whose agent is working comes back as it is, says it runs older
//      code, and the picker closes
//   3. one that comes back on its own after its agent's turn, on older code,
//      says so once it is in front, and not before
//
// The checkout changes for real: after each window under test starts, the
// test moves the mtime of src/build-info.json (a file nothing reads) to now,
// and restores it at the end. Other AgentTerm windows running from this
// checkout see the change while the test runs.
// Run: node test/e2e/unhide-older-code.mjs

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
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
// realpath: Electron reports userData resolved through /var -> /private/var.
const UD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-unhide-e2e-')));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0; const failures = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const MARKER = path.join(APP_DIR, 'src', 'build-info.json');
const markerStat = fs.statSync(MARKER);
const sourceChangesNow = () => { const now = new Date(); fs.utimesSync(MARKER, now, now); };

for (const [id, prompt] of [[6, 'idle one'], [8, 'working one'], [9, 'returning one']]) {
  sessionsLog.appendEvent(UD, { e: 'started', id, hue: id * 30, token: 'tok' + id });
  sessionsLog.appendEvent(UD, { e: 'cli', id, cli: 'true' });
  sessionsLog.appendEvent(UD, { e: 'prompt', id, prompt });
  sessionsLog.appendEvent(UD, { e: 'cwd', id, cwd: UD });
}
// A visible session held by this node process, so closing a window leaves one
// visible and no fresh window opens.
sessionsLog.writeActiveFile(UD, 7, { pid: process.pid, bootTime: sessionsLog.currentBootTime(), guiSession: guiSession.currentGuiSession(), touchedClock: 0, touchedAt: Date.now(), lastWorkingAt: 0, hiddenAt: null });

async function launch() {
  const app = await launchElectron({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', `--user-data-dir=${UD}`, APP_DIR],
    timeout: 45_000,
  });
  const w = { app, log: '' };
  app.process().stdout.on('data', (d) => { w.log += d.toString(); });
  w.exited = new Promise(r => app.process().once('exit', (code) => r(code)));
  w.page = await app.firstWindow();
  await w.page.waitForSelector('.at-picker-input', { timeout: 30_000 });
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
// Resume `id` in window `w`, then close its window: the session hides. The
// checkout then changes, so the window runs older code.
async function hiddenSession(w, id, command) {
  await w.app.evaluate(({ ipcMain }, id) => { ipcMain.emit('picker-pick', {}, id); }, id);
  await sleep(2000);
  await w.page.keyboard.press('Escape');   // the armed /resume intercept
  if (command) {
    await w.page.evaluate(() => { const ta = document.querySelector('.xterm-helper-textarea'); if (ta) ta.focus(); });
    await w.page.keyboard.type(command);
    await w.page.keyboard.press('Enter');
    await sleep(1500);
  }
  await w.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  const rec = await waitFor(() => { const r = sessionsLog.readActiveFile(UD, id); return r && r.hiddenAt ? r : null; }, 5000);
  await sleep(50);
  sourceChangesNow();
  return rec;
}
const cleanup = [];

try {
  // 1. Idle and on older code: it closes, and the session resumes in the picker.
  const a = await launch(); cleanup.push(a);
  const aPid = await a.app.evaluate(() => process.pid);
  await hiddenSession(a, 6);
  const p = await launch(); cleanup.push(p);
  await sleep(6000);                     // past the 5s of output that reads as working
  const pPid = await p.app.evaluate(() => process.pid);
  await p.app.evaluate(({ ipcMain }) => { ipcMain.emit('picker-bring-forward', {}, 6); });
  const aCode = await Promise.race([a.exited, sleep(10_000).then(() => 'timeout')]);
  check('the older window closes', aCode !== 'timeout', String(aCode));
  check('it says why', /session 6 started before the code changed; closing so it resumes on the current code/.test(a.log));
  const rec6 = await waitFor(() => { const r = sessionsLog.readActiveFile(UD, 6); return r && r.pid === pPid ? r : null; }, 5000);
  check('the session resumes in the picker window', !!rec6, JSON.stringify(sessionsLog.readActiveFile(UD, 6)));
  check('through its CLI, on the current code', /armed intercept after picker-pick id=6/.test(p.log));
  const told = await waitFor(() => p.page.evaluate(() => document.body.innerText.includes('So it resumes on the current code, through the CLI.')), 5000);
  check('the picker window says why it resumes through the CLI', !!told);
  check('the older window left a closed event', sessionsLog.readLog(UD).some(e => e.id === 6 && e.e === 'closed'));
  check('and exited on its own', aPid && !(() => { try { process.kill(aPid, 0); return true; } catch { return false; } })());

  // 2. Working and on older code: it comes back as it is; the picker closes.
  const b = await launch(); cleanup.push(b);
  await hiddenSession(b, 8, 'for i in $(seq 40); do echo work $i; sleep 1; done');
  const q = await launch(); cleanup.push(q);
  await q.app.evaluate(({ ipcMain }) => { ipcMain.emit('picker-bring-forward', {}, 8); });
  const qCode = await Promise.race([q.exited, sleep(10_000).then(() => 'timeout')]);
  check('a working window stays', /session 8 runs older code but stays: its agent is working/.test(b.log), b.log.split('\n').filter(l => /auto-hide/.test(l)).join(' | '));
  check('and comes back as it is', await b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()));
  check('the picker closes once it is back', qCode !== 'timeout', String(qCode));
  const banner = await waitFor(() => b.page.evaluate(() => document.body.innerText.includes('started before your latest code changes')), 5000);
  check('it says it runs older code', !!banner);

  // 3. Its turn ends while hidden: it comes back on its own, without focus,
  //    and the notice waits until it is in front.
  const c = await launch(); cleanup.push(c);
  await hiddenSession(c, 9, 'sleep 3; for i in $(seq 18); do echo tick $i; sleep 1; done');
  const back = await waitFor(() => /turn ended while hidden; bringing session 9 back/.test(c.log), 45_000);
  check('the returning window comes back after its turn', !!back);
  check('it knows it runs older code', !!(await waitFor(() => /session 9 came back on older code/.test(c.log), 5000)));
  const noticeShown = () => c.page.evaluate(() => document.body.innerText.includes('started before your latest code changes'));
  await sleep(1000);
  check('no notice while it is not in front', !(await noticeShown()));
  await c.app.evaluate(({ app, BrowserWindow }) => {
    if (process.platform === 'darwin') app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0].focus();
  });
  check('the notice shows once it is in front', !!(await waitFor(noticeShown, 5000)));
} finally {
  fs.utimesSync(MARKER, markerStat.atime, markerStat.mtime);
  if (failures.length) for (const w of cleanup) console.log('--- log\n' + w.log.split('\n').filter(l => /resume|auto-hide|picker/.test(l)).join('\n'));
  for (const w of cleanup) { try { await w.app.close(); } catch {} }
}

console.log(`\nunhide-older-code: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
