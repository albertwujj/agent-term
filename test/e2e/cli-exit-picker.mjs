// End-to-end test: a session's CLI exits, and its window starts over on the
// picker. Launches the REAL app against an isolated userData dir, with a fake
// `claude` on a PATH the test puts first: an executable, since the shell must
// see it take the terminal and give it back. It shows a title, then reads
// lines until `/exit`, or until Ctrl+C or Ctrl+D ends it.
//
//   1. a session whose CLI is running keeps its window through prompts
//   2. Ctrl+C: the session is recorded as closed, its record is released, the
//      window reads as a new one, and the picker opens with that session in it,
//      over a fresh shell in the same directory
//   3. a session started from that picker is a new one, under a token of its
//      own, on a cleared screen, and `/exit` ends it the same way
//   4. a CLI suspended with Ctrl+Z is still the window's: nothing ends
//   5. the ended session picked from the picker resumes in the same window
//   6. the checkout changed since the window started: the picker opens in a
//      new window instead, and this one closes once that window says it is up;
//      a launch that fails leaves the picker here
//
// The fake comes first on PATH through the rc files of a HOME the test owns,
// since a fresh shell keeps nothing the old one exported, and a profile of
// the real HOME may put the real CLI first. Main is loaded with the successor spawn
// stubbed, so case 6's launch is recorded and leaves no detached child. The
// checkout changes for real, as in unhide-older-code.mjs: the mtime of
// src/tools/protocol.md moves to now and is restored at the end.
//
// Run: node test/e2e/cli-exit-picker.mjs

import { followMainLog, launchElectron } from './electron.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const sessionsLog = require(path.join(APP_DIR, 'src', 'sessions-log.js'));
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0; const failures = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); } };

// realpath: Electron reports userData resolved through /var -> /private/var.
const UD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-cli-exit-e2e-')));
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-cli-exit-fake-')));
const BIN = path.join(T, 'bin');
const WHICH = path.join(T, 'which');
const TOKENS = path.join(T, 'tokens');
const OUT = path.join(T, 'out');
const WORK = path.join(T, 'work');
const HOME = path.join(T, 'home');
fs.mkdirSync(BIN);
fs.mkdirSync(WORK);
fs.mkdirSync(HOME);
for (const rc of ['.bashrc', '.zshrc', '.profile']) fs.writeFileSync(path.join(HOME, rc), `export PATH='${BIN}':"$PATH"\n`);
const MARKER = path.join(APP_DIR, 'src', 'tools', 'protocol.md');
const markerStat = fs.statSync(MARKER);
const BOOTSTRAP = path.join(T, 'bootstrap.cjs');
fs.writeFileSync(BOOTSTRAP, `
  const { EventEmitter } = require('node:events');
  globalThis.__newInstanceLaunches = [];
  globalThis.__failNextLaunch = false;
  require(${JSON.stringify(path.join(APP_DIR, 'src/relaunch.js'))}).spawnNewInstance = (argv, execPath, options) => {
    const env = options.env || {};
    globalThis.__newInstanceLaunches.push({ cwd: env.AGENT_TERM_START_CWD || null, ready: env.AGENT_TERM_READY_FILE || null });
    const child = new EventEmitter();
    child.pid = 12345;
    if (globalThis.__failNextLaunch) process.nextTick(() => child.emit('exit', 1));
    return child;
  };
  require(${JSON.stringify(path.join(APP_DIR, 'src/main.js'))});
`);
fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/sh
printf '%s\\n' "$AGENT_SESSION_ID" >> '${TOKENS}'
printf '\\033]0;Claude Code\\007'
while IFS= read -r line; do
  [ "$line" = /exit ] && exit 0
done
`, { mode: 0o755 });

async function waitFor(fn, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(200);
  }
}
async function focusTerminal(page) {
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea').focus());
}
async function typeLine(page, text) {
  await focusTerminal(page);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await sleep(400);
}
const events = (e) => sessionsLog.readLog(UD).filter(ev => ev.e === e);
const pickerOpen = (page) => page.evaluate(() => !!document.querySelector('.at-picker-input'));
const chromeText = (page) => page.evaluate(() => {
  const el = document.querySelector('.at-chrome-text');
  return el ? el.textContent : null;
});
const tokens = () => { try { return fs.readFileSync(TOKENS, 'utf8').trim().split('\n'); } catch { return []; } };
// The viewport's text, which only the DOM renderer keeps under .xterm-rows
// (hence --disable-gpu).
const screenText = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.xterm-rows > div')].map(row => row.textContent || '').join('\n'));
// What the shell answers, read from a file: the screen is cleared between sessions.
async function shellSays(page, expr) {
  fs.rmSync(OUT, { force: true });
  await typeLine(page, `printf '%s' "${expr}" > '${OUT}'`);
  return waitFor(() => { try { return fs.readFileSync(OUT, 'utf8'); } catch { return null; } }, 5000);
}

let app = null;
try {
  app = await launchElectron({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', '--disable-gpu', `--user-data-dir=${UD}`, BOOTSTRAP],
    // Main is loaded from the bootstrap's directory; this names the checkout
    // whose changes it watches.
    env: { ...process.env, HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), AGENT_TERM_DEV_SOURCE_WIN: APP_DIR },
    timeout: 45_000,
  });
  const mainLog = await followMainLog(app);
  const log = () => mainLog.text;
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached', timeout: 30_000 });
  await page.waitForSelector('.at-picker-input', { timeout: 30_000 });
  await sleep(1000);
  await page.keyboard.press('Escape');
  await sleep(300);
  await typeLine(page, `cd '${WORK}' && export AT_E2E_MARK=old-shell && command -v claude > '${WHICH}'`);
  const found = await waitFor(() => { try { return fs.readFileSync(WHICH, 'utf8').trim(); } catch { return null; } }, 5000);
  if (found !== path.join(BIN, 'claude')) throw new Error(`the shell finds ${JSON.stringify(found)}, not the fake; stopping before anything runs it`);

  console.log('1 — a running CLI keeps its window');
  await typeLine(page, 'claude');
  await sleep(800);
  await typeLine(page, 'first task of the day');
  const first = await waitFor(() => events('started')[0], 5000);
  if (!first) throw new Error('the first session never started');
  await typeLine(page, 'and a follow-up');
  await sleep(2500);
  check('the session is live', sessionsLog.isSessionActive(sessionsLog.readActiveFile(UD, first.id)));
  check('prompts do not end it', events('closed').length === 0 && !(await pickerOpen(page)));
  check('the window shows its prompt', (await chromeText(page) || '').includes('first task of the day'), JSON.stringify(await chromeText(page)));

  console.log('2 — Ctrl+C: the session ends and the picker opens');
  await focusTerminal(page);
  await page.keyboard.press('Control+C');
  check('the picker opens', !!(await waitFor(() => pickerOpen(page), 8000)), log().split('\n').filter(l => /\[cli\]/.test(l)).join(' | '));
  check('main says why', /claude exited; session \d+ ends and the picker opens/.test(log()));
  check('the session is recorded as closed', events('closed').some(e => e.id === first.id));
  check('its record is released', !sessionsLog.isSessionActive(sessionsLog.readActiveFile(UD, first.id)));
  check('the window reads as a new one', !(await chromeText(page) || '').includes('first task'), JSON.stringify(await chromeText(page)));
  check('the ended session is in the picker', !!(await page.locator(`.at-picker-row[data-id="${first.id}"]`).count()));
  check('the window is still up', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1));
  check('over a fresh shell', !!(await waitFor(() => /fresh shell for the next session/.test(log()), 5000)));
  check('no window was launched for it', (await app.evaluate(() => globalThis.__newInstanceLaunches.length)) === 0);
  await page.keyboard.press('Escape');
  await sleep(500);
  check('which kept nothing the old one exported', (await shellSays(page, '${AT_E2E_MARK:-unset}')) === 'unset');
  check('and starts in the same directory', (await shellSays(page, '$PWD')) === WORK);
  check('the CLI\'s last screen is still there to read', (await screenText(page) || '').includes('first task of the day'));
  await page.evaluate(() => window.pty.reopenPicker());
  await page.waitForSelector('.at-picker-input', { timeout: 5000 });

  console.log('3 — a session started from that picker is a new one');
  await page.evaluate(() => window.pty.pickerStartNew('claude'));
  await page.keyboard.press('Escape');
  await sleep(1200);
  check('it starts on a cleared screen', !(await screenText(page) || 'first task').includes('first task'), JSON.stringify((await screenText(page) || '').slice(0, 300)));
  await typeLine(page, 'second task entirely');
  const second = await waitFor(() => events('started').find(e => e.id !== first.id), 5000);
  check('it starts under its own id', !!second, JSON.stringify(events('started')));
  check('and its own token', second && second.token && second.token !== first.token, JSON.stringify([first.token, second && second.token]));
  check('which its CLI was started with', second && tokens().at(-1) === second.token, JSON.stringify(tokens()));
  check('the first session got no more prompts', !events('prompt').some(e => e.id === first.id && /second task/.test(e.prompt)));
  await typeLine(page, '/exit');
  check('/exit opens the picker again', !!(await waitFor(() => pickerOpen(page), 8000)));
  check('and closes the second session', !!second && events('closed').some(e => e.id === second.id));

  console.log('4 — a suspended CLI is still the window\'s');
  await page.evaluate(() => window.pty.pickerStartNew('claude'));
  await page.keyboard.press('Escape');
  await sleep(1200);
  await typeLine(page, 'third task, to be suspended');
  const third = await waitFor(() => events('started').find(e => e.id !== first.id && e.id !== (second && second.id)), 5000);
  if (!third) throw new Error('the third session never started');
  await focusTerminal(page);
  await page.keyboard.press('Control+Z');
  await sleep(600);
  await page.keyboard.press('Enter');   // a shell prompt, and a reading
  await sleep(3000);
  check('no picker opens', !(await pickerOpen(page)));
  check('the session is still live', sessionsLog.isSessionActive(sessionsLog.readActiveFile(UD, third.id)) && !events('closed').some(e => e.id === third.id));
  await typeLine(page, 'fg');
  await sleep(500);
  await focusTerminal(page);
  await page.keyboard.press('Control+D');
  check('Ctrl+D, once it is back in front, ends it', !!(await waitFor(() => pickerOpen(page), 8000)));

  console.log('5 — the ended session resumes from the picker, in the same window');
  const row = page.locator(`.at-picker-row[data-id="${first.id}"]`);
  await row.waitFor({ timeout: 5000 });
  await row.click();
  const pid = await app.evaluate(() => process.pid);
  const rec = await waitFor(() => { const r = sessionsLog.readActiveFile(UD, first.id); return r && r.pid === pid ? r : null; }, 5000);
  check('this window holds it again', !!rec, JSON.stringify(sessionsLog.readActiveFile(UD, first.id)));
  check('under the token it started with', !!(await waitFor(() => tokens().at(-1) === first.token, 5000)), JSON.stringify(tokens()));
  check('and shows its prompt', (await chromeText(page) || '').includes('first task of the day'), JSON.stringify(await chromeText(page)));
  await sleep(2500);
  check('a resumed session is not taken for an exit', !(await pickerOpen(page)) && events('closed').filter(e => e.id === first.id).length === 1);

  console.log('6 — the code changed since the window started: the picker opens in a new window');
  const launches = () => app.evaluate(() => globalThis.__newInstanceLaunches);
  const exited = new Promise(r => app.process().once('exit', () => r('exited')));
  await page.keyboard.press('Escape');
  { const now = new Date(); fs.utimesSync(MARKER, now, now); }
  await app.evaluate(() => { globalThis.__failNextLaunch = true; });
  await focusTerminal(page);
  await page.keyboard.press('Control+C');
  check('a launch that fails leaves the picker here', !!(await waitFor(() => pickerOpen(page), 10_000)), log().split('\n').filter(l => /\[cli\]|new-instance/.test(l)).slice(-6).join(' | '));
  check('after one try', (await launches()).length === 1, JSON.stringify(await launches()));
  check('and the window stays', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1));
  await app.evaluate(() => { globalThis.__failNextLaunch = false; });
  await page.evaluate(() => window.pty.pickerStartNew('claude'));
  await page.keyboard.press('Escape');
  await sleep(1500);
  await typeLine(page, 'a task on the older code');
  await waitFor(() => events('prompt').some(e => /older code/.test(e.prompt)), 5000);
  await focusTerminal(page);
  await page.keyboard.press('Control+C');
  const asked = await waitFor(async () => { const l = await launches(); return l.length === 2 ? l[1] : null; }, 10_000);
  check('the next exit launches a window', !!asked, JSON.stringify(await launches()));
  check('in the session\'s directory', asked && asked.cwd === WORK, JSON.stringify(asked));
  check('and says why, for as long as it says a window is starting',
    !!(await waitFor(() => page.evaluate(() => document.body.innerText.includes("AgentTerm's code changed. Starting new AgentTerm in")), 3000)));
  await sleep(1500);
  check('no picker opens here meanwhile', !(await pickerOpen(page)));
  check('this window waits for the new one', (await Promise.race([exited, sleep(300).then(() => 'up')])) === 'up');
  if (asked && asked.ready) fs.writeFileSync(asked.ready, 'up');
  check('and closes once the new one is up', (await Promise.race([exited, sleep(10_000).then(() => 'timeout')])) === 'exited');
  app = null;
} catch (err) {
  failures.push('exception: ' + (err && err.stack || err));
  console.log('  ✗ ' + (err && err.stack || err));
} finally {
  try { fs.utimesSync(MARKER, markerStat.atime, markerStat.mtime); } catch {}
  try { if (app) await app.close(); } catch {}
  fs.rmSync(UD, { recursive: true, force: true });
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
