const assert = require('assert');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});

global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const { createViewerSelector } = require('../src/viewer-selector');

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

function key(el, keyName, modifiers = {}) {
  const event = new window.KeyboardEvent('keydown', {
    key: keyName,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  el.dispatchEvent(event);
  return event;
}

function input(el, value) {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

const ENTRIES = [
  { kind: 'md', key: '/home/user/notes/design.md' },
  { kind: 'url', key: 'https://gerrit.example.com/c/repo/+/42' },
  { kind: 'review', key: 'review:///home/user/pkg/review.md' },
  { kind: 'url', key: 'file:///home/user/report.html' },
];

console.log('viewer-selector');

(async () => {

await test('renders every entry with kind tags, newest first', () => {
  const selector = createViewerSelector({ entries: ENTRIES, onPick: () => {} });

  const rows = [...document.querySelectorAll('.at-vsel-row')];
  assert.strictEqual(rows.length, 4);
  assert.ok(rows[0].textContent.includes('/home/user/notes/design.md'));
  const tags = rows.map(r => r.querySelector('.at-vsel-tag').textContent);
  assert.deepStrictEqual(tags, ['md', 'web', 'review', 'file']);

  selector.destroy();
});

await test('filter matches any part of the key and highlights it', () => {
  const selector = createViewerSelector({ entries: ENTRIES, onPick: () => {} });
  const el = document.querySelector('.at-vsel-input');

  input(el, 'gerrit');

  const rows = [...document.querySelectorAll('.at-vsel-row')];
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].querySelector('mark.at-vsel-match').textContent, 'gerrit');

  selector.destroy();
});

await test('space is AND: "read .md" narrows to README.md', () => {
  const selector = createViewerSelector({
    entries: [...ENTRIES, { kind: 'md', key: '/Users/yunxin/agent-term/README.md' }],
    onPick: () => {},
  });
  const el = document.querySelector('.at-vsel-input');

  input(el, 'read .md');

  assert.deepStrictEqual(
    selector._state().visibleRows.map(e => e.key),
    ['/Users/yunxin/agent-term/README.md']
  );

  selector.destroy();
});

await test('multiple terms intersect like the sessions picker filter', () => {
  const selector = createViewerSelector({ entries: ENTRIES, onPick: () => {} });
  const el = document.querySelector('.at-vsel-input');

  input(el, 'user .md');

  assert.deepStrictEqual(
    selector._state().visibleRows.map(e => e.key),
    ['/home/user/notes/design.md', 'review:///home/user/pkg/review.md']
  );

  selector.destroy();
});

await test('a filter with no matches shows the empty heading', () => {
  const selector = createViewerSelector({ entries: ENTRIES, onPick: () => {} });
  const el = document.querySelector('.at-vsel-input');

  input(el, 'zzz');

  assert.strictEqual(document.querySelectorAll('.at-vsel-row').length, 0);
  assert.ok(document.querySelector('.at-vsel-divider').textContent.includes('No viewers match'));

  selector.destroy();
});

await test('Enter picks the selected entry', () => {
  let picked = null;
  const selector = createViewerSelector({ entries: ENTRIES, onPick: (entry) => { picked = entry; } });
  const el = document.querySelector('.at-vsel-input');

  key(el, 'ArrowDown');
  key(el, 'Enter');

  assert.deepStrictEqual(picked, { kind: 'url', key: 'https://gerrit.example.com/c/repo/+/42' });

  selector.destroy();
});

await test('click picks the clicked entry', () => {
  let picked = null;
  const selector = createViewerSelector({ entries: ENTRIES, onPick: (entry) => { picked = entry; } });

  document.querySelectorAll('.at-vsel-row')[1].dispatchEvent(
    new window.MouseEvent('click', { bubbles: true })
  );

  assert.deepStrictEqual(picked, { kind: 'url', key: 'https://gerrit.example.com/c/repo/+/42' });

  selector.destroy();
});

await test('selection starts on the second row when the first is already open', () => {
  const selector = createViewerSelector({
    entries: ENTRIES,
    current: ENTRIES[0],
    onPick: () => {},
  });

  assert.strictEqual(selector._state().selectedIndex, 1);
  const badges = [...document.querySelectorAll('.at-vsel-open-badge')];
  assert.strictEqual(badges.length, 1);

  selector.destroy();
});

await test('selection starts on the first row when the current viewer is elsewhere', () => {
  const selector = createViewerSelector({
    entries: ENTRIES,
    current: ENTRIES[2],
    onPick: () => {},
  });

  assert.strictEqual(selector._state().selectedIndex, 0);

  selector.destroy();
});

await test('Delete removes the selected entry and reports it', () => {
  let removed = null;
  const selector = createViewerSelector({
    entries: ENTRIES,
    onPick: () => {},
    onRemove: (entry) => { removed = entry; },
  });
  const el = document.querySelector('.at-vsel-input');

  key(el, 'Delete');

  assert.deepStrictEqual(removed, { kind: 'md', key: '/home/user/notes/design.md' });
  assert.strictEqual(selector._state().visibleRows.length, 3);

  selector.destroy();
});

await test('Backspace removes only when the filter is empty', () => {
  let removed = null;
  const selector = createViewerSelector({
    entries: ENTRIES,
    onPick: () => {},
    onRemove: (entry) => { removed = entry; },
  });
  const el = document.querySelector('.at-vsel-input');

  input(el, 'md');
  key(el, 'Backspace');
  assert.strictEqual(removed, null);

  input(el, '');
  key(el, 'Backspace');
  assert.deepStrictEqual(removed, { kind: 'md', key: '/home/user/notes/design.md' });

  selector.destroy();
});

await test('Escape closes via onClose', () => {
  let closed = false;
  const selector = createViewerSelector({
    entries: ENTRIES,
    onPick: () => {},
    onClose: () => { closed = true; },
  });
  const el = document.querySelector('.at-vsel-input');

  key(el, 'Escape');
  assert.strictEqual(closed, true);

  selector.destroy();
});

await test('Tab and Shift+Tab move the selection instead of leaving the modal', () => {
  const selector = createViewerSelector({ entries: ENTRIES, onPick: () => {} });
  const el = document.querySelector('.at-vsel-input');

  key(el, 'Tab');
  assert.strictEqual(selector._state().selectedIndex, 1);
  key(el, 'Tab', { shiftKey: true });
  assert.strictEqual(selector._state().selectedIndex, 0);

  selector.destroy();
});

await test('arrow navigation wraps around the visible rows', () => {
  const selector = createViewerSelector({ entries: ENTRIES, onPick: () => {} });
  const el = document.querySelector('.at-vsel-input');

  key(el, 'ArrowUp');
  assert.strictEqual(selector._state().selectedIndex, 3);
  key(el, 'ArrowDown');
  assert.strictEqual(selector._state().selectedIndex, 0);

  selector.destroy();
});

await test('overlay carries the modal marker document-level Esc handlers yield to', () => {
  const selector = createViewerSelector({ entries: ENTRIES, onPick: () => {} });
  const overlay = document.querySelector('.at-vsel-overlay');
  assert.ok(overlay.classList.contains('at-modal-overlay'));
  selector.destroy();
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
if (testsFailed > 0) process.exit(1);

})();
