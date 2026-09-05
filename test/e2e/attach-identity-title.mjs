// End-to-end tests for a window's identity title — the name the picker shows
// for the conversation. The original case is a window attached to a
// conversation started outside agent-term: the user starts the CLI here,
// resumes it in the CLI's own dialog, and only then types a prompt. By then
// the CLI has already re-emitted the conversation's topic title, before the
// first prompt, so the boot vocabulary would have swallowed it. The rest
// cover the CLIs whose default OSC title is not a conversation name at all.
// Each fake CLI is a shell function named for the CLI it stands in for,
// playing that CLI's real OSC title sequence back against typed lines.
//
//   1. claude attach: banner, /resume, topic title, pick, prompt, spinner
//      re-emission → exactly one title event, logged after the prompt, and
//      the fold takes it as the identity title; the re-emission is not
//      logged twice
//   2. claude fresh start: banner, prompt, topic title
//      → the banner is never logged; the topic is the identity title
//   3. cursor fresh start: the "Cursor Agent" banner, prompt, topic title
//      → the banner reads as a brand label and is never logged
//   4. codex picker start-new: the launch carries the supported
//      tui.terminal_title override, so codex emits "codex | <thread>"
//      → the pre-name thread UUID is never logged, the named thread is
//   5. codex picker resume: the resume launch carries the same override, and
//      a project label already in the log is repaired by the named thread
//   6. codex typed by hand, so no override: the project label and its
//      spinner frames never become a conversation title
//
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
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0; const failures = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const osc = (title) => `printf '\\033]0;%s\\007' '${title}'`;
const PROMPT = 'please add retry logic to the uploader';

// Launch the app on a fresh userData dir, define the fake CLI, start it, play
// the typed lines with a pause after each, and return the log events of the
// session the window recorded. How it starts decides which launch path is
// under test: `seed` pre-writes a past session and picks it (picker-pick,
// with the resume intercept armed), `pickerLaunch` sends picker-start-new,
// and the default types the bare command the way the user would in the shell.
// Only the picker paths go through the launch-command rewrite, so the codex
// scenarios below can tell "we supplied the setting" from "we didn't".
async function runScenario(name, fakeBody, lines, { cli = 'claude', pickerLaunch = false, seed = [] } = {}) {
  const UD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-attach-e2e-')));
  for (const event of seed) sessionsLog.appendEvent(UD, event);
  const app = await electron.launch({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', `--user-data-dir=${UD}`, APP_DIR], timeout: 45_000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await sleep(1500);
  if (await page.evaluate(() => !!document.querySelector('.at-picker-overlay'))) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea').focus());
  // `claude() {` does not match the CLI pattern (no space after the name), so
  // defining the function is an ordinary shell command; running it is not.
  await page.keyboard.type(`${cli}() { ${fakeBody} }`);
  await page.keyboard.press('Enter');
  await sleep(400);
  if (seed.length) {
    await page.evaluate((id) => window.pty.pickerPick(id), seed[0].id);
  } else if (pickerLaunch) {
    await page.evaluate((command) => window.pty.pickerStartNew(command), cli);
  } else {
    await page.keyboard.type(cli);
    await page.keyboard.press('Enter');
  }
  await sleep(1000);
  for (const line of lines) {
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
    await sleep(700);
  }
  await sleep(1500);
  await app.close();
  const events = sessionsLog.readLog(UD);
  const ids = [...new Set(events.filter(e => e.e === 'started').map(e => e.id))];
  console.log(`${name}: session ids ${JSON.stringify(ids)}`);
  const id = ids[0];
  return {
    events: events.filter(e => e.id === id),
    session: sessionsLog.listSessions(UD).find(s => s.id === id),
  };
}

console.log('1 — attach: topic re-emitted before the first prompt');
{
  const fake = [
    osc('Claude Code'), 'read -r a',            // banner; user types /resume
    osc('Fix window titles'), 'read -r b',      // resume replay; user filters + picks
    'read -r c',                                // first prompt
    osc('* Fix window titles'), 'read -r d',    // spinner re-emission of the topic
  ].join('; ') + ';';
  const { events, session } = await runScenario('attach', fake, ['/resume', 'fix', PROMPT]);
  const promptIdx = events.findIndex(e => e.e === 'prompt');
  const titleIdxs = events.map((e, i) => e.e === 'title' ? i : -1).filter(i => i >= 0);
  check('session recorded with the typed prompt', session && session.prompt === PROMPT, JSON.stringify(session));
  check('exactly one title event', titleIdxs.length === 1, JSON.stringify(events.filter(e => e.e === 'title')));
  check('the title event follows the prompt', titleIdxs.length === 1 && titleIdxs[0] > promptIdx);
  check('identity title is the topic', session && session.title === 'Fix window titles', session && session.title);
  check('lastTitle agrees', session && session.lastTitle === 'Fix window titles', session && session.lastTitle);
}

console.log('2 — fresh start: banner, prompt, then the topic');
{
  const fake = [
    osc('Claude Code'), 'read -r a',            // banner; user types the prompt
    osc('Fix window titles'), 'read -r b',      // the CLI names the conversation
  ].join('; ') + ';';
  const { events, session } = await runScenario('fresh', fake, [PROMPT]);
  const promptIdx = events.findIndex(e => e.e === 'prompt');
  const titles = events.filter(e => e.e === 'title');
  check('session recorded with the typed prompt', session && session.prompt === PROMPT, JSON.stringify(session));
  check('banner never logged', !titles.some(e => /claude code/i.test(e.title)), JSON.stringify(titles));
  check('no title before the prompt', !events.slice(0, promptIdx).some(e => e.e === 'title'));
  check('identity title is the topic', session && session.title === 'Fix window titles', session && session.title);
}

console.log('3 — Cursor fresh start: startup banner, prompt, then the topic');
{
  const fake = [osc('Cursor Agent'), 'read -r a', osc('Root Cause Triage'), 'read -r b'].join('; ') + ';';
  const { events, session } = await runScenario('cursor-fresh', fake, [PROMPT], { cli: 'agent' });
  check('Cursor records its topic as identity', session && session.title === 'Root Cause Triage', session && session.title);
  check('Cursor banner never logged', !events.some(e => e.e === 'title' && /cursor agent/i.test(e.title)),
    JSON.stringify(events.filter(e => e.e === 'title')));
}

const CODEX_TOPIC = 'codex | Investigate WSL launch failures';
// Make the fake emit a topic only if the actual launch path supplies the
// supported setting. This tests wiring through main, not just the helper.
const codexWithTitleSetting = (body) =>
  `if [ "$1" != '-c' ] || [ "$2" != 'tui.terminal_title=["app-name","thread"]' ]; then ${osc('agent-term-debug')}; read -r missing; return; fi; ${body}`;

console.log('4 — Codex picker launch: unnamed ID, prompt, then named thread');
{
  const fake = codexWithTitleSetting([
    osc('codex | 01a072c1-544f-7153-9da1-a39c29e6e9b9'), 'read -r a',
    osc(CODEX_TOPIC), 'read -r b',
  ].join('; ') + ';');
  const { events, session } = await runScenario('codex-fresh', fake, [PROMPT], { cli: 'codex', pickerLaunch: true });
  check('Codex picker launch supplies the title setting', session && session.title === CODEX_TOPIC, session && session.title);
  check('Codex unnamed ID never logged', events.filter(e => e.e === 'title').every(e => e.title === CODEX_TOPIC),
    JSON.stringify(events.filter(e => e.e === 'title')));
}

console.log('5 — Codex resume repairs an old project label through actual title output');
{
  const fake = codexWithTitleSetting([
    osc('codex'), 'read -r a', // intercepted Enter supplies /resume
    osc(CODEX_TOPIC), 'read -r b',
  ].join('; ') + ';');
  const { session } = await runScenario('codex-resume', fake, [''], {
    cli: 'codex',
    seed: [
      { e: 'started', id: 152, hue: 48 },
      { e: 'cli', id: 152, cli: 'codex' },
      { e: 'prompt', id: 152, prompt: PROMPT },
      { e: 'title', id: 152, title: 'agent-term-debug' },
    ],
  });
  check('Codex resume supplies title setting and repairs identity', session && session.title === CODEX_TOPIC, session && session.title);
  check('resuming preserves the first prompt', session && session.prompt === PROMPT, session && session.prompt);
}

console.log('6 — Codex manually launched with default title never claims a project as the topic');
{
  const fake = [osc('agent-term-debug'), 'read -r a', osc('⠙ agent-term-debug'), 'read -r b'].join('; ') + ';';
  const { events, session } = await runScenario('codex-default', fake, [PROMPT], { cli: 'codex' });
  check('manual Codex still captures prompts', session && session.prompt === PROMPT, session && session.prompt);
  check('default project title is not recorded', session && session.title === null && !events.some(e => e.e === 'title'),
    JSON.stringify(events.filter(e => e.e === 'title')));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('failures: ' + failures.join('; ')); process.exit(1); }
