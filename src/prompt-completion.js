// Recover an @ completion only from the input row where its query was typed.
// No CLI names, output-wide file collection, or private conversation formats.
// Rows/markers that do not match are deliberately left to keystroke capture.

const MAX_ROWS = 80;
const MAX_CHARS = 32768;
const PROMPT_START = /^([ \t]*(?:[│┃|▎][ \t]*)?[>›❯❱→][ \t]+)(.*)$/u;
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

function beginMentionCompletion(typed, snapshot, retainedQuery = false) {
  const query = /(^|\s)@([^\s@]+)$/.exec(typed);
  if (!query) return null;
  const rows = promptRows(snapshot);
  const matches = rows.filter(row => normalize(row.text) === normalize(typed));
  if (matches.length !== 1) return null;
  const anchor = matches[0];
  // The latest row with this exact prompt gutter must be the composer.
  // This also declines menus that use the same gutter as the input.
  if (rows.filter(row => row.prefix === anchor.prefix).at(-1) !== anchor) return null;
  return {
    type: snapshot.type, row: anchor.row, prefix: anchor.prefix,
    before: typed.slice(0, query.index + query[1].length),
    query: query[2], typedPrefix: retainedQuery ? typed : '',
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
  const text = normalize(row.text);
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

module.exports = { readPromptSnapshot, beginMentionCompletion, recoverMentionCompletion };
