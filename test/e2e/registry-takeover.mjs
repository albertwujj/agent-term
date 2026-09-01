// End-to-end test for the active-window registry against an isolated userData
// dir (--user-data-dir). Launches the REAL app and drives the main process
// through ipcMain, asserting on the files other windows would read:
//
//   1. startup compaction is skipped while another window's record is live
//   2. picking a session another window holds brings that window forward
//      instead of taking its id (the picker's list may be hours old)
//   3. a resume writes the record under this process's pid
//   4. when another live window is handed the id, the next heartbeat exits
//      this window as superseded: no closed/lost event, successor's record kept
//
// The fourth check waits for a real ACTIVITY_REFRESH_MS heartbeat (30s).
// Run: npm run test:e2e

import { _electron as electron } from 'playwright-core';
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
const UD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-registry-e2e-')));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0; const failures = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const old = Date.now() - 60 * 86400e3;
sessionsLog.appendEvent(UD, { t: old, e: 'started', id: 1, hue: 0 });
sessionsLog.appendEvent(UD, { t: old, e: 'closed', id: 1 });
for (const [id, hue, prompt] of [[5, 100, 'live one'], [6, 200, 'resumable one']]) {
  sessionsLog.appendEvent(UD, { e: 'started', id, hue, token: 'tok' + id });
  sessionsLog.appendEvent(UD, { e: 'cli', id, cli: 'true' });
  sessionsLog.appendEvent(UD, { e: 'prompt', id, prompt });
  sessionsLog.appendEvent(UD, { e: 'cwd', id, cwd: UD });
}
// Session 5 is held by THIS node process: alive, current boot, current compositor.
sessionsLog.writeActiveFile(UD, 5, { pid: process.pid, bootTime: sessionsLog.currentBootTime(), guiSession: guiSession.currentGuiSession(), token: 'tok5', hue: 100, lastInputAt: Date.now(), lastWorkingAt: 0, lastPromptAt: Date.now(), hiddenAt: null });

const app = await electron.launch({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', `--user-data-dir=${UD}`, APP_DIR], timeout: 45_000 });
const exited = new Promise(r => app.process().once('exit', (code) => r(code)));
const page = await app.firstWindow();
await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
await sleep(1500);
const ud = await app.evaluate(({ app }) => app.getPath('userData'));
const appPid = await app.evaluate(() => process.pid);
check('userData is the isolated dir', ud === UD, ud);
if (ud !== UD) { await app.close(); process.exit(1); }

// Startup: compaction guarded by the live record of session 5.
check('compaction skipped while another window is live', sessionsLog.readLog(UD).some(e => e.id === 1));
check('disk log created', fs.existsSync(path.join(UD, 'logs', `main-${appPid}.log`)));

// Pick-time liveness: picking a session another window holds brings it forward.
await app.evaluate(({ ipcMain }) => { ipcMain.emit('picker-pick', {}, 5); });
await sleep(800);
let ctl = null; try { ctl = JSON.parse(fs.readFileSync(path.join(UD, 'cap-control', '5.json'), 'utf8')); } catch {}
check('live session picked -> show control sent to its holder', ctl && ctl.action === 'show', JSON.stringify(ctl));
check('live session picked -> its record untouched', sessionsLog.readActiveFile(UD, 5).pid === process.pid);

// Resume a session nobody holds: this window takes the id and writes the record.
await app.evaluate(({ ipcMain }) => { ipcMain.emit('picker-pick', {}, 6); });
await sleep(1500);
const rec6 = sessionsLog.readActiveFile(UD, 6);
check('resume writes the active record under the app pid', rec6 && rec6.pid === appPid, JSON.stringify(rec6));

// Takeover: another live window now holds 6. The next heartbeat must exit this one as superseded.
sessionsLog.writeActiveFile(UD, 6, { ...rec6, pid: process.pid });
const t0 = Date.now();
const code = await Promise.race([exited, sleep(50_000).then(() => 'timeout')]);
check('superseded window exits within a heartbeat interval', code !== 'timeout', `after ${Math.round((Date.now() - t0) / 1000)}s: ${code}`);
const diskLog = fs.readFileSync(path.join(UD, 'logs', `main-${appPid}.log`), 'utf8');
check('disk log records the reason', /is held by another window; this window is gone, exiting/.test(diskLog), diskLog.slice(-300));
const events6 = sessionsLog.readLog(UD).filter(e => e.id === 6 && (e.e === 'closed' || e.e === 'lost'));
check('no closed/lost event for the successor\'s session', events6.length === 0, JSON.stringify(events6));
check('successor\'s record left in place', sessionsLog.readActiveFile(UD, 6).pid === process.pid);
if (code === 'timeout') { try { await app.close(); } catch {} }
try { fs.rmSync(UD, { recursive: true, force: true }); } catch {}
console.log(`\nregistry-takeover: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
