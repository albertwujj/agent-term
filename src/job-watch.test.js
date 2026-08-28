// node --test src/job-watch.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const jw = require('./job-watch');

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_800_000_000_000;
// One poll's input. agentActiveAt defaults to 20 min quiet, the window came
// up a day ago, no previous poll, nothing pending.
const inp = (over = {}) => {
  const now = over.now ?? T0;
  return {
    now, agentActiveAt: now - 20 * MIN, composing: false,
    events: [], starts: [], pending: new Map(), prevPollAt: 0,
    windowStartAt: T0 - 24 * HOUR, quietMs: 2 * MIN,
    ...over,
  };
};
const ev = (over = {}) => ({
  file: '/tmp/agent-events/1.300.event', pid: 300, session: 'abc123',
  tsMs: T0 - 16 * MIN, startedMs: T0 - 60 * MIN,
  msg: 'watch-build.sh change 123: VERDICT=SUCCESS http://j/42/', ...over,
});
const st = (over = {}) => ({
  file: '/tmp/agent-events/1.300.started', pid: 300, session: 'abc123',
  startedMs: T0 - 60 * MIN, cmd: 'watch-build.sh --url http://j/42/',
  alive: true, ...over,
});

test('parseSpool: events and start records, alive bit, junk skipped', () => {
  const dump = [
    '===FILE /tmp/agent-events/100.300.event',
    'session=abc123', 'ts=2027-01-01T00:00:00Z', 'started=2026-12-31T23:00:00Z', 'msg=done rc=0',
    '===FILE /tmp/agent-events/101.400.started',
    'session=abc123', 'started=2026-12-31T23:30:00Z', 'cmd=deploy.sh prod',
    '', 'alive=1',
    '===FILE /tmp/agent-events/102.500.started',
    'session=abc123', 'started=2026-12-31T23:40:00Z', 'cmd=sleepy.sh',
    'alive=0',
    '===FILE /tmp/agent-events/notes.txt',
    'session=zzz',
  ].join('\n');
  const r = jw.parseSpool(dump);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].pid, 300);
  assert.equal(r.events[0].msg, 'done rc=0');
  assert.equal(r.starts.length, 2);
  assert.deepEqual(r.starts.map((s) => s.alive), [true, false]);
  assert.equal(r.starts[0].cmd, 'deploy.sh prod');
  assert.equal(r.starts[0].pid, 400);
});

test('parseSpool: an event without session or ts is dropped', () => {
  const dump = '===FILE /tmp/agent-events/1.300.event\nmsg=half-written\n';
  assert.equal(jw.parseSpool(dump).events.length, 0);
});

test('evaluate: no events, no starts → silence', () => {
  const r = jw.evaluate(inp());
  assert.equal(r.notice, null);
  assert.deepEqual(r.superseded, []);
  assert.deepEqual(r.running, []);
});

// --- completion events: idle at the finish, and quiet for quietMs after it ---

test('evaluate: agent awake at the finish → event superseded, consumed, never pasted', () => {
  // Finished 16 min ago; the agent produced output 1 min ago, so it was awake
  // after the finish (mid-turn, or already told by its own environment).
  const r = jw.evaluate(inp({ agentActiveAt: T0 - MIN, events: [ev()] }));
  assert.equal(r.notice, null);
  assert.deepEqual(r.superseded, [ev().file]);
  assert.deepEqual(r.remove, [ev().file]);
  assert.equal(r.pending.size, 0);
});

test('evaluate: output just before the finish counts as awake at it (margin)', () => {
  const fin = T0 - 10 * MIN;
  const awake = jw.evaluate(inp({ events: [ev({ tsMs: fin })], agentActiveAt: fin - 3000 }));
  assert.deepEqual(awake.superseded, [ev().file]);
  const asleep = jw.evaluate(inp({ events: [ev({ tsMs: fin })], agentActiveAt: fin - 8000 }));
  assert.equal(asleep.notice.kind, 'job-report');
});

test('evaluate: idle since before the finish and quiet for quietMs → delivered at first sight', () => {
  const r = jw.evaluate(inp({ events: [ev()] })); // quiet 20 min, finished 16 min ago
  assert.equal(r.notice.kind, 'job-report');
  assert.deepEqual(r.remove, [ev().file]);
  assert.deepEqual(r.superseded, []);
  assert.equal(r.pending.size, 0);
});

test('evaluate: idle at the finish, quiet period not over → pending; delivered once it is', () => {
  const young = ev({ tsMs: T0 - MIN });
  const p1 = jw.evaluate(inp({ agentActiveAt: T0 - 10 * MIN, events: [young] }));
  assert.equal(p1.notice, null);
  assert.deepEqual(p1.remove, []);                 // stays in the spool
  assert.equal(p1.pending.get(young.file).finishedAt, T0 - MIN); // finish time fixed at first sight
  const p2 = jw.evaluate(inp({ now: T0 + MIN, agentActiveAt: T0 - 10 * MIN, events: [young], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(p2.notice.kind, 'job-report');
  assert.deepEqual(p2.remove, [young.file]);
  assert.equal(p2.pending.size, 0);
});

test('evaluate: idle at the finish but woke within the quiet period → superseded', () => {
  const young = ev({ tsMs: T0 - MIN });
  const p1 = jw.evaluate(inp({ agentActiveAt: T0 - 10 * MIN, events: [young] }));
  assert.equal(p1.pending.size, 1);
  // 30 s later the agent produced output (a self-waking CLI's notice, or a user prompt).
  const p2 = jw.evaluate(inp({ now: T0 + MIN, agentActiveAt: T0 + 30_000, events: [young], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(p2.notice, null);
  assert.deepEqual(p2.superseded, [young.file]);
  assert.deepEqual(p2.remove, [young.file]);
});

test('evaluate: clock skew — a ts before the previous poll is clamped to it; a future ts to now', () => {
  // WSL's clock fell 30 min behind after a host sleep: the file is new (it was
  // not there last poll), so the job finished within the last poll interval.
  const old = ev({ tsMs: T0 - 30 * MIN });
  const r = jw.evaluate(inp({ agentActiveAt: T0 - 5 * MIN, events: [old], prevPollAt: T0 - MIN }));
  assert.equal(r.notice, null);                    // not delivered as if 30 min quiet
  assert.equal(r.pending.get(old.file).finishedAt, T0 - MIN);
  const future = ev({ tsMs: T0 + 10 * MIN });
  const f = jw.evaluate(inp({ agentActiveAt: T0 - 5 * MIN, events: [future] }));
  assert.equal(f.pending.get(future.file).finishedAt, T0);
});

test('evaluate: a job that finished before this window existed waits quietMs from the agent\'s last activity', () => {
  // Resumed session: the window came up 1 min ago, the job finished an hour
  // ago, and the CLI's startup burst (ending 50 s ago) is the only output.
  const old = ev({ tsMs: T0 - HOUR });
  const p1 = jw.evaluate(inp({ windowStartAt: T0 - MIN, agentActiveAt: T0 - 50_000, events: [old] }));
  assert.equal(p1.notice, null);
  assert.deepEqual(p1.superseded, []);             // the startup burst is not "waking to it"
  assert.equal(p1.pending.get(old.file).finishedAt, T0 - 50_000); // pinned to that burst
  // Still quiet 2 min later → delivered.
  const p2 = jw.evaluate(inp({ now: T0 + 2 * MIN, windowStartAt: T0 - MIN, agentActiveAt: T0 - 50_000, events: [old], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(p2.notice.kind, 'job-report');
  // But NEW activity after the pin (a first prompt) supersedes, as for any event.
  const p3 = jw.evaluate(inp({ now: T0 + MIN, windowStartAt: T0 - MIN, agentActiveAt: T0 + 20_000, events: [old], pending: p1.pending, prevPollAt: T0 }));
  assert.deepEqual(p3.superseded, [old.file]);
});

test('evaluate: composing holds a ripe event; a submit afterwards supersedes it', () => {
  const held = jw.evaluate(inp({ composing: true, events: [ev()] }));
  assert.equal(held.notice, null);
  assert.deepEqual(held.remove, []);
  assert.equal(held.pending.get(ev().file).finishedAt, T0 - 16 * MIN);
  // They submitted: the turn's output is agent activity after the finish.
  const after = jw.evaluate(inp({ now: T0 + MIN, agentActiveAt: T0 + 40_000, events: [ev()], pending: held.pending, prevPollAt: T0 }));
  assert.equal(after.notice, null);
  assert.deepEqual(after.superseded, [ev().file]);
});

test('evaluate: composing holds; typing abandoned → delivers once the user is quiet', () => {
  const held = jw.evaluate(inp({ composing: true, events: [ev()] }));
  const after = jw.evaluate(inp({ now: T0 + MIN, events: [ev()], pending: held.pending, prevPollAt: T0 }));
  assert.equal(after.notice.kind, 'job-report');
});

// --- start records: running jobs, and death without a report ---

test('evaluate: a live start record is a running job, kept in the spool', () => {
  const r = jw.evaluate(inp({ starts: [st()] }));
  assert.equal(r.notice, null);
  assert.deepEqual(r.remove, []);
  assert.deepEqual(r.running, [{ cmd: st().cmd, startedMs: st().startedMs }]);
});

test('evaluate: dead start record, agent idle through the quiet period → job-vanished', () => {
  const gone = st({ alive: false });
  const p1 = jw.evaluate(inp({ starts: [gone] }));
  assert.equal(p1.notice, null);                   // death detected now; quiet period starts
  assert.deepEqual(p1.remove, []);
  assert.equal(p1.pending.get(gone.file).finishedAt, T0);
  assert.deepEqual(p1.running, []);
  const p2 = jw.evaluate(inp({ now: T0 + 3 * MIN, agentActiveAt: T0 - 20 * MIN, starts: [gone], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(p2.notice.kind, 'job-vanished');
  assert.match(p2.notice.items[0].command, /watch-build\.sh/);
  assert.deepEqual(p2.remove, [gone.file]);
});

test('evaluate: agent active around the death → start record consumed silently (it likely killed the job)', () => {
  const gone = st({ alive: false });
  const r = jw.evaluate(inp({ agentActiveAt: T0 - 2000, starts: [gone] }));
  assert.equal(r.notice, null);
  assert.deepEqual(r.superseded, [gone.file]);
  assert.deepEqual(r.remove, [gone.file]);
});

test('evaluate: waking within the quiet period supersedes a dead start record', () => {
  const gone = st({ alive: false });
  const p1 = jw.evaluate(inp({ starts: [gone] }));
  assert.equal(p1.pending.size, 1);
  const p2 = jw.evaluate(inp({ now: T0 + MIN, agentActiveAt: T0 + 30_000, starts: [gone], pending: p1.pending, prevPollAt: T0 }));
  assert.deepEqual(p2.superseded, [gone.file]);
});

test('evaluate: an event from the same pid owns the job — the start record is cleaned, never a vanish', () => {
  // The trap wrote the event; its rm of the start record can trail this
  // read. Whatever the liveness bit says, the pair is a normal exit.
  const r = jw.evaluate(inp({ events: [ev()], starts: [st({ alive: false })] }));
  assert.equal(r.notice.kind, 'job-report');
  assert.ok(r.remove.includes(st().file));
  assert.deepEqual(r.superseded, []);
  assert.deepEqual(r.running, []);
});

test('evaluate: pre-window death (job from before a resume) is not superseded by the startup burst', () => {
  // Window up 1 min, startup burst 50 s ago, job started an hour ago and
  // died while no host was watching.
  const gone = st({ alive: false });
  const p1 = jw.evaluate(inp({ windowStartAt: T0 - MIN, agentActiveAt: T0 - 50_000, starts: [gone] }));
  assert.deepEqual(p1.superseded, []);
  assert.equal(p1.pending.size, 1);
  // Still quiet after the period → the vanish notice fires.
  const p2 = jw.evaluate(inp({ now: T0 + 3 * MIN, windowStartAt: T0 - MIN, agentActiveAt: T0 - 50_000, starts: [gone], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(p2.notice.kind, 'job-vanished');
  // NEW activity instead → superseded.
  const p3 = jw.evaluate(inp({ now: T0 + MIN, windowStartAt: T0 - MIN, agentActiveAt: T0 + 20_000, starts: [gone], pending: p1.pending, prevPollAt: T0 }));
  assert.deepEqual(p3.superseded, [gone.file]);
});

test('evaluate: one notice per poll — a ripe report wins; ripe gone records stay pending', () => {
  const gone = st({ alive: false, file: '/tmp/agent-events/2.400.started', pid: 400 });
  const p1 = jw.evaluate(inp({ starts: [gone] }));
  // Both ripen: the event delivers, the gone record waits a poll.
  const p2 = jw.evaluate(inp({ now: T0 + 3 * MIN, events: [ev()], starts: [gone], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(p2.notice.kind, 'job-report');
  assert.ok(!p2.remove.includes(gone.file));
  assert.equal(p2.pending.has(gone.file), true);
  const p3 = jw.evaluate(inp({ now: T0 + 4 * MIN, starts: [gone], pending: p2.pending, prevPollAt: T0 + 3 * MIN }));
  assert.equal(p3.notice.kind, 'job-vanished');
});

test('evaluate: composing holds a ripe vanish notice', () => {
  const gone = st({ alive: false });
  const p1 = jw.evaluate(inp({ starts: [gone] }));
  const held = jw.evaluate(inp({ now: T0 + 3 * MIN, composing: true, starts: [gone], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(held.notice, null);
  assert.equal(held.pending.has(gone.file), true);
});

test('oneLine strips escapes and collapses whitespace', () => {
  assert.equal(jw.oneLine('a\x1b[2Jb\n  c'), 'a[2Jb c');
});
