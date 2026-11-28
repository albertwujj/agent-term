// A comment box's own undo and redo (wired once in comment-ui.js
// createComposer, so the terminal, md and review composers all have it).
// Typing, ⌫, the arrows and selection are the browser's; only the history is
// the box's own.
//
// ⌘Z undoes and ⇧⌘Z (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y elsewhere) redoes a word
// at a time: a key typed where the last one left the caret joins its step
// unless it starts the next word, and a run of ⌫ (or Delete) goes the same
// way, a word erased per step (startsNewWord, word-snap.js). A paste, a cut,
// typing over a selection and an IME composition start a step of their own.
// Held, a step every HOLD_WORD_MS. Undo goes back to how the box opened. What
// you opened it with is yours (`seedFrom`): the key that opened it starts your
// first word, a paste that opened it is a step, and undo reaches the empty
// box; text the box was handed (To comment's words, a reopened comment, a
// saved draft) is where undo stops.
//
// The page's native undo history cannot serve: it is shared by every field in
// the document, the terminal's hidden input included, so an undo past this
// box's first change would reach into another field (and with no Edit menu,
// main.js, macOS gives a text box no redo). Undo and redo write the value
// directly, outside that native history.
//
// Electron-free: bundled into the review preload with comment-ui.js.

const { startsNewWord, HOLD_WORD_MS } = require('./word-snap');

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '');

// seedFrom: 'key' or 'paste' when the box opened with what the user typed or
// pasted; omitted when its opening text was handed to it.
function wireCommentUndo(ta, { seedFrom } = {}) {
  const undoStack = [];
  const redoStack = [];
  let known = ta.value; // the text as the history last saw it
  let before = null; // the box just before the change on its way
  let run = null; // the step changes may still join: { kind: 'type' | 'back' | 'forward', text, to }
  let composing = false;
  let lastStep = 0;
  const snap = () => ({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd });
  if (ta.value && seedFrom) undoStack.push({ value: '', start: 0, end: 0 }); // what opened the box undoes to empty
  if (ta.value && seedFrom === 'key') run = { kind: 'type', text: ta.value, to: ta.value.length }; // the keys after it join its word

  // `was` is the box before a change that starts a step. Text a host wrote
  // meanwhile starts the history over from there.
  function record(was) {
    if (was.value !== known) undoStack.length = 0;
    undoStack.push(was);
    redoStack.length = 0;
  }
  function step(redo) {
    run = null;
    if (ta.value !== known) { undoStack.length = 0; redoStack.length = 0; known = ta.value; return; }
    const from = redo ? redoStack : undoStack;
    if (!from.length) return;
    (redo ? undoStack : redoStack).push(snap());
    const to = from.pop();
    ta.value = to.value;
    ta.setSelectionRange(to.start, to.end);
    known = ta.value;
    const InputEventCtor = window.InputEvent || window.Event;
    ta.dispatchEvent(new InputEventCtor('input', { bubbles: true, inputType: redo ? 'historyRedo' : 'historyUndo' }));
  }

  function onKeydown(e) {
    if (e.isComposing || e.defaultPrevented) return;
    if (!(IS_MAC ? e.metaKey : e.ctrlKey) || e.altKey) return;
    const k = String(e.key).toLowerCase();
    const redo = (k === 'z' && e.shiftKey) || (!IS_MAC && k === 'y' && !e.shiftKey);
    if (k !== 'z' && !redo) return;
    e.preventDefault();
    if (e.repeat && Date.now() - lastStep < HOLD_WORD_MS) return;
    lastStep = Date.now();
    step(redo);
  }

  function onBeforeInput(e) {
    const t = e.inputType || '';
    if (t === 'historyUndo' || t === 'historyRedo') { e.preventDefault(); step(t === 'historyRedo'); return; }
    if (composing) return; // the composition is one step, recorded at its start
    before = snap();
  }

  function onInput(e) {
    const t = e.inputType || '';
    if (t === 'historyUndo' || t === 'historyRedo' || composing || !before) return;
    const was = before;
    before = null;
    // What the change was: typed text, or text ⌫ or Delete erased at a caret.
    const atCaret = was.start === was.end;
    let kind = null;
    let text = '';
    if (t === 'insertText') { kind = 'type'; text = e.data || ''; }
    else if (atCaret && /^delete(Content|Word)Backward$/.test(t)) { kind = 'back'; text = was.value.slice(ta.selectionStart, was.start); }
    else if (atCaret && /^delete(Content|Word)Forward$/.test(t)) { kind = 'forward'; text = was.value.slice(was.start, was.start + was.value.length - ta.value.length); }
    const joins = !!kind && atCaret && !!run && run.kind === kind && run.to === was.start && was.value === known
      && !startsNewWord(run.text, text, kind === 'back');
    if (joins) run.text = kind === 'back' ? text + run.text : run.text + text;
    else { record(was); run = kind ? { kind, text } : null; }
    if (run) run.to = ta.selectionStart;
    known = ta.value;
  }
  function onCompositionStart() { record(snap()); run = null; composing = true; }
  function onCompositionEnd(e) {
    composing = false;
    known = ta.value;
    run = { kind: 'type', text: e.data || '', to: ta.selectionStart };
  }

  ta.addEventListener('keydown', onKeydown);
  ta.addEventListener('beforeinput', onBeforeInput);
  ta.addEventListener('input', onInput);
  ta.addEventListener('compositionstart', onCompositionStart);
  ta.addEventListener('compositionend', onCompositionEnd);
  return () => {
    ta.removeEventListener('keydown', onKeydown);
    ta.removeEventListener('beforeinput', onBeforeInput);
    ta.removeEventListener('input', onInput);
    ta.removeEventListener('compositionstart', onCompositionStart);
    ta.removeEventListener('compositionend', onCompositionEnd);
  };
}

module.exports = { wireCommentUndo };
