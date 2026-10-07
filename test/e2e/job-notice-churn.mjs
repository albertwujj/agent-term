// End-to-end regression test for the job-notice activity classifier:
// a completion notice must DELIVER through ongoing status-line churn and
// must be HELD under real scrolling output until that output stops.
//
// The regression pinned here end-to-end: a CLI repainting/clearing a status
// line read as agent activity (any pty byte counted), so a notice could sit
// behind an idle CLI's repaints. The classified path is renderer buffer watcher → substantial
// flag over preload IPC → main's lastAgentOutputTime → job-watch evaluate.
// This drives the REAL app via Playwright's _electron: real shell, real
// event spool, real 500ms buffer polls; the oracle is the main process's
// own [job-watch] log lines on the Electron stdout.
//
//   Case A (regression): a status line repaints in place every 400ms the
//     whole time — before, at, and after the event lands mid-churn (the
//     cursor shape: stats shown DURING the task, cleared/redrawn at the
//     finish). Expect "[job-watch] notice: job-report" naming the event's
//     msg despite the ongoing repaints.
//   Case B (control): screen pre-filled so scroll is active (the steady
//     state of any real session) → quiet gap → event lands → real lines
//     scroll in for 8s. Expect no notice while they scroll, then the
//     notice once the output has stopped for the idle window.
//
// Sped up via env knobs: poll 1500ms, idle window 3000ms.
//
// Run: npm run test:e2e   (builds the renderer first, then this)

import { launchElectron } from './electron.mjs';
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

// Write a spool event the shell's own AGENT_SESSION_ID routes back to
// this window. <epoch>.<pid>.event shape; the pid part is a per-case
// literal so the two files can't collide.
function writeEvent(msg, fakePid) {
  return `d="$TMPDIR/agent-events"; mkdir -p "$d"; ` +
    `printf 'session=%s\\nts=%s\\nstarted=%s\\nmsg=%s\\n' ` +
    `"$AGENT_SESSION_ID" "$(date -u +%FT%TZ)" "$(date -u +%FT%TZ)" ${msg} ` +
    `> "$d/$(date +%s).${fakePid}.event"`;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-e2e-jobs-'));
  const app = await launchElectron({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', APP_DIR],
    env: {
      ...process.env,
      TMPDIR: tmp,                      // isolated spool: $TMPDIR/agent-events
      AGENT_TERM_JOB_POLL_MS: '1500',
      AGENT_TERM_JOB_IDLE_MS: '3000',
    },
    timeout: 45_000,
  });

  // The oracle: main's log() writes to the Electron process stdout.
  let mainLog = '';
  const proc = app.process();
  if (!proc || !proc.stdout) throw new Error('electron stdout not piped — cannot observe [job-watch] log');
  proc.stdout.on('data', (d) => { mainLog += d.toString(); });
  if (proc.stderr) proc.stderr.on('data', (d) => { mainLog += d.toString(); });
  async function waitForLog(re, timeoutMs, from = 0) {
    const t0 = Date.now();
    for (;;) {
      const m = mainLog.slice(from).match(re);
      if (m) return m;
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(250);
    }
  }

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
    await sleep(1200); // let the shell print its first prompt

    const runCmd = async (cmd) => {
      await page.evaluate(() => {
        const ta = document.querySelector('.xterm-helper-textarea');
        if (ta) ta.focus();
      });
      await page.keyboard.type(cmd);
      await page.keyboard.press('Enter');
    };

    check('job watch armed', !!(await waitForLog(/\[job-watch\] armed/, 10_000)));

    // ---- Case A: notice delivers through status-line churn ----
    console.log('Case A — status-line churn must not eat the notice');
    const markA = mainLog.length;
    // One status row repaints in place every 400ms for ~24s; the event
    // lands mid-churn at iteration 20 (~8s in) — the output pattern
    // (spinner/counter/stats repaints) of a CLI that is idle but repainting.
    await runCmd(
      `( i=0; while [ $i -lt 60 ]; do i=$((i+1)); ` +
      `if [ $i -eq 20 ]; then ${writeEvent('churnjob-finished', '101')}; fi; ` +
      `printf '\\r\\033[2K* working %d' $i; sleep 0.4; done; echo )`);
    const noticeA = await waitForLog(/\[job-watch\] notice: job-report.*churnjob-finished/, 35_000, markA);
    check('notice delivered during churn', !!noticeA);

    // ---- Case B: real scrolling output holds the notice until it stops ----
    console.log('Case B — scrolling output holds the notice (control)');
    await sleep(2500); // let case A's pasted notice echo and the prompt settle
    const markB = mainLog.length;
    // Fill the screen first so scroll is active — the steady state of any
    // real session — then go quiet before the event, and scroll after it.
    // The stream's end is marked by a file, so the test knows when the
    // output stopped.
    const doneB = path.join(tmp, 'stream-done');
    await runCmd(
      `( j=0; while [ $j -lt 110 ]; do j=$((j+1)); echo "fill-$j"; done; ` +
      `sleep 8; ${writeEvent('streamjob-finished', '202')}; ` +
      `i=0; while [ $i -lt 40 ]; do i=$((i+1)); echo "stream-line-$i"; sleep 0.2; done; ` +
      `touch "${doneB}" )`);
    for (const t0 = Date.now(); !fs.existsSync(doneB) && Date.now() - t0 < 30_000;) await sleep(100);
    check('stream ran to its end', fs.existsSync(doneB));
    check('no notice while the output scrolled',
      !mainLog.slice(markB).match(/\[job-watch\] notice: job-report.*streamjob-finished/));
    const noticeB = await waitForLog(/\[job-watch\] notice: job-report.*streamjob-finished/, 15_000, markB);
    check('notice delivered once the output stopped', !!noticeB);

    // ---- Case C: start record → running indicator → unreported death ----
    // A hand-written start record for a real short-lived process: while it
    // lives the indicator must report one running job; when it dies with no
    // completion event (no trap removes a hand-written record), the host
    // must notice "gone without a completion report" after the quiet
    // period, with the run length known: this window saw the death.
    console.log('Case C — start record: running indicator, then unreported death');
    await sleep(2500);
    const markC = mainLog.length;
    await runCmd(
      `( sleep 12 >/dev/null 2>&1 & p=$!; d="$TMPDIR/agent-events"; mkdir -p "$d"; ` +
      `printf 'session=%s\\nstarted=%s\\ncmd=%s\\n' ` +
      `"$AGENT_SESSION_ID" "$(date -u +%FT%TZ)" "demo-job sleep 12" ` +
      `> "$d/$(date +%s).$p.started" )`);
    check('running job indicated', !!(await waitForLog(/\[job-watch\] running: 1/, 15_000, markC)));
    const vanishedC = await waitForLog(/\[job-watch\] notice: job-vanished.*demo-job sleep 12.*/, 35_000, markC);
    check('unreported death noticed', !!vanishedC);
    check('a death the window watched has a known end', /"goneMs":\d+/.test(vanishedC ? vanishedC[0] : ''));
    check('indicator cleared after the death', !!(await waitForLog(/\[job-watch\] running: 0/, 10_000, markC)));
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
