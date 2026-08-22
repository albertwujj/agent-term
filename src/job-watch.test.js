// node --test src/job-watch.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const jw = require('./job-watch');

// Fixture tree, modeled on the live topology observed on macOS:
//   100 zsh (shell, session leader)
//   200 claude (foreground child of shell)
//   300 labeled job wrapper (own session, child of claude)
//   310 grandchild of the labeled job (its internal sleep)
//   400 caffeinate (claude's keep-awake helper, same pgid, also `+`)
//   500 plain unlabeled background wrapper (child of claude)
const PS = `
  100     1   100 Ss      01:00 /bin/zsh
  200   100   200 S+      59:00 claude
  300   200   300 Ss      10:00 watch-build.sh[sess:abc123] ./scripts/watch-build.sh --url http://j/42/
  310   300   300 S       00:30 sleep 600
  400   200   200 S+      02:00 caffeinate -i -t 300
  500   200   500 Ss      05:00 /bin/zsh -c eval 'make slowtest' < /dev/null
`;
const rows = () => jw.parsePs(PS);
const snap = (r) => ({
  labeled: jw.selectLabeled(r, 'abc123'),
  generic: jw.selectGeneric(r, jw.findAgentPid(r, 100), 'abc123'),
});
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_800_000_000_000;
// One poll's input. agentActiveAt defaults to "quiet for agentQuietFor", the
// window came up a day ago, no previous poll, nothing pending. psOk defaults
// true: a real ps snapshot backs every fixture below; the psOk=false path
// (empty/failed ps read) has its own test.
const inp = (over = {}) => {
  const now = over.now ?? T0;
  const agentQuietFor = over.agentQuietFor ?? 20 * MIN;
  return {
    now, agentQuietFor, agentActiveAt: now - agentQuietFor, composing: false,
    snapshot: snap(rows()), events: [], pending: new Map(), prevPollAt: 0,
    windowStartAt: T0 - 24 * HOUR, quietMs: 2 * MIN, idleMs: 2 * MIN, fuseMs: 15 * MIN, psOk: true,
    ...over,
  };
};
const ev = (over = {}) => ({
  file: '/tmp/agent-events/1.300.event', pid: 300, session: 'abc123',
  tsMs: T0 - 16 * MIN, startedMs: T0 - 60 * MIN,
  msg: 'watch-build.sh change 123: VERDICT=SUCCESS http://j/42/', ...over,
});

test('parseEtime: all ps formats', () => {
  assert.equal(jw.parseEtime('00:30'), 30);
  assert.equal(jw.parseEtime('59:00'), 3540);
  assert.equal(jw.parseEtime('02:03:04'), 7384);
  assert.equal(jw.parseEtime('1-02:03:04'), 93784);
  assert.equal(jw.parseEtime('bogus'), null);
});

test('parsePs keeps full command text', () => {
  const r = rows();
  assert.equal(r.length, 6);
  assert.match(r.find((x) => x.pid === 500).command, /make slowtest/);
});

test('findAgentPid walks the foreground chain, not into helper leaves', () => {
  assert.equal(jw.findAgentPid(rows(), 100), 200);
  const bare = jw.parsePs('  100     1   100 Ss   01:00 /bin/zsh');
  assert.equal(jw.findAgentPid(bare, 100), null);
});

test('selectLabeled: token match, any ancestry, zombies excluded', () => {
  const r = rows();
  assert.deepEqual(jw.selectLabeled(r, 'abc123').map((x) => x.pid), [300]);
  const orphan = jw.parsePs('  300     1   300 Ss   10:00 watch-build.sh[sess:abc123] x');
  assert.deepEqual(jw.selectLabeled(orphan, 'abc123').map((x) => x.pid), [300]);
  const zombie = jw.parsePs('  300     1   300 Z    10:00 watch-build.sh[sess:abc123] x');
  assert.deepEqual(jw.selectLabeled(zombie, 'abc123'), []);
});

test('selectGeneric: agent children minus caffeinate, labeled, grandchildren', () => {
  const s = snap(rows());
  assert.deepEqual(s.generic.map((x) => x.pid), [500]);
});

test('evaluate: agent active + no events → reset, silence', () => {
  const r = jw.evaluate(inp({ agentQuietFor: MIN }), { nudged: true });
  assert.equal(r.state, null);
  assert.equal(r.notice, null);
  assert.deepEqual(r.superseded, []);
});

// --- completion events: idle at the finish, and quiet for quietMs after it ---

test('evaluate: agent awake at the finish → event superseded, consumed, never pasted', () => {
  // Finished 16 min ago; the agent produced output 1 min ago, so it was awake
  // after the finish (mid-turn, or already told by its own environment).
  const r = jw.evaluate(inp({ agentQuietFor: MIN, events: [ev()] }), null);
  assert.equal(r.notice, null);
  assert.deepEqual(r.superseded, [ev().file]);
  assert.deepEqual(r.remove, [ev().file]);
  assert.equal(r.pending.size, 0);
  assert.equal(r.state, null); // vanish window still closed (agent not idle)
});

test('evaluate: output just before the finish counts as awake at it (margin)', () => {
  const fin = T0 - 10 * MIN;
  const awake = jw.evaluate(inp({ events: [ev({ tsMs: fin })], agentActiveAt: fin - 3000 }), null);
  assert.deepEqual(awake.superseded, [ev().file]);
  const asleep = jw.evaluate(inp({ events: [ev({ tsMs: fin })], agentActiveAt: fin - 8000 }), null);
  assert.equal(asleep.notice.kind, 'job-report');
});

test('evaluate: idle since before the finish and quiet for quietMs → delivered at first sight, no fuse', () => {
  const r = jw.evaluate(inp({ events: [ev()] }), null); // quiet 20 min, finished 16 min ago
  assert.equal(r.notice.kind, 'job-report');
  assert.deepEqual(r.remove, [ev().file]);
  assert.deepEqual(r.superseded, []);
  assert.equal(r.pending.size, 0);
});

test('evaluate: idle at the finish, quiet period not over → pending; delivered once it is', () => {
  const young = ev({ tsMs: T0 - MIN });
  const p1 = jw.evaluate(inp({ agentQuietFor: 10 * MIN, events: [young] }), null);
  assert.equal(p1.notice, null);
  assert.deepEqual(p1.remove, []);                 // stays in the spool
  assert.equal(p1.pending.get(young.file).finishedAt, T0 - MIN); // finish time fixed at first sight
  const p2 = jw.evaluate(inp({ now: T0 + MIN, agentQuietFor: 12 * MIN, events: [young], pending: p1.pending, prevPollAt: T0 }), p1.state);
  assert.equal(p2.notice.kind, 'job-report');
  assert.deepEqual(p2.remove, [young.file]);
  assert.equal(p2.pending.size, 0);
});

test('evaluate: idle at the finish but woke within the quiet period → superseded', () => {
  const young = ev({ tsMs: T0 - MIN });
  const p1 = jw.evaluate(inp({ agentQuietFor: 10 * MIN, events: [young] }), null);
  assert.equal(p1.pending.size, 1);
  // 30 s later the agent produced output (a self-waking CLI's notice, or a user prompt).
  const p2 = jw.evaluate(inp({ now: T0 + MIN, agentQuietFor: 30_000, events: [young], pending: p1.pending, prevPollAt: T0 }), null);
  assert.equal(p2.notice, null);
  assert.deepEqual(p2.superseded, [young.file]);
  assert.deepEqual(p2.remove, [young.file]);
});

test('evaluate: clock skew — a ts before the previous poll is clamped to it; a future ts to now', () => {
  // WSL's clock fell 30 min behind after a host sleep: the file is new (it was
  // not there last poll), so the job finished within the last poll interval.
  const old = ev({ tsMs: T0 - 30 * MIN });
  const r = jw.evaluate(inp({ agentQuietFor: 5 * MIN, events: [old], prevPollAt: T0 - MIN }), null);
  assert.equal(r.notice, null);                    // not delivered as if 30 min quiet
  assert.equal(r.pending.get(old.file).finishedAt, T0 - MIN);
  const future = ev({ tsMs: T0 + 10 * MIN });
  const f = jw.evaluate(inp({ agentQuietFor: 5 * MIN, events: [future] }), null);
  assert.equal(f.pending.get(future.file).finishedAt, T0);
});

test('evaluate: a job that finished before this window existed waits quietMs from the agent\'s last activity', () => {
  // Resumed session: the window came up 1 min ago, the job finished an hour
  // ago, and the CLI's startup burst (ending 50 s ago) is the only output.
  const old = ev({ tsMs: T0 - HOUR });
  const p1 = jw.evaluate(inp({ windowStartAt: T0 - MIN, agentActiveAt: T0 - 50_000, agentQuietFor: 50_000, events: [old] }), null);
  assert.equal(p1.notice, null);
  assert.deepEqual(p1.superseded, []);             // the startup burst is not "waking to it"
  assert.equal(p1.pending.get(old.file).finishedAt, T0 - 50_000); // pinned to that burst
  // Still quiet 2 min later → delivered.
  const p2 = jw.evaluate(inp({ now: T0 + 2 * MIN, windowStartAt: T0 - MIN, agentActiveAt: T0 - 50_000, agentQuietFor: 170_000, events: [old], pending: p1.pending, prevPollAt: T0 }), null);
  assert.equal(p2.notice.kind, 'job-report');
  // But NEW activity after the pin (a first prompt) supersedes, as for any event.
  const p3 = jw.evaluate(inp({ now: T0 + MIN, windowStartAt: T0 - MIN, agentActiveAt: T0 + 20_000, agentQuietFor: 40_000, events: [old], pending: p1.pending, prevPollAt: T0 }), null);
  assert.deepEqual(p3.superseded, [old.file]);
});

test('evaluate: composing holds a ripe event; a submit afterwards supersedes it', () => {
  const held = jw.evaluate(inp({ composing: true, events: [ev()] }), null);
  assert.equal(held.notice, null);
  assert.deepEqual(held.remove, []);
  assert.equal(held.pending.get(ev().file).finishedAt, T0 - 16 * MIN);
  // They submitted: the turn's output is agent activity after the finish.
  const after = jw.evaluate(inp({ now: T0 + MIN, agentQuietFor: 20_000, events: [ev()], pending: held.pending, prevPollAt: T0 }), null);
  assert.equal(after.notice, null);
  assert.deepEqual(after.superseded, [ev().file]);
});

test('evaluate: composing holds; typing abandoned → delivers once the user is quiet', () => {
  const held = jw.evaluate(inp({ composing: true, events: [ev()] }), null);
  const after = jw.evaluate(inp({ now: T0 + MIN, agentQuietFor: 21 * MIN, events: [ev()], pending: held.pending, prevPollAt: T0 }), held.state);
  assert.equal(after.notice.kind, 'job-report');
});

// --- vanish tiers ---

test('evaluate: labeled process gone with NO event → job-vanished', () => {
  const after = rows().filter((x) => x.pid !== 300 && x.pid !== 310);
  const r = jw.evaluate(inp({ snapshot: snap(after) }),
    { baselineAt: T0 - 20 * MIN, baseLabeled: new Map([[300, rows().find((x) => x.pid === 300)]]), baseGeneric: new Map(), nudged: false });
  assert.equal(r.notice.kind, 'job-vanished');
  assert.match(r.notice.items[0].command, /watch-build\.sh\[sess:abc123\]/);
});

test('evaluate: an event, pending or delivered, suppresses the vanish notice for its writer pid', () => {
  const after = rows().filter((x) => x.pid !== 300 && x.pid !== 310);
  const young = ev({ tsMs: T0 - MIN });
  const base = { baselineAt: T0 - 20 * MIN, baseLabeled: new Map([[300, rows().find((x) => x.pid === 300)]]), baseGeneric: new Map(), nudged: false };
  // Quiet period not over: nothing injects, nothing is consumed, and pid 300
  // leaves the vanish baseline (its event proved a normal exit).
  const p1 = jw.evaluate(inp({ snapshot: snap(after), events: [young] }), base);
  assert.equal(p1.notice, null);
  assert.deepEqual(p1.remove, []);
  assert.equal(p1.state.baseLabeled.has(300), false);
  // Quiet period over: the event delivers as a report; never a vanish.
  const p2 = jw.evaluate(inp({ now: T0 + MIN, agentQuietFor: 21 * MIN, snapshot: snap(after), events: [young], pending: p1.pending, prevPollAt: T0 }), p1.state);
  assert.equal(p2.notice.kind, 'job-report');
});

test('evaluate: unlabeled agent child gone → job-generic; caffeinate exit is silent', () => {
  const after = rows().filter((x) => x.pid !== 400 && x.pid !== 500);
  const base = snap(rows());
  const r = jw.evaluate(inp({ snapshot: snap(after) }),
    { baselineAt: T0 - 20 * MIN, baseLabeled: new Map(), baseGeneric: new Map(base.generic.map((x) => [x.pid, x])), nudged: false });
  assert.equal(r.notice.kind, 'job-generic');
  assert.equal(r.notice.items.length, 1); // 500 only — caffeinate never entered the baseline
  assert.match(r.notice.items[0].command, /make slowtest/);
});

test('evaluate: grandchild churn never counted; vanish nudges once per window', () => {
  const after = rows().filter((x) => x.pid !== 310);
  const base = snap(rows());
  const st = { baselineAt: T0 - 20 * MIN, baseLabeled: new Map(base.labeled.map((x) => [x.pid, x])), baseGeneric: new Map(base.generic.map((x) => [x.pid, x])), nudged: false };
  const r = jw.evaluate(inp({ snapshot: snap(after) }), st);
  assert.equal(r.notice, null);
  // Now the labeled job dies too — but this window already nudged? It has
  // not (grandchild churn produced no notice), so the vanish still fires.
  const after2 = rows().filter((x) => x.pid !== 310 && x.pid !== 300);
  const r2 = jw.evaluate(inp({ now: T0 + MIN, agentQuietFor: 21 * MIN, snapshot: snap(after2) }), r.state);
  assert.equal(r2.notice.kind, 'job-vanished');
  // And a second vanish in the same window stays silent.
  const after3 = after2.filter((x) => x.pid !== 500);
  const r3 = jw.evaluate(inp({ now: T0 + 2 * MIN, agentQuietFor: 22 * MIN, snapshot: snap(after3) }), r2.state);
  assert.equal(r3.notice, null);
});

test('evaluate: an empty/failed ps snapshot (psOk=false) is not a mass vanish', () => {
  // The labeled job is alive and baselined, agent long quiet — but this
  // poll's ps read came back empty (WSL hiccup / shell pid unresolved).
  const base = { baselineAt: T0 - 20 * MIN, baseLabeled: new Map([[300, rows().find((x) => x.pid === 300)]]), baseGeneric: new Map(), nudged: false };
  const empty = { labeled: [], generic: [] };
  const r = jw.evaluate(inp({ snapshot: empty, psOk: false }), base);
  assert.equal(r.notice, null);        // no false "gone" while the job is alive
  assert.equal(r.state, base);         // baseline preserved for the next poll
  // ps recovers next poll and the job is genuinely gone → vanish fires.
  const after = rows().filter((x) => x.pid !== 300 && x.pid !== 310);
  const r2 = jw.evaluate(inp({ now: T0 + MIN, agentQuietFor: 21 * MIN, snapshot: snap(after) }), r.state);
  assert.equal(r2.notice.kind, 'job-vanished');
});

test('oneLine strips escapes and collapses whitespace', () => {
  assert.equal(jw.oneLine('a\x1b[2Jb\n  c'), 'a[2Jb c');
});
