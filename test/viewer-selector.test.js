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
  { kind: 'url', key: 'https://code.example.com/c/repo/+/42' },
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

  input(el, 'code');

  const rows = [...document.querySelectorAll('.at-vsel-row')];
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].querySelector('mark.at-vsel-match').textContent, 'code');

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

  assert.deepStrictEqual(picked, { kind: 'url', key: 'https://code.example.com/c/repo/+/42' });

  selector.destroy();
});

await test('click picks the clicked entry', () => {
  let picked = null;
  const selector = createViewerSelector({ entries: ENTRIES, onPick: (entry) => { picked = entry; } });

  document.querySelectorAll('.at-vsel-row')[1].dispatchEvent(
    new window.MouseEvent('click', { bubbles: true })
  );

  assert.deepStrictEqual(picked, { kind: 'url', key: 'https://code.example.com/c/repo/+/42' });

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

// ---- on-disk section ----

const DISK_CTX = { cwd: '/Users/u/repo', home: '/Users/u' };

function diskSpy() {
  const calls = [];
  const cancels = [];
  return {
    calls,
    cancels,
    startDiskSearch: (payload) => calls.push(payload),
    cancelDiskSearch: (requestId) => cancels.push(requestId),
  };
}

function progress(selector, spy, extra) {
  selector.handleDiskSearchProgress({ requestId: spy.calls[0].requestId, ...DISK_CTX, ...extra });
}

await test('opens with no entries and says the disk is one typed name away', () => {
  const spy = diskSpy();
  const selector = createViewerSelector({ entries: [], onPick: () => {}, ...spy });
  assert.strictEqual(document.querySelectorAll('.at-vsel-row').length, 0);
  assert.strictEqual(
    document.querySelector('.at-vsel-divider').textContent,
    'No viewers yet · type a name to find one on disk'
  );
  selector.destroy();

  const plain = createViewerSelector({ entries: [], onPick: () => {} });
  assert.strictEqual(document.querySelector('.at-vsel-divider').textContent, 'No viewers yet');
  plain.destroy();
});

await test('three typed characters start the disk walk, once per open', () => {
  const spy = diskSpy();
  const selector = createViewerSelector({ entries: ENTRIES, onPick: () => {}, ...spy });
  const el = document.querySelector('.at-vsel-input');

  input(el, 're');
  assert.strictEqual(spy.calls.length, 0);
  assert.strictEqual(document.querySelector('.at-vsel-disk-divider'), null);

  input(el, 'red');
  assert.strictEqual(spy.calls.length, 1);
  assert.ok(/^disk-/.test(spy.calls[0].requestId));
  assert.strictEqual(document.querySelector('.at-vsel-disk-divider').textContent, 'On disk — searching…');

  input(el, 'reddit');
  assert.strictEqual(spy.calls.length, 1);

  selector.destroy();
});

await test('disk rows land under the known rows, labelled by tier and filtered by the term', () => {
  const spy = diskSpy();
  let picked = null;
  const selector = createViewerSelector({ entries: ENTRIES, onPick: (e) => { picked = e; }, ...spy });
  const el = document.querySelector('.at-vsel-input');
  input(el, 'reddit');

  progress(selector, spy, {
    done: false, tier: 'cwd',
    files: ['/Users/u/repo/docs/reddit-post.md', '/Users/u/repo/README.md'],
  });
  let rows = [...document.querySelectorAll('.at-vsel-row')];
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.at-vsel-key').textContent), ['docs/reddit-post.md']);
  assert.strictEqual(
    document.querySelector('.at-vsel-disk-divider').textContent,
    'On disk — 1 matching reddit · searching…'
  );

  progress(selector, spy, {
    done: false, tier: 'siblings',
    files: ['/Users/u/launch/reddit-notes.md', '/Users/u/other/nothing.md'],
  });
  progress(selector, spy, { done: true, tier: null, files: [] });
  rows = [...document.querySelectorAll('.at-vsel-row')];
  assert.deepStrictEqual(
    rows.map((r) => r.querySelector('.at-vsel-key').textContent),
    ['docs/reddit-post.md', '~/launch/reddit-notes.md']
  );
  assert.strictEqual(document.querySelector('.at-vsel-disk-divider').textContent, 'On disk — 2 matching reddit');
  assert.strictEqual(rows[1].querySelector('mark.at-vsel-match').textContent, 'reddit');

  key(el, 'ArrowDown');
  key(el, 'Enter');
  assert.strictEqual(picked.kind, 'md');
  assert.strictEqual(picked.key, '/Users/u/launch/reddit-notes.md');
  assert.strictEqual(picked.source, 'disk');

  selector.destroy();
});

await test('known rows come first and a known row hides its disk copy', () => {
  const spy = diskSpy();
  const selector = createViewerSelector({
    entries: [{ kind: 'md', key: 'docs/reddit-post.md' }, { kind: 'md', key: 'reddit-faq.md' }],
    onPick: () => {},
    ...spy,
  });
  const el = document.querySelector('.at-vsel-input');
  input(el, 'reddit');
  progress(selector, spy, {
    done: true, tier: 'cwd',
    files: [
      '/Users/u/repo/docs/reddit-post.md',
      '/Users/u/repo/notes/reddit-faq.md',
      '/Users/u/repo/reddit-draft.md',
    ],
  });

  const keys = [...document.querySelectorAll('.at-vsel-row .at-vsel-key')].map((k) => k.textContent);
  assert.deepStrictEqual(keys, ['docs/reddit-post.md', 'reddit-faq.md', 'reddit-draft.md']);
  assert.strictEqual(document.querySelector('.at-vsel-disk-divider').textContent, 'On disk — 1 matching reddit');

  selector.destroy();
});

await test('the disk list caps at twelve rows and asks for more letters', () => {
  const spy = diskSpy();
  const selector = createViewerSelector({ entries: [], onPick: () => {}, ...spy });
  const el = document.querySelector('.at-vsel-input');
  input(el, 'note');
  const files = Array.from({ length: 15 }, (_, i) => `/Users/u/repo/note-${String(i).padStart(2, '0')}.md`);
  progress(selector, spy, { done: true, tier: 'cwd', files });

  assert.strictEqual(document.querySelectorAll('.at-vsel-row').length, 12);
  assert.strictEqual(document.querySelector('.at-vsel-more').textContent, '3 more · keep typing to narrow');
  assert.strictEqual(document.querySelector('.at-vsel-disk-divider').textContent, 'On disk — 15 matching note');

  input(el, 'note-1');
  assert.strictEqual(document.querySelectorAll('.at-vsel-row').length, 5);
  assert.strictEqual(document.querySelector('.at-vsel-more'), null);

  selector.destroy();
});

await test('a finished walk with no match says so; a stale request id is ignored', () => {
  const spy = diskSpy();
  const selector = createViewerSelector({ entries: ENTRIES, onPick: () => {}, ...spy });
  const el = document.querySelector('.at-vsel-input');
  input(el, 'zzz');

  selector.handleDiskSearchProgress({
    requestId: 'disk-stale', ...DISK_CTX, done: false, tier: 'cwd', files: ['/Users/u/repo/zzz.md'],
  });
  assert.strictEqual(document.querySelectorAll('.at-vsel-row').length, 0);

  progress(selector, spy, { done: true, tier: null, files: [] });
  assert.strictEqual(document.querySelector('.at-vsel-disk-divider').textContent, 'On disk — none matching zzz');
  assert.ok(document.querySelector('.at-vsel-divider').textContent.includes('No viewers match'));

  selector.destroy();
});

await test('a tier the budget cut short is called a partial walk', () => {
  const spy = diskSpy();
  const selector = createViewerSelector({ entries: [], onPick: () => {}, ...spy });
  const el = document.querySelector('.at-vsel-input');
  input(el, 'reddit');
  progress(selector, spy, { done: false, tier: 'cwd', files: [], partial: false });
  progress(selector, spy, { done: false, tier: 'siblings', files: ['/Users/u/x/reddit.md'], partial: true });
  assert.strictEqual(document.querySelector('.at-vsel-disk-divider').textContent, 'On disk — 1 matching reddit · searching…');
  progress(selector, spy, { done: true, tier: null, files: [] });
  assert.strictEqual(document.querySelector('.at-vsel-disk-divider').textContent, 'On disk — 1 matching reddit · partial walk');
  assert.strictEqual(selector._state().disk.partial, true);

  selector.destroy();
});

await test('the disk section hides below three letters and returns without a new walk', () => {
  const spy = diskSpy();
  const selector = createViewerSelector({ entries: [], onPick: () => {}, ...spy });
  const el = document.querySelector('.at-vsel-input');
  input(el, 'reddit');
  progress(selector, spy, { done: true, tier: 'cwd', files: ['/Users/u/repo/reddit.md'] });
  assert.strictEqual(document.querySelectorAll('.at-vsel-row').length, 1);

  input(el, 're');
  assert.strictEqual(document.querySelector('.at-vsel-disk-divider'), null);
  assert.strictEqual(document.querySelectorAll('.at-vsel-row').length, 0);

  input(el, 'red');
  assert.strictEqual(spy.calls.length, 1);
  assert.strictEqual(document.querySelectorAll('.at-vsel-row').length, 1);

  selector.destroy();
});

await test('Delete on a disk row forgets nothing', () => {
  const spy = diskSpy();
  let removed = null;
  const selector = createViewerSelector({ entries: [], onPick: () => {}, onRemove: (e) => { removed = e; }, ...spy });
  const el = document.querySelector('.at-vsel-input');
  input(el, 'reddit');
  progress(selector, spy, { done: true, tier: 'cwd', files: ['/Users/u/repo/reddit.md'] });

  key(el, 'Delete');
  assert.strictEqual(removed, null);
  assert.strictEqual(document.querySelectorAll('.at-vsel-row').length, 1);

  selector.destroy();
});

await test('destroy cancels a walk still running and leaves a finished one alone', () => {
  const running = diskSpy();
  const selector = createViewerSelector({ entries: [], onPick: () => {}, ...running });
  input(document.querySelector('.at-vsel-input'), 'reddit');
  selector.destroy();
  assert.deepStrictEqual(running.cancels, [running.calls[0].requestId]);

  const finished = diskSpy();
  const other = createViewerSelector({ entries: [], onPick: () => {}, ...finished });
  input(document.querySelector('.at-vsel-input'), 'reddit');
  progress(other, finished, { done: true, tier: null, files: [] });
  other.destroy();
  assert.deepStrictEqual(finished.cancels, []);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
if (testsFailed > 0) process.exit(1);

})();
