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
//      → the macOS window/Dock title stays "codex" until the thread is named
//      → trailing spinner frames neither bypass the UUID check nor log churn
//   5. codex picker resume: the resume launch carries the same override, and
//      saved project/UUID spinner labels are skipped in favor of the named
//      thread in both the picker and its "Filter for" hint
//   6. codex typed by hand, so no override: the project label and its
//      spinner frames never become a conversation title
//   7. codex after a shell command: the launcher strip stays up, a
//      Shift-click on its codex chip types the line, an option is added by
//      hand, Enter runs it
//      → the override reached codex, and the named thread is the title
//   8. mention completion: one Enter picks the @ query, the next submits
//      the target URL → only the submitted target names the session
//   9. a rendered composer recovers only the picked prompt references,
//      which feed the preview and deep search through the same saved text
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
// `stripLaunch` runs a shell command first and Shift-clicks the launcher
// strip's chip, so the line is typed and the Enter that runs it is the
// user's, and the default types the bare command the way the user would in
// the shell. Only the picker and strip paths go through the launch-command
// rewrite, so the codex scenarios below can tell "we supplied the setting"
// from "we didn't".
async function runScenario(name, fakeBody, lines, { cli = 'claude', pickerLaunch = false, stripLaunch = false, seed = [] } = {}) {
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
  let pickerTitle = null;
  if (seed.length) {
    await page.evaluate(() => window.pty.reopenPicker());
    const row = page.locator(`.at-picker-row[data-id="${seed[0].id}"]`);
    await row.waitFor();
    pickerTitle = await row.locator('.at-picker-title-line').allTextContents();
    await row.click();
    await page.waitForSelector('.at-resume-hint');
  } else if (pickerLaunch) {
    await page.evaluate((command) => window.pty.pickerStartNew(command), cli);
  } else if (stripLaunch) {
    // The Escape above left the launcher strip up; a shell command keeps it.
    await page.keyboard.type('cd .');
    await page.keyboard.press('Enter');
    await sleep(300);
    await page.waitForSelector('.at-launcher', { timeout: 5_000 });
    await page.click(`.at-launcher-chip[data-cli="${cli}"]`, { modifiers: ['Shift'] });   // typed, left at the prompt
    await page.waitForSelector('.at-resume-hint.launch', { timeout: 5_000 });
    await page.waitForFunction(() => !document.querySelector('.at-launcher'), null, { timeout: 5_000 });
    await sleep(300);
    await page.keyboard.type('--model fake');   // an option added onto the typed line
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.at-resume-hint'), null, { timeout: 5_000 });
  } else {
    await page.keyboard.type(cli);
    await page.keyboard.press('Enter');
  }
  await sleep(1000);
  const nativeWindow = await app.browserWindow(page);
  const windowTitles = [await nativeWindow.evaluate(win => win.getTitle())];
  for (const line of lines) {
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
    await sleep(700);
    windowTitles.push(await nativeWindow.evaluate(win => win.getTitle()));
  }
  await sleep(1500);
  const resumeHintText = await page.locator('.at-resume-hint-tail').allTextContents();
  await app.close();
  const events = sessionsLog.readLog(UD);
  const ids = [...new Set(events.filter(e => e.e === 'started').map(e => e.id))];
  console.log(`${name}: session ids ${JSON.stringify(ids)}`);
  const id = ids[0];
  return {
    windowTitles,
    pickerTitle,
    resumeHintText,
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
  const { events, session, windowTitles } = await runScenario('fresh', fake, [PROMPT]);
  const promptIdx = events.findIndex(e => e.e === 'prompt');
  const titles = events.filter(e => e.e === 'title');
  check('session recorded with the typed prompt', session && session.prompt === PROMPT, JSON.stringify(session));
  check('banner never logged', !titles.some(e => /claude code/i.test(e.title)), JSON.stringify(titles));
  check('no title before the prompt', !events.slice(0, promptIdx).some(e => e.e === 'title'));
  check('identity title is the topic', session && session.title === 'Fix window titles', session && session.title);
  if (process.platform === 'darwin') {
    check('Claude window title still follows the topic', windowTitles[1] === 'claude · Fix window titles', JSON.stringify(windowTitles));
  }
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
    osc('codex | 01a072c1-544f-7153-9da1-a39c29e6e9b9 ⠸'),
    osc('codex | 01a072c1-544f-7153-9da1-a39c29e6e9b9 ⠼'), 'read -r b',
    osc(CODEX_TOPIC), osc(CODEX_TOPIC + ' ⠋'), osc(CODEX_TOPIC + ' ⠙'), 'read -r c',
  ].join('; ') + ';');
  const { events, session, windowTitles } = await runScenario('codex-fresh', fake, [PROMPT, 'continue'], { cli: 'codex', pickerLaunch: true });
  check('Codex picker launch supplies the title setting', session && session.title === CODEX_TOPIC, session && session.title);
  check('Codex unnamed ID never logged', events.filter(e => e.e === 'title').every(e => e.title === CODEX_TOPIC),
    JSON.stringify(events.filter(e => e.e === 'title')));
  check('Codex trailing spinner changes do not add title events', events.filter(e => e.e === 'title').length === 1);
  if (process.platform === 'darwin') {
    check('Codex window/Dock title hides the UUID before and after the first prompt',
      windowTitles[0] === 'codex' && windowTitles[1] === 'codex', JSON.stringify(windowTitles));
    check('Codex window/Dock title shows the named thread when it arrives',
      windowTitles[2] === 'codex · Investigate WSL launch failures', JSON.stringify(windowTitles));
  }
}

console.log('5 — Codex resume repairs saved spinner UUIDs in the picker and filter hint');
{
  const resumedTopic = 'codex | Resumed WSL launch investigation';
  const fake = codexWithTitleSetting([
    osc('codex'), 'read -r a', // intercepted Enter supplies /resume
    osc(resumedTopic), 'read -r b',
  ].join('; ') + ';');
  const { session, pickerTitle, resumeHintText } = await runScenario('codex-resume', fake, [''], {
    cli: 'codex',
    seed: [
      { e: 'started', id: 152, hue: 48 },
      { e: 'cli', id: 152, cli: 'codex' },
      { e: 'prompt', id: 152, prompt: PROMPT },
      { e: 'title', id: 152, title: 'agent-term-debug' },
      { e: 'title', id: 152, title: 'codex | 01a0bacf-9f1a-7c22-926f-1a2db761b353 ⠸' },
      { e: 'title', id: 152, title: CODEX_TOPIC + ' ⠼' },
    ],
  });
  check('Codex resume supplies title setting', session && session.lastTitle === resumedTopic, session && session.lastTitle);
  check('Codex saved identity skips the spinner UUID', session && session.title === CODEX_TOPIC + ' ⠼', session && session.title);
  check('Codex picker shows the saved conversation name',
    JSON.stringify(pickerTitle) === JSON.stringify(['Investigate WSL launch failures']), JSON.stringify(pickerTitle));
  check('Codex filter hint shows the picked conversation name without its spinner',
    JSON.stringify(resumeHintText) === JSON.stringify(['Investigate WSL launch failures']), JSON.stringify(resumeHintText));
  check('resuming preserves the first prompt', session && session.prompt === PROMPT, session && session.prompt);
}

console.log('6 — Codex manually launched with default title never claims a project as the topic');
{
  const fake = [osc('agent-term-debug'), 'read -r a', osc('⠙ agent-term-debug'), 'read -r b'].join('; ') + ';';
  const { events, session, windowTitles } = await runScenario('codex-default', fake, [PROMPT], { cli: 'codex' });
  check('manual Codex still captures prompts', session && session.prompt === PROMPT, session && session.prompt);
  check('default project title is not recorded', session && session.title === null && !events.some(e => e.e === 'title'),
    JSON.stringify(events.filter(e => e.e === 'title')));
  if (process.platform === 'darwin') {
    check('Codex window/Dock title hides default project labels and their spinners',
      windowTitles.every(title => title === 'codex'), JSON.stringify(windowTitles));
  }
}

console.log('7 — Codex after a shell command: the launcher strip types the line, an option added by hand');
{
  const fake = codexWithTitleSetting([
    osc('codex | 01a072c1-544f-7153-9da1-a39c29e6e9b9'), 'read -r a',
    osc(CODEX_TOPIC), 'read -r b',
  ].join('; ') + ';');
  const { events, session } = await runScenario('codex-strip', fake, [PROMPT], { cli: 'codex', stripLaunch: true });
  check('the strip\'s line carries the title setting past a hand-typed option',
    session && session.title === CODEX_TOPIC, session && session.title);
  check('the session records codex and the typed prompt',
    session && session.cli === 'codex' && session.prompt === PROMPT, JSON.stringify(session));
  check('Codex unnamed ID never logged', events.filter(e => e.e === 'title').every(e => e.title === CODEX_TOPIC),
    JSON.stringify(events.filter(e => e.e === 'title')));
}

console.log('8 — mention-picker Enter followed by the actual prompt submission');
{
  const target = 'https://review.example/c/team/repo/+/10427036/2';
  const fake = [
    osc('Cursor Agent'), 'read -r query',
    "printf '@ai/review.md '", 'read -r submitted',
    osc('Review the proposed change'), 'read -r next',
  ].join('; ') + ';';
  const { events, session } = await runScenario('mention-completion', fake, ['@pr-rev', target], { cli: 'agent' });
  const prompts = events.filter(e => e.e === 'prompt');
  check('completion selection is never logged as a prompt', prompts.length === 1 && prompts[0].prompt === target,
    JSON.stringify(prompts));
  check('the first real submission names the session', session && session.prompt === target, JSON.stringify(session));
  check('the conversation title follows the real submission', session && session.title === 'Review the proposed change',
    session && session.title);
}

console.log('9 — only selected prompt references reach preview and deep search');
{
  const target = 'https://review.example/c/team/repo/+/10427036/2';
  const fixture = path.join(APP_DIR, 'test/fixtures/prompt-completion-cli.py');
  const fake = `python3 '${fixture.replace(/'/g, "'\\''")}';`;
  const { events, session } = await runScenario('rendered-completion', fake,
    ['@pr-rev', target, '@guide', 'more detail'], { cli: 'agent' });
  const prompts = events.filter(e => e.e === 'prompt');
  const expected = ['@ai/gerrit/pr-review.md ' + target, '@docs/guide.md more detail'];
  check('only the two actual submissions are captured, with selected paths',
    JSON.stringify(prompts.map(p => p.prompt)) === JSON.stringify(expected), JSON.stringify(prompts));
  check('the saved identity includes the first selected path', session && session.prompt === expected[0], JSON.stringify(session));
  const { extractPathsAndUrls } = require(path.join(APP_DIR, 'src/icon-render'));
  const refs = extractPathsAndUrls(session?.prompt).refs;
  check('the preview reference source includes the selected file',
    refs.some(ref => ref.full === '@ai/gerrit/pr-review.md'), JSON.stringify(refs));
  const deep = sessionsLog.searchHiddenPromptMatchesForSession(session, prompts, 'guide.md');
  check('deep search finds the selected filename in the follow-up prompt',
    deep && deep.matches.length === 1 && deep.matches[0].text === expected[1], JSON.stringify(deep));
  for (const excluded of ['never-picked.md', 'output-only.md']) {
    check(excluded + ' never enters saved prompts or deep search',
      !prompts.some(p => p.prompt.includes(excluded)) &&
      !sessionsLog.searchHiddenPromptMatchesForSession(session, prompts, excluded));
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('failures: ' + failures.join('; ')); process.exit(1); }
