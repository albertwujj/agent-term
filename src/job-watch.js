// job-watch.js — pure decision logic for the background-job monitor (the
// "job-done nudge"). Host contract: job-events.md. I/O-free: main.js feeds
// it one ps snapshot + one spool dump per idle poll; this decides which
// event files to remove and what notice (at most one per idle window) to
// inject. Three signals, each covering the others' blind spot:
//   events  — a participating script announced its own completion (rich,
//             durable, topology-proof); the primary signal.
//   labeled — a process carrying our [sess:<token>] label vanished with NO
//             event: SIGKILL/OOM-class death, a result that is never
//             coming. Matched machine-wide (labels survive orphaning).
//   generic — an unlabeled direct child of the agent vanished: non-kit
//             background jobs. Direct children only — grandchild churn
//             (curl/sleep inside a job) is normal mid-job behavior.

'use strict';

// Claude Code on macOS keeps `caffeinate -i -t 300` as a child; its lease
// expires ~5 min into every idle window — a scheduled exit caused BY
// idleness, not a job finishing (counting it would nudge-loop forever).
// The one observed infra child worth excluding; extend only on an observed
// second offender. Inert on WSL (caffeinate is macOS-only).
const GENERIC_DENYLIST = new Set(['caffeinate']);


// ps etime ([[dd-]hh:]mm:ss, same format BSD and procps) → seconds.
function parseEtime(s) {
  const m = String(s).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return (((Number(dd || 0) * 24 + Number(hh || 0)) * 60 + Number(mm)) * 60) + Number(ss);
}

// `ps -axo pid=,ppid=,pgid=,stat=,etime=,command=` → rows.
function parsePs(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]),
      stat: m[4], etimeSec: parseEtime(m[5]), command: m[6].trim(),
    });
  }
  return rows;
}

// The agent = the shell's foreground (`+`) child, descended through
// exec-style wrappers. A wrapper has exactly one child, in the foreground
// group; a node with several children (jobs, plus helpers like caffeinate
// that are ALSO `+` but leaves) is the agent itself — descending into a
// foreground helper leaf would misidentify it. No `+` child under the
// shell → nothing is running at the prompt.
function findAgentPid(rows, shellPid) {
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r);
  }
  const fgKids = (pid) => (kids.get(pid) || []).filter((r) => r.stat.includes('+'));
  const first = fgKids(shellPid); // shell may have other, background children
  if (!first.length) return null;
  let agent = first[0].pid;
  for (;;) {
    const all = kids.get(agent) || [];
    const fg = fgKids(agent);
    if (all.length === 1 && fg.length === 1) agent = fg[0].pid;
    else return agent;
  }
}

function labelToken(sess) { return `[sess:${sess}]`; }

// Live processes carrying our label — any ancestry, so a labeled job that
// was orphaned (reparented to init) is still watched.
function selectLabeled(rows, sess) {
  const tok = labelToken(sess);
  return rows.filter((r) => !r.stat.startsWith('Z') && r.command.includes(tok));
}

function commandBasename(command) {
  const first = String(command).trim().split(/\s+/)[0] || '';
  return first.split('/').pop();
}

// Live unlabeled direct children of the agent, minus denylisted infra.
function selectGeneric(rows, agentPid, sess) {
  if (!agentPid) return [];
  const tok = labelToken(sess);
  return rows.filter((r) =>
    r.ppid === agentPid &&
    !r.stat.startsWith('Z') &&
    !r.command.includes(tok) &&
    !GENERIC_DENYLIST.has(commandBasename(r.command)));
}

// Spool dump ("===FILE <path>" then key=value lines per event) → events.
// The writer pid rides in the filename (<epoch>.<pid>.event) and is what
// correlates an event with a labeled process's normal exit.
function parseEvents(dump) {
  const events = [];
  let cur = null;
  for (const line of String(dump).split('\n')) {
    const f = line.match(/^===FILE (.+)$/);
    if (f) {
      const pm = f[1].match(/(\d+)\.(\d+)\.event$/);
      cur = { file: f[1], pid: pm ? Number(pm[2]) : null, session: '', tsMs: null, startedMs: null, msg: '' };
      events.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^(session|ts|started|msg)=(.*)$/);
    if (!kv) continue;
    if (kv[1] === 'session') cur.session = kv[2].trim();
    else if (kv[1] === 'ts') cur.tsMs = Date.parse(kv[2]) || null;
    else if (kv[1] === 'started') cur.startedMs = Date.parse(kv[2]) || null;
    else cur.msg = kv[2];
  }
  return events.filter((e) => e.session && e.tsMs);
}

// Notice text must survive the bracketed-paste envelope even if a cmdline
// or msg is hostile: one line, ESC stripped, length-capped.
function oneLine(s, max = 200) {
  return String(s).replace(/\x1b/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// One poll step. input: { now, agentQuietFor (ms since last PTY output),
// composing (keys typed since the last submit), snapshot, events (this
// session's only), idleMs, fuseMs, psOk (the ps snapshot is trustworthy —
// ps ran and exited cleanly) }. Returns { state, notice|null,
// remove: [files] }.
//
// Completion events deliver ALWAYS — exactly once each, at the first poll
// where the user is not mid-compose. No fuse: an explicit event is a
// reliable signal, so a slept agent is re-engaged on the next poll. A user
// steer or a running turn only holds delivery to the poll after their
// submit, where the paste rides the CLI's own input queue. Redundant
// deliveries to self-waking CLIs are accepted by design — the notice
// carries an "ignore if already handled" tail.
//
// The vanish tiers still need a quiet-agent window: their baselines are
// only meaningful when no foreground tool has been running (idleMs of
// output silence). User keystrokes don't reset that window — typing
// changes no process state. They also need a trustworthy snapshot: a
// vanish is inferred from ABSENCE, so an empty/failed ps read must never
// stand in for "everything died" (see the psOk guard).
function evaluate(input, state) {
  const { now, agentQuietFor, composing, snapshot, events, idleMs, fuseMs, psOk } = input;
  const remove = [];
  let notice = null;

  if (!composing && events.length) {
    for (const e of events) remove.push(e.file);
    notice = {
      kind: 'job-report', notice: true,
      items: events.map((e) => ({ msg: oneLine(e.msg), tsMs: e.tsMs, startedMs: e.startedMs })),
    };
  }

  if (agentQuietFor < idleMs) return { state: null, notice, remove };

  // Vanish is inferred from a process's ABSENCE, so it is sound only against
  // a known-good snapshot. An empty/failed ps read (a WSL hiccup, or the
  // shell pid not yet resolvable) would otherwise read as "every baselined
  // job vanished at once" and fire a false report. When the snapshot is not
  // trustworthy, keep the baseline intact and skip the vanish tiers this
  // poll — events were already handled above and don't depend on ps.
  if (!psOk) return { state: state || null, notice, remove };

  const st = state || {
    baselineAt: now,
    baseLabeled: new Map(snapshot.labeled.map((r) => [r.pid, r])),
    baseGeneric: new Map(snapshot.generic.map((r) => [r.pid, r])),
    nudged: false,
  };

  // An event writer exited normally — deliverable or not yet, its labeled
  // process must never also be reported as vanished.
  for (const e of events) {
    if (e.pid) st.baseLabeled.delete(e.pid);
  }

  // Vanish notices hold while the user is composing, same as events; the
  // gone pids stay in the baseline so the notice fires after the submit.
  if (!notice && !st.nudged && !composing && agentQuietFor >= fuseMs) {
    const liveLabeled = new Set(snapshot.labeled.map((r) => r.pid));
    const goneLabeled = [...st.baseLabeled.values()].filter((r) => !liveLabeled.has(r.pid));
    if (goneLabeled.length) {
      notice = {
        kind: 'job-vanished', notice: true, lastSeenMs: now,
        items: goneLabeled.map((r) => ({
          command: oneLine(r.command, 120),
          startedMs: r.etimeSec != null ? st.baselineAt - r.etimeSec * 1000 : null,
        })),
      };
      for (const r of goneLabeled) st.baseLabeled.delete(r.pid);
      st.nudged = true;
    } else {
      const liveGeneric = new Set(snapshot.generic.map((r) => r.pid));
      const goneGeneric = [...st.baseGeneric.values()].filter((r) => !liveGeneric.has(r.pid));
      if (goneGeneric.length) {
        notice = {
          kind: 'job-generic', notice: true,
          items: goneGeneric.map((r) => ({ command: oneLine(r.command, 120) })),
        };
        for (const r of goneGeneric) st.baseGeneric.delete(r.pid);
        st.nudged = true;
      }
    }
  }

  return { state: st, notice, remove };
}

module.exports = {
  parseEtime, parsePs, findAgentPid, selectLabeled, selectGeneric,
  parseEvents, oneLine, evaluate, GENERIC_DENYLIST,
};
