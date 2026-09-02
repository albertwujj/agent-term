// End-to-end test for the identity title of a window attached to a
// conversation that was started outside agent-term: the user starts the CLI
// here, resumes the conversation in the CLI's own dialog, and only then types
// a prompt. By then the CLI has already re-emitted the conversation's topic
// title, before the first prompt, so the boot vocabulary would have swallowed
// it. The fake CLI below is a shell function named `claude` that plays the
// CLI's OSC title sequence back against typed lines.
//
//   1. attach: banner, /resume, topic title, pick, prompt, spinner re-emission
//      → exactly one title event, logged after the prompt, and the fold takes
//        it as the identity title; the re-emission is not logged twice
//   2. fresh start: banner, prompt, topic title
//      → the banner is never logged; the topic is the identity title
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

// Launch the app on a fresh userData dir, define the fake CLI, start it as
// `claude` (the same detection the picker's start-new path lands on), play
// the typed lines with a pause after each, and return the log events of the
// session the window recorded.
async function runScenario(name, fakeBody, lines) {
  const UD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-attach-e2e-')));
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
  await page.keyboard.type(`claude() { ${fakeBody} }`);
  await page.keyboard.press('Enter');
  await sleep(400);
  await page.keyboard.type('claude');
  await page.keyboard.press('Enter');
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('failures: ' + failures.join('; ')); process.exit(1); }
