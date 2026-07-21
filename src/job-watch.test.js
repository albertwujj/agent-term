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
// psOk defaults true: a real ps snapshot backs every fixture below. The
// psOk=false path (empty/failed ps read) has its own test.
const CONSTS = { idleMs: 2 * MIN, fuseMs: 15 * MIN, psOk: true };
const T0 = 1_800_000_000_000;
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

test('evaluate: agent active + no ripe events → reset, silence', () => {
  const r = jw.evaluate({ now: T0, agentQuietFor: MIN, composing: false, snapshot: snap(rows()), events: [], ...CONSTS }, { nudged: true });
  assert.equal(r.state, null);
  assert.equal(r.notice, null);
});

test('evaluate: event delivers even while the agent is mid-turn (rides the CLI queue)', () => {
  const r = jw.evaluate({ now: T0, agentQuietFor: MIN, composing: false, snapshot: snap(rows()), events: [ev()], ...CONSTS }, null);
  assert.equal(r.notice.kind, 'job-report');
  assert.deepEqual(r.remove, [ev().file]);
  assert.equal(r.state, null); // vanish window still closed (agent not idle-gated)
});

test('evaluate: an event delivers with no fuse wait — age AND quiet both under the fuse', () => {
  const young = ev({ tsMs: T0 - 3 * MIN }); // 3 min old; fuse is 15 min
  const r = jw.evaluate({ now: T0, agentQuietFor: 6 * MIN, composing: false, snapshot: snap(rows()), events: [young], ...CONSTS }, null);
  assert.equal(r.notice.kind, 'job-report'); // delivered anyway — completion events aren't fused
  assert.deepEqual(r.remove, [young.file]);
});

test('evaluate: composing holds everything; delivery lands after submit', () => {
  const held = jw.evaluate({ now: T0, agentQuietFor: 20 * MIN, composing: true, snapshot: snap(rows()), events: [ev()], ...CONSTS }, null);
  assert.equal(held.notice, null);
  assert.deepEqual(held.remove, []); // event stays in the spool
  const after = jw.evaluate({ now: T0 + MIN, agentQuietFor: 21 * MIN, composing: false, snapshot: snap(rows()), events: [ev()], ...CONSTS }, held.state);
  assert.equal(after.notice.kind, 'job-report');
});

test('evaluate: labeled process gone with NO event → job-vanished', () => {
  const after = rows().filter((x) => x.pid !== 300 && x.pid !== 310);
  const r = jw.evaluate({ now: T0, agentQuietFor: 20 * MIN, composing: false, snapshot: snap(after), events: [], ...CONSTS },
    { baselineAt: T0 - 20 * MIN, baseLabeled: new Map([[300, rows().find((x) => x.pid === 300)]]), baseGeneric: new Map(), nudged: false });
  assert.equal(r.notice.kind, 'job-vanished');
  assert.match(r.notice.items[0].command, /watch-build\.sh\[sess:abc123\]/);
});

test('evaluate: an event suppresses the vanish notice for its writer pid (held by composing, report after submit)', () => {
  const after = rows().filter((x) => x.pid !== 300 && x.pid !== 310);
  const young = ev({ tsMs: T0 - MIN });
  const base = { baselineAt: T0 - 20 * MIN, baseLabeled: new Map([[300, rows().find((x) => x.pid === 300)]]), baseGeneric: new Map(), nudged: false };
  // While composing: nothing injects, nothing is consumed.
  const held = jw.evaluate({ now: T0, agentQuietFor: 20 * MIN, composing: true, snapshot: snap(after), events: [young], ...CONSTS }, base);
  assert.equal(held.notice, null);
  assert.deepEqual(held.remove, []);
  // After submit: the event delivers as a report; pid 300 is never
  // reported as vanished (its event proved a normal exit).
  const r = jw.evaluate({ now: T0 + MIN, agentQuietFor: 21 * MIN, composing: false, snapshot: snap(after), events: [young], ...CONSTS }, held.state);
  assert.equal(r.notice.kind, 'job-report');
});

test('evaluate: unlabeled agent child gone → job-generic; caffeinate exit is silent', () => {
  const after = rows().filter((x) => x.pid !== 400 && x.pid !== 500);
  const base = snap(rows());
  const r = jw.evaluate({ now: T0, agentQuietFor: 20 * MIN, composing: false, snapshot: snap(after), events: [], ...CONSTS },
    { baselineAt: T0 - 20 * MIN, baseLabeled: new Map(), baseGeneric: new Map(base.generic.map((x) => [x.pid, x])), nudged: false });
  assert.equal(r.notice.kind, 'job-generic');
  assert.equal(r.notice.items.length, 1); // 500 only — caffeinate never entered the baseline
  assert.match(r.notice.items[0].command, /make slowtest/);
});

test('evaluate: grandchild churn never counted; vanish nudges once per window', () => {
  const after = rows().filter((x) => x.pid !== 310);
  const base = snap(rows());
  const st = { baselineAt: T0 - 20 * MIN, baseLabeled: new Map(base.labeled.map((x) => [x.pid, x])), baseGeneric: new Map(base.generic.map((x) => [x.pid, x])), nudged: false };
  const r = jw.evaluate({ now: T0, agentQuietFor: 20 * MIN, composing: false, snapshot: snap(after), events: [], ...CONSTS }, st);
  assert.equal(r.notice, null);
  // Now the labeled job dies too — but this window already nudged? It has
  // not (grandchild churn produced no notice), so the vanish still fires.
  const after2 = rows().filter((x) => x.pid !== 310 && x.pid !== 300);
  const r2 = jw.evaluate({ now: T0 + MIN, agentQuietFor: 21 * MIN, composing: false, snapshot: snap(after2), events: [], ...CONSTS }, r.state);
  assert.equal(r2.notice.kind, 'job-vanished');
  // And a second vanish in the same window stays silent.
  const after3 = after2.filter((x) => x.pid !== 500);
  const r3 = jw.evaluate({ now: T0 + 2 * MIN, agentQuietFor: 22 * MIN, composing: false, snapshot: snap(after3), events: [], ...CONSTS }, r2.state);
  assert.equal(r3.notice, null);
});

test('evaluate: an empty/failed ps snapshot (psOk=false) is not a mass vanish', () => {
  // The labeled job is alive and baselined, agent long quiet — but this
  // poll's ps read came back empty (WSL hiccup / shell pid unresolved).
  const base = { baselineAt: T0 - 20 * MIN, baseLabeled: new Map([[300, rows().find((x) => x.pid === 300)]]), baseGeneric: new Map(), nudged: false };
  const empty = { labeled: [], generic: [] };
  const r = jw.evaluate({ now: T0, agentQuietFor: 20 * MIN, composing: false, snapshot: empty, events: [], ...CONSTS, psOk: false }, base);
  assert.equal(r.notice, null);        // no false "gone" while the job is alive
  assert.equal(r.state, base);         // baseline preserved for the next poll
  // ps recovers next poll and the job is genuinely gone → vanish fires.
  const after = rows().filter((x) => x.pid !== 300 && x.pid !== 310);
  const r2 = jw.evaluate({ now: T0 + MIN, agentQuietFor: 21 * MIN, composing: false, snapshot: snap(after), events: [], ...CONSTS }, r.state);
  assert.equal(r2.notice.kind, 'job-vanished');
});

test('oneLine strips escapes and collapses whitespace', () => {
  assert.equal(jw.oneLine('a\x1b[2Jb\n  c'), 'a[2Jb c');
});
