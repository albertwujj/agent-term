// The agent's change brings a rolled-up review up full, scrolled to what it
// changed; a review the user already had up (split) comes up full where it
// was. The review is long and both changes land near its end: a reply on a
// thread there (the agent's journal), and new diff lines (a re-render). While
// a sent thread waits on the agent, its explanation and its commit hold the
// band; its status brings it up. Drives the real app and the real review
// render.
//
// Run: npm run test:e2e
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron } from './electron.mjs';

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'at-review-land-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'e2e');
git('config', 'user.email', 'e2e@example.invalid');
fs.writeFileSync(path.join(repo, 'f.js'), 'export const a = 1;\n');
git('add', '.');
git('commit', '-qm', 'Base');
const base = git('rev-parse', 'HEAD');
fs.appendFileSync(path.join(repo, 'f.js'), 'export const b = 2;\n');
git('commit', '-qam', 'Add b');
const dir = path.join(repo, '.git', 'review', 'main');
fs.mkdirSync(dir, { recursive: true });
const pkg = path.join(dir, 'main.md');
// Long prose first, so the thread and the diff sit far below the top.
const pkgText = (head) => `---\nrange: ${base}..${head}\n---\n\n# Review\n\n`
  + Array.from({ length: 50 }, (_, i) => `Context paragraph ${i + 1} of the review.`).join('\n\n')
  + '\n\nThe last paragraph, where the thread sits.\n\n:::diff f.js\n';
fs.writeFileSync(pkg, pkgText(git('rev-parse', 'HEAD')));
fs.writeFileSync(path.join(dir, 'main-comments.json'), JSON.stringify({
  version: 1,
  turn: 1,
  threads: [{
    id: 't1',
    anchor: { snippet: 'The last paragraph, where the thread sits.' },
    messages: [{ author: 'user', body: 'Is this the right place?', ts: 1, turn: 1 }],
  }],
}, null, 2));
const journal = path.join(dir, 'main-agent.jsonl');
const reply = (body, status) => fs.appendFileSync(journal,
  JSON.stringify({ thread: 't1', body, ...(status ? { status } : {}), ts: Date.now(), turn: 1 }) + '\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

const app = await launchElectron({
  executablePath: require('electron'),
  args: ['--no-sandbox', `--user-data-dir=${path.join(tmp, 'userdata')}`, APP_DIR],
  env: { ...process.env, AGENT_TERM_START_CWD: repo, AGENT_STREAM_HUB_URL: '/', TMUX: '', STY: '', ZELLIJ: '' },
  timeout: 45_000,
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 900));
  await sleep(1000);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  const terminal = page.locator('.xterm-helper-textarea');
  await terminal.focus();
  await page.keyboard.type(`echo review://${pkg}`);
  await page.keyboard.press('Enter');
  await sleep(700);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.vb-shell.vb-web.open');
  const inReview = (code) => app.evaluate(({ webContents }, code) => {
    const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview'
      && /[/\\]review[/\\]main[/\\]main\.html(?:$|[?#])/.test(w.getURL()));
    return guest ? guest.executeJavaScript(code) : null;
  }, code);
  const waitFor = async (fn, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { if (await fn()) return true; } catch {}
      await sleep(150);
    }
    return false;
  };
  const band = () => page.evaluate(() => {
    const s = document.querySelector('.vb-shell.vb-web');
    if (!s) return 'none';
    if (s.classList.contains('open')) return s.classList.contains('vb-full') ? 'full' : 'golden';
    return s.classList.contains('hidden') ? 'hidden' : 'closed';
  });
  // Whether the selector's first match is inside the review's viewport.
  const inView = (selector) => inReview(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  })()`);
  const toTop = () => inReview('window.scrollTo(0, 0); scrollY');
  const rollUpByTyping = async () => {
    await terminal.focus();
    await page.keyboard.type('x');
    await page.keyboard.press('Control+U'); // the typing is over
    return waitFor(async () => (await band()) === 'hidden', 2000);
  };

  check('the review renders its thread', await waitFor(() => inReview('!!document.querySelector(".rv-thread[data-rv-tid=\\"t1\\"]")'), 15_000));
  check('the review opens full', await band() === 'full', await band());
  await toTop();
  check('the thread starts out of view', !(await inView('.rv-thread[data-rv-tid="t1"]')));

  // A reply out of a roll-up: up full, scrolled to the reply.
  console.log('A reply, out of a roll-up');
  check('typing rolls the review up', await rollUpByTyping(), await band());
  reply('Should it sit above instead?', 'open');
  check('the reply brings it up full', await waitFor(async () => (await band()) === 'full', 8000), await band());
  check('scrolled to the pulsing reply', await waitFor(() => inView('.rv-pulse'), 8000));
  check('which left the top', (await inReview('scrollY')) > 200, await inReview('scrollY'));
  await sleep(10_000); // the reply's pulse runs out

  // A reply at the split: up full, where the user was.
  console.log('A reply, from the split');
  await toTop();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('viewer-shortcut', 'size'));
  check('the size chord splits', await waitFor(async () => (await band()) === 'golden', 2000), await band());
  reply('And one more note.', 'open');
  check('the reply takes it full', await waitFor(async () => (await band()) === 'full', 8000), await band());
  await sleep(1500);
  check('the review stays at the top', (await inReview('scrollY')) < 1, await inReview('scrollY'));
  await sleep(9000);

  // New diff lines out of a roll-up: the review re-renders and reloads, then
  // scrolls to the first new line.
  console.log('New diff lines, out of a roll-up');
  await toTop();
  check('typing rolls the review up again', await rollUpByTyping(), await band());
  fs.appendFileSync(path.join(repo, 'f.js'), 'export const c = 3;\n');
  git('commit', '-qam', 'Add c');
  fs.writeFileSync(pkg, pkgText(git('rev-parse', 'HEAD')));
  check('the re-render brings it up full', await waitFor(async () => (await band()) === 'full', 10_000), await band());
  check('scrolled to the new line, pulsing', await waitFor(async () => {
    const pulsing = await inReview('(document.querySelector("td.code.add.rv-pulse") || {}).textContent || ""');
    return /const c = 3/.test(pulsing) && await inView('td.code.add.rv-pulse');
  }, 10_000));

  // The user follows up on the thread (a send stamps its turn). The agent
  // explains, commits, then sets the status: the band holds through the
  // explanation and the re-render, and the status brings it up on what pulses.
  console.log('Explanation, commit, then status, out of a roll-up');
  const storePath = path.join(dir, 'main-comments.json');
  const s = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  s.turn = 2;
  s.threads[0].messages.push({ author: 'user', body: 'And the next one?', ts: Date.now(), turn: 2 });
  fs.writeFileSync(storePath, JSON.stringify(s, null, 2));
  await sleep(2500); // main's poll has read the follow-up
  await toTop();
  check('typing rolls the review up once more', await rollUpByTyping(), await band());
  reply('Adding d after c.');
  await sleep(6000); // main's poll, and more than the rest after it
  check('the explanation alone holds the band', await band() === 'hidden', await band());
  fs.appendFileSync(path.join(repo, 'f.js'), 'export const d = 4;\n');
  git('commit', '-qam', 'Add d');
  fs.writeFileSync(pkg, pkgText(git('rev-parse', 'HEAD')));
  check('the review re-renders', await waitFor(() => inReview('/const d = 4/.test(document.body.textContent)'), 15_000));
  await sleep(4000); // past the rest after the re-render
  check('the re-render holds the band while the thread waits', await band() === 'hidden', await band());
  reply('Added d. Should c go as well?', 'open');
  check('the status brings it up full', await waitFor(async () => (await band()) === 'full', 8000), await band());
  check('scrolled to what pulses', await waitFor(() => inView('.rv-pulse'), 8000));
  check('which left the top', (await inReview('scrollY')) > 200, await inReview('scrollY'));
} finally {
  await app.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('review-land-on-change passed');
