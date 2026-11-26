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

module.exports = { snapStart, snapEnd, snapRangeToWords };
