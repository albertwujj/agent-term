// job-watch.js — pure decision logic for the background-job monitor (the
// "job-done nudge"). Host contract: docs/dev/job-events.md. I/O-free: main.js feeds
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
// session's only), pending (Map file → { finishedAt } from earlier polls),
// prevPollAt (the last completed poll, 0 if none), windowStartAt (when this
// window's shell came up), quietMs }.
// Returns { pending, notice|null, remove: [files], running: [{ cmd, startedMs }] }.
//
// A completion event is delivered once the agent has been quiet for quietMs
// after both the job's finish and its own last activity, and the user is not
// composing. Activity holds an event; nothing consumes one unread. A job
// launched detached runs out of the CLI's sight, so the host is the only one
// that will tell the agent, busy or not; a paste mid-turn would ride the
// CLI's input queue, so the event waits for the turn to end instead. A CLI
// that did track the job and told the agent itself makes the report a
// duplicate, which the notice's "ignore if already handled" covers. Quiet is
// judged on substantial screen output (agentActiveAt): a spinner frame,
// token counter, or a status line repainting is churn, and counting it would
// hold a report behind a CLI that repaints while idle.
//
// The finish time is the event's ts, clamped into (prevPollAt, now] (the file
// was not in the spool at the previous poll; WSL's clock can be minutes off
// after a host sleep) and to no earlier than windowStartAt (a job that
// finished before this window existed counts as finishing when it came up).
// Fixed at first sight, so the quiet period is measured from one point.
//
// A start record whose process is dead with no matching event enters the
// same pipeline, its death detected now, and earns the "gone without a
// completion report" notice. The poll that sees the death bounds it to one
// poll interval, so the notice gives how long the job ran; a job from before
// this window found dead at its first completed poll died while no host was
// looking, at a time nobody knows (goneMs null). Start records with a live
// process are reported as running and left in the spool; their EXIT trap
// removes them.
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
  const running = [];
  let notice = null;
  const ripe = (p) => !composing && now - Math.max(p.finishedAt, agentActiveAt) >= quietMs;

  const ripeEvents = [];
  for (const e of events) {
    const p = pendingIn.get(e.file)
      || { finishedAt: Math.min(Math.max(e.tsMs, prevPollAt, windowStartAt), now) };
    if (ripe(p)) ripeEvents.push(e);
    else pending.set(e.file, p);
  }
  if (ripeEvents.length) {
    for (const e of ripeEvents) remove.push(e.file);
    notice = {
      kind: 'job-report', notice: true,
      items: ripeEvents.map((e) => ({ msg: oneLine(e.msg), tsMs: e.tsMs, startedMs: e.startedMs })),
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
    const p = pendingIn.get(s.file) || {
      finishedAt: now,
      unwatched: !prevPollAt && !(s.startedMs >= windowStartAt),
    };
    // One notice per poll: a ripe report going out this cycle leaves the
    // gone records pending (still ripe) for the next one.
    if (ripe(p) && !notice) ripeGone.push({ s, p });
    else pending.set(s.file, p);
  }
  if (ripeGone.length) {
    for (const { s } of ripeGone) remove.push(s.file);
    notice = {
      kind: 'job-vanished', notice: true,
      items: ripeGone.map(({ s, p }) => ({
        command: oneLine(s.cmd, 120), startedMs: s.startedMs,
        goneMs: p.unwatched ? null : p.finishedAt,
      })),
    };
  }

  return { pending, notice, remove, running };
}

module.exports = { parseSpool, oneLine, evaluate };
