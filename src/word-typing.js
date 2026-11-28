// Word-level typing in a comment box: the edit's rules (edit-marks.js,
// md-editing-design.md "Editing works a word at a time") on a plain
// textarea. A comment is read by an agent that shrugs off a typo, so the
// unit of re-work is the word:
//
// - ⌫/Delete take the word beside the caret (or the one it is inside); a
//   word gone from between two others leaves one space. Held, a word every
//   HOLD_WORD_MS. A selection deletes as it is (it is whole words already).
// - ←/→ move to the end of the word before or after; Shift grows the
//   selection by words. ↑/↓, Home/End and clicks settle after the word they
//   land in; a selection snaps to whole words.
// - A caret at rest between words (after a click, an arrow, ⌫) is the block
//   caret, and text typed there is a new word with its own spaces
//   (newWordSpacing). The end of the comment, and of each line, is where you
//   compose: there the caret is the bar and typing just goes on.
//
// ⌘Z undoes and ⇧⌘Z (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y elsewhere) redoes
// through the box's own history, as the edit's do: a typed word is one step
// (startsTypedWord), as are a word erase, a paste and a cut; held, a step
// every HOLD_WORD_MS, the pace a held ⌫ erases. Undo goes back to how the box
// opened. What you opened it with is yours (`seedFrom`): the key that opened
// it starts your first word, a paste that opened it is a step, and
// undo reaches the empty box; text the box was handed (To comment's words, a
// reopened comment, a saved draft) is where undo stops. The page's native
// undo history cannot serve: it is shared by
// every field in the document, the terminal's hidden input included, so an
// undo past this box's first change would reach into another field (and with
// no Edit menu, main.js, macOS gives a text box no redo). The box's own
// edits write with setRangeText, outside that native history. Other ⌘/Ctrl
// chords and IME composition stay native.
//
// Electron-free: bundled into the review preload with comment-ui.js.

const { wordSpans, snapStart, snapEnd, newWordSpacing, wordEraseSpan, startsTypedWord, HOLD_WORD_MS } = require('./word-snap');
const SPACE = /[ \t ]/;

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '');

function replaceRange(ta, from, to, text) {
  ta.setRangeText(text, from, to, 'end');
  const InputEventCtor = window.InputEvent || window.Event;
  ta.dispatchEvent(new InputEventCtor('input', { bubbles: true, inputType: text ? 'insertText' : 'deleteContentBackward', data: text || null }));
}

// Inside a word: after it. At a word's start right after spaces that follow
// a word: on those spaces, after that word.
function restingOffset(value, at) {
  const inside = wordSpans(value).find((w) => w.start < at && at < w.end);
  if (inside) return inside.end;
  if (/\S/.test(value[at] || '') && SPACE.test(value[at - 1] || '')) {
    let k = at;
    while (k > 0 && SPACE.test(value[k - 1])) k--;
    if (k > 0 && /\S/.test(value[k - 1])) return k;
  }
  return at;
}

// The span ⌫ (backward) or Delete takes from a collapsed caret, or null.
function eraseSpan(value, caret, backward) {
  const words = wordSpans(value);
  const word = backward ? words.filter((w) => w.start < caret).pop() : words.find((w) => w.end > caret);
  if (!word) return null;
  const { from, to } = wordEraseSpan(value, word, caret, backward);
  // A word gone from between two others leaves one space between them.
  const space = (from === 0 || SPACE.test(value[from - 1])) && SPACE.test(value[to] || '') ? 1 : 0;
  return { from, to: to + space };
}

// seedFrom: 'key' or 'paste' when the box opened with what the user typed or
// pasted; omitted when its opening text was handed to it.
function wireWordTyping(ta, { seedFrom } = {}) {
  let rest = false; // the caret rests between words: typed text is a new word
  let lastErase = 0;

  // ——— the box's own history ———
  const undoStack = [];
  const redoStack = [];
  let typedTo = null; // where the last typed text left the caret: its word goes on there
  let typedWord = ''; // the text typed in this step so far: whether the next key starts a word
  let pendingWord = ''; // typedWord once the key on its way lands
  let lastStep = 0;
  let composing = false;
  let known = ta.value; // the text as the history last saw it
  const snap = () => ({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd });
  if (ta.value && seedFrom) undoStack.push({ value: '', start: 0, end: 0 }); // what opened the box undoes to empty
  if (ta.value && seedFrom === 'key') { typedTo = ta.value.length; typedWord = ta.value; } // the keys after it join its word
  // A change is about to happen: the text before it is a step. Text a host
  // wrote meanwhile starts the history over from there.
  function record() {
    if (ta.value !== known) undoStack.length = 0;
    undoStack.push(snap());
    redoStack.length = 0;
    typedTo = null;
  }
  function step(redo) {
    unrest();
    if (ta.value !== known) { undoStack.length = 0; redoStack.length = 0; known = ta.value; return; }
    const from = redo ? redoStack : undoStack;
    if (!from.length) return;
    (redo ? undoStack : redoStack).push(snap());
    const to = from.pop();
    ta.value = to.value;
    ta.setSelectionRange(to.start, to.end);
    known = ta.value;
    typedTo = null;
    const InputEventCtor = window.InputEvent || window.Event;
    ta.dispatchEvent(new InputEventCtor('input', { bubbles: true, inputType: redo ? 'historyRedo' : 'historyUndo' }));
  }

  function seat(at) {
    const value = ta.value;
    ta.setSelectionRange(at, at);
    typedTo = null; // the caret moved: what is typed next is a step of its own
    // The end of the comment, or of a line, is where you compose: the bar.
    rest = at < value.length && value[at] !== '\n';
    ta.classList.toggle('cu-word-rest', rest);
  }
  function unrest() {
    rest = false;
    ta.classList.remove('cu-word-rest');
  }

  function onKeydown(e) {
    if (e.isComposing || e.defaultPrevented) return;
    if ((IS_MAC ? e.metaKey : e.ctrlKey) && !e.altKey) {
      const k = String(e.key).toLowerCase();
      const redo = (k === 'z' && e.shiftKey) || (!IS_MAC && k === 'y' && !e.shiftKey);
      if (k === 'z' || redo) {
        e.preventDefault();
        if (e.repeat && Date.now() - lastStep < HOLD_WORD_MS) return;
        lastStep = Date.now();
        step(redo);
      }
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    const value = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (start !== end) { unrest(); return; } // the selection goes as it is
      e.preventDefault();
      if (e.repeat && Date.now() - lastErase < HOLD_WORD_MS) return;
      const span = eraseSpan(value, start, e.key === 'Backspace');
      if (!span) return;
      lastErase = Date.now();
      record();
      replaceRange(ta, span.from, span.to, '');
      known = ta.value;
      seat(restingOffset(ta.value, span.from));
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const backward = e.key === 'ArrowLeft';
      const words = wordSpans(value);
      if (e.shiftKey) {
        const towardStart = start !== end && ta.selectionDirection === 'backward';
        const anchor = start === end ? start : (towardStart ? end : start);
        const focus = start === end ? start : (towardStart ? start : end);
        const stops = backward ? [0, ...words.map((w) => w.start)] : [...words.map((w) => w.end), value.length];
        const next = backward ? stops.filter((s) => s < focus).pop() : stops.find((s) => s > focus);
        const to = next == null ? focus : next;
        if (to < anchor) ta.setSelectionRange(to, anchor, 'backward');
        else ta.setSelectionRange(anchor, to, 'forward');
        unrest();
        return;
      }
      const from = start === end ? start : (backward ? start : end);
      const ends = [0, ...words.map((w) => w.end), value.length];
      const next = backward ? ends.filter((x) => x < from).pop() : ends.find((x) => x > from);
      seat(next == null ? from : next);
      return;
    }
    if (!e.shiftKey && /^(ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(e.key)) {
      // The browser moves the caret; it then rests after the word it landed in.
      setTimeout(() => {
        if (ta.selectionStart === ta.selectionEnd) seat(restingOffset(ta.value, ta.selectionStart));
      }, 0);
    }
  }

  function onBeforeInput(e) {
    const t = e.inputType || '';
    if (t === 'historyUndo' || t === 'historyRedo') { e.preventDefault(); step(t === 'historyRedo'); return; }
    if (composing) return; // the composition is one step, recorded at its start
    // A key typed where the last one left the caret joins that step, unless
    // it starts the next word.
    const typing = t === 'insertText' && ta.selectionStart === ta.selectionEnd;
    const joins = typing && typedTo === ta.selectionStart && ta.value === known && !startsTypedWord(typedWord, e.data);
    if (!joins) record();
    pendingWord = joins ? typedWord + (e.data || '') : (e.data || '');
    const wasRest = rest;
    unrest();
    if (!wasRest || !typing || !e.data) return;
    const caret = ta.selectionStart;
    const spacing = newWordSpacing(e.data, caret, ta.value);
    if (!spacing || (!spacing.lead && !spacing.trail)) return;
    e.preventDefault();
    replaceRange(ta, caret, caret, `${spacing.lead}${e.data}${spacing.trail}`);
    const at = ta.selectionStart - spacing.trail.length; // the next keys extend the word
    ta.setSelectionRange(at, at);
    known = ta.value;
    typedTo = at;
    typedWord = e.data;
  }

  function onInput(e) {
    const t = e.inputType || '';
    if (t === 'historyUndo' || t === 'historyRedo' || composing) return;
    known = ta.value;
    typedTo = t === 'insertText' && ta.selectionStart === ta.selectionEnd ? ta.selectionStart : null;
    typedWord = pendingWord;
    pendingWord = '';
  }
  function onCompositionStart() { record(); composing = true; }
  function onCompositionEnd(e) {
    composing = false;
    known = ta.value;
    typedTo = ta.selectionStart;
    typedWord = e.data || '';
  }

  function onMouseup() {
    setTimeout(() => {
      if (document.activeElement !== ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start !== end) {
        const a = snapStart(ta.value, start);
        const b = snapEnd(ta.value, end);
        if (b > a && (a !== start || b !== end)) ta.setSelectionRange(a, b, ta.selectionDirection);
        unrest();
        return;
      }
      seat(restingOffset(ta.value, start));
    }, 0);
  }

  ta.addEventListener('keydown', onKeydown);
  ta.addEventListener('beforeinput', onBeforeInput);
  ta.addEventListener('input', onInput);
  ta.addEventListener('compositionstart', onCompositionStart);
  ta.addEventListener('compositionend', onCompositionEnd);
  ta.addEventListener('mouseup', onMouseup);
  ta.addEventListener('blur', unrest);
  return () => {
    ta.removeEventListener('keydown', onKeydown);
    ta.removeEventListener('beforeinput', onBeforeInput);
    ta.removeEventListener('input', onInput);
    ta.removeEventListener('compositionstart', onCompositionStart);
    ta.removeEventListener('compositionend', onCompositionEnd);
    ta.removeEventListener('mouseup', onMouseup);
    ta.removeEventListener('blur', unrest);
  };
}

module.exports = { wireWordTyping, eraseSpan, restingOffset };
