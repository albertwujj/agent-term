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

// Leaving the screen hands the keyboard back. A click in the band lands focus
// on its shell (or a bar button, a composer, a webview guest); once the band
// rolls up or closes that element is gone from view, and every key would land
// on it — the window reads as frozen. The band asks the host to focus the
// terminal, and only when it actually held focus.
{
  let focused = 0;
  const focusBand = createViewerBand({ name: 'focus', focusTerminal: () => { focused += 1; } });
  focusBand.open();
  const other = document.createElement('input');
  document.body.appendChild(other);
  other.focus();
  focusBand.hide();
  assert.strictEqual(focused, 0, 'a roll-up with focus elsewhere leaves it alone');
  focusBand.show();
  focusBand.shell.tabIndex = -1;
  focusBand.shell.focus();
  assert.strictEqual(document.activeElement, focusBand.shell);
  focusBand.hide();
  assert.strictEqual(focused, 1, 'a roll-up with focus on the shell hands it to the terminal');
  focusBand.show();
  focusBand.toggleFullSize();
  focusBand.bar.querySelector('button').focus();
  focusBand.close();
  assert.strictEqual(focused, 2, 'a close with focus on a bar button hands it to the terminal');
  assert.ok(!focusBand.shell.classList.contains('vb-full'), 'a closed shell drops the full-size marker');
  assert.ok(!focusBand.shell.classList.contains('open') && !focusBand.shell.classList.contains('hidden'));
  focusBand.open();
  other.focus();
  focusBand.close();
  assert.strictEqual(focused, 2, 'a close with focus elsewhere leaves it alone');
  // No host callback: the band still closes.
  const plain = createViewerBand({ name: 'plain' });
  plain.open();
  plain.shell.tabIndex = -1;
  plain.shell.focus();
  plain.close();
  assert.ok(!plain.isOpen());
}

console.log('viewer-band test passed');
