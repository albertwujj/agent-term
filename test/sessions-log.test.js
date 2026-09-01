// Tests for src/sessions-log.js — uses a temp directory as the userDataDir.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const log = require('../src/sessions-log');

let testsPassed = 0, testsFailed = 0;
let tmpDir = null;
const FROZEN_BOOT = 1700000000000;
const FROZEN_GUI = 'ws:123:Mon Jan  1 00:00:00 2026';

function freshDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-sessions-test-'));
  return tmpDir;
}

function cleanup() {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    tmpDir = null;
  }
}

function test(name, fn) {
  freshDir();
  try {
    fn(tmpDir);
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
  } finally {
    cleanup();
  }
}

console.log('sessions-log');

// ---- log basics ----

test('appendEvent + readLog round-trips', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 24 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  const events = log.readLog(dir);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].e, 'started');
  assert.strictEqual(events[0].id, 1);
  assert.ok(typeof events[0].t === 'number');
});

test('listSessions folds events by id', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 0 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Fix the auth bug' });
  log.appendEvent(dir, { e: 'title',   id: 1, title: 'Old title' });
  log.appendEvent(dir, { e: 'title',   id: 1, title: 'New title' });
  log.appendEvent(dir, { e: 'started', id: 2, hue: 24 });

  const sessions = log.listSessions(dir);
  assert.strictEqual(sessions.length, 2);
  const s1 = sessions.find(s => s.id === 1);
  assert.strictEqual(s1.cli, 'claude');
  assert.strictEqual(s1.title, 'Old title');         // identity: first after the prompt
  assert.strictEqual(s1.lastTitle, 'New title');     // drift: last-wins
  assert.strictEqual(s1.prompt, 'Fix the auth bug');
  assert.strictEqual(s1.closedAt, null);
});

test('listSessions folds cwd last-wins, defaults null', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 0 });
  log.appendEvent(dir, { e: 'cwd',     id: 1, cwd: '/home/u/old-repo' });
  log.appendEvent(dir, { e: 'cwd',     id: 1, cwd: '/home/u/repo' });
  log.appendEvent(dir, { e: 'started', id: 2, hue: 24 });
  const sessions = log.listSessions(dir);
  assert.strictEqual(sessions.find(s => s.id === 1).cwd, '/home/u/repo');
  assert.strictEqual(sessions.find(s => s.id === 2).cwd, null);
});

test('closed event marks session closed', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 0 });
  log.appendEvent(dir, { e: 'closed',  id: 1 });
  const s = log.listSessions(dir).find(x => x.id === 1);
  assert.ok(s.closedAt > 0);
});

test('listSessions: the identity title is the first title after the first prompt', (dir) => {
  // A pre-prompt title is the CLI's boot banner, never the identity.
  log.appendEvent(dir, { e: 'started', id: 1, hue: 0 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'title',   id: 1, title: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Investigate timeout in worker pool' });
  // The CLI names the conversation; later titles drift.
  log.appendEvent(dir, { e: 'title',   id: 1, title: 'Investigate timeout' });
  log.appendEvent(dir, { e: 'title',   id: 1, title: 'Looking at the locking code' });

  const s = log.listSessions(dir).find(x => x.id === 1);
  assert.strictEqual(s.title, 'Investigate timeout');
  assert.strictEqual(s.lastTitle, 'Looking at the locking code');
});

test('listSessions: titles before any prompt never become the identity title', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 0 });
  log.appendEvent(dir, { e: 'title',   id: 1, title: 'Drifting title' });
  log.appendEvent(dir, { e: 'title',   id: 1, title: 'Another' });
  const s = log.listSessions(dir).find(x => x.id === 1);
  assert.strictEqual(s.title, null);
  assert.strictEqual(s.lastTitle, 'Another');
});

test('listSessions: a resume that ran another conversation leaves the identity title alone', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 0 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Demote the web viewer' });
  log.appendEvent(dir, { e: 'title',   id: 1, title: 'Web viewer invocation changes' });
  // Resume: the CLI banner, then the title of whichever conversation the
  // user picked in the CLI's own dialog (here, a different one).
  log.appendEvent(dir, { e: 'title',   id: 1, title: '✳ Claude Code' });
  log.appendEvent(dir, { e: 'title',   id: 1, title: 'Resume hint UI visibility' });
  const s = log.listSessions(dir).find(x => x.id === 1);
  assert.strictEqual(s.title, 'Web viewer invocation changes');
  assert.strictEqual(s.lastTitle, 'Resume hint UI visibility');
});

test('readLog handles malformed lines without crashing', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1 });
  // Inject garbage manually
  fs.appendFileSync(path.join(dir, 'sessions.jsonl'), 'not json\n{"e":"closed","id":1}\n');
  const events = log.readLog(dir);
  // started + closed pass; "not json" line is silently dropped
  assert.strictEqual(events.length, 2);
});

test('listSessions on empty/missing log returns []', (dir) => {
  assert.deepStrictEqual(log.listSessions(dir), []);
});

// ---- active files ----

test('writeActiveFile + readActiveFile round-trips', (dir) => {
  log.writeActiveFile(dir, 7, { pid: 12345, bootTime: FROZEN_BOOT });
  const r = log.readActiveFile(dir, 7);
  assert.deepStrictEqual(r, { pid: 12345, bootTime: FROZEN_BOOT });
});

test('deleteActiveFile removes the file', (dir) => {
  log.writeActiveFile(dir, 7, { pid: 1, bootTime: FROZEN_BOOT });
  log.deleteActiveFile(dir, 7);
  assert.strictEqual(log.readActiveFile(dir, 7), null);
});

test('isSessionActive: stale bootTime is not active', () => {
  const rec = { pid: process.pid, bootTime: FROZEN_BOOT };
  assert.strictEqual(log.isSessionActive(rec, { bootTime: FROZEN_BOOT + 60 * 60_000 }), false);
});

// The stamp is derived from os.uptime(), which drifts against the wall clock on
// Windows (sleep, clock resync). Live windows restamp on every heartbeat, so a
// stamp a refresh interval old must still read as this boot.
test('isSessionActive: a drifted bootTime within tolerance is still active', () => {
  const rec = { pid: process.pid, bootTime: FROZEN_BOOT - 60_000 };
  assert.strictEqual(log.isSessionActive(rec, { bootTime: FROZEN_BOOT }), true);
});

test('isSessionActive: drift past the tolerance is not active', () => {
  const rec = { pid: process.pid, bootTime: FROZEN_BOOT - log.BOOT_TIME_TOLERANCE_MS - 1 };
  assert.strictEqual(log.isSessionActive(rec, { bootTime: FROZEN_BOOT }), false);
});

test('isSessionActive: matching boot + live pid is active', () => {
  const rec = { pid: process.pid, bootTime: FROZEN_BOOT };
  assert.strictEqual(log.isSessionActive(rec, { bootTime: FROZEN_BOOT }), true);
});

test('isSessionActive: matching boot + dead pid is not active', () => {
  // PID 1 is init/launchd which is alive — pick something almost guaranteed dead.
  // Using a very high pid that won't exist on a developer machine.
  const rec = { pid: 999999, bootTime: FROZEN_BOOT };
  assert.strictEqual(log.isSessionActive(rec, { bootTime: FROZEN_BOOT }), false);
});

// ---- compositor-session guard (macOS WindowServer crash leaves a live pid
// whose window is gone; see src/gui-session.js) ----

test('isSessionActive: matching guiSession + live pid is active', () => {
  const rec = { pid: process.pid, bootTime: FROZEN_BOOT, guiSession: FROZEN_GUI };
  assert.strictEqual(log.isSessionActive(rec, { bootTime: FROZEN_BOOT, guiSession: FROZEN_GUI }), true);
});

test('isSessionActive: stale guiSession is not active even with a live pid', () => {
  const rec = { pid: process.pid, bootTime: FROZEN_BOOT, guiSession: FROZEN_GUI };
  assert.strictEqual(log.isSessionActive(rec, { bootTime: FROZEN_BOOT, guiSession: 'ws:99:later' }), false);
});

test('isSessionActive: unstamped record falls through to the pid check', () => {
  // Written by an older build — never reap on a comparison we cannot make.
  const rec = { pid: process.pid, bootTime: FROZEN_BOOT };
  assert.strictEqual(log.isSessionActive(rec, { bootTime: FROZEN_BOOT, guiSession: FROZEN_GUI }), true);
});

test('isSessionActive: unstamped platform ignores the record stamp', () => {
  // Windows/Linux: currentGuiSession() is null, so liveness stays pid + boot.
  const rec = { pid: process.pid, bootTime: FROZEN_BOOT, guiSession: FROZEN_GUI };
  assert.strictEqual(log.isSessionActive(rec, { bootTime: FROZEN_BOOT, guiSession: null }), true);
});

test('gcActiveFiles cleans up stale entries', (dir) => {
  // alive (this process) + previous-boot dead pid + dead-pid + live pid whose
  // window died with a previous compositor session
  log.writeActiveFile(dir, 1, { pid: process.pid, bootTime: FROZEN_BOOT, guiSession: FROZEN_GUI });
  log.writeActiveFile(dir, 2, { pid: 999998,      bootTime: FROZEN_BOOT - 60 * 60_000 });
  log.writeActiveFile(dir, 3, { pid: 999999,      bootTime: FROZEN_BOOT });
  log.writeActiveFile(dir, 4, { pid: process.pid, bootTime: FROZEN_BOOT, guiSession: 'ws:1:earlier' });
  log.gcActiveFiles(dir, { bootTime: FROZEN_BOOT, guiSession: FROZEN_GUI });
  assert.deepStrictEqual(log.listActiveIds(dir).sort(), [1]);
});

// A boot-stamp mismatch is not evidence the window is gone, and deleting is
// destructive: the owner only merges into an existing file. Windows drift used
// to make a starting window reap every other live window this way.
test('gcActiveFiles keeps a live pid whose boot stamp drifted', (dir) => {
  log.writeActiveFile(dir, 1, { pid: process.pid, bootTime: FROZEN_BOOT - 60 * 60_000 });
  log.gcActiveFiles(dir, { bootTime: FROZEN_BOOT, guiSession: null });
  assert.deepStrictEqual(log.listActiveIds(dir), [1]);
});

// ---- pending recovery ----

test('initPendingRecoveryIfNeeded picks up orphans on first init', (dir) => {
  // Two sessions: one with full chain (started+cli+prompt, no closed),
  // one closed cleanly. Only the first should be pending.
  log.appendEvent(dir, { e: 'started', id: 1, hue: 0 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Investigate the timeout' });
  log.appendEvent(dir, { e: 'started', id: 2, hue: 24 });
  log.appendEvent(dir, { e: 'cli',     id: 2, cli: 'codex' });
  log.appendEvent(dir, { e: 'prompt',  id: 2, prompt: 'Refactor middleware' });
  log.appendEvent(dir, { e: 'closed',  id: 2 });

  const snap = log.initPendingRecoveryIfNeeded(dir, { bootTime: FROZEN_BOOT });
  assert.strictEqual(snap.bootTime, FROZEN_BOOT);
  assert.deepStrictEqual(snap.pendingIds, [1]);
});

test('initPendingRecoveryIfNeeded: active sessions are excluded', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Long enough prompt now' });
  log.writeActiveFile(dir, 1, { pid: process.pid, bootTime: FROZEN_BOOT });

  const snap = log.initPendingRecoveryIfNeeded(dir, { bootTime: FROZEN_BOOT });
  assert.deepStrictEqual(snap.pendingIds, []);
});

test('initPendingRecoveryIfNeeded: shell-only sessions (no cli) excluded', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1 });
  // No cli, no prompt — shell-only
  const snap = log.initPendingRecoveryIfNeeded(dir, { bootTime: FROZEN_BOOT });
  assert.deepStrictEqual(snap.pendingIds, []);
});

test('initPendingRecoveryIfNeeded: same boot returns existing snapshot unchanged', (dir) => {
  log.writePendingRecovery(dir, { bootTime: FROZEN_BOOT, pendingIds: [99] });
  // No log entries at all; existing snapshot should be returned intact.
  const snap = log.initPendingRecoveryIfNeeded(dir, { bootTime: FROZEN_BOOT });
  assert.deepStrictEqual(snap.pendingIds, [99]);
});

test('initPendingRecoveryIfNeeded: a drifted stamp keeps the snapshot', (dir) => {
  // Same boot, Windows-drifted stamp: recomputing here would resurrect
  // already-resumed sessions as pending.
  log.writePendingRecovery(dir, { bootTime: FROZEN_BOOT - 60_000, pendingIds: [99] });
  const snap = log.initPendingRecoveryIfNeeded(dir, { bootTime: FROZEN_BOOT });
  assert.deepStrictEqual(snap.pendingIds, [99]);
});

test('initPendingRecoveryIfNeeded: different boot recomputes', (dir) => {
  log.writePendingRecovery(dir, { bootTime: FROZEN_BOOT - 60 * 60_000, pendingIds: [99] });
  log.appendEvent(dir, { e: 'started', id: 7 });
  log.appendEvent(dir, { e: 'cli',     id: 7, cli: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 7, prompt: 'New session prompt' });
  const snap = log.initPendingRecoveryIfNeeded(dir, { bootTime: FROZEN_BOOT });
  assert.strictEqual(snap.bootTime, FROZEN_BOOT);
  assert.deepStrictEqual(snap.pendingIds, [7]);
});

test('removeFromPendingRecovery decrements the set', (dir) => {
  log.writePendingRecovery(dir, { bootTime: FROZEN_BOOT, pendingIds: [1, 2, 3] });
  log.removeFromPendingRecovery(dir, 2);
  const snap = log.readPendingRecovery(dir);
  assert.deepStrictEqual(snap.pendingIds, [1, 3]);
});

test('removeFromPendingRecovery on missing id is a no-op', (dir) => {
  log.writePendingRecovery(dir, { bootTime: FROZEN_BOOT, pendingIds: [1, 2, 3] });
  log.removeFromPendingRecovery(dir, 99);
  assert.deepStrictEqual(log.readPendingRecovery(dir).pendingIds, [1, 2, 3]);
});

// ---- public picker queries ----

test('autoRecoveryList returns full session objects, newest first', (dir) => {
  // Two pending, one closed. Manually order timestamps so id 2 is newer.
  log.appendEvent(dir, { e: 'started', id: 1 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Fix the auth bug now' });
  // sleep one ms to ensure ordering
  const wait = Date.now() + 2; while (Date.now() < wait) {}
  log.appendEvent(dir, { e: 'started', id: 2 });
  log.appendEvent(dir, { e: 'cli',     id: 2, cli: 'codex' });
  log.appendEvent(dir, { e: 'prompt',  id: 2, prompt: 'Investigate the timeout' });

  const list = log.autoRecoveryList(dir, { bootTime: FROZEN_BOOT });
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, 2);   // newer first
  assert.strictEqual(list[1].id, 1);
  assert.strictEqual(list[0].cli, 'codex');
});

test('menuList includes closed and active with isActive flag', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Fix the auth bug now' });
  log.appendEvent(dir, { e: 'closed',  id: 1 });

  log.appendEvent(dir, { e: 'started', id: 2 });
  log.appendEvent(dir, { e: 'cli',     id: 2, cli: 'codex' });
  log.appendEvent(dir, { e: 'prompt',  id: 2, prompt: 'Investigate the timeout' });
  log.writeActiveFile(dir, 2, { pid: process.pid, bootTime: FROZEN_BOOT });

  const list = log.menuList(dir, { bootTime: FROZEN_BOOT });
  assert.strictEqual(list.length, 2);
  const s1 = list.find(s => s.id === 1);
  const s2 = list.find(s => s.id === 2);
  assert.strictEqual(s1.isActive, false);
  assert.strictEqual(s2.isActive, true);
});

test('menuList excludes sessions without a captured prompt', (dir) => {
  // Opening claude and exiting without typing — has cli + title but no prompt.
  // "Start new claude session" already covers fresh launches; resume is for
  // sessions with content.
  log.appendEvent(dir, { e: 'started', id: 1, hue: 0 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'title',   id: 1, title: '✳ Claude Code' });
  log.appendEvent(dir, { e: 'closed',  id: 1 });

  const list = log.menuList(dir, { bootTime: FROZEN_BOOT });
  assert.strictEqual(list.length, 0);
});

test('menuList excludes sessions without a recorded cli (shell-only / non-CLI)', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 0 });
  log.appendEvent(dir, { e: 'title',   id: 1, title: 'agent-term' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'this should not show' });
  log.appendEvent(dir, { e: 'closed',  id: 1 });

  const list = log.menuList(dir, { bootTime: FROZEN_BOOT });
  assert.strictEqual(list.length, 0);
});

test('menuList drops sessions older than the 4-week window', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Old prompt long enough' });
  // Manually rewrite the file with very old timestamps (60 days > the 28-day window)
  const file = path.join(dir, 'sessions.jsonl');
  const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
    const ev = JSON.parse(l);
    ev.t = old;
    return JSON.stringify(ev);
  }).join('\n') + '\n';
  fs.writeFileSync(file, lines);

  const list = log.menuList(dir, { bootTime: FROZEN_BOOT });
  assert.strictEqual(list.length, 0);
});

// ---- compaction ----

test('compactSessionsLog drops events older than the window', (dir) => {
  // Two old events + two recent ones; only recent should survive.
  log.appendEvent(dir, { e: 'started', id: 1, hue: 0 });
  log.appendEvent(dir, { e: 'closed',  id: 1 });
  log.appendEvent(dir, { e: 'started', id: 2, hue: 24 });
  log.appendEvent(dir, { e: 'closed',  id: 2 });

  // Backdate the first session's events to 60 days ago.
  const file = path.join(dir, 'sessions.jsonl');
  const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => {
    const ev = JSON.parse(l);
    if (ev.id === 1) ev.t = old;
    return JSON.stringify(ev);
  }).join('\n') + '\n';
  fs.writeFileSync(file, lines);

  const dropped = log.compactSessionsLog(dir);
  assert.strictEqual(dropped, 2);
  const remaining = log.readLog(dir);
  assert.strictEqual(remaining.length, 2);
  assert.ok(remaining.every(ev => ev.id === 2));
});

test('compactSessionsLog is a no-op when nothing exceeds the window', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 0 });
  log.appendEvent(dir, { e: 'closed',  id: 1 });
  const before = fs.readFileSync(path.join(dir, 'sessions.jsonl'), 'utf8');
  const dropped = log.compactSessionsLog(dir);
  assert.strictEqual(dropped, 0);
  const after = fs.readFileSync(path.join(dir, 'sessions.jsonl'), 'utf8');
  assert.strictEqual(after, before);
});

test('compactSessionsLog with empty log returns 0', (dir) => {
  const dropped = log.compactSessionsLog(dir);
  assert.strictEqual(dropped, 0);
});

test('compactSessionsLog respects custom maxAgeMs override', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 0 });
  // Backdate to 2 hours ago.
  const file = path.join(dir, 'sessions.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => {
    const ev = JSON.parse(l);
    ev.t = Date.now() - 2 * 60 * 60 * 1000;
    return JSON.stringify(ev);
  }).join('\n') + '\n';
  fs.writeFileSync(file, lines);

  // 1-hour window drops the 2-hour-old event.
  const dropped = log.compactSessionsLog(dir, { maxAgeMs: 60 * 60 * 1000 });
  assert.strictEqual(dropped, 1);
  assert.strictEqual(log.readLog(dir).length, 0);
});

test('currentBootTime is stable within a process', () => {
  const a = log.currentBootTime();
  const b = log.currentBootTime();
  assert.strictEqual(a, b);   // rounded to nearest minute
});

// ---- getRecentPromptsForSession ----

test('getRecentPromptsForSession returns chronological prompt events for a session', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 24 });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'First prompt for the session' });
  log.appendEvent(dir, { e: 'title',   id: 1, title: 'Some title' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Second prompt later on' });
  log.appendEvent(dir, { e: 'prompt',  id: 2, prompt: 'A different session prompt' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Third prompt much later' });

  const prompts = log.getRecentPromptsForSession(dir, 1);
  assert.strictEqual(prompts.length, 3);
  assert.deepStrictEqual(prompts.map(p => p.prompt), [
    'First prompt for the session',
    'Second prompt later on',
    'Third prompt much later',
  ]);
});

test('getRecentPromptsForSession caps by total chars, dropping oldest', (dir) => {
  log.appendEvent(dir, { e: 'prompt', id: 1, prompt: 'a'.repeat(100) });
  log.appendEvent(dir, { e: 'prompt', id: 1, prompt: 'b'.repeat(100) });
  log.appendEvent(dir, { e: 'prompt', id: 1, prompt: 'c'.repeat(100) });

  const prompts = log.getRecentPromptsForSession(dir, 1, { maxChars: 250 });
  // Total before cap = 300; after dropping oldest (a's) = 200, fits under 250.
  assert.deepStrictEqual(prompts.map(p => p.prompt[0]), ['b', 'c']);
});

test('getRecentPromptsForSession returns empty list when no prompts logged', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  assert.deepStrictEqual(log.getRecentPromptsForSession(dir, 1), []);
});

test('getRecentPromptsForSession keeps newest entry even if it alone exceeds the cap', (dir) => {
  log.appendEvent(dir, { e: 'prompt', id: 1, prompt: 'a'.repeat(100) });
  log.appendEvent(dir, { e: 'prompt', id: 1, prompt: 'huge' + 'b'.repeat(1000) });

  const prompts = log.getRecentPromptsForSession(dir, 1, { maxChars: 50 });
  // Cap can't drop everything — keep the newest no matter what.
  assert.strictEqual(prompts.length, 1);
  assert.ok(prompts[0].prompt.startsWith('huge'));
});

// ---- searchHiddenPromptMatches ----

test('searchHiddenPromptMatches excludes the visible first prompt', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 24 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'billing webhook first prompt' });

  const matches = log.searchHiddenPromptMatches(dir, 'billing webhook');
  assert.deepStrictEqual(matches, []);
});

test('searchHiddenPromptMatches returns follow-up prompt matches grouped by session', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 24 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Investigate checkout retries' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'webhook retries fail for billing after 409' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'retry billing webhook from dead-letter queue' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'billing only follow up' });

  const matches = log.searchHiddenPromptMatches(dir, 'billing webhook');
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].id, 1);
  assert.strictEqual(matches[0].matchCount, 2);
  assert.deepStrictEqual(matches[0].matches.map(m => m.text), [
    'webhook retries fail for billing after 409',
    'retry billing webhook from dead-letter queue',
  ]);
});

test('searchHiddenPromptMatches requires all words within the same hidden prompt', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 24 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Initial prompt for this session' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'billing investigation follow up' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'webhook retry follow up' });

  const matches = log.searchHiddenPromptMatches(dir, 'billing webhook');
  assert.deepStrictEqual(matches, []);
});

test('searchHiddenPromptMatches counts each matching hidden prompt once', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 24 });
  log.appendEvent(dir, { e: 'cli',     id: 1, cli: 'claude' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'Initial prompt for this session' });
  log.appendEvent(dir, { e: 'prompt',  id: 1, prompt: 'billing webhook then billing webhook again' });

  const matches = log.searchHiddenPromptMatches(dir, 'billing webhook');
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].matchCount, 1);
  assert.deepStrictEqual(
    matches[0].matches[0].ranges.map(r => matches[0].matches[0].text.slice(r.start, r.end)),
    ['billing', 'webhook', 'billing', 'webhook'],
  );
});

test('listSessions folds the session token from started and token events', (dir) => {
  log.appendEvent(dir, { e: 'started', id: 1, hue: 24, token: 'aaaa11' });
  log.appendEvent(dir, { e: 'started', id: 2, hue: 48 });
  log.appendEvent(dir, { e: 'token', id: 2, token: 'bbbb22' });
  const byId = new Map(log.listSessions(dir).map(s => [s.id, s]));
  assert.strictEqual(byId.get(1).token, 'aaaa11');
  assert.strictEqual(byId.get(2).token, 'bbbb22');
});

test('findActiveByToken returns the active record carrying the token', (dir) => {
  log.writeActiveFile(dir, 3, { pid: process.pid, bootTime: FROZEN_BOOT, token: 'cccc33', lastWorkingAt: 5, hue: 200 });
  log.writeActiveFile(dir, 4, { pid: process.pid, bootTime: FROZEN_BOOT });
  const rec = log.findActiveByToken(dir, 'cccc33');
  assert.strictEqual(rec.id, 3);
  assert.strictEqual(rec.hue, 200);
  assert.strictEqual(log.findActiveByToken(dir, 'nope'), null);
  assert.strictEqual(log.findActiveByToken(dir, ''), null);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
