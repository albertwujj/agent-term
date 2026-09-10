const assert = require('assert');
const { JSDOM } = require('jsdom');
const { launcherClis, renderMarkup, show, destroy, isMounted, HEIGHT_PX } = require('../src/launcher-band');

let testsPassed = 0;
let testsFailed = 0;

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  return dom;
}

function test(name, fn) {
  try { fn(); testsPassed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  } finally {
    try { destroy(); } catch {}
    delete global.window;
    delete global.document;
  }
}

console.log('launcher-band');

test('chips order the CLIs the user has run first, most recent first, then the rest', () => {
  assert.deepStrictEqual(launcherClis([]), ['claude', 'codex', 'copilot', 'agent']);
  assert.deepStrictEqual(launcherClis([
    { cli: 'codex' }, { cli: 'agent' }, { cli: 'codex' }, { cli: 'mystery' }, { cli: null },
  ]), ['codex', 'agent', 'claude', 'copilot']);
});

test('the markup is Start, one chip per CLI with its brand icon, and the two hints', () => {
  installDom();
  const root = document.createElement('div');
  root.innerHTML = renderMarkup({ clis: ['codex', 'claude'], platform: 'darwin' });
  const chips = [...root.querySelectorAll('.at-launcher-chip')];
  assert.deepStrictEqual(chips.map(c => c.dataset.cli), ['codex', 'claude']);
  assert.ok(chips.every(c => c.querySelector('svg.at-cli-icon')), 'each chip carries the brand icon');
  assert.strictEqual(root.querySelector('.at-launcher-lead').textContent, 'Start');
  const hint = root.querySelector('.at-launcher-hint').textContent.replace(/\s+/g, ' ').trim();
  assert.ok(hint.includes('⇧ click to add options first'), hint);
  assert.ok(hint.includes('⌘⇧S for the picker'), hint);
  root.innerHTML = renderMarkup({ clis: ['claude'], platform: 'win32' });
  assert.ok(root.querySelector('.at-launcher-hint').textContent.includes('Ctrl+Shift+S for the picker'));
});

test('a click starts the CLI; Shift+click asks for the typed line; ✕ removes the strip', () => {
  installDom();
  const starts = [];
  let resizes = 0;
  show({
    clis: ['claude', 'codex'],
    platform: 'darwin',
    onStart: (cli, opts) => starts.push([cli, opts]),
    onResize: () => { resizes++; },
  });
  assert.ok(isMounted());
  assert.strictEqual(document.body.style.getPropertyValue('--at-launcher-height'), `${HEIGHT_PX}px`,
    'the strip pushes the terminal down through the body variable');
  assert.strictEqual(resizes, 1, 'the renderer is asked to re-fit on mount');

  document.querySelector('.at-launcher-chip[data-cli="codex"]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true }));
  document.querySelector('.at-launcher-chip[data-cli="claude"]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, shiftKey: true }));
  assert.deepStrictEqual(starts, [['codex', { typeOnly: false }], ['claude', { typeOnly: true }]]);
  assert.ok(isMounted(), 'the pick itself leaves dismissal to the caller');

  document.querySelector('.at-launcher-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(!isMounted());
  assert.strictEqual(document.querySelector('.at-launcher'), null);
  assert.strictEqual(document.body.style.getPropertyValue('--at-launcher-height'), '', 'the variable is cleared');
  assert.strictEqual(resizes, 2, 'and the renderer re-fits again');
});

test('show replaces an earlier strip rather than stacking', () => {
  installDom();
  show({ clis: ['claude'] });
  show({ clis: ['codex'] });
  assert.strictEqual(document.querySelectorAll('.at-launcher').length, 1);
  assert.strictEqual(document.querySelector('.at-launcher-chip').dataset.cli, 'codex');
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
