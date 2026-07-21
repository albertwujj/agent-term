const assert = require('assert');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});

global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
window.pty = { pickerBringForward: () => {} };

const { createPicker } = require('../src/sessions-picker');

let testsPassed = 0;
let testsFailed = 0;

function resetDom() {
  document.body.innerHTML = '';
}

async function test(name, fn) {
  resetDom();
  try { await fn(); testsPassed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  } finally {
    resetDom();
  }
}

function key(el, keyName) {
  const event = new window.KeyboardEvent('keydown', {
    key: keyName,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(event);
  return event;
}

function input(el, value) {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function wait(ms = 0) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('sessions-picker');

(async () => {

await test('renders deduped AI title segments once', () => {
  const picker = createPicker({
    sessions: [{
      id: 1,
      cli: 'claude',
      title: '✳ Claude Code · Debug failing build at Jenkins pipeline · Debug failing build at Jenkins pipeline',
      prompt: 'and other docs in ai/',
      lastEventAt: Date.now(),
    }],
    onPick: () => {},
    onStartNew: () => {},
    onClose: () => {},
  });

  const titleLines = [...document.querySelectorAll('.at-picker-title-line')];
  assert.strictEqual(titleLines.length, 1);
  assert.strictEqual(titleLines[0].textContent.trim(), 'Debug failing build at Jenkins pipeline');
  assert.ok(!titleLines[0].textContent.includes('Claude Code'));

  picker.destroy();
});

await test('suppresses spinner-only app titles', () => {
  const picker = createPicker({
    sessions: [{
      id: 2,
      cli: 'codex',
      title: '⠦ agent-term',
      prompt: 'there should be code to dedup messages from ai',
      lastEventAt: Date.now(),
    }],
    onPick: () => {},
    onStartNew: () => {},
    onClose: () => {},
  });

  assert.strictEqual(document.querySelectorAll('.at-picker-title-line').length, 0);

  picker.destroy();
});

await test('Delete hides the selected past session for this picker instance', () => {
  const picker = createPicker({
    sessions: [
      { id: 1, cli: 'claude', prompt: 'first', lastEventAt: 2 },
      { id: 2, cli: 'codex', prompt: 'second', lastEventAt: 1 },
    ],
    onPick: () => {},
    onStartNew: () => {},
    onClose: () => {},
  });
  const el = document.querySelector('.at-picker-input');

  key(el, 'ArrowDown');
  key(el, 'Delete');

  assert.deepStrictEqual(picker._state().visibleRows.map(s => s.id), [2]);
  assert.deepStrictEqual([...picker._state().dismissedIds], [1]);

  picker.destroy();
});

await test('Backspace hides the selected past session when the filter is empty', () => {
  const picker = createPicker({
    sessions: [
      { id: 1, cli: 'claude', prompt: 'first', lastEventAt: 2 },
      { id: 2, cli: 'codex', prompt: 'second', lastEventAt: 1 },
    ],
    onPick: () => {},
    onStartNew: () => {},
    onClose: () => {},
  });
  const el = document.querySelector('.at-picker-input');

  key(el, 'ArrowDown');
  key(el, 'Backspace');

  assert.deepStrictEqual(picker._state().visibleRows.map(s => s.id), [2]);
  assert.deepStrictEqual([...picker._state().dismissedIds], [1]);

  picker.destroy();
});

await test('Backspace keeps normal filter editing when the filter has text', () => {
  const picker = createPicker({
    sessions: [
      { id: 1, cli: 'claude', prompt: 'alpha task', lastEventAt: 2 },
      { id: 2, cli: 'codex', prompt: 'beta task', lastEventAt: 1 },
    ],
    onPick: () => {},
    onStartNew: () => {},
    onClose: () => {},
  });
  const el = document.querySelector('.at-picker-input');

  input(el, 'task');
  key(el, 'ArrowDown');
  const event = key(el, 'Backspace');

  assert.strictEqual(event.defaultPrevented, false);
  assert.deepStrictEqual(picker._state().visibleRows.map(s => s.id), [1, 2]);
  assert.deepStrictEqual([...picker._state().dismissedIds], []);

  picker.destroy();
});

await test('visible search matches all query words in row text', () => {
  const picker = createPicker({
    sessions: [
      { id: 1, cli: 'claude', title: 'Billing alert', prompt: 'Investigate webhook retry failures', lastEventAt: 3 },
      { id: 2, cli: 'codex', title: 'Billing alert', prompt: 'Investigate invoice retry failures', lastEventAt: 2 },
      { id: 3, cli: 'claude', title: 'Webhook alert', prompt: 'Investigate retry failures', lastEventAt: 1 },
    ],
    onPick: () => {},
    onStartNew: () => {},
    onClose: () => {},
  });
  const el = document.querySelector('.at-picker-input');

  input(el, 'billing webhook');

  assert.deepStrictEqual(picker._state().visibleRows.map(s => s.id), [1]);
  const marks = [...document.querySelectorAll('.at-picker-row[data-id="1"] mark')]
    .map(mark => mark.textContent.toLowerCase());
  assert.deepStrictEqual(marks.sort(), ['billing', 'webhook']);

  picker.destroy();
});

await test('deep search stat opens same-row hidden prompt match picker', async () => {
  let pickedId = null;
  let startedSearch = null;
  let cancelledSearch = null;
  const picker = createPicker({
    sessions: [
      { id: 1, cli: 'claude', title: 'Checkout retry work', prompt: 'Fix checkout retry logic', lastEventAt: 2 },
      { id: 2, cli: 'codex', prompt: 'Unrelated task', lastEventAt: 1 },
    ],
    startHiddenPromptSearch: (payload) => { startedSearch = payload; },
    cancelHiddenPromptSearch: (requestId) => { cancelledSearch = requestId; },
    deepSearchDebounceMs: 0,
    onPick: (id) => { pickedId = id; },
    onStartNew: () => {},
    onClose: () => {},
  });
  const el = document.querySelector('.at-picker-input');

  input(el, 'billing webhook');
  await wait(5);
  assert.ok(startedSearch);

  picker.handleHiddenSearchProgress({
    requestId: startedSearch.requestId,
    query: 'billing webhook',
    done: false,
    matchCount: 2,
    sessions: [{
      id: 1,
      cli: 'claude',
      title: 'Checkout retry work',
      prompt: 'Fix checkout retry logic',
      lastEventAt: 2,
      hiddenMatchCount: 2,
      hiddenMatches: [
        { text: 'webhook retries fail for billing after 409', ranges: [{ start: 0, end: 7 }, { start: 25, end: 32 }], t: 1 },
        { text: 'retry billing webhook from dead-letter queue', ranges: [{ start: 6, end: 13 }, { start: 14, end: 21 }], t: 2 },
      ],
    }],
  });

  const stat = document.querySelector('.at-picker-hidden-stat');
  assert.ok(stat);
  assert.strictEqual(stat.textContent, '2+ hidden prompt matches');

  stat.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.strictEqual(picker._state().mode, 'deep');
  assert.deepStrictEqual(picker._state().visibleRows.map(s => s.id), [1]);
  assert.ok(document.body.textContent.includes('Fix checkout retry logic'));
  assert.ok(document.body.textContent.includes('Hidden prompt matches for billing webhook — 2+ matches'));
  const evidence = [...document.querySelectorAll('.at-picker-hidden-match-line')];
  assert.strictEqual(evidence.length, 2);
  assert.ok(evidence[0].textContent.includes('webhook retries fail for billing after 409'));
  assert.ok(evidence[1].textContent.includes('retry billing webhook from dead-letter queue'));

  key(el, 'Enter');
  assert.strictEqual(pickedId, 1);
  assert.strictEqual(cancelledSearch, startedSearch.requestId);

  picker.destroy();
});

await test('finished deep search removes progressive plus marker', async () => {
  let startedSearch = null;
  const picker = createPicker({
    sessions: [
      { id: 1, cli: 'claude', title: 'Checkout retry work', prompt: 'Fix checkout retry logic', lastEventAt: 2 },
    ],
    startHiddenPromptSearch: (payload) => { startedSearch = payload; },
    deepSearchDebounceMs: 0,
    onPick: () => {},
    onStartNew: () => {},
    onClose: () => {},
  });
  const el = document.querySelector('.at-picker-input');

  input(el, 'billing webhook');
  await wait(5);
  assert.ok(startedSearch);

  picker.handleHiddenSearchProgress({
    requestId: startedSearch.requestId,
    query: 'billing webhook',
    done: false,
    matchCount: 2,
    sessions: [{
      id: 1,
      cli: 'claude',
      title: 'Checkout retry work',
      prompt: 'Fix checkout retry logic',
      lastEventAt: 2,
      hiddenMatchCount: 2,
      hiddenMatches: [
        { text: 'webhook retries fail for billing after 409', ranges: [{ start: 0, end: 7 }, { start: 25, end: 32 }], t: 1 },
        { text: 'retry billing webhook from dead-letter queue', ranges: [{ start: 6, end: 13 }, { start: 14, end: 21 }], t: 2 },
      ],
    }],
  });

  const stat = document.querySelector('.at-picker-hidden-stat');
  assert.ok(stat);
  stat.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.ok(document.body.textContent.includes('Hidden prompt matches for billing webhook — 2+ matches'));

  picker.handleHiddenSearchProgress({
    requestId: startedSearch.requestId,
    query: 'billing webhook',
    done: true,
    matchCount: 2,
    sessions: [],
  });
  assert.ok(document.body.textContent.includes('Hidden prompt matches for billing webhook — 2 matches'));

  picker.destroy();
});

await test('no visible match reports hidden-search progress and final empty state', async () => {
  let startedSearch = null;
  const picker = createPicker({
    sessions: [
      { id: 1, cli: 'claude', prompt: 'Fix checkout retry logic', lastEventAt: 2 },
    ],
    startHiddenPromptSearch: (payload) => { startedSearch = payload; },
    deepSearchDebounceMs: 0,
    onPick: () => {},
    onStartNew: () => {},
    onClose: () => {},
  });
  const el = document.querySelector('.at-picker-input');

  input(el, 'booo');
  await wait(5);

  let heading = document.querySelector('.at-picker-divider');
  assert.ok(heading);
  assert.strictEqual(heading.textContent, 'No visible matches for booo — searching hidden prompts');

  picker.handleHiddenSearchProgress({
    requestId: startedSearch.requestId,
    query: 'booo',
    done: true,
    matchCount: 0,
    sessions: [],
  });

  heading = document.querySelector('.at-picker-divider');
  assert.ok(heading);
  assert.strictEqual(heading.textContent, 'No visible or hidden matches for booo');

  picker.destroy();
});

await test('stale hidden-search progress is ignored after query changes', async () => {
  const starts = [];
  const picker = createPicker({
    sessions: [
      { id: 1, cli: 'claude', prompt: 'Fix checkout retry logic', lastEventAt: 2 },
    ],
    startHiddenPromptSearch: (payload) => { starts.push(payload); },
    deepSearchDebounceMs: 0,
    onPick: () => {},
    onStartNew: () => {},
    onClose: () => {},
  });
  const el = document.querySelector('.at-picker-input');

  input(el, 'billing');
  await wait(5);
  input(el, 'webhook');
  await wait(5);

  picker.handleHiddenSearchProgress({
    requestId: starts[0].requestId,
    query: 'billing',
    done: false,
    matchCount: 1,
    sessions: [{
      id: 1,
      cli: 'claude',
      prompt: 'Fix checkout retry logic',
      lastEventAt: 2,
      hiddenMatchCount: 1,
      hiddenMatches: [{ text: 'billing hidden prompt', ranges: [{ start: 0, end: 7 }], t: 1 }],
    }],
  });

  assert.strictEqual(document.querySelector('.at-picker-hidden-stat'), null);

  picker.handleHiddenSearchProgress({
    requestId: starts[1].requestId,
    query: 'webhook',
    done: false,
    matchCount: 1,
    sessions: [{
      id: 1,
      cli: 'claude',
      prompt: 'Fix checkout retry logic',
      lastEventAt: 2,
      hiddenMatchCount: 1,
      hiddenMatches: [{ text: 'webhook hidden prompt', ranges: [{ start: 0, end: 7 }], t: 1 }],
    }],
  });

  const stat = document.querySelector('.at-picker-hidden-stat');
  assert.ok(stat);
  assert.strictEqual(stat.textContent, '1+ hidden prompt match');

  picker.destroy();
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);

})();
