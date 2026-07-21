const { selectionLabel, commentOnSelectionLabel, markSelectionsInText } = require('./comment-format');

const DEFAULT_SELECTION_CONTEXT_LINES = 0;
const DEFAULT_MAX_LINE_CHARS = 500;
const DEFAULT_MAX_COMMENT_CHARS = 4000;
const DEFAULT_MAX_SELECTION_SOURCE_CHARS = 4000;
const DEFAULT_SELECTION_SNIPPET_CHARS = 260;
const BROAD_SELECTION_CHAR_LIMIT = 240;
const BROAD_SELECTION_WORD_LIMIT = 45;

function truncateText(value, maxChars = DEFAULT_MAX_LINE_CHARS) {
  const text = String(value == null ? '' : value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function normalizeOutputLine(value, maxChars = DEFAULT_MAX_LINE_CHARS) {
  return truncateText(String(value == null ? '' : value).replace(/\s+$/g, ''), maxChars);
}

function normalizeComment(value, maxChars = DEFAULT_MAX_COMMENT_CHARS) {
  return truncateText(String(value == null ? '' : value).trim(), maxChars);
}

function normalizeNewlines(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function normalizeLineEntry(line, fallbackRow, maxChars = DEFAULT_MAX_LINE_CHARS) {
  if (line && typeof line === 'object') {
    const row = Number.isFinite(line.row) ? line.row : fallbackRow;
    return {
      row,
      endRow: Number.isFinite(line.endRow) ? Math.max(row, line.endRow) : row,
      text: normalizeOutputLine(line.text, maxChars),
    };
  }
  return {
    row: fallbackRow,
    endRow: fallbackRow,
    text: normalizeOutputLine(line, maxChars),
  };
}

function normalizePoint(point, fallback = {}) {
  return {
    row: Number.isFinite(point && point.row) ? point.row : (Number.isFinite(fallback.row) ? fallback.row : 0),
    column: Number.isFinite(point && point.column) ? point.column : (Number.isFinite(fallback.column) ? fallback.column : 0),
  };
}

function comparePoint(a, b) {
  return a.row - b.row || a.column - b.column;
}

function normalizeSelectionRange(record) {
  const rawStart = record.selection && record.selection.start
    ? record.selection.start
    : {
        row: Number.isFinite(record.selectionStartRow) ? record.selectionStartRow : record.targetRow,
        column: Number.isFinite(record.selectionStartColumn) ? record.selectionStartColumn : 0,
      };
  const rawEnd = record.selection && record.selection.end
    ? record.selection.end
    : {
        row: Number.isFinite(record.selectionEndRow) ? record.selectionEndRow : rawStart.row,
        column: Number.isFinite(record.selectionEndColumn) ? record.selectionEndColumn : rawStart.column,
      };

  let start = normalizePoint(rawStart);
  let end = normalizePoint(rawEnd, start);
  if (comparePoint(end, start) < 0) {
    [start, end] = [end, start];
  }

  const selectedEndRow = end.column === 0 && end.row > start.row ? end.row - 1 : end.row;
  return {
    start,
    end,
    selectedEndRow,
  };
}

function normalizeLineComment(record, index) {
  const targetLine = normalizeLineEntry(record.targetLine, Number.isFinite(record.targetRow) ? record.targetRow : index);
  return {
    kind: 'line',
    index,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : index,
    comment: normalizeComment(record.comment),
    targetRow: targetLine.row,
    targetLine,
    startRow: targetLine.row,
    endRow: targetLine.endRow,
  };
}

function getSelectionSpanForRow(selection, row, text) {
  const { start, end, selectedEndRow } = selection;
  if (row < start.row || row > selectedEndRow) return null;

  const markerStart = row === start.row ? clampColumn(start.column, text) : 0;
  const markerEnd = row === end.row ? clampColumn(end.column, text) : text.length;
  if (markerEnd <= markerStart) return null;
  return {
    start: markerStart,
    end: markerEnd,
  };
}

function getSelectionSnippetBounds(text, span) {
  if (text.length <= DEFAULT_SELECTION_SNIPPET_CHARS) {
    return { start: 0, end: text.length };
  }

  const selectedLength = Math.max(0, span.end - span.start);
  if (selectedLength >= DEFAULT_SELECTION_SNIPPET_CHARS) {
    return {
      start: span.start,
      end: Math.min(text.length, span.start + DEFAULT_SELECTION_SNIPPET_CHARS),
    };
  }

  const remaining = DEFAULT_SELECTION_SNIPPET_CHARS - selectedLength;
  let start = Math.max(0, span.start - Math.floor(remaining / 2));
  let end = Math.min(text.length, span.end + Math.ceil(remaining / 2));

  if (end - start < DEFAULT_SELECTION_SNIPPET_CHARS && start > 0) {
    start = Math.max(0, end - DEFAULT_SELECTION_SNIPPET_CHARS);
  }
  if (end - start < DEFAULT_SELECTION_SNIPPET_CHARS && end < text.length) {
    end = Math.min(text.length, start + DEFAULT_SELECTION_SNIPPET_CHARS);
  }

  return { start, end };
}

function cropSelectionContextLines(contextLines, range) {
  const selection = {
    start: { ...range.start },
    end: { ...range.end },
    selectedEndRow: range.selectedEndRow,
  };

  const lines = contextLines.map((line) => {
    const span = getSelectionSpanForRow(range, line.row, line.text);
    if (!span) return normalizeLineEntry(line, line.row);

    const bounds = getSelectionSnippetBounds(line.text, span);
    if (bounds.start === 0 && bounds.end === line.text.length) {
      return normalizeLineEntry(line, line.row);
    }

    if (line.row === selection.start.row) {
      selection.start.column = Math.max(0, selection.start.column - bounds.start);
    }
    if (line.row === selection.end.row) {
      selection.end.column = Math.max(0, selection.end.column - bounds.start);
    }

    return normalizeLineEntry({
      ...line,
      text: line.text.slice(bounds.start, bounds.end),
    }, line.row);
  });

  return { contextLines: lines, selection };
}

function normalizeSelectionComment(record, index) {
  const range = normalizeSelectionRange(record);
  const fallbackStart = Math.min(range.start.row, range.selectedEndRow);
  const rawLines = Array.isArray(record.contextLines) ? record.contextLines : [];
  const contextLines = rawLines
    .map((line, i) => normalizeLineEntry(line, fallbackStart + i, DEFAULT_MAX_SELECTION_SOURCE_CHARS))
    .filter((line) => Number.isFinite(line.row));

  if (!contextLines.some((line) => line.row === range.start.row)) {
    contextLines.push(normalizeLineEntry(record.targetLine || record.selectedText || '', range.start.row, DEFAULT_MAX_SELECTION_SOURCE_CHARS));
  }

  const selectedText = normalizeNewlines(record.selectedText);
  if (isBroadSelectionComment(record, selectedText)) {
    const passageLines = getSelectedPassageLines(contextLines, range, selectedText);
    const rows = passageLines.map((line) => line.row).filter((row) => Number.isFinite(row));
    const endRows = passageLines.map((line) => line.endRow).filter((row) => Number.isFinite(row));
    const lastPassageLine = passageLines[passageLines.length - 1] || null;
    return {
      kind: 'passage',
      index,
      createdAt: Number.isFinite(record.createdAt) ? record.createdAt : index,
      comment: normalizeComment(record.comment),
      selectedText,
      selection: range,
      targetRow: rows.length ? Math.min(...rows) : range.start.row,
      passageLines,
      startRow: rows.length ? Math.min(...rows) : range.start.row,
      endRow: endRows.length ? Math.max(...endRows) : range.selectedEndRow,
      commentRow: lastPassageLine && Number.isFinite(lastPassageLine.row) ? lastPassageLine.row : range.selectedEndRow,
    };
  }

  const cropped = cropSelectionContextLines(contextLines, range);
  const rows = cropped.contextLines.map((line) => line.row).filter((row) => Number.isFinite(row));
  const endRows = cropped.contextLines.map((line) => line.endRow).filter((row) => Number.isFinite(row));
  const startRow = rows.length ? Math.min(...rows) : range.start.row;
  const endRow = endRows.length ? Math.max(...endRows) : range.selectedEndRow;

  return {
    kind: 'selection',
    index,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : index,
    comment: normalizeComment(record.comment),
    selectedText,
    selection: cropped.selection,
    targetRow: cropped.selection.start.row,
    contextLines: cropped.contextLines,
    startRow,
    endRow,
  };
}

function normalizeCommentRecord(record, index) {
  if (!record || typeof record !== 'object') return null;
  const normalized = record.kind === 'selection' || record.kind === 'passage'
    ? normalizeSelectionComment(record, index)
    : normalizeLineComment(record, index);
  return normalized.comment ? normalized : null;
}

function isBroadSelectionComment(record, selectedText) {
  // A hard newline alone does not make a selection broad. The precise path can
  // span rows while preserving its boundary context; passage mode is reserved
  // for explicit intent or a selection large enough to need compact output.
  return record.selectionMode === 'passage'
    || record.targetKind === 'passage'
    || record.kind === 'passage'
    || String(selectedText || '').length > BROAD_SELECTION_CHAR_LIMIT
    || countWords(selectedText) > BROAD_SELECTION_WORD_LIMIT;
}

function getSelectedPassageLines(contextLines, range, selectedText) {
  const lines = contextLines
    .map((line) => {
      const span = getSelectionSpanForRow(range, line.row, line.text);
      if (!span) return null;
      return normalizeLineEntry({
        row: line.row,
        endRow: line.endRow,
        text: line.text.slice(span.start, span.end),
      }, line.row, DEFAULT_MAX_SELECTION_SOURCE_CHARS);
    })
    .filter(Boolean);

  if (lines.length > 0) return lines;

  return normalizeNewlines(selectedText)
    .split('\n')
    .map((text, index) => normalizeLineEntry({
      row: range.start.row + index,
      text,
    }, range.start.row + index, DEFAULT_MAX_SELECTION_SOURCE_CHARS));
}

function clampColumn(column, text) {
  return Math.max(0, Math.min(Number.isFinite(column) ? column : 0, text.length));
}

function markerForSelectionRow(selection, row, text, label, order) {
  const span = getSelectionSpanForRow(selection, row, text);
  if (!span) return null;
  return {
    label,
    order,
    opens: true,
    closes: true,
    start: span.start,
    end: span.end,
  };
}

function addRow(rows, row, text, endRow = row) {
  if (!Number.isFinite(row)) return;
  if (!rows.has(row)) {
    rows.set(row, {
      text: normalizeOutputLine(text),
      endRow: Number.isFinite(endRow) ? Math.max(row, endRow) : row,
    });
  }
}

function buildStreamModel(records) {
  const normalized = records
    .map((record, index) => normalizeCommentRecord(record, index))
    .filter(Boolean)
    .sort((a, b) => a.startRow - b.startRow || a.targetRow - b.targetRow || a.createdAt - b.createdAt);

  const rows = new Map();
  const selectionMarkersByRow = new Map();
  const commentsByRow = new Map();
  const selectionCount = normalized.filter((comment) => comment.kind === 'selection' || comment.kind === 'passage').length;
  let selectionNumber = 0;

  const addComment = (row, comment) => {
    if (!commentsByRow.has(row)) commentsByRow.set(row, []);
    commentsByRow.get(row).push(comment);
  };

  for (const comment of normalized) {
    if (comment.kind === 'selection' || comment.kind === 'passage') {
      selectionNumber += 1;
      comment.selectionNumber = selectionCount > 1 ? selectionNumber : null;
      comment.selectionLabel = selectionLabel(comment.selectionNumber);
    }

    if (comment.kind === 'selection') {
      for (const line of comment.contextLines) {
        addRow(rows, line.row, line.text, line.endRow);
      }
      const selectionMarkers = comment.contextLines
        .map((line) => ({
          line,
          marker: markerForSelectionRow(comment.selection, line.row, line.text, comment.selectionLabel, selectionNumber),
        }))
        .filter((entry) => entry.marker);
      for (let i = 0; i < selectionMarkers.length; i++) {
        const { line, marker } = selectionMarkers[i];
        marker.opens = i === 0;
        marker.closes = i === selectionMarkers.length - 1;
        if (!selectionMarkersByRow.has(line.row)) selectionMarkersByRow.set(line.row, []);
        selectionMarkersByRow.get(line.row).push(marker);
      }
      addComment(comment.selection.selectedEndRow, comment);
    } else if (comment.kind === 'passage') {
      for (const line of comment.passageLines) {
        addRow(rows, line.row, line.text, line.endRow);
      }
      const selectionMarkers = comment.passageLines
        .map((line) => ({
          line,
          marker: line.text.length > 0
            ? {
                label: comment.selectionLabel,
                order: selectionNumber,
                opens: true,
                closes: true,
                start: 0,
                end: line.text.length,
              }
            : null,
        }))
        .filter((entry) => entry.marker);
      for (let i = 0; i < selectionMarkers.length; i++) {
        const { line, marker } = selectionMarkers[i];
        marker.opens = i === 0;
        marker.closes = i === selectionMarkers.length - 1;
        if (!selectionMarkersByRow.has(line.row)) selectionMarkersByRow.set(line.row, []);
        selectionMarkersByRow.get(line.row).push(marker);
      }
      addComment(comment.commentRow, comment);
    } else {
      addRow(rows, comment.targetLine.row, comment.targetLine.text, comment.targetLine.endRow);
      addComment(comment.targetLine.row, comment);
    }
  }

  for (const comments of commentsByRow.values()) {
    comments.sort((a, b) => a.createdAt - b.createdAt || a.index - b.index);
  }

  return { rows, selectionMarkersByRow, commentsByRow };
}

function leadingWhitespaceLength(text) {
  const match = String(text || '').match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

function getCommonLeadingTrim(rows, selectionMarkersByRow) {
  const rowEntries = Array.from(rows.values())
    .filter((entry) => String(entry.text || '').trim() !== '');
  if (rowEntries.length === 0) return 0;

  let trim = Infinity;
  for (const entry of rowEntries) {
    trim = Math.min(trim, leadingWhitespaceLength(entry.text));
  }

  for (const markers of selectionMarkersByRow.values()) {
    for (const marker of markers) {
      if (marker && Number.isFinite(marker.start)) {
        trim = Math.min(trim, marker.start);
      }
    }
  }

  return Number.isFinite(trim) ? Math.max(0, trim) : 0;
}

function applyCommonLeadingTrim(rows, selectionMarkersByRow) {
  const trim = getCommonLeadingTrim(rows, selectionMarkersByRow);
  if (trim <= 0) return;

  for (const entry of rows.values()) {
    entry.text = String(entry.text || '').slice(trim);
  }

  for (const markers of selectionMarkersByRow.values()) {
    for (const marker of markers) {
      marker.start = Math.max(0, marker.start - trim);
      marker.end = Math.max(marker.start, marker.end - trim);
    }
  }
}

function formatCommentAttachment(comment, { compactLineCommentLabel = false } = {}) {
  const lines = [];
  if (comment.kind === 'selection' || comment.kind === 'passage') {
    lines.push(commentOnSelectionLabel(comment.selectionNumber));
  } else {
    lines.push(compactLineCommentLabel ? '[Comment]' : '[Comment on line above]');
  }
  lines.push(normalizeNewlines(comment.comment));
  lines.push('[/Comment]');
  return lines;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function formatTerminalCommentHeading(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const commentCount = list.filter((comment) => comment && normalizeComment(comment.comment)).length;
  const selectionCount = list.filter((comment) => comment && (comment.kind === 'selection' || comment.kind === 'passage')).length;
  const commentLabel = pluralize(commentCount, 'comment');
  if (selectionCount === 0) return `My ${commentLabel} on terminal output:`;
  return `My ${pluralize(selectionCount, 'selection')} and ${commentLabel} on terminal output:`;
}

function buildTerminalCommentBatchMessage(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const { rows, selectionMarkersByRow, commentsByRow } = buildStreamModel(list);
  applyCommonLeadingTrim(rows, selectionMarkersByRow);
  const sortedRows = Array.from(rows.keys()).sort((a, b) => a - b);
  const lines = [formatTerminalCommentHeading(list)];

  if (sortedRows.length === 0) {
    return lines.join('\n');
  }

  lines.push('...');
  const totalComments = Array.from(commentsByRow.values()).reduce((sum, commentsForRow) => sum + commentsForRow.length, 0);
  const compactLineCommentLabel = totalComments === 1 && sortedRows.length === 1;
  let previousEndRow = null;
  for (const row of sortedRows) {
    if (previousEndRow != null && row > previousEndRow + 1) {
      lines.push('...');
    }

    const rowEntry = rows.get(row) || { text: '', endRow: row };
    const text = rowEntry.text || '';
    const markers = selectionMarkersByRow.get(row) || [];
    lines.push(markSelectionsInText(text, markers));

    const commentsForRow = commentsByRow.get(row) || [];
    for (const comment of commentsForRow) {
      lines.push(...formatCommentAttachment(comment, {
        compactLineCommentLabel: compactLineCommentLabel && comment.kind === 'line',
      }));
    }

    previousEndRow = Math.max(previousEndRow == null ? row : previousEndRow, rowEntry.endRow);
  }
  lines.push('...');

  return lines.map(normalizeNewlines).join('\n');
}

function buildTerminalCommentMessage(input) {
  return buildTerminalCommentBatchMessage([input]);
}

module.exports = {
  DEFAULT_SELECTION_CONTEXT_LINES,
  buildTerminalCommentBatchMessage,
  buildTerminalCommentMessage,
  normalizeOutputLine,
};
