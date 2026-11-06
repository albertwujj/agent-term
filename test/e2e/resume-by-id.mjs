// End-to-end test: a Cursor Agent or Claude Code session resumes by its
// conversation id from the picker, with no /resume and no resume band
// (src/cli-conversation.js). Launches the REAL app against an isolated
// userData dir, with fakes that leave the trace each real CLI leaves:
//   agent   keeps its chat store open, under
//           <tmp>/chats/<md5 of its cwd>/<chat id>/store.db
//   claude  writes its session record, <CLAUDE_CONFIG_DIR>/sessions/<pid>.json
//
// For each CLI:
//   1. a prompt in a fresh session: the probe finds the conversation and logs
//      it, with the directory it resumes from
//   2. the session picked in a new window: the CLI starts with
//      --resume <id> from that directory, and no band shows; a later prompt
//      on the same conversation logs nothing new
// Then once:
//   3. a resume the user did not ask for (older code, the live cap) on a
//      session that resumes by id: the reason stands alone, with no band
//
// The fakes are executables on a PATH the test puts first, not shell
// functions: a resumed session launches through `env AGENT_SESSION_ID=…`, and
// env cannot see a function. The test checks the shell finds the fakes before
// anything starts them, so neither real CLI ever runs.
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
const WHICH = path.join(T, 'which');
// The app's probe reads Claude's records from here, and so does nothing else.
const CLAUDE_CONFIG = path.join(T, 'claude-config');
fs.mkdirSync(BIN);
fs.mkdirSync(path.join(CLAUDE_CONFIG, 'sessions'), { recursive: true });

// Each fake records its arguments, names itself in the title as the real CLI
// does, leaves that CLI's trace for the id after --resume (else its own), and
// reads lines until the window goes.
const CLIS = [
  {
    cli: 'agent',
    id: '5b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3',
    trace: (id) => `h=$(printf %s "$PWD" | { md5sum 2>/dev/null || md5; } | cut -c1-32)
d='${T}'/chats/$h/${id}
mkdir -p "$d"
printf '{"schemaVersion":1,"cwd":"%s"}\\n' "$PWD" > "$d/meta.json"
: >> "$d/store.db"
exec 3<"$d/store.db"
printf '\\033]0;Cursor Agent\\007'`,
  },
  {
    cli: 'claude',
    id: '9f8e7d6c-5b4a-4321-8fed-cba987654321',
    trace: (id) => `printf '{"pid":%s,"sessionId":"%s","cwd":"%s","kind":"interactive","status":"idle"}\\n' $$ "${id}" "$PWD" > '${CLAUDE_CONFIG}/sessions/'$$.json
printf '\\033]0;Claude Code\\007'`,
  },
];
for (const c of CLIS) {
  c.args = path.join(T, `args-${c.cli}`);
  fs.writeFileSync(path.join(BIN, c.cli), `#!/bin/sh
printf '%s\\n' "$*" >> '${c.args}'
id='${c.id}'
[ "$1" = --resume ] && id="$2"
${c.trace('$id')}
while read -r line; do :; done
`, { mode: 0o755 });
}

async function launch() {
  const app = await launchElectron({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', `--user-data-dir=${UD}`, APP_DIR],
    env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE_CONFIG },
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
// Leave the picker for the shell, put the fakes first on PATH, and prove the
// shell resolves both CLIs to them.
async function useFakes(page) {
  await page.keyboard.press('Escape');
  await sleep(300);
  fs.rmSync(WHICH, { force: true });
  await typeLine(page, `export PATH='${BIN}':"$PATH"; hash -r; { command -v agent; command -v claude; } > '${WHICH}'`);
  const found = await waitFor(() => {
    try { const t = fs.readFileSync(WHICH, 'utf8').trim(); return t.split('\n').length === 2 ? t : null; } catch { return null; }
  }, 5000);
  const want = [path.join(BIN, 'agent'), path.join(BIN, 'claude')].join('\n');
  if (found !== want) throw new Error(`the shell finds ${JSON.stringify(found)}, not the fakes; stopping before anything runs them`);
}
const conversationEvents = (id) => sessionsLog.readLog(UD).filter(e => e.e === 'conversation' && e.id === id);
const readArgs = (c) => { try { return fs.readFileSync(c.args, 'utf8').trim(); } catch { return null; } };
const cleanup = [];

try {
  for (const c of CLIS) {
    console.log(`1 — ${c.cli}: a prompt in a fresh session logs the conversation it went to`);
    const before = new Set(sessionsLog.readLog(UD).filter(e => e.e === 'started').map(e => e.id));
    const a = await launch(); cleanup.push(a);
    await useFakes(a.page);
    await typeLine(a.page, c.cli);
    await sleep(800);
    await typeLine(a.page, `please add retry logic to the ${c.cli} uploader`);
    // The event, not its id: the first session's id is 0.
    const started = await waitFor(() => sessionsLog.readLog(UD).find(e => e.e === 'started' && !before.has(e.id)), 5000);
    const id = started ? started.id : null;
    const logged = await waitFor(() => id !== null && conversationEvents(id)[0], 10_000);
    check(`${c.cli}: the conversation is logged after the prompt`, logged && logged.conversation === c.id,
      JSON.stringify(sessionsLog.readLog(UD).filter(e => e.e === 'conversation')));
    check(`${c.cli}: with the directory the CLI runs in`, logged && typeof logged.dir === 'string' && logged.dir.length > 1,
      JSON.stringify(logged));
    const session = sessionsLog.listSessions(UD).find(s => s.id === id);
    check(`${c.cli}: the fold carries it`, session && session.conversation && session.conversation.id === c.id, JSON.stringify(session));
    await a.app.close();
    cleanup.length = 0;

    console.log(`2 — ${c.cli}: picked in a new window, it resumes by id, with no band`);
    fs.rmSync(c.args, { force: true });
    const b = await launch(); cleanup.push(b);
    await useFakes(b.page);
    await b.page.evaluate(() => window.pty.reopenPicker());
    const row = b.page.locator(`.at-picker-row[data-id="${id}"]`);
    await row.waitFor({ timeout: 5000 });
    await row.click();
    const args = await waitFor(() => readArgs(c), 10_000);
    check(`${c.cli}: the CLI starts with --resume and the id`, args === `--resume ${c.id}`, JSON.stringify(args));
    check(`${c.cli}: main says it resumed by id`, new RegExp(`resumed by id after picker-pick id=${id} cli=${c.cli} conversation=${c.id}`).test(b.log));
    check(`${c.cli}: no intercept is armed`, !/armed intercept after picker-pick/.test(b.log));
    await sleep(1000);
    check(`${c.cli}: no resume band shows`, !(await b.page.evaluate(() => !!document.querySelector('.at-resume-hint'))));
    const count = conversationEvents(id).length;
    await typeLine(b.page, 'and cover the timeout case too');
    await sleep(5000);
    check(`${c.cli}: the follow-up prompt is logged to the same session`,
      sessionsLog.readLog(UD).some(e => e.e === 'prompt' && e.id === id && e.prompt === 'and cover the timeout case too'));
    check(`${c.cli}: the same conversation logs nothing new`, conversationEvents(id).length === count, JSON.stringify(conversationEvents(id)));

    if (c === CLIS[CLIS.length - 1]) {
      console.log('3 — a resume the user did not ask for: the reason stands alone');
      await b.app.evaluate(({ BrowserWindow }, payload) => {
        BrowserWindow.getAllWindows()[0].webContents.send('resume-with-reason', payload);
      }, { cli: c.cli, prompt: 'x', title: null, conversation: { id: c.id, dir: '/w' }, reason: 'older-code' });
      const notice = await waitFor(() => b.page.evaluate(() => {
        const el = document.querySelector('.at-notice-standalone');
        return el ? el.textContent : null;
      }), 5000);
      check('the reason shows as a notice', notice && notice.includes('so it resumed through the CLI.'), JSON.stringify(notice));
      check('still no resume band', !(await b.page.evaluate(() => !!document.querySelector('.at-resume-hint'))));
    }
    await b.app.close();
    cleanup.length = 0;
  }
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
