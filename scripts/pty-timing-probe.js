// Standalone PTY-timing probe. Spawns an AI CLI through node-pty,
// captures every data-event timestamp, and runs the same adaptive-
// threshold math the resume auto-fire uses to predict when (and
// whether) it would have misfired.
//
// Usage: node scripts/pty-timing-probe.js [cli] [duration_seconds]
//   cli:      "claude" | "codex" | any command (default: claude)
//   duration: how long to record before killing (default: 25)
//
// Output: arm-to-first-output, longest inter-output pause, last
// output time, computed required-quiet, and the predicted fire
// time. If predicted-fire < last-meaningful-output, that's a
// misfire scenario.

const pty = require('node-pty');

const cli = process.argv[2] || 'claude';
const durationMs = (parseInt(process.argv[3], 10) || 25) * 1000;
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

const PROGRESS_IDLE_MS = 1500;
const RESUME_AUTO_QUIET_DELTA_MS = 1000;
const RESUME_AUTO_QUIET_MAX_MS = 8000;

console.log(`[probe] spawning "${cli}" for ${durationMs}ms`);
const env = Object.assign({}, process.env, { TERM: 'xterm-256color' });
const proc = pty.spawn(cli, [], {
  name: 'xterm-color',
  cols: 100,
  rows: 30,
  cwd: process.cwd(),    // inherit shell cwd so we test in a trusted directory
  env,
});

const start = Date.now();
let prevT = start;
const events = [];

// Specific control sequences worth flagging — these mark TUI lifecycle
// moments that PTY timing alone can't see. Some of them might serve as
// reliable "ready for input" signals.
const NOTABLE = [
  { re: /\x1b\[\?1049h/, tag: 'ALT-SCREEN-ON' },
  { re: /\x1b\[\?1049l/, tag: 'ALT-SCREEN-OFF' },
  { re: /\x1b\[\?25h/,   tag: 'CURSOR-VISIBLE' },
  { re: /\x1b\[\?25l/,   tag: 'CURSOR-HIDDEN' },
  { re: /\x1b\[\?12h/,   tag: 'CURSOR-BLINK-ON' },
  { re: /\x1b\[\?12l/,   tag: 'CURSOR-BLINK-OFF' },
  { re: /\x1b\[\d ?q/,   tag: 'CURSOR-STYLE-SET' },     // DECSCUSR
  { re: /\x1b\[\?2026h/, tag: 'SYNC-BEGIN' },
  { re: /\x1b\[\?2026l/, tag: 'SYNC-END' },
  { re: /\x1b\[\?2004h/, tag: 'BRACKETED-PASTE-ON' },
  { re: /\x1b\[\?1004h/, tag: 'FOCUS-EVENTS-ON' },
  { re: /\x1b\[\d+;\d+r/,tag: 'SCROLL-REGION-SET' },
  { re: /\x1b\]0;[^\x07]*\x07/, tag: 'TITLE-SET' },
];

function flagsIn(data) {
  const hits = [];
  for (const { re, tag } of NOTABLE) {
    if (re.test(data)) hits.push(tag);
  }
  return hits;
}

proc.onData((data) => {
  const now = Date.now();
  const ev = { offset: now - start, gap: now - prevT, bytes: data.length };
  events.push(ev);
  prevT = now;
  if (verbose) {
    const peek = JSON.stringify(data.slice(0, 40));
    const flags = flagsIn(data);
    const flagStr = flags.length ? ` ⟦${flags.join(',')}⟧` : '';
    console.log(`[${ev.offset.toString().padStart(6)}ms] gap=${ev.gap.toString().padStart(5)} bytes=${ev.bytes.toString().padStart(5)}${flagStr} ${peek}${data.length > 40 ? '…' : ''}`);
  }
});

proc.onExit(({ exitCode }) => {
  console.log(`[probe] CLI exited (code=${exitCode}) before duration elapsed`);
  report();
  process.exit(0);
});

setTimeout(() => {
  try { proc.kill(); } catch {}
  report();
  process.exit(0);
}, durationMs);

function report() {
  if (events.length === 0) {
    console.log('[probe] no PTY output captured');
    return;
  }
  const firstOffset = events[0].offset;
  const lastOffset = events[events.length - 1].offset;

  let maxGap = firstOffset;   // first sample = arm→first-output
  for (let i = 1; i < events.length; i++) {
    if (events[i].gap > maxGap) maxGap = events[i].gap;
  }

  const required = Math.max(
    PROGRESS_IDLE_MS,
    Math.min(RESUME_AUTO_QUIET_MAX_MS, maxGap + RESUME_AUTO_QUIET_DELTA_MS),
  );
  const fireAt = lastOffset + required;

  console.log('');
  console.log('--- PTY timing report ---');
  console.log(`  events:           ${events.length}`);
  console.log(`  first output at:  ${firstOffset}ms`);
  console.log(`  last output at:   ${lastOffset}ms`);
  console.log(`  total bytes:      ${events.reduce((s, e) => s + e.bytes, 0)}`);
  console.log(`  max sample:       ${maxGap}ms (includes arm→first-output)`);
  console.log(`  required quiet:   ${required}ms`);
  console.log(`  predicted fire:   ${fireAt}ms after spawn`);
  console.log('');
  console.log('--- top 5 gaps ---');
  const gaps = events
    .map((e, i) => ({ i, offset: e.offset, gap: i === 0 ? firstOffset : e.gap }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 5);
  for (const g of gaps) {
    console.log(`  event #${g.i.toString().padStart(3)} at ${g.offset.toString().padStart(6)}ms — gap ${g.gap}ms`);
  }
  console.log('');
  console.log('--- last 5 events ---');
  for (const e of events.slice(-5)) {
    console.log(`  offset=${e.offset.toString().padStart(6)}ms gap=${e.gap.toString().padStart(5)}ms bytes=${e.bytes}`);
  }
}
