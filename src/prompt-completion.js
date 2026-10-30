// Recover an @ completion only from the input row where its query was typed.
// No CLI names, output-wide file collection, or private conversation formats.
// Rows/markers that do not match are deliberately left to keystroke capture.

const MAX_ROWS = 80;
const MAX_CHARS = 32768;
// The space after the marker can be a no-break one: Claude Code draws it.
const PROMPT_START = /^([ \t]*(?:[│┃|▎][ \t]*)?[>›❯❱→][ \t\u00a0]+)(.*)$/u;
// All a composer row can start with besides text: a box edge, a marker, both.
// Copilot's rows have only the edge.
const PROMPT_GUTTER = /^[ \t]*(?:[│┃|▎][ \t]*)?(?:[>›❯❱→][ \t\u00a0]*)?/u;
const GUTTERED_ROW = /^[ \t]*(?:[│┃|▎]|[>›❯❱→][ \t\u00a0])/u;
const normalize = text => text.replace(/\s+/g, ' ').trim();

function readPromptSnapshot(terminal) {
  const buffer = terminal && terminal.buffer && terminal.buffer.active;
  if (!buffer || typeof buffer.getLine !== 'function') return null;
  const end = Math.min(buffer.length, buffer.baseY + terminal.rows);
  const begin = Math.max(buffer.baseY, end - MAX_ROWS);
  const lines = [];
  let chars = 0;
  for (let row = begin; row < end; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const next = row + 1 < end ? buffer.getLine(row + 1) : null;
    const text = line.translateToString(!(next && next.isWrapped));
    chars += text.length;
    if (chars > MAX_CHARS) return null;
    if (line.isWrapped) {
      // A viewport beginning in the middle of a wrapped prompt cannot
      // supply its marker, so never invent a head for that continuation.
      if (lines.length) lines[lines.length - 1].text += text;
    } else {
      lines.push({ row, text });
    }
  }
  return { type: buffer.type, lines };
}

function textBeforeCaret(line, col) {
  return line.isWrapped || /\S/.test(line.translateToString(false, 0, col).replace(PROMPT_GUTTER, ''));
}

// Whether the composer of the running CLI holds text that a message pasted at
// its caret would run into: anything before the caret on its row. A placeholder
// follows the caret, and a caret on an empty row under earlier text is already
// on a line of its own. Read off the screen, not the keystrokes: a CLI can empty
// its composer (Esc Esc) or fill it (history) without those bytes saying so.
// Ask only while a CLI runs: at a bare shell its own prompt would read as text.
function promptHoldsInput(terminal) {
  const buffer = terminal && terminal.buffer && terminal.buffer.active;
  if (!buffer || typeof buffer.getLine !== 'function') return false;
  if (!terminal._core?.coreService?.isCursorHidden) {
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    return !!line && textBeforeCaret(line, buffer.cursorX);
  }
  // A CLI can hide the terminal's cursor and draw its own caret, an inverted
  // cell in the composer. Unfocused it may show neither, as Cursor Agent and
  // Copilot do, which leaves the last row with a gutter to answer: the composer
  // is the bottom of the screen. Its placeholder is the dim part.
  const end = Math.min(buffer.length, buffer.baseY + terminal.rows);
  let anchor = -1;
  for (let row = end - 1; row >= buffer.baseY && anchor < 0; row--) {
    const line = buffer.getLine(row);
    if (line && GUTTERED_ROW.test(line.translateToString(false))) anchor = row;
  }
  if (anchor < 0) return false;
  const cell = buffer.getNullCell();
  for (let row = anchor; row < end; row++) {
    const line = buffer.getLine(row);
    for (let col = 0; line && col < line.length; col++) {
      line.getCell(col, cell);
      if (cell.isInverse()) return textBeforeCaret(line, col);
    }
  }
  const line = buffer.getLine(anchor);
  const gutter = PROMPT_GUTTER.exec(line.translateToString(false))[0].length;
  let typed = '';
  for (let col = gutter; col < line.length; col++) {
    line.getCell(col, cell);
    if (!cell.isDim()) typed += cell.getChars();
  }
  return /\S/.test(typed.replace(/[│┃|▎][ \t]*$/, ''));
}

function promptRows(snapshot) {
  if (!snapshot || !['normal', 'alternate'].includes(snapshot.type) ||
      !Array.isArray(snapshot.lines) || snapshot.lines.length > MAX_ROWS) return [];
  const rows = [];
  let chars = 0;
  for (const [index, line] of snapshot.lines.entries()) {
    if (!line || !Number.isInteger(line.row) || typeof line.text !== 'string') return [];
    chars += line.text.length;
    if (chars > MAX_CHARS) return [];
    const match = PROMPT_START.exec(line.text);
    if (match) rows.push({
      row: line.row, prefix: match[1],
      text: match[2].replace(/[ \t]+[│┃|▎][ \t]*$/, '').trimEnd(),
      nextText: snapshot.lines[index + 1]?.text || '',
    });
  }
  return rows;
}

// The @ token a Tab or an Enter hands to the picker: the text in front of it,
// and the query itself. The CLI expands the token in place, so from that key
// on the bytes held for it are the query, not what the user submitted.
function mentionTokenAt(typed) {
  const query = /(^|\s)@([^\s@]+)$/.exec(typed);
  if (!query) return null;
  return { before: typed.slice(0, query.index + query[1].length), query: query[2] };
}

function beginMentionCompletion(typed, snapshot, retainedQuery = false, opts = {}) {
  const token = mentionTokenAt(typed);
  if (!token) return null;
  const rows = promptRows(snapshot);
  const normalizedTyped = normalize(typed);
  const matches = [];
  for (const row of rows) {
    const rowText = normalize(row.text);
    if (rowText === normalizedTyped) {
      matches.push({ row, leadingText: '' });
      continue;
    }
    // A clipboard image is transported to the CLI as a path, but the CLI may
    // render that path as an attachment chip. Prompt capture deliberately
    // excludes the transport path from its text. When it tells us an
    // attachment precedes this query, anchor the exact textual tail while
    // retaining all the usual row/type/gutter checks below. Never enable this
    // for ordinary prompts: a suffix match without known attachment provenance
    // would let output or a picker suggestion masquerade as the composer.
    if (opts.allowLeadingContent && normalizedTyped && rowText.endsWith(normalizedTyped)) {
      matches.push({
        row,
        leadingText: rowText.slice(0, rowText.length - normalizedTyped.length),
      });
    }
  }
  if (matches.length !== 1) return null;
  const { row: anchor, leadingText } = matches[0];
  // The latest row with this exact prompt gutter must be the composer.
  // This also declines menus that use the same gutter as the input.
  if (rows.filter(row => row.prefix === anchor.prefix).at(-1) !== anchor) return null;
  return {
    type: snapshot.type, row: anchor.row, prefix: anchor.prefix,
    before: token.before, query: token.query,
    typedPrefix: retainedQuery ? typed : '',
    leadingText,
  };
}

function queryMatches(query, mention) {
  if (query === mention) return false; // still the query, not a completion
  // File pickers can fuzzy-match a basename anywhere within its path.
  // Matching as a subsequence tolerates that without resolving a filename
  // on disk or replacing it with a guessed absolute path.
  const wanted = Array.from(query.toLowerCase());
  let index = 0;
  for (const ch of mention.toLowerCase()) if (ch === wanted[index]) index++;
  return index === wanted.length;
}

function recoverMentionCompletion(typed, completion, snapshot) {
  if (!completion || !snapshot || snapshot.type !== completion.type ||
      !typed.startsWith(completion.typedPrefix)) return null;
  const rows = promptRows(snapshot).filter(row => row.prefix === completion.prefix);
  const row = rows.at(-1);
  if (!row || row.row !== completion.row) return null;

  const before = normalize(completion.before);
  let text = normalize(row.text);
  if (completion.leadingText) {
    if (!text.startsWith(completion.leadingText)) return null;
    text = text.slice(completion.leadingText.length).trimStart();
  }
  if (before && !text.startsWith(before + ' ')) return null;
  const rest = before ? text.slice(before.length + 1) : text;
  const match = /^@([^\s@`'"]+)(?:\s+(.*))?$/.exec(rest);
  if (!match || !queryMatches(completion.query, match[1])) return null;
  const after = typed.slice(completion.typedPrefix.length);
  const visibleAfter = match[2] || '';
  // A token ending at a renderer hard-wrap is not a complete filename.
  // Soft wraps were joined by readPromptSnapshot. For an unmarked hard
  // continuation, decline instead of capturing the first path fragment.
  if (!visibleAfter && row.nextText.trim()) return null;
  // The echo can lag the last keystrokes/paste. It may be a prefix of the
  // bytes we have, but it may not contain any unrelated text. Only the @
  // token is recovered from the screen; the user's remaining bytes win.
  if (!normalize(after).startsWith(visibleAfter)) return null;
  return completion.before + '@' + match[1] +
    (after && !/^\s/.test(after) ? ' ' : '') + after;
}

// The fallback for a Tab whose completion recoverMentionCompletion could not
// read: no snapshot to sample, a composer that moved, evidence an edit
// dropped. Only the query reached these bytes, and the CLI has since replaced
// it, so it is removed instead of being left glued to the word typed after
// it — those words are the user's and stand on their own. Held bytes the
// composer still shows are kept whole: a Tab that completed nothing changed
// neither the screen nor the prompt. Returns the text to submit and the
// queries taken out of it, which the log names so the rate this path runs at
// is visible.
function dropUnrecoveredMentions(typed, tokens, snapshot, completion = null) {
  const dropped = [];
  if (!Array.isArray(tokens) || tokens.length === 0) return { text: typed, dropped };
  const shown = promptRows(snapshot).map(row => {
    let text = normalize(row.text);
    if (completion && completion.leadingText && text.startsWith(completion.leadingText)) {
      text = text.slice(completion.leadingText.length).trimStart();
    }
    return text;
  }).filter(Boolean);
  if (shown.some(text => normalize(typed).startsWith(text))) return { text: typed, dropped };
  let text = typed;
  for (const token of [...tokens].reverse()) {
    const held = token.before + '@' + token.query;
    if (!text.startsWith(held)) continue;
    const rest = text.slice(held.length);
    // Nothing followed the token: it is the whole prompt, which the bare-query
    // path already declines to name a session after.
    if (!rest.trim()) continue;
    text = token.before + rest.replace(/^[ \t]+/, '');
    dropped.unshift('@' + token.query);
  }
  return { text, dropped };
}

module.exports = {
  readPromptSnapshot, promptHoldsInput, beginMentionCompletion, recoverMentionCompletion,
  mentionTokenAt, dropUnrecoveredMentions,
};
