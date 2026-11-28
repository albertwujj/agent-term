// A comment box's own undo and redo (src/comment-undo.js, wired by
// comment-ui.js createComposer into the terminal, md and review composers):
// typing, ⌫ and the arrows are the browser's; ⌘Z and ⇧⌘Z step through the
// box's own history a word at a time, back to how the box opened.

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

// The platform's own keys: ⌘ on macOS (the module reads navigator.platform), Ctrl elsewhere.
const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '');
const mod = mac ? { metaKey: true } : { ctrlKey: true };

function open(seed, seedFrom) {
  const c = createComposer({ actions: [], seed, seedFrom });
  document.body.appendChild(c.root);
  c.focus();
  const box = c.textarea;
  const press = (k, init = {}) => {
    const ev = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    box.dispatchEvent(ev);
    return ev;
  };
  // Typing and ⌫ as the browser does them: beforeinput, the change, input.
  const type = (text) => {
    for (const ch of text) {
      const ev = new dom.window.InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true });
      box.dispatchEvent(ev);
      if (ev.defaultPrevented) continue;
      box.setRangeText(ch, box.selectionStart, box.selectionEnd, 'end');
      box.dispatchEvent(new dom.window.InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
    }
  };
  const erase = (backward = true) => {
    const inputType = backward ? 'deleteContentBackward' : 'deleteContentForward';
    const ev = new dom.window.InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
    box.dispatchEvent(ev);
    if (ev.defaultPrevented) return ev;
    const at = box.selectionStart;
    if (backward) box.setRangeText('', Math.max(0, at - 1), at, 'end');
    else box.setRangeText('', at, at + 1, 'end');
    box.dispatchEvent(new dom.window.InputEvent('input', { inputType, bubbles: true }));
    return ev;
  };
  return { box, press, type, erase, undo: () => press('z', mod) };
}
const redoOf = (press) => (i) => (!mac && i % 2 ? press('y', mod) : press('Z', { ...mod, shiftKey: true }));

async function run() {
  {
    const { box, press, erase } = open('the poller', undefined);
    box.setSelectionRange(box.value.length, box.value.length);
    check('⌫ is the browser\'s: a letter at a time', !erase().defaultPrevented && box.value === 'the polle', box.value);
    check('and so are the arrows', !press('ArrowLeft').defaultPrevented && !press('ArrowRight', { altKey: true }).defaultPrevented);
  }

  {
    const { box, press, type, erase, undo } = open('k', 'key');
    type('eep these');
    for (let i = 0; i < 5; i++) erase();
    type('those');
    check('the box reads as typed', box.value === 'keep those', box.value);
    const redo = redoOf(press);
    const undos = [];
    for (let i = 0; i < 5; i++) { undo(); undos.push(box.value); }
    check('undo steps back a word at a time, an erased word one step, to the first word with the key that opened the box, and stops at empty',
      JSON.stringify(undos) === JSON.stringify(['keep ', 'keep these', 'keep ', '', '']), undos);
    const redos = [];
    for (let i = 0; i < 5; i++) { redo(i); redos.push(box.value); }
    check(`redo (${mac ? '⇧⌘Z' : 'Ctrl+Shift+Z and Ctrl+Y'}) steps forward again, and stops at the last change`,
      JSON.stringify(redos) === JSON.stringify(['keep ', 'keep these', 'keep ', 'keep those', 'keep those']), redos);
    undo();
    type('x');
    redo(0);
    check('a change after an undo drops what could be redone', box.value === 'keep x', box.value);
    const menuUndo = new dom.window.InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true });
    box.dispatchEvent(menuUndo);
    check('the context menu\'s Undo steps the same history', menuUndo.defaultPrevented && box.value === 'keep ', box.value);
    box.value = 'written by the host';
    undo();
    check('text a host writes starts the history over: undo leaves it', box.value === 'written by the host', box.value);
  }

  {
    const { box, type, erase, undo } = open('', undefined);
    type('read the poller');
    for (let i = 0; i < 12; i++) erase(); // "poller", " the", and on into "read"
    check('⌫ erases as typed', box.value === 'rea', box.value);
    undo();
    check('a run of ⌫ undoes a word at a time: the letter that reached "read" is its own step', box.value === 'read', box.value);
    undo();
    check('then each erased word with the space before it', box.value === 'read the', box.value);
    undo();
    check('and the next', box.value === 'read the poller', box.value);
  }

  {
    const pasted = open('the clipboard', 'paste');
    pasted.type(' and more');
    pasted.undo();
    check('a space typed ahead of a word rides with it', pasted.box.value === 'the clipboard and ', pasted.box.value);
    pasted.undo();
    check('a paste that opened the box is its own step', pasted.box.value === 'the clipboard', pasted.box.value);
    pasted.undo();
    check('and undo takes it back to empty', pasted.box.value === '', pasted.box.value);

    const handed = open('words handed over');
    handed.type(' and mine');
    handed.undo();
    handed.undo();
    check('undo takes back the words typed into a box opened with handed-over text', handed.box.value === 'words handed over', handed.box.value);
    handed.undo();
    check('and stops at the text it opened with', handed.box.value === 'words handed over', handed.box.value);

    const held = open('', undefined);
    held.type('one two three four');
    held.undo();
    held.press('z', { ...mod, repeat: true });
    check('held, repeats within the hold interval undo nothing more', held.box.value === 'one two three ', held.box.value);
    await sleep(170);
    held.press('z', { ...mod, repeat: true });
    check('the next repeat after the interval undoes the next word', held.box.value === 'one two ', held.box.value);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
