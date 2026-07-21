// Shared bits of the agent-message envelope for review / md / terminal comments,
// so the three surfaces read consistently and pluralize the same way. This is the
// first shared piece of the comment-ui unification; the composer/affordance/
// highlight join it as each surface is ported.
//
// Convention (matches what md + terminal already emit): the lead is
//   "My comment on <surface>:"   for one, and
//   "My comments on <surface>:"  for more than one
// — comment vs comments by count, and NO count number (the agent reads the
// threads/store for specifics). <surface> is "markdown document", "terminal
// output", or "review://<package>".

function pluralize(n, word) {
  return n === 1 ? word : `${word}s`;
}

function commentHeader(surface, count = 1) {
  return `My ${pluralize(Math.max(1, count || 1), 'comment')} on ${surface}:`;
}

// The selection-marker vocabulary: [selected]…[/selected], or a numbered pair
// like [selected 2]…[/selected 2] when a batch carries several selections. All
// surfaces emit tags through here so the convention can't drift.
function selectionTag(label = 'selected', closing = false) {
  return `[${closing ? '/' : ''}${label}]`;
}

// The label inside the tags: 'selected', or 'selected N' when a context carries
// several selections (numbering only when needed).
function selectionLabel(n) {
  return n == null ? 'selected' : `selected ${n}`;
}

// The comment-block opener paired with a numbered selection; the closer is
// always the plain '[/Comment]'.
function commentOnSelectionLabel(n) {
  return n == null ? '[Comment on selection]' : `[Comment on selection ${n}]`;
}

// Splice selection tags into `text` at span offsets — the one implementation of
// marker placement for every surface. Spans are {start, end, label?, opens?,
// closes?, order?}: offsets are clamped to the text, overlapping spans are
// skipped (first-sorted wins), opens/closes default true (the terminal uses
// them for selections spanning wrapped rows). Callers own span DISCOVERY —
// grid coordinates for the terminal, text offsets for md/review — this owns
// only the splicing, so the emitted convention has a single home.
function markSelectionsInText(text, spans) {
  const s = String(text == null ? '' : text);
  const sorted = (spans || [])
    .filter((span) => span && span.end > span.start)
    .sort((a, b) => a.start - b.start || b.end - a.end || (a.order || 0) - (b.order || 0));
  let output = '';
  let cursor = 0;
  for (const span of sorted) {
    const start = Math.max(0, Math.min(Number.isFinite(span.start) ? span.start : 0, s.length));
    const end = Math.max(0, Math.min(Number.isFinite(span.end) ? span.end : 0, s.length));
    if (end <= start || start < cursor) continue;
    const open = span.opens !== false ? selectionTag(span.label) : '';
    const close = span.closes !== false ? selectionTag(span.label, true) : '';
    output += s.slice(cursor, start) + open + s.slice(start, end) + close;
    cursor = end;
  }
  return output + s.slice(cursor);
}

// Mark the first occurrence of `selected` inside `context` in place —
//   "…integrated, [selected]open[/selected], and yours…"
// — the single-selection case of markSelectionsInText, for callers holding a
// text blob rather than offsets. Returns null when `selected` isn't in
// `context`; each caller keeps its own fallback. indexOf rather than
// String.replace: the selection is document text and may contain replacement
// patterns like `$&`.
function markSelectionInContext(context, selected) {
  const ctx = String(context == null ? '' : context);
  const sel = String(selected == null ? '' : selected);
  if (!sel) return null;
  const at = ctx.indexOf(sel);
  if (at === -1) return null;
  return markSelectionsInText(ctx, [{ start: at, end: at + sel.length }]);
}

module.exports = {
  pluralize, commentHeader,
  selectionTag, selectionLabel, commentOnSelectionLabel,
  markSelectionsInText, markSelectionInContext,
};
