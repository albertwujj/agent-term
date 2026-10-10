// Ticking a decision's circle confirms it: a [Confirm] message in the store,
// the heading green until the agent records it in the package, and the tick
// yours to take back until a send covers it. Driven with real mouse input.
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
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'at-review-confirm-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'e2e');
git('config', 'user.email', 'e2e@example.invalid');
fs.writeFileSync(path.join(repo, 'limits.py'), 'REFILL = None\nRETRIES = None\n');
git('add', '.');
git('commit', '-qm', 'Base');
const base = git('rev-parse', 'HEAD');
fs.writeFileSync(path.join(repo, 'limits.py'), 'REFILL = 10\nRETRIES = 3\n');
git('commit', '-qam', 'Set limits');
const dir = path.join(repo, '.git', 'review', 'main');
fs.mkdirSync(dir, { recursive: true });
const pkg = path.join(dir, 'main.md');
const storePath = path.join(dir, 'main-comments.json');
const journalPath = path.join(dir, 'main-agent.jsonl');
const packageText = (refill, retry) => `---\nrange: ${base}..${git('rev-parse', 'HEAD')}\n---\n
Only unconfirmed decisions need a response.

## [${refill}] Decision: refill rate

I defaulted the refill to 10/s; 25/s never sheds but lets a flood reach auth.

:::diff limits.py

## [${retry}] Decision: retry budget

Three retries, then the caller sees the error.
`;
fs.writeFileSync(pkg, packageText('unconfirmed', 'unconfirmed'));
// The agent already asked something on the second decision, and is blocked on the answer.
const now = Date.now();
fs.writeFileSync(storePath, JSON.stringify({ version: 1, turn: 1, threads: [{
  id: 'asked', anchor: { path: '(note 3)', side: '', line: '', snippet: 'Decision: retry budget', context: 'Decision: retry budget',
    wholeBlock: true, heading: '' }, anchor_status: 'ok',
  messages: [{ author: 'user', body: 'Why three?', ts: now - 60_000, turn: 1 }],
}] }, null, 2));
fs.writeFileSync(journalPath, JSON.stringify({ thread: 'asked', body: 'It covers one failover. Keep it?', status: 'open', ts: now - 30_000, turn: 1 }) + '\n');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, message) {
  const until = Date.now() + 15_000;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`${message}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}
const readStore = () => JSON.parse(fs.readFileSync(storePath, 'utf8'));
const confirmThreads = () => readStore().threads.filter(t => t.messages.some(m => m.body === '[Confirm] Decision: refill rate'));

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
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`echo review://${pkg}`);
  await page.keyboard.press('Enter');
  await sleep(700);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.vb-shell.vb-web.open');
  const inReview = code => app.evaluate(({ webContents }, code) => {
    const guest = webContents.getAllWebContents().find(w => w.getType() === 'webview'
      && /[/\\]review[/\\]main[/\\]main\.html(?:$|[?#])/.test(w.getURL()));
    return guest ? guest.executeJavaScript(code) : null;
  }, code);
  // Real mouse input on a decision's mark; clicks: 1 = click, 2 = double-click.
  const clickMark = async (n, clicks = 1) => {
    const pt = await inReview(`(() => {
      const m = document.querySelectorAll('h2.rv-decision > .rv-decision-mark')[${n}];
      m.scrollIntoView({ block: 'center' });
      const r = m.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await app.evaluate(({ webContents }, { pt, clicks }) => {
      const guest = webContents.getAllWebContents().find(w => w.getType() === 'webview');
      for (let c = 1; c <= clicks; c++) {
        guest.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: c });
        guest.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: c });
      }
    }, { pt, clicks });
  };
  const decision = n => inReview(`(() => {
    const h = document.querySelectorAll('h2.rv-decision')[${n}];
    const m = h.querySelector(':scope > .rv-decision-mark');
    const toc = document.querySelector('#toc a[href="#' + h.id + '"]');
    const card = h.parentElement.querySelector('.rv-quote-thread .rv-thread');
    return {
      state: h.classList.contains('rv-decision-confirmed') ? 'confirmed' : 'unconfirmed',
      toc: toc.classList.contains('rv-decision-confirmed') ? 'confirmed' : 'unconfirmed',
      aria: h.getAttribute('aria-label'), text: h.textContent,
      glyph: getComputedStyle(m, '::before').content, headGlyph: getComputedStyle(h, '::before').content,
      act: m.disabled ? '' : m.title,
      card: card ? [...card.querySelectorAll('.rv-msg')].map(e => e.textContent).join(' | ') : '',
      actions: card ? [...card.querySelectorAll('.rv-thread-actions button')].map(b => b.dataset.act).join() : '',
      folded: !!(card && card.classList.contains('rv-collapsed')),
      quoteBtn: getComputedStyle(document.getElementById('rv-quote-btn')).display,
    };
  })()`);

  await waitFor(() => inReview('!!document.querySelector("h2.rv-decision > .rv-decision-mark")'), 'decision mark missing');
  const fresh = await decision(0);
  assert.deepEqual([fresh.state, fresh.toc, fresh.glyph, fresh.headGlyph, fresh.act, fresh.text],
    ['unconfirmed', 'unconfirmed', '"○"', 'none', 'Confirm', 'Decision: refill rate']);
  // The button sits in the glyph's old box: the heading's words start where review.py put them.
  const shift = await inReview(`(() => {
    const h = document.querySelector('h2.rv-decision');
    const textX = () => { const r = document.createRange(); r.selectNodeContents(h.lastChild); return r.getBoundingClientRect().left; };
    const live = textX();
    const m = h.querySelector('.rv-decision-mark');
    m.remove(); h.classList.remove('rv-decision-live');
    const authored = textX();
    h.insertBefore(m, h.firstChild); h.classList.add('rv-decision-live');
    return Math.abs(live - authored);
  })()`);
  assert.ok(shift < 0.5, `heading words moved ${shift}px`);
  console.log('PASS an unconfirmed heading offers its circle in the glyph\'s own place');

  await clickMark(0);
  const ticked = await waitFor(async () => { const d = await decision(0); return d.state === 'confirmed' && d.card ? d : false; }, 'click did not confirm');
  const [thread] = confirmThreads();
  assert.ok(thread, 'no confirm thread in the store');
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.anchor.snippet, 'Decision: refill rate');
  assert.equal(thread.anchor.wholeBlock, true);
  assert.equal(thread.messages[0].turn, undefined, 'a confirm must not send');
  assert.deepEqual([ticked.toc, ticked.glyph, ticked.act, ticked.card], ['confirmed', '"✓"', 'Take back', 'You✓ confirmed']);
  assert.ok(ticked.aria.endsWith('— confirmed'));
  assert.deepEqual(ticked.actions.split(','), ['comment', 'send', 'toprompt', 'discard']);
  assert.equal(await inReview(`CSS.highlights.get('cu-anchor')?.size ?? 0`), 1, 'only the asked thread\'s quote is highlighted');
  console.log('PASS a click confirms in place and parks a [Confirm] thread for the next send');

  await clickMark(0);
  await waitFor(async () => (await decision(0)).state === 'unconfirmed', 'second click did not take it back');
  assert.equal(confirmThreads().length, 0);
  assert.equal((await decision(0)).card, '');
  console.log('PASS clicking your own unsent tick takes it back');

  await clickMark(0, 2);
  await waitFor(async () => (await decision(0)).state === 'confirmed', 'double-click did not confirm');
  await sleep(600);
  const afterDouble = await decision(0);
  assert.equal(afterDouble.state, 'confirmed', 'the second click of a double-click took the tick back');
  assert.equal(afterDouble.quoteBtn, 'none', 'double-clicking the mark selected the heading for a comment');
  assert.equal(confirmThreads().length, 1);
  console.log('PASS a double-click on the circle confirms once and starts no comment');

  const asked = await decision(1);
  assert.equal(asked.state, 'unconfirmed');
  await clickMark(1);
  const joined = await waitFor(async () => { const d = await decision(1); return d.state === 'confirmed' ? d : false; }, 'joined confirm missing');
  const threads = readStore().threads;
  assert.equal(threads.length, 2, 'the confirm should join the open thread on the heading');
  assert.deepEqual(threads.find(t => t.id === 'asked').messages.map(m => m.body), ['Why three?', '[Confirm] Decision: retry budget']);
  assert.equal(joined.card, 'YouWhy three? | AgentIt covers one failover. Keep it? | You✓ confirmed');
  console.log('PASS a confirm joins the conversation already open on its heading');

  await inReview(`document.querySelectorAll('h2.rv-decision')[0].parentElement.querySelector('.rv-thread [data-act=send]').click()`);
  const sent = await waitFor(async () => { const d = await decision(0); return d.act === '' ? d : false; }, 'send did not seal the tick');
  assert.equal(sent.state, 'confirmed');
  assert.ok(Number.isFinite(confirmThreads()[0].messages[0].turn), 'send did not stamp the confirm');
  assert.equal((await decision(1)).act, '', 'one send covers every pending confirm');
  console.log('PASS a sent tick stays confirmed and can no longer be taken back');

  // The agent records the first decision: package marker, then the resolved status.
  const id = confirmThreads()[0].id;
  fs.appendFileSync(journalPath, JSON.stringify({ thread: id, status: 'resolved', ts: Date.now(), turn: readStore().turn }) + '\n');
  fs.writeFileSync(pkg, packageText('confirmed', 'unconfirmed'));
  const recorded = await waitFor(async () => { const d = await decision(0); return d.folded ? d : false; }, 'recorded decision did not fold its thread');
  assert.deepEqual([recorded.state, recorded.act], ['confirmed', '']);
  assert.match(await inReview(`document.querySelector('.rv-thread.rv-collapsed').textContent`), /Resolved\s*Confirmed/);
  console.log('PASS the agent\'s [confirmed] takes over and the thread folds');

  fs.writeFileSync(pkg, packageText('unconfirmed', 'unconfirmed'));
  await waitFor(async () => (await decision(0)).state === 'unconfirmed', 'reopened decision stayed green');
  assert.equal((await decision(0)).act, 'Confirm');
  console.log('PASS an agent reopening the decision brings the circle back');
} finally {
  await app.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
