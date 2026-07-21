function diffArrays(a, b) {
  const oldItems = Array.isArray(a) ? a : [];
  const newItems = Array.isArray(b) ? b : [];
  const prefixLength = commonPrefixLength(oldItems, newItems);
  const suffixLength = commonSuffixLength(oldItems, newItems, prefixLength);
  const prefixOpcode = prefixLength > 0
    ? [{ tag: 'equal', i1: 0, i2: prefixLength, j1: 0, j2: prefixLength }]
    : [];
  const oldEnd = oldItems.length - suffixLength;
  const newEnd = newItems.length - suffixLength;
  const oldMiddle = oldItems.slice(prefixLength, oldEnd);
  const newMiddle = newItems.slice(prefixLength, newEnd);
  const suffixOpcode = suffixLength > 0
    ? [{
        tag: 'equal',
        i1: oldEnd,
        i2: oldItems.length,
        j1: newEnd,
        j2: newItems.length,
      }]
    : [];

  if (oldMiddle.length === 0 && newMiddle.length === 0) {
    return [...prefixOpcode, ...suffixOpcode];
  }
  if (oldMiddle.length === 0) {
    return [
      ...prefixOpcode,
      { tag: 'insert', i1: prefixLength, i2: prefixLength, j1: prefixLength, j2: newEnd },
      ...suffixOpcode,
    ];
  }
  if (newMiddle.length === 0) {
    return [
      ...prefixOpcode,
      { tag: 'delete', i1: prefixLength, i2: oldEnd, j1: prefixLength, j2: prefixLength },
      ...suffixOpcode,
    ];
  }

  // Avoid a pathological pause during polling. The fallback is still correct
  // enough for highlighting: it marks the changed middle as one replacement.
  if (oldMiddle.length * newMiddle.length > 4_000_000) {
    return [
      ...prefixOpcode,
      { tag: 'replace', i1: prefixLength, i2: oldEnd, j1: prefixLength, j2: newEnd },
      ...suffixOpcode,
    ];
  }

  const middleOpcodes = diffArraysWithLcs(oldMiddle, newMiddle)
    .map((op) => ({
      tag: op.tag,
      i1: op.i1 + prefixLength,
      i2: op.i2 + prefixLength,
      j1: op.j1 + prefixLength,
      j2: op.j2 + prefixLength,
    }));
  return [...prefixOpcode, ...middleOpcodes, ...suffixOpcode];
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

function commonSuffixLength(a, b, prefixLength) {
  const max = Math.min(a.length, b.length) - prefixLength;
  let count = 0;
  while (count < max && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
  return count;
}

function diffArraysWithLcs(oldItems, newItems) {
  const n = oldItems.length;
  const m = newItems.length;
  const stride = m + 1;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * stride + j] = oldItems[i] === newItems[j]
        ? table[(i + 1) * stride + j + 1] + 1
        : Math.max(table[(i + 1) * stride + j], table[i * stride + j + 1]);
    }
  }

  const edits = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldItems[i] === newItems[j]) {
      edits.push({ type: 'equal' });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * stride + j] >= table[i * stride + j + 1]) {
      edits.push({ type: 'delete' });
      i += 1;
    } else {
      edits.push({ type: 'insert' });
      j += 1;
    }
  }
  while (i < n) {
    edits.push({ type: 'delete' });
    i += 1;
  }
  while (j < m) {
    edits.push({ type: 'insert' });
    j += 1;
  }

  return editsToOpcodes(edits);
}

function editsToOpcodes(edits) {
  const raw = [];
  let i = 0;
  let j = 0;
  let current = null;

  function flush() {
    if (!current) return;
    raw.push(current);
    current = null;
  }

  for (const edit of edits) {
    if (!current || current.tag !== edit.type) {
      flush();
      current = { tag: edit.type, i1: i, i2: i, j1: j, j2: j };
    }

    if (edit.type === 'equal') {
      i += 1;
      j += 1;
    } else if (edit.type === 'delete') {
      i += 1;
    } else if (edit.type === 'insert') {
      j += 1;
    }
    current.i2 = i;
    current.j2 = j;
  }
  flush();

  const opcodes = [];
  for (let index = 0; index < raw.length; index++) {
    const op = raw[index];
    const next = raw[index + 1];
    if (op.tag === 'delete' && next && next.tag === 'insert') {
      opcodes.push({
        tag: 'replace',
        i1: op.i1,
        i2: op.i2,
        j1: next.j1,
        j2: next.j2,
      });
      index += 1;
    } else if (op.tag === 'insert' && next && next.tag === 'delete') {
      opcodes.push({
        tag: 'replace',
        i1: next.i1,
        i2: next.i2,
        j1: op.j1,
        j2: op.j2,
      });
      index += 1;
    } else {
      opcodes.push(op);
    }
  }

  return opcodes;
}

function splitSourceLines(source) {
  return String(source == null ? '' : source).split('\n');
}

function getLineDiffOpcodes(oldSource, newSource) {
  return diffArrays(splitSourceLines(oldSource), splitSourceLines(newSource));
}

const TEXT_TOKEN_RE = /\S+|\s+/g;

function tokenizeTextWithOffsets(text) {
  const source = String(text == null ? '' : text);
  const tokens = [];
  let match;
  TEXT_TOKEN_RE.lastIndex = 0;
  while ((match = TEXT_TOKEN_RE.exec(source))) {
    tokens.push({
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

function trimWhitespaceRange(text, start, end) {
  let from = Math.max(0, start);
  let to = Math.max(from, end);
  while (from < to && /\s/.test(text[from])) from += 1;
  while (to > from && /\s/.test(text[to - 1])) to -= 1;
  return from < to ? { start: from, end: to } : null;
}

function mergeRanges(ranges) {
  const sorted = ranges
    .filter((range) => range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

// A contiguous multi-word edit fragments into one changed range per word, because
// the tokenizer emits the interword spaces as their own tokens and the diff aligns
// those identical spaces as unchanged. Bridge ranges whose gap is only whitespace
// so a run of adjacent changed words reads as one mark, not a stripe per word. A gap
// holding any non-whitespace (an unchanged word between two changed ones) stays split.
function mergeRangesAcrossWhitespace(ranges, text) {
  const source = String(text == null ? '' : text);
  const bridged = [];
  for (const range of mergeRanges(ranges)) {
    const last = bridged[bridged.length - 1];
    if (last && !/\S/.test(source.slice(last.end, range.start))) {
      last.end = Math.max(last.end, range.end);
    } else {
      bridged.push({ start: range.start, end: range.end });
    }
  }
  return bridged;
}

function getWordList(text) {
  return String(text == null ? '' : text).toLowerCase().match(/[a-z0-9_]+/g) || [];
}

function getWordSet(text) {
  return new Set(getWordList(text));
}

function hasNewWordSignal(oldText, newText) {
  const oldWords = getWordSet(oldText);
  const newWords = getWordSet(newText);
  if (newWords.size === 0) return false;
  for (const word of newWords) {
    if (!oldWords.has(word)) return true;
  }
  return false;
}

function hasDeletedWordSignal(oldText, newText) {
  const newCounts = new Map();
  for (const word of getWordList(newText)) {
    newCounts.set(word, (newCounts.get(word) || 0) + 1);
  }

  for (const word of getWordList(oldText)) {
    const count = newCounts.get(word) || 0;
    if (count <= 0) return true;
    newCounts.set(word, count - 1);
  }
  return false;
}

function getWordRanges(text) {
  const source = String(text == null ? '' : text);
  const ranges = [];
  const re = /[A-Za-z0-9_]+/g;
  let match;
  while ((match = re.exec(source))) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function isWordChar(char) {
  return /[A-Za-z0-9_]/.test(char);
}

function isWhitespaceChar(char) {
  return /\s/.test(char);
}

function expandRangeWithAttachedPunctuation(text, range) {
  const source = String(text == null ? '' : text);
  if (!range) return null;
  let start = Math.max(0, range.start);
  let end = Math.max(start, range.end);

  while (start > 0 && !isWhitespaceChar(source[start - 1]) && !isWordChar(source[start - 1])) {
    start -= 1;
  }
  while (end < source.length && !isWhitespaceChar(source[end]) && !isWordChar(source[end])) {
    end += 1;
  }

  return end > start ? { start, end } : null;
}

function getPunctuationRanges(text) {
  const source = String(text == null ? '' : text);
  const ranges = [];
  const re = /[^\sA-Za-z0-9_]+/g;
  let match;
  while ((match = re.exec(source))) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function getAnchorUnitRanges(text) {
  const source = String(text == null ? '' : text);
  const words = getWordRanges(source).map((range) => expandRangeWithAttachedPunctuation(source, range)).filter(Boolean);
  return words.length > 0 ? words : getPunctuationRanges(source);
}

function addSurroundingAnchorRanges(ranges, text, offset) {
  const units = getAnchorUnitRanges(text);
  if (units.length === 0) return;

  const position = Math.max(0, Math.min(String(text || '').length, Number(offset) || 0));
  let before = null;
  let after = null;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.end <= position) {
      before = unit;
      continue;
    }
    if (unit.start >= position) {
      after = unit;
      break;
    }
    before = unit;
    after = units[i + 1] || null;
    break;
  }
  if (!before && !after) before = units[units.length - 1];

  if (before) ranges.push(before);
  if (after && (!before || after.start !== before.start || after.end !== before.end)) ranges.push(after);
}

function getTokenText(source, tokens, start, end) {
  const first = tokens[start];
  const last = tokens[end - 1];
  return first && last ? String(source || '').slice(first.start, last.end) : '';
}

function getTokenStartOrEnd(tokens, index, fallback, edge = 'start') {
  const token = tokens[index];
  if (!token) return fallback;
  return edge === 'end' ? token.end : token.start;
}

function findDeletionAnchorRanges(oldText, newText) {
  const oldSource = String(oldText == null ? '' : oldText);
  const newSource = String(newText == null ? '' : newText);
  if (!oldSource || !newSource || oldSource === newSource) return [];

  const oldTokens = tokenizeTextWithOffsets(oldSource);
  const newTokens = tokenizeTextWithOffsets(newSource);
  const opcodes = diffArrays(
    oldTokens.map((token) => token.value),
    newTokens.map((token) => token.value),
  );
  const ranges = [];

  for (const op of opcodes) {
    if (op.tag === 'delete') {
      const oldSegment = getTokenText(oldSource, oldTokens, op.i1, op.i2);
      if (!hasDeletedWordSignal(oldSegment, '')) continue;
      addSurroundingAnchorRanges(
        ranges,
        newSource,
        getTokenStartOrEnd(newTokens, op.j1, newSource.length),
      );
    } else if (op.tag === 'replace') {
      const oldSegment = getTokenText(oldSource, oldTokens, op.i1, op.i2);
      const newSegment = getTokenText(newSource, newTokens, op.j1, op.j2);
      if (hasNewWordSignal(oldSegment, newSegment) || !hasDeletedWordSignal(oldSegment, newSegment)) continue;
      addSurroundingAnchorRanges(
        ranges,
        newSource,
        getTokenStartOrEnd(newTokens, op.j2 - 1, newSource.length, 'end'),
      );
    }
  }

  return mergeRanges(ranges);
}

function findInsertedTextRanges(oldText, newText) {
  const oldSource = String(oldText == null ? '' : oldText);
  const newSource = String(newText == null ? '' : newText);
  if (!newSource) return [];
  if (!oldSource) {
    const full = trimWhitespaceRange(newSource, 0, newSource.length);
    return full ? [full] : [];
  }

  const oldTokens = tokenizeTextWithOffsets(oldSource);
  const newTokens = tokenizeTextWithOffsets(newSource);
  const opcodes = diffArrays(
    oldTokens.map((token) => token.value),
    newTokens.map((token) => token.value),
  );
  const ranges = [];
  for (const op of opcodes) {
    if (op.tag !== 'insert' && op.tag !== 'replace') continue;
    const first = newTokens[op.j1];
    const last = newTokens[op.j2 - 1];
    if (!first || !last) continue;
    if (op.tag === 'replace') {
      const oldFirst = oldTokens[op.i1];
      const oldLast = oldTokens[op.i2 - 1];
      const oldSegment = oldFirst && oldLast ? oldSource.slice(oldFirst.start, oldLast.end) : '';
      const newSegment = newSource.slice(first.start, last.end);
      if (!hasNewWordSignal(oldSegment, newSegment)) continue;
    }
    const range = trimWhitespaceRange(newSource, first.start, last.end);
    if (range) ranges.push(range);
  }
  return mergeRangesAcrossWhitespace(ranges, newSource);
}

module.exports = {
  diffArrays,
  findDeletionAnchorRanges,
  findInsertedTextRanges,
  getLineDiffOpcodes,
  hasNewWordSignal,
  tokenizeTextWithOffsets,
};
