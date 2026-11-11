// A review reminder is an explicit retry for one sent thread. Exercise the
// real guest, main handler, journal merge and PTY with a fake Cursor composer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron } from './electron.mjs';

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'at-review-remind-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'e2e');
git('config', 'user.email', 'e2e@example.invalid');
fs.writeFileSync(path.join(repo, 'limits.py'), 'FIRST = None\nSECOND = None\nTHIRD = None\n');
git('add', '.');
git('commit', '-qm', 'Base');
const base = git('rev-parse', 'HEAD');
fs.writeFileSync(path.join(repo, 'limits.py'), 'FIRST = 1\nSECOND = 2\nTHIRD = 3\n');
git('commit', '-qam', 'Set limits');
const runbook = path.join(repo, 'ai', 'agent-threads', 'code', 'produce-review.md');
fs.mkdirSync(path.dirname(runbook), { recursive: true });
fs.writeFileSync(runbook, '# Review runbook\n');
const dir = path.join(repo, '.git', 'review', 'main');
fs.mkdirSync(dir, { recursive: true });
const pkg = path.join(dir, 'main.md');
const storePath = path.join(dir, 'main-comments.json');
const journalPath = path.join(dir, 'main-agent.jsonl');
fs.writeFileSync(pkg, `---\nrange: ${base}..${git('rev-parse', 'HEAD')}\n---\n\n# Limits\n\n:::diff limits.py\n`);
fs.writeFileSync(storePath, JSON.stringify({ version: 1, turn: 0, threads: ['first', 'second'].map((id, i) => ({
  id, anchor: { path: 'limits.py', side: 'new', line: i + 1, snippet: `${id.toUpperCase()} = ${i + 1}` },
  anchor_status: 'ok', messages: [{ author: 'user', body: `Why this ${id} limit?`, ts: Date.now() }],
})) }));

const received = path.join(tmp, 'received');
const fake = path.join(tmp, 'cursor.cjs');
fs.writeFileSync(fake, `
  const fs = require('node:fs');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let text = '';
  function draw() {
    process.stdout.write('\\r\\x1b[2K› ' + (text || '\\x1b[2mAsk anything\\x1b[22m\\x1b[12D'));
  }
  process.stdout.write('\\x1b[?2004h\\x1b]0;Review limits - ⏳ Working ...\\x07Fake Cursor session\\r\\n');
  draw();
  process.stdin.on('data', data => {
    fs.appendFileSync(${JSON.stringify(received)}, data);
    const value = data.toString().replace(/\\x1b\\[20[01]~/g, '');
    if (value.includes('\\x03')) process.exit(0);
    if (value.includes('\\x15') || value.includes('\\r')) text = '';
    else text += value;
    draw();
  });
`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, message, timeout = 15_000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(80);
  }
  throw new Error(`${message}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}
const input = () => fs.existsSync(received) ? fs.readFileSync(received, 'utf8') : '';
const readStore = () => fs.readFileSync(storePath, 'utf8');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const app = await launchElectron({
  executablePath: require('electron'),
  args: ['--no-sandbox', `--user-data-dir=${path.join(tmp, 'userdata')}`, APP_DIR],
  env: { ...process.env, AGENT_TERM_START_CWD: repo, AGENT_STREAM_HUB_URL: '/', TMUX: '', STY: '', ZELLIJ: '' },
  timeout: 45_000,
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea');
  await sleep(1000);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 900));
  const write = data => page.evaluate(data => window.pty.write(data), data);
  await write(`echo review://${pkg}\r`);
  await sleep(500);
  await write(`agent() { ${quote(process.execPath)} ${quote(fake)}; }\r`);
  await sleep(300);
  await page.evaluate(() => window.pty.pickerStartNew('agent'));
  await waitFor(() => page.evaluate(() => window.promptHoldsInput() === false), 'fake composer not empty');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.vb-shell.vb-web.open');
  const inReview = code => app.evaluate(({ webContents }, code) => {
    const guest = webContents.getAllWebContents().find(w => w.getType() === 'webview'
      && /[/\\]review[/\\]main[/\\]main\.html(?:$|[?#])/.test(w.getURL()));
    return guest ? guest.executeJavaScript(code) : null;
  }, code);
  const actions = id => inReview(`Array.from(document.querySelectorAll('[data-rv-tid="${id}"] .rv-thread-actions button')).map(b => b.dataset.act)`);
  const click = (id, action) => inReview(`document.querySelector('[data-rv-tid="${id}"] [data-act="${action}"]').click()`);
  await waitFor(() => inReview('document.querySelectorAll(".rv-thread").length === 2'), 'review threads missing');
  assert.deepEqual(await actions('first'), ['edit', 'send', 'toprompt', 'discard']);
  await click('first', 'send');
  await waitFor(async () => (await actions('first')).includes('remind'), 'send did not offer reminder');
  assert.deepEqual(await actions('first'), ['comment', 'remind']);
  await waitFor(() => input().includes('\r'), 'initial send was not submitted');
  console.log('PASS sent waiting threads offer Comment and Remind agent');

  const afterSend = input();
  // Outwait the removed 60-second timer with no substantive output. Cursor's
  // busy title stays set, just as during a long thinking phase or tool call.
  await sleep(65_000);
  assert.equal(input(), afterSend, 'an automatic reminder was sent while Cursor was busy');
  console.log('PASS no automatic reminder after the former stall threshold');

  // Park another comment without sending. A reminder must not stamp or send it.
  await inReview(`(() => {
    document.querySelector('td.ln[data-side="new"][data-line="3"]').click();
    const ta = document.querySelector('.rv-compose-row textarea');
    ta.value = 'Keep this draft unsent';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('section.file h2').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  })()`);
  await waitFor(() => JSON.parse(readStore()).threads.length === 3, 'draft was not parked');
  const beforeRemind = readStore();
  const atRemind = input().length;
  await inReview(`(() => {
    const b = document.querySelector('[data-rv-tid="first"] [data-act="remind"]');
    b.click(); b.dispatchEvent(new Event('click'));
  })()`);
  await waitFor(() => input().slice(atRemind).includes('\r'), 'manual reminder was not submitted');
  const reminder = input().slice(atRemind);
  assert.equal((reminder.match(/Recheck review comment thread/g) || []).length, 1, 'duplicate click sent twice');
  assert.ok(reminder.includes(`thread "first" in ${storePath}`));
  assert.ok(reminder.includes(`per ${runbook}`));
  assert.ok(reminder.includes('anything still needing attention'));
  assert.ok(!reminder.includes('thread "second"'));
  assert.equal(readStore(), beforeRemind, 'reminder changed messages, stamps or turn');
  assert.ok(!fs.existsSync(journalPath), 'reminder wrote an agent reply');
  console.log('PASS reminder targets one thread once and leaves the conversation and other drafts unchanged');

  // Freeze the viewer's read response at its last snapshot, then let the
  // agent resolve on disk. A click on that stale card must use the real files.
  await app.evaluate(({ ipcMain }, data) => {
    globalThis.__reviewRead = { success: true, data, sessionFirstTurn: 1, resolvedAtSend: [] };
    ipcMain.removeHandler('read-review-comments');
    ipcMain.handle('read-review-comments', () => globalThis.__reviewRead);
  }, JSON.parse(beforeRemind));
  fs.appendFileSync(journalPath, JSON.stringify({ thread: 'first', status: 'resolved', ts: Date.now(), turn: 1 }) + '\n');
  const beforeStale = input();
  await click('first', 'remind');
  await waitFor(() => inReview('!document.querySelector("[data-rv-tid=first] [data-act=remind]")'), 'stale card did not refresh');
  await app.evaluate(() => { globalThis.__reviewRead.data.threads.find(t => t.id === 'first').status = 'resolved'; });
  assert.equal(input(), beforeStale, 'stale reminder reached the CLI');
  assert.equal(readStore(), beforeRemind);
  console.log('PASS a stale card refreshes without reminding about a resolved thread');

  // Typed terminal text must never be submitted by a reminder's Enter.
  await write('half written user draft');
  await sleep(300);
  const beforeDraft = input().length;
  await click('second', 'remind');
  await waitFor(() => input().slice(beforeDraft).includes('thread "second"'), 'reminder did not join the prompt');
  await sleep(500);
  assert.ok(!input().slice(beforeDraft).includes('\r'), 'reminder submitted the unfinished user draft');
  assert.equal(readStore(), beforeRemind);
  console.log('PASS a terminal draft receives the reminder without submission');

  fs.appendFileSync(journalPath, JSON.stringify({ thread: 'second', body: 'Which value do you want?', status: 'open', ts: Date.now(), turn: 1 }) + '\n');
  await app.evaluate(({ webContents }) => {
    globalThis.__reviewRead.data.threads.find(t => t.id === 'second').status = 'open';
    const guest = webContents.getAllWebContents().find(w => w.getType() === 'webview');
    guest.send('rv-refresh');
  });
  await waitFor(() => inReview('!document.querySelector("[data-rv-tid=second] [data-act=remind]")'), 'blocked thread still offered reminder');
  assert.ok(!JSON.parse(readStore()).threads[2].messages[0].turn, 'other draft was marked sent');
  console.log('PASS threads waiting on the user have no reminder action');

  // The markdown viewer shares the same handler logic, including edit threads
  // whose sealed block used to have no row when there was no attached note.
  const doc = path.join(repo, 'plan.md');
  fs.writeFileSync(doc, '# Plan\n\nFirst paragraph of the plan.\n\nSecond paragraph uses vague wording.\n\nThird paragraph needs your choice.\n');
  const mdStore = path.join(repo, '.agent-threads', 'plan-comments.json');
  const mdJournal = path.join(repo, '.agent-threads', 'plan-agent.jsonl');
  fs.mkdirSync(path.dirname(mdStore), { recursive: true });
  const mdRunbook = path.join(repo, 'ai', 'agent-threads', 'md', 'user-intent.md');
  fs.mkdirSync(path.dirname(mdRunbook), { recursive: true });
  fs.writeFileSync(mdRunbook, '# Document runbook\n');
  const mdThreads = [
    { id: 'md-first', anchor: { snippet: 'First paragraph of the plan.' },
      messages: [{ author: 'user', body: 'Please check the first paragraph.', ts: 10, turn: 1 }] },
    { id: 'md-edit', anchor: { snippet: 'Second paragraph uses vague wording.', wholeBlock: true },
      messages: [{ author: 'user', body: '[Edit] Second paragraph uses <del>vague</del><ins>clear</ins> wording. [/Edit]', ts: 10, turn: 1 }] },
    { id: 'md-blocked', anchor: { snippet: 'Third paragraph needs your choice.' },
      messages: [{ author: 'user', body: 'Please check the third paragraph.', ts: 10, turn: 1 }] },
  ];
  fs.writeFileSync(mdStore, JSON.stringify({ version: 1, turn: 1, threads: mdThreads }));
  fs.writeFileSync(mdJournal, JSON.stringify({ thread: 'md-blocked', body: 'Which choice?', status: 'open', ts: 20, turn: 1 }) + '\n');
  await write('\x03');
  await sleep(500);
  await write(`echo ${doc}`);
  await write('\r');
  await sleep(500);
  await page.evaluate(() => window.pty.pickerStartNew('agent'));
  await sleep(500);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.vb-shell.vb-md.open .md-viewer-body h1');
  const mdRow = id => `.primary [data-md-keep-key="thread:${id}"]`;
  const mdOpen = id => page.locator(mdRow(id)).evaluate(el => el.click());
  await waitFor(() => page.locator(mdRow('md-first')).count(), 'markdown thread did not load');
  await mdOpen('md-first');
  assert.deepEqual(await page.locator(`${mdRow('md-first')} .md-thread-actions button`).allTextContents(), ['Reply', 'Remind agent']);
  assert.equal(await page.locator(`${mdRow('md-blocked')} .md-thread-remind`).count(), 0);
  const mdBefore = fs.readFileSync(mdStore, 'utf8');
  const mdJournalBefore = fs.readFileSync(mdJournal, 'utf8');
  const atMdRemind = input().length;
  // Both article copies share one in-flight guard.
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('.md-thread-remind[data-md-remind-thread="md-first"]')) {
      button.dispatchEvent(new Event('click'));
    }
  });
  await waitFor(() => input().slice(atMdRemind).includes('\r'), 'markdown reminder not submitted');
  const mdReminder = input().slice(atMdRemind);
  assert.equal((mdReminder.match(/Recheck comment thread/g) || []).length, 1);
  assert.ok(mdReminder.includes(`Markdown document: ${doc}`));
  assert.ok(mdReminder.includes(`thread "md-first" in ${mdStore}`));
  assert.ok(mdReminder.includes(`per ${mdRunbook}`));
  assert.equal(fs.readFileSync(mdStore, 'utf8'), mdBefore);
  assert.equal(fs.readFileSync(mdJournal, 'utf8'), mdJournalBefore);
  console.log('PASS markdown waiting threads offer the same targeted reminder without changing the store');

  await mdOpen('md-edit');
  await waitFor(() => page.locator(`${mdRow('md-edit')} .md-thread-remind`).count(), 'sent edit without a note has no reminder');
  const atEditRemind = input().length;
  await page.locator(`${mdRow('md-edit')} .md-thread-remind`).evaluate(el => el.click());
  await waitFor(() => input().slice(atEditRemind).includes('\r'), 'edit reminder not submitted');
  assert.ok(input().slice(atEditRemind).includes('thread "md-edit"'));
  assert.equal(fs.readFileSync(mdStore, 'utf8'), mdBefore);
  console.log('PASS a sent markdown edit without a note can be opened and reminded');

  // Keep the viewer at its prior snapshot to exercise the document handler's
  // stale-card check against the actual journal, rather than the UI poll.
  await app.evaluate(({ ipcMain }, data) => {
    ipcMain.removeHandler('md-read-threads');
    ipcMain.handle('md-read-threads', () => ({ success: true, data }));
  }, { version: 1, turn: 1, threads: mdThreads });
  fs.appendFileSync(mdJournal, JSON.stringify({ thread: 'md-first', status: 'resolved', ts: 30, turn: 1 }) + '\n');
  const beforeMdStale = input();
  await page.locator(`${mdRow('md-first')} .md-thread-remind`).evaluate(el => el.click());
  await waitFor(() => page.locator(`${mdRow('md-first')} .md-thread-remind`).count().then(n => n === 0), 'stale markdown card did not refresh');
  assert.equal(input(), beforeMdStale, 'stale markdown reminder reached the agent');
  assert.equal(fs.readFileSync(mdStore, 'utf8'), mdBefore);
  console.log('PASS a resolved markdown thread refreshes without sending a stale reminder');
} catch (error) {
  console.error('Last CLI input:', JSON.stringify(input().slice(-1800)));
  const page = await app.firstWindow();
  console.error('Reminder diagnostics:', await page.evaluate(() => ({
    mdApi: typeof window.pty.mdRemindAgent,
    notices: [...document.querySelectorAll('[class*="toast"]')].map(el => el.textContent),
    prompt: typeof window.promptHoldsInput === 'function' ? window.promptHoldsInput() : null,
  })));
  throw error;
} finally {
  await app.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
