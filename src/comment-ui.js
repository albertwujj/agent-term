// Shared DOM helpers for the comment UI across review / md / terminal. Pure DOM,
// no node deps, so esbuild can bundle it into BOTH the renderer and the webview
// preload — one implementation across the host/guest boundary (that's why the
// preload is now bundled). First pieces below; the composer, the "type to
// comment" affordance, and the highlight-in-place anchor join here as each
// surface is ported onto it.

function normWS(s) {
  return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
}

// The nearest authored heading above a node, within its prose / commit-message
// container — the agent's own words for anchoring a prose comment (never a host
// label). Returns '' when there's no enclosing heading.
function nearestHeading(node) {
  const start = node && (node.nodeType === 1 ? node : node.parentElement);
  const root = start && start.closest && start.closest('.md-render, #commit');
  if (!root) return '';
  const heads = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
  let best = '';
  for (let i = 0; i < heads.length; i++) {
    if (heads[i].compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING) best = normWS(heads[i].textContent);
    else break;
  }
  return best;
}

let toastStyled = false;
function toast(msg) {
  if (!toastStyled) {
    toastStyled = true;
    const st = document.createElement('style');
    st.textContent = '.cu-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);'
      + 'z-index:2147483001;background:#1f2328;color:#fff;padding:7px 14px;border-radius:6px;'
      + 'font:12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
      + 'box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:1;transition:opacity 320ms ease}'
      + '.cu-toast-out{opacity:0}';
    document.head.appendChild(st);
  }
  const t = document.createElement('div');
  t.className = 'cu-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function () { t.classList.add('cu-toast-out'); }, 1600);
  setTimeout(function () { t.remove(); }, 2000);
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

let composerStyled = false;
function ensureComposerStyle() {
  if (composerStyled || typeof document === 'undefined') return;
  composerStyled = true;
  const st = document.createElement('style');
  st.textContent = [
    '.cu-composer{max-width:780px;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2328}',
    '.cu-qprev{font-size:11px;color:#59636e;border-left:3px solid #d1d9e0;padding:2px 8px;margin-bottom:5px;max-height:48px;overflow:auto}',
    '.cu-anchor{color:#59636e;font-size:11px;margin-bottom:4px}',
    '.cu-ta{width:100%;box-sizing:border-box;border:1px solid #d1d9e0;border-radius:6px;background:#fff;padding:6px 8px;',
    'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2328;resize:vertical}',
    '.cu-ta:focus{outline:none;border-color:#0969da;box-shadow:0 0 0 3px rgba(9,105,218,.18)}',
    '.cu-actions{display:flex;gap:8px;margin-top:6px}',
    '.cu-btn{border:1px solid #d1d9e0;border-radius:6px;background:#f6f8fa;color:#1f2328;padding:3px 12px;',
    'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}',
    '.cu-btn:hover{background:#eef1f4}',
    '.cu-btn.cu-primary{background:#1f883d;border-color:#1a7f37;color:#fff}',
    '.cu-btn.cu-primary:hover{background:#1a7f37}',
    '.cu-btn:disabled{opacity:.5;cursor:default}',
    // The keyboard shortcut is a hint, not part of the action word: subordinate it.
    '.cu-btn .cu-kbd{margin-left:7px;opacity:.62;font-weight:400;font-size:11px}',
    // Dark variant (.cu-dark) — for composers floating over the terminal, where
    // the light palette would clash. Matches the old terminal-comment colors.
    '.cu-dark{color:#e8eaed}',
    '.cu-dark .cu-ta{background:#151619;color:#f1f3f4;border-color:rgba(255,255,255,.16)}',
    '.cu-dark .cu-ta:focus{border-color:rgba(138,180,248,.72);box-shadow:0 0 0 2px rgba(138,180,248,.16)}',
    '.cu-dark .cu-btn{background:transparent;color:#e8eaed;border-color:rgba(255,255,255,.14)}',
    '.cu-dark .cu-btn:hover{background:rgba(255,255,255,.08)}',
    '.cu-dark .cu-btn.cu-primary{background:#8ab4f8;border-color:#8ab4f8;color:#0c0c0c}',
    '.cu-dark .cu-btn.cu-primary:hover{background:#9cc0ff}',
    '.cu-dark .cu-qprev{color:#9aa0a6;border-color:rgba(255,255,255,.18)}',
    '.cu-dark .cu-anchor{color:#9aa0a6}',
  ].join('');
  document.head.appendChild(st);
}

// The modifier-Enter chord as the user reads it on their platform. Cmd/Ctrl+
// Enter is the one chord the composers advertise: it fires the To prompt
// action (below), the only key a first use would not teach.
function isMac() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(String(navigator.platform || ''));
}
function modEnterLabel() { return isMac() ? '⌘↩' : 'Ctrl↩'; }
function isModEnter(e) {
  return e.key === 'Enter' && (isMac() ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey;
}
// Shift+mod+Enter is Send from anywhere: page-wide in the md viewer, and in
// any composer (below) so a button advertising it works wherever focus sits.
function shiftModEnterLabel() { return isMac() ? '⇧⌘↩' : 'Ctrl⇧↩'; }
function isShiftModEnter(e) {
  return e.key === 'Enter' && (isMac() ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey;
}
// Mod+letter chords for the few composer actions a letter can name (⌘E: edit
// instead). Platform-strict like the Enter chords: on a Mac, Ctrl+letter keeps
// its native text-field meaning (Ctrl+E is end-of-line there).
function modKeyLabel(letter) { return (isMac() ? '⌘' : 'Ctrl+') + String(letter).toUpperCase(); }
function isModKey(e, letter) {
  if (!e || typeof e.key !== 'string' || e.key.toLowerCase() !== String(letter).toLowerCase()) return false;
  if (e.shiftKey || e.altKey) return false;
  return isMac() ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
}

// The To prompt action, shared by every composer: Send's sibling that pastes
// the same message into the CLI input and leaves it there, cursor on a fresh
// line, for the user to finish typing (an overall comment, say) and press
// Enter themselves. Quiet like Discard; carries its chord, since nothing else
// would teach it. Send carries no key: Enter is the CLI's own, learned once.
function toPromptAction(onClick) {
  return {
    label: 'To prompt',
    shortcut: modEnterLabel(),
    modEnter: true,
    title: 'Put the message in the prompt without sending; type the rest there and press Enter',
    onClick: onClick,
  };
}

// One composer widget for all comment surfaces: optional quote + heading preview,
// a textarea (seeded, focus-at-end), and action buttons. Key contract: plain
// Enter fires the primary action; Shift/Alt+Enter = newline; Esc = onCancel;
// Cmd/Ctrl+Enter fires the action flagged modEnter (see toPromptAction); an
// action carrying `key: 'e'` fires on Cmd/Ctrl+E (see isModKey).
// Each action's onClick gets { root, textarea } so the caller can disable buttons
// and read the value. Optional onInput(ctx) fires on every keystroke (autogrow /
// fit / footer for the queue surfaces). Returns { root, textarea, primaryButton,
// focus }; the caller mounts root (inline node or floating panel) — placement
// stays per-surface.
function createComposer({ quote = '', anchorLabel = '', placeholder = '', seed = '', rows = 3, actions = [], onCancel, onInput, theme = 'light' } = {}) {
  ensureComposerStyle();
  const root = document.createElement('div');
  root.className = 'cu-composer' + (theme === 'dark' ? ' cu-dark' : '');
  let html = '';
  if (quote) html += '<div class="cu-qprev">' + escHtml(quote) + '</div>';
  if (anchorLabel) html += '<div class="cu-anchor">' + escHtml(anchorLabel) + '</div>';
  html += '<textarea class="cu-ta" rows="' + rows + '"></textarea>'
    + '<div class="cu-actions">'
    + actions.map(function (a, i) {
        return '<button class="cu-btn' + (a.primary ? ' cu-primary' : '') + '" data-i="' + i + '"'
          + (a.title ? ' title="' + escHtml(a.title) + '"' : '') + '>'
          + escHtml(a.label) + (a.shortcut ? '<span class="cu-kbd">' + escHtml(a.shortcut) + '</span>' : '') + '</button>';
      }).join('')
    + '</div>';
  root.innerHTML = html;
  const ta = root.querySelector('textarea');
  ta.placeholder = placeholder;
  if (seed) ta.value = seed;
  const ctx = { root: root, textarea: ta };
  const primary = actions.find(function (a) { return a.primary; });
  const modEnter = actions.find(function (a) { return a.modEnter; });
  const keyed = actions.filter(function (a) { return typeof a.key === 'string' && a.key.length === 1; });
  actions.forEach(function (a, i) {
    root.querySelector('[data-i="' + i + '"]').onclick = function () { a.onClick(ctx); };
  });
  ta.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); if (onCancel) onCancel(); return; }
    if (modEnter && isModEnter(e)) { e.preventDefault(); modEnter.onClick(ctx); return; }
    const byKey = keyed.find(function (a) { return isModKey(e, a.key); });
    if (byKey) { e.preventDefault(); byKey.onClick(ctx); return; }
    if (primary && isShiftModEnter(e)) { e.preventDefault(); primary.onClick(ctx); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && primary) { e.preventDefault(); primary.onClick(ctx); }
  });
  if (onInput) ta.addEventListener('input', function () { onInput(ctx); });
  return {
    root: root,
    textarea: ta,
    primaryButton: primary ? root.querySelector('.cu-primary') : null,
    focus: function () { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); },
  };
}

let highlightStyled = false;
function ensureHighlightStyle() {
  if (highlightStyled || typeof document === 'undefined') return;
  highlightStyled = true;
  const st = document.createElement('style');
  st.textContent = '::highlight(cu-sel),::highlight(cu-anchor){background:rgba(250,204,21,.4)}';
  document.head.appendChild(st);
}

// Mark a range in place via the CSS Custom Highlight API — the anchored text
// stays visually highlighted (while composing, and ideally after) instead of
// being repeated as a quote in the composer. No-op where the API is absent.
function highlightRange(range) {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined' || !range) return;
  ensureHighlightStyle();
  try { CSS.highlights.set('cu-sel', new Highlight(range)); } catch (e) { /* ignore */ }
}
function clearHighlight() {
  try { if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('cu-sel'); } catch (e) { /* ignore */ }
}

// Set a named, possibly multi-range highlight — used to mark every submitted
// comment's exact anchored text (cu-anchor), the same yellow as the live
// selection (cu-sel). Empty ranges clears it.
function highlightRanges(name, ranges) {
  try {
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    if (!ranges || !ranges.length || typeof Highlight === 'undefined') { CSS.highlights.delete(name); return; }
    ensureHighlightStyle();
    CSS.highlights.set(name, new Highlight(...ranges));
  } catch (e) { /* ignore */ }
}

// A Range covering `snippet` (whitespace-normalized) within root's text, so the
// EXACT anchored text can be highlighted instead of the whole block. Walks text
// nodes building a normalized string with a per-char map back to (node, offset).
// null when the text isn't found (e.g. it changed since the comment was made).
function rangeOfText(root, snippet) {
  if (typeof document === 'undefined' || !root) return null;
  const snip = normWS(snippet);
  if (!snip) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let norm = '';
  const map = []; // map[i] -> { node, offset } for norm[i]
  let prevSpace = true; // collapse runs + left-trim, matching normWS
  let node;
  while ((node = walker.nextNode())) {
    const s = node.data;
    for (let j = 0; j < s.length; j++) {
      if (/\s/.test(s[j])) {
        if (prevSpace) continue;
        norm += ' '; map.push({ node: node, offset: j }); prevSpace = true;
      } else {
        norm += s[j]; map.push({ node: node, offset: j }); prevSpace = false;
      }
    }
  }
  const idx = norm.indexOf(snip);
  if (idx === -1) return null;
  const a = map[idx];
  const b = map[idx + snip.length - 1];
  if (!a || !b) return null;
  try {
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset + 1);
    return range;
  } catch (e) { return null; }
}

// Cmd/Ctrl+V while a "Type to comment" affordance is armed: open the composer
// seeded with the clipboard instead of letting the paste fall through (to the
// shell, or nowhere). Either modifier on every platform — with a selection
// armed, the paste can only mean "comment this"; no shift/alt so real chords
// (Ctrl+Shift+V etc.) stay untouched.
function isPasteCommentShortcut(event) {
  if (!event || typeof event.key !== 'string') return false;
  if (event.key.toLowerCase() !== 'v') return false;
  if (event.altKey || event.shiftKey) return false;
  return (event.metaKey && !event.ctrlKey) || (event.ctrlKey && !event.metaKey);
}

module.exports = {
  normWS, nearestHeading, toast, createComposer, toPromptAction, modEnterLabel, isModEnter, shiftModEnterLabel,
  modKeyLabel, isModKey,
  highlightRange, clearHighlight, highlightRanges, rangeOfText,
  isPasteCommentShortcut,
  isMac,
};
