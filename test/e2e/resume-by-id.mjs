// End-to-end test: a Cursor Agent session resumes by its chat id from the
// picker, with no /resume and no resume band (src/cli-conversation.js).
// Launches the REAL app against an isolated userData dir, with a fake `agent`
// that keeps a chat store open the way Cursor does: under
// <tmp>/chats/<md5 of its cwd>/<chat id>/store.db.
//
//   1. a prompt in a fresh session: the probe finds the chat held open and
//      logs it, with the directory it resumes from
//   2. the session picked in a new window: the CLI starts with
//      --resume <chat id> from that directory, and no band shows; a later
//      prompt on the same chat logs nothing new
//   3. a resume the user did not ask for (older code, the live cap) on a
//      session that resumes by id: the reason stands alone, with no band
//
// The fake is an executable on a PATH the test puts first, not a shell
// function: a resumed session launches through `env AGENT_SESSION_ID=…`, and
// env cannot see a function. The test checks the shell finds the fake before
// anything starts `agent`, so the real Cursor Agent never runs.
// Run: node test/e2e/resume-by-id.mjs

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
const UD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-resume-id-e2e-')));
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-resume-id-fake-')));
const BIN = path.join(T, 'bin');
const ARGS = path.join(T, 'args');
const WHICH = path.join(T, 'which');
const CHAT = '5b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';
fs.mkdirSync(BIN);
// The fake Cursor Agent: records its arguments, opens its chat's store under
// the md5 of its cwd (the id after --resume, else CHAT), names itself in the
// title as Cursor does, and reads lines until the window goes.
fs.writeFileSync(path.join(BIN, 'agent'), `#!/bin/sh
printf '%s\\n' "$*" >> '${ARGS}'
id='${CHAT}'
[ "$1" = --resume ] && id="$2"
h=$(printf %s "$PWD" | { md5sum 2>/dev/null || md5; } | cut -c1-32)
d='${T}'/chats/$h/$id
mkdir -p "$d"
printf '{"schemaVersion":1,"cwd":"%s"}\\n' "$PWD" > "$d/meta.json"
: >> "$d/store.db"
exec 3<"$d/store.db"
printf '\\033]0;Cursor Agent\\007'
while read -r line; do :; done
`, { mode: 0o755 });

async function launch() {
  const app = await launchElectron({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', `--user-data-dir=${UD}`, APP_DIR],
    timeout: 45_000,
  });
  const mainLog = await followMainLog(app);
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await page.waitForSelector('.at-picker-input', { timeout: 30_000 });
  await sleep(1000);
  return { app, page, get log() { return mainLog.text; } };
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
async function typeLine(page, text) {
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea').focus());
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await sleep(400);
}
// Leave the picker for the shell, put the fake first on PATH, and prove the
// shell resolves `agent` to it.
async function useFake(page) {
  await page.keyboard.press('Escape');
  await sleep(300);
  fs.rmSync(WHICH, { force: true });
  await typeLine(page, `export PATH='${BIN}':"$PATH"; hash -r; command -v agent > '${WHICH}'`);
  const found = await waitFor(() => { try { return fs.readFileSync(WHICH, 'utf8').trim(); } catch { return null; } }, 5000);
  if (found !== path.join(BIN, 'agent')) throw new Error(`the shell finds agent at ${found}, not the fake; stopping before anything runs it`);
}
const conversationEvents = () => sessionsLog.readLog(UD).filter(e => e.e === 'conversation');
const cleanup = [];

try {
  console.log('1 — a prompt in a fresh Cursor session logs the chat it went to');
  const a = await launch(); cleanup.push(a);
  await useFake(a.page);
  await typeLine(a.page, 'agent');
  await sleep(800);
  await typeLine(a.page, 'please add retry logic to the uploader');
  const logged = await waitFor(() => conversationEvents()[0], 10_000);
  check('the chat is logged after the prompt', logged && logged.conversation === CHAT, JSON.stringify(conversationEvents()));
  const id = logged ? logged.id : null;
  check('with the directory the agent keeps it under', logged && typeof logged.dir === 'string' && logged.dir.length > 1,
    JSON.stringify(logged));
  const session = sessionsLog.listSessions(UD).find(s => s.id === id);
  check('the fold carries it', session && session.conversation && session.conversation.id === CHAT, JSON.stringify(session));
  await a.app.close();
  cleanup.length = 0;

  console.log('2 — picked in a new window, it resumes by id, with no band');
  fs.rmSync(ARGS, { force: true });
  const b = await launch(); cleanup.push(b);
  await useFake(b.page);
  await b.page.evaluate(() => window.pty.reopenPicker());
  const row = b.page.locator(`.at-picker-row[data-id="${id}"]`);
  await row.waitFor({ timeout: 5000 });
  await row.click();
  const args = await waitFor(() => { try { return fs.readFileSync(ARGS, 'utf8').trim(); } catch { return null; } }, 10_000);
  check('the CLI starts with --resume and the chat id', args === `--resume ${CHAT}`, JSON.stringify(args));
  check('main says it resumed by id', /resumed by id after picker-pick id=\d+ cli=agent conversation=/.test(b.log));
  check('no intercept is armed', !/armed intercept after picker-pick/.test(b.log));
  await sleep(1000);
  check('no resume band shows', !(await b.page.evaluate(() => !!document.querySelector('.at-resume-hint'))));
  const before = conversationEvents().length;
  await typeLine(b.page, 'and cover the timeout case too');
  await sleep(5000);
  check('the follow-up prompt is logged to the same session',
    sessionsLog.readLog(UD).some(e => e.e === 'prompt' && e.id === id && e.prompt === 'and cover the timeout case too'));
  check('the same chat logs nothing new', conversationEvents().length === before, JSON.stringify(conversationEvents()));

  console.log('3 — a resume the user did not ask for: the reason stands alone');
  await b.app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0].webContents.send('resume-with-reason', payload);
  }, { cli: 'agent', prompt: 'x', title: null, conversation: { id: CHAT, dir: '/w' }, reason: 'older-code' });
  const notice = await waitFor(() => b.page.evaluate(() => {
    const el = document.querySelector('.at-notice-standalone');
    return el ? el.textContent : null;
  }), 5000);
  check('the reason shows as a notice', notice && notice.includes('so it resumed through the CLI.'), JSON.stringify(notice));
  check('still no resume band', !(await b.page.evaluate(() => !!document.querySelector('.at-resume-hint'))));
} catch (err) {
  failures.push(String(err && err.message));
  console.log('  ✗ ' + (err && err.stack));
} finally {
  for (const w of cleanup) { try { await w.app.close(); } catch {} }
  fs.rmSync(UD, { recursive: true, force: true });
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
