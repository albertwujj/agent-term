// End-to-end: what moves the viewer band on its own, against a fake Claude in
// the real PTY.
//
//   - A resumed conversation reprints its history; a handoff in it (here a
//     conversation doc's path) does not open. Only output answering a turn the
//     user started opens one.
//   - A conversation doc's path printed in answer opens the doc, full; a second
//     one printed with it does not replace it, and a toast says it arrived.
//   - Any input to the terminal rolls the viewer up, a one-key answer included.
//   - A Send recedes the band to golden; it stays golden while the agent works
//     after answering, and returns to full once the CLI's title says idle.
//   - Typing in the viewer never resizes it.
//   - A handoff arriving while the user types in the terminal does not open:
//     a toast says it arrived.
//
// The fake CLI echoes nothing of its own beyond its output: the tty driver's
// cooked mode echoes the keystrokes, and its lines arrive on Enter.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launchElectron } from './electron.mjs';

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'at-viewer-auto-moves-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
git('init', '-q', '-b', 'main');
const conversation = path.join(repo, '.git', 'conversation');
fs.mkdirSync(conversation, { recursive: true });
const doc = (title) => `# ${title}\n\nThe first paragraph of this conversation doc carries enough words to click on.\n\n`
  + 'The second paragraph is here so the page has more than one block.\n';
for (const name of ['replayed', 'first', 'second']) fs.writeFileSync(path.join(conversation, `${name}.md`), doc(name));
// The runbook the md send preflights, vendored where the host looks first.
fs.mkdirSync(path.join(repo, 'ai', 'agent-threads', 'md'), { recursive: true });
fs.writeFileSync(path.join(repo, 'ai', 'agent-threads', 'md', 'user-intent.md'), '# user intent (stub)\n');
// Two review packages: one in the resumed history, one printed later.
const reviewPkg = (branch) => {
  const pkg = path.join(repo, '.git', 'review', branch, `${branch}.md`);
  fs.mkdirSync(path.dirname(pkg), { recursive: true });
  fs.writeFileSync(pkg, '---\nrange: a..b\n---\n\n# Review\n');
  return pkg;
};
const replayedReview = reviewPkg('main');
const laterReview = reviewPkg('later');
const store = path.join(conversation, '.agent-threads', 'first-comments.json');

const fake = path.join(tmp, 'fake-claude.cjs');
fs.writeFileSync(fake, `
  const fs = require('node:fs');
  const path = require('node:path');
  const conversation = ${JSON.stringify(conversation)};
  const store = ${JSON.stringify(store)};
  const replayedReview = ${JSON.stringify(replayedReview)};
  const laterReview = ${JSON.stringify(laterReview)};
  const title = (t) => process.stdout.write('\\x1b]0;' + t + '\\x07');
  title('✳ Fake session');
  if (process.argv.includes('--resume')) {
    process.stdout.write('Earlier in this conversation:\\r\\n' + path.join(conversation, 'replayed.md') + '\\r\\n'
      + 'Review: review://' + replayedReview + '\\r\\n');
  }
  let working = false;
  function work(then) {
    working = true;
    title('◐ Fake session');
    then(() => { working = false; title('✳ Fake session'); });
  }
  function onLine(line) {
    if (/split please/.test(line)) {
      work((done) => setTimeout(() => {
        process.stdout.write('\\r\\n' + path.join(conversation, 'first.md') + '\\r\\n' + path.join(conversation, 'second.md') + '\\r\\n');
        done();
      }, 300));
    } else if (/comments\\.json/.test(line) && !working) {
      // Answer every thread waiting on the agent, then keep working a while.
      work((done) => setTimeout(() => {
        const s = JSON.parse(fs.readFileSync(store, 'utf8'));
        for (const t of s.threads) {
          const last = t.messages[t.messages.length - 1];
          if ((t.status || 'open') === 'open' && last.author === 'user') {
            t.messages.push({ author: 'agent', body: 'Tightened.', ts: Date.now(), turn: s.turn });
          }
        }
        fs.writeFileSync(store, JSON.stringify(s, null, 2));
        setTimeout(done, 3000);
      }, 500));
    } else if (/review later/.test(line)) {
      setTimeout(() => process.stdout.write('\\r\\nReview: review://' + laterReview + '\\r\\n'), 2500);
    }
  }
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\\n')) !== -1) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
`);

const app = await launchElectron({
  executablePath: require('electron'),
  args: ['--no-sandbox', `--user-data-dir=${path.join(tmp, 'userdata')}`, APP_DIR],
  env: { ...process.env, TMUX: '', STY: '', ZELLIJ: '' },
  timeout: 45_000,
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await sleep(1000);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  const terminal = page.locator('.xterm-helper-textarea');
  const typeLine = async (text) => {
    await terminal.focus();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };
  const band = (name) => page.evaluate((name) => {
    const shell = document.querySelector(`.vb-shell.vb-${name}`);
    if (!shell) return 'none';
    if (shell.classList.contains('open')) return shell.classList.contains('vb-full') ? 'full' : 'golden';
    return shell.classList.contains('hidden') ? 'hidden' : 'closed';
  }, name);
  const waitBand = async (name, state, timeout) => {
    const until = Date.now() + timeout;
    let now;
    while ((now = await band(name)) !== state && Date.now() < until) await sleep(100);
    return now;
  };
  const toastSeen = (text) => page.evaluate((text) => [...document.body.children]
    .some((el) => el.tagName === 'DIV' && el.textContent.includes(text)), text);
  const waitToast = async (text, timeout) => {
    const until = Date.now() + timeout;
    while (!(await toastSeen(text)) && Date.now() < until) await sleep(100);
    return toastSeen(text);
  };

  await typeLine(`claude() { ${quote(process.execPath)} ${quote(fake)} "$@"; }`);
  await sleep(300);
  await typeLine('claude --resume');
  await sleep(3000);
  check('a resumed conversation\'s reprinted handoffs do not open',
    await band('md') === 'none' && await band('web') === 'none', [await band('md'), await band('web')]);

  await typeLine('split please');
  check('a conversation doc printed in answer to a prompt opens, full', await waitBand('md', 'full', 8000) === 'full', await band('md'));
  const title = await page.locator('.vb-shell.vb-md .vb-title').textContent();
  check('it is the first doc printed', title.endsWith('first.md'), title);
  check('the second doc toasts instead of replacing it', await waitToast('Agent posted a doc', 3000));
  await sleep(500);
  check('and the first stays on stage', (await page.locator('.vb-shell.vb-md .vb-title').textContent()).endsWith('first.md'));

  await terminal.focus();
  await page.keyboard.press('1');
  check('a one-key answer in the terminal rolls the viewer up', await waitBand('md', 'hidden', 2000) === 'hidden', await band('md'));
  await page.keyboard.press('Control+U'); // clear the fake's line

  await page.locator('.vb-shell.vb-md .vb-bar').click({ position: { x: 300, y: 10 } });
  check('the handle brings it back at full', await waitBand('md', 'full', 2000) === 'full', await band('md'));
  await sleep(450); // a step swallows clicks off the bar for a beat

  // A Send at full: golden while the agent works, full once it is done.
  const paragraph = page.locator('.primary .md-viewer-body p').filter({ hasText: 'first paragraph' });
  await paragraph.click();
  await page.keyboard.type('Tighten this.');
  await page.waitForSelector('.md-comment-card textarea');
  await page.keyboard.press('Enter');
  check('a Send recedes the band to golden', await waitBand('md', 'golden', 3000) === 'golden', await band('md'));
  const answeredAt = Date.now() + 8000;
  const answered = () => {
    try { return JSON.parse(fs.readFileSync(store, 'utf8')).threads.every((t) => t.messages.at(-1).author === 'agent'); }
    catch { return false; }
  };
  while (!answered() && Date.now() < answeredAt) await sleep(100);
  check('the fake agent answered', answered());
  await sleep(1800); // the store poll has seen it; the CLI still works
  check('answered while the agent works keeps golden', await band('md') === 'golden', await band('md'));
  check('answered and idle returns to full', await waitBand('md', 'full', 5000) === 'full', await band('md'));

  // Typing in the viewer never resizes it.
  await page.locator('.vb-shell.vb-md .vb-bar').click({ position: { x: 300, y: 10 } });
  check('a click on the bar at full drops to golden', await waitBand('md', 'golden', 2000) === 'golden', await band('md'));
  await sleep(450); // a step swallows clicks off the bar for a beat
  await page.locator('.primary .md-viewer-body p').filter({ hasText: 'second paragraph' }).click();
  await page.keyboard.type('Another thought.');
  await sleep(800);
  check('typing a comment at golden leaves the size alone', await band('md') === 'golden', await band('md'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // A handoff while the user types in the terminal: a toast, not a band.
  await page.locator('.vb-shell.vb-md .vb-close').click({ force: true });
  await waitBand('md', 'closed', 2000);
  await typeLine('review later');
  await page.keyboard.type('abc'); // still typing when the link lands
  check('a review link arriving mid-typing toasts', await waitToast('a review', 5000));
  check('and opens nothing', await band('web') === 'none', await band('web'));
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
