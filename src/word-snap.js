// A selection made to comment on or edit covers whole words. What the user
// marks is an intent for the agent, so part of a word, or the space beside
// one, is never what they mean: an end that falls inside a word grows to the
// word's edge, and spaces at either end fall away. Offsets are UTF-16,
// matching DOM Range and the viewers' text-offset helpers. Unicode word
// segmentation finds the words, CJK included.
//
// Electron-free: the md viewer uses the offset form; the review preload
// bundles the DOM form.

let segmenter;

// The word with `offset` strictly inside it (an offset at a word's edge is
// already a word boundary), or null.
function wordAround(text, offset) {
  segmenter ||= new Intl.Segmenter(undefined, { granularity: 'word' });
  for (const part of segmenter.segment(text)) {
    const end = part.index + part.segment.length;
    if (part.index >= offset) break;
    if (part.isWordLike && offset < end) return { start: part.index, end };
  }
  return null;
}

function snapStart(text, offset) {
  const word = wordAround(text, offset);
  let at = word ? word.start : offset;
  while (at < text.length && /\s/.test(text[at])) at++;
  return at;
}

function snapEnd(text, offset) {
  const word = wordAround(text, offset);
  let at = word ? word.end : offset;
  while (at > 0 && /\s/.test(text[at - 1])) at--;
  return at;
}

// The DOM form: a range snapped within the blocks its ends sit in (blockOf
// maps a node to its block element). Null when the snap leaves nothing (a
// selection of only spaces) or an end has no block.
function snapRangeToWords(range, blockOf) {
  const startBlock = blockOf(range.startContainer);
  const endBlock = blockOf(range.endContainer);
  if (!startBlock || !endBlock) return null;
  const flatOffset = (block, node, offset) => {
    const before = document.createRange();
    before.selectNodeContents(block);
    before.setEnd(node, offset);
    return before.toString().length;
  };
  const start = snapStart(startBlock.textContent, flatOffset(startBlock, range.startContainer, range.startOffset));
  const end = snapEnd(endBlock.textContent, flatOffset(endBlock, range.endContainer, range.endOffset));
  if (startBlock === endBlock && end <= start) return null;
  const pointAt = (block, offset, isEnd) => {
    const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
    const walker = document.createTreeWalker(block, SHOW_TEXT, null);
    let left = offset; let node; let last = null;
    while ((node = walker.nextNode())) {
      if (left < node.data.length || (isEnd && left === node.data.length)) return [node, left];
      left -= node.data.length;
      last = node;
    }
    return last ? [last, last.data.length] : [block, 0];
  };
  const snapped = document.createRange();
  snapped.setStart(...pointAt(startBlock, start, false));
  snapped.setEnd(...pointAt(endBlock, end, true));
  return snapped;
}

// The words of a text as editing counts them: Unicode word boundaries, as
// a selection snaps to (`book/books` is two words, `don't` and `3.14` one),
// the punctuation touching a word riding with it. Punctuation between two
// words goes with the one before (`book/`, `books`), punctuation that opens
// a run with the one after (`(maybe)`). Returns [{ start, end }] in order.
function wordSpans(text) {
  const spans = [];
  segmenter ||= new Intl.Segmenter(undefined, { granularity: 'word' });
  for (const run of String(text || '').matchAll(/\S+/g)) {
    const start = run.index;
    let open = null; // the span being built
    let lead = null; // punctuation waiting for the word after it
    for (const part of segmenter.segment(run[0])) {
      const s = start + part.index;
      const e = s + part.segment.length;
      if (part.isWordLike) {
        if (open) spans.push(open);
        open = { start: lead != null ? lead : s, end: e };
        lead = null;
      } else if (open) {
        open.end = e;
      } else if (lead == null) {
        lead = s;
      }
    }
    if (open) spans.push(open);
    else if (lead != null) spans.push({ start: lead, end: start + run[0].length });
  }
  return spans;
}

// The spaces text typed at a resting caret (between words) needs to stand as
// a word of its own: one before it right after a word, one after it right
// before a word. A word ends before the caret unless that is a space, the
// start, or an opening bracket or quote; one starts after it on a letter or
// digit, or an opening bracket or quote leading into one. Null when the text
// goes in as typed: it starts with a space, it is closing punctuation right
// after a word (`foo,`), or the caret is between two words with no space
// between them (`book/|books`), where you type what joins them. Shared by the
// edit (edit-marks.js) and the comment box (word-typing.js).
const OPENERS = /[(\[{“‘«]/;
const QUOTES = /["']/;
const CLOSERS = /^[,.;:!?)\]]/;
function newWordSpacing(text, caret, value) {
  if (!text || /^\s/.test(text)) return null;
  const at = (k) => value[k] || '';
  const before = at(caret - 1);
  const afterWord = /\S/.test(before) && !OPENERS.test(before)
    && !(QUOTES.test(before) && !/\S/.test(at(caret - 2)));
  if (afterWord && CLOSERS.test(text)) return null;
  const after = at(caret);
  if (/\S/.test(before) && /\S/.test(after)) {
    const words = wordSpans(value);
    if (words.some((w) => w.end === caret) && words.some((w) => w.start === caret)) return null;
  }
  const wordNext = /[\p{L}\p{N}]/u.test(after)
    || ((OPENERS.test(after) || QUOTES.test(after)) && /[\p{L}\p{N}]/u.test(at(caret + 1)));
  return { lead: afterWord ? ' ' : '', trail: wordNext ? ' ' : '' };
}

// The span ⌫ (backward) or Delete takes for `word` from a caret: the word,
// and the spaces between it and the caret, unless taking them would join
// the text either side (Delete at `the |book/books` leaves `the books`).
// Shared by the edit (edit-marks.js) and the comment box (word-typing.js).
function wordEraseSpan(text, word, caret, backward) {
  const from = backward ? word.start : Math.min(caret, word.start);
  const to = backward ? Math.max(caret, word.end) : word.end;
  const joins = /\S/.test(text[from - 1] || '') && /\S/.test(text[to] || '') && /\s/.test(text.slice(from, to));
  return joins ? { from: word.start, to: word.end } : { from, to };
}

// Undo and redo step a word at a time, as ⌫ erases one: a typed key joins the
// step of the keys before it unless it starts the next word (wordSpans) after
// a word typed in the step. `typed` is the text typed in the step so far, so
// spaces typed ahead of a word ride with it. Shared by the edit
// (markdown-viewer.js, review-commit-edit.js) and the comment box
// (word-typing.js).
function startsTypedWord(typed, text) {
  typed = typed || '';
  if (!text || !wordSpans(typed).length) return false;
  return wordSpans(typed + text).some((w) => w.start === typed.length);
}

// Held, ⌫ takes and ⌘Z undoes a word every HOLD_WORD_MS: key repeat at
// letter speed would run past where you meant to stop.
const HOLD_WORD_MS = 150;

module.exports = { snapStart, snapEnd, snapRangeToWords, wordSpans, newWordSpacing, wordEraseSpan, startsTypedWord, HOLD_WORD_MS };
