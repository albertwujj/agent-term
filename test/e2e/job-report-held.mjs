// End-to-end test of the held-reports indicator and its "send now" override.
// Drives the real app: real shell, real spool, real clicks on the chrome bar.
// The oracles are main's [job-watch] log lines, the spool, and what the shell
// did with what reached it.
//
//   Case A: a report in its quiet period shows the grey envelope; Send now
//     submits it long before the quiet period ends, the spool file goes, and
//     the icon with it.
//   Case B: keys typed and left in the prompt hold a report past its quiet
//     period, in amber; To prompt leaves the line unsubmitted, and a second
//     report still waits rather than submit it.
//   Case C: a bare Esc holds a report just the same, and Enter ends the hold.
//   Case D: To prompt after a bare Esc submits nothing either: the keys cannot
//     tell an emptied prompt from a draft whose caret is on a fresh line.
//
// The idle window is far longer than any check here, so only the click can
// explain a notice in A and B.
//
// Run: npm run test:e2e   (builds the renderer first, then this)

import { followMainLog, launchElectron } from './electron.mjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 500;
const AMBER = 'rgb(220, 220, 170)';
const GREY = 'rgb(144, 144, 144)';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-e2e-held-'));
  const spool = path.join(tmp, 'agent-events');
  fs.mkdirSync(spool);
  const app = await launchElectron({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', APP_DIR],
    env: {
      ...process.env,
      TMPDIR: tmp,
      AGENT_TERM_JOB_POLL_MS: String(POLL_MS),
      AGENT_TERM_JOB_IDLE_MS: '6000',
    },
    timeout: 45_000,
  });
  const mainLog = await followMainLog(app);
  const logged = (re, from = 0) => re.test(mainLog.text.slice(from));
  const waitFor = async (cond, timeoutMs) => {
    for (const t0 = Date.now(); Date.now() - t0 < timeoutMs;) {
      if (await cond()) return true;
      await sleep(100);
    }
    return false;
  };

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
    await waitFor(() => page.locator('.at-picker-overlay').count(), 10_000);
    await waitFor(async () => {
      if (!(await page.locator('.at-picker-overlay').count())) return true;
      await page.keyboard.press('Escape');
      return false;
    }, 10_000);
    await page.evaluate(() => document.querySelector('.xterm-helper-textarea').focus());
    await sleep(1200);

    const tokenFile = path.join(tmp, 'token');
    await page.keyboard.type(`echo "$AGENT_SESSION_ID" > "${tokenFile}"`);
    await page.keyboard.press('Enter');
    await waitFor(() => fs.existsSync(tokenFile) && fs.readFileSync(tokenFile, 'utf8').trim(), 5000);
    const token = fs.readFileSync(tokenFile, 'utf8').trim();

    let fakePid = 500;
    const writeEvent = (msg) => {
      const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      const file = path.join(spool, `${Math.floor(Date.now() / 1000)}.${++fakePid}.event`);
      fs.writeFileSync(file, `session=${token}\nts=${iso}\nstarted=${iso}\nmsg=${msg}\n`);
      return file;
    };
    const icon = page.locator('.at-chrome-held');
    const iconColor = () => icon.evaluate((el) => getComputedStyle(el).color);
    const iconTitle = () => icon.getAttribute('title');
    const clearHold = async () => {
      await page.keyboard.press('Control+C');
      await sleep(300);
      await page.keyboard.press('Enter');
      await sleep(300);
    };

    // ---- Case A ----
    console.log('Case A — quiet period: grey envelope, Send now submits');
    let mark = mainLog.text.length;
    const fileA = writeEvent('job-a-finished');
    check('envelope appears', await waitFor(() => icon.count(), 5000));
    check('grey: the hold ends by itself', (await iconColor()) === GREY);
    check('tooltip says why and names the report',
      /waiting: it goes out after 6s of quiet\njob-a-finished/.test(await iconTitle()));
    check('nothing sent yet', !logged(/\[job-watch\] notice:/, mark));
    const focusBefore = await page.evaluate(() => document.activeElement && document.activeElement.className);
    await icon.click();
    const send = page.locator('.at-chrome-held-send');
    check('click opens the popover with the send button', await waitFor(() => send.count(), 2000));
    check('the popover names the report',
      (await page.locator('.at-chrome-jobs-pop .cmd').first().textContent()) === 'job-a-finished');
    await send.click();
    check('sent right away, marked as the user\'s',
      await waitFor(() => logged(/\[job-watch\] notice: job-report \(sent now by the user\).*job-a-finished/, mark), 2000));
    check('the spool file is gone', await waitFor(() => !fs.existsSync(fileA), 2000));
    check('the envelope is gone', await waitFor(async () => !(await icon.count()), 2000));
    check('the popover is gone', (await page.locator('.at-chrome-jobs-pop').count()) === 0);
    check('focus stayed where it was', focusBefore === await page.evaluate(() => document.activeElement && document.activeElement.className));
    check('exactly one notice', (mainLog.text.slice(mark).match(/\[job-watch\] notice:/g) || []).length === 1);
    await sleep(1500);

    // ---- Case B ----
    console.log('Case B — a draft in the prompt: amber, To prompt does not submit it');
    await clearHold();
    mark = mainLog.text.length;
    const ran = path.join(tmp, 'draft-ran');
    await page.keyboard.type(`touch "${ran}"`);
    const fileB = writeEvent('job-b-finished');
    check('envelope appears', await waitFor(() => icon.count(), 5000));
    check('amber: only the user ends this one', await waitFor(async () => (await iconColor()) === AMBER, 3000));
    check('tooltip names the typing',
      /keys were typed here since the last Enter/.test(await iconTitle()));
    // Past the quiet period the automatic path would have sent it; composing holds.
    await sleep(6500);
    check('held past the quiet period', !logged(/\[job-watch\] notice:/, mark) && fs.existsSync(fileB));
    await icon.click();
    check('the button says it goes to the prompt', (await send.textContent()) === 'To prompt');
    await send.click();
    check('sent on the click',
      await waitFor(() => logged(/\[job-watch\] notice: job-report \(sent now by the user\).*job-b-finished/, mark), 3000));
    await sleep(1500);
    check('the draft did not run', !fs.existsSync(ran));
    check('nothing was submitted', !logged(/\[submit\] terminator sent/, mark));
    // The line is still unsent, so the hold stays on for the next report.
    const fileB2 = writeEvent('job-b2-finished');
    check('a second report waits', await waitFor(() => icon.count(), 5000));
    check('still amber', await waitFor(async () => (await iconColor()) === AMBER, 3000));
    await sleep(6500);
    check('held past its quiet period: the draft is not submitted by it',
      !logged(/\[job-watch\] notice: job-report (?!\(sent now).*job-b2-finished/, mark) && fs.existsSync(fileB2) && !fs.existsSync(ran));
    await page.keyboard.press('Control+C');
    await sleep(300);
    await page.keyboard.press('Enter');
    check('and goes out once the line is gone',
      await waitFor(() => logged(/\[job-watch\] notice: job-report .*job-b2-finished/, mark), 10_000));
    await sleep(1500);

    // ---- Case C ----
    console.log('Case C — a bare Esc holds too; Enter ends it');
    await clearHold();
    mark = mainLog.text.length;
    await page.keyboard.press('Escape');
    writeEvent('job-c-finished');
    check('envelope appears', await waitFor(() => icon.count(), 5000));
    check('amber', await waitFor(async () => (await iconColor()) === AMBER, 3000));
    await sleep(6500);
    check('held past the quiet period', !logged(/\[job-watch\] notice:/, mark));
    await page.keyboard.press('Enter');
    check('Enter releases it, by itself',
      await waitFor(() => logged(/\[job-watch\] notice: job-report (?!\(sent now).*job-c-finished/, mark), 10_000));
    check('the envelope is gone', await waitFor(async () => !(await icon.count()), 3000));
    await sleep(1500);

    // ---- Case D ----
    console.log('Case D — To prompt after a bare Esc: unsubmitted');
    await clearHold();
    mark = mainLog.text.length;
    await page.keyboard.press('Escape');
    writeEvent('job-d-finished');
    check('amber', await waitFor(async () => (await icon.count()) && (await iconColor()) === AMBER, 5000));
    await icon.click();
    await send.click();
    check('sent on the click',
      await waitFor(() => logged(/\[job-watch\] notice: job-report \(sent now by the user\).*job-d-finished/, mark), 3000));
    await sleep(1000);
    check('nothing was submitted', !logged(/\[submit\] terminator sent/, mark));
    await page.keyboard.press('Control+C');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
