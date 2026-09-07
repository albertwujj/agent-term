// End-to-end: a send that finds no agent-threads runbook offers to have the
// agent clone it; taking the offer sends the README's prompt, shrinks a
// full-size band, and holds the send behind a waiting box that closes itself
// when the clone lands, so the send goes ahead with the runbook it found.
//
// Drives the real preflight IPC (renderer -> main -> dialogs -> pty) with
// three things arranged around it. The runbook ladder is starved: HOME, the
// start cwd and the document all sit in a scratch tree with no agent-threads
// anywhere above them. The native dialogs are OS windows Playwright cannot
// press, so they are replaced in the main process by a recorder that answers
// from a queue, keeps what it was shown, and honours the waiting box's abort
// signal the way the real one does. And the pty's shell is a tiny script that
// appends every submitted line to a file, so what the terminal typed on the
// user's behalf is read back exactly, bracketed-paste markers included.

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

async function waitFor(fn, ms = 8000) {
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
  const runbook = path.join(proj, 'ai', 'agent-threads', 'md', 'user-intent.md');
  const landClone = () => { fs.mkdirSync(path.dirname(runbook), { recursive: true }); fs.writeFileSync(runbook, '# runbook\n'); };
  const removeClone = () => fs.rmSync(path.join(proj, 'ai'), { recursive: true, force: true });
  const same = (a, b) => a && b && fs.realpathSync(a) === fs.realpathSync(b);

  // The stand-in shell: records each submitted line. The pty echoes what is
  // typed on its own, which is what the screenshot shows.
  const typed = path.join(scratch, 'typed.txt');
  const shell = path.join(scratch, 'shell.sh');
  fs.writeFileSync(shell, '#!/bin/sh\nwhile IFS= read -r line; do printf \'%s\\n\' "$line" >> "$AT_E2E_TYPED"; done\n');
  fs.chmodSync(shell, 0o755);
  const typedLines = () => (fs.existsSync(typed) ? fs.readFileSync(typed, 'utf8').split('\n').filter(Boolean) : []);
  const unbracket = (s) => s.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
  const promptLines = () => typedLines().filter((l) => unbracket(l) === AGENT_THREADS_CLONE_PROMPT);

  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', `--user-data-dir=${path.join(scratch, 'ud')}`, APP_DIR],
    env: { ...process.env, HOME: home, SHELL: shell, AT_E2E_TYPED: typed, AGENT_TERM_START_CWD: proj },
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
  await sleep(1500);
  if (await page.evaluate(() => !!document.querySelector('.at-picker-overlay'))) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }

  // The dialog recorder: answers from a queue, keeps every call's options, and
  // when told to 'wait' resolves only on the abort signal, as the real box
  // closes when the app aborts it.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    globalThis.__answers = [];
    dialog.showMessageBox = (...args) => {
      const opts = args[args.length - 1] || {};
      globalThis.__dialogs.push({
        buttons: opts.buttons, defaultId: opts.defaultId, cancelId: opts.cancelId,
        message: opts.message, detail: opts.detail, hasSignal: !!opts.signal,
      });
      const a = globalThis.__answers.shift();
      if (a === 'wait') {
        return new Promise((resolve) => {
          if (!opts.signal) { resolve({ response: opts.cancelId, checkboxChecked: false }); return; }
          opts.signal.addEventListener('abort', () => resolve({ response: opts.cancelId, checkboxChecked: false }));
        });
      }
      return Promise.resolve({ response: a, checkboxChecked: false });
    };
  });
  const dialogs = () => app.evaluate(() => globalThis.__dialogs);
  const answers = (list) => app.evaluate((_electron, v) => { globalThis.__answers = v; }, list);
  const preflight = () => page.evaluate((docPath) => window.pty.mdRunbookPreflight({ docPath }), doc);
  const bandFull = () => page.evaluate(() => !!document.querySelector('.vb-shell.vb-md.open.vb-full'));

  try {
    console.log('the document open in the band, at full size');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`echo ${doc}`);
    await page.keyboard.press('Enter');
    await sleep(700);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
    const opened = await waitFor(() => page.evaluate(() => !!document.querySelector('.vb-shell.vb-md.open .md-viewer-body h1')));
    check('the band shows the document', !!opened);
    if (opened && !(await bandFull())) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('viewer-shortcut', 'size'));
      await sleep(400);
    }
    check('at full size', await bandFull());

    console.log('the offer, taken, and the clone lands');
    await answers([0, 'wait']);
    const pending = preflight();
    const line = await waitFor(() => promptLines()[0] || null);
    check("the terminal submitted the README's prompt, word for word, as one bracketed paste",
      !!line && typedLines().filter((l) => /agent-threads/.test(l)).length === 1
        && line.startsWith('\x1b[200~') && line.endsWith('\x1b[201~') && unbracket(line) === AGENT_THREADS_CLONE_PROMPT, line);
    const shrunk = await waitFor(async () => !(await bandFull()));
    check('the band dropped from full size while the send waits', !!shrunk);
    check('and stays open on the document', await page.evaluate(() => !!document.querySelector('.vb-shell.vb-md.open')));
    const shown = await dialogs();
    check('the offer came first: clone, send anyway, cancel, clone as default, cancel as the escape',
      shown.length === 2 && JSON.stringify(shown[0].buttons) === JSON.stringify(['Ask the agent to clone it into ai/', 'Send anyway', 'Cancel'])
        && shown[0].defaultId === 0 && shown[0].cancelId === 2 && shown[0].message === 'agent-threads runbook not found', shown[0]);
    check('then the waiting box, with an abort signal, send anyway and cancel',
      shown.length === 2 && shown[1].hasSignal && JSON.stringify(shown[1].buttons) === JSON.stringify(['Send anyway', 'Cancel'])
        && shown[1].message === 'Waiting for the agent to clone agent-threads', shown[1]);
    await sleep(600);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const shot = path.join(SHOT_DIR, 'runbook-clone-offer.png');
    await page.screenshot({ path: shot });
    console.log(`  screenshot: ${shot}`);
    check('the send is still held', await Promise.race([pending.then(() => false), sleep(300).then(() => true)]));
    landClone();
    const res = await pending;
    check('when the clone lands the box closes itself and the send goes ahead with the runbook',
      !!(res && same(res.runbook, runbook)), res);

    console.log('a clone that never lands: send anyway');
    removeClone();
    await answers([0, 0]);
    const sendAnyway = await preflight();
    check('returns the acknowledged, runbook-less send', !!(sendAnyway && sendAnyway.acked && sendAnyway.runbook === null && !sendAnyway.canceled), sendAnyway);
    check('after sending the prompt again', !!(await waitFor(() => promptLines().length === 2)), promptLines().length);

    console.log('a clone that never lands: cancel');
    await answers([0, 1]);
    const cancel = await preflight();
    check('returns canceled', !!(cancel && cancel.canceled), cancel);
    check('after sending the prompt again', !!(await waitFor(() => promptLines().length === 3)), promptLines().length);

    console.log('the first box on its own');
    await answers([1]);
    const first = await preflight();
    await sleep(1800); // longer than the writer's fallback, so a paste would have landed
    check('send anyway returns the acknowledged send and types nothing', !!(first && first.acked) && promptLines().length === 3, [first, promptLines().length]);
    await answers([2]);
    const firstCancel = await preflight();
    await sleep(1800);
    check('cancel returns canceled and types nothing', !!(firstCancel && firstCancel.canceled) && promptLines().length === 3, [firstCancel, promptLines().length]);
    check('eight boxes were shown in all', (await dialogs()).length === 8, (await dialogs()).length);

    console.log('with the clone in ai/');
    landClone();
    const found = await preflight();
    check('the preflight resolves it with no box', !!(found && same(found.runbook, runbook)) && (await dialogs()).length === 8, found);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
