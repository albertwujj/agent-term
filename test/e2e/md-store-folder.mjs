// End-to-end: a markdown document's thread store lands in a .agent-threads
// folder beside it, created on first comment.
//
// The store used to be the document's hidden sibling, which put an untracked
// dotfile next to every commented document. The folder is the .DS_Store shape:
// one name, ignored once in a global gitignore. This drives the real IPC path
// (renderer -> main -> fs), so it covers the directory creation that the first
// comment on a document now depends on, and completion history surviving a
// follow-up through those same files and IPC paths.

import { launchElectron } from './electron.mjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`); }
}

async function main() {
  // A document in a scratch directory: the folder must be created from nothing,
  // which is the case that used to work by accident when the store was a sibling.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'md-store-'));
  const doc = path.join(scratch, 'launch plan.md');
  fs.writeFileSync(doc, '# Launch plan\n\nThe opening paragraph.\n', 'utf8');
  const expected = path.join(scratch, '.agent-threads', 'launch plan-comments.json');
  const oldSibling = path.join(scratch, '.launch plan-comments.json');

  const app = await launchElectron({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', `--user-data-dir=${path.join(scratch, 'userdata')}`, APP_DIR],
    env: { ...process.env, AGENT_TERM_START_CWD: scratch, TMUX: '', STY: '', ZELLIJ: '' },
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await sleep(1200);
  if (await page.evaluate(() => !!document.querySelector('.at-picker-overlay'))) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }

  try {
    console.log('the first comment creates the store folder');
    check('no store folder before the first comment', !fs.existsSync(path.dirname(expected)));

    const added = await page.evaluate(async (docPath) => window.pty.mdAddThreads({
      docPath,
      threads: [{ body: 'Tighten this opening.', anchor: { snippet: 'The opening paragraph.' } }],
      allowMissingRunbook: true,
    }), doc);
    // pasteMdPointer needs a live shell and may report otherwise; the store write
    // happens before it either way, and the store is what this test is about.
    check('the store file exists at the folder path', fs.existsSync(expected), added && added.error);
    check('and nothing was written to the old sibling path', !fs.existsSync(oldSibling));

    const store = JSON.parse(fs.readFileSync(expected, 'utf8'));
    check('the thread survived the round trip', store.threads.length === 1, store.threads.length);
    check('with the body the viewer sent', store.threads[0].messages[0].body === 'Tighten this opening.');
    check('and the turn clock ticked', store.turn === 1, store.turn);

    console.log('the store reads back through the same derivation');
    const read = await page.evaluate(async (docPath) => window.pty.mdReadThreads({ docPath }), doc);
    check('mdReadThreads finds it', !!(read && read.success), read);
    check('and returns the same thread', !!(read && read.data && read.data.threads.length === 1));

    console.log('a second comment reuses the folder');
    await page.evaluate(async (docPath) => window.pty.mdAddThreads({
      docPath,
      threads: [{ body: 'And the close.', anchor: { snippet: 'The opening paragraph.' } }],
      allowMissingRunbook: true,
    }), doc);
    const after = JSON.parse(fs.readFileSync(expected, 'utf8'));
    check('both threads are in the one store', after.threads.length === 2, after.threads.length);
    check('no stray store beside the document', fs.readdirSync(scratch).filter((f) => f.endsWith('-comments.json')).length === 0);

    console.log('a refinement preserves an already completed edit');
    const refineDoc = path.join(scratch, 'refine.md');
    const applied = 'The document now uses clear wording.';
    const appliedSource = '# Refine\n\n' + applied + '\n';
    fs.writeFileSync(refineDoc, appliedSource);
    const refineStore = path.join(scratch, '.agent-threads', 'refine-comments.json');
    const openedAt = Date.now() - 10000;
    fs.writeFileSync(refineStore, JSON.stringify({ version: 1, turn: 1, threads: [{
      id: 'edit-refine', anchor: { snippet: 'The document utilizes clear wording.' },
      messages: [{ author: 'user', body: '[Edit] The document <del>utilizes</del><ins>uses</ins> clear wording. [/Edit]', ts: openedAt, turn: 1 }],
    }] }));
    fs.writeFileSync(refineStore.replace('-comments.json', '-agent.jsonl'), JSON.stringify({
      thread: 'edit-refine', body: 'Changed it to uses.', status: 'resolved',
      anchor: { snippet: applied }, ts: openedAt + 1000, turn: 1,
    }) + '\n');
    const terminal = page.locator('.xterm-helper-textarea');
    const openRefinement = async () => {
      await terminal.focus();
      await page.keyboard.press('Control+C');
      await page.keyboard.type(`echo ${refineDoc}`);
      await page.keyboard.press('Enter');
      await sleep(700);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
      await page.waitForSelector('.vb-md.open .primary [data-md-keep-key="thread:edit-refine"]');
    };
    await openRefinement();
    await page.locator('.primary .md-thread-resolved-line[data-md-keep-key="thread:edit-refine"]').click();
    await page.locator('.primary .md-thread-card button').filter({ hasText: /^Reply$/ }).click();
    await page.locator('.primary .md-thread-reply textarea').fill('Refine that wording further.');
    await page.locator('.primary .md-thread-reply textarea').press('Enter');
    await page.waitForSelector('.vb-md .primary .md-thread-waiting-line');
    const readRefinement = await page.evaluate(async (docPath) => window.pty.mdReadThreads({ docPath }), refineDoc);
    check('the follow-up reopens the conversation through real IPC', readRefinement.success
      && !readRefinement.data.threads[0].status
      && readRefinement.data.threads[0].messages.at(-1).body === 'Refine that wording further.');
    check('the document keeps the applied text in both viewer pages', await page.locator('.vb-md .md-viewer-body').evaluateAll((articles, applied) =>
      articles.every((a) => a.querySelector('p')?.textContent === applied && !a.querySelector('.md-sealed, .md-pending-diff.sent')), applied));
    check('the source file is unchanged by the reply', fs.readFileSync(refineDoc, 'utf8') === appliedSource);
    await page.locator('.vb-md .vb-close').click();
    await openRefinement();
    check('reopening preserves the applied text', await page.locator('.primary .md-viewer-body p').textContent() === applied);
    const refined = 'The document uses concise wording.';
    fs.writeFileSync(refineDoc, '# Refine\n\n' + refined + '\n');
    await page.waitForFunction((text) => document.querySelector('.vb-md .primary .md-viewer-body p')?.textContent === text,
      refined, { timeout: 8000 });
    check('the next agent edit appears while the refinement awaits its reply',
      await page.locator('.primary .md-viewer-body p').textContent() === refined);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
