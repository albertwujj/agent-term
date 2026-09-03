// End-to-end regression: where a clicked link ends up.
//
// A link that asks for a new window (target=_blank, window.open) used to get a
// bare BrowserWindow — the app's icon, no address bar, no back button. Every such
// link now goes to the system browser, as does an http link inside a rendered
// review or an md doc, while a plain link on a browsed page keeps navigating in
// place. shell.openExternal is stubbed in-process, so a run opens no browser.

import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(APP_DIR, 'test', 'fixtures');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

function makeReviewRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'at-link-routing-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(repo, 'f.py'), 'a = 1\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  fs.appendFileSync(path.join(repo, 'f.py'), 'a = 2\n');
  git('commit', '-qam', 'two');
  const range = `${git('rev-parse', 'HEAD~1')}..${git('rev-parse', 'HEAD')}`;
  const dir = path.join(repo, '.git', 'review', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, 'main.md');
  fs.writeFileSync(pkg, `---\nrange: ${range}\n---\n\n# Review\n\nA change to f.py.\n\n:::diff f.py\n`);
  return { repo, pkg };
}

async function run() {
  let reviewRepo = null;
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', APP_DIR],
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  try {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
    await sleep(1200);
    await page.keyboard.press('Escape'); // the startup session picker
    await sleep(300);

    // Record what would have been handed to the browser instead of opening one.
    await app.evaluate(({ shell }) => {
      globalThis.__ext = [];
      shell.openExternal = (u) => { globalThis.__ext.push(u); return Promise.resolve(); };
    });
    const drainExternal = () => app.evaluate(() => {
      const seen = globalThis.__ext;
      globalThis.__ext = [];
      return seen;
    });
    const state = () => app.evaluate(({ BrowserWindow, webContents }) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview');
      return {
        windows: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
        guest: guest ? guest.getURL() : null,
      };
    });
    // A review page follows a link only on a modified click — the plain one belongs
    // to its commenting gestures — so the guest click carries metaKey when asked.
    const clickInGuest = (id, { follow = false } = {}) => app.evaluate(({ webContents }, [elId, withModifier]) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview');
      return guest.executeJavaScript(
        `document.getElementById(${JSON.stringify(elId)}).dispatchEvent(`
        + `new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: ${!!withModifier} }))`,
      );
    }, [id, follow]);
    const runCommand = async (command) => {
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
      await sleep(400);
    };
    const openViewer = async (target, selector) => {
      await runCommand(`echo ${target}`);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url');
      });
      await page.waitForSelector(selector, { timeout: 10_000 });
      await sleep(1200);
    };
    const isShell = (u) => /src[/\\]index\.html$/.test(u || '');

    // --- web viewer: popups leave, plain links keep browsing in place ---
    await openViewer(url.pathToFileURL(path.join(FIXTURES, 'e2e-link-popup.html')).href, '.vb-shell.vb-web.open');

    await clickInGuest('blank');
    await sleep(900);
    let s = await state();
    check('target=_blank spawns no app window', s.windows.length === 1 && isShell(s.windows[0]), s.windows);
    check('target=_blank goes to the system browser',
      (await drainExternal()).includes('https://example.com/blank-target'));

    await clickInGuest('popup');
    await sleep(900);
    s = await state();
    check('window.open spawns no app window', s.windows.length === 1 && isShell(s.windows[0]), s.windows);
    check('window.open goes to the system browser',
      (await drainExternal()).includes('https://example.com/js-popup'));

    await clickInGuest('inline');
    await sleep(1200);
    s = await state();
    check('plain link still browses in place', /e2e-link-popup\.html\?browsed=1/.test(s.guest || ''), s.guest);
    check('plain link stayed in the viewer', (await drainExternal()).length === 0);

    // --- review page: switching from an existing generic guest recreates it
    // with the review preload; http links leave and the review stays put. ---
    reviewRepo = makeReviewRepo();
    await runCommand(`echo review://${reviewRepo.pkg}`);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url');
    });
    await page.waitForSelector('.vb-shell.vb-web.open', { timeout: 10_000 });
    await sleep(1200);
    // Add deterministic links to a genuine generated review. The review
    // preload's handlers are delegated, so these exercise the real routing
    // without coupling this test to the renderer's document prose.
    await app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview');
      return guest.executeJavaScript(`(() => {
        const fixture = document.createElement('div');
        fixture.innerHTML = '<h2 id="top">review link fixture</h2>'
          + '<p><a id="ext" href="https://example.com/review-ext">external</a></p>'
          + '<p><a id="frag" href="#top">fragment</a></p>';
        document.body.prepend(fixture);
      })()`);
    });

    await clickInGuest('ext');
    await sleep(900);
    s = await state();
    check('a plain click on a review link follows nothing', (await drainExternal()).length === 0);
    check('and the review page stays put', /\/\.git\/review\/main\/main\.html$/.test(s.guest || ''), s.guest);

    await clickInGuest('ext', { follow: true });
    await sleep(900);
    s = await state();
    check('a modified click on a review link goes to the system browser',
      (await drainExternal()).includes('https://example.com/review-ext'));
    check('review page was not navigated away', /\/\.git\/review\/main\/main\.html$/.test(s.guest || ''), s.guest);

    await clickInGuest('frag');
    await sleep(600);
    s = await state();
    check('review in-page fragment nav still works', /\/\.git\/review\/main\/main\.html#top$/.test(s.guest || ''), s.guest);
    check('fragment nav stayed in the viewer', (await drainExternal()).length === 0);

    // --- md viewer: http leaves, a relative link never eats the app shell ---
    await page.locator('.vb-shell.vb-web .vb-close').click();
    await sleep(600);
    await openViewer(path.join(FIXTURES, 'e2e-md-links.md'), '.vb-shell.vb-md.open');
    await page.waitForSelector('.md-viewer-body a', { timeout: 10_000 });

    const clickDocLink = (selector, follow) => page.evaluate(([sel, withModifier]) => {
      document.querySelector(sel).dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: withModifier }),
      );
    }, [selector, follow]);

    await clickDocLink('a[href^="https://example.com/md-ext"]', false);
    await sleep(700);
    check('a plain click on an md link follows nothing', (await drainExternal()).length === 0);
    check('it arms the block for a comment instead',
      await page.evaluate(() => !!document.querySelector('.md-comment-target-active')));
    check('and the hint names the modifier',
      await page.evaluate(() => /click follows/.test(document.querySelector('.md-bar-hint.on')?.textContent || '')));
    await page.keyboard.press('Escape');
    await sleep(300);

    await clickDocLink('a[href^="https://example.com/md-ext"]', true);
    await sleep(700);
    check('md viewer http link goes to the system browser on a modified click',
      (await drainExternal()).includes('https://example.com/md-ext'));

    await clickDocLink('a[href="./e2e-md-link-target.md"]', true);
    await page.waitForFunction(
      () => /md link target/i.test(document.querySelector('.md-viewer-body h1')?.textContent || ''),
      { timeout: 10_000 },
    ).catch(() => {});
    s = await state();
    const shown = await page.evaluate(() => ({
      heading: document.querySelector('.md-viewer-body h1')?.textContent || '',
      title: document.querySelector('.vb-shell.vb-md .vb-title')?.textContent || '',
    }));
    check('md viewer relative link opens that doc in the viewer',
      /md link target/i.test(shown.heading) && /e2e-md-link-target\.md/.test(shown.title), shown);
    check('following a doc link never navigates the app shell',
      s.windows.length === 1 && isShell(s.windows[0]), s.windows);
    check('following a doc link stays out of the browser', (await drainExternal()).length === 0);

    // --- the app shell itself never navigates ---
    await page.evaluate(() => { window.location.href = 'https://example.com/host-nav'; });
    await sleep(1200);
    s = await state();
    check('app shell navigation blocked', isShell(s.windows[0]), s.windows);
    check('app shell navigation goes to the system browser',
      (await drainExternal()).includes('https://example.com/host-nav'));
  } finally {
    await app.close();
    if (reviewRepo) fs.rmSync(reviewRepo.repo, { recursive: true, force: true });
  }
  if (failures) throw new Error(`${failures} link-routing check(s) failed`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
