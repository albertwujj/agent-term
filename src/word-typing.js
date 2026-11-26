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
// ⌘/Ctrl chords and IME composition stay native. Edits go through
// execCommand so native undo and the box's input listeners see them.
//
// Electron-free: bundled into the review preload with comment-ui.js.

const { wordSpans, snapStart, snapEnd, newWordSpacing } = require('./word-snap');

const HOLD_WORD_MS = 150;
const SPACE = /[ \t ]/;

function replaceRange(ta, from, to, text) {
  ta.setSelectionRange(from, to);
  const done = typeof document.execCommand === 'function'
    && document.execCommand(text ? 'insertText' : 'delete', false, text || undefined);
  if (!done) {
    ta.setRangeText(text, from, to, 'end');
    ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
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
  const from = backward ? word.start : Math.min(caret, word.start);
  let to = backward ? Math.max(caret, word.end) : word.end;
  // A word gone from between two others leaves one space between them.
  if ((from === 0 || SPACE.test(value[from - 1])) && SPACE.test(value[to] || '')) to += 1;
  return { from, to };
}

function wireWordTyping(ta) {
  let rest = false; // the caret rests between words: typed text is a new word
  let lastErase = 0;

  function seat(at) {
    const value = ta.value;
    ta.setSelectionRange(at, at);
    // The end of the comment, or of a line, is where you compose: the bar.
    rest = at < value.length && value[at] !== '\n';
    ta.classList.toggle('cu-word-rest', rest);
  }
  function unrest() {
    rest = false;
    ta.classList.remove('cu-word-rest');
  }

  function onKeydown(e) {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.defaultPrevented) return;
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
      replaceRange(ta, span.from, span.to, '');
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
    if (!rest) return;
    unrest();
    if (e.inputType !== 'insertText' || !e.data || ta.selectionStart !== ta.selectionEnd) return;
    const caret = ta.selectionStart;
    const spacing = newWordSpacing(e.data, caret, ta.value);
    if (!spacing || (!spacing.lead && !spacing.trail)) return;
    e.preventDefault();
    replaceRange(ta, caret, caret, `${spacing.lead}${e.data}${spacing.trail}`);
    if (spacing.trail) {
      const at = ta.selectionStart - spacing.trail.length; // the next keys extend the word
      ta.setSelectionRange(at, at);
    }
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
  ta.addEventListener('mouseup', onMouseup);
  ta.addEventListener('blur', unrest);
  return () => {
    ta.removeEventListener('keydown', onKeydown);
    ta.removeEventListener('beforeinput', onBeforeInput);
    ta.removeEventListener('mouseup', onMouseup);
    ta.removeEventListener('blur', unrest);
  };
}

module.exports = { wireWordTyping, eraseSpan, restingOffset };
