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

// The size chord (and the bar's double-click): golden⇄full while open; from the
// hidden handle it reveals at full — so toggle() gives the reading split and
// toggleFullSize() gives the full screen, each one press from the handle.
band.toggleFullSize();
assert.ok(shell.classList.contains('vb-full'), 'size toggle from golden is full');
assert.ok(shell.classList.contains('open'));
assert.ok(band.isFull(), 'isFull reports the open-at-full state');

band.toggleFullSize();
assert.ok(!shell.classList.contains('vb-full'), 'size toggle from full is golden');
assert.ok(shell.classList.contains('open'));
assert.strictEqual(shell.style.getPropertyValue('--vb-open-h'), goldenHeight);
assert.ok(!band.isFull(), 'golden is not full');

band.toggle();
assert.ok(shell.classList.contains('hidden'), 'toggle from open is the handle');
band.toggle();
assert.ok(shell.classList.contains('open'), 'toggle from the handle reopens');
assert.ok(!shell.classList.contains('vb-full'), 'at the golden reading height');
assert.strictEqual(shell.style.getPropertyValue('--vb-open-h'), goldenHeight);

band.hide();
assert.ok(!band.isFull(), 'the handle is not full even before the size reset lands');
band.toggleFullSize();
assert.ok(shell.classList.contains('open') && shell.classList.contains('vb-full'),
  'size toggle from the handle reveals at full');

// The bar's double-click drives the same golden⇄full toggle.
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

// defaultSize: 'full' — a fresh reveal lands full-screen (the md band's mode:
// opening a doc puts it on stage). Golden stays reachable by the size toggle,
// and hide/show returns to full, the band's rest size.
const fullBand = createViewerBand({ name: 'fulltest', defaultSize: 'full', escToHide: false });
fullBand.open();
assert.ok(fullBand.isFull(), 'a full-default band opens at full');

fullBand.toggleFullSize();
assert.ok(!fullBand.isFull(), 'size toggle still drops to golden');
assert.ok(fullBand.shell.classList.contains('open'));

fullBand.hide();
fullBand.show();
assert.ok(fullBand.isFull(), 'reveal after hide returns to the full default');

fullBand.toggleFullSize();
assert.ok(!fullBand.isFull());
fullBand.close();
fullBand.open();
assert.ok(fullBand.isFull(), 'a fresh open after close is back at the full default');

// setDefaultSize — the web band retargets its default per page: review pages
// full, plain pages golden. Open bands keep their current size; the new default
// governs the next reveal.
fullBand.setDefaultSize('golden');
assert.ok(fullBand.isFull(), 'retargeting while open leaves the current size alone');
fullBand.hide();
fullBand.show();
assert.ok(!fullBand.isFull(), 'the next reveal lands on the new golden default');
fullBand.close();
fullBand.setDefaultSize('full');
fullBand.open();
assert.ok(fullBand.isFull(), 'retargeting while closed takes effect on open');

console.log('viewer-band test passed');
