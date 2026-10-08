// A decision's wording, outline links and geometry survive settlement/reopening.
// Exercise actual package refresh in the review guest at two window widths.
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
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'at-review-decision-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'e2e');
git('config', 'user.email', 'e2e@example.invalid');
fs.writeFileSync(path.join(repo, 'config.js'), 'export const days = null;\n');
git('add', '.');
git('commit', '-qm', 'Base');
const base = git('rev-parse', 'HEAD');
fs.writeFileSync(path.join(repo, 'config.js'), 'export const days = 30;\n');
git('commit', '-qam', 'Expire new links');
const dir = path.join(repo, '.git', 'review', 'main');
fs.mkdirSync(dir, { recursive: true });
const pkg = path.join(dir, 'main.md');
const pending = `---\nrange: ${base}..${git('rev-parse', 'HEAD')}\n---\n
## [unconfirmed] Decision: **link lifetime**

New links get a configured lifetime.

:::diff config.js

### [unconfirmed] Decision: a longer nested decision that wraps in the outline

Consider the effect on existing shared URLs.

## Ordinary section

${Array.from({ length: 20 }, (_, i) => `Additional context ${i + 1}.`).join('\n\n')}
`;
fs.writeFileSync(pkg, pending);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, message) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    try { if (await fn()) return; } catch {}
    await sleep(100);
  }
  throw new Error(message);
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
  await waitFor(() => inReview('document.querySelector("h2.rv-decision-unconfirmed")'), 'pending heading missing');
  const align = () => inReview('document.querySelector("h2.rv-decision").scrollIntoView(); window.scrollBy(0, -20)');
  const snapshot = () => inReview(`(() => {
    const headings = [...document.querySelectorAll('.sec-head .rv-decision')];
    const nav = [...document.querySelectorAll('#toc .rv-decision')];
    const rect = el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    return {
      text: [...headings, ...nav].map(e => e.textContent),
      rects: [...headings, ...nav, document.querySelector('section.file')].map(rect),
      ids: headings.map(e => e.id), links: nav.map(e => e.getAttribute('href')),
      color: getComputedStyle(headings[0]).backgroundColor,
      mark: getComputedStyle(headings[0], '::before').content,
      aria: headings[0].getAttribute('aria-label'),
      inlineFormat: headings[0].querySelector('strong')?.textContent,
      nestedIndent: getComputedStyle(nav[1]).paddingLeft,
      scroll: scrollY,
    };
  })()`);
  const stable = (before, after) => {
    assert.deepEqual(after.text, before.text);
    assert.deepEqual(after.ids, before.ids);
    assert.deepEqual(after.links, before.links);
    assert.ok(Math.abs(after.scroll - before.scroll) < 1, 'scroll moved');
    for (let i = 0; i < before.rects.length; i++) for (let j = 0; j < 4; j++) {
      assert.ok(Math.abs(after.rects[i][j] - before.rects[i][j]) < 1,
        `geometry moved: ${JSON.stringify({ before: before.rects, after: after.rects })}`);
    }
  };
  await align();
  const initial = await snapshot();
  assert.equal(initial.inlineFormat, 'link lifetime');
  assert.equal(initial.mark, '"○"');
  assert.ok(initial.aria.endsWith('unconfirmed'));
  assert.equal(initial.nestedIndent, '17px');
  fs.writeFileSync(pkg, pending.replaceAll('[unconfirmed]', '[confirmed]'));
  await waitFor(() => inReview('!!document.querySelector("h2.rv-decision-confirmed")'), 'settled heading missing');
  await sleep(500);
  const settled = await snapshot();
  stable(initial, settled);
  assert.equal(settled.mark, '"✓"');
  assert.ok(settled.aria.endsWith('confirmed'));
  assert.notEqual(settled.color, initial.color);
  console.log('PASS settlement updates status while preserving heading text, formatting, anchors and layout');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 900));
  await sleep(500);
  await align();
  const narrow = await snapshot();
  fs.writeFileSync(pkg, pending);
  await waitFor(() => inReview('!!document.querySelector("h2.rv-decision-unconfirmed")'), 'reopened heading missing');
  await sleep(500);
  const reopened = await snapshot();
  stable(narrow, reopened);
  assert.equal(reopened.mark, initial.mark);
  assert.equal(reopened.color, initial.color);
  console.log('PASS reopening stays stable at a narrow width, including a wrapped nested outline entry');
} finally {
  await app.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
