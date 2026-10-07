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
  assert.deepEqual(r.remove, []);
  assert.deepEqual(r.running, []);
});

// --- completion events: quiet for quietMs past the finish and the last activity ---

test('evaluate: idle since before the finish and quiet for quietMs → delivered at first sight', () => {
  const r = jw.evaluate(inp({ events: [ev()] })); // quiet 20 min, finished 16 min ago
  assert.equal(r.notice.kind, 'job-report');
  assert.deepEqual(r.remove, [ev().file]);
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

test('evaluate: agent busy at the finish → held, never consumed; delivered once quiet for quietMs', () => {
  // Finished 16 min ago, mid-turn: output 1 min ago.
  const p1 = jw.evaluate(inp({ agentActiveAt: T0 - MIN, events: [ev()] }));
  assert.equal(p1.notice, null);
  assert.deepEqual(p1.remove, []);
  assert.equal(p1.pending.size, 1);
  // Still working an hour later: still held.
  const p2 = jw.evaluate(inp({ now: T0 + HOUR, agentActiveAt: T0 + HOUR - 10_000, events: [ev()], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(p2.notice, null);
  assert.equal(p2.pending.size, 1);
  // The turn ended; quiet for quietMs since → delivered.
  const done = T0 + HOUR - 10_000;
  const p3 = jw.evaluate(inp({ now: done + 2 * MIN, agentActiveAt: done, events: [ev()], pending: p2.pending, prevPollAt: T0 + HOUR }));
  assert.equal(p3.notice.kind, 'job-report');
  assert.deepEqual(p3.remove, [ev().file]);
});

test('evaluate: idle at the finish but woke within the quiet period → quiet restarts from that activity', () => {
  const young = ev({ tsMs: T0 - MIN });
  const p1 = jw.evaluate(inp({ agentActiveAt: T0 - 10 * MIN, events: [young] }));
  // 30 s later the agent produced output (a user prompt, or a CLI that tracked the job).
  const p2 = jw.evaluate(inp({ now: T0 + MIN, agentActiveAt: T0 + 30_000, events: [young], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(p2.notice, null);
  assert.deepEqual(p2.remove, []);
  const p3 = jw.evaluate(inp({ now: T0 + 30_000 + 2 * MIN, agentActiveAt: T0 + 30_000, events: [young], pending: p2.pending, prevPollAt: T0 + MIN }));
  assert.equal(p3.notice.kind, 'job-report');
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

test('evaluate: a job that finished before this window existed waits quietMs past the window\'s start and the agent\'s last activity', () => {
  // Resumed session: the window came up 1 min ago, the job finished an hour
  // ago, and the CLI's startup burst (ending 50 s ago) is the only output.
  const old = ev({ tsMs: T0 - HOUR });
  const p1 = jw.evaluate(inp({ windowStartAt: T0 - MIN, agentActiveAt: T0 - 50_000, events: [old] }));
  assert.equal(p1.notice, null);
  assert.equal(p1.pending.get(old.file).finishedAt, T0 - MIN); // counts as finishing when the window came up
  // Still quiet 2 min later → delivered.
  const p2 = jw.evaluate(inp({ now: T0 + 2 * MIN, windowStartAt: T0 - MIN, agentActiveAt: T0 - 50_000, events: [old], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(p2.notice.kind, 'job-report');
});

test('evaluate: composing holds a ripe event; after a submit it waits out the turn', () => {
  const held = jw.evaluate(inp({ composing: true, events: [ev()] }));
  assert.equal(held.notice, null);
  assert.deepEqual(held.remove, []);
  assert.equal(held.pending.get(ev().file).finishedAt, T0 - 16 * MIN);
  // They submitted: the turn's output holds the event...
  const turn = jw.evaluate(inp({ now: T0 + MIN, agentActiveAt: T0 + 40_000, events: [ev()], pending: held.pending, prevPollAt: T0 }));
  assert.equal(turn.notice, null);
  assert.equal(turn.pending.size, 1);
  // ...until the agent has been quiet for quietMs.
  const after = jw.evaluate(inp({ now: T0 + 40_000 + 2 * MIN, agentActiveAt: T0 + 40_000, events: [ev()], pending: turn.pending, prevPollAt: T0 + MIN }));
  assert.equal(after.notice.kind, 'job-report');
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
  assert.equal(p2.notice.items[0].goneMs, T0);    // run length ends at the detection, not the delivery
  assert.deepEqual(p2.remove, [gone.file]);
});

test('evaluate: agent active around the death → the record is held, then reported once quiet', () => {
  const gone = st({ alive: false });
  const p1 = jw.evaluate(inp({ agentActiveAt: T0 - 2000, starts: [gone] }));
  assert.equal(p1.notice, null);
  assert.deepEqual(p1.remove, []);
  const p2 = jw.evaluate(inp({ now: T0 + MIN, agentActiveAt: T0 + 30_000, starts: [gone], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(p2.notice, null);
  const p3 = jw.evaluate(inp({ now: T0 + 30_000 + 2 * MIN, agentActiveAt: T0 + 30_000, starts: [gone], pending: p2.pending, prevPollAt: T0 + MIN }));
  assert.equal(p3.notice.kind, 'job-vanished');
});

test('evaluate: an event from the same pid owns the job — the start record is cleaned, never a vanish', () => {
  // The trap wrote the event; its rm of the start record can trail this
  // read. Whatever the liveness bit says, the pair is a normal exit.
  const r = jw.evaluate(inp({ events: [ev()], starts: [st({ alive: false })] }));
  assert.equal(r.notice.kind, 'job-report');
  assert.ok(r.remove.includes(st().file));
  assert.deepEqual(r.running, []);
});

test('evaluate: pre-window death (job from before a resume) waits out the startup burst', () => {
  // Window up 1 min, startup burst 50 s ago, job started an hour ago and
  // died while no host was watching.
  const gone = st({ alive: false });
  const p1 = jw.evaluate(inp({ windowStartAt: T0 - MIN, agentActiveAt: T0 - 50_000, starts: [gone] }));
  assert.equal(p1.notice, null);
  assert.equal(p1.pending.size, 1);
  const p2 = jw.evaluate(inp({ now: T0 + 3 * MIN, windowStartAt: T0 - MIN, agentActiveAt: T0 - 50_000, starts: [gone], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(p2.notice.kind, 'job-vanished');
  assert.equal(p2.notice.items[0].goneMs, null);   // no host saw it die: run length unknown
});

test('evaluate: a death this window watched for has a known end, even for a job from before it', () => {
  // A poll already completed in this window and saw the process alive; the
  // next one finds it dead, so it died within that interval.
  const gone = st({ alive: false });
  const p1 = jw.evaluate(inp({ windowStartAt: T0 - 10 * MIN, prevPollAt: T0 - MIN, starts: [gone] }));
  const p2 = jw.evaluate(inp({ now: T0 + 3 * MIN, windowStartAt: T0 - 10 * MIN, starts: [gone], pending: p1.pending, prevPollAt: T0 }));
  assert.equal(p2.notice.items[0].goneMs, T0);
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
