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

const { createViewerBand, userIsTyping, setTypingProbe, setAgentIdle } = require('../src/viewer-band');

const band = createViewerBand({ name: 'test' });
band.open();

const { shell, bar } = band;
// The bar is a stepper. jsdom lays nothing out, so it sits where we say: its
// top half is above y=613, its bottom half below.
bar.getBoundingClientRect = () => ({ top: 600, bottom: 626, height: 26, left: 0, right: 800, width: 800 });
const TOP = 605;
const BOTTOM = 620;
const clickBar = (y) => bar.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientY: y }));
const hoverBar = (y) => bar.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, clientY: y }));

const goldenHeight = shell.style.getPropertyValue('--vb-open-h');
assert.ok(shell.classList.contains('open'));
assert.ok(!shell.classList.contains('vb-full'));

// Hover leans the bar toward where a click sends it: a strip just above it
// over the top half, just below it over the bottom half.
const lean = () => document.querySelector('.vb-bar-lean.on');
hoverBar(TOP);
assert.ok(lean() && lean().classList.contains('up') && lean().style.top === '588px',
  'hovering the top half at golden leans the bar up');
assert.strictEqual(bar.title, 'Click to roll up');
hoverBar(BOTTOM);
assert.ok(lean() && lean().classList.contains('down') && lean().style.top === '626px',
  'hovering the bottom half leans it down');
assert.strictEqual(bar.title, 'Click for full size');
lean().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const fullHeight = shell.style.getPropertyValue('--vb-open-h');
assert.ok(shell.classList.contains('vb-full'), 'the lean is part of the target: a click on it steps the same way');
assert.ok(parseFloat(fullHeight) > parseFloat(goldenHeight));
assert.ok(!lean(), 'a step drops the lean');
assert.ok(document.querySelector('.vb-edge-catch.on'), 'at full the sliver below the bar joins it');
hoverBar(BOTTOM);
assert.ok(lean() && lean().classList.contains('up') && bar.title === 'Click to roll up',
  'at full the whole bar leans up, its only way');

// At full a click anywhere rolls the band up: golden is the transitional size
// a Send recedes to, not a stop on the way.
clickBar(BOTTOM);
assert.ok(shell.classList.contains('hidden'), 'at full a click anywhere rolls the band up');
assert.ok(!document.querySelector('.vb-edge-catch.on'), 'the sliver is only the bar at full');
clickBar(TOP);
assert.ok(shell.classList.contains('open') && !shell.classList.contains('vb-full'),
  'a click anywhere on the handle brings it back, at its default size');
clickBar(BOTTOM);
assert.ok(shell.classList.contains('vb-full'));
document.querySelector('.vb-edge-catch').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert.ok(shell.classList.contains('hidden'), 'a click on the sliver rolls it up too');
clickBar(TOP);
clickBar(TOP);
assert.ok(shell.classList.contains('hidden'), "golden's top half rolls the band up");
clickBar(TOP);
clickBar(BOTTOM);
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

// A click on the bar at full rolls it up; the handle brings it back.
clickBar(TOP);
assert.ok(shell.classList.contains('hidden'));
clickBar(TOP);
assert.ok(shell.classList.contains('open'));

// A step moves the bar out from under the pointer, so a click elsewhere right
// after it (the rest of a habitual double-click) is swallowed, not delivered.
{
  const target = document.createElement('div');
  document.body.appendChild(target);
  let clicks = 0;
  target.addEventListener('click', () => { clicks += 1; });
  clickBar(BOTTOM);
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

// The Send's round trip. A Send at full recedes to golden (the terminal shows
// the pickup) and arms the return; full comes back once the agent has
// answered and the CLI says its turn is over — or, where the title gives no
// idle evidence, once every thread is resolved. The user's hand, putting the
// band away, and starting to write all end it; nothing moves while typing.
{
  const rt = createViewerBand({ name: 'roundtrip', defaultSize: 'full', escToHide: false });
  const answered = { answered: true, resolved: false };
  const resolved = { answered: true, resolved: true };
  const waiting = { answered: false, resolved: false };
  const freshSend = () => { rt.close(); rt.open(); rt.recedeForSend(); };

  setAgentIdle(false);
  rt.open();
  rt.reportThreads(resolved); // a report from before the Send
  rt.recedeForSend();
  assert.ok(rt.isOpen() && !rt.isFull(), 'a Send at full recedes to golden');
  setAgentIdle(true);
  assert.ok(!rt.isFull(), 'a report from before the Send does not count');
  rt.reportThreads(waiting);
  assert.ok(!rt.isFull(), 'threads still waiting on the agent keep golden');
  setAgentIdle(false);
  rt.reportThreads(answered);
  assert.ok(!rt.isFull(), 'answered while the CLI still works keeps golden');
  setAgentIdle(true);
  assert.ok(rt.isFull(), 'answered and idle returns to full');
  rt.toggleFullSize(); // the user drops to golden by hand
  rt.reportThreads(resolved);
  assert.ok(!rt.isFull(), 'the return is one-shot; a size picked by hand holds');

  // No idle evidence from the title: only every thread resolved returns.
  freshSend();
  setAgentIdle(null);
  rt.reportThreads(answered);
  assert.ok(!rt.isFull(), 'without idle evidence, answered alone keeps golden');
  rt.reportThreads(resolved);
  assert.ok(rt.isFull(), 'without idle evidence, all resolved returns to full');

  // A Send from golden the user chose arms nothing.
  rt.toggleFullSize();
  setAgentIdle(true);
  rt.recedeForSend();
  rt.reportThreads(resolved);
  assert.ok(!rt.isFull(), 'a Send from a golden the user picked stays golden');

  // The hand, putting the band away, and starting to write each end the trip.
  freshSend();
  rt.toggleFullSize(); rt.toggleFullSize(); // back to golden, by hand
  rt.reportThreads(resolved);
  assert.ok(!rt.isFull(), 'a hand resize cancels the return');
  freshSend();
  rt.hide(); rt.show();
  assert.ok(rt.isFull(), 'a band put away comes back at its default size');
  rt.toggleFullSize();
  rt.reportThreads(resolved);
  assert.ok(!rt.isFull(), 'and owes nothing to the Send before');

  freshSend();
  const box = document.createElement('textarea');
  rt.content.appendChild(box);
  box.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  rt.reportThreads(resolved);
  assert.ok(!rt.isFull(), 'starting to write at golden settles golden');
  rt.recedeForSend(); // the Send written there
  rt.reportThreads(resolved);
  assert.ok(!rt.isFull(), 'and the Send written there arms nothing');

  freshSend();
  const search = document.createElement('input');
  rt.content.appendChild(search);
  search.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  search.focus();
  assert.ok(userIsTyping(), 'a focused text field in a band is typing');
  rt.reportThreads(resolved);
  assert.ok(!rt.isFull(), 'no return lands while the user types');
  search.blur();
  rt.reportThreads(resolved);
  assert.ok(!rt.isFull(), 'a return dropped for typing is not deferred');

  freshSend();
  let typing = true;
  setTypingProbe(() => typing);
  assert.ok(userIsTyping(), 'the host probe (terminal typing) counts');
  rt.reportThreads(resolved);
  assert.ok(!rt.isFull(), 'typing in the terminal blocks the return too');
  typing = false;
  setTypingProbe(null);

  // A Send still being prepared (md waiting on the agent-threads clone)
  // recedes without arming; the Send that completes it arms the return.
  rt.close(); rt.open();
  rt.recede();
  assert.ok(!rt.isFull(), 'the clone wait recedes');
  rt.reportThreads(resolved);
  assert.ok(!rt.isFull(), 'and arms nothing by itself');
  rt.recedeForSend();
  rt.reportThreads(resolved);
  assert.ok(rt.isFull(), 'the Send it completes arms the return');

  // Rolled up, the band stays put; nothing reveals it.
  freshSend();
  rt.hide();
  rt.reportThreads(resolved);
  assert.ok(rt.isHidden(), 'a rolled-up band stays rolled up');
  rt.close();
}

console.log('viewer-band test passed');


