const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cliTitleStatus, createTitleActivityTracker, isAgentWorking } = require('../src/cli-title-status');
const { cleanAiTitle, aiTitleDedupeKey, isConversationTitle } = require('../src/ai-title');

test('Codex explicit state distinguishes background waits from user-input waits', () => {
  for (const status of ['Ready', 'Starting', 'Thinking', 'Working', 'Waiting',
    '[ ! ] Action Required', '[ . ] Action Required']) {
    const title = `${status} | codex | Investigate A | B ⠸ ⠋`;
    assert.equal(cliTitleStatus(title, 'codex').working,
      !['Ready', '[ ! ] Action Required', '[ . ] Action Required'].includes(status));
    assert.equal(cleanAiTitle(title, 'codex'), 'Investigate A | B');
    assert.equal(isConversationTitle(title, 'codex'), true);
    assert.equal(aiTitleDedupeKey(title, 'codex'), 'investigate a | b');
  }
  assert.equal(cliTitleStatus('Ready | codex', 'codex').working, false);
  for (const title of ['Ready | codex', 'Ready | codex | 01a072c1-544f-7153-9da1-a39c29e6e9b9 ⠸']) {
    assert.equal(isConversationTitle(title, 'codex'), false);
  }
  // The old trailing spinner means title generation, not necessarily a turn.
  for (const title of ['codex | Ready', 'codex | Working | a topic', 'codex | topic ⠸',
    'Compacting | codex | topic', 'Working on the project']) {
    assert.equal(cliTitleStatus(title, 'codex').working, null, title);
  }
});

test('Claude recognizes its title markers, including current half-circle busy frames', () => {
  for (const marker of ['◐', '◑', '⠋', '⠙']) {
    assert.equal(cliTitleStatus(`${marker} Fix activity`, 'claude').working, true);
    assert.equal(cleanAiTitle(`${marker} Fix activity`, 'claude'), 'Fix activity');
  }
  for (const marker of ['✳', '✱']) {
    assert.equal(cliTitleStatus(`${marker} Fix activity`, 'claude').working, false);
  }
  for (const title of ['Claude Code', 'Fix activity', '* Fix activity', 'Working', '✳']) {
    assert.equal(cliTitleStatus(title, 'claude').working, null, title);
  }
});

test('Cursor optional status suffixes preserve names and separate user waits from work', () => {
  for (const suffix of ['✅ Ready', '❓ Waiting for you', '🔐 Waiting for confirmation']) {
    const title = `Working - Fix activity - ${suffix}`;
    assert.equal(cliTitleStatus(title, 'agent').working, false, suffix);
    assert.equal(cleanAiTitle(title, 'agent'), 'Working - Fix activity');
  }
  for (const suffix of ['📤 Moving to cloud', '📂 Loading conversation', '🔄 Reconnecting',
    '⌨️ Running shell command', '🧭 Planning', '⏳ Working ···', '⏳ Working .··',
    '⏳ Working ..·', '⏳ Working ...', '📋 Queued', '📝 Reviewing changes']) {
    assert.equal(cliTitleStatus(`Fix activity - ${suffix}`, 'agent').working, true, suffix);
    assert.equal(aiTitleDedupeKey(`Fix activity - ${suffix}`, 'agent'), 'fix activity');
  }
  assert.equal(isConversationTitle('Cursor Agent - ✅ Ready', 'agent'), false);
  for (const title of ['Working', 'Ready', 'Fix Waiting for you', 'Fix activity', 'Fix - New status',
    'Fix - Ready', 'Fix - Waiting for you', 'Fix - Working', 'Fix - ✅ Working']) {
    assert.equal(cliTitleStatus(title, 'agent').working, null, title);
  }
});

test('unsupported title formats, old Claude spinners, multiplexers and new runs retain fallback', () => {
  const tracker = createTitleActivityTracker();
  tracker.update('✳ topic', 'claude');
  assert.equal(tracker.working, null); // could be an older star-only busy spinner
  tracker.update('◐ topic', 'claude');
  tracker.update('✳ topic', 'claude');
  assert.equal(tracker.working, false);
  tracker.update('unrecognized', 'claude');
  assert.equal(tracker.working, null);
  tracker.reset();
  tracker.update('✳ topic', 'claude');
  assert.equal(tracker.working, null);
  tracker.update('Ready | codex | topic', 'codex');
  assert.equal(tracker.working, false);
  tracker.update(null, 'codex');
  assert.equal(tracker.working, null);
  tracker.update('✳ topic', 'claude');
  assert.equal(tracker.working, null);
  const mux = createTitleActivityTracker({ multiplexer: true });
  mux.update('◐ topic', 'claude');
  mux.update('✳ topic', 'claude');
  assert.equal(mux.working, null);
});

test('Copilot intent/name ambiguity retains fallback, including its turn-start brand', () => {
  for (const title of ['GitHub Copilot', 'Thinking - GitHub Copilot', 'Fix activity - GitHub Copilot',
    'Fix activity - Thinking - GitHub Copilot']) {
    assert.equal(cliTitleStatus(title, 'copilot').working, null);
  }
  assert.equal(cliTitleStatus('Ready | codex | topic', 'copilot').working, null);
  assert.equal(cliTitleStatus(null, 'codex').working, null);
});

test('explicit idle veto is additive to all existing timing and typing rules', () => {
  const state = { iconLocked: true, now: 100_000, lastPtyOutputTime: 99_999, lastTypingTime: 0 };
  // A sparkle can produce bytes for hours; explicit Ready still wins.
  for (let now = state.now; now < state.now + 3_600_000; now += 1000) {
    assert.equal(isAgentWorking({ ...state, now, lastPtyOutputTime: now, titleWorking: false }), false);
  }
  for (const titleWorking of [null, true]) {
    assert.equal(isAgentWorking({ ...state, titleWorking }), true);
    assert.equal(isAgentWorking({ ...state, titleWorking, iconLocked: false }), false);
    assert.equal(isAgentWorking({ ...state, titleWorking, lastTypingTime: state.now - 4999 }), false);
    assert.equal(isAgentWorking({ ...state, titleWorking, lastPtyOutputTime: state.now - 5000 }), false);
  }
});
