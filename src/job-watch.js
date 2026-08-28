// job-watch.js — pure decision logic for the background-job monitor (the
// "job-done nudge"). Host contract: job-events.md. I/O-free: main.js feeds
// it one spool dump per poll (completion events plus start records, each
// start record carrying a liveness bit main resolved with kill -0); this
// decides which spool files to remove, which to keep pending, which jobs
// are running (the chrome bar's background-jobs indicator), and what
// notice (at most one per poll) to inject. Two signals:
//   events — a participating script announced its own completion (rich,
//            durable, topology-proof); the primary signal.
//   starts — a start record whose process is gone with NO event:
//            SIGKILL/OOM-class death, a result that is never coming. A
//            start record with a live process is a running job.

'use strict';

// Spool dump ("===FILE <path>" then key=value lines per file) → parsed
// events and start records. The writer pid rides in the filename
// (<epoch>.<pid>.event / .started) and is what correlates a start record
// with its job's completion event. `alive` on a start record is resolved
// shell-side (kill -0 by the filename pid) in the same read as the
// listing, so liveness can never refer to a different moment than the
// file's existence.
function parseSpool(dump) {
  const events = [];
  const starts = [];
  let cur = null;
  for (const line of String(dump).split('\n')) {
    const f = line.match(/^===FILE (.+)$/);
    if (f) {
      const em = f[1].match(/(\d+)\.(\d+)\.event$/);
      const sm = f[1].match(/(\d+)\.(\d+)\.started$/);
      if (em) {
        cur = { file: f[1], pid: Number(em[2]), session: '', tsMs: null, startedMs: null, msg: '' };
        events.push(cur);
      } else if (sm) {
        cur = { file: f[1], pid: Number(sm[2]), session: '', startedMs: null, cmd: '', alive: false };
        starts.push(cur);
      } else {
        cur = null;
      }
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^(session|ts|started|msg|cmd|alive)=(.*)$/);
    if (!kv) continue;
    if (kv[1] === 'session') cur.session = kv[2].trim();
    else if (kv[1] === 'ts') cur.tsMs = Date.parse(kv[2]) || null;
    else if (kv[1] === 'started') cur.startedMs = Date.parse(kv[2]) || null;
    else if (kv[1] === 'msg') cur.msg = kv[2];
    else if (kv[1] === 'cmd') cur.cmd = kv[2];
    else if (kv[1] === 'alive') cur.alive = kv[2].trim() === '1';
  }
  return {
    events: events.filter((e) => e.session && e.tsMs),
    starts: starts.filter((s) => s.session),
  };
}

// Notice text must survive the bracketed-paste envelope even if a cmdline
// or msg is hostile: one line, ESC stripped, length-capped.
function oneLine(s, max = 200) {
  return String(s).replace(/\x1b/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// One poll step. input: { now, agentActiveAt (ms timestamp of the last
// SUBSTANTIAL screen change: real content, not spinner/status churn, and
// not the user's own typing echo — classified in stream/renderer-watch.js),
// composing (keys typed since the last submit), events, starts (this
// session's only), pending (Map file → { finishedAt, awakeAfter, gone? }
// from earlier polls), prevPollAt (the last completed poll, 0 if none),
// windowStartAt (when this window's shell came up), quietMs }.
// Returns { pending, notice|null, remove: [files], superseded: [files],
// running: [{ cmd, startedMs }] }.
//
// Completion events deliver only to an agent that was idle WHEN the job
// finished and stays idle for quietMs AFTER it. An agent that was awake at
// the finish, or woke within the quiet period, learned of it from its own
// environment (a self-waking CLI's background-task notice, its own check) or
// is busy with something a queued notice would only confuse: a pasted notice
// rides the CLI's input queue and lands after the running turn, as a stale
// second report. Such an event is superseded: consumed, logged, never pasted.
// "Awake" is judged on substantial screen output (agentActiveAt): a spinner
// frame, token counter, or a status line clearing at the finish is churn,
// not waking — a CLI wiping its task-stats display the moment the job ends
// must not eat the report. The user composing holds a ripe event; if they
// then submit, the turn's output supersedes it at the next poll.
//
// The finish time is the event's ts, clamped into (prevPollAt, now] (the file
// was not in the spool at the previous poll; WSL's clock can be minutes off
// after a host sleep). A job that finished before this window existed had no
// agent here to be awake at it, and the resumed CLI's startup burst must not
// read as waking to it: its finish is pinned to the agent's last activity at
// first sight, so the quiet period runs from there and only NEW activity
// supersedes. Fixed at first sight, so the quiet period is measured from one
// point; `awakeAfter` is the activity threshold that supersedes.
//
// A start record whose process is dead with no matching event enters the
// same pipeline, with the death detected now: an agent active around the
// detection most likely killed the job itself (or is mid-turn), so the
// record is consumed silently; an agent idle through the quiet period gets
// the "gone without a completion report" notice. A start record predating
// this window (a job from before a resume that died while no host was
// watching) is pinned like a pre-window event, so the resumed CLI's
// startup burst does not eat it. Start records with a live process are
// reported as running and left in the spool; their EXIT trap removes them.
const FINISH_MARGIN_MS = 5000; // output this close before the finish = awake at it

function evaluate(input) {
  const { now, composing, quietMs } = input;
  const agentActiveAt = input.agentActiveAt || 0;
  const prevPollAt = input.prevPollAt || 0;
  const windowStartAt = input.windowStartAt || 0;
  const events = input.events || [];
  const starts = input.starts || [];
  const pendingIn = input.pending || new Map();
  const pending = new Map();
  const remove = [];
  const superseded = [];
  const running = [];
  let notice = null;

  const ripe = [];
  for (const e of events) {
    let p = pendingIn.get(e.file);
    if (!p) {
      const lo = Math.max(prevPollAt, windowStartAt);
      let finishedAt = Math.min(Math.max(e.tsMs, lo), now);
      let awakeAfter = finishedAt - FINISH_MARGIN_MS;
      if (e.tsMs < windowStartAt) {
        finishedAt = Math.min(Math.max(finishedAt, agentActiveAt), now);
        awakeAfter = finishedAt + 1;
      }
      p = { finishedAt, awakeAfter };
    }
    if (agentActiveAt >= p.awakeAfter) {
      superseded.push(e.file);
      remove.push(e.file);
      continue;
    }
    if (now - p.finishedAt >= quietMs && !composing) { ripe.push(e); continue; }
    pending.set(e.file, p);
  }
  if (ripe.length) {
    for (const e of ripe) remove.push(e.file);
    notice = {
      kind: 'job-report', notice: true,
      items: ripe.map((e) => ({ msg: oneLine(e.msg), tsMs: e.tsMs, startedMs: e.startedMs })),
    };
  }

  // Start records. An event from the same pid owns the job: the trap wrote
  // both, and its rm of the start record can trail this read — clean the
  // record up rather than ever reading the pair as a vanish.
  const eventPids = new Set(events.map((e) => e.pid).filter(Boolean));
  const ripeGone = [];
  for (const s of starts) {
    if (s.pid && eventPids.has(s.pid)) { remove.push(s.file); continue; }
    if (s.alive) { running.push({ cmd: s.cmd, startedMs: s.startedMs }); continue; }
    let p = pendingIn.get(s.file);
    if (!p) {
      // Death detected this poll. For a job predating the window, only NEW
      // activity supersedes (the resumed CLI's startup burst is not the
      // agent reacting to a death it never saw).
      const preWindow = s.startedMs && s.startedMs < windowStartAt;
      p = {
        finishedAt: now,
        awakeAfter: preWindow ? agentActiveAt + 1 : now - FINISH_MARGIN_MS,
        gone: { cmd: s.cmd, startedMs: s.startedMs },
      };
    }
    if (agentActiveAt >= p.awakeAfter) {
      superseded.push(s.file);
      remove.push(s.file);
      continue;
    }
    if (now - p.finishedAt >= quietMs && !composing) { ripeGone.push({ s, p }); continue; }
    pending.set(s.file, p);
  }
  if (ripeGone.length) {
    if (!notice) {
      for (const { s } of ripeGone) remove.push(s.file);
      notice = {
        kind: 'job-vanished', notice: true, lastSeenMs: now,
        items: ripeGone.map(({ s, p }) => ({
          command: oneLine(s.cmd, 120),
          startedMs: p.gone ? p.gone.startedMs : s.startedMs,
        })),
      };
    } else {
      // One notice per poll: a ripe report went out this cycle, so the
      // gone records stay pending (still ripe) for the next one.
      for (const { s, p } of ripeGone) pending.set(s.file, p);
    }
  }

  return { pending, notice, remove, superseded, running };
}

module.exports = { parseSpool, oneLine, evaluate, FINISH_MARGIN_MS };
