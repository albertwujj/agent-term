// End-to-end: a send that finds no agent-threads runbook offers to have the
// agent clone it, and the offer, once taken, lands the README's prompt in the
// terminal as a submitted line.
//
// Drives the real preflight IPC (renderer -> main -> dialog -> pty) with three
// things arranged around it. The runbook ladder is starved: HOME, the start
// cwd and the document all sit in a scratch tree with no agent-threads
// anywhere above them. The native dialog is an OS window Playwright cannot
// click, so it is replaced in the main process by a recorder that answers
// with a chosen button and keeps what it was shown. And the pty's shell is a
// tiny script that appends every submitted line to a file, so what the
// terminal typed on the user's behalf is read back exactly, bracketed-paste
// markers and the Enter included. A screenshot of the window after the
// clone shows the echoed prompt.

import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AGENT_THREADS_CLONE_PROMPT } = require('../../src/loop-install.js');

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const SHOT_DIR = process.env.AGENT_TERM_E2E_SHOTS || path.join(os.tmpdir(), 'agent-term-e2e');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`); }
}

async function waitFor(fn, ms = 6000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(150);
  }
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'runbook-clone-'));
  const home = path.join(scratch, 'home');
  const proj = path.join(scratch, 'proj');
  fs.mkdirSync(home); fs.mkdirSync(proj);
  const doc = path.join(proj, 'plan.md');
  fs.writeFileSync(doc, '# Plan\n\nThe opening paragraph.\n', 'utf8');
  // The stand-in shell: records each submitted line. The pty echoes what is
  // typed on its own, which is what the screenshot shows.
  const typed = path.join(scratch, 'typed.txt');
  const shell = path.join(scratch, 'shell.sh');
  fs.writeFileSync(shell, '#!/bin/sh\nwhile IFS= read -r line; do printf \'%s\\n\' "$line" >> "$AT_E2E_TYPED"; done\n');
  fs.chmodSync(shell, 0o755);
  const typedLines = () => (fs.existsSync(typed) ? fs.readFileSync(typed, 'utf8').split('\n').filter(Boolean) : []);
  const unbracket = (s) => s.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');

  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', `--user-data-dir=${path.join(scratch, 'ud')}`, APP_DIR],
    env: { ...process.env, HOME: home, SHELL: shell, AT_E2E_TYPED: typed, AGENT_TERM_START_CWD: proj },
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await sleep(1500);
  if (await page.evaluate(() => !!document.querySelector('.at-picker-overlay'))) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }

  // The dialog recorder: answers with __answer, keeps every call's options.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    globalThis.__answer = 0;
    dialog.showMessageBox = async (...args) => {
      const opts = args[args.length - 1] || {};
      globalThis.__dialogs.push({
        buttons: opts.buttons, defaultId: opts.defaultId, cancelId: opts.cancelId,
        message: opts.message, detail: opts.detail,
      });
      return { response: globalThis.__answer, checkboxChecked: false };
    };
  });
  const dialogs = () => app.evaluate(() => globalThis.__dialogs);
  // electronApp.evaluate hands the function the electron module first, then the argument.
  const answer = (n) => app.evaluate((_electron, v) => { globalThis.__answer = v; }, n);
  const preflight = () => page.evaluate((docPath) => window.pty.mdRunbookPreflight({ docPath }), doc);

  try {
    console.log('the offer, taken');
    await answer(0);
    const res = await preflight();
    check('the send reads as canceled with the clone requested', !!(res && res.canceled && res.cloneRequested), res);
    const shown = (await dialogs())[0];
    check('the dialog offered the clone first, then send anyway, then cancel',
      !!shown && JSON.stringify(shown.buttons) === JSON.stringify(['Ask the agent to clone it into ai/', 'Send anyway', 'Cancel']), shown && shown.buttons);
    check('with the clone as the default and cancel as the escape', !!shown && shown.defaultId === 0 && shown.cancelId === 2, shown);
    check('under the runbook-not-found message', !!shown && shown.message === 'agent-threads runbook not found', shown && shown.message);
    check('and a detail that says where it looked and what the clone is',
      !!shown && /agent-threads\/md\/user-intent\.md/.test(shown.detail) && /into ai\//.test(shown.detail), shown && shown.detail);

    const line = await waitFor(() => typedLines()[0] || null);
    check('the terminal submitted one line to the shell', typedLines().length === 1, typedLines());
    check('wrapped as a bracketed paste', !!line && line.startsWith('\x1b[200~') && line.endsWith('\x1b[201~'), line);
    check("and it is the README's prompt, word for word", !!line && unbracket(line) === AGENT_THREADS_CLONE_PROMPT, line && unbracket(line));

    await sleep(600);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const shot = path.join(SHOT_DIR, 'runbook-clone-offer.png');
    await page.screenshot({ path: shot });
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.xterm-rows > div')).map((r) => r.textContent).join('\n'));
    check('the echoed prompt is on screen', /Clone https:\/\/github\.com\/albertwujj\/agent-threads/.test(rows), rows.slice(0, 300));
    console.log(`  screenshot: ${shot}`);

    console.log('send anyway');
    await answer(1);
    const sendAnyway = await preflight();
    check('returns the acked, runbook-less send', !!(sendAnyway && sendAnyway.acked && sendAnyway.runbook === null && !sendAnyway.canceled), sendAnyway);
    await sleep(400);
    check('and types nothing', typedLines().length === 1, typedLines().length);

    console.log('cancel');
    await answer(2);
    const cancel = await preflight();
    check('returns canceled with no clone requested', !!(cancel && cancel.canceled && !cancel.cloneRequested), cancel);
    await sleep(400);
    check('and types nothing', typedLines().length === 1, typedLines().length);
    check('three dialogs were shown in all', (await dialogs()).length === 3);

    console.log('after the clone lands in ai/');
    const runbook = path.join(proj, 'ai', 'agent-threads', 'md', 'user-intent.md');
    fs.mkdirSync(path.dirname(runbook), { recursive: true });
    fs.writeFileSync(runbook, '# runbook\n');
    const found = await preflight();
    check('the preflight resolves it without a dialog', !!(found && found.runbook && fs.realpathSync(found.runbook) === fs.realpathSync(runbook)), found);
    check('so no fourth dialog', (await dialogs()).length === 3);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
