// A re-render of the open review that fails says so. The renderer exiting with
// an error writes no page, so the band keeps the last one that rendered, which
// would pass for current; the failure surfaces as an error toast instead,
// once per failure rather than on every poll, and the next good change
// renders as usual and takes the toast down. Drives the real app and the real
// review render.
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
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'at-review-failed-')));
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
const pkgText = (prose) => `---\nrange: ${base}..${git('rev-parse', 'HEAD')}\n---\n\n# Review\n\n${prose}\n\n:::diff f.js\n`;
fs.writeFileSync(pkg, pkgText('The first version.'));

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
  await sleep(1000);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  await page.locator('.xterm-helper-textarea').focus();
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
  const failToasts = () => page.evaluate(() => [...document.body.children]
    .filter((el) => el.textContent.includes("Review didn't refresh")).map((el) => el.textContent));
  check('the review opens', await waitFor(() => inReview('/The first version/.test(document.body.textContent)'), 15_000));

  // Bytes that are not UTF-8: the renderer cannot read the package and exits
  // with a traceback before it writes a page.
  fs.writeFileSync(pkg, Buffer.concat([Buffer.from(pkgText('The broken version.')), Buffer.from([0xff, 0xfe])]));
  check('the failed re-render shows an error toast',
    await waitFor(async () => (await failToasts()).length > 0, 15_000), await failToasts());
  const [toast] = await failToasts();
  check('the toast carries the renderer\'s error', /UnicodeDecodeError/.test(toast || ''), toast);
  check('the band keeps the last page that rendered',
    await inReview('/The first version/.test(document.body.textContent)') === true);
  await sleep(6000); // three polls
  check('one toast per failure, not one per poll', (await failToasts()).length === 1, (await failToasts()).length);

  fs.writeFileSync(pkg, pkgText('The fixed version.'));
  check('the next good change renders', await waitFor(() => inReview('/The fixed version/.test(document.body.textContent)'), 15_000));
  check('and takes the toast down', (await failToasts()).length === 0, await failToasts());

  // A failure then a fix that renders the page it already showed: no reload,
  // but the toast still comes down.
  const broken = Buffer.concat([Buffer.from(pkgText('The fixed version.')), Buffer.from([0xff, 0xfe])]);
  fs.writeFileSync(pkg, broken);
  check('a second failure shows one toast', await waitFor(async () => (await failToasts()).length === 1, 15_000), await failToasts());
  fs.writeFileSync(pkg, pkgText('The fixed version.'));
  check('a fix back to the shown page takes it down', await waitFor(async () => (await failToasts()).length === 0, 15_000), await failToasts());
} finally {
  await app.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('review-render-failed passed');
