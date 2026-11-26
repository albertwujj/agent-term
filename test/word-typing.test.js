// Word-level typing in a comment box (src/word-typing.js, wired by
// comment-ui.js createComposer into the terminal, md and review composers):
// ⌫/Delete take a word, arrows move a word, clicks and selections settle on
// words, and text typed at a resting caret is a new word with its spaces.

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;

const { createComposer } = require('../src/comment-ui');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const composer = createComposer({ actions: [] });
document.body.appendChild(composer.root);
const ta = composer.textarea;
let inputs = 0;
ta.addEventListener('input', () => { inputs++; });
ta.focus();

function set(value, caret = value.length, end = caret) {
  ta.value = value;
  ta.setSelectionRange(caret, end);
  ta.classList.remove('cu-word-rest');
}
function key(k, init = {}) {
  const ev = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  ta.dispatchEvent(ev);
  return ev;
}
function type(text, box = ta) {
  for (const ch of text) {
    const ev = new dom.window.InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true });
    box.dispatchEvent(ev);
    if (!ev.defaultPrevented) {
      box.setRangeText(ch, box.selectionStart, box.selectionEnd, 'end');
      box.dispatchEvent(new dom.window.InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
    }
  }
}
const caret = () => ta.selectionStart;
const resting = () => ta.classList.contains('cu-word-rest');

async function run() {
  // ⌫ and Delete take a word
  set('the poller reads the file');
  inputs = 0;
  check('⌫ is the box\'s own: the browser does not delete a character', key('Backspace').defaultPrevented);
  check('⌫ takes the last word, the space before it stays', ta.value === 'the poller reads the ' && caret() === 21, [ta.value, caret()]);
  check('the box hears the change', inputs > 0);
  check('at the end of the comment the caret is the bar: you are composing', !resting());
  key('Backspace');
  check('the next ⌫ takes the word before', ta.value === 'the poller reads ', ta.value);

  set('the poller reads the file', 'the poller'.length);
  key('Backspace');
  check('a word gone from between two others leaves one space', ta.value === 'the reads the file', ta.value);
  check('the caret rests on that space as the block', caret() === 3 && resting(), caret());
  type('daemon');
  check('text typed there is a new word with its own space', ta.value === 'the daemon reads the file', ta.value);
  check('while you type, the caret is the bar', !resting());

  set('the poller reads the file', 'the po'.length);
  key('Backspace');
  check('inside a word, ⌫ takes that whole word', ta.value === 'the reads the file', ta.value);

  set('the poller reads the file', 'the poller'.length);
  key('Delete');
  check('Delete takes the word after with its space', ta.value === 'the poller the file', ta.value);

  set('the poller reads', 3, 10);
  check('over a selection ⌫ is the browser\'s', !key('Backspace').defaultPrevented);

  set('one two three four');
  key('Backspace');
  key('Backspace', { repeat: true });
  check('held, repeats within the hold interval take nothing more', ta.value === 'one two three ', ta.value);
  await sleep(170);
  key('Backspace', { repeat: true });
  check('the next repeat after the interval takes the next word', ta.value === 'one two ', ta.value);

  // arrows move a word
  set('the poller reads the file');
  key('ArrowLeft');
  check('← moves to the end of the word before, the block caret', caret() === 'the poller reads the'.length && resting(), caret());
  type('big');
  check('a word typed there gets its own space', ta.value === 'the poller reads the big file', ta.value);
  set('the poller reads', 0);
  key('ArrowRight');
  check('→ moves to the end of the next word', caret() === 3, caret());
  key('ArrowRight');
  key('ArrowRight');
  check('and on to the end of the comment, where the caret is the bar', caret() === ta.value.length && !resting(), caret());
  set('the poller reads', 3);
  key('ArrowRight', { shiftKey: true });
  check('Shift+→ grows the selection by a word', ta.value.slice(ta.selectionStart, ta.selectionEnd) === ' poller', ta.value.slice(ta.selectionStart, ta.selectionEnd));
  check('a chord passes through', !key('ArrowLeft', { metaKey: true }).defaultPrevented);

  // a new word at the start gets its space after it
  set('poller reads', 0);
  key('ArrowLeft');
  type('The');
  check('at the start a new word gets a space after it', ta.value === 'The poller reads', ta.value);

  // clicks and selections settle on words
  set('the poller reads the file', 'the po'.length);
  ta.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  await sleep(10);
  check('a click inside a word rests the caret after it', caret() === 'the poller'.length && resting(), caret());
  set('the poller reads the file', 'the po'.length, 'the poller re'.length);
  ta.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  await sleep(10);
  check('a selection snaps to whole words', ta.value.slice(ta.selectionStart, ta.selectionEnd) === 'poller reads', ta.value.slice(ta.selectionStart, ta.selectionEnd));

  // closing punctuation attaches; at a line's end typing just goes on
  set('the poller reads the file', 'the poller'.length);
  ta.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  await sleep(10);
  type(',');
  check('closing punctuation at rest joins the word before', ta.value === 'the poller, reads the file', ta.value);
  set('first line\nsecond', 'first line'.length);
  ta.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  await sleep(10);
  check('at a line\'s end the caret is the bar', !resting());
  type('s');
  check('and typing just goes on', ta.value === 'first lines\nsecond', ta.value);

  // undo and redo: the box's own history, all the way back to empty
  {
    const seeded = createComposer({ actions: [], seed: 'k' });
    document.body.appendChild(seeded.root);
    const box = seeded.textarea;
    box.focus();
    box.setSelectionRange(1, 1);
    const press = (k, init = {}) => box.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
    type('eep these', box);
    press('Backspace');
    type('those', box);
    check('the box reads as typed', box.value === 'keep those', box.value);
    // The platform's own keys: ⌘ on macOS (the module reads navigator.platform), Ctrl elsewhere.
    const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '');
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    const undo = () => press('z', mod);
    const redo = (i) => (!mac && i % 2 ? press('y', mod) : press('Z', { ...mod, shiftKey: true }));
    const undos = [];
    for (let i = 0; i < 5; i++) { undo(); undos.push(box.value); }
    check('undo steps back a typing run, a word erase, the next run, then the opening letter, and stops at empty',
      JSON.stringify(undos) === JSON.stringify(['keep ', 'keep these', 'k', '', '']), undos);
    const redos = [];
    for (let i = 0; i < 5; i++) { redo(i); redos.push(box.value); }
    check(`redo (${mac ? '⇧⌘Z' : 'Ctrl+Shift+Z and Ctrl+Y'}) steps forward again, and stops at the last change`,
      JSON.stringify(redos) === JSON.stringify(['k', 'keep these', 'keep ', 'keep those', 'keep those']), redos);
    undo();
    type('x', box);
    redo(0);
    check('a change after an undo drops what could be redone', box.value === 'keep x', box.value);
    const menuUndo = new dom.window.InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true });
    box.dispatchEvent(menuUndo);
    check('the context menu\'s Undo steps the same history', menuUndo.defaultPrevented && box.value === 'keep ', box.value);
    box.value = 'written by the host';
    undo();
    check('text a host writes starts the history over: undo leaves it', box.value === 'written by the host', box.value);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
