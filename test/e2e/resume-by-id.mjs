// End-to-end test: a Cursor Agent, Claude Code or Codex session resumes by its
// conversation id from the picker, with no /resume and no resume band
// (src/cli-conversation.js). Launches the REAL app against an isolated
// userData dir, with fakes that leave the trace each real CLI leaves:
//   agent   keeps its chat store open, under
//           <tmp>/chats/<md5 of its cwd>/<chat id>/store.db
//   claude  writes its session record, <CLAUDE_CONFIG_DIR>/sessions/<pid>.json
//   codex   writes its thread, with the name it generates, to its store,
//           <CODEX_HOME>/state_5.sqlite, and shows "<name> | <project>" as
//           its title, as Codex 0.167 does by default
//
// For each CLI:
//   1. a prompt in a fresh session: the conversation is found and logged,
//      with the directory it resumes from
//   2. the session picked in a new window: the CLI starts with its resume
//      arguments and the id, from that directory, and no band shows; a later
//      prompt on the same conversation logs nothing new
// Then once:
//   3. a resume the user did not ask for (older code, the live cap) on a
//      session that resumes by id: the reason stands alone, with no band
//   4. a Codex session recorded before its thread could be found (a name in
//      its titles, no conversation): the pick finds the thread by name,
//      resumes by id, and the band shown at the pick goes
//
// The fakes are executables on a PATH the test puts first, not shell
// functions: a resumed session launches through `env AGENT_SESSION_ID=…`, and
// env cannot see a function. The test checks the shell finds the fakes before
// anything starts them, so no real CLI ever runs.
// Run: node test/e2e/resume-by-id.mjs

import { followMainLog, launchElectron } from './electron.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { execFileSync } from 'node:child_process';
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
// The app reads Claude's records and Codex's store from here, and so does
// nothing else.
const CLAUDE_CONFIG = path.join(T, 'claude-config');
const CODEX_HOME = path.join(T, 'codex-home');
fs.mkdirSync(BIN);
fs.mkdirSync(path.join(CLAUDE_CONFIG, 'sessions'), { recursive: true });
fs.mkdirSync(CODEX_HOME);

// Codex's thread store: the threads table, with the columns the lookup reads.
function codexStore(rows) {
  execFileSync('python3', ['-c', `
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1] + "/state_5.sqlite")
db.execute("create table if not exists threads (id text primary key, cwd text, name text, thread_source text)")
db.executemany("insert or replace into threads values (?, ?, ?, ?)", json.loads(sys.argv[2]))
db.commit()`, CODEX_HOME, JSON.stringify(rows)]);
}
const CODEX_NAME = 'Add uploader retries';

// Each fake records its arguments, shows the title the real CLI shows, leaves
// that CLI's trace for the id it resumes (else its own), and reads lines until
// the window goes.
const CLIS = [
  {
    cli: 'agent',
    id: '5b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3',
    resumeArgs: (id) => `--resume ${id}`,
    script: (id) => `id='${id}'
[ "$1" = --resume ] && id="$2"
h=$(printf %s "$PWD" | { md5sum 2>/dev/null || md5; } | cut -c1-32)
d='${T}'/chats/$h/$id
mkdir -p "$d"
printf '{"schemaVersion":1,"cwd":"%s"}\\n' "$PWD" > "$d/meta.json"
: >> "$d/store.db"
exec 3<"$d/store.db"
printf '\\033]0;Cursor Agent\\007'`,
  },
  {
    cli: 'claude',
    id: '9f8e7d6c-5b4a-4321-8fed-cba987654321',
    resumeArgs: (id) => `--resume ${id}`,
    script: (id) => `id='${id}'
[ "$1" = --resume ] && id="$2"
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","kind":"interactive","status":"idle"}\\n' $$ "$id" "$PWD" > '${CLAUDE_CONFIG}/sessions/'$$.json
printf '\\033]0;Claude Code\\007'`,
  },
  {
    cli: 'codex',
    id: '01a1b250-1111-7222-8333-944455556666',
    resumeArgs: (id) => `--no-alt-screen resume ${id}`,
    // A fresh thread: the project as the title until the first prompt, then
    // the thread in the store and its name in front of the project. A resumed
    // thread shows its name again.
    script: (id) => `case " $* " in *" resume "*) printf '\\033]0;%s | %s\\007' '${CODEX_NAME}' "$(basename "$PWD")";; *)
printf '\\033]0;%s\\007' "$(basename "$PWD")"
read -r first
python3 -c 'import sqlite3, sys; db = sqlite3.connect(sys.argv[1] + "/state_5.sqlite"); db.execute("create table if not exists threads (id text primary key, cwd text, name text, thread_source text)"); db.execute("insert or replace into threads values (?, ?, ?, ?)", (sys.argv[2], sys.argv[3], sys.argv[4], "user")); db.commit()' '${CODEX_HOME}' '${id}' "$PWD" '${CODEX_NAME}'
printf '\\033]0;%s | %s\\007' '${CODEX_NAME}' "$(basename "$PWD")";;
esac`,
  },
];
for (const c of CLIS) {
  c.args = path.join(T, `args-${c.cli}`);
  fs.writeFileSync(path.join(BIN, c.cli), `#!/bin/sh
printf '%s\\n' "$*" >> '${c.args}'
${c.script(c.id)}
while read -r line; do :; done
`, { mode: 0o755 });
}

async function launch() {
  const app = await launchElectron({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', `--user-data-dir=${UD}`, APP_DIR],
    env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE_CONFIG, CODEX_HOME },
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
// shell resolves every CLI to them.
async function useFakes(page) {
  await page.keyboard.press('Escape');
  await sleep(300);
  fs.rmSync(WHICH, { force: true });
  const names = CLIS.map(c => c.cli);
  await typeLine(page, `export PATH='${BIN}':"$PATH"; hash -r; { ${names.map(n => `command -v ${n};`).join(' ')} } > '${WHICH}'`);
  const found = await waitFor(() => {
    try { const t = fs.readFileSync(WHICH, 'utf8').trim(); return t.split('\n').length === names.length ? t : null; } catch { return null; }
  }, 5000);
  const want = names.map(n => path.join(BIN, n)).join('\n');
  if (found !== want) throw new Error(`the shell finds ${JSON.stringify(found)}, not the fakes; stopping before anything runs them`);
}
const conversationEvents = (id) => sessionsLog.readLog(UD).filter(e => e.e === 'conversation' && e.id === id);
const readArgs = (c) => { try { return fs.readFileSync(c.args, 'utf8').trim(); } catch { return null; } };
async function pick(w, id) {
  await w.page.evaluate(() => window.pty.reopenPicker());
  const row = w.page.locator(`.at-picker-row[data-id="${id}"]`);
  await row.waitFor({ timeout: 5000 });
  await row.click();
}
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
      JSON.stringify(sessionsLog.readLog(UD).filter(e => e.e === 'conversation' || e.e === 'title')));
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
    await pick(b, id);
    const args = await waitFor(() => readArgs(c), 10_000);
    check(`${c.cli}: the CLI starts with its resume arguments and the id`, args === c.resumeArgs(c.id), JSON.stringify(args));
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

  console.log('4 — a Codex session recorded before its thread could be found: found by name at the pick');
  const codex = CLIS.find(c => c.cli === 'codex');
  const LEGACY_ID = '01a0d986-d8d8-7a11-81ef-277863951c88';
  const legacy = 9001;
  const dir = fs.realpathSync(APP_DIR);
  codexStore([[LEGACY_ID, dir, 'Fix Electron icon display', 'user'],
    ['01a0d9a6-0000-7000-8000-000000000000', dir, 'Guardian review', 'guardian_review']]);
  for (const event of [
    { e: 'started', id: legacy, hue: 200 },
    { e: 'cli', id: legacy, cli: 'codex' },
    { e: 'prompt', id: legacy, prompt: 'check why electron icon shows' },
    { e: 'cwd', id: legacy, cwd: dir },
    { e: 'title', id: legacy, title: `Fix Electron icon display | ${path.basename(dir)}` },
  ]) sessionsLog.appendEvent(UD, event);
  fs.rmSync(codex.args, { force: true });
  const d = await launch(); cleanup.push(d);
  await useFakes(d.page);
  await pick(d, legacy);
  const args = await waitFor(() => readArgs(codex), 10_000);
  check('the pick resumes the thread found by name', args === codex.resumeArgs(LEGACY_ID), JSON.stringify(args));
  check('and records it, so the next pick needs no lookup',
    conversationEvents(legacy).some(e => e.conversation === LEGACY_ID && e.dir === dir), JSON.stringify(conversationEvents(legacy)));
  check('no intercept is armed', !/armed intercept after picker-pick/.test(d.log));
  const bandGone = await waitFor(() => d.page.evaluate(() => !document.querySelector('.at-resume-hint')), 3000);
  check('the band shown at the pick goes', !!bandGone);
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
