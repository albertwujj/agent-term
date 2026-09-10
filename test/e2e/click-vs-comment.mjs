// End-to-end: in the terminal, a click navigates and a selection comments —
// the two never ride on the same gesture.
//
// A double click used to open a line comment, so on navigable output (a path, a
// URL, a diff line — most of what an agent prints) the first click navigated and
// the second opened a composer: one gesture, two unrelated actions. Double and
// triple click now belong to xterm's word and line select, which arm the
// type-to-comment pill; commenting always goes through a selection.
//
// IDE/OS targets now accept a delayed plain click. Selection cancels that action
// before it leaves the app; existing viewer clicks and Ctrl/Cmd stay immediate.

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(APP_DIR, 'test', 'fixtures');
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
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    // wordTarget below finds its click point by walking text nodes under
    // `.xterm-rows`, and only the DOM renderer puts text there. With WebGL up
    // those rows are empty and every target comes back null. Denying the GPU
    // makes WebglAddon fail to load and the renderer falls back to the DOM on
    // its own — the documented path it already takes on context loss. Nothing
    // here asserts how a cell is painted, only where a click lands and what
    // the app does with it, so the substrate is free to be either one.
    args: ['--no-sandbox', '--disable-gpu', APP_DIR],
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

  const nativeInterval = await page.evaluate(() => window.pty.getDoubleClickInterval());
  if (process.platform === 'darwin' || process.platform === 'win32') {
    check('native double-click timing is available', Number.isFinite(nativeInterval) && nativeInterval > 0, nativeInterval);
  }
  // Observe actual requests without opening another app or depending on an IDE
  // being installed. Use a slow interval to exercise late second presses.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__clickActions = [];
    globalThis.__clickComments = [];
    globalThis.__clickTimingReads = 0;
    ipcMain.removeHandler('get-double-click-interval');
    ipcMain.handle('get-double-click-interval', () => { globalThis.__clickTimingReads++; return 700; });
    for (const channel of ['navigate-to-file', 'navigate-to-symbol', 'open-resource', 'open-url']) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, target) => {
        globalThis.__clickActions.push({ channel, target });
        return { success: true, status: 'ok' };
      });
    }
    // Observe the selected-text payload at the renderer/main boundary. Sending
    // this prose to a real shell executes it as commands; command-not-found
    // hooks can still be running when the next fixture command is typed.
    ipcMain.removeHandler('submit-inline-comment');
    ipcMain.handle('submit-inline-comment', (_event, body) => {
      globalThis.__clickComments.push(body);
      return { success: true };
    });
  });
  const actions = () => app.evaluate(() => globalThis.__clickActions);
  const timingReads = () => app.evaluate(() => globalThis.__clickTimingReads);

  const focusTerm = () => page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    if (ta) ta.focus();
  });
  const runCmd = async (cmd) => {
    await focusTerm();
    await page.keyboard.type(cmd);
    await page.keyboard.press('Enter');
    await sleep(700);
  };
  const state = () => page.evaluate(() => ({
    band: !!document.querySelector('.vb-shell.vb-web.open'),
    bubble: !!document.querySelector('.terminal-comment-bubble'),
    pill: !!document.querySelector('.terminal-comment-selection-hint'),
  }));
  // Drive the real composer and read the submitted message, whose selection
  // markers identify the exact span picked by the gesture.
  const commentAndSend = async (text) => {
    const before = await app.evaluate(() => globalThis.__clickComments.length);
    await focusTerm();
    await page.keyboard.type(text);
    await page.waitForSelector('.terminal-comment-bubble', { timeout: 3_000 });
    await page.keyboard.press('Enter');
    await page.waitForSelector('.terminal-comment-bubble', { state: 'detached', timeout: 3_000 });
    const comments = await app.evaluate(() => globalThis.__clickComments);
    if (comments.length !== before + 1) throw new Error('Expected one submitted selection comment');
    return comments[before];
  };
  const selectedIn = (message) => {
    const all = [...message.matchAll(/\[selected](.*?)\[\/selected]/gs)];
    return all.length ? all[all.length - 1][1] : null;
  };
  const navFired = async () => {
    for (let i = 0; i < 20; i++) {
      if ((await actions()).length) return true;
      await sleep(50);
    }
    return (await actions()).length > 0;
  };
  const clearNavFeedback = async () => {
    await app.evaluate(() => { globalThis.__clickActions = []; });
    await page.evaluate(() => document.querySelectorAll('.nav-feedback').forEach((n) => n.remove()));
  };
  const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';
  const modifiedClick = async (x, y) => {
    await page.keyboard.down(MOD_KEY);
    await page.mouse.click(x, y);
    await page.keyboard.up(MOD_KEY);
  };
  const bubbleShown = () => page.evaluate(() => !!document.querySelector('.terminal-comment-bubble'));
  const pillShown = () => page.evaluate(() => !!document.querySelector('.terminal-comment-selection-hint'));
  // The pill appears on a 120ms debounce after the selection settles.
  const awaitPill = async () => {
    await page.waitForSelector('.terminal-comment-selection-hint', { timeout: 3_000 }).catch(() => {});
    return pillShown();
  };
  const closeBand = async () => {
    const close = page.locator('.vb-shell.vb-web .vb-close');
    if (await close.count()) { await close.click(); await sleep(500); }
  };
  const escape = async () => {
    await page.evaluate(() => {
      const el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await sleep(300);
  };
  // Bottom-most decoration box: the match on the freshly echoed line.
  const lastDecoration = () => page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.xterm-decoration')]
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
      .filter((r) => r.w > 4 && r.h > 2);
    boxes.sort((a, b) => a.y - b.y);
    return boxes[boxes.length - 1] || null;
  });
  // Aim at a word on the echoed OUTPUT row — searched from the bottom so neither
  // the command line that printed it nor a sent comment echoing it is the hit. A
  // DOM Range over the word's own characters gives exact geometry, so this does
  // not depend on knowing the cell width.
  const wordTarget = (needle, word) => page.evaluate(([text, target]) => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')];
    for (let i = rows.length - 1; i >= 0; i--) {
      const rowText = rows[i].textContent || '';
      if (!rowText.includes(text) || rowText.includes('printf') || rowText.includes('[selected]')) continue;
      const col = rowText.indexOf(target);
      if (col < 0) continue;
      // Walk the row's text nodes to the character offset, then measure the word.
      let seen = 0;
      const walker = document.createTreeWalker(rows[i], NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const len = node.textContent.length;
        if (seen + len > col) {
          const start = col - seen;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, Math.min(len, start + target.length));
          const r = range.getBoundingClientRect();
          if (!r.width) return null;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), rowText: rowText.trim() };
        }
        seen += len;
      }
      return null;
    }
    return null;
  }, [needle, word]);

  try {
    const fileUrl = url.pathToFileURL(path.join(FIXTURES, 'e2e-link-popup.html')).href;

    console.log('a click navigates');
    await runCmd(`echo ${fileUrl}`);
    await sleep(1500);
    const link = await lastDecoration();
    check('the URL is decorated as navigable', !!link, link);
    const lx = Math.round(link.x + link.w / 2);
    const ly = Math.round(link.y + link.h / 2);
    await page.mouse.click(lx, ly);
    await page.waitForSelector('.vb-shell.vb-web.open', { timeout: 10_000 }).catch(() => {});
    let s = await state();
    check('a single click opens the viewer band', s.band, s);
    check('existing viewer links do not request a click delay', await timingReads() === 0);
    check('and opens no composer', !s.bubble, s);
    await closeBand();

    console.log('an IDE-bound match takes a delayed plain click or immediate ctrl/cmd');
    await runCmd("printf '%s\\n' 'see src/sessions-log.js:213 and isSessionActive for it'");
    await sleep(1200);
    const ideLine = await wordTarget('and isSessionActive for it', 'src/sessions-log.js:213');
    check('the file:line is on screen', !!ideLine, ideLine);
    await clearNavFeedback();
    await page.mouse.click(ideLine.x, ideLine.y);
    check('a plain click does not navigate immediately', (await actions()).length === 0);
    check('a plain click on file:line navigates after the delay', await navFired());
    check('it navigates once to the clicked file and line', (await actions()).length === 1
      && (await actions())[0].target.filePath === 'src/sessions-log.js'
      && (await actions())[0].target.line === 213);
    check('and opens no viewer band', !(await state()).band);
    await clearNavFeedback();
    const beforeModified = await timingReads();
    await modifiedClick(ideLine.x, ideLine.y);
    check('ctrl/cmd click on file:line navigates', await navFired());
    check('ctrl/cmd bypasses the timing lookup', await timingReads() === beforeModified);

    const symbol = await wordTarget('and isSessionActive for it', 'isSessionActive');
    check('the symbol is on screen', !!symbol, symbol);
    await clearNavFeedback();
    await page.mouse.click(symbol.x, symbol.y);
    check('a plain click on a symbol navigates after the delay', await navFired());
    await clearNavFeedback();
    await modifiedClick(symbol.x, symbol.y);
    check('ctrl/cmd click on a symbol navigates', await navFired());
    await clearNavFeedback();

    console.log('the mark and the hit region are the same span');
    // Where the reference lands decides whether its line belongs to it. The
    // cursor is the readout: it turns to a pointer over a match the current
    // modifier state can act on.
    const cursorOver = async (needle, word, held) => {
      const t = await wordTarget(needle, word);
      if (!t) throw new Error(`no row carrying "${word}"`);
      if (held) await page.keyboard.down(MOD_KEY);
      await page.mouse.move(t.x, t.y);
      await sleep(200);
      const cursor = await page.evaluate(() => document.querySelector('.xterm-screen')?.style.cursor || '');
      if (held) await page.keyboard.up(MOD_KEY);
      return cursor;
    };
    // An IDE jump lands on the line, so file:line is one reference end to end.
    const ide = 'and isSessionActive for it';
    check('an IDE path is a target under the modifier', await cursorOver(ide, 'src/sessions-log.js', true) === 'pointer');
    check('and so is its line, the same one reference', await cursorOver(ide, '213', true) === 'pointer');
    check('the IDE path is also a target without the modifier', await cursorOver(ide, 'src/sessions-log.js', false) === 'pointer');

    // The md viewer opens the document, so the line is not part of what is named.
    const doc = `open ${path.join(FIXTURES, 'e2e-md-links.md')}:42 now`;
    await runCmd(`printf '%s\\n' '${doc}'`);
    await sleep(1200);
    check('a doc is a target on a plain click', await cursorOver(doc, 'e2e-md-links.md', false) === 'pointer');
    check('and its line is ordinary text', await cursorOver(doc, '42', false) === '');

    const mdTarget = await wordTarget(doc, 'e2e-md-links.md');
    const mdDragEnd = await wordTarget(doc, 'open');
    await page.mouse.move(mdTarget.x, mdTarget.y);
    await page.mouse.down();
    await page.mouse.move(mdDragEnd.x, mdDragEnd.y, { steps: 5 });
    await page.mouse.up();
    check('dragging across an immediate markdown link arms commenting', await awaitPill());
    check('that drag does not open the markdown viewer', await page.locator('.vb-shell.vb-md.open').count() === 0);
    await escape();
    await sleep(700); // start a fresh click sequence after the drag
    const beforeMarkdown = await timingReads();
    await page.mouse.click(mdTarget.x, mdTarget.y);
    await page.waitForSelector('.vb-shell.vb-md.open', { timeout: 10_000 });
    check('markdown still opens without requesting a delay', await timingReads() === beforeMarkdown);
    await page.locator('.vb-shell.vb-md .vb-close').click();
    await sleep(500);

    console.log('a double click on an IDE-bound match navigates nowhere');
    // The first mouseup arms a timer; the second DOWN cancels it.
    await page.mouse.dblclick(symbol.x, symbol.y);
    check('the word select arms the pill', await awaitPill());
    check('and no navigation fired on the way', !(await navFired()));
    await escape();
    await sleep(200);

    console.log('a slow second press cancels before its release, and a third selects the line');
    const slowSymbol = await wordTarget('and isSessionActive for it', 'isSessionActive');
    await page.mouse.click(slowSymbol.x, slowSymbol.y);
    await sleep(600);
    await page.mouse.down({ clickCount: 2 });
    await sleep(300); // beyond the first click's deadline, still holding
    check('no navigation while the second press is held', (await actions()).length === 0);
    await page.mouse.up({ clickCount: 2 });
    check('slow double-click still arms commenting', await awaitPill());
    await page.mouse.down({ clickCount: 3 });
    await page.mouse.up({ clickCount: 3 });
    check('triple-click over a symbol offers the line comment', await awaitPill());
    check('and no delayed navigation survives', !(await navFired()));
    check('the comment receives the whole linked line', selectedIn(await commentAndSend('k'))
      === 'see src/sessions-log.js:213 and isSessionActive for it');

    console.log('selection and cancellation win over delayed navigation');
    await runCmd("printf '%s\\n' 'drag isSessionActive toward this word'");
    const dragSymbol = await wordTarget('drag isSessionActive toward', 'isSessionActive');
    const dragEnd = await wordTarget('drag isSessionActive toward', 'word');
    if (!dragSymbol || !dragEnd) {
      throw new Error('drag fixture output missing: ' + JSON.stringify(await page.evaluate(() => (
        [...document.querySelectorAll('.xterm-rows > div')].map(row => row.textContent || '').filter(Boolean)
      ))));
    }
    await clearNavFeedback();
    await page.mouse.move(dragSymbol.x, dragSymbol.y);
    await page.mouse.down();
    await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 6 });
    await page.mouse.up();
    check('dragging from a symbol arms commenting', await awaitPill());
    check('drag selection never navigates', !(await navFired()));
    await escape();
    await page.mouse.move(dragSymbol.x, dragSymbol.y);
    await page.mouse.down();
    await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 6 });
    await page.mouse.move(dragSymbol.x, dragSymbol.y, { steps: 6 });
    await page.mouse.up();
    check('dragging out and back never navigates', !(await navFired()));
    await escape();
    for (const cancel of [
      () => page.keyboard.press('Escape'),
      () => page.keyboard.type('x'),
      () => page.mouse.wheel(0, -40),
      () => page.evaluate(() => window.dispatchEvent(new Event('blur'))),
    ]) {
      const target = await wordTarget('drag isSessionActive toward', 'isSessionActive');
      await page.mouse.click(target.x, target.y);
      await cancel();
      check('a cancelled plain click never navigates', !(await navFired()));
    }
    await page.keyboard.press('Control+c');

    console.log('native hyperlinks keep their immediate URL even with a symbol caption');
    await runCmd('clear');
    await runCmd("printf '\\033]8;;https://example.invalid/osc8\\007%s\\033]8;;\\007 after\\n' 'isSessionActive'");
    const nativeLabel = await wordTarget('isSessionActive after', 'isSessionActive');
    await clearNavFeedback();
    const beforeNativeLink = await timingReads();
    await page.mouse.move(nativeLabel.x, nativeLabel.y);
    await sleep(200); // allow xterm's native link provider to resolve the hover
    await page.mouse.click(nativeLabel.x, nativeLabel.y);
    check('the native caption opens its URL', await navFired());
    check('the URL opens exactly once, without an IDE jump', (await actions()).length === 1
      && (await actions())[0].channel === 'open-url'
      && (await actions())[0].target === 'https://example.invalid/osc8');
    check('the native caption does not request a click delay', await timingReads() === beforeNativeLink);
    await clearNavFeedback();
    const nativeDragEnd = await wordTarget('isSessionActive after', 'after');
    await page.mouse.move(nativeLabel.x, nativeLabel.y);
    await page.mouse.down();
    await page.mouse.move(nativeDragEnd.x, nativeDragEnd.y, { steps: 6 });
    await page.mouse.up();
    check('a drag from the native symbol caption arms commenting', await awaitPill());
    check('a native caption drag opens neither URL nor IDE', !(await navFired()));
    await escape();

    console.log('a bare OS path also accepts a plain click');
    await runCmd('echo ./docs/assets');
    const folder = await wordTarget('./docs/assets', './docs/assets');
    await page.mouse.click(folder.x, folder.y);
    check('plain click opens the folder after the delay', await navFired());
    check('the OS handler receives the folder exactly once', (await actions()).length === 1
      && (await actions())[0].channel === 'open-resource'
      && (await actions())[0].target === './docs/assets');
    await clearNavFeedback();

    console.log('a double click on navigable output does not comment');
    // A path-shaped word retains xterm's selection and comment payload.
    await runCmd('echo src/nope-does-not-exist.txt');
    await sleep(1500);
    const deadPath = await lastDecoration();
    check('the path is decorated as navigable', !!deadPath, deadPath);
    await page.mouse.dblclick(Math.round(deadPath.x + deadPath.w / 2), Math.round(deadPath.y + deadPath.h / 2));
    check('the double click selected the word instead', await awaitPill());
    check('no composer on a double click over a link', !(await bubbleShown()));
    check('and the comment it feeds marks the path',
      selectedIn(await commentAndSend('k')) === 'src/nope-does-not-exist.txt');

    // One printed line, a fresh word per gesture: re-selecting a range that is
    // already selected fires no selection-change, so the pill would not re-arm.
    // The mark has to be there while the drag is still happening. xterm reports
    // a selection change on mouse UP, and its own selection colour is the one
    // thing that cannot paint a cell carrying its own background (a diff row),
    // so a mark that waited for the event looked like it arrived on release.
    console.log('the mark follows a drag over a row with a background of its own');
    await runCmd("printf '\\033[48;2;19;56;19m%s\\033[0m\\n' '+ added telemetry to the resume path'");
    await sleep(1200);
    const markCount = () => page.evaluate(() => document.querySelectorAll('.terminal-comment-mark').length);
    const dragFrom = await wordTarget('added telemetry', 'added');
    const dragTo = await wordTarget('added telemetry', 'resume');
    if (!dragFrom || !dragTo) throw new Error('no row carrying the coloured diff line');
    await page.mouse.move(dragFrom.x, dragFrom.y);
    await page.mouse.down();
    await page.mouse.move(dragTo.x, dragTo.y, { steps: 6 });
    await sleep(300); // the mark syncs on the next animation frame
    check('the mark is painted while the button is still down', await markCount() > 0);
    await page.mouse.up();
    await sleep(400);
    check('and it is still there after the release', await markCount() > 0);
    await escape();
    await sleep(200);
    check('and gone once the selection is dismissed', await markCount() === 0);

    console.log('a double click on plain output selects a word and offers a comment');
    await runCmd("printf '%s\\n' 'the quick brown fox jumped over the lazy dog'");
    await sleep(1200);
    const at = async (word) => {
      const target = await wordTarget('quick brown fox', word);
      if (!target) {
        console.log('    rows:', JSON.stringify(await page.evaluate(() => (
          [...document.querySelectorAll('.xterm-rows > div')].map((r) => (r.textContent || '').trim()).filter(Boolean).slice(-6)
        ))));
        throw new Error(`no row carrying "${word}"`);
      }
      return target;
    };

    const quick = await at('quick');
    await page.mouse.dblclick(quick.x, quick.y);
    check('word select arms the pill', await awaitPill());
    check('and opens no composer on its own', !(await bubbleShown()));

    console.log('typing turns that selection into a comment');
    await focusTerm();
    await page.keyboard.type('x');
    await page.waitForSelector('.terminal-comment-bubble', { timeout: 3_000 }).catch(() => {});
    check('composer opens on the first key', await bubbleShown());
    check('composer is seeded with the typed char', await page.evaluate(() => (
      document.querySelector('.terminal-comment-bubble textarea')?.value === 'x'
    )));
    await escape();
    await page.waitForFunction(() => !document.querySelector('.terminal-comment-bubble'), { timeout: 3_000 }).catch(() => {});
    check('Esc closes the composer', !(await bubbleShown()));

    console.log('Esc hands the next keystroke back to the shell');
    const dog = await at('dog');
    await page.mouse.dblclick(dog.x, dog.y);
    check('the pill is armed', await awaitPill());
    await focusTerm();
    await page.keyboard.press('Escape');
    await sleep(300);
    check('Esc disarms the pill on an unfrozen view', !(await pillShown()));
    await focusTerm();
    await page.keyboard.type('echo back-to-the-shell');
    await page.keyboard.press('Enter');
    await sleep(700);
    const after = await page.evaluate(() => (
      [...document.querySelectorAll('.xterm-rows > div')].map((r) => (r.textContent || '').trim()).filter(Boolean)
    ));
    check('the keystrokes reached the shell, not a comment',
      after.some((row) => row === 'back-to-the-shell'), after.slice(-4));

    console.log('the comment carries exactly what was selected');
    const brown = await at('brown');
    await page.mouse.dblclick(brown.x, brown.y);
    check('the pill arms on the word', await awaitPill());
    check('a word comment marks that word', selectedIn(await commentAndSend('k')) === 'brown');

    console.log('a triple click takes the whole line');
    await runCmd('clear');
    await runCmd("printf '%s\\n' 'the quick brown fox jumped over the lazy dog'");
    await sleep(1200);
    const lazy = await at('lazy');
    await page.mouse.click(lazy.x, lazy.y, { clickCount: 3 });
    check('line select arms the pill', await awaitPill());
    check('a line comment marks the whole line',
      selectedIn(await commentAndSend('k')) === 'the quick brown fox jumped over the lazy dog');

    console.log('streaming output stays live on a click, freezes for a hold or drag');
    const frozen = () => page.evaluate(() => !!document.querySelector('.terminal-output-frozen-pill'));
    await runCmd('clear');
    await runCmd("printf '%s\\n' 'streaming isSessionActive target'; while :; do printf '.\\r'; sleep 0.1; done");
    const streamTarget = await wordTarget('streaming isSessionActive target', 'isSessionActive');
    const streamEnd = await wordTarget('streaming isSessionActive target', 'target');
    await clearNavFeedback();
    await page.mouse.click(streamTarget.x, streamTarget.y);
    // A CLI status query causes xterm to reply through onData. It is protocol,
    // not typing, and must not silently cancel this pending navigation.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('pty-output', '\u001b[5n');
    });
    await sleep(300);
    check('a pending plain click does not freeze streaming output', !(await frozen()));
    check('the delayed click still navigates while output streams', await navFired());
    await clearNavFeedback();
    await page.mouse.move(streamTarget.x, streamTarget.y);
    await page.mouse.down();
    await sleep(300);
    check('holding a linked word freezes live output', await frozen());
    await page.mouse.up();
    check('the held press does not navigate on release', !(await navFired()));
    check('its freeze survives the navigation deadline', await frozen());
    await escape();
    await sleep(200);
    await page.mouse.move(streamTarget.x, streamTarget.y);
    await page.mouse.down();
    await page.mouse.move(streamEnd.x, streamEnd.y, { steps: 6 });
    check('dragging from a linked word freezes live output', await frozen());
    await page.mouse.up();
    check('the streaming drag arms commenting', await awaitPill());
    check('no navigation interrupts the frozen selection', !(await navFired()));
    await focusTerm();
    await page.keyboard.type('c');
    await page.waitForSelector('.terminal-comment-bubble', { timeout: 3_000 });
    check('typing on the frozen drag selection starts a comment', await bubbleShown());
    await escape();
    check('Esc leaves commenting and resumes streaming', !(await frozen()));
    await page.keyboard.press('Control+c');
  } finally {
    await app.close();
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
