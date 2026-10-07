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

const { createViewerBand, userIsTyping, setTypingProbe } = require('../src/viewer-band');

const band = createViewerBand({ name: 'test', reachAbove: true });
band.open();
band.toggleFullSize(); // the split view, by the size chord

(async () => {
const { shell, bar } = band;
// jsdom lays nothing out, so the bar sits where we say. TOP and BOTTOM are
// its two halves, which act the same.
bar.getBoundingClientRect = () => ({ top: 600, bottom: 626, height: 26, left: 0, right: 800, width: 800 });
const TOP = 605;
const BOTTOM = 620;
const clickBar = (y) => bar.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientY: y }));
const hoverBar = (y) => bar.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, clientY: y }));
// Cmd-click on macOS, Ctrl-click elsewhere (either key is taken); the hint
// names the platform's own.
const MOD_CLICK = /Mac/i.test((globalThis.navigator && globalThis.navigator.platform) || '') ? '⌘-click' : 'Ctrl-click';
const modClickBar = (y) => bar.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientY: y, ctrlKey: true }));
// Clicks act at once; this only lets a step's own settling run out.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const goldenHeight = shell.style.getPropertyValue('--vb-open-h');
assert.ok(shell.classList.contains('open'));
assert.ok(!shell.classList.contains('vb-full'));

// At golden the bar is one target: a click anywhere on it takes the viewer
// full. Hover lightens it and names the clicks, a beat after the pointer
// arrives. Nothing hangs off the bar into the terminal; the terminal's own
// click is the host's.
const hint = () => {
  const el = bar.querySelector('.vb-hover-hint.on');
  return el ? el.textContent : '';
};
hoverBar(BOTTOM);
assert.ok(bar.classList.contains('vb-hot'), 'hover lightens the bar');
assert.ok(!document.querySelector('.vb-bar-lean, .vb-reach-below'), 'no band hangs off the bar');
assert.strictEqual(hint(), '', 'the hint waits a beat');
await new Promise((resolve) => setTimeout(resolve, 200));
assert.strictEqual(hint(), `Click: full size · ${MOD_CLICK}: roll up`, 'the hint names each gesture and what it does');
clickBar(BOTTOM);
const fullHeight = shell.style.getPropertyValue('--vb-open-h');
assert.ok(shell.classList.contains('vb-full'), "golden's bar goes full wherever it is clicked");
assert.ok(parseFloat(fullHeight) > parseFloat(goldenHeight));
assert.ok(!bar.classList.contains('vb-hot'), 'a step drops the hover');
assert.ok(document.querySelector('.vb-edge-catch.on'), 'at full the sliver below the bar joins it');
hoverBar(BOTTOM);
await new Promise((resolve) => setTimeout(resolve, 200));
assert.strictEqual(hint(), `Click: roll up · ${MOD_CLICK}: split view`, 'at full the bar names both clicks');

// At full and on the handle a click crosses to the other end, at once, and a
// modifier-click lands on golden instead; at golden it rolls the band up.
clickBar(BOTTOM);
assert.ok(shell.classList.contains('hidden'), 'a click at full rolls the band up, at once');
assert.ok(!document.querySelector('.vb-edge-catch.on'), 'the sliver is only the bar at full');
hoverBar(TOP);
await new Promise((resolve) => setTimeout(resolve, 200));
assert.strictEqual(hint(), `Click: full size · ${MOD_CLICK}: split view`, 'the handle names both clicks');
clickBar(TOP);
await settle();
assert.ok(shell.classList.contains('vb-full'), 'a click on the handle opens it full');
modClickBar(TOP);
assert.ok(shell.classList.contains('open') && !shell.classList.contains('vb-full'), 'a modifier-click at full lands on golden');
modClickBar(TOP);
assert.ok(shell.classList.contains('hidden'), 'at golden a modifier-click rolls the band up');
modClickBar(TOP);
assert.ok(shell.classList.contains('open') && !shell.classList.contains('vb-full'), 'a modifier-click on the handle opens golden');
// At golden, for a viewer whose page ends in an empty margin, a strip of it
// above the bar joins the bar.
const reachAbove = () => document.querySelector('.vb-reach-above.on');
assert.ok(reachAbove() && reachAbove().style.height === '20px', 'at golden the bar reaches 20px up');
reachAbove().dispatchEvent(new window.PointerEvent('pointerenter'));
assert.ok(bar.classList.contains('vb-hot'), 'the reach lights the bar');
reachAbove().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert.ok(shell.classList.contains('vb-full'), 'a click there takes the viewer full');
assert.ok(!reachAbove(), 'at full the bar does not reach; the edge sliver takes over');
document.querySelector('.vb-edge-catch').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle();
assert.ok(shell.classList.contains('hidden'), 'a click on the sliver rolls it up');
assert.ok(!reachAbove(), 'nor does it reach from the rolled-up handle');
clickBar(TOP);
await settle();
assert.ok(shell.classList.contains('vb-full'));

band.hide();
assert.ok(shell.classList.contains('hidden'));
assert.ok(!shell.classList.contains('vb-full'));

band.show();
assert.ok(shell.classList.contains('open'));
assert.ok(shell.classList.contains('vb-full'), 'a reveal lands full');
assert.ok(band.isFull(), 'isFull reports the open-at-full state');

// The size chord: golden⇄full while open; from the hidden handle it reveals
// at full, like every reveal.
band.toggleFullSize();
assert.ok(!shell.classList.contains('vb-full'), 'size toggle from full is golden');
assert.ok(shell.classList.contains('open'));
assert.strictEqual(shell.style.getPropertyValue('--vb-open-h'), goldenHeight);
assert.ok(!band.isFull(), 'golden is not full');

band.toggleFullSize();
assert.ok(shell.classList.contains('vb-full'), 'size toggle from golden is full');
assert.ok(shell.classList.contains('open'));

band.toggleFullSize();
band.toggle();
assert.ok(shell.classList.contains('hidden'), 'toggle from open is the handle');
band.toggle();
assert.ok(shell.classList.contains('open'), 'toggle from the handle reopens');
assert.ok(shell.classList.contains('vb-full'), 'at full: golden is never where the band rests');

band.hide();
assert.ok(!band.isFull(), 'the handle is not full even before the size reset lands');
band.toggleFullSize();
assert.ok(shell.classList.contains('open') && shell.classList.contains('vb-full'),
  'size toggle from the handle reveals at full');

// A click on the bar at full rolls it up; the handle brings it back, full.
clickBar(TOP);
await settle();
assert.ok(shell.classList.contains('hidden'));
clickBar(TOP);
await settle();
assert.ok(shell.classList.contains('vb-full'));
band.toggleFullSize(); // golden, by the size chord

// A step moves the bar out from under the pointer, so a click elsewhere right
// after it (the rest of a habitual double-click) is swallowed, not delivered.
{
  const target = document.createElement('div');
  document.body.appendChild(target);
  let clicks = 0;
  target.addEventListener('click', () => { clicks += 1; });
  clickBar(TOP);
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.strictEqual(clicks, 0, 'a click just after a step is swallowed');
  band.toggleFullSize(); // back to golden for what follows, by the size chord
  assert.ok(shell.classList.contains('open') && !shell.classList.contains('vb-full'));
  target.remove();
}

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

// Every reveal lands full: a fresh open, a show from the handle, an open
// after a close. A page opened over the split keeps it.
const fullBand = createViewerBand({ name: 'fulltest', escToHide: false });
fullBand.open();
assert.ok(fullBand.isFull(), 'a band opens at full');

fullBand.toggleFullSize();
assert.ok(!fullBand.isFull(), 'size toggle drops to golden');
assert.ok(fullBand.shell.classList.contains('open'));
fullBand.open();
assert.ok(fullBand.shell.classList.contains('open') && !fullBand.isFull(), 'a page opened over the split keeps it');

fullBand.hide();
fullBand.show();
assert.ok(fullBand.isFull(), 'a reveal after hide is full');

fullBand.toggleFullSize();
fullBand.close();
fullBand.open();
assert.ok(fullBand.isFull(), 'a fresh open after close is full');
fullBand.close();

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

// The automatic moves. The agent's new content brings the band up full, from
// golden or the handle; a Send recedes full to golden; the user acting on
// the terminal rolls it up (withdraw). A roll-up by hand holds through the
// agent's content until the user acts on the terminal or brings it back, and
// nothing moves while the user types.
{
  const rt = createViewerBand({ name: 'moves', escToHide: false });
  rt.open();
  rt.recede();
  assert.ok(rt.isOpen() && !rt.isFull(), 'a Send at full recedes to golden');
  rt.recede();
  assert.ok(rt.isOpen() && !rt.isFull(), 'a Send at golden stays there');
  rt.contentArrived();
  assert.ok(rt.isFull(), "the agent's content returns golden to full");
  rt.contentArrived();
  assert.ok(rt.isFull(), 'and leaves full alone');

  rt.toggleFullSize(); // a split by hand, to watch the agent
  rt.contentArrived();
  assert.ok(rt.isFull(), 'a split by hand waits for the content too');

  rt.withdraw(); // the user typed in the terminal
  assert.ok(rt.isHidden(), 'acting on the terminal rolls the band up');
  rt.contentArrived();
  assert.ok(rt.isFull(), 'and the content answering it brings the band up full');

  rt.hide(); // by hand: Esc, the bar, a click on the terminal
  rt.contentArrived();
  assert.ok(rt.isHidden(), 'a roll-up by hand holds through the content');
  rt.withdraw(); // then the user types in the terminal
  rt.contentArrived();
  assert.ok(rt.isFull(), 'until the user acts on the terminal');
  rt.hide();
  rt.show();
  rt.toggleFullSize();
  rt.contentArrived();
  assert.ok(rt.isFull(), 'or brings the band back');

  rt.toggleFullSize();
  const search = document.createElement('input');
  rt.content.appendChild(search);
  search.focus();
  assert.ok(userIsTyping(), 'a focused text field in a band is typing');
  rt.contentArrived();
  assert.ok(!rt.isFull(), 'no content move lands while the user types');
  search.blur();
  let typing = true;
  setTypingProbe(() => typing);
  assert.ok(userIsTyping(), 'the host probe (terminal typing) counts');
  rt.contentArrived();
  assert.ok(!rt.isFull(), 'typing in the terminal holds it too');
  typing = false;
  setTypingProbe(null);
  rt.setWriting(true); // a review composer in the guest page
  rt.contentArrived();
  assert.ok(!rt.isFull(), "writing in a guest page holds it, which the host's focus cannot see");
  rt.setWriting(false);
  rt.contentArrived();
  assert.ok(rt.isFull(), 'the next content after the user stops lands');

  rt.close();
  rt.contentArrived();
  assert.ok(!rt.isOpen() && !rt.isHidden(), 'content never opens a closed band');
}

console.log('viewer-band test passed');
})().catch((err) => { console.error(err); process.exit(1); });


