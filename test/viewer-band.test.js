const assert = require('assert');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(window, 'innerHeight', {
  configurable: true,
  value: 1000,
});

const { createViewerBand } = require('../src/viewer-band');

const band = createViewerBand({ name: 'test' });
band.open();

const { shell, bar } = band;
const doubleClickBar = () => bar.dispatchEvent(new window.MouseEvent('dblclick', {
  bubbles: true,
  cancelable: true,
}));

const goldenHeight = shell.style.getPropertyValue('--vb-open-h');
assert.ok(shell.classList.contains('open'));
assert.ok(!shell.classList.contains('vb-full'));

doubleClickBar();
const fullHeight = shell.style.getPropertyValue('--vb-open-h');
assert.ok(shell.classList.contains('vb-full'));
assert.ok(parseFloat(fullHeight) > parseFloat(goldenHeight));

doubleClickBar();
assert.ok(!shell.classList.contains('vb-full'));
assert.strictEqual(shell.style.getPropertyValue('--vb-open-h'), goldenHeight);

doubleClickBar();
assert.ok(shell.classList.contains('vb-full'));

band.hide();
assert.ok(shell.classList.contains('hidden'));
assert.ok(!shell.classList.contains('vb-full'));

band.show();
assert.ok(shell.classList.contains('open'));
assert.ok(!shell.classList.contains('vb-full'));
assert.strictEqual(shell.style.getPropertyValue('--vb-open-h'), goldenHeight);

// The size ladder the host's two chords walk: collapsed handle / golden / full.
// A step clamps at each end, so a held-and-tapped chord runs the band out to an
// extreme and stays there.
band.stepSize(+1);
assert.ok(shell.classList.contains('vb-full'), 'a step up from golden is full');
band.stepSize(+1);
assert.ok(shell.classList.contains('vb-full'), 'stepping up again stays at full');
assert.ok(shell.classList.contains('open'));

band.stepSize(-1);
assert.ok(!shell.classList.contains('vb-full'), 'a step down from full is golden');
assert.ok(shell.classList.contains('open'));
assert.strictEqual(shell.style.getPropertyValue('--vb-open-h'), goldenHeight);

band.stepSize(-1);
assert.ok(shell.classList.contains('hidden'), 'a step down from golden is the handle');
band.stepSize(-1);
assert.ok(shell.classList.contains('hidden'), 'stepping down again stays on the handle');

band.stepSize(+1);
assert.ok(shell.classList.contains('open'), 'a step up from the handle reopens');
assert.ok(!shell.classList.contains('vb-full'), 'at the golden reading height');
assert.strictEqual(shell.style.getPropertyValue('--vb-open-h'), goldenHeight);

// Two taps from the handle reach full, which is what holding the chord does.
band.stepSize(-1);
band.stepSize(+1);
band.stepSize(+1);
assert.ok(shell.classList.contains('open') && shell.classList.contains('vb-full'),
  'handle -> golden -> full in two steps');

// The bar's double-click still jumps straight between full and golden.
doubleClickBar();
assert.ok(!shell.classList.contains('vb-full'));
assert.strictEqual(shell.style.getPropertyValue('--vb-open-h'), goldenHeight);

// Esc rolls up an open band — but yields while a modal overlay is up, so the
// modal (viewer selector, path chooser, session picker) can close itself.
const pressEsc = () => document.dispatchEvent(new window.KeyboardEvent('keydown', {
  key: 'Escape',
  bubbles: true,
  cancelable: true,
}));

const modal = document.createElement('div');
modal.className = 'at-modal-overlay';
document.body.appendChild(modal);
pressEsc();
assert.ok(shell.classList.contains('open'), 'Esc must not hide the band under a modal');

modal.remove();
pressEsc();
assert.ok(shell.classList.contains('hidden'), 'Esc hides the band once the modal is gone');

console.log('viewer-band test passed');
