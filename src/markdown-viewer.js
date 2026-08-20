const {
  findAnchorForLine,
  getSectionHierarchyForLine,
  renderMarkdownDocument,
} = require('./markdown-render');
const {
  findDeletionAnchorRanges,
  findInsertedTextRanges,
  getLineDiffOpcodes,
} = require('./markdown-change-diff');
const { isFindShortcut } = require('./search-shortcut');
const { classifyMarkdownLink } = require('./md-link-target');
const { createViewerBand } = require('./viewer-band');
const { createComposer, isPasteCommentShortcut } = require('./comment-ui');
const {
  isPlainCommentKey,
  isCommentEntryKey,
  isEditEntryKey,
  isMutatingEntryKey,
  createMarkEngine,
  serializeMarkedBlock,
  overlayToEnvelope,
  wrapEditEnvelope,
  parseEditEnvelope,
  buildEnvelopeDiffNode,
} = require('./edit-marks');

const BROAD_SELECTION_CHAR_LIMIT = 240;
const BROAD_SELECTION_WORD_LIMIT = 45;
const MARKDOWN_REFRESH_POLL_MS = 1000;
const MARKDOWN_REFRESH_DEBOUNCE_MS = 250;
const MARKDOWN_REFRESH_PULSE_MS = 9000;
const MARKDOWN_CHANGE_HIGHLIGHT_MAX_AGE = 2;
const MARKDOWN_CHANGE_FLASH_MS = 9300;

function findMarkdownSearchRanges(text, query) {
  const haystack = String(text == null ? '' : text);
  const needle = String(query == null ? '' : query);
  if (!needle) return [];

  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const ranges = [];
  let index = 0;
  while ((index = lowerHaystack.indexOf(lowerNeedle, index)) !== -1) {
    ranges.push({ start: index, end: index + needle.length });
    index += Math.max(1, needle.length);
  }
  return ranges;
}

// isPlainCommentKey / isCommentEntryKey / isEditEntryKey / isMutatingEntryKey
// (the first-key dispatch) now live in edit-marks.js, shared with the review
// viewer's commit-message editor.

// Merged word-diff of one line pair via common prefix/suffix trim: the middle
// is what changed. One representation drives both the in-place pending view
// and the [Edit] envelope, so user and agent see the same picture.
function diffMergedParts(oldText, newText) {
  let p = 0;
  const maxP = Math.min(oldText.length, newText.length);
  while (p < maxP && oldText[p] === newText[p]) p += 1;
  let s = 0;
  const maxS = maxP - p;
  while (s < maxS && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s += 1;
  // Minimal char diff — the most precise picture of what changed. A prior
  // word-boundary snap was asymmetric (it grew the prefix but not the suffix),
  // so a merge like "final text" -> "finatext" rendered as the duplicated
  // "final finatext"; snapping to whole tokens instead dragged in trailing
  // punctuation ("final text." / "finatext."), equally noisy. Minimal simply
  // strikes what was removed and underlines what was added, never duplicating.
  return {
    prefix: oldText.slice(0, p),
    del: oldText.slice(p, oldText.length - s),
    ins: newText.slice(p, newText.length - s),
    suffix: oldText.slice(oldText.length - s),
  };
}

function isTypingTarget(target) {
  if (!target || !target.closest) return true;
  const tagName = target.tagName ? target.tagName.toUpperCase() : '';
  if (target.isContentEditable) return false;
  if (tagName === 'TEXTAREA' && target.classList.contains('xterm-helper-textarea')) return true;
  if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') return false;
  return true;
}

function getRenderedText(element) {
  if (!element) return '';
  const text = element.innerText != null ? element.innerText : element.textContent;
  return String(text || '').trim();
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function isBroadMarkdownSelection({ selectedText, multiBlock }) {
  return !!multiBlock
    || String(selectedText || '').length > BROAD_SELECTION_CHAR_LIMIT
    || countWords(selectedText) > BROAD_SELECTION_WORD_LIMIT;
}

function hashString(value) {
  const text = String(value == null ? '' : value);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function getMarkdownReadSignature(result) {
  if (!result || !result.success) return '';
  return [
    result.path || '',
    Number.isFinite(result.mtimeMs) ? result.mtimeMs : '',
    Number.isFinite(result.size) ? result.size : '',
    hashString(result.content || ''),
  ].join('|');
}

function getMarkdownStatSignature(result) {
  if (!result || !result.success) return '';
  if (!Number.isFinite(result.mtimeMs) || !Number.isFinite(result.size)) return '';
  return [
    result.path || '',
    result.mtimeMs,
    result.size,
  ].join('|');
}

function escapeSelectorValue(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function autoGrowTextarea(textarea) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  const computed = window.getComputedStyle(textarea);
  const lineHeight = parseFloat(computed.lineHeight) || 20;
  const padding = (parseFloat(computed.paddingTop) || 0) + (parseFloat(computed.paddingBottom) || 0);
  const maxHeight = lineHeight * 6 + padding;
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, lineHeight + padding), maxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function ensureStyles() {
  if (document.getElementById('markdown-viewer-style')) return;
  const style = document.createElement('style');
  style.id = 'markdown-viewer-style';
  style.textContent = `
    /* Chrome (shell, bar, hide/roll-up, hue divider, refresh-flash) is the shared
       viewer-band (.vb-shell.vb-md). Only md-specific content theming lives here;
       md drives the band's .vb-refreshed flash itself (pulse until content lands). */
    /* The split view keeps the neutral slate that softens its boundary with the
       black terminal. Full mode nearly covers the terminal, so lift the whole
       neutral surface hierarchy back to the original brighter reading palette.
       The band's .vb-full marker changes alongside its 200ms height transition. */
    .vb-md {
      --vb-bg-transition-duration: 200ms;
      --md-surface: #dadde1;
      --md-scroll-track: #d2d5d9;
      --md-inline-code: #c5c8cc;
      --md-block: #ced1d5;
      --md-panel: #ced1d5;
      --md-landing: #cbced2;
      --md-queued: #c9ccd0;
      color-scheme: light;
      color: #111827;
    }
    .vb-md.vb-full {
      --md-surface: #eef1f5;
      --md-scroll-track: #e9edf2;
      --md-inline-code: #e2e8ef;
      --md-block: #e6ebf1;
      --md-panel: #e5eaf0;
      /* Must stay visibly below --md-surface: the brighter full-mode lift once
         took this to #eef2f7, one step from the #eef1f5 surface — invisible. */
      --md-landing: #dfe4eb;
      --md-queued: #e2e7ee;
    }
    .md-viewer-scroll {
      flex: 1 1 auto;
      /* Flex items default to min-height:auto (won't shrink below content), which
         keeps the whitish page from collapsing when the band rolls up — so its
         top edge shows through the collapsed strip. min-height:0 lets it go to 0. */
      min-height: 0;
      overflow: hidden;
      position: relative; /* the edit pill anchors to the band's corner */
      background-color: var(--md-surface);
      transition: background-color 200ms ease;
    }
    /* Modern scrollbars in the viewer — Windows renders the chunky default with
       arrow buttons otherwise. Thin, buttonless, subtle rounded thumb, matching
       the web viewer + terminal. */
    .vb-md ::-webkit-scrollbar { width: 11px; height: 11px; }
    .vb-md ::-webkit-scrollbar-track { background: transparent; }
    .vb-md ::-webkit-scrollbar-thumb {
      background: rgba(128, 128, 128, 0.42);
      border-radius: 7px;
      border: 3px solid transparent;
      background-clip: content-box;
    }
    .vb-md ::-webkit-scrollbar-thumb:hover {
      background: rgba(128, 128, 128, 0.62);
      background-clip: content-box;
    }
    .vb-md ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
    .vb-md ::-webkit-scrollbar-corner { background: transparent; }
    .md-viewer-body {
      box-sizing: border-box;
      width: 100%;
      /* Readable measure per page (~75 chars/line; ch is the "0" width, so 66ch
         overshoots its name in prose). Charter/Georgia: screen serifs with large
         x-heights — the previous serif was just Chromium's default Times. */
      max-width: 66ch;
      margin: 0 auto;
      padding: 22px 20px 28px;
      font-family: Charter, "Bitstream Charter", "Iowan Old Style", Georgia, serif;
      font-size: 17px;
      line-height: 1.62;
      color: #111827;
      /* Break a long unbroken token (URL, hash, identifier) rather than overflow. */
      overflow-wrap: break-word;
    }
    .md-viewer-body ::selection {
      background: #fff3bf;
      color: inherit;
    }
    ::highlight(md-comment-selection) {
      background: rgba(250, 204, 21, 0.38);
      color: inherit;
    }
    /* A submitted comment's quoted text, marked while its thread card is open.
       Same yellow the selection wore while composing, softened so an armed
       draft still reads stronger than a readback. */
    ::highlight(md-thread-anchor) {
      background: rgba(250, 204, 21, 0.28);
      color: inherit;
    }
    /* Hover-only change ranges: green marks changed text, cool blue marks a
       surviving anchor for deletion-only changes (the deleted text itself
       cannot be shown). Settled changes show only the gutter bar below —
       the in-text color appears while hovering the barred block. */
    ::highlight(md-change-hover-exact) { background: rgba(27, 141, 76, 0.18); color: inherit; }
    ::highlight(md-change-hover-anchor) { background: rgba(37, 99, 235, 0.16); color: inherit; }
    .md-viewer-body h1,
    .md-viewer-body h2,
    .md-viewer-body h3 {
      line-height: 1.25;
      margin: 1.1em 0 0.45em;
      color: #0f172a;
    }
    .md-viewer-body h1:first-child,
    .md-viewer-body h2:first-child,
    .md-viewer-body h3:first-child {
      margin-top: 0;
    }
    .md-viewer-body h1 { font-size: 1.72em; }
    .md-viewer-body h2 { font-size: 1.38em; }
    .md-viewer-body h3 { font-size: 1.14em; }
    .md-viewer-body h4,
    .md-viewer-body h5,
    .md-viewer-body h6 {
      margin: 1em 0 0.35em;
      line-height: 1.25;
      color: #1f2937;
    }
    .md-viewer-body p,
    .md-viewer-body ul,
    .md-viewer-body ol,
    .md-viewer-body blockquote,
    .md-viewer-body pre,
    .md-viewer-body table {
      margin: 0.7em 0;
    }
    .md-viewer-body ul,
    .md-viewer-body ol {
      padding-left: 1.45em;
    }
    .md-viewer-body li {
      margin: 0.16em 0;
    }
    .md-viewer-body blockquote {
      padding: 0.12em 0 0.12em 0.95em;
      border-left: 3px solid #cbd5e1;
      color: #475569;
    }
    .md-viewer-body img {
      max-width: 100%;
      height: auto;
    }
    .md-viewer-body code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 0.92em;
      background-color: var(--md-inline-code);
      border-radius: 4px;
      padding: 0.1em 0.28em;
      transition: background-color 200ms ease;
    }
    .md-viewer-body pre {
      position: relative;
      padding: 12px 14px;
      /* Wrap long code lines instead of scrolling — this is a reading surface, and
         horizontal scroll fights the page-flip flow. pre-wrap keeps indentation;
         overflow-wrap breaks an unbroken token that would still overflow. */
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background-color: var(--md-block);
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      transition: background-color 200ms ease;
    }
    /* The copy-text bar button is a glyph + word ("⧉ text"), not a single icon —
       widen it past the ✕'s fixed 22px (a two-class selector so it beats the base
       .vb-btn width). */
    .vb-btn.md-copy-body { width: auto; padding: 0 9px; }
    .md-viewer-body pre code {
      background: transparent;
      border-radius: 0;
      padding: 0;
      font-size: 0.8em;
      line-height: 1.5;
    }
    .md-viewer-body table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82em;
    }
    .md-viewer-body th,
    .md-viewer-body td {
      border: 1px solid #d8dee6;
      padding: 6px 8px;
      vertical-align: top;
      /* A cell's widest unbroken token (usually a code identifier) otherwise
         sets the table's minimum width, and a wide table juts past the pane
         and gets clipped — the pane hides overflow because scrolling doesn't
         exist here. anywhere lets auto layout always fit the measure; it
         inherits into the code spans that carry most of the long tokens. */
      overflow-wrap: anywhere;
    }
    .md-viewer-body th {
      background-color: var(--md-panel);
      font-weight: 600;
      transition: background-color 200ms ease;
    }
    /* The I-beam over link text is the honest cursor here: a plain click puts a
       caret in the block to comment or edit, and only ctrl/cmd/alt+click follows
       the link. Colour and the hover underline still mark it as one. */
    .md-viewer-body a {
      color: #1d4ed8;
      text-decoration: none;
      cursor: text;
    }
    .md-viewer-body a:hover {
      text-decoration: underline;
    }
    .md-viewer-body .md-anchor {
      border-radius: 5px;
      transition: background-color 200ms ease, box-shadow 120ms ease;
    }
    .md-viewer-body .md-anchor:hover {
      background-color: var(--md-block);
    }
    /* Settled change marker: the pulse decays into a thin gutter bar riding
       the block (the landing-target idiom), keeping the text itself quiet.
       Age = sends since the change (the turn clock). At 3px, lightness is the
       signal that actually reads, so it climbs in even steps (L 33 → 58 → 78)
       while saturation drops (68 → 40 → 32) — a fresher bar is always louder.
       The hue nudges green → sea-green → mint so each level is also nameable,
       without a shade ladder that proved undecodable. Tuned for normal vision
       by decision; colorblind users customize later. Declared before
       landing/comment-active so those states override. */
    .md-viewer-body .md-change-bar {
      box-shadow: inset 2px 0 #1b8d4c;
      border-radius: 5px;
    }
    .md-viewer-body .md-change-bar.md-change-age-1 {
      box-shadow: inset 2px 0 #69bfa2;
    }
    .md-viewer-body .md-change-bar.md-change-age-2 {
      box-shadow: inset 2px 0 #b5d9d0;
    }
    /* Residual landing marker: after the arrival flash decays, this is the only
       answer to "where did I jump to". The bar carries the signal — the same
       slate the neutral flash pulses, at the change-bar weight — and the tint
       stays a whisper so the text field remains quiet. */
    .md-viewer-body .md-landing-target {
      background-color: var(--md-landing);
      box-shadow: inset 2px 0 #64748b;
    }
    .md-viewer-body .md-comment-target-active {
      background-color: var(--md-block);
      box-shadow: inset 2px 0 #9ca3af;
    }
    .md-viewer-body mark.md-search-match {
      border-radius: 3px;
      padding: 0 0.04em;
      background: rgba(250, 204, 21, 0.36);
      color: inherit;
    }
    .md-viewer-body mark.md-search-match.current {
      background: rgba(250, 204, 21, 0.68);
      box-shadow: 0 0 0 1px rgba(202, 138, 4, 0.34);
    }
    .md-spread-layout {
      height: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      column-gap: 34px;
      box-sizing: border-box;
      padding: 0 26px;
    }
    /* Page insets: the pane's padding is the page margin, and the inner
       viewport clips the text, so mid-scroll lines never touch the band
       chrome. The viewport (not the pane) is the scroller. */
    .md-spread-pane {
      --md-pane-pad-top: 18px;
      position: relative;
      min-width: 0;
      height: 100%;
      overflow: hidden;
      box-sizing: border-box;
      padding: var(--md-pane-pad-top) 0 20px;
    }
    /* Spread reading advances by whole page-flips only (flipSpread): the
       viewport refuses native scrolling so no intermediate motion exists.
       On narrow windows the pages simply get narrower. */
    .md-page-viewport {
      height: 100%;
      overflow: hidden;
      /* The page grid does its own shift compensation (preserveSpreadTopAcross);
         the browser's native scroll anchoring would double-correct under it. */
      overflow-anchor: none;
    }
    /* The seam markers. Adjacent pages overlap by a line or two so a line is never
       split at a page edge and the reader keeps their place across the seam. Rather
       than greying the repeated lines (which hurts readability), a thin rule marks
       where the repeat ends and fresh text begins — drawn at the bottom of the
       recap, so everything above the rule already appeared on the page before.
       Two kinds, styled apart so the reader can tell which seam they're at:
         • a "flip" rule on each left page — content carried across a page turn
           from the previous spread (the bigger jump: a solid rule);
         • a "gutter" rule on each right page — content carried from the facing
           left page within the same spread (a lighter dashed stitch).
       The first spread's left page has no flip rule; its top is the document's
       real start. One rule rides each (non-scrolling) outer pane; its vertical
       position is the live overlap and its column width are set per layout pass in
       JS. pointer-events:none so a comment click still lands on the text under it. */
    .md-recap-veil {
      position: absolute;
      top: var(--md-pane-pad-top, 18px);
      /* A bracket: the bottom border is the underline, the left/right borders are
         short end-caps rising toward the repeated lines. The caps mark the column
         width so it reads as a deliberate marker (not a stray underline or <hr>),
         which lets the underline stay faint. JS sets top so the underline lands on
         the seam; the box height is the cap height. */
      height: 5px;
      pointer-events: none;
      z-index: 4;
      display: none; /* JS reveals it (display:block) once there's a recap to mark */
      border: 0 solid transparent;
      border-bottom-width: 1px;
      border-left-width: 1px;
      border-right-width: 1px;
    }
    .md-recap-veil.md-recap-flip {
      /* Page turn: solid, the stronger of the two; underline lighter than the caps. */
      border-color: rgba(71, 85, 105, 0.5);
      border-bottom-color: rgba(71, 85, 105, 0.32);
    }
    .md-recap-veil.md-recap-gutter {
      /* Facing-page continuation inside the spread: solid like the flip rule (a
         dashed hairline reads as choppy at 1px) but a lighter stone tone, so it
         stays the gentler-looking of the two seams. */
      border-color: rgba(120, 113, 108, 0.42);
      border-bottom-color: rgba(120, 113, 108, 0.34);
    }
    .md-spread-pane.secondary .md-viewer-body {
      pointer-events: auto;
      will-change: transform;
    }
    .md-spread-pane .md-viewer-body {
      min-height: 100%;
    }
    /* Newest-change pulse — mirrors rv-pulse in web-viewer-preload.js (the review
       viewer's pulse). It rides the changed block itself (resolveChangeRecordAnchor
       returns a block-level md anchor): a tint filled behind the text via inset
       box-shadow, plus a solid left accent bar, over three ~3s cycles. box-shadow
       (not background) carries the tint so a code block's own grey shows through,
       and it stays behind the glyphs. Same hue as the settled gutter bars the
       pulse decays into. Riding the element means no overlay and free scroll
       tracking. Keep the curve in sync with rv-pulse-kf. */
    /* One pulse for every change kind — the pulse's job is attention, not
       classification; delete-vs-change lives in the hover ranges. */
    .md-change-pulse {
      border-radius: 4px;
      animation: md-change-pulse-kf 3000ms ease-in-out 3;
      will-change: box-shadow;
      --md-cp-tint: rgba(34, 197, 94, 0.34);
      --md-cp-accent: #16a34a;
      --md-cp-outline: rgba(22, 163, 74, 0.55);
    }
    @keyframes md-change-pulse-kf {
      0%, 72%, 100% {
        box-shadow: inset 2px 0 0 transparent,
                    inset 0 0 0 1px transparent,
                    inset 0 0 0 999px transparent;
      }
      12%, 45% {
        box-shadow: inset 2px 0 0 var(--md-cp-accent),
                    inset 0 0 0 1px var(--md-cp-outline),
                    inset 0 0 0 999px var(--md-cp-tint);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .md-change-pulse {
        animation: none;
        box-shadow: inset 2px 0 0 var(--md-cp-accent),
                    inset 0 0 0 999px var(--md-cp-tint);
      }
    }
    /* Arrival flash for a jump-to-line. Reuses the change-pulse keyframes and the
       same green/blue vocabulary (exact = added, anchor = deletion) plus a neutral
       slate for non-diff navigation, so a jump is visible and its colour says why. */
    .md-landing-pulse {
      border-radius: 4px;
      animation: md-change-pulse-kf 3000ms ease-in-out 3;
      will-change: box-shadow;
    }
    .md-landing-pulse--exact {
      --md-cp-tint: rgba(34, 197, 94, 0.34);
      --md-cp-accent: #16a34a;
      --md-cp-outline: rgba(22, 163, 74, 0.55);
    }
    .md-landing-pulse--anchor {
      --md-cp-tint: rgba(37, 99, 235, 0.30);
      --md-cp-accent: #2563eb;
      --md-cp-outline: rgba(37, 99, 235, 0.55);
    }
    .md-landing-pulse--neutral {
      --md-cp-tint: rgba(100, 116, 139, 0.28);
      --md-cp-accent: #64748b;
      --md-cp-outline: rgba(100, 116, 139, 0.55);
    }
    @media (prefers-reduced-motion: reduce) {
      .md-landing-pulse {
        animation: none;
        box-shadow: inset 2px 0 0 var(--md-cp-accent),
                    inset 0 0 0 999px var(--md-cp-tint);
      }
    }
    .md-bottom-spacer {
      height: var(--md-bottom-spacer-height, 0px);
      pointer-events: none;
    }
    /* While the viewer owns a drag, the native selection must not compete. */
    .md-spread-layout.md-vdrag { user-select: none; cursor: text; }
    .md-bar-hint {
      display: none;
      color: #aab1ba;
      font-size: 12px;
      line-height: 1;
      white-space: nowrap;
      user-select: none;
      padding: 0 6px;
    }
    .md-bar-hint.on { display: inline-block; }
    .md-comment-card {
      margin: 8px 0 12px;
      padding: 9px 10px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      background-color: var(--md-panel);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
      transition: background-color 200ms ease;
    }
    /* Comment drafts: the thread-card family with the amber draft accent —
       pending items are threads that haven't been sent yet. */
    .md-queued-comment-card {
      margin: 8px 0 12px;
      padding: 8px 10px;
      border: 1px solid #cbd5e1;
      border-left: 2px solid rgba(217, 119, 6, 0.8);
      border-radius: 8px;
      background-color: var(--md-panel);
      font-size: 0.8em;
      cursor: pointer;
      transition: background-color 200ms ease;
    }
    .md-queued-comment-card:hover {
      background-color: var(--md-block);
    }
    .md-queued-comment-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 2px;
    }
    .md-queued-comment-label {
      font-weight: 600;
      font-size: 11px;
      color: #92610a;
    }
    .md-queued-comment-x {
      margin-left: auto;
      font-size: 11px;
      color: #64748b;
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
    }
    .md-queued-comment-x:hover {
      color: #b91c1c;
    }
    .md-queued-comment-body {
      color: #111827;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    /* Thread layer: expanded cards and collapsed disclosure lines, inserted
       into the article flow after their anchored blocks (both spread pages). */
    .md-thread-card {
      margin: 8px 0 12px;
      padding: 8px 10px;
      border: 1px solid #cbd5e1;
      border-left: 2px solid #94a3b8;
      border-radius: 8px;
      background-color: var(--md-panel);
      font-size: 0.8em;
      transition: background-color 200ms ease;
    }
    /* Amber says one thing only: this needs you. A thread still awaiting the
       agent asks nothing of the user, so it stays as quiet as a resolved one. */
    .md-thread-card.needs-user { border-left-color: #d97706; }
    /* A waiting card only exists expanded-for-reading (the rest state is the
       one-line row below); clicking it folds back, so the whole card affords. */
    .md-thread-card.waiting { border-left-color: #94a3b8; cursor: pointer; }
    /* Resolved = finished, no turn. Grey, so the one card blocked on you keeps
       the only colored border on the block. */
    .md-thread-card.resolved {
      border-left-color: #94a3b8;
      opacity: 0.78;
    }
    /* Progress, localized: while the agent is working (the renderer sets
       body.agent-working from live PTY output — the CLI's own spinner keeps it
       live through the turn), the open comments it hasn't answered breathe their
       accent — the resting waiting row, or the card when clicked open.
       A low-profile "being worked on" cue that shows only when something
       is actually pending: it clears when the agent replies (the card re-renders
       without .waiting) or when output goes quiet (the class drops). The swing
       is wide (slate-400 to slate-800, plus an edge line at peak): a 2px border
       needs a large luminance delta to register in peripheral vision while the
       eye is reading elsewhere. */
    @keyframes md-thread-working {
      0%, 100% { border-left-color: #94a3b8; box-shadow: -1.5px 0 0 rgba(30, 41, 59, 0); }
      50%      { border-left-color: #1e293b; box-shadow: -1.5px 0 0 rgba(30, 41, 59, 0.5); }
    }
    body.agent-working .md-thread-card.waiting,
    body.agent-working .md-thread-waiting-line {
      animation: md-thread-working 1.6s ease-in-out infinite;
    }
    /* Sent edits awaiting the agent pulse the same way, so edit and comment read
       consistently. The seal / structural sent-diff box breathes its whole border
       (its only accent) over the same slate range, as a ring instead of a left bar. */
    @keyframes md-edit-working {
      0%, 100% { border-color: #94a3b8; box-shadow: 0 0 0 1px rgba(30, 41, 59, 0); }
      50%      { border-color: #1e293b; box-shadow: 0 0 0 1px rgba(30, 41, 59, 0.5); }
    }
    body.agent-working .md-viewer-body .md-sealed.md-await-agent,
    body.agent-working .md-pending-diff.sent.md-await-agent {
      animation: md-edit-working 1.6s ease-in-out infinite;
    }
    .md-thread-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 2px;
    }
    .md-thread-pill {
      font-size: 10px;
      color: #64748b;
      border: 1px solid #cbd5e1;
      border-radius: 999px;
      padding: 0 6px;
      white-space: nowrap;
    }
    .md-thread-pill.lost {
      color: #b45309;
      border-color: #f59e0b;
    }
    .md-thread-fold {
      margin-left: auto;
      font-size: 11px;
      color: #64748b;
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
    }
    .md-thread-fold:hover {
      color: #334155;
      text-decoration: underline;
    }
    .md-thread-msg {
      margin: 3px 0;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    /* A hairline between consecutive messages marks where one ends — with "you"
       gone, this is what separates two of your messages in a row, or your reply
       right after a multi-line agent message. The agent label still carries who. */
    .md-thread-msg + .md-thread-msg {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid rgba(100, 116, 139, 0.12);
    }
    .md-thread-msg .who {
      color: #64748b;
      font-weight: 600;
      margin-right: 6px;
    }
    .md-thread-actions {
      margin-top: 6px;
      display: flex;
      gap: 12px;
    }
    .md-thread-actions button {
      font-size: 11px;
      color: #475569;
      background: none;
      border: 1px solid #cbd5e1;
      border-radius: 5px;
      padding: 2px 8px;
      cursor: pointer;
    }
    .md-thread-actions button:hover {
      background-color: var(--md-block);
    }
    .md-thread-reply {
      margin-top: 6px;
    }
    /* Resting annotation row — one low-profile bordered line standing in for a
       comment thread or an edit's note. Detail and actions reveal on click; the
       row never fills (a fill reads as an inserted code/callout block). The
       left-accent carries type: slate comment, green edit, amber unsent draft.
       Text truncates to the line via .md-anno-text. */
    .md-thread-resolved-summary,
    .md-thread-resolved-line,
    .md-thread-waiting-line,
    .md-pending-note-mark,
    .md-queued-comment-mark {
      display: flex;
      align-items: center;
      gap: 6px;
      width: auto;
      margin: 6px 0 10px;
      padding: 3px 9px;
      font-size: 0.74em;
      line-height: 1.5;
      color: #475569;
      background: none;
      border: 1px solid #d5dbe2;
      border-left: 2px solid #94a3b8;
      border-radius: 6px;
      cursor: pointer;
      overflow: hidden;
      white-space: nowrap;
    }
    .md-anno-text {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .md-anno-meta { flex: none; color: #94a3b8; font-size: 0.92em; }
    .md-thread-resolved-summary:hover,
    .md-thread-resolved-line:hover,
    .md-thread-waiting-line:hover,
    .md-pending-note-mark:hover,
    .md-queued-comment-mark:hover {
      color: #334155;
      background-color: var(--md-block);
    }
    /* Resolved history: the agent finished, so this carries no turn and no
       content — a count, quiet, one line per block. The work itself is already
       visible as the document change. Click unfolds the threads behind it. */
    .md-thread-resolved-summary {
      border-left-color: #94a3b8;
      color: #64748b;
      opacity: 0.8;
    }
    .md-thread-resolved-summary:hover { opacity: 1; }
    /* The resolved group sits in from the block, leaving a gutter for its fold
       caret — so the caret costs no row and never moves, it only flips. */
    .md-resolved-item { margin-left: 18px; }
    /* overflow:visible so the gutter caret isn't clipped away by the row's own
       overflow:hidden — the text span does its own truncating, so the row has no
       need to clip. */
    .md-resolved-first { position: relative; overflow: visible; }
    .md-resolved-caret {
      position: absolute;
      left: -17px;
      top: 50%;
      transform: translateY(-50%);
      width: 14px;
      padding: 0;
      font-size: 9px;
      line-height: 1;
      color: #94a3b8;
      background: none;
      border: none;
      cursor: pointer;
      opacity: 0.75;
    }
    .md-resolved-caret:hover { color: #475569; opacity: 1; }
    /* One resolved thread behind the count: your opening ask, indented under the
       header that revealed it. Grey like its header — finished, no turn. */
    .md-thread-resolved-line {
      border-left-color: #cbd5e1;
      color: #64748b;
      opacity: 0.9;
    }
    .md-thread-resolved-line:hover { opacity: 1; }
    .md-thread-resolved-line del { opacity: 0.7; }
    .md-anno-edit { flex: none; opacity: 0.6; }
    /* The agent label rides INSIDE the truncating text, so it spaces itself
       rather than leaning on the row's flex gap. */
    .md-anno-who { color: #64748b; font-weight: 600; }
    .md-anno-text .md-anno-who { margin-right: 5px; }
    .md-anno-text .md-anno-who--after { margin-left: 10px; }
    /* A sent, un-answered edit seals its block: the amber border is the whole lock
       signal (no "awaiting" chip — the color is the turn). In-place editing is
       disabled there; notes and comments stay open. */
    .md-viewer-body .md-sealed {
      border: 1.5px solid rgba(100, 116, 139, 0.55);
      background: rgba(100, 116, 139, 0.05);
      border-radius: 6px;
      padding: 3px 9px;
      margin-left: -10px;
      margin-right: -10px;
    }
    /* Editing core: amber pending-edit bars (same gutter idiom as change bars,
       declared after them so pending wins on a block carrying both), and the
       batch pill. */
    /* Blinking caret at the click position — shows where an edit will start
       before the first key. A zero-width inline bar in the reading ink. */
    .md-viewer-body .md-edit-caret {
      display: inline-block;
      width: 0;
      height: 1.05em;
      margin: 0 -0.5px;
      vertical-align: text-bottom;
      border-left: 1.5px solid #1f2937;
      animation: md-edit-caret-blink 1.06s steps(1, end) infinite;
      pointer-events: none;
    }
    @keyframes md-edit-caret-blink { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }
    /* Direct editing on the rendered block: the document itself is the
       editing surface; the grey wash marks the live block. */
    .md-viewer-body .md-rendered-editing {
      background-color: var(--md-block);
      border-radius: 5px;
      outline: none;
      cursor: text;
    }
    /* Sent-edit / stale-thread fallback box — the source text in the reading
       font, boxed, persisting through the sent (slate) lifecycle. */
    .md-pending-diff {
      margin: 0.7em 0;
      padding: 7px 10px 6px;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      background-color: var(--md-block);
      font-size: 0.92em;
      transition: background-color 200ms ease;
    }
    .md-pending-diff.sent {
      opacity: 0.9;
    }
    .md-pending-diff-body {
      white-space: pre-wrap;
      line-height: 1.5;
    }
    .md-pending-diff-body del {
      color: #9f1239;
      background: rgba(244, 63, 94, 0.12);
      text-decoration: line-through;
      border-radius: 3px;
      padding: 0 1px;
    }
    .md-pending-diff-body ins {
      color: #92400e;
      background: rgba(217, 119, 6, 0.16);
      text-decoration: none;
      border-radius: 3px;
      padding: 0 1px;
    }
    .md-pending-diff.sent .md-pending-diff-body ins {
      color: #334155;
      background: rgba(100, 116, 139, 0.16);
    }
    .md-pending-diff-old {
      color: #9f1239;
      background: rgba(244, 63, 94, 0.08);
      text-decoration: line-through;
      white-space: pre-wrap;
    }
    .md-pending-diff-new {
      color: #92400e;
      background: rgba(217, 119, 6, 0.10);
      white-space: pre-wrap;
    }
    .md-pending-diff-ctx {
      color: #475569;
      white-space: pre-wrap;
    }
    .md-pending-diff-actions {
      margin-top: 5px;
      display: flex;
      gap: 12px;
      align-items: baseline;
    }
    .md-pending-diff-actions button {
      font-size: 13px;
      line-height: 1.2;
      color: #475569;
      background: none;
      border: 1px solid #cbd5e1;
      border-radius: 5px;
      padding: 1px 7px;
      cursor: pointer;
    }
    .md-pending-diff-actions button:hover {
      background-color: var(--md-panel);
    }
    .md-sent-chip {
      font-size: 10px;
      color: #64748b;
      border: 1px solid #cbd5e1;
      border-radius: 999px;
      padding: 0 7px;
    }
    .md-pending-diff-note {
      margin-top: 4px;
      font-size: 0.9em;
      font-style: italic;
      color: #475569;
    }
    .md-pending-diff-composer {
      margin-top: 6px;
    }
    /* Decorated rendered blocks: the document stays typeset; deleted words
       struck in place, inserted words marked. Amber = pending, slate = sent —
       the inline marks alone carry the state. */
    .md-viewer-body del.md-pending-del,
    .md-viewer-body del.md-sent-del {
      color: #9f1239;
      background: rgba(244, 63, 94, 0.12);
      text-decoration: line-through;
      border-radius: 3px;
      padding: 0 1px;
    }
    .md-viewer-body del.md-sent-del {
      color: #64748b;
      background: rgba(100, 116, 139, 0.14);
    }
    /* Inserted text reads as a track-changes insertion — a colored underline,
       not a solid fill (a fill collides with the comment highlight). Deleted
       is strikethrough above; together they are the universal change pair. */
    .md-viewer-body ins.md-pending-ins {
      color: #b45309;
      background: none;
      text-decoration: underline;
      text-decoration-thickness: 2px;
      text-underline-offset: 2px;
      text-decoration-color: rgba(217, 119, 6, 0.85);
      /* Typed spaces must each render, or the caret sits still on the
         keystroke: a space typed beside an existing one (any word-boundary
         click) collapses under normal white-space and reads as a dead key.
         Matches ins.md-sent-ins; the marks carry every typed space anyway. */
      white-space: pre-wrap;
    }
    .md-viewer-body ins.md-sent-ins {
      color: #475569;
      background: none;
      text-decoration: underline;
      text-decoration-thickness: 2px;
      text-underline-offset: 2px;
      text-decoration-color: rgba(100, 116, 139, 0.7);
      /* a sealed insertion may carry a "\n" break; typed ins text is
         space-normalized, so pre-wrap exposes nothing else */
      white-space: pre-wrap;
    }
    /* An inserted line break in prose: a break atom carrying a real "\n".
       Its own pre-wrap renders the break while the block stays collapsed;
       the pilcrow makes the break visible and struck-able (⌫ removes it as
       one unit). Code blocks carry raw newlines instead — <pre> is already
       honest. */
    .md-viewer-body ins.md-pending-break { white-space: pre-wrap; }
    .md-viewer-body ins.md-pending-break::before {
      content: '¶';
      color: rgba(217, 119, 6, 0.55);
      font-size: 0.82em;
    }
    /* The revealed edit affordance: the same bubble chrome as .md-comment-card,
       so a revealed edit reads like an open comment. Holds the shared composer
       (note textarea + Undo/Send). */
    .md-pending-strip {
      margin: 8px 0 12px;
      padding: 9px 10px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      background-color: var(--md-panel);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
    }
    /* The sent edit's status line stays a light inline chip, not a bubble. */
    .md-pending-strip.sent {
      margin: -0.35em 0 0.8em;
      padding: 0;
      border: none;
      background: none;
      box-shadow: none;
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    /* The live-edit control is the same inline bubble as a revisit (chrome from
       .md-pending-strip); .md-editing-strip is just a marker for it. */
    /* A long edit run can walk the caret pages away from the block's tail,
       taking the bubble's flow seat off every page. It then pins to the edited
       page's bottom edge as an overlay, so Undo/Send/note stay reachable. */
    .md-editing-strip.pinned {
      position: absolute;
      left: 14px;
      right: 14px;
      bottom: 6px;
      margin: 0;
      z-index: 40;
      box-shadow: 0 6px 18px rgba(15, 23, 42, 0.18);
    }
    /* Caret in the page's lower half: the pin flips to the top edge so the
       bubble never covers the text being struck. */
    .md-editing-strip.pinned.pinned-top { bottom: auto; top: 6px; }
    /* Edit's note row (green, ties to the edit's change bar) and the unsent
       draft's note row (amber). Layout shared with the resting rows above. */
    .md-pending-note-mark { border-left-color: #1b8d4c; color: #3f6b52; }
    /* A bare edit still rests with a line (full consistency); its empty-note
       prompt reads muted so it doesn't compete with real notes and comments. */
    .md-pending-note-mark.empty .md-anno-text { opacity: 0.55; font-style: italic; }
    .md-queued-comment-mark { border-left-color: rgba(217, 119, 6, 0.85); color: #92610a; }
    .md-viewer-body del.md-pending-del,
    .md-viewer-body ins.md-pending-ins { cursor: pointer; }
    .md-comment-card-spacer {
      margin: 8px 0 12px;
      pointer-events: none;
    }
    .md-queued-comment-card-spacer {
      margin: 8px 0 12px;
      pointer-events: none;
    }
    /* The composer (textarea + Cancel/Send) is the shared comment-ui widget
       (.cu-composer); md only styles the card wrapper around it. */
    .md-viewer-loading,
    .md-viewer-error {
      padding: 22px 28px;
      color: #64748b;
      font-size: 13px;
    }
    .md-viewer-error {
      color: #b91c1c;
    }
  `;
  document.head.appendChild(style);
}

function createMarkdownViewer({
  readMarkdownFile,
  statMarkdownFile,
  submitMarkdownThreads,
  preflightMarkdownRunbook,
  readMarkdownThreads,
  addMarkdownThreadMessage,
  showToast,
  openURL,
  openDocPath,
  getTerminalMetrics,
  focusTerminal,
  openSearchBar,
  closeSearchBar,
  getSearchState,
  onOpen,
  onClose,
  platform,
} = {}) {
  const state = {
    shell: null,
    title: null,
    article: null,
    activeTarget: null,
    activeTargetPane: null,
    activeSelection: null,
    activeCard: null,
    queuedComments: [],
    threadStore: null,
    threadStoreSig: '',
    threadPollInFlight: false,
    threadRenderPending: false,
    threadReply: null,
    resumeFullPending: false, // a full-size send receded to golden; resume full when the agent's turn ends
    resolvedExpanded: new Set(), // block anchorIds whose resolved history is unfolded to lines
    expandedThreads: new Set(), // thread ids opened from a resolved/waiting line into a full card
    editing: null, // open block-editor session
    editCaret: null, // blinking caret span at the held click position
    expandedHunkKey: null, // anchorId of the pending edit whose action strip is open
    // A user edit is a comment: strike-in-place marks (<del>/<ins>) over the
    // FROZEN rendered block. The document source is never mutated by an edit. The
    // marked overlay is the single source of truth for both the on-screen
    // decoration and the [Edit] envelope, keyed by the block's stable anchorId
    // (stable because the source is frozen). Value: { html, note }.
    blockOverlays: new Map(), // anchorId → { html, note }
    pendingClickCaret: null, // rendered-text offset captured at the last block click
    hint: null,
    doc: null,
    spreadLayout: null,
    primaryPane: null,
    secondaryPane: null,
    secondaryArticle: null,
    primarySpacer: null,
    secondarySpacer: null,
    primaryVeil: null,
    secondaryVeil: null,
    // The spread's intended top, before syncSecondaryPane nudges the display up to
    // a whole line. Flips advance THIS (not the nudged scrollTop) so paging forward
    // then back returns to the same page — see setSpreadScroll.
    spreadGridTop: 0,
    filePath: '',
    resolvedPath: '',
    imageRoot: '',
    nextCommentId: 0,
    openToken: 0,
    search: {
      isOpen: false,
      query: '',
      matches: [],
      currentIndex: -1,
    },
    sourceText: '',
    changeHighlightBatches: [],
    changeClockTurn: null,
    changeBarRecords: null,
    changeHoverEl: null,
    changeFlashRecords: [],
    changeFlashToken: 0,
    changeFlashTimer: 0,
    changePulseEls: [],
    landingPulse: null, // { ids, variant } — survives layoutSpread rebuilds by anchor id
    fileSignature: '',
    fileStatSignature: '',
    pendingRefreshResult: null,
    pendingRefreshSignature: '',
    pendingRefreshStatSignature: '',
    refreshPollTimer: null,
    refreshDebounceTimer: null,
    refreshPulseTimer: null,
    refreshPulseStartedAt: 0,
    refreshPulseViewUpdated: true,
    refreshInFlight: false,
  };

  // Chrome (shell, bar, hide/roll-up, sizing, hue, Esc) is the shared band; this
  // viewer only fills the content slot (the spread) + a bar widget (the comment
  // footer). escToHide:false → md drives Esc itself (cancel a card first).
  const band = createViewerBand({
    name: 'md',
    share: 'major',
    bg: 'var(--md-surface)',
    minHeight: 220,
    // Opening a doc puts it on stage, so a fresh reveal is full-screen. The
    // golden split is the handoff state, and it arrives on its own: a send
    // recedes to it (the terminal receipt) and the store's turn-end resumes
    // full. The web viewer keeps golden — a terminal URL is a glance beside
    // the session, not a takeover.
    defaultSize: 'full',
    closeTitle: 'Close markdown viewer',
    escToHide: false,
    getTerminalGrid: () => {
      const m = typeof getTerminalMetrics === 'function' ? getTerminalMetrics() : null;
      if (!m || !Number.isFinite(m.top) || !Number.isFinite(m.height) || !Number.isFinite(m.rows) || m.rows <= 0) return null;
      return { top: m.top, cellHeight: m.height / m.rows };
    },
    onShow: () => { updateBottomSpacer(); scheduleSpreadLayout(); },
    // Rolling up takes the doc off screen, so an md-scoped search has nothing to
    // show — close it (clearing its highlights) so Ctrl-F targets the terminal.
    onHide: () => {
      // Rolling up abandons the transient target/selection (and clears the bar
      // hint with it). Leaves live edits and open composers untouched.
      clearActiveTarget();
      if (!state.search.isOpen) return;
      if (typeof closeSearchBar === 'function') closeSearchBar();
      else closeSearch();
    },
    onClose: () => { teardownMarkdown(); if (typeof onClose === 'function') onClose(); },
  });

  function ensureMounted() {
    if (state.shell) return;
    ensureStyles();
    band.mount();
    band.shell.setAttribute('aria-label', 'Markdown viewer');
    band.shell.setAttribute('tabindex', '-1'); // so state.shell.focus() works

    // The comment/edit key guide is bar chrome, not page flow: a flow slot can
    // land beyond both pages (a block at the right page's bottom puts its slot
    // past the spread, and the counterpart slot belongs to the next spread),
    // and an armed target survives page flips while flow chrome scrolls away
    // with its block. The bar shows the guide exactly while a target is armed.
    if (band.barRight && !band.barRight.querySelector('.md-bar-hint')) {
      const hintEl = document.createElement('span');
      hintEl.className = 'md-bar-hint';
      band.barRight.insertBefore(hintEl, band.barRight.firstChild);
    }
    state.barHint = band.barRight ? band.barRight.querySelector('.md-bar-hint') : null;

    // Right-side bar button: copy the document body as plain text (comments
    // excluded), for pasting a drafted message into a chat or email. Sits apart
    // from the (left-aligned) file path — it's the body, not the filename.
    if (band.barRight && !band.barRight.querySelector('.md-copy-body')) {
      let copyBtn;
      copyBtn = band.makeBtn('⧉ text', 'Copy the document body as plain text (no comments) — for a chat or email', () => copyDocBody(copyBtn));
      copyBtn.classList.add('md-copy-body');
      copyBtn._restLabel = copyBtn.textContent;
      band.barRight.appendChild(copyBtn);
    }

    const scroll = document.createElement('div');
    scroll.className = 'md-viewer-scroll';

    const spreadLayout = document.createElement('div');
    spreadLayout.className = 'md-spread-layout';

    const primaryPane = document.createElement('div');
    primaryPane.className = 'md-spread-pane primary';

    const secondaryPane = document.createElement('div');
    secondaryPane.className = 'md-spread-pane secondary';

    const article = document.createElement('article');
    article.className = 'md-viewer-body';
    const primarySpacer = document.createElement('div');
    primarySpacer.className = 'md-bottom-spacer';

    const secondaryArticle = document.createElement('article');
    secondaryArticle.className = 'md-viewer-body';
    const secondarySpacer = document.createElement('div');
    secondarySpacer.className = 'md-bottom-spacer';

    const primaryViewport = document.createElement('div');
    primaryViewport.className = 'md-page-viewport';
    const secondaryViewport = document.createElement('div');
    secondaryViewport.className = 'md-page-viewport';

    primaryViewport.append(article, primarySpacer);
    secondaryViewport.append(secondaryArticle, secondarySpacer);
    primaryPane.appendChild(primaryViewport);
    secondaryPane.appendChild(secondaryViewport);
    // Seam rules ride the (non-scrolling) outer panes, over the viewport's top.
    // Left page = flip seam (across the page turn); right page = gutter seam
    // (from the facing left page).
    const primaryVeil = document.createElement('div');
    primaryVeil.className = 'md-recap-veil md-recap-flip';
    const secondaryVeil = document.createElement('div');
    secondaryVeil.className = 'md-recap-veil md-recap-gutter';
    primaryPane.appendChild(primaryVeil);
    secondaryPane.appendChild(secondaryVeil);
    spreadLayout.append(primaryPane, secondaryPane);
    scroll.appendChild(spreadLayout);

    band.content.appendChild(scroll);
    spreadLayout.addEventListener('click', handleArticleClick);
    spreadLayout.addEventListener('mouseup', handleSelectionMouseup);
    spreadLayout.addEventListener('mousedown', handleVdragDown);
    spreadLayout.addEventListener('mouseover', handleChangeBarHover);
    primaryViewport.addEventListener('scroll', handlePrimaryPaneScroll);
    spreadLayout.addEventListener('wheel', handleSpreadWheel, { passive: false });
    band.shell.addEventListener('mousedown', (event) => event.stopPropagation());
    band.shell.addEventListener('dblclick', (event) => event.stopPropagation());
    document.addEventListener('keydown', handleDocumentKeydown, true);
    window.addEventListener('resize', () => {
      updateBottomSpacer();
      scheduleSpreadLayout();
    });
    // Band expand/shrink (2/3 ↔ full) animates the shell height with no window
    // resize event, leaving the bottom trims and the right page's offset stale.
    // Observe the layout — whose size the alignment pass never sets; observing
    // the viewports would loop on their own bottom trims — and re-measure each
    // animation frame while the 200ms height transition runs.
    if (typeof ResizeObserver === 'function') {
      let paneResizeRaf = 0;
      new ResizeObserver(() => {
        if (paneResizeRaf) return;
        paneResizeRaf = requestAnimationFrame(() => {
          paneResizeRaf = 0;
          realignPagesPreservingTop();
        });
      }).observe(spreadLayout);
    }

    state.shell = band.shell;
    state.scroll = scroll;
    state.spreadLayout = spreadLayout;
    // The viewports are the scrollers ("panes" to the rest of the code); the
    // outer pane divs only carry the page-margin padding.
    state.primaryPane = primaryViewport;
    state.secondaryPane = secondaryViewport;
    state.article = article;
    state.secondaryArticle = secondaryArticle;
    state.primarySpacer = primarySpacer;
    state.secondarySpacer = secondarySpacer;
    state.primaryVeil = primaryVeil;
    state.secondaryVeil = secondaryVeil;
  }

  function updateBottomSpacer() {
    if (!state.primaryPane) return;
    const spacerHeight = Math.max(0, state.primaryPane.clientHeight - 24);
    if (state.primarySpacer) state.primarySpacer.style.height = `${spacerHeight}px`;
    if (state.secondarySpacer) state.secondarySpacer.style.height = `${spacerHeight}px`;
  }

  function getRenderedLineHeight() {
    const computed = state.article ? window.getComputedStyle(state.article) : null;
    return parseFloat(computed && computed.lineHeight) || 24;
  }

  function getSpreadPageAdvance() {
    const paneHeight = state.primaryPane ? state.primaryPane.clientHeight || 0 : 0;
    if (!paneHeight) return 0;

    // Adjacent pages overlap by ~one line so the reader keeps their place across
    // the seam and no line is split there. One line is the floor: the bottom trim
    // can eat up to a line of it and the top nudge can add up to a line back, so a
    // full line designed keeps the actual overlap from ever going negative (which
    // would skip content) while typically repeating just a single line.
    const overlap = Math.min(paneHeight * 0.25, Math.max(20, getRenderedLineHeight()));
    return Math.max(1, paneHeight - overlap);
  }

  // Move the spread to an intended top and remember it as the grid top. The
  // display scrollTop then gets nudged up to a whole line by syncSecondaryPane,
  // but that nudge stays out of spreadGridTop — so the next flip advances from the
  // clean grid position and paging forward then back returns to the same page.
  // (The whole-line nudge and realign-preserve deliberately DON'T come through
  // here; a comment/anchor jump does, re-basing the grid to where it landed.)
  function setSpreadScroll(top) {
    state.spreadGridTop = top;
    if (!state.primaryPane) return;
    if (Math.abs(state.primaryPane.scrollTop - top) < 0.5) syncSecondaryPane();
    else state.primaryPane.scrollTop = top; // fires handlePrimaryPaneScroll → syncSecondaryPane
  }

  // A spread advances only by whole page-flips: 2× the page advance, so the
  // new left page continues from the old right page's bottom, and the same
  // overlap lines that stitch the seam inside a spread repeat across the flip.
  function flipSpread(direction) {
    if (!state.primaryPane) return;
    // Full page height for the advance arithmetic — the bottom trim from the
    // previous alignment pass must not shrink the flip.
    state.primaryPane.style.height = '';
    if (state.secondaryPane) state.secondaryPane.style.height = '';
    const advance = getSpreadPageAdvance();
    const clientH = state.primaryPane.clientHeight;
    // Content height, not scrollHeight — the spacer exists for landing arithmetic,
    // never as page content.
    const contentHeight = state.article ? state.article.offsetHeight : 0;
    // The grid top, NOT the live scrollTop: sync nudges scrollTop up to a whole
    // line for display, and reading that back would compound the nudge every flip
    // (forward + back wouldn't return home).
    const from = state.spreadGridTop || 0;
    // A spread whose right page already reaches the document end is the final one.
    const reachesEnd = (top) => top + advance + clientH >= contentHeight - 1;

    if (direction > 0) {
      // Already parked on the final spread: nothing ahead, so re-run alignment
      // and stay put.
      if (reachesEnd(from)) { syncSecondaryPane(); return; }
      // Advance a whole spread, staying on the page grid so every seam repeats the
      // same overlap — the flip onto the final spread included. Its right page (and
      // maybe most of its left) may end up empty when little text remains; that's
      // fine. Pulling the spread back to fill the page would force the reader to
      // re-read a screenful and hunt for where the new text actually starts, which
      // costs more than the blank space it hides.
      setSpreadScroll(from + 2 * advance);
      return;
    }

    // Backward: a whole spread back, clamped at the first page.
    setSpreadScroll(Math.max(0, from - 2 * advance));
  }

  // Wheel → flips. The hard problem is macOS momentum: after a swipe, decaying
  // inertia events stream for 1–2s, and a fixed swallow-window either eats the
  // user's next swipe or double-fires on the tail. The physical distinction:
  // momentum deltas only DECAY; a finger push makes them RISE. Only deltas at
  // or above the recent-window maximum count toward a flip, so pushes register
  // even mid-tail while inertia never does. A short absolute cooldown catches
  // the rising edge of one push firing twice.
  const wheelRecent = []; // |delta| of the last few events
  let wheelAccum = 0;
  let wheelLastAt = 0;
  let wheelCooldownUntil = 0;
  function handleSpreadWheel(event) {
    handlePaneWheelIntent(event);
    event.preventDefault();
    const now = Date.now();
    const delta = event.deltaMode === 1 ? event.deltaY * getRenderedLineHeight() : event.deltaY;
    const abs = Math.abs(delta);
    if (now - wheelLastAt > 250) {
      // A real gap in events — new gesture, stale history gone.
      wheelRecent.length = 0;
      wheelAccum = 0;
    }
    wheelLastAt = now;
    const recentMax = wheelRecent.length ? Math.max(...wheelRecent) : 0;
    wheelRecent.push(abs);
    if (wheelRecent.length > 3) wheelRecent.shift();
    if (abs < recentMax) return; // decaying = momentum, never accumulates
    if (now < wheelCooldownUntil) return;
    if (wheelAccum !== 0 && Math.sign(delta) !== Math.sign(wheelAccum)) wheelAccum = 0;
    wheelAccum += delta;
    if (Math.abs(wheelAccum) < 40) return;
    const direction = wheelAccum > 0 ? 1 : -1;
    wheelAccum = 0;
    wheelCooldownUntil = now + 350;
    flipSpread(direction);
  }

  let spreadLayoutRaf = 0;
  function scheduleSpreadLayout() {
    if (!state.shell || !band.isOpen()) return;
    if (state.activeTarget || state.activeCard || state.queuedComments.length > 0) return;
    if (spreadLayoutRaf) cancelAnimationFrame(spreadLayoutRaf);
    spreadLayoutRaf = requestAnimationFrame(() => {
      spreadLayoutRaf = 0;
      layoutSpread();
    });
  }

  // Probe the text line box straddling a horizontal edge (y) of a page
  // viewport. Several x positions are tried because the edge may fall over
  // margins, list gutters, or blank space between blocks (→ null: no line is
  // cut there, nothing to align). Guarded for runtimes without
  // caretRangeFromPoint (tests): alignment then no-ops.
  function getLineRectAtEdge(rect, y) {
    if (typeof document.caretRangeFromPoint !== 'function') return null;
    const maxLine = getRenderedLineHeight() * 2;
    for (const x of [rect.left + 40, rect.left + rect.width / 2, rect.right - 40]) {
      let range = null;
      try { range = document.caretRangeFromPoint(x, y); } catch { continue; }
      if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) continue;
      const node = range.startContainer;
      if (!node.length) continue;
      // Strip/composer chrome carries text too (button labels, notes) — it is
      // apparatus, not a content line, and a pinned strip sits right at the
      // page bottom where this probe runs. Never let it define a page edge.
      if (node.parentElement && node.parentElement.closest
        && node.parentElement.closest('.md-pending-strip')) continue;
      const probe = document.createRange();
      const start = Math.min(range.startOffset, node.length - 1);
      probe.setStart(node, start);
      probe.setEnd(node, start + 1);
      const line = probe.getClientRects()[0];
      if (!line || line.height <= 0 || line.height > maxLine) continue;
      // caretRangeFromPoint over blank space returns the NEAREST caret, which
      // can be a line far from the edge (e.g. the doc's last line while the
      // probe sits in end-of-document emptiness). Only a line that actually
      // contains the probe y is a straddle; anything else means no line is
      // cut at this edge.
      if (line.top > y + 2 || line.bottom < y - 2) continue;
      return line;
    }
    return null;
  }

  // A page ends on a whole line: if the viewport's bottom edge cuts a line,
  // shrink the viewport so that line falls outside it — the leftover slack
  // reads as bottom margin, which is how books absorb it. Reset to full
  // height before every measurement pass (syncSecondaryPane, flipSpread).
  function trimPageBottom(viewport) {
    const rect = viewport.getBoundingClientRect();
    const line = getLineRectAtEdge(rect, rect.bottom - 1);
    if (!line || line.bottom <= rect.bottom + 0.5) return;
    const height = line.top - rect.top;
    if (height > 80) viewport.style.height = `${height}px`;
  }

  // Book-page alignment on every scroll change: pages start on a whole line
  // (top edges nudge ≤1 line, revealing the straddled line — extra overlap
  // never loses content) and end on a whole line (bottom trim). Idempotent:
  // the nudge re-fires the scroll handler, whose second pass measures aligned
  // edges and changes nothing.
  function syncSecondaryPane() {
    if (!state.primaryPane || !state.secondaryPane || !state.secondaryArticle) return;
    state.primaryPane.style.height = '';
    state.secondaryPane.style.height = '';

    // Full-page metrics, captured before any nudge or bottom-trim shrinks them.
    const paneHFull = state.primaryPane.clientHeight;
    const advance = getSpreadPageAdvance();

    const primaryRect = state.primaryPane.getBoundingClientRect();
    const primaryTopLine = getLineRectAtEdge(primaryRect, primaryRect.top + 1);
    if (primaryTopLine && primaryRect.top - primaryTopLine.top > 0.5) {
      state.primaryPane.scrollTop -= primaryRect.top - primaryTopLine.top;
    }

    let nextTop = state.primaryPane.scrollTop + advance;
    const nextLeft = state.primaryPane.scrollLeft || 0;
    state.secondaryPane.scrollTop = 0;
    state.secondaryPane.scrollLeft = 0;
    state.secondaryArticle.style.transform = `translate(${-nextLeft}px, ${-nextTop}px)`;

    const secondaryRect = state.secondaryPane.getBoundingClientRect();
    const secondaryTopLine = getLineRectAtEdge(secondaryRect, secondaryRect.top + 1);
    if (secondaryTopLine && secondaryRect.top - secondaryTopLine.top > 0.5) {
      nextTop -= secondaryRect.top - secondaryTopLine.top;
      state.secondaryArticle.style.transform = `translate(${-nextLeft}px, ${-nextTop}px)`;
    }

    trimPageBottom(state.primaryPane);
    trimPageBottom(state.secondaryPane);

    // Seam rules: draw each at the bottom of the lines its page repeats from the
    // page before it, spanning the text column. The right page's gutter seam
    // repeats the left page's *visible* bottom — measure it exactly (left visible
    // bottom minus right top) so trims and the whole-line nudge above are folded in.
    // The left page's flip seam repeats what the previous spread's right page ended
    // on: a whole page below that spread's top, i.e. content (gridTop + one page's
    // overlap). The same content renders here, so the repeat measured on THIS page
    // is the designed overlap plus however far the display was nudged/pulled up from
    // the grid top (gridTop - scrollTop) — that revealed tail was on the previous
    // spread too. That term also folds in the final spread's pull-back, so no
    // separate pull-back term is needed. The very first page is the document's real
    // start, not a repeat, so it carries no flip rule.
    const seamTop = state.primaryPane.scrollTop;
    const gutterOverlap = Math.max(0, (seamTop + state.primaryPane.clientHeight) - nextTop);
    const nudgeUp = Math.max(0, state.spreadGridTop - seamTop);
    const flipOverlap = state.spreadGridTop > 1 ? (paneHFull - advance) + nudgeUp : 0;
    const lineH = getRenderedLineHeight();
    // Align the rules to the centered text column, not the full pane width.
    const colRect = state.article.getBoundingClientRect();
    const paneRect = state.primaryPane.getBoundingClientRect(); // spans the pane horizontally
    const insetLeft = Math.max(0, Math.round(colRect.left - paneRect.left));
    const insetRight = Math.max(0, Math.round(paneRect.right - colRect.right));
    placeSeamRule(state.secondaryVeil, state.secondaryPane, gutterOverlap, lineH, insetLeft, insetRight);
    placeSeamRule(state.primaryVeil, state.primaryPane, flipOverlap, lineH, insetLeft, insetRight);
  }

  const MD_PANE_PAD_TOP = 18; // keep in sync with --md-pane-pad-top
  const MD_SEAM_CAP_H = 5;    // keep in sync with .md-recap-veil height (cap height)
  // Draw a seam bracket with its underline near the bottom of the recap, snapped
  // into the gap between lines so it can never slice through text, and lifted a
  // touch toward the repeated lines so it sits with the text you've read, not
  // crowding the fresh text below (its end-caps rise into that repeated region).
  // Hidden when nothing meaningful is repeated (overlap under ~a quarter line —
  // e.g. the very first page, or a seam that landed flush).
  function placeSeamRule(veil, viewport, overlapPx, lineH, insetLeft, insetRight) {
    if (!veil) return;
    if ((overlapPx || 0) <= Math.max(4, lineH * 0.25)) { veil.style.display = 'none'; return; }
    const rect = viewport.getBoundingClientRect();
    // (getLineRectAtEdge returns a single-glyph rect, so use its top as the line's
    // top edge; a line box bottom is ~one line below its top.)
    let boundaryTop = null; // fresh line's top == last repeated line's bottom, rel. to viewport
    const straddled = getLineRectAtEdge(rect, rect.top + overlapPx);
    if (straddled) {
      // The overlap depth lands on a line. Round to the nearer line edge: a line
      // more than half inside the overlap is (mostly) a repeat, so hug its bottom;
      // otherwise it's fresh, so hug its top (the last repeated line's bottom).
      // Always flooring to the top dropped a last line that a whole-line nudge left
      // mostly repeated — the "repeat separator missed the last line" bug, worst on
      // the flip seam where the nudge pushes the overlap past a full line.
      const lineTop = straddled.top - rect.top;
      if (overlapPx - lineTop > lineH * 0.5) {
        boundaryTop = lineTop + lineH; // this straddled line is itself a repeat
      } else {
        boundaryTop = lineTop;
        // Unless a paragraph margin sits just above it: then this line is a fresh
        // paragraph, and the last repeated line is above the margin — hug that instead
        // of floating over the margin. (Skip for the page's own first line.)
        if (boundaryTop > lineH) {
          const prev = getLineRectAtEdge(rect, rect.top + boundaryTop - Math.round(lineH * 0.9));
          if (prev && boundaryTop - (prev.top - rect.top) > lineH * 1.25) {
            boundaryTop = (prev.top - rect.top) + lineH; // the repeated line's own bottom
          }
        }
      }
    } else {
      // Boundary fell in a gap/margin with no line straddling it — scan up to the
      // last text line and take its bottom.
      for (let y = overlapPx - 4; y >= Math.max(1, overlapPx - lineH * 1.8); y -= 4) {
        const line = getLineRectAtEdge(rect, rect.top + y);
        if (line) { boundaryTop = (line.top - rect.top) + lineH; break; }
      }
    }
    // The boundary must not sit more than ~half a line below where the overlap
    // actually ends — that would mark a mostly-fresh line as a repeat (the else
    // fallback can snap to a whole line when barely half a line repeats). Round it
    // back up to the nearer line; under a truly-repeated line that lands it above
    // the first line, and the hide check below drops it.
    if (boundaryTop != null && boundaryTop - overlapPx > lineH * 0.5) boundaryTop -= lineH;
    // Nothing repeated above the boundary (only a paragraph margin, or the page
    // starts fresh here) — nothing to mark, so hide.
    if (boundaryTop == null || boundaryTop < lineH * 0.85) { veil.style.display = 'none'; return; }
    const underlineY = MD_PANE_PAD_TOP + boundaryTop - Math.round(lineH * 0.15); // hug the repeated line
    veil.style.left = `${insetLeft}px`;
    veil.style.right = `${insetRight}px`;
    veil.style.top = `${Math.max(2, underlineY - MD_SEAM_CAP_H)}px`; // caps rise above the underline
    veil.style.display = 'block';
  }

  function handlePrimaryPaneScroll() {
    syncSecondaryPane();
    if (state.activeSelection && !state.activeCard) {
      clearActiveTarget();
    }
  }

  // Re-measure the page window without rebuilding content. A height change (the
  // band 2/3↔full animation, or an image finishing decode) alters how much fits
  // below the left page's top line, never what sits at the top — so pin that top
  // line across the pass: refresh the spacers and the right-page seam, then
  // restore the scroll offset so mid-change snap nudges can't accumulate.
  function realignPagesPreservingTop() {
    const keepTop = state.primaryPane ? state.primaryPane.scrollTop : 0;
    updateBottomSpacer();
    syncSecondaryPane();
    if (state.primaryPane && state.primaryPane.scrollTop !== keepTop) {
      state.primaryPane.scrollTop = keepTop;
    }
    // The composer bubble lives in ONE article copy (its counterpart is a blank
    // spacer), so unlike thread cards it cannot continue across the page split —
    // and layoutSpread is frozen while it's open. When this pass shrinks the
    // page window (band full→golden, window resize, an image settling), the
    // page bottom sweeps through the open bubble unless it re-fits here.
    fitActiveCommentCard();
  }

  // Content-anchored counterpart to the pixel-preserving realign above. The
  // comment apparatus lives in the article flow and changes height with state
  // (composer bubble, one-line queued mark, waiting line, full thread card,
  // resolved count line). When such a change lands ABOVE the page top, a pixel
  // scrollTop slides different text under the reader and every later flip
  // inherits the error — so paging is shift-aware: capture which block sits at
  // the left page top, run the mutation, then move the scroll AND the page
  // grid by however far that block moved. Below-top changes move no captured
  // block and fall through untouched.
  function captureSpreadTopMarks() {
    if (!state.primaryPane || !state.article) return null;
    const paneTop = state.primaryPane.getBoundingClientRect().top;
    const articleTop = state.article.getBoundingClientRect().top;
    let straddler = null;
    const marks = [];
    for (const el of state.article.querySelectorAll('[data-md-anchor-id]')) {
      const rect = el.getBoundingClientRect();
      if (!rect.height || rect.bottom <= paneTop + 1) continue;
      const mark = { id: el.getAttribute('data-md-anchor-id'), top: rect.top - articleTop };
      // The deepest block straddling the page top is the true anchor (a list
      // item beats its whole list: a mutation inside the list above the item
      // still shifts it). Blocks fully below are fallbacks in case a mutation
      // replaces the anchor element itself.
      if (rect.top <= paneTop + 1) { straddler = mark; continue; }
      marks.push(mark);
      if (marks.length >= 3) break;
    }
    if (straddler) marks.unshift(straddler);
    return marks.length ? marks : null;
  }

  function preserveSpreadTopAcross(mutate) {
    const marks = captureSpreadTopMarks();
    mutate();
    if (!marks || !state.primaryPane || !state.article) return;
    const articleTop = state.article.getBoundingClientRect().top;
    for (const mark of marks) {
      const el = getAnchorElement({ id: mark.id });
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.height) continue;
      const shift = (rect.top - articleTop) - mark.top;
      if (Math.abs(shift) >= 0.5) {
        state.primaryPane.scrollTop += shift;
        state.spreadGridTop = (state.spreadGridTop || 0) + shift;
        syncSecondaryPane();
      }
      return;
    }
  }

  // Embedded images carry no width/height and decode async. Every layoutSpread
  // rebuilds both panes' innerHTML, so on a re-layout (thread-store poll, edit,
  // resize) the <img> starts over at zero height: the geometry pass measures the
  // seam and bottom trims against a collapsed column, and once the pixels arrive
  // and the image springs back to full height, everything below it — comment
  // cards included — is shoved down out of the overflow:hidden page with no
  // scrollbar to reveal it. That is the "comments vanish under an image" bug.
  //
  // Fix: cache each image's rendered height (keyed by src sans cache-buster) and
  // stamp it as an explicit height on every render, BEFORE the geometry pass, so
  // the column never collapses on a re-layout. (An unloaded <img> has zero
  // intrinsic size, so `aspect-ratio` alone reserves nothing — the box needs a
  // definite height; width stays responsive under max-width:100%.) Then re-
  // measure the true height at the current column width and refresh the cache —
  // complete images on each render, still-loading ones on their load event. A
  // window resize is what changes the column width, and it re-runs layoutSpread,
  // whose fresh <img>s re-measure (complete → synchronously), so the reserve
  // self-corrects at the new width instead of stranding a stale height. (The
  // band 2/3↔full toggle only changes height, not width, so its geometry-only
  // realign needs no re-measure.) The very first load can't reserve height yet,
  // but that happens at scrollTop 0 where no comment is in view.
  const imageHeightBySrc = new Map();
  const imageKey = (img) => String(img.src || '').split('?')[0];

  // Reserve known image heights on freshly-rendered HTML, before anything
  // measures the column. Call right after each innerHTML assignment.
  function reserveCachedImageHeights(article) {
    if (!article) return;
    for (const img of article.querySelectorAll('img')) {
      const h = imageHeightBySrc.get(imageKey(img));
      if (h > 0) img.style.height = `${h}px`;
    }
  }
  let imageSettleRaf = 0;
  function scheduleImageSettleRealign() {
    if (imageSettleRaf) return;
    imageSettleRaf = requestAnimationFrame(() => {
      imageSettleRaf = 0;
      if (band.isOpen()) realignPagesPreservingTop();
    });
  }
  // Measure the image's true rendered height at the current column width: clear
  // any reserved height first so the read reflects the loaded image, not the
  // value we stamped. Cache it for the next render, re-apply it, and re-align.
  function measureAndReserveImage(img) {
    const key = imageKey(img);
    img.style.height = '';
    const h = img.getBoundingClientRect().height;
    if (h > 0 && key) { imageHeightBySrc.set(key, h); img.style.height = `${h}px`; }
    scheduleImageSettleRealign();
  }
  function watchArticleImages() {
    for (const article of [state.article, state.secondaryArticle]) {
      if (!article) continue;
      for (const img of article.querySelectorAll('img')) {
        if (img.complete && img.naturalHeight) { measureAndReserveImage(img); continue; }
        img.addEventListener('load', () => measureAndReserveImage(img), { once: true });
        img.addEventListener('error', scheduleImageSettleRealign, { once: true });
      }
    }
  }

  function isOpen() {
    // "Up" = open OR rolled-up (hidden) — both mean the viewer owns the band, so
    // mutual exclusion should still close it when the other viewer opens.
    return !!(state.shell && (band.isOpen() || band.isHidden()));
  }

  function hasBlockingMarkdownRefreshState() {
    // A pending edit batch freezes doc refreshes for the whole turn: the user
    // edits against the snapshot they started from, and reconciliation happens
    // once, at handoff (md-editing-design.md, Conflicts).
    return !!state.activeCard || state.queuedComments.length > 0 || !!state.threadReply
      || !!state.editing || state.blockOverlays.size > 0;
  }

  function stopMarkdownAutoRefresh() {
    if (state.refreshPollTimer) {
      clearInterval(state.refreshPollTimer);
      state.refreshPollTimer = null;
    }
    if (state.refreshDebounceTimer) {
      clearTimeout(state.refreshDebounceTimer);
      state.refreshDebounceTimer = null;
    }
    if (state.refreshPulseTimer) {
      clearTimeout(state.refreshPulseTimer);
      state.refreshPulseTimer = null;
    }
    if (state.shell) state.shell.classList.remove('vb-refreshed');
    state.pendingRefreshResult = null;
    state.pendingRefreshSignature = '';
    state.pendingRefreshStatSignature = '';
    state.refreshPulseStartedAt = 0;
    state.refreshPulseViewUpdated = true;
    state.refreshInFlight = false;
  }

  function scheduleMarkdownRefreshPulseStop() {
    if (!state.refreshPulseStartedAt) return;
    if (state.refreshPulseTimer) clearTimeout(state.refreshPulseTimer);

    const elapsedMs = Date.now() - state.refreshPulseStartedAt;
    const remainingMs = Math.max(0, MARKDOWN_REFRESH_PULSE_MS - elapsedMs);
    if (state.refreshPulseViewUpdated && remainingMs === 0) {
      if (state.shell) state.shell.classList.remove('vb-refreshed');
      state.refreshPulseTimer = null;
      state.refreshPulseStartedAt = 0;
      return;
    }

    state.refreshPulseTimer = setTimeout(() => {
      state.refreshPulseTimer = null;
      scheduleMarkdownRefreshPulseStop();
    }, remainingMs || 100);
  }

  function startMarkdownRefreshPulse() {
    if (!state.shell) return;
    if (state.refreshPulseTimer) {
      clearTimeout(state.refreshPulseTimer);
      state.refreshPulseTimer = null;
    }
    state.refreshPulseStartedAt = Date.now();
    state.refreshPulseViewUpdated = false;
    state.shell.classList.remove('vb-refreshed');
    void state.shell.offsetWidth;
    state.shell.classList.add('vb-refreshed');
    scheduleMarkdownRefreshPulseStop();
  }

  function markMarkdownRefreshViewUpdated() {
    if (!state.refreshPulseStartedAt) return;
    state.refreshPulseViewUpdated = true;
    scheduleMarkdownRefreshPulseStop();
  }

  // Local image srcs render against the doc's own directory; the platform
  // file:// prefix comes from main with each read (see read-markdown-file).
  function markdownImageOptions(result) {
    const resolved = (result && result.path) || state.resolvedPath || state.filePath || '';
    const lastSlash = resolved.lastIndexOf('/');
    if (result && result.imageRoot) state.imageRoot = result.imageRoot;
    if (!state.imageRoot || lastSlash < 0) return null;
    return {
      rootUrl: state.imageRoot,
      docDir: resolved.slice(0, lastSlash) || '/',
      version: result && Number.isFinite(result.mtimeMs) ? result.mtimeMs : null,
    };
  }

  function applyMarkdownReadResult(result, { preserveScroll = false } = {}) {
    if (!result || !result.success || !state.article || !state.secondaryArticle) return false;
    const previousScrollTop = preserveScroll && state.primaryPane ? state.primaryPane.scrollTop : 0;
    const previousDoc = state.doc;
    const previousSourceText = state.sourceText;
    const nextSourceText = result.content || '';
    const nextDoc = renderMarkdownDocument(nextSourceText, markdownImageOptions(result));
    const changeRecords = preserveScroll
      ? computeMarkdownChangeRecords({
          oldDoc: previousDoc,
          newDoc: nextDoc,
          oldSource: previousSourceText,
          newSource: nextSourceText,
        })
      : [];
    state.resolvedPath = result.path || state.resolvedPath || state.filePath;
    state.doc = nextDoc;
    state.sourceText = nextSourceText;
    state.fileSignature = getMarkdownReadSignature(result);
    state.fileStatSignature = getMarkdownStatSignature(result);
    band.setTitle(state.resolvedPath);
    clearActiveTarget();
    if (preserveScroll) recordMarkdownObservedChange(changeRecords);
    else clearMarkdownChangeHighlightState();
    layoutSpread();
    if (preserveScroll && state.primaryPane) {
      const maxScrollTop = Math.max(0, state.primaryPane.scrollHeight - state.primaryPane.clientHeight);
      state.primaryPane.scrollTop = Math.min(previousScrollTop, maxScrollTop);
      state.spreadGridTop = state.primaryPane.scrollTop; // re-base the grid after a live refresh
      syncSecondaryPane();
    } else {
      state.spreadGridTop = 0; // a fresh open starts at the top
    }
    return true;
  }

  // Hold a disk refresh that would break a currently-pinned (sealed) edit: a
  // sent edit stays in place until the agent answers it, so the agent's own
  // file-write landing a beat before its reply — or an external change — can't
  // flash through under the pending marks. A refresh that leaves every held seal
  // intact (an unrelated block changed, or no sealed edits) applies normally;
  // the held one lands the moment the thread is answered (pollMarkdownThreadStore).
  function pendingRefreshWouldOrphanSeal() {
    const result = state.pendingRefreshResult;
    if (!result || !state.article) return false;
    const threads = (state.threadStore && Array.isArray(state.threadStore.threads)) ? state.threadStore.threads : [];
    const sealed = threads.filter(isUnconsumedEditThread);
    if (!sealed.length) return false;
    let nextArticle = null;
    for (const thread of sealed) {
      const snip = snippetMatchText(thread.anchor && thread.anchor.snippet);
      if (!snip) continue;
      const curTarget = resolveThreadTarget(state.article, thread);
      const heldNow = !!(curTarget && normalizeChangeMatchText(getRenderedText(curTarget)).includes(snip));
      if (!heldNow) continue; // not pinned in place today — nothing to protect
      if (!nextArticle) {
        const nextDoc = renderMarkdownDocument(result.content || '', markdownImageOptions(result));
        nextArticle = createDetachedMarkdownArticle(nextDoc);
      }
      const nextTarget = resolveThreadTarget(nextArticle, thread);
      const heldNext = !!(nextTarget && normalizeChangeMatchText(getRenderedText(nextTarget)).includes(snip));
      if (!heldNext) return true; // the refresh would orphan a held seal — hold it
    }
    return false;
  }

  function applyPendingMarkdownRefreshIfReady() {
    if (!state.pendingRefreshResult || !isOpen() || hasBlockingMarkdownRefreshState()) return false;
    if (pendingRefreshWouldOrphanSeal()) return false;
    const result = state.pendingRefreshResult;
    state.pendingRefreshResult = null;
    state.pendingRefreshSignature = '';
    state.pendingRefreshStatSignature = '';
    const applied = applyMarkdownReadResult(result, { preserveScroll: true });
    if (applied) markMarkdownRefreshViewUpdated();
    return applied;
  }

  function schedulePendingMarkdownRefresh() {
    if (state.refreshDebounceTimer) clearTimeout(state.refreshDebounceTimer);
    state.refreshDebounceTimer = setTimeout(() => {
      state.refreshDebounceTimer = null;
      applyPendingMarkdownRefreshIfReady();
    }, MARKDOWN_REFRESH_DEBOUNCE_MS);
  }

  async function pollMarkdownFile(openToken) {
    if (!isOpen() || openToken !== state.openToken || state.refreshInFlight) return;
    if (!state.resolvedPath && !state.filePath) return;
    state.refreshInFlight = true;
    try {
      if (typeof statMarkdownFile !== 'function') {
        throw new Error('Markdown refresh stat API is unavailable');
      }
      const statResult = await statMarkdownFile(state.resolvedPath || state.filePath);
      if (!isOpen() || openToken !== state.openToken) return;
      if (!statResult || !statResult.success) {
        throw new Error((statResult && statResult.error) || 'Markdown refresh stat failed');
      }
      const statSignature = getMarkdownStatSignature(statResult);
      if (!statSignature) {
        throw new Error('Markdown refresh stat response is missing mtime/size');
      }
      const currentStatSignature = state.pendingRefreshStatSignature || state.fileStatSignature;
      if (statSignature === currentStatSignature) {
        applyPendingMarkdownRefreshIfReady();
        return;
      }

      startMarkdownRefreshPulse();
      const result = await readMarkdownFile(state.resolvedPath || state.filePath);
      if (!isOpen() || openToken !== state.openToken) return;
      if (!result || !result.success) {
        throw new Error((result && result.error) || 'Markdown refresh read failed');
      }
      const signature = getMarkdownReadSignature(result);
      const resultStatSignature = getMarkdownStatSignature(result);
      const currentSignature = state.pendingRefreshSignature || state.fileSignature;
      if (!signature || signature === currentSignature) {
        state.fileStatSignature = statSignature;
        markMarkdownRefreshViewUpdated();
        applyPendingMarkdownRefreshIfReady();
        return;
      }
      state.pendingRefreshResult = result;
      state.pendingRefreshSignature = signature;
      state.pendingRefreshStatSignature = resultStatSignature || statSignature;
      schedulePendingMarkdownRefresh();
    } catch (error) {
      stopMarkdownAutoRefresh();
      if (typeof showToast === 'function') {
        showToast(error && error.message ? error.message : 'Markdown refresh failed');
      }
    } finally {
      state.refreshInFlight = false;
    }
  }

  function startMarkdownAutoRefresh(openToken) {
    stopMarkdownAutoRefresh();
    state.refreshPollTimer = setInterval(() => {
      pollMarkdownFile(openToken);
      pollMarkdownThreadStore(openToken);
    }, MARKDOWN_REFRESH_POLL_MS);
  }

  // The sidecar store changes on its own clock (the agent replies whenever),
  // so it rides the same 1s poll as the doc. A JSON signature gates re-renders;
  // store read errors are non-fatal for the reading surface.
  async function pollMarkdownThreadStore(openToken) {
    if (!isOpen() || openToken !== state.openToken || state.threadPollInFlight) return;
    if (state.threadRenderPending && !hasBlockingMarkdownRefreshState() && !spreadLayoutFrozen()) {
      state.threadRenderPending = false;
      layoutSpread();
    }
    const doc = state.resolvedPath || state.filePath;
    if (!doc || typeof readMarkdownThreads !== 'function') return;
    state.threadPollInFlight = true;
    try {
      const result = await readMarkdownThreads({ docPath: doc });
      if (!isOpen() || openToken !== state.openToken) return;
      if (!result || !result.success || !result.data) return;
      const sig = JSON.stringify(result.data);
      if (sig === state.threadStoreSig) return;
      state.threadStoreSig = sig;
      state.threadStore = result.data;
      syncChangeAgeToStoreTurn(result.data);
      // A store update can answer a sealed edit, releasing a refresh that was
      // held waiting on it — apply it now so the resolve lands in one step.
      if (!applyPendingMarkdownRefreshIfReady()) scheduleThreadLayerRender();
      maybeResumeFullSize();
    } catch {} finally {
      state.threadPollInFlight = false;
    }
  }

  function scheduleThreadLayerRender() {
    // A frozen layout has to come back as pending, not be handed to layoutSpread
    // to swallow: the store signature is already recorded, so no later poll asks
    // for this render again and the agent's reply would never appear.
    if (hasBlockingMarkdownRefreshState() || spreadLayoutFrozen()) {
      state.threadRenderPending = true;
      return;
    }
    layoutSpread();
  }

  function adoptThreadStore(data) {
    if (!data) return;
    state.threadStore = data;
    state.threadStoreSig = JSON.stringify(data);
    syncChangeAgeToStoreTurn(data);
  }

  function getSearchableTextNodes(root) {
    if (!root) return { text: '', nodes: [] };
    const filter = window.NodeFilter || {
      SHOW_TEXT: 4,
      FILTER_ACCEPT: 1,
      FILTER_REJECT: 2,
    };
    const nodes = [];
    let text = '';
    const walker = document.createTreeWalker(root, filter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node || !node.nodeValue) return filter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return filter.FILTER_REJECT;
        const tagName = parent.tagName ? parent.tagName.toUpperCase() : '';
        if (tagName === 'SCRIPT' || tagName === 'STYLE') return filter.FILTER_REJECT;
        // Struck "deleted" decorations are not document text (searching,
        // anchoring, and offsets must see only the real content).
        if (parent.closest && parent.closest('del.md-pending-del, del.md-sent-del')) return filter.FILTER_REJECT;
        return filter.FILTER_ACCEPT;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue || '';
      nodes.push({
        node,
        start: text.length,
        end: text.length + value.length,
      });
      text += value;
    }
    return { text, nodes };
  }

  function unwrapElement(element) {
    if (!element || !element.parentNode) return;
    const parent = element.parentNode;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    parent.removeChild(element);
    parent.normalize();
  }

  function clearSearchMarks() {
    if (!state.spreadLayout) return;
    for (const mark of Array.from(state.spreadLayout.querySelectorAll('mark.md-search-match'))) {
      unwrapElement(mark);
    }
  }

  function getArticleAnchors(article) {
    if (!article) return [];
    return Array.from(article.querySelectorAll('[data-md-anchor-id]'));
  }

  function getArticleAnchorById(article, id) {
    if (!article || !id) return null;
    return article.querySelector(`[data-md-anchor-id="${escapeSelectorValue(id)}"]`);
  }

  function collectMarkdownSearchMatches(query) {
    const matches = [];
    for (const anchor of getArticleAnchors(state.article)) {
      const anchorId = anchor.getAttribute('data-md-anchor-id');
      if (!anchorId) continue;
      const { text } = getSearchableTextNodes(anchor);
      for (const range of findMarkdownSearchRanges(text, query)) {
        matches.push({
          index: matches.length,
          anchorId,
          start: range.start,
          end: range.end,
        });
      }
    }
    return matches;
  }

  function wrapTextPiece(piece, match) {
    if (!piece || !piece.node || piece.from >= piece.to) return;
    const range = document.createRange();
    range.setStart(piece.node, piece.from);
    range.setEnd(piece.node, piece.to);
    const mark = document.createElement('mark');
    mark.className = `md-search-match${match.index === state.search.currentIndex ? ' current' : ''}`;
    mark.setAttribute('data-md-search-index', String(match.index));
    try {
      range.surroundContents(mark);
    } catch {
      // A single text-node range should be surroundable. If the browser rejects
      // a pathological node, skip that visual piece without dropping the match.
    }
  }

  function renderSearchMatchInAnchor(anchor, match) {
    const { nodes } = getSearchableTextNodes(anchor);
    const pieces = [];
    for (const segment of nodes) {
      const start = Math.max(segment.start, match.start);
      const end = Math.min(segment.end, match.end);
      if (start >= end) continue;
      pieces.push({
        node: segment.node,
        from: start - segment.start,
        to: end - segment.start,
        absoluteStart: start,
      });
    }

    pieces
      .sort((a, b) => b.absoluteStart - a.absoluteStart || b.from - a.from)
      .forEach((piece) => wrapTextPiece(piece, match));
  }

  function applySearchMarksToArticle(article) {
    if (!article) return;
    const byAnchor = new Map();
    for (const match of state.search.matches) {
      if (!byAnchor.has(match.anchorId)) byAnchor.set(match.anchorId, []);
      byAnchor.get(match.anchorId).push(match);
    }

    for (const [anchorId, matches] of byAnchor.entries()) {
      const anchor = getArticleAnchorById(article, anchorId);
      if (!anchor) continue;
      matches
        .slice()
        .sort((a, b) => b.start - a.start || b.end - a.end)
        .forEach((match) => renderSearchMatchInAnchor(anchor, match));
    }
  }

  function applyMarkdownSearchHighlights() {
    clearSearchMarks();
    applySearchMarksToArticle(state.article);
    applySearchMarksToArticle(state.secondaryArticle);
    updateChangeHighlights();
    updateSelectionHighlights();
  }

  function getElementTopInPrimaryArticle(element) {
    if (!element || !state.article) return 0;
    const elementRect = element.getBoundingClientRect();
    const articleRect = state.article.getBoundingClientRect();
    return elementRect.top - articleRect.top;
  }

  function getPrimarySearchMark(match) {
    if (!match || !state.article) return null;
    return state.article.querySelector(`mark.md-search-match[data-md-search-index="${match.index}"]`);
  }

  function scrollMarkdownSearchMatchIntoView(match) {
    if (!match || !state.primaryPane) return;
    const mark = getPrimarySearchMark(match);
    const anchor = getArticleAnchorById(state.article, match.anchorId);
    const target = mark || anchor;
    if (!target) return;

    const targetTop = getElementTopInPrimaryArticle(target);
    const paneTop = state.primaryPane.scrollTop;
    const paneHeight = state.primaryPane.clientHeight || 0;
    if (!paneHeight) return;

    const margin = 24;
    const leftStart = paneTop;
    const leftEnd = paneTop + paneHeight;
    const pageAdvance = getSpreadPageAdvance();
    const rightStart = paneTop + pageAdvance;
    const rightEnd = rightStart + paneHeight;
    const isInLeft = targetTop >= leftStart + margin && targetTop <= leftEnd - margin;
    const isInRight = targetTop >= rightStart + margin
      && targetTop <= rightEnd - margin;

    if (!isInLeft && !isInRight) {
      state.primaryPane.scrollTop = Math.max(0, targetTop - paneHeight * 0.35);
      state.spreadGridTop = state.primaryPane.scrollTop; // jump re-bases the grid
    }
    syncSecondaryPane();
  }

  function getBestInitialMarkdownSearchIndex(matches) {
    if (!matches.length || !state.primaryPane) return -1;
    const center = state.primaryPane.scrollTop + (state.primaryPane.clientHeight || 0) / 2;
    let bestIndex = 0;
    let bestDistance = Infinity;

    for (let i = 0; i < matches.length; i++) {
      const anchor = getArticleAnchorById(state.article, matches[i].anchorId);
      const top = anchor ? anchor.offsetTop : 0;
      const distance = Math.abs(top - center);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  function getMarkdownSearchResult() {
    return {
      matchCount: state.search.matches.length,
      currentIndex: state.search.currentIndex,
      query: state.search.query,
    };
  }

  function openSearch() {
    if (!isOpen()) return getMarkdownSearchResult();
    state.search.isOpen = true;
    return getMarkdownSearchResult();
  }

  function closeSearch() {
    state.search.isOpen = false;
    state.search.query = '';
    state.search.matches = [];
    state.search.currentIndex = -1;
    clearSearchMarks();
    updateChangeHighlights();
    updateSelectionHighlights();
    // Hand focus back to the doc only when it's actually on screen — closing a
    // search as the band rolls up must not focus the hidden shell.
    if (band.isOpen()) {
      try { state.shell.focus({ preventScroll: true }); } catch {}
    }
    syncSecondaryPane();
    return getMarkdownSearchResult();
  }

  function runSearch(query) {
    if (!isOpen()) return closeSearch();
    state.search.isOpen = true;
    state.search.query = String(query || '');
    state.search.matches = [];
    state.search.currentIndex = -1;
    clearSearchMarks();

    if (!state.search.query) {
      updateChangeHighlights();
      syncSecondaryPane();
      return getMarkdownSearchResult();
    }

    state.search.matches = collectMarkdownSearchMatches(state.search.query);
    state.search.currentIndex = getBestInitialMarkdownSearchIndex(state.search.matches);
    applyMarkdownSearchHighlights();
    if (state.search.currentIndex >= 0) {
      scrollMarkdownSearchMatchIntoView(state.search.matches[state.search.currentIndex]);
    } else {
      syncSecondaryPane();
    }
    return getMarkdownSearchResult();
  }

  function navigateSearch(delta) {
    if (!state.search.isOpen || state.search.matches.length === 0) return getMarkdownSearchResult();
    const count = state.search.matches.length;
    state.search.currentIndex = (state.search.currentIndex + delta + count) % count;
    applyMarkdownSearchHighlights();
    scrollMarkdownSearchMatchIntoView(state.search.matches[state.search.currentIndex]);
    return getMarkdownSearchResult();
  }

  function refreshSearchAfterRender() {
    if (!state.search.isOpen || !state.search.query) return false;
    const previousIndex = state.search.currentIndex;
    state.search.matches = collectMarkdownSearchMatches(state.search.query);
    state.search.currentIndex = Math.min(previousIndex, state.search.matches.length - 1);
    if (state.search.currentIndex < 0 && state.search.matches.length > 0) {
      state.search.currentIndex = 0;
    }
    applyMarkdownSearchHighlights();
    if (state.search.currentIndex >= 0) {
      scrollMarkdownSearchMatchIntoView(state.search.matches[state.search.currentIndex]);
    } else {
      syncSecondaryPane();
    }
    return true;
  }

  function getSearchSelectionText() {
    if (!isOpen()) return '';
    const selection = window.getSelection && window.getSelection();
    if (!selection || selection.isCollapsed) return '';
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (
      !state.shell.contains(anchorNode && anchorNode.nodeType === 1 ? anchorNode : anchorNode && anchorNode.parentNode)
      || !state.shell.contains(focusNode && focusNode.nodeType === 1 ? focusNode : focusNode && focusNode.parentNode)
    ) {
      return '';
    }
    return String(selection.toString() || '').trim();
  }

  function getElementForNode(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function getAnchorForNode(node) {
    const element = getElementForNode(node);
    return element && element.closest ? element.closest('[data-md-anchor-id]') : null;
  }

  function isNodeInsideMarkdown(node) {
    const element = getElementForNode(node);
    return !!(element && state.spreadLayout && state.spreadLayout.contains(element));
  }

  function getRangeEndRect(range) {
    if (!range) return null;
    const rects = Array.from(range.getClientRects ? range.getClientRects() : [])
      .filter((rect) => rect && (rect.width > 0 || rect.height > 0));
    return rects[rects.length - 1] || (range.getBoundingClientRect ? range.getBoundingClientRect() : null);
  }

  // DOM position → offset in the SAME filtered text space getTextPositionWithin
  // and createTextRangeWithin map back from (getSearchableTextNodes: struck del
  // decorations are excluded). Counting raw DOM text here instead shifted every
  // caret and selection highlight left on a block already carrying marks. A
  // position inside excluded text lands at the boundary before it.
  function getTextOffsetWithin(root, container, offset) {
    if (!root || !container) return 0;
    try {
      const point = document.createRange();
      point.setStart(container, offset);
      point.collapse(true);
      let count = 0;
      for (const segment of getSearchableTextNodes(root).nodes) {
        const value = String(segment.node.nodeValue || '');
        if (segment.node === container) return count + Math.max(0, Math.min(offset, value.length));
        if (point.comparePoint(segment.node, value.length) > 0) break;
        count += value.length;
      }
      return count;
    } catch {
      return 0;
    }
  }

  function getTextPositionWithin(root, offset) {
    if (!root || !Number.isFinite(offset)) return null;
    const { nodes } = getSearchableTextNodes(root);
    const targetOffset = Math.max(0, offset);
    for (const segment of nodes) {
      if (targetOffset < segment.end) {
        return {
          node: segment.node,
          offset: Math.max(0, targetOffset - segment.start),
        };
      }
    }

    const last = nodes[nodes.length - 1];
    if (!last) return null;
    return {
      node: last.node,
      offset: String(last.node.nodeValue || '').length,
    };
  }

  function createTextRangeWithin(root, start, end) {
    if (!root || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const startPosition = getTextPositionWithin(root, start);
    const endPosition = getTextPositionWithin(root, end);
    if (!startPosition || !endPosition) return null;
    try {
      const range = document.createRange();
      range.setStart(startPosition.node, startPosition.offset);
      range.setEnd(endPosition.node, endPosition.offset);
      return range;
    } catch {
      return null;
    }
  }

  const CHANGE_HOVER_HIGHLIGHT_NAMES = ['md-change-hover-exact', 'md-change-hover-anchor'];
  function clearChangeHoverHighlight() {
    const highlights = window.CSS && window.CSS.highlights;
    if (!highlights || typeof highlights.delete !== 'function') return;
    for (const name of CHANGE_HOVER_HIGHLIGHT_NAMES) highlights.delete(name);
  }

  // Hover a barred block → that block's changed ranges light up while the
  // pointer rests there; leaving clears them. Delegated from the spread
  // layout; the element guard keeps descendant mouseovers cheap.
  function handleChangeBarHover(event) {
    const target = event.target && event.target.closest
      ? event.target.closest('.md-change-bar')
      : null;
    if (target === state.changeHoverEl) return;
    state.changeHoverEl = target;
    clearChangeHoverHighlight();
    if (!target) return;
    const highlights = window.CSS && window.CSS.highlights;
    if (!highlights || typeof highlights.set !== 'function' || typeof window.Highlight !== 'function') return;
    const article = target.closest('.md-viewer-body');
    const id = target.getAttribute('data-md-anchor-id');
    const records = (state.changeBarRecords && state.changeBarRecords.get(id)) || [];
    const byKind = { exact: [], anchor: [] };
    for (const record of records) {
      const kind = record.kind === 'anchor' ? 'anchor' : 'exact';
      byKind[kind].push(...createChangeHighlightRangesForArticle(article, record));
    }
    try {
      if (byKind.exact.length) highlights.set('md-change-hover-exact', new window.Highlight(...byKind.exact));
      if (byKind.anchor.length) highlights.set('md-change-hover-anchor', new window.Highlight(...byKind.anchor));
    } catch {}
  }

  function clearChangeFlashTimer() {
    if (state.changeFlashTimer) {
      clearTimeout(state.changeFlashTimer);
      state.changeFlashTimer = 0;
    }
  }

  function clearChangePulse() {
    for (const el of state.changePulseEls) {
      el.classList.remove('md-change-pulse');
    }
    state.changePulseEls = [];
  }

  // Pulse the changed block(s) themselves — the freshly rendered anchor elements —
  // so the tint rides the text (no overlay to re-measure on scroll). Called from
  // layoutSpread after the render, since startChangeFlash runs while the DOM still
  // holds the old content.
  function applyChangePulse() {
    clearChangePulse();
    const records = state.changeFlashRecords;
    if (!records || !records.length || !state.article || !state.secondaryArticle) return;
    const targets = [];
    const seen = new Set();
    for (const record of records) {
      for (const article of [state.article, state.secondaryArticle]) {
        const el = resolveChangeRecordAnchor(article, record);
        if (!el || seen.has(el)) continue;
        seen.add(el);
        targets.push(el);
      }
    }
    if (!targets.length) return;
    // Force a reflow so re-adding the class restarts the animation when the same
    // block pulses again without a full re-render (mirrors the review viewer's pulseEl).
    void state.article.offsetWidth;
    for (const el of targets) {
      el.classList.add('md-change-pulse');
      state.changePulseEls.push(el);
    }
  }

  function stopChangeFlash() {
    clearChangeFlashTimer();
    state.changeFlashToken += 1;
    state.changeFlashRecords = [];
    clearChangePulse();
  }

  function clearMarkdownChangeHighlightState() {
    state.changeHighlightBatches = [];
    state.changeClockTurn = null;
    state.changeBarRecords = null;
    state.changeHoverEl = null;
    stopChangeFlash();
    clearChangeHoverHighlight();
  }

  function startChangeFlash(records) {
    clearChangeFlashTimer();
    const flashRecords = (Array.isArray(records) ? records : [])
      .filter((record) => record && (record.kind === 'exact' || record.kind === 'anchor'));
    state.changeFlashToken += 1;
    const token = state.changeFlashToken;
    state.changeFlashRecords = flashRecords;
    clearChangePulse();
    if (!flashRecords.length) {
      return;
    }

    // The pulse classes land in the following layoutSpread (fresh DOM); here we
    // just arm the lifecycle and the removal timer.
    state.changeFlashTimer = setTimeout(() => {
      if (state.changeFlashToken !== token) return;
      state.changeFlashRecords = [];
      state.changeFlashTimer = 0;
      clearChangePulse();
    }, MARKDOWN_CHANGE_FLASH_MS);
  }

  function mergeTextRanges(ranges) {
    const sorted = (Array.isArray(ranges) ? ranges : [])
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

  function createDetachedMarkdownArticle(doc) {
    const article = document.createElement('article');
    article.className = 'md-viewer-body';
    article.innerHTML = doc && doc.html ? doc.html : '';
    return article;
  }

  function lineRangesIntersect(aStart, aEnd, bStart, bEnd) {
    if (!Number.isFinite(aStart) || !Number.isFinite(aEnd) || !Number.isFinite(bStart) || !Number.isFinite(bEnd)) return false;
    return aStart <= bEnd && bStart <= aEnd;
  }

  function lineRangeOverlap(aStart, aEnd, bStart, bEnd) {
    if (!lineRangesIntersect(aStart, aEnd, bStart, bEnd)) return 0;
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart) + 1);
  }

  function getAnchorsIntersectingLineRange(anchors, startLine, endLine) {
    if (!Array.isArray(anchors) || !Number.isFinite(startLine) || !Number.isFinite(endLine) || endLine < startLine) return [];
    return anchors.filter((anchor) => anchor && lineRangesIntersect(anchor.startLine, anchor.endLine, startLine, endLine));
  }

  function getBestOldAnchorForNewAnchor(newAnchor, oldAnchors, oldStartLine, oldEndLine) {
    if (!newAnchor || !Array.isArray(oldAnchors) || oldEndLine < oldStartLine) return null;
    const candidates = getAnchorsIntersectingLineRange(oldAnchors, oldStartLine, oldEndLine);
    if (candidates.length === 0) return findAnchorForLine(oldAnchors, oldStartLine);
    return candidates
      .slice()
      .sort((a, b) => {
        const typeDelta = (a.type === newAnchor.type ? 0 : 1) - (b.type === newAnchor.type ? 0 : 1);
        if (typeDelta) return typeDelta;
        const overlapDelta = lineRangeOverlap(b.startLine, b.endLine, oldStartLine, oldEndLine)
          - lineRangeOverlap(a.startLine, a.endLine, oldStartLine, oldEndLine);
        if (overlapDelta) return overlapDelta;
        return Math.abs(a.startLine - oldStartLine) - Math.abs(b.startLine - oldStartLine);
      })[0] || null;
  }

  function getAnchorTextFromArticle(article, anchorId) {
    const element = getArticleAnchorById(article, anchorId);
    return element ? getSearchableTextNodes(element).text : '';
  }

  function addExactChangeRecord(exactByAnchor, anchor, ranges, anchorText) {
    const anchorId = anchor && anchor.id;
    if (!anchorId) return;
    const merged = mergeTextRanges(ranges);
    if (!merged.length) return;
    const existing = exactByAnchor.get(anchorId) || {
      kind: 'exact',
      anchorId,
      sourceStartLine: anchor.startLine,
      sourceEndLine: anchor.endLine,
      anchorText,
      ranges: [],
    };
    existing.ranges = mergeTextRanges(existing.ranges.concat(merged));
    existing.snippets = existing.ranges
      .map((range) => String(anchorText || '').slice(range.start, range.end))
      .filter(Boolean);
    exactByAnchor.set(anchorId, existing);
  }

  function addAnchorChangeRecord(anchorRecords, anchor, anchorText = '', ranges = []) {
    if (!anchor || !anchor.id) return;
    const merged = mergeTextRanges(ranges);
    const existing = anchorRecords.get(anchor.id) || {
      kind: 'anchor',
      anchorId: anchor.id,
      sourceStartLine: anchor.startLine,
      sourceEndLine: anchor.endLine,
      anchorText,
      ranges: [],
    };
    existing.anchorText = anchorText || existing.anchorText;
    existing.ranges = mergeTextRanges(existing.ranges.concat(merged));
    existing.snippets = existing.ranges
      .map((range) => String(existing.anchorText || '').slice(range.start, range.end))
      .filter(Boolean);
    anchorRecords.set(anchor.id, existing);
  }

  // A pure deletion collapses to a seam in the new doc; mark the surviving
  // block on EACH side so the void is bracketed — one-sided marking can't say
  // whether the removed content sat above or below the bar. This mirrors the
  // word-level treatment (findDeletionAnchorRanges marks a surviving word on
  // each side of an intra-block cut). A block straddling the seam IS both
  // sides: a deletion inside one surviving block marks just that block.
  function findAnchorsFlankingDeletion(anchors, seamLine) {
    const results = [];
    const after = findAnchorForLine(anchors, seamLine);
    if (after) results.push(after);
    if (after && after.startLine < seamLine) return results;
    let before = null;
    for (const anchor of anchors) {
      if (!anchor || anchor.endLine >= seamLine) continue;
      if (
        !before
        || anchor.endLine > before.endLine
        || (anchor.endLine === before.endLine && anchor.startLine > before.startLine)
      ) {
        before = anchor;
      }
    }
    if (before && (!after || before.id !== after.id)) results.push(before);
    return results;
  }

  function computeMarkdownChangeRecords({ oldDoc, newDoc, oldSource, newSource }) {
    if (!oldDoc || !newDoc || oldSource === newSource) return [];
    const oldAnchors = Array.isArray(oldDoc.anchors) ? oldDoc.anchors : [];
    const newAnchors = Array.isArray(newDoc.anchors) ? newDoc.anchors : [];
    if (!newAnchors.length) return [];

    const oldArticle = createDetachedMarkdownArticle(oldDoc);
    const newArticle = createDetachedMarkdownArticle(newDoc);
    const exactByAnchor = new Map();
    const anchorRecords = new Map();
    const opcodes = getLineDiffOpcodes(oldSource, newSource);

    for (const op of opcodes) {
      if (!op || op.tag === 'equal') continue;
      const oldStartLine = op.i1 + 1;
      const oldEndLine = op.i2;
      const newStartLine = op.j1 + 1;
      const newEndLine = op.j2;

      if (op.tag === 'delete' || op.j1 === op.j2) {
        for (const anchor of findAnchorsFlankingDeletion(newAnchors, newStartLine)) {
          addAnchorChangeRecord(anchorRecords, anchor, getAnchorTextFromArticle(newArticle, anchor.id));
        }
        continue;
      }

      const changedAnchors = getAnchorsIntersectingLineRange(newAnchors, newStartLine, newEndLine);
      if (!changedAnchors.length) {
        const anchor = findAnchorForLine(newAnchors, newStartLine);
        addAnchorChangeRecord(anchorRecords, anchor, anchor ? getAnchorTextFromArticle(newArticle, anchor.id) : '');
        continue;
      }

      for (const newAnchor of changedAnchors) {
        const newElement = getArticleAnchorById(newArticle, newAnchor.id);
        if (!newElement) continue;
        const oldAnchor = getBestOldAnchorForNewAnchor(newAnchor, oldAnchors, oldStartLine, oldEndLine);
        const oldElement = oldAnchor ? getArticleAnchorById(oldArticle, oldAnchor.id) : null;
        const newText = getSearchableTextNodes(newElement).text;
        const oldText = oldElement ? getSearchableTextNodes(oldElement).text : '';
        const ranges = findInsertedTextRanges(oldText, newText);
        const deletionAnchorRanges = findDeletionAnchorRanges(oldText, newText);
        if (ranges.length > 0) {
          addExactChangeRecord(exactByAnchor, newAnchor, ranges, newText);
        }
        if (deletionAnchorRanges.length > 0) {
          addAnchorChangeRecord(anchorRecords, newAnchor, newText, deletionAnchorRanges);
        } else if (ranges.length === 0 && (oldText !== newText || op.tag !== 'insert')) {
          addAnchorChangeRecord(anchorRecords, newAnchor, newText);
        }
      }
    }

    const records = Array.from(exactByAnchor.values());
    for (const record of anchorRecords.values()) records.push(record);
    return records;
  }

  // Any number of agent writes between the user's turns accumulate at age 0;
  // aging happens on the logical clock (syncChangeAgeToStoreTurn), so a burst
  // of writes can't scroll its own first change off before the user looked.
  function recordMarkdownObservedChange(records) {
    if (records && records.length > 0) {
      const head = state.changeHighlightBatches[0];
      if (head && head.age === 0) head.records = head.records.concat(records);
      else state.changeHighlightBatches.unshift({ age: 0, records });
      startChangeFlash(records);
    } else {
      stopChangeFlash();
    }
  }

  // Bars age per user send: the store turn tick is the "I acted on this
  // state" signal (same clock as thread collapse). Level 0 = changed since
  // your last send, 1 = one send ago, 2 = two; then gone.
  function syncChangeAgeToStoreTurn(store) {
    if (!store || typeof store !== 'object') return;
    // A store born without a turn is at turn 0 (storeless docs baseline
    // there, so the first-ever send still ages).
    const turn = Number.isFinite(store.turn) ? store.turn : 0;
    if (state.changeClockTurn == null) {
      state.changeClockTurn = turn;
      return;
    }
    const delta = turn - state.changeClockTurn;
    if (delta <= 0) return;
    state.changeClockTurn = turn;
    state.changeHighlightBatches = state.changeHighlightBatches
      .map((batch) => ({ ...batch, age: batch.age + delta }))
      .filter((batch) => batch.age <= MARKDOWN_CHANGE_HIGHLIGHT_MAX_AGE && batch.records && batch.records.length > 0);
  }

  function normalizeChangeMatchText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  function recordMatchesAnchorText(record, text) {
    const normalizedText = normalizeChangeMatchText(text);
    if (!normalizedText) return false;
    const anchorText = normalizeChangeMatchText(record.anchorText);
    if (anchorText && anchorText === normalizedText) return true;
    const snippets = Array.isArray(record.snippets) ? record.snippets : [];
    return snippets.length > 0 && snippets.every((snippet) => normalizedText.includes(normalizeChangeMatchText(snippet)));
  }

  function findArticleAnchorForSourceLine(article, line) {
    if (!article || !Number.isFinite(line)) return null;
    const anchors = getArticleAnchors(article);
    let nearestBefore = null;
    let nearestAfter = null;
    for (const anchor of anchors) {
      const start = Number(anchor.getAttribute('data-source-start-line'));
      const end = Number(anchor.getAttribute('data-source-end-line'));
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start <= line && end >= line) return anchor;
      if (end < line && (!nearestBefore || end > Number(nearestBefore.getAttribute('data-source-end-line')))) {
        nearestBefore = anchor;
      }
      if (start > line && (!nearestAfter || start < Number(nearestAfter.getAttribute('data-source-start-line')))) {
        nearestAfter = anchor;
      }
    }
    return nearestAfter || nearestBefore;
  }

  function resolveChangeRecordAnchor(article, record) {
    if (!article || !record) return null;
    const direct = record.anchorId ? getArticleAnchorById(article, record.anchorId) : null;
    if (direct && recordMatchesAnchorText(record, getSearchableTextNodes(direct).text)) return direct;

    const anchorText = normalizeChangeMatchText(record.anchorText);
    if (anchorText) {
      for (const anchor of getArticleAnchors(article)) {
        if (normalizeChangeMatchText(getSearchableTextNodes(anchor).text) === anchorText) return anchor;
      }
    }

    const snippets = Array.isArray(record.snippets) ? record.snippets.map(normalizeChangeMatchText).filter(Boolean) : [];
    if (snippets.length > 0) {
      for (const anchor of getArticleAnchors(article)) {
        const text = normalizeChangeMatchText(getSearchableTextNodes(anchor).text);
        if (snippets.every((snippet) => text.includes(snippet))) return anchor;
      }
    }

    return findArticleAnchorForSourceLine(article, record.sourceStartLine) || direct;
  }

  function findNearestTextIndex(text, needle, hint) {
    if (!needle) return -1;
    let best = -1;
    let index = String(text || '').indexOf(needle);
    while (index !== -1) {
      if (best === -1 || Math.abs(index - hint) < Math.abs(best - hint)) best = index;
      index = String(text || '').indexOf(needle, index + 1);
    }
    return best;
  }

  function createTextRangesForRecord(anchor, record) {
    const text = getSearchableTextNodes(anchor).text;
    const ranges = [];
    for (const textRange of record.ranges || []) {
      const snippet = String(text.slice(textRange.start, textRange.end) || '');
      const expected = String(record.anchorText || '').slice(textRange.start, textRange.end);
      if (expected && snippet === expected) {
        const range = createTextRangeWithin(anchor, textRange.start, textRange.end);
        if (range) ranges.push(range);
        continue;
      }

      const index = findNearestTextIndex(text, expected, textRange.start);
      if (index >= 0) {
        const range = createTextRangeWithin(anchor, index, index + expected.length);
        if (range) ranges.push(range);
      }
    }
    return ranges;
  }

  function createFirstWordRangeForAnchor(anchor) {
    const text = getSearchableTextNodes(anchor).text;
    const match = /[A-Za-z0-9_]+/.exec(text);
    if (!match) return null;
    return createTextRangeWithin(anchor, match.index, match.index + match[0].length);
  }

  function createChangeHighlightRangesForArticle(article, record) {
    if (!article || !record) return [];
    const anchor = resolveChangeRecordAnchor(article, record);
    if (!anchor) return [];

    if (record.kind === 'anchor') {
      const ranges = createTextRangesForRecord(anchor, record);
      if (ranges.length > 0) return ranges;
      const range = createFirstWordRangeForAnchor(anchor);
      return range ? [range] : [];
    }

    return createTextRangesForRecord(anchor, record);
  }

  // Settled presentation of tracked changes: a thin gutter bar on each changed
  // block, in both spread pages — one shade, one bit ("changed recently, not
  // yet engaged"); batch age is retention only. The in-text ranges appear on
  // hover (handleChangeBarHover), so reading stays quiet. Also rebuilds the
  // anchorId → records index the hover handler reads.
  function updateChangeHighlights() {
    clearChangeHoverHighlight();
    state.changeHoverEl = null;
    state.changeBarRecords = new Map();
    for (const article of [state.article, state.secondaryArticle]) {
      if (!article) continue;
      for (const el of article.querySelectorAll('.md-change-bar')) {
        el.classList.remove('md-change-bar', 'md-change-age-1', 'md-change-age-2');
      }
    }
    const ages = new Map();
    for (const batch of state.changeHighlightBatches) {
      for (const record of batch.records || []) {
        for (const article of [state.article, state.secondaryArticle]) {
          const el = resolveChangeRecordAnchor(article, record);
          if (!el) continue;
          const prev = ages.get(el);
          if (prev == null || batch.age < prev) ages.set(el, batch.age);
          const id = el.getAttribute('data-md-anchor-id');
          if (!id) continue;
          if (!state.changeBarRecords.has(id)) state.changeBarRecords.set(id, []);
          const list = state.changeBarRecords.get(id);
          if (!list.includes(record)) list.push(record);
        }
      }
    }
    for (const [el, age] of ages) {
      el.classList.add('md-change-bar');
      if (age === 1) el.classList.add('md-change-age-1');
      else if (age >= 2) el.classList.add('md-change-age-2');
    }
  }

  function getCurrentSelectionContextResult() {
    if (!isOpen()) return { context: null, reason: 'closed' };
    const selection = window.getSelection && window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return { context: null, reason: 'empty' };
    }

    const rawSelectedText = String(selection.toString() || '');
    const selectedText = rawSelectedText.trim();
    if (!selectedText) return { context: null, reason: 'empty' };

    const range = selection.getRangeAt(0);
    if (!isNodeInsideMarkdown(range.startContainer) || !isNodeInsideMarkdown(range.endContainer)) {
      return { context: null, reason: 'outside' };
    }

    const startAnchor = getAnchorForNode(range.startContainer);
    const endAnchor = getAnchorForNode(range.endContainer);
    if (!startAnchor || !endAnchor) return { context: null, reason: 'outside' };
    if (isInSecondaryPane(startAnchor) !== isInSecondaryPane(endAnchor)) {
      return { context: null, reason: 'multiPane' };
    }

    const leadingTrimmedChars = rawSelectedText.length - rawSelectedText.replace(/^\s+/, '').length;
    const trailingTrimmedChars = rawSelectedText.length - rawSelectedText.replace(/\s+$/, '').length;
    const selectionStart = getTextOffsetWithin(startAnchor, range.startContainer, range.startOffset) + leadingTrimmedChars;
    const selectionEnd = getTextOffsetWithin(endAnchor, range.endContainer, range.endOffset) - trailingTrimmedChars;
    const multiBlock = startAnchor !== endAnchor;
    const targetKind = isBroadMarkdownSelection({ selectedText, multiBlock }) ? 'passage' : 'selection';
    return {
      context: {
        target: startAnchor,
        anchorId: getAnchorIdForTarget(startAnchor),
        endAnchorId: getAnchorIdForTarget(endAnchor),
        selectedText,
        selectionStart,
        selectionEnd,
        targetKind,
        sourceStartLine: getTargetSourceStartLine(startAnchor),
        pane: isInSecondaryPane(startAnchor) ? 'right' : 'left',
        rect: getRangeEndRect(range),
      },
      reason: null,
    };
  }

  function getCurrentSelectionContext() {
    return getCurrentSelectionContextResult().context;
  }

  function showMultiPaneSelectionError() {
    if (typeof showToast === 'function') {
      showToast('Select within one markdown pane to comment');
    }
  }

  function clearSelectionHighlights() {
    const highlights = window.CSS && window.CSS.highlights;
    if (!highlights || typeof highlights.delete !== 'function') return;
    highlights.delete('md-comment-selection');
  }

  function getSelectionHighlightRecords() {
    const records = [];
    if (state.vdrag && state.vdrag.active && state.vdrag.record) {
      records.push(state.vdrag.record);
    }
    if (state.activeCard && isMarkdownSelectionKind(state.activeCard.targetKind)) {
      records.push(state.activeCard);
    } else if (state.activeSelection && state.activeSelection.selectedText) {
      records.push(state.activeSelection);
    }
    for (const comment of state.queuedComments) {
      if (isMarkdownSelectionKind(comment.targetKind) && comment.selectedText) records.push(comment);
    }
    return records;
  }

  function isMarkdownSelectionKind(kind) {
    return kind === 'selection' || kind === 'passage';
  }

  function getSearchableTextLength(anchor) {
    return getSearchableTextNodes(anchor).text.length;
  }

  function createSelectionHighlightRangesForArticle(article, record) {
    const startAnchorId = record.anchorId || getAnchorIdForTarget(record.target);
    if (!article || !startAnchorId) return [];

    const endAnchorId = record.endAnchorId || startAnchorId;
    const anchors = getArticleAnchors(article);
    const startIndex = anchors.findIndex((anchor) => getAnchorIdForTarget(anchor) === startAnchorId);
    const endIndex = anchors.findIndex((anchor) => getAnchorIdForTarget(anchor) === endAnchorId);
    if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) return [];

    const startOffset = Number.isFinite(record.selectionStart) ? Math.max(0, record.selectionStart) : 0;
    const fallbackEndOffset = startOffset + String(record.selectedText || '').length;
    const endOffset = Number.isFinite(record.selectionEnd) ? Math.max(0, record.selectionEnd) : fallbackEndOffset;

    if (startIndex === endIndex) {
      const range = createTextRangeWithin(anchors[startIndex], startOffset, endOffset);
      return range ? [range] : [];
    }

    const ranges = [];
    for (let index = startIndex; index <= endIndex; index++) {
      const anchor = anchors[index];
      const start = index === startIndex ? startOffset : 0;
      const end = index === endIndex ? endOffset : getSearchableTextLength(anchor);
      const range = createTextRangeWithin(anchor, start, end);
      if (range) ranges.push(range);
    }
    return ranges;
  }

  function createSelectionHighlightRanges(record) {
    if (!record || !record.selectedText) return [];
    const ranges = [];
    for (const article of [state.article, state.secondaryArticle]) {
      ranges.push(...createSelectionHighlightRangesForArticle(article, record));
    }
    return ranges;
  }

  function canUseSelectionHighlights() {
    const highlights = window.CSS && window.CSS.highlights;
    return !!(
      highlights
      && typeof highlights.set === 'function'
      && typeof highlights.delete === 'function'
      && typeof window.Highlight === 'function'
    );
  }

  function showSelectionHighlightError() {
    if (typeof showToast === 'function') {
      showToast('Selection highlight is not supported in this runtime');
    }
  }

  function canHighlightSelectionRecord(record) {
    if (!canUseSelectionHighlights()) return false;
    return createSelectionHighlightRanges(record).length > 0;
  }

  function updateSelectionHighlights() {
    if (!canUseSelectionHighlights()) return false;
    const highlights = window.CSS.highlights;

    const ranges = [];
    for (const record of getSelectionHighlightRecords()) {
      ranges.push(...createSelectionHighlightRanges(record));
    }

    if (ranges.length === 0) {
      clearSelectionHighlights();
      return true;
    }
    try {
      highlights.set('md-comment-selection', new window.Highlight(...ranges));
      return true;
    } catch {
      showSelectionHighlightError();
      return false;
    }
  }

  function activateSelectionFromDom() {
    const result = getCurrentSelectionContextResult();
    if (!result.context) {
      if (result.reason === 'multiPane') showMultiPaneSelectionError();
      return false;
    }
    return activateSelectionFromRecord(result.context);
  }

  // Arms a selection record — from the native path above or built by the
  // virtual drag (document-space, possibly spanning pages).
  function activateSelectionFromRecord(selection) {
    if (!selection) return false;
    if (!canHighlightSelectionRecord(selection)) {
      showSelectionHighlightError();
      return false;
    }

    if (state.activeCard) {
      if (getActiveMarkdownCommentText()) {
        queueActiveMarkdownCommentDraft();
      } else {
        closeActiveCard({ restoreQueuedDraft: !!state.activeCard.queueMode });
        clearActiveTarget();
      }
    }

    // A selection supersedes any earlier click point: if the selection has
    // collapsed by the time an edit key lands, the entry must not inherit a
    // stale caret from a previous click.
    state.pendingClickCaret = null;
    setActiveTarget(selection.target, { selection });
    return true;
  }

  function handleSelectionMouseup(event) {
    if (event.target && event.target.closest && event.target.closest('.md-comment-card, .md-queued-comment-card')) {
      return;
    }
    setTimeout(() => {
      activateSelectionFromDom();
    }, 0);
  }

  // ---- Virtual drag selection. A native drag can only live inside one
  // article copy, so the viewer owns the drag: the two open pages read as one
  // sheet (the fold is just distance under the sweep), and pressing past a
  // page's top or bottom edge turns the page — crossing flips, hovering
  // doesn't, so the first and last lines never fight a flip zone and a held
  // press never turns more than once: the crossing is spent after its turn,
  // and turning again takes another push past the edge. The record is
  // document-space (anchor + offset pairs, ordered by document position, so
  // a backward sweep is a first-class selection); the highlight paints it
  // into both articles, so it survives every flip.
  const VDRAG_THRESHOLD = 5;
  const VDRAG_FLIP_GRACE_MS = 260;
  let vdragPaintRaf = 0;

  function resolveArticlePoint(x, y) {
    let range = null;
    try { range = document.caretRangeFromPoint(x, y); } catch { return null; }
    if (!range || !range.startContainer) return null;
    const node = range.startContainer;
    const el = node.nodeType === 3 ? node.parentElement : node;
    if (!el || !el.closest) return null;
    if (el.closest('.md-comment-card, .md-queued-comment-card, .md-pending-strip, .md-thread-card, .md-thread-waiting-line, button, textarea, input')) return null;
    const anchor = el.closest('[data-md-anchor-id]');
    if (!anchor || !state.spreadLayout || !state.spreadLayout.contains(anchor) || !anchor.contains(node)) return null;
    return {
      anchorId: anchor.getAttribute('data-md-anchor-id'),
      offset: getTextOffsetWithin(anchor, node, range.startOffset),
      pane: isInSecondaryPane(anchor) ? 'right' : 'left',
    };
  }

  function buildVirtualSelectionRecord(a, b) {
    if (!a || !b || !state.article) return null;
    const anchors = getArticleAnchors(state.article);
    const idxOf = (id) => anchors.findIndex((el) => getAnchorIdForTarget(el) === id);
    const ai = idxOf(a.anchorId);
    const bi = idxOf(b.anchorId);
    if (ai < 0 || bi < 0) return null;
    const backward = bi < ai || (bi === ai && b.offset < a.offset);
    const start = backward ? b : a;
    const end = backward ? a : b;
    const startIdx = backward ? bi : ai;
    const endIdx = backward ? ai : bi;
    const parts = [];
    for (let i = startIdx; i <= endIdx; i++) {
      const text = getSearchableTextNodes(anchors[i]).text;
      parts.push(text.slice(i === startIdx ? start.offset : 0, i === endIdx ? end.offset : text.length));
    }
    const selectedText = parts.join('\n').trim();
    if (!selectedText) return null;
    let selectionStart = start.offset;
    let selectionEnd = end.offset;
    if (startIdx === endIdx) {
      const raw = parts[0];
      selectionStart += raw.length - raw.replace(/^\s+/, '').length;
      selectionEnd -= raw.length - raw.replace(/\s+$/, '').length;
    }
    const multiBlock = startIdx !== endIdx;
    return {
      target: anchors[startIdx],
      anchorId: getAnchorIdForTarget(anchors[startIdx]),
      endAnchorId: getAnchorIdForTarget(anchors[endIdx]),
      selectedText,
      selectionStart,
      selectionEnd,
      targetKind: isBroadMarkdownSelection({ selectedText, multiBlock }) ? 'passage' : 'selection',
      sourceStartLine: getTargetSourceStartLine(anchors[startIdx]),
      // Where the drag currently is — the composer seats at the passage END,
      // on the page the reader finished on.
      pane: b.pane,
      rect: null,
    };
  }

  function spreadEdges() {
    const left = viewportRectOf(state.primaryPane);
    const right = viewportRectOf(state.secondaryPane);
    if (!left && !right) return null;
    return {
      top: Math.min(left ? left.top : Infinity, right ? right.top : Infinity),
      bottom: Math.max(left ? left.bottom : -Infinity, right ? right.bottom : -Infinity),
    };
  }

  function scheduleVdragPaint() {
    if (vdragPaintRaf) return;
    vdragPaintRaf = requestAnimationFrame(() => {
      vdragPaintRaf = 0;
      const drag = state.vdrag;
      if (!drag || !drag.active) return;
      drag.record = buildVirtualSelectionRecord(drag.start, drag.focus || drag.start);
      updateSelectionHighlights();
    });
  }

  // After a turn the endpoint rests at the first line the turn revealed, so
  // the selection reads continuously onto the visible spread and releasing
  // right away selects only to the top (or, backward, the bottom) of the new
  // page — never more.
  function snapVdragFocusToRevealedPage(drag, direction) {
    const pane = direction > 0 ? state.primaryPane : state.secondaryPane;
    const vp = viewportRectOf(pane);
    if (!vp) return;
    const inset = Math.min(getRenderedLineHeight(), 24) / 2;
    const y = direction > 0 ? vp.top + inset : vp.bottom - inset;
    for (const x of [vp.left + 40, (vp.left + vp.right) / 2, vp.right - 40]) {
      const point = resolveArticlePoint(x, y);
      if (point) { drag.focus = point; return; }
    }
  }

  function updateVdragFlip(drag, beyond) {
    if (!beyond) {
      drag.flipDir = 0;
      drag.flipSpent = 0;
      if (drag.flipTimer) { clearTimeout(drag.flipTimer); drag.flipTimer = null; }
      return;
    }
    if (drag.flipSpent === beyond) return; // one turn per crossing
    if (drag.flipDir === beyond && drag.flipTimer) return; // grace pending
    drag.flipDir = beyond;
    if (drag.flipTimer) clearTimeout(drag.flipTimer);
    drag.flipTimer = setTimeout(() => {
      drag.flipTimer = null;
      if (state.vdrag !== drag || drag.flipDir !== beyond) return;
      flipSpread(beyond);
      drag.flipSpent = beyond;
      // Snap a frame later: the flip's scroll fires the async page-alignment
      // pass (whole-line top nudge, bottom trim), and the parked endpoint
      // should read the settled first line, not the pre-nudge one.
      requestAnimationFrame(() => {
        if (state.vdrag !== drag) return;
        snapVdragFocusToRevealedPage(drag, beyond);
        scheduleVdragPaint();
      });
    }, VDRAG_FLIP_GRACE_MS);
  }

  function handleVdragMove(event) {
    const drag = state.vdrag;
    if (!drag) return;
    if (!drag.active) {
      const dx = event.clientX - drag.x0;
      const dy = event.clientY - drag.y0;
      if (dx * dx + dy * dy < VDRAG_THRESHOLD * VDRAG_THRESHOLD) return;
      drag.active = true;
      const s = window.getSelection && window.getSelection();
      if (s && s.removeAllRanges) try { s.removeAllRanges(); } catch {}
      if (state.spreadLayout) state.spreadLayout.classList.add('md-vdrag');
    }
    const edges = spreadEdges();
    const beyond = edges ? (event.clientY < edges.top ? -1 : (event.clientY > edges.bottom ? 1 : 0)) : 0;
    updateVdragFlip(drag, beyond);
    if (beyond === 0) {
      const point = resolveArticlePoint(event.clientX, event.clientY);
      if (point) {
        drag.focus = point;
        scheduleVdragPaint();
      }
    }
    event.preventDefault();
  }

  function releaseVdrag(drag) {
    state.vdrag = null;
    document.removeEventListener('mousemove', handleVdragMove, true);
    document.removeEventListener('mouseup', handleVdragUp, true);
    if (drag.flipTimer) clearTimeout(drag.flipTimer);
    if (state.spreadLayout) state.spreadLayout.classList.remove('md-vdrag');
  }

  function cancelVdrag() {
    const drag = state.vdrag;
    if (!drag) return false;
    const wasActive = drag.active;
    releaseVdrag(drag);
    if (wasActive) {
      state.vdragConsumedClick = true;
      setTimeout(() => { state.vdragConsumedClick = false; }, 0);
      updateSelectionHighlights();
    }
    return wasActive;
  }

  function handleVdragUp() {
    const drag = state.vdrag;
    if (!drag) return;
    releaseVdrag(drag);
    if (!drag.active) return; // a plain click: the click event handles it
    state.vdragConsumedClick = true;
    setTimeout(() => { state.vdragConsumedClick = false; }, 0);
    const record = buildVirtualSelectionRecord(drag.start, drag.focus || drag.start);
    updateSelectionHighlights(); // drop the live-drag paint
    if (record) activateSelectionFromRecord(record);
  }

  function handleVdragDown(event) {
    if (event.button !== 0 || state.vdrag || state.editing) return;
    if (event.target && event.target.closest
      && event.target.closest('.md-comment-card, .md-queued-comment-card, .md-pending-strip, .md-thread-card, .md-thread-waiting-line, button, textarea, input')) return;
    const point = resolveArticlePoint(event.clientX, event.clientY);
    if (!point) return;
    state.vdrag = {
      x0: event.clientX,
      y0: event.clientY,
      start: point,
      focus: point,
      active: false,
      flipTimer: null,
      flipDir: 0,
      flipSpent: 0,
      record: null,
    };
    document.addEventListener('mousemove', handleVdragMove, true);
    document.addEventListener('mouseup', handleVdragUp, true);
  }

  function getProjectedOffsetTop(element) {
    if (!element) return 0;
    if (state.secondaryArticle && state.secondaryArticle.contains(element)) {
      const primary = element.getAttribute && element.getAttribute('data-md-anchor-id')
        ? getAnchorElement({ id: element.getAttribute('data-md-anchor-id') })
        : null;
      if (primary) return primary.offsetTop;
      const secondaryTop = element.offsetTop || 0;
      return secondaryTop;
    }
    return element.offsetTop || 0;
  }

  // Off-grid fit: nudge the shared scrollTop the minimum needed so the span
  // [spanTop, spanBottom] (article offsets) sits inside the given page's
  // window — either edge, so a span cut by the page top pulls back into view
  // the same as one cut by the bottom. The grid follows the scroll.
  function fitSpanOnPane(spanTop, spanBottom, pane) {
    if (!state.primaryPane) return;
    // Full page height for the fit arithmetic (the flipSpread idiom): a bottom
    // trim left by the previous alignment pass would shrink both the window and
    // the page advance here, mis-aiming the fit by up to a line.
    state.primaryPane.style.height = '';
    if (state.secondaryPane) state.secondaryPane.style.height = '';
    const paneHeight = state.primaryPane.clientHeight || 0;
    const pageAdvance = getSpreadPageAdvance();
    if (!paneHeight || !pageAdvance) return;
    const margin = 14;
    // The whole-line top nudge in syncSecondaryPane shifts content down by up
    // to a line AFTER this fit, so the bottom needs that much extra clearance
    // or the fitted span still ends up cut at the page bottom.
    const bottomMargin = margin + getRenderedLineHeight();
    const base = pane === 'right' ? pageAdvance : 0;
    let nextScrollTop = state.primaryPane.scrollTop;
    const start = nextScrollTop + base;
    const end = start + paneHeight;
    if (spanTop < start + margin) {
      nextScrollTop = Math.max(0, spanTop - base - margin);
    } else if (spanBottom > end - bottomMargin) {
      nextScrollTop = Math.max(0, spanBottom - base - paneHeight + bottomMargin);
    }
    if (nextScrollTop !== state.primaryPane.scrollTop) {
      state.primaryPane.scrollTop = nextScrollTop;
      state.spreadGridTop = nextScrollTop; // keep the grid with the scrolled fit
    }
    syncSecondaryPane();
  }

  function fitActiveCommentCard() {
    if (!state.activeCard || !state.primaryPane) return;
    updateBottomSpacer();
    // The editor height is intentionally capped, so normal panes can fit the
    // active card. Tiny/pathological panes rely on textarea internal scroll.
    const { card, pane } = state.activeCard;
    const cardTop = getProjectedOffsetTop(card);
    fitSpanOnPane(cardTop, cardTop + card.offsetHeight, pane);
  }

  function paneOf(el) {
    return isInSecondaryPane(el) ? state.secondaryPane : state.primaryPane;
  }

  // state.primaryPane / state.secondaryPane ARE the .md-page-viewport
  // elements — the clipping boxes whose client rect is a page's window.
  function viewportRectOf(pane) {
    if (!pane || typeof pane.getBoundingClientRect !== 'function') return null;
    const rect = pane.getBoundingClientRect();
    return rect.height > 0 ? rect : null;
  }

  // Client rect of the character just before the offset — a collapsed range
  // reports an empty rect, a one-char range always measures. The char BEFORE:
  // a struck trail sits after the caret and is filtered out, so the char at
  // the offset itself is the trail's far end, stationary while a backward
  // erase walks the caret up; the preceding char hugs the caret in both
  // directions (it is the just-typed char when typing forward).
  function rectForTextOffset(el, offset) {
    const len = getSearchableTextLength(el);
    if (len <= 0) return null;
    const start = Math.max(0, Math.min(offset - 1, len - 1));
    const range = createTextRangeWithin(el, start, Math.min(start + 1, len));
    if (!range) return null;
    const rect = range.getBoundingClientRect();
    return rect && rect.height > 0 ? rect : null;
  }

  function caretOffsetVisible(el, offset) {
    const vp = viewportRectOf(paneOf(el));
    if (!vp) return false;
    const rect = rectForTextOffset(el, offset);
    if (!rect) return false;
    return rect.top >= vp.top - 1 && rect.bottom <= vp.bottom + 1;
  }

  // The caret is logical; the page turns to serve it — never a scroll (strict
  // paging holds; the flip is the app's one motion). When typing or erasing
  // walks the caret off the visible part of its copy: if the same spread's
  // other page renders that text (the fold), the session hands over across
  // it; otherwise the spread flips one turn toward the caret and lands on
  // whichever copy now renders it.
  function followEditingCaret() {
    const session = state.editing;
    if (!session || session.mode !== 'rendered' || !state.primaryPane) return;
    const s = window.getSelection && window.getSelection();
    if (!s || !s.rangeCount) return;
    const range = s.getRangeAt(0);
    if (!session.el.contains(range.startContainer)) return;
    const offset = getTextOffsetWithin(session.el, range.startContainer, range.startOffset);
    if (caretOffsetVisible(session.el, offset)) {
      updateEditingStripSeat();
      return;
    }
    const counterpart = getCounterpartAnchorElement(session.el);
    if (counterpart && caretOffsetVisible(counterpart, offset)) {
      handoverEditingSession(counterpart, offset);
      updateEditingStripSeat();
      return;
    }
    const vp = viewportRectOf(paneOf(session.el));
    const rect = rectForTextOffset(session.el, offset);
    if (!vp || !rect) return;
    flipSpread(rect.top < vp.top ? -1 : 1);
    if (counterpart && caretOffsetVisible(counterpart, offset)) {
      handoverEditingSession(counterpart, offset);
    } else if (caretOffsetVisible(session.el, offset)) {
      setCaretWithin(session.el, offset);
    }
    updateEditingStripSeat();
  }

  // The block's two copies are one logical surface: the session rides
  // whichever copy renders the page the caret is on. The mirror keeps them
  // identical, so a handover is a role swap — wire the other copy, unwire
  // this one, park the caret at the same text offset.
  function handoverEditingSession(toEl, caretOffset) {
    const session = state.editing;
    if (!session || !toEl || toEl === session.el) return;
    const fromEl = session.el;
    if (session.unwire) session.unwire();
    session.el = toEl; // before focus: the blur guards read it
    session.unwire = wireEditingSurface(toEl);
    wireEditingMirror(session, toEl, fromEl);
    try { toEl.focus({ preventScroll: true }); } catch {}
    setCaretWithin(toEl, caretOffset);
  }

  // The bubble never leaves the reader: it keeps its flow seat under the
  // block while that seat is on a page, and pins to an edge of the edited
  // page when the block's tail is a page away from the caret — the edge
  // OPPOSITE the caret, so it never covers the text being struck. Never
  // moved while its note has focus (moving a focused field would blur-commit).
  function updateEditingStripSeat() {
    const session = state.editing;
    if (!session || !session.strip || !session.strip.isConnected) return;
    const strip = session.strip;
    if (strip.contains(document.activeElement)) return;
    const pane = paneOf(session.el);
    const vp = viewportRectOf(pane);
    if (!vp) return;
    const pinAwayFromCaret = () => {
      const sel = window.getSelection && window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      if (!session.el.contains(r.startContainer)) return;
      const off = getTextOffsetWithin(session.el, r.startContainer, r.startOffset);
      const caretRect = rectForTextOffset(session.el, off);
      if (!caretRect) return;
      const caretLow = (caretRect.top + caretRect.bottom) / 2 > (vp.top + vp.bottom) / 2;
      strip.classList.toggle('pinned-top', caretLow);
    };
    const blockRect = session.el.getBoundingClientRect();
    const stripH = strip.offsetHeight || 0;
    const seatFits = blockRect.bottom >= vp.top && blockRect.bottom + stripH <= vp.bottom + 1;
    if (strip.classList.contains('pinned')) {
      if (seatFits) {
        strip.classList.remove('pinned', 'pinned-top');
        session.el.insertAdjacentElement('afterend', strip);
      } else {
        if (strip.parentElement !== pane) pane.appendChild(strip); // follow the caret's pane
        pinAwayFromCaret();
      }
      return;
    }
    const ownVp = viewportRectOf(paneOf(strip));
    const rect = strip.getBoundingClientRect();
    const seated = ownVp && rect.height > 0 && rect.top >= ownVp.top - 1 && rect.bottom <= ownVp.bottom + 1;
    if (seated) return;
    if (seatFits) {
      session.el.insertAdjacentElement('afterend', strip);
    } else {
      strip.classList.add('pinned');
      pane.appendChild(strip);
      pinAwayFromCaret();
    }
  }

  // What a spread rebuild would wipe if it ran now: an armed block's caret, an
  // open composer, an editing session, queued marks — all of them live in the
  // DOM layoutSpread replaces. Named rather than inlined because callers have
  // to ask it too: whoever mutates state and then asks for a render must know
  // the render can be refused, or the two drift apart. Thread rows did exactly
  // that — the set grew, nothing redrew, and the expansion surfaced later on an
  // unrelated render.
  function spreadLayoutFrozen() {
    return !!state.activeTarget
      || !!state.activeCard
      || !!state.editing
      || state.queuedComments.length > 0;
  }

  function layoutSpread() {
    if (!state.article || !state.secondaryArticle || !state.doc || spreadLayoutFrozen()) return;
    // Shift-aware: the rebuild swaps thread cards/marks in and out of the flow,
    // so hold the page top to content across it. Search refresh runs after —
    // when it jumps to a hit, that jump owns the frame and must land last.
    preserveSpreadTopAcross(() => {
      const landingIds = Array.from(state.spreadLayout.querySelectorAll('.md-landing-target'))
        .map((target) => target.getAttribute('data-md-anchor-id'))
        .filter(Boolean);
      const html = state.doc.html || '<div class="md-viewer-loading">Empty markdown file</div>';
      state.article.innerHTML = html;
      state.secondaryArticle.innerHTML = html;
      // Reserve known image heights before anything measures the column, so a
      // re-layout doesn't collapse images to zero and shove content out of view.
      reserveCachedImageHeights(state.article);
      reserveCachedImageHeights(state.secondaryArticle);
      updateBottomSpacer();
      for (const id of landingIds) {
        for (const target of getAnchorElementsById(id)) target.classList.add('md-landing-target');
      }
      reapplyLandingPulse();
      renderThreadLayer(false);
      renderPendingDiffBlocks();
    });
    const didRefreshSearch = refreshSearchAfterRender();
    updateChangeHighlights();
    applyChangePulse();
    updateSelectionHighlights();
    if (!didRefreshSearch) syncSecondaryPane();
    watchArticleImages();
  }

  function clearLandingTarget() {
    if (!state.spreadLayout) return;
    for (const el of state.spreadLayout.querySelectorAll('.md-landing-target')) {
      el.classList.remove('md-landing-target');
    }
    clearLandingPulse();
  }

  function landingPulseVariant(kind) {
    if (kind === 'exact') return 'md-landing-pulse--exact';
    if (kind === 'anchor') return 'md-landing-pulse--anchor';
    return 'md-landing-pulse--neutral';
  }

  // Transient arrival flash on the landed block. Tracked apart from applyChangePulse
  // so a live refresh and a jump can't clear each other. Recorded by anchor id,
  // not element, because open() polls the thread store right after landAt and
  // that layoutSpread rebuilds the article's innerHTML — on an element record
  // the flash died at birth on any doc with a store. The rebuild re-applies the
  // classes to the fresh elements, restarting the animation; those rebuilds land
  // within the flash's first beat, so a restart reads as the flash itself.
  // animationend retires the record, so a later rebuild can't resurrect a
  // finished flash; the md-landing-target marker stays behind as the residue.
  function applyLandingPulse(landedEls, kind) {
    clearLandingPulse();
    if (!landedEls || !landedEls.length) return;
    const variant = landingPulseVariant(kind);
    const ids = Array.from(new Set(
      landedEls.map((el) => el.getAttribute('data-md-anchor-id')).filter(Boolean),
    ));
    state.landingPulse = ids.length ? { ids, variant } : null;
    // Force a reflow so re-adding the class restarts the animation on a repeat jump.
    if (state.article) void state.article.offsetWidth;
    for (const el of landedEls) startLandingPulseOn(el, variant);
  }

  function startLandingPulseOn(el, variant) {
    el.classList.add('md-landing-pulse', variant);
    el.addEventListener('animationend', retireLandingPulse, { once: true });
  }

  function reapplyLandingPulse() {
    if (!state.landingPulse) return;
    const { ids, variant } = state.landingPulse;
    for (const id of ids) {
      for (const el of getAnchorElementsById(id)) startLandingPulseOn(el, variant);
    }
  }

  function retireLandingPulse(event) {
    // animationend bubbles; only the pulse's own keyframes end the record.
    if (event && event.animationName && event.animationName !== 'md-change-pulse-kf') return;
    state.landingPulse = null;
  }

  function clearLandingPulse() {
    if (state.spreadLayout) {
      for (const el of state.spreadLayout.querySelectorAll('.md-landing-pulse')) {
        el.classList.remove('md-landing-pulse', 'md-landing-pulse--exact', 'md-landing-pulse--anchor', 'md-landing-pulse--neutral');
      }
    }
    state.landingPulse = null;
  }

  function clearActiveTarget() {
    clearEditCaret();
    if (state.activeTarget) {
      state.activeTarget.classList.remove('md-comment-target-active');
    }
    state.activeTarget = null;
    state.activeTargetPane = null;
    state.activeSelection = null;
    hideHint();
    updateSelectionHighlights();
  }

  function hideHint() {
    if (!state.hint) return;
    state.hint.classList.remove('on');
    state.hint.textContent = '';
    state.hint = null;
  }

  function closeActiveCard({ restoreQueuedDraft = false } = {}) {
    if (!state.activeCard) return;
    const { card, target, placeholder } = state.activeCard;
    const active = state.activeCard;
    state.activeCard = null;
    if (restoreQueuedDraft) restoreQueuedMarkdownCommentDraft(active);
    if (target) target.classList.remove('md-comment-target-active');
    // The bubble may sit above the page top (flipped away while composing);
    // removing it then shifts everything below — hold the page to content.
    preserveSpreadTopAcross(() => {
      try { card.remove(); } catch {}
      try { if (placeholder) placeholder.remove(); } catch {}
    });
    updateSelectionHighlights();
    syncSecondaryPane();
  }

  // The viewer's own teardown — runs from band.onClose (✕, or md.close()).
  function teardownMarkdown() {
    state.openToken += 1;
    stopMarkdownAutoRefresh();
    if (state.search.isOpen && typeof closeSearchBar === 'function') {
      closeSearchBar();
    } else {
      closeSearch();
    }
    closeActiveCard();
    clearQueuedMarkdownComments();
    clearActiveTarget();
    clearLandingTarget();
    clearSelectionHighlights();
    clearMarkdownChangeHighlightState();
    closeThreadReply({ render: false });
    state.threadStore = null;
    state.threadStoreSig = '';
    state.threadRenderPending = false;
    state.resumeFullPending = false;
    state.resolvedExpanded = new Set();
    state.editing = null;
    state.blockOverlays = new Map();
    state.expandedHunkKey = null;
    state.pendingClickCaret = null;
  }

  function close() {
    band.close(); // fires band.onClose → teardownMarkdown + the host onClose
  }

  function showLoading(filePath) {
    ensureMounted();
    band.open();
    band.setTitle(filePath || 'Markdown');
    state.article.innerHTML = '<div class="md-viewer-loading">Loading markdown...</div>';
    if (state.secondaryArticle) state.secondaryArticle.innerHTML = '';
  }

  function showError(message) {
    ensureMounted();
    state.article.innerHTML = '';
    if (state.secondaryArticle) state.secondaryArticle.innerHTML = '';
    const error = document.createElement('div');
    error.className = 'md-viewer-error';
    error.textContent = message || 'Could not load markdown';
    state.article.appendChild(error);
  }

  function getAnchorElement(anchor) {
    if (!anchor || !state.article) return null;
    return state.article.querySelector(`[data-md-anchor-id="${escapeSelectorValue(anchor.id)}"]`);
  }

  function isInSecondaryPane(element) {
    return !!(element && state.secondaryPane && state.secondaryPane.contains(element));
  }

  function getCounterpartAnchorElement(target) {
    if (!target || !target.getAttribute) return null;
    const id = target.getAttribute('data-md-anchor-id');
    if (!id) return null;
    const candidates = getAnchorElementsById(id);
    return candidates.find((candidate) => candidate !== target && (
      isInSecondaryPane(candidate) !== isInSecondaryPane(target)
    )) || null;
  }

  function getAnchorIdForTarget(target) {
    return target && target.getAttribute ? target.getAttribute('data-md-anchor-id') : '';
  }

  function insertCommentFlowElementAfterTarget(target, element) {
    if (!target || !element) return;
    const anchorId = getAnchorIdForTarget(target);
    if (anchorId) element.setAttribute('data-md-comment-anchor-id', anchorId);

    let reference = target;
    while (
      reference.nextElementSibling
      && anchorId
      && reference.nextElementSibling.getAttribute('data-md-comment-anchor-id') === anchorId
    ) {
      reference = reference.nextElementSibling;
    }
    reference.insertAdjacentElement('afterend', element);
  }

  function createFlowPlaceholderForTarget(target, className) {
    const counterpart = getCounterpartAnchorElement(target);
    if (!counterpart) return null;
    const placeholder = document.createElement('div');
    placeholder.className = className;
    insertCommentFlowElementAfterTarget(counterpart, placeholder);
    return placeholder;
  }

  function createCommentPlaceholderForTarget(target) {
    return createFlowPlaceholderForTarget(target, 'md-comment-card-spacer');
  }

  function syncActiveCommentPlaceholder() {
    if (!state.activeCard || !state.activeCard.placeholder) return;
    state.activeCard.placeholder.style.height = `${state.activeCard.card.offsetHeight}px`;
  }

  function getTargetSourceStartLine(target) {
    const line = Number(target && target.getAttribute && target.getAttribute('data-source-start-line'));
    return Number.isFinite(line) ? line : Number.MAX_SAFE_INTEGER;
  }

  function getActiveMarkdownCommentText() {
    return state.activeCard && state.activeCard.textarea
      ? state.activeCard.textarea.value.trim()
      : '';
  }

  function buildMarkdownCommentRecord(target, comment, existing = null) {
    const selection = existing && (isMarkdownSelectionKind(existing.targetKind) || isMarkdownSelectionKind(existing.kind))
      ? existing
      : state.activeSelection;
    const selectionKind = selection && isMarkdownSelectionKind(selection.targetKind)
      ? selection.targetKind
      : (selection && isMarkdownSelectionKind(selection.kind) ? selection.kind : null);
    const isSelection = !!(selection && (selection.selectedText || selectionKind));
    const targetKind = isSelection ? (selectionKind || 'selection') : 'block';
    return {
      id: existing && Number.isFinite(existing.id) ? existing.id : ++state.nextCommentId,
      // Authoring order — the id sequence already is it, no clock needed.
      createdAt: existing && Number.isFinite(existing.createdAt) ? existing.createdAt : state.nextCommentId,
      anchorId: selection && selection.anchorId ? selection.anchorId : getAnchorIdForTarget(target),
      endAnchorId: selection && selection.endAnchorId ? selection.endAnchorId : (selection && selection.anchorId ? selection.anchorId : getAnchorIdForTarget(target)),
      target,
      pane: selection && selection.pane ? selection.pane : (isInSecondaryPane(target) ? 'right' : 'left'),
      filePath: state.resolvedPath || state.filePath,
      sourceStartLine: getTargetSourceStartLine(target),
      selectionStart: selection && Number.isFinite(selection.selectionStart) ? selection.selectionStart : 0,
      selectionEnd: selection && Number.isFinite(selection.selectionEnd)
        ? selection.selectionEnd
        : (
          selection && selection.selectedText
            ? (Number.isFinite(selection.selectionStart) ? selection.selectionStart : 0) + String(selection.selectedText).length
            : 0
        ),
      sectionHierarchy: getSectionHierarchyForTarget(target),
      targetText: getRenderedText(target),
      imageAnchor: imageAnchorForTarget(target),
      targetKind,
      selectedText: isSelection ? String(selection.selectedText || '') : '',
      comment,
      card: null,
      placeholder: null,
    };
  }

  // An image-only block carries no anchorable text (its <img> renders no text
  // nodes), so a comment on it can't anchor by snippet. Return the image's
  // authored src (data-md-src) as the key, with alt as the label; null for any
  // block that has its own text — those anchor by text as usual.
  function imageAnchorForTarget(target) {
    if (!target || getRenderedText(target).trim()) return null;
    const img = target.matches && target.matches('img')
      ? target
      : (target.querySelector && target.querySelector('img[data-md-src]'));
    const src = img && img.getAttribute ? (img.getAttribute('data-md-src') || '') : '';
    return src ? { src, alt: img.getAttribute('alt') || '' } : null;
  }

  // Thread payload for the sidecar store (~/agent-threads/contract.md prose
  // anchor). Context disambiguates only a short sub-block selection; a whole
  // block or a long snippet stands alone. heading = the nearest heading, in
  // the author's own words, for locating a lost anchor. An image-only block has
  // no such text, so it anchors by the image itself (contract.md image anchor).
  function getMarkdownThreadPayload(comment) {
    const selected = String(comment.selectedText || '');
    // Trimmed: an image run keeps whitespace between its images (an HTML-authored
    // triptych's &nbsp; spacers), which must not read as anchorable block text.
    const blockText = String(comment.targetText || '').trim();
    const hierarchy = Array.isArray(comment.sectionHierarchy) ? comment.sectionHierarchy : [];
    const heading = hierarchy.length ? String(hierarchy[hierarchy.length - 1]) : '';
    const image = !selected && !blockText ? comment.imageAnchor : null;
    if (image) {
      return {
        body: comment.comment,
        anchor: { snippet: image.alt || '', src: image.src, context: '', wholeBlock: true, heading },
      };
    }
    return {
      body: comment.comment,
      anchor: {
        snippet: selected || blockText,
        context: selected && selected !== blockText && selected.length < 64 ? blockText : '',
        wholeBlock: !selected,
        heading,
      },
    };
  }

  function getPendingMarkdownCommentRecords() {
    const activeComment = getActiveMarkdownCommentText();
    if (!state.activeCard || !activeComment) return [...state.queuedComments];

    const activeRecord = buildMarkdownCommentRecord(
      state.activeCard.target,
      activeComment,
      state.activeCard.originalQueuedComment || state.activeCard,
    );
    const comments = [...state.queuedComments];
    if (state.activeCard.queueMode) {
      const index = Number.isInteger(state.activeCard.queueIndex)
        ? Math.max(0, Math.min(state.activeCard.queueIndex, comments.length))
        : comments.length;
      comments.splice(index, 0, activeRecord);
      return comments;
    }
    comments.push(activeRecord);
    return comments;
  }

  function getPendingMarkdownCommentCount() {
    return state.queuedComments.length + (getActiveMarkdownCommentText() ? 1 : 0);
  }

  function removeQueuedMarkdownCommentCard(comment) {
    preserveSpreadTopAcross(() => {
      try { if (comment && comment.card) comment.card.remove(); } catch {}
      try { if (comment && comment.cardCounterpart) comment.cardCounterpart.remove(); } catch {}
      try { if (comment && comment.placeholder) comment.placeholder.remove(); } catch {}
    });
    if (comment) {
      comment.card = null;
      comment.cardCounterpart = null;
      comment.placeholder = null;
    }
  }

  // A queued comment rests as a small mark — same grammar as pending edits:
  // the composing card was the active state; once clicked away, your words
  // wait as a plain resting line (hover reads them back). Clicking reopens the composer,
  // where editing, sending, and discarding live.
  function buildQueuedMarkElement(comment) {
    const card = document.createElement('div');
    card.className = 'md-queued-comment-mark';
    const text = document.createElement('span');
    text.className = 'md-anno-text';
    // A comment shows its first line at rest (an edit shows its in-place diff
    // instead, so it needs no line). Same grammar as the collapsed thread row.
    text.textContent = String(comment.comment || '').split('\n')[0].replace(/\s+/g, ' ').trim();
    card.append(text);
    card.title = `${comment.comment} — click to edit`;
    card.addEventListener('mousedown', (event) => event.stopPropagation());
    card.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openQueuedMarkdownCommentForEdit(comment);
    });
    card.addEventListener('dblclick', (event) => event.stopPropagation());
    return card;
  }

  function createQueuedMarkdownCommentCard(comment) {
    // The block is rendered in BOTH page articles; which page shows it depends on
    // the (possibly off-grid) scroll fitActiveCommentCard left behind. Render the
    // mark in both articles so it follows the block across flips — otherwise a grid
    // realign that moves the block to the opposite pane orphans a single-pane mark,
    // and it vanishes while the comment stays queued. The two identical marks are
    // each other's height spacer, so the panes stay aligned with no separate spacer.
    comment.placeholder = null;
    preserveSpreadTopAcross(() => {
      comment.card = buildQueuedMarkElement(comment);
      insertCommentFlowElementAfterTarget(comment.target, comment.card);
      const counterpart = getCounterpartAnchorElement(comment.target);
      comment.cardCounterpart = counterpart ? buildQueuedMarkElement(comment) : null;
      if (comment.cardCounterpart) insertCommentFlowElementAfterTarget(counterpart, comment.cardCounterpart);
    });
    updateSelectionHighlights();
    syncSecondaryPane();
  }

  function insertQueuedMarkdownComment(comment, index) {
    const targetIndex = Number.isInteger(index)
      ? Math.max(0, Math.min(index, state.queuedComments.length))
      : state.queuedComments.length;
    state.queuedComments.splice(targetIndex, 0, comment);
    createQueuedMarkdownCommentCard(comment);
  }

  function removeQueuedMarkdownComment(comment) {
    const at = state.queuedComments.indexOf(comment);
    if (at !== -1) state.queuedComments.splice(at, 1);
    removeQueuedMarkdownCommentCard(comment);
    updateSelectionHighlights();
  }

  function clearQueuedMarkdownComments() {
    for (const comment of state.queuedComments) removeQueuedMarkdownCommentCard(comment);
    state.queuedComments.length = 0;
    updateSelectionHighlights();
    syncSecondaryPane();
  }

  function queueActiveMarkdownCommentDraft() {
    const comment = getActiveMarkdownCommentText();
    if (!state.activeCard || !comment) return false;
    const source = state.activeCard;
    const queued = buildMarkdownCommentRecord(
      source.target,
      comment,
      source.originalQueuedComment || source,
    );
    const queueIndex = Number.isInteger(source.queueIndex) ? source.queueIndex : undefined;
    closeActiveCard();
    insertQueuedMarkdownComment(queued, queueIndex);
    clearActiveTarget();
    return true;
  }

  function restoreQueuedMarkdownCommentDraft(comment) {
    if (!comment || !comment.originalQueuedComment) return false;
    insertQueuedMarkdownComment(comment.originalQueuedComment, comment.queueIndex);
    return true;
  }

  // --- Editing core (md-editing-design.md): a user edit is a comment. Marks
  // strike in place over the FROZEN rendered block; the file on disk is truth
  // and is never rewritten. The marked overlay (state.blockOverlays, keyed by
  // the block's stable anchorId) is the single source of truth for both the
  // on-screen decoration and the [Edit] envelope. The agent interprets at
  // handoff. ---

  function getBlockSourceRange(target) {
    const start = Number(target && target.getAttribute('data-source-start-line'));
    const end = Number(target && target.getAttribute('data-source-end-line'));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return null;
    return { start, end }; // 1-based, inclusive
  }

  function blockSourceForRange(range) {
    if (!range) return '';
    return state.sourceText.split('\n').slice(range.start - 1, range.end).join('\n');
  }

  // Render a single block's source to a detached element (its typeset form,
  // inline markup and all). Used to build a derived overlay when an edit
  // arrives with no live marks (a whole-text replacement).
  function renderBlockElement(blockSource) {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdownDocument(
      blockSource,
      markdownImageOptions({ path: state.resolvedPath || state.filePath }),
    ).html;
    if (host.children.length !== 1) return null;
    const el = host.firstElementChild;
    for (const n of [el, ...el.querySelectorAll('[data-md-anchor-id]')]) {
      n.removeAttribute('data-md-anchor-id');
      n.removeAttribute('data-source-start-line');
      n.removeAttribute('data-source-end-line');
    }
    return el;
  }

  // The document body as plain text, for pasting a drafted message into a chat
  // or email. Rendered from the FROZEN SOURCE, so comments and un-sent edits —
  // which live in the sidecar store, never the source — are excluded for free.
  // Headings and rules are dropped; each paragraph collapses to a single line
  // (soft wraps gone); list items stay one per line; code blocks keep their line
  // breaks; blocks are separated by a blank line.
  function buildDocBodyText() {
    const src = state.sourceText || '';
    if (!src.trim()) return '';
    const host = document.createElement('div');
    host.innerHTML = renderMarkdownDocument(
      src, markdownImageOptions({ path: state.resolvedPath || state.filePath }),
    ).html;
    const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const parts = [];
    for (const el of Array.from(host.children)) {
      const tag = (el.tagName || '').toUpperCase();
      if (/^H[1-6]$/.test(tag) || tag === 'HR') continue;
      let text;
      if (tag === 'PRE') {
        text = String(el.textContent || '').replace(/\s+$/, ''); // code: keep line breaks
      } else if (tag === 'UL' || tag === 'OL') {
        text = Array.from(el.querySelectorAll('li')).map((li) => oneLine(li.textContent)).filter(Boolean).join('\n');
      } else {
        text = oneLine(el.textContent);
      }
      if (text) parts.push(text);
    }
    return parts.join('\n\n');
  }

  function copyDocBody(btn) {
    const flash = (label) => {
      if (!btn) return;
      btn.textContent = label;
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(() => { btn.textContent = btn._restLabel || label; }, 1400);
    };
    const text = buildDocBodyText();
    if (!text) { flash('∅'); return; }
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => flash('✓'), () => flash('✕')); // ✓ mirrors the web viewer's copy-url
  }

  // When an edit ends with no live strike-in-place marks (its content was
  // replaced wholesale rather than struck), derive the overlay by diffing the
  // block's original rendered text against the edited text and striking that
  // difference in place on a fresh render of the frozen block. Returns the
  // marked innerHTML, or null for a no-op / unmappable edit.
  function buildDerivedOverlayHtml(session) {
    const origRendered = session.origRendered || '';
    const edited = getSearchableTextNodes(session.el).text.replace(/\u00a0/g, ' ');
    // Collapse whitespace on both sides: the block renders soft wraps as spaces,
    // so a caret-placed newline must not read as a change.
    const oldNorm = origRendered.replace(/\s+/g, ' ');
    const newNorm = edited.replace(/\s+/g, ' ');
    if (!oldNorm || oldNorm === newNorm) return null;
    const parts = diffMergedParts(oldNorm, newNorm);
    if (!parts.del && !parts.ins) return null;
    const el = renderBlockElement(blockSourceForRange({ start: session.start, end: session.end }));
    if (!el) return null;
    const segments = [
      { kind: 'text', text: parts.prefix },
      { kind: 'del', text: parts.del },
      { kind: 'ins', text: parts.ins },
      { kind: 'text', text: parts.suffix },
    ];
    if (!decorateMergedIntoBlock(el, segments, 'pending')) return null;
    return serializeMarkedBlock(el);
  }

  function setCaretWithin(el, offset) {
    const sel = window.getSelection && window.getSelection();
    const at = getTextPositionWithin(el, Math.max(0, offset));
    if (!sel || !at) return;
    try {
      const range = document.createRange();
      range.setStart(at.node, at.offset);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  }

  function getEditableCaretOffset(el) {
    const sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return null;
    return getTextOffsetWithin(el, range.startContainer, range.startOffset);
  }

  function editableDeleteText(el, start, end) {
    const range = createTextRangeWithin(el, start, end);
    if (!range) return;
    range.deleteContents();
    el.normalize();
    setCaretWithin(el, start);
  }

  function editableInsertText(el, offset, text) {
    const at = getTextPositionWithin(el, offset);
    if (!at || at.node.nodeType !== 3) return;
    at.node.insertData(at.offset, text);
    el.normalize();
    setCaretWithin(el, offset + text.length);
  }

  // Direct editing on the rendered block (md-editing-design.md, edit on
  // rendered): the typeset text itself is the editing surface. The entry
  // key acts at the click caret; from there the browser owns typing (IME
  // included). Only plain text may enter — paste is text-only, rich and
  // Strike-in-place editing: a delete strikes the text (never removes it), a
  // keystroke inserts it marked. The marks ARE the edit — no diff, no
  // reconstruction. Scoped to the block; structure never changes.
  // The mark mutators live in edit-marks.js (shared with the review viewer's
  // commit-message editor); this host binds them to its per-action undo.
  const {
    strikeInBlock, escapeDelAtCaret, insertMarkedInBlock, insertLineBreakInBlock,
  } = createMarkEngine({ beforeMutate: () => pushEditingUndo() });
  // ——— Action-by-action edit history ———
  // Native undo is blocked on the editing surface (it can't see the marks), so
  // the session keeps its own: the first mutator call in a user action
  // snapshots the block before the change. A strike+insert pair (typing over a
  // selection, paste) lands in the same event, so a microtask latch coalesces
  // it into one step. Escape/Revert still drop the whole session at once.
  function pushEditingUndo() {
    const session = state.editing;
    if (!session || !session.el || session.undoLatch) return;
    session.undoLatch = true;
    queueMicrotask(() => { session.undoLatch = false; });
    const caret = getEditableCaretOffset(session.el);
    (session.undoStack = session.undoStack || []).push({
      html: session.el.innerHTML,
      caret: caret == null ? 0 : caret,
    });
    session.redoStack = [];
  }

  // One step back (or forward again): swap the live block for the snapshot.
  // The mirror observer re-serializes the counterpart, and the caret re-seat
  // runs the follower — a step whose caret sits on another page flips to it,
  // the same physics as typing there.
  function undoEditingStep(redo) {
    const session = state.editing;
    if (!session || !session.el) return;
    const from = redo ? session.redoStack : session.undoStack;
    if (!from || !from.length) return;
    const caret = getEditableCaretOffset(session.el);
    const to = redo
      ? (session.undoStack = session.undoStack || [])
      : (session.redoStack = session.redoStack || []);
    to.push({ html: session.el.innerHTML, caret: caret == null ? 0 : caret });
    const snap = from.pop();
    session.el.innerHTML = snap.html;
    try { session.el.focus({ preventScroll: true }); } catch {}
    setCaretWithin(session.el, snap.caret);
  }

  // strikeInBlock / escapeDelAtCaret / insertMarkedInBlock moved to
  // edit-marks.js (bound above with this host's undo hook).
  // serializeMarkedBlock moved to edit-marks.js.

  // The editing surface's own listeners, wired so the session can hand the
  // surface from one article's copy to the other (both wire identically; the
  // returned teardown unwires this copy). Typing is intercepted wholesale:
  // structural inputs are blocked. A first-key Enter breaks the line at the
  // click caret; while editing, Enter sends and Shift+Enter breaks; clicking
  // away commits; Esc reverts.
  function wireEditingSurface(el) {
    const onPaste = (event) => {
      event.preventDefault();
      const text = event.clipboardData ? String(event.clipboardData.getData('text/plain') || '') : '';
      const s = window.getSelection && window.getSelection();
      if (s && s.rangeCount && !s.getRangeAt(0).collapsed) strikeInBlock(el, s.getRangeAt(0), 'after');
      insertMarkedInBlock(text.replace(/\s+/g, ' '));
    };
    const onBeforeInput = (event) => {
      const t = event.inputType || '';
      if (t.indexOf('delete') === 0) {
        event.preventDefault();
        const s = window.getSelection();
        const wasSelection = !!(s && s.rangeCount && !s.getRangeAt(0).collapsed);
        const ranges = event.getTargetRanges ? event.getTargetRanges() : [];
        const sr = ranges && ranges[0];
        if (sr) {
          const r = document.createRange();
          r.setStart(sr.startContainer, sr.startOffset);
          r.setEnd(sr.endContainer, sr.endOffset);
          strikeInBlock(el, r, wasSelection ? 'after' : (t.indexOf('Forward') !== -1 ? 'after' : 'before'));
        }
        return;
      }
      if (t === 'insertText' || t === 'insertReplacementText' || t === 'insertFromComposition') {
        event.preventDefault();
        const s = window.getSelection();
        if (s && s.rangeCount && !s.getRangeAt(0).collapsed) strikeInBlock(el, s.getRangeAt(0), 'after');
        insertMarkedInBlock(event.data || '');
        return;
      }
      // no new blocks, no formatting, no native undo (it can't see our marks)
      if (t.startsWith('format') || t === 'insertParagraph' || t === 'insertLineBreak'
        || t === 'insertFromDrop' || t === 'insertHorizontalRule'
        || t === 'insertOrderedList' || t === 'insertUnorderedList'
        || t === 'historyUndo' || t === 'historyRedo') {
        event.preventDefault();
      }
    };
    const onMousedown = (event) => event.stopPropagation();
    el.addEventListener('paste', onPaste);
    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('blur', commitEditorOnBlur);
    el.addEventListener('mousedown', onMousedown);
    el.contentEditable = 'true';
    el.spellcheck = true;
    el.classList.add('md-rendered-editing');
    return () => {
      el.removeEventListener('paste', onPaste);
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeEventListener('blur', commitEditorOnBlur);
      el.removeEventListener('mousedown', onMousedown);
      try { el.contentEditable = 'false'; } catch {}
      el.classList.remove('md-rendered-editing');
    };
  }

  // Point the session's mirror at (from → to): every mutation of the editing
  // surface re-serializes into the other article's copy (cleaned, exactly
  // like the resting decoration). Pagination trusts both articles laying out
  // the same content, and the seam repeats a line or two of it — without the
  // mirror the far side of a seam shows stale text while you type. Reflowing
  // text also moves the seam's line boxes, so each tick re-aligns the pages.
  function wireEditingMirror(session, from, to) {
    if (session.mirror) { try { session.mirror.disconnect(); } catch {} session.mirror = null; }
    if (!to || typeof MutationObserver !== 'function') return;
    let seamRaf = 0;
    session.mirror = new MutationObserver(() => {
      to.innerHTML = serializeMarkedBlock(from);
      if (seamRaf) return;
      seamRaf = requestAnimationFrame(() => { seamRaf = 0; syncSecondaryPane(); });
    });
    session.mirror.observe(from, { subtree: true, childList: true, characterData: true });
  }

  // The selection an entry keystroke acts on, as a live range clamped to the
  // block. The native selection's boundaries often rest outside it — a
  // triple-click ends at the NEXT block's start — so clamp rather than reject.
  // A virtual-drag selection has no live range at all; its record rebuilds
  // one. Either way a span reaching past this block strikes the part inside
  // it: editing is per-block.
  function resolveEntrySelectionRange(target, record) {
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed) {
      const live = sel.getRangeAt(0);
      let overlaps = false;
      try { overlaps = live.intersectsNode(target); } catch {}
      if (overlaps) {
        const r = live.cloneRange();
        if (!target.contains(r.startContainer)) r.setStart(target, 0);
        if (!target.contains(r.endContainer)) r.setEnd(target, target.childNodes.length);
        if (!r.collapsed) return r;
      }
    }
    if (record && record.selectedText && record.anchorId === getAnchorIdForTarget(target)) {
      const end = record.endAnchorId && record.endAnchorId !== record.anchorId
        ? getSearchableTextNodes(target).text.length
        : record.selectionEnd;
      return createTextRangeWithin(target, record.selectionStart, end);
    }
    return null;
  }

  function openRenderedEditor(target, range, blockSource, entryEvent, clickCaret, entrySelection) {
    const origRendered = getSearchableTextNodes(target).text;
    const anchorId = target.getAttribute('data-md-anchor-id') || '';
    const existing = state.blockOverlays.get(anchorId);
    state.editing = {
      mode: 'rendered',
      el: target,
      textarea: null,
      start: range.start,
      end: range.end,
      blockSource,
      origRendered,
      anchorId,
      note: existing ? (existing.note || '') : '',
    };
    state.editing.unwire = wireEditingSurface(target);
    attachEditingStrip(state.editing, target);
    try { target.focus({ preventScroll: true }); } catch {}
    wireEditingMirror(state.editing, target, getCounterpartAnchorElement(target));
    let followRaf = 0;
    state.editing.caretFollow = () => {
      if (followRaf) return;
      followRaf = requestAnimationFrame(() => { followRaf = 0; followEditingCaret(); });
    };
    document.addEventListener('selectionchange', state.editing.caretFollow);

    const k = entryEvent ? entryEvent.key : '';
    // The entry keystroke strikes/inserts in place, exactly like every keystroke
    // after it — with a selection (live or virtual-drag record), ⌫/Delete
    // strikes the whole selection and a printable key types over it
    // (strike + insert).
    if (entryEvent && isMutatingEntryKey(entryEvent)) {
      const entryRange = resolveEntrySelectionRange(target, entrySelection);
      if (entryRange) {
        strikeInBlock(target, entryRange, 'after');
        if (k === 'Enter') insertLineBreakInBlock();
        else if (k !== 'Backspace' && k !== 'Delete') insertMarkedInBlock(k);
        return;
      }
    }
    const caret = Math.max(0, Math.min(
      clickCaret != null ? clickCaret : origRendered.length,
      origRendered.length,
    ));
    if (!entryEvent || !isMutatingEntryKey(entryEvent)) {
      setCaretWithin(target, caret);
      return;
    }
    if (k === 'Backspace') {
      if (caret > 0) { const r = createTextRangeWithin(target, caret - 1, caret); if (r) strikeInBlock(target, r, 'before'); }
      else setCaretWithin(target, 0);
    } else if (k === 'Delete') {
      const r = createTextRangeWithin(target, caret, caret + 1); if (r) strikeInBlock(target, r, 'after');
    } else if (k === 'Enter') {
      setCaretWithin(target, caret);
      insertLineBreakInBlock();
    } else {
      setCaretWithin(target, caret);
      insertMarkedInBlock(k);
    }
  }

  // Editing an element commits only when focus leaves the whole edit apparatus —
  // the block being edited plus its control. Moving within it (into the note, a
  // button, or back to the text) keeps the edit live. Shared by the block editor
  // and the note field so either can hand focus to the other.
  function commitEditorOnBlur(event) {
    const to = event && event.relatedTarget;
    if (to && state.editing) {
      const { strip, el } = state.editing;
      if (strip && strip.contains(to)) return;
      // A handover focuses the other copy: session.el already points there.
      if (el && (el === to || (el.contains && el.contains(to)))) return;
    }
    commitBlockEditor();
  }

  // The edit's control is one thing across its whole life: the same composer
  // bubble a revisit shows — note textarea + Undo + Send — sitting inline under
  // the block while you edit, so making and revisiting an edit look identical.
  // The note you type here rides onto the committed hunk. Stored on the session
  // so commit/revert removes it.
  function attachEditingStrip(session, editorEl) {
    const holder = document.createElement('div');
    holder.className = 'md-pending-strip md-editing-strip';
    holder.addEventListener('mousedown', (event) => event.stopPropagation());
    const sendShortcut = platform === 'darwin' ? '⌘↩' : 'Ctrl↩';
    // Send flushes the whole batch — this edit plus everything queued — so the
    // label counts when that is more than one (the comment composer's grammar).
    // A revisited block is already in blockOverlays; a fresh edit is not yet.
    const batchCount = state.queuedComments.length + state.blockOverlays.size
      + (state.blockOverlays.has(session.anchorId) ? 0 : 1);
    const composer = createComposer({
      placeholder: 'Note for the agent about this edit...',
      seed: session.note || '',
      rows: 2,
      onInput: () => { autoGrowTextarea(composer.textarea); session.note = composer.textarea.value; },
      actions: [
        { label: 'Revert', onClick: () => revertBlockEditor() },
        { label: batchCount > 1 ? `Send all (${batchCount})` : 'Send', shortcut: sendShortcut, primary: true, onClick: () => { commitBlockEditor(); sendEditBatch(); } },
      ],
    });
    // Buttons must not steal focus from the editor (that blur would commit
    // before the click) — mousedown-preventDefault, as the old pill did.
    composer.root.querySelectorAll('.cu-btn').forEach((b) => {
      b.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
    });
    // The note hands focus back to the text or a button without committing;
    // leaving the apparatus entirely commits (mirrors the editor's blur guard).
    composer.textarea.addEventListener('blur', (event) => {
      const to = event.relatedTarget;
      // The live surface may have handed over to the block's other copy since
      // the strip was attached — judge against the session's current surface.
      const surface = state.editing ? state.editing.el : editorEl;
      if (to && (surface === to || (surface && surface.contains && surface.contains(to)) || holder.contains(to))) return;
      if (state.editing) commitBlockEditor();
    });
    holder.appendChild(composer.root);
    session.strip = holder;
    session.composer = composer;
    if (editorEl && editorEl.parentNode) editorEl.insertAdjacentElement('afterend', holder);
    else (state.spreadLayout || document.body).appendChild(holder);
    // Entry moves nothing (the caret is where you clicked): a seat below the
    // fold pins as an overlay instead of scrolling the page to chase it.
    updateEditingStripSeat();
    return holder;
  }

  // The spill fix, minimal: when an active edit control sits below the fold of
  // the primary page, scroll it into view (content must stay visible; a resting
  // mark can wait for the page flip). The secondary page is transform-positioned,
  // so it's left alone here.
  //
  // Deliberately NOT extended to the blocked ("needs you") card, tempting as
  // that is: this would run on every store refresh, so the page would jump
  // whenever the agent replied anywhere. The amber border survives clipping — a
  // half-cut card still reads as "needs you" and resolves on the next scroll —
  // so the interrupt isn't lost, only its full text is briefly. A rare cosmetic
  // clip beats constant scroll-jank. If you came here to "fix" a clipped card,
  // that is the trade you'd be making.
  function ensureVisibleInPane(el) {
    // Only the primary page scrolls (the secondary is transform-positioned).
    if (!el || !state.primaryPane || typeof el.getBoundingClientRect !== 'function') return;
    if (!state.primaryPane.contains(el)) return;
    const paneRect = state.primaryPane.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    if (!paneRect.height || !elRect.height) return;
    const overflow = elRect.bottom - (paneRect.bottom - 8);
    if (overflow > 0) {
      state.primaryPane.scrollTop += overflow;
      state.spreadGridTop = state.primaryPane.scrollTop; // reveal re-bases the grid
      syncSecondaryPane();
    }
  }

  function openBlockEditor(target, entryEvent) {
    if (state.editing || !target) return;
    // A sealed block holds a sent edit awaiting the agent — its content can't be
    // re-edited in place (roll back to change). Notes and comments still route
    // through their own paths, so only the in-place editor is blocked here.
    if (target.closest && target.closest('.md-sealed')) {
      if (typeof showToast === 'function') showToast('This edit is sent — awaiting the agent');
      return;
    }
    // The typeset text is the editing surface; an image-only block has none to
    // strike or hang an insertion on, so it takes comments, not in-place edits.
    if (!getRenderedText(target).trim()) {
      if (typeof showToast === 'function') showToast('An image block takes comments, not edits');
      return;
    }
    const range = getBlockSourceRange(target);
    if (!range) return;
    const clickCaret = state.pendingClickCaret;
    // A virtual-drag selection has no live DOM range — it exists only in the
    // armed record, which the target clear below wipes. Carry it in by hand.
    const entrySelection = state.activeSelection;
    hideHint();
    clearActiveTarget();
    // Every block edits in place on its frozen rendered surface — markup blocks
    // (bold, links, lists) strike like prose. There is no source-textarea
    // fallback; the source is never touched.
    const blockSource = blockSourceForRange(range);
    openRenderedEditor(target, range, blockSource, entryEvent, clickCaret, entrySelection);
  }

  function commitBlockEditor() {
    const session = state.editing;
    if (!session) return;
    state.editing = null;
    releaseEditingFollowers(session);
    if (session.strip) { try { session.strip.remove(); } catch {} }
    try { session.el.contentEditable = 'false'; } catch {}
    const anchorId = session.anchorId;
    const note = session.note && session.note.trim() ? session.note.trim() : '';
    // Strike-in-place left exact del/ins marks on the block: keep them verbatim
    // as the overlay (the decoration IS what you struck, never a re-derived diff).
    // A whole-text replacement with no marks (e.g. a programmatic edit) derives
    // its overlay by diffing the original rendered text against the edit.
    let html = null;
    if (session.el.querySelector('del.md-pending-del, ins.md-pending-ins')) {
      const serialized = serializeMarkedBlock(session.el);
      if (/<del|<ins/.test(serialized)) html = serialized;
    } else {
      html = buildDerivedOverlayHtml(session);
    }
    if (anchorId && html) state.blockOverlays.set(anchorId, { html, note });
    else if (anchorId) state.blockOverlays.delete(anchorId);
    if (state.expandedHunkKey && !state.blockOverlays.has(state.expandedHunkKey)) state.expandedHunkKey = null;
    reapplyEditDecorations();
    applyPendingMarkdownRefreshIfReady();
    // The edit is done; typing means the prompt again. Without this, focus
    // dies on <body> and the keyboard reaches nothing (a commit-adjacent
    // click that targets a block re-takes focus right after, by design).
    if (typeof focusTerminal === 'function') focusTerminal();
  }

  function releaseEditingFollowers(session) {
    if (session.mirror) { try { session.mirror.disconnect(); } catch {} }
    if (session.caretFollow) document.removeEventListener('selectionchange', session.caretFollow);
    if (session.unwire) { try { session.unwire(); } catch {} }
  }

  function revertBlockEditor() {
    if (!state.editing) return;
    const session = state.editing;
    state.editing = null;
    releaseEditingFollowers(session);
    if (session.strip) { try { session.strip.remove(); } catch {} }
    try { session.el.contentEditable = 'false'; } catch {}
    // Nothing committed to the overlay map: a re-layout from the frozen doc
    // drops the in-progress marks and restores any prior overlay untouched.
    reapplyEditDecorations();
    applyPendingMarkdownRefreshIfReady();
    if (typeof focusTerminal === 'function') focusTerminal();
  }

  // Drop a committed edit: remove its overlay and re-decorate. The source was
  // never touched, so there is nothing to un-splice.
  function undoOverlay(anchorId) {
    if (!anchorId || !state.blockOverlays.has(anchorId)) return;
    state.blockOverlays.delete(anchorId);
    if (state.expandedHunkKey === anchorId) state.expandedHunkKey = null;
    reapplyEditDecorations();
    applyPendingMarkdownRefreshIfReady();
  }

  // layoutSpread freezes while comments are queued (its innerHTML rebuild would
  // wipe their marks). For a local edit re-render that must show through — a
  // commit, revert, or strip toggle on a block that also carries a comment —
  // rebuild anyway, then re-anchor each queued mark onto the fresh DOM by its
  // stable anchorId. Without this the edit is neither shown nor rollback-able.
  function relayoutThroughQueuedComments() {
    const queued = state.queuedComments.splice(0);
    for (const c of queued) { c.card = null; c.cardCounterpart = null; c.placeholder = null; }
    layoutSpread();
    if (!queued.length) return;
    state.queuedComments.push(...queued);
    for (const c of queued) {
      const article = c.pane === 'right' ? state.secondaryArticle : state.article;
      const target = article && getArticleAnchorById(article, c.anchorId);
      if (!target) continue; // anchor gone (rare) — the mark returns on the next full render
      c.target = target;
      createQueuedMarkdownCommentCard(c);
    }
  }

  // Re-apply pending edit decorations after a commit, revert, or undo. The
  // source is frozen, so the doc never re-renders here: a fresh layout from the
  // frozen doc gives a clean slate, then the overlays paint back on. A comment
  // target left by the commit click must not gate this (layoutSpread skips while
  // a target is active), so clear it first.
  function reapplyEditDecorations() {
    clearActiveTarget();
    relayoutThroughQueuedComments();
  }

  // In-place pending view: the blocks a hunk touches are replaced by a
  // Whitespace-collapsed view of a string with index maps both ways, so
  // source offsets (which may carry stray spaces an edit left behind, or
  // newlines that render as spaces) translate to DOM text offsets.
  function wsProfile(text) {
    let out = '';
    const toOrig = [];
    const toCollapsed = new Array(text.length + 1);
    for (let i = 0; i < text.length; i += 1) {
      toCollapsed[i] = out.length;
      if (/\s/.test(text[i])) {
        if (out === '' || out.endsWith(' ')) continue;
        out += ' ';
      } else {
        out += text[i];
      }
      toOrig.push(i);
    }
    toCollapsed[text.length] = out.length;
    if (out.endsWith(' ')) { out = out.slice(0, -1); toOrig.pop(); }
    toOrig.push(text.length);
    return { text: out, toOrig, toCollapsed };
  }

  // Decorate a block IN PLACE with a merged edit, striking deleted words and
  // marking inserted ones without re-rendering. The frozen block shows the
  // ORIGINAL (pre-edit) text (prefix + del + suffix), so we match that, wrap
  // each del span where it sits, and splice each ins in beside it. Inline markup
  // (bold, links) survives; only the edited words are touched. Whitespace is
  // elastic (a source newline renders as a space) and an untouched ATX heading
  // marker is skipped. Returns false when the original text is not found
  // uniquely at a line boundary (a stale thread whose text moved on falls back
  // to the box).
  function decorateMergedIntoBlock(el, segments, kind) {
    let segs = segments;
    // OLD text = prefix + del + suffix (what the frozen block currently shows).
    let oldText = segments.map((g) => (g.kind === 'ins' ? '' : g.text)).join('');
    const marker = oldText.match(/^#{1,6} /);
    if (marker) {
      const first = segments[0];
      if (!first || first.kind !== 'text' || first.text.length < marker[0].length) return false;
      oldText = oldText.slice(marker[0].length);
      segs = [{ kind: 'text', text: first.text.slice(marker[0].length) }, ...segments.slice(1)];
    }
    const domText = getSearchableTextNodes(el).text;
    const R = wsProfile(domText);
    const S = wsProfile(oldText);
    if (!S.text) return false;
    const found = R.text.indexOf(S.text);
    if (found === -1 || R.text.indexOf(S.text, found + 1) !== -1) return false;
    // The original text is a whole line; it may only match at line boundaries in
    // the block. A prefix match inside a longer line (a stale sent thread whose
    // text half-survives) must fall through, not strike live text.
    const startOrig = R.toOrig[found];
    const endC = found + S.text.length;
    const endOrig = endC < R.toOrig.length ? R.toOrig[endC] : domText.length;
    if (startOrig > 0 && domText[startOrig - 1] !== '\n') return false;
    if (endOrig < domText.length && !/^\s*(\n|$)/.test(domText.slice(endOrig))) return false;
    // Map an OLD collapsed offset to an index into the ORIGINAL visible text.
    const mapToDom = (off) => {
      const c = Math.min(S.toCollapsed[Math.min(off, oldText.length)], S.text.length);
      return R.toOrig[Math.min(found + c, R.text.length)];
    };
    // Transactional: a midway failure must not leave partial marks behind (the
    // box fallback renders next to whatever survived otherwise).
    const inserted = [];
    const rollback = () => {
      for (const node of inserted) {
        const parent = node.parentNode;
        if (!parent) continue;
        if (node.tagName === 'DEL') {
          while (node.firstChild) parent.insertBefore(node.firstChild, node);
        }
        node.remove();
        if (parent.normalize) parent.normalize();
      }
    };
    try {
      // offset walks OLD collapsed coordinates (prefix and del advance it; an ins
      // is zero-width in OLD). shift tracks how the applied marks have changed the
      // live visible length to the LEFT (a struck del leaves the walker's text, an
      // inserted ins joins it), so an original index maps to live as index+shift.
      let offset = 0;
      let shift = 0;
      for (const seg of segs) {
        if (seg.kind === 'text') {
          offset += seg.text.length;
        } else if (seg.kind === 'del') {
          if (seg.text) {
            const domS = mapToDom(offset);
            const domE = mapToDom(offset + seg.text.length);
            const range = createTextRangeWithin(el, domS + shift, domE + shift);
            if (!range) throw new Error('unmappable');
            const delEl = document.createElement('del');
            delEl.className = kind === 'sent' ? 'md-sent-del' : 'md-pending-del';
            range.surroundContents(delEl);
            inserted.push(delEl);
            shift -= (domE - domS);
          }
          offset += seg.text.length;
        } else if (seg.kind === 'ins') {
          if (seg.text) {
            const at = getTextPositionWithin(el, mapToDom(offset) + shift);
            if (!at) throw new Error('unmappable');
            const insEl = document.createElement('ins');
            insEl.className = kind === 'sent' ? 'md-sent-ins' : 'md-pending-ins';
            insEl.textContent = seg.text;
            const r = document.createRange();
            r.setStart(at.node, at.offset);
            r.collapse(true);
            r.insertNode(insEl);
            inserted.push(insEl);
            shift += insEl.textContent.length;
          }
        }
      }
    } catch {
      rollback();
      return false;
    }
    el.classList.add(kind === 'sent' ? 'md-sent-block' : 'md-pending-block');
    return true;
  }

  // The revealed edit affordance IS the shared composer bubble: the same widget
  // a comment uses. A comment's body is its text; an edit's body is its in-place
  // marks, so the textarea carries the optional note instead. Undo takes the edit
  // back; Send commits the turn. One chrome, so revealing an edit reads like
  // opening a comment. Keyed by the block's stable anchorId.
  function buildStripHolder(anchorId, note) {
    const holder = document.createElement('div');
    holder.className = 'md-pending-strip';
    holder.addEventListener('mousedown', (event) => event.stopPropagation());
    holder.addEventListener('click', (event) => event.stopPropagation());
    const sendShortcut = platform === 'darwin' ? '⌘↩' : 'Ctrl↩';
    // This overlay is already in the batch; count everything Send will flush.
    const batchCount = state.queuedComments.length + state.blockOverlays.size;
    const composer = createComposer({
      placeholder: 'Note for the agent about this edit...',
      seed: note || '',
      rows: 2,
      onInput: () => {
        autoGrowTextarea(composer.textarea);
        const ov = state.blockOverlays.get(anchorId);
        if (ov) ov.note = composer.textarea.value.trim();
      },
      actions: [
        { label: 'Revert', onClick: () => undoOverlay(anchorId) },
        { label: batchCount > 1 ? `Send all (${batchCount})` : 'Send', shortcut: sendShortcut, primary: true, onClick: () => sendEditBatch() },
      ],
    });
    holder.appendChild(composer.root);
    if (state.pendingRefreshResult) {
      const held = document.createElement('span');
      held.className = 'md-sent-chip';
      held.textContent = 'agent updated · reconciles on send';
      holder.appendChild(held);
    }
    return holder;
  }

  function toggleHunkStrip(anchorId) {
    state.expandedHunkKey = state.expandedHunkKey === anchorId ? null : anchorId;
    clearActiveTarget();
    relayoutThroughQueuedComments();
    if (state.expandedHunkKey && state.article) {
      ensureVisibleInPane(state.article.querySelector('.md-pending-strip:not(.sent)'));
    }
  }

  // Every edit rests with a low-profile line, like a comment does. It carries the
  // note (the one thing the in-place marks don't already show); with no note it
  // shows a muted prompt, so a bare edit is still a discoverable handle to its
  // control. Click reveals the strip.
  function buildEditNoteRow(anchorId, note) {
    const noteText = String(note || '').split('\n')[0].replace(/\s+/g, ' ').trim();
    const row = document.createElement('div');
    row.className = noteText ? 'md-pending-note-mark' : 'md-pending-note-mark empty';
    row.dataset.mdHunkKey = anchorId;
    const text = document.createElement('span');
    text.className = 'md-anno-text';
    // First line, whitespace collapsed: same normalization as a comment's resting
    // row, so a multi-line note truncates the same way (CSS ellipsis trims the
    // width). The full note stays in the tooltip.
    text.textContent = noteText || 'Add a note for the agent';
    row.append(text);
    row.title = noteText || 'Add a note for the agent';
    row.addEventListener('mousedown', (event) => event.stopPropagation());
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleHunkStrip(anchorId);
    });
    return row;
  }

  // Paint every pending overlay onto its block by the stable anchorId (the
  // source is frozen, so ids are stable across renders). Each overlay is the
  // exact struck/inserted markup; set it as the block's content, then rest a note
  // row (or the open action strip) under it. A strike-in-place edit is
  // single-block and always has an overlay, so there is no diff enumeration here.
  function renderPendingDiffBlocks() {
    for (const article of [state.article, state.secondaryArticle]) {
      if (!article) continue;
      for (const el of article.querySelectorAll('.md-pending-strip:not(.sent), .md-pending-note-mark')) el.remove();
    }
    if (state.expandedHunkKey && !state.blockOverlays.has(state.expandedHunkKey)) {
      state.expandedHunkKey = null;
    }
    if (!state.blockOverlays.size) return;
    for (const article of [state.article, state.secondaryArticle]) {
      if (!article) continue;
      for (const [anchorId, ov] of state.blockOverlays) {
        const el = getArticleAnchorById(article, anchorId);
        if (!el) continue;
        el.innerHTML = ov.html;
        el.classList.add('md-pending-block');
        el.dataset.mdHunkKey = anchorId;
        const note = ov.note || '';
        if (state.expandedHunkKey === anchorId) {
          el.insertAdjacentElement('afterend', buildStripHolder(anchorId, note));
        } else {
          el.insertAdjacentElement('afterend', buildEditNoteRow(anchorId, note));
        }
      }
    }
  }

  // The exact marks the user struck, as the envelope body: the passage in
  // rendered form with <del>/<ins> in place (markup tags dropped; the user
  // marked what they saw, and the agent maps it to the source).
  // overlayToEnvelope moved to edit-marks.js.

  // One edit thread from an overlay: its exact marks as the [Edit] envelope. The
  // ATX heading marker (if any) is restored from the frozen source so the agent's
  // target is unambiguous. The block is anchored by its frozen rendered text.
  function buildEditThreadPayload(anchorId, ov, finalDoc, finalText) {
    const anchors = finalDoc && Array.isArray(finalDoc.anchors) ? finalDoc.anchors : [];
    const a = anchors.find((an) => an.id === anchorId);
    if (!a) return null;
    const blockSource = finalText.split('\n').slice(a.startLine - 1, a.endLine).join('\n');
    const marker = (blockSource.match(/^#{1,6} /) || [''])[0];
    const inner = overlayToEnvelope(ov.html);
    const rendered = renderBlockElement(blockSource);
    const snippet = rendered ? getSearchableTextNodes(rendered).text : '';
    let heading = '';
    const hierarchy = getSectionHierarchyForLine(finalDoc.headings, a.startLine);
    if (Array.isArray(hierarchy) && hierarchy.length) heading = String(hierarchy[hierarchy.length - 1]);
    return {
      body: wrapEditEnvelope(inner, marker),
      note: ov.note || '',
      anchor: { snippet, context: '', wholeBlock: false, heading },
    };
  }

  // Handoff (Cmd+Enter): the document is never rewritten. Each pending edit ships
  // as a comment thread carrying its exact marks, keyed to the frozen block;
  // queued comments ride along. Preflight the runbook first (found: send with it;
  // missing: send-anyway ack or cancel), then hand off as one turn.
  async function sendEditBatch() {
    const doc = state.resolvedPath || state.filePath;
    if (!doc || typeof submitMarkdownThreads !== 'function') return false;
    const commentRecords = getPendingMarkdownCommentRecords();
    const overlayEntries = Array.from(state.blockOverlays.entries());
    if (!overlayEntries.length && !commentRecords.length) return false;
    let allowMissingRunbook = false;
    if (typeof preflightMarkdownRunbook === 'function') {
      const pf = await preflightMarkdownRunbook({ docPath: doc });
      if (pf && pf.canceled) return false; // nothing sent
      allowMissingRunbook = !!(pf && pf.acked);
    }
    try {
      // The frozen source is the anchor/heading truth; nothing is read back from
      // disk and nothing is written.
      const finalText = state.sourceText;
      const finalDoc = state.doc && Array.isArray(state.doc.anchors)
        ? state.doc
        : renderMarkdownDocument(finalText, markdownImageOptions({ path: doc }));
      const editThreads = overlayEntries
        .map(([anchorId, ov]) => buildEditThreadPayload(anchorId, ov, finalDoc, finalText))
        .filter(Boolean);
      const editCount = editThreads.length;
      const comments = commentRecords.map(getMarkdownThreadPayload);
      const commentCount = comments.length;
      const threads = [...editThreads, ...comments];
      if (threads.length) {
        const batchKind = editCount && threads.length > editCount
          ? 'mixed'
          : (editCount ? 'edits' : 'comments');
        const result = await submitMarkdownThreads({ docPath: doc, threads, batchKind, allowMissingRunbook });
        if (!result || !result.success) throw new Error((result && result.error) || 'Could not send the batch');
        adoptThreadStore(result.data);
        // Sending hands the turn to the agent. At full size that leaves the user
        // blind to the pickup, so recede to the golden split: the terminal slides
        // into view underneath (the receipt) while the doc keeps the major share,
        // where the replies land. The user chose full mode, so the recede arms a
        // resume: when the store says the agent's turn is over (no thread awaits
        // it — see maybeResumeFullSize), full size comes back. The store is the
        // one true done signal; PTY quiet can't tell a finished turn from a
        // permission prompt, so no auto-expand rides the working heuristics.
        if (band.isFull()) {
          band.toggleFullSize();
          state.resumeFullPending = true;
        }
      }
      state.blockOverlays = new Map();
      state.expandedHunkKey = null;
      state.pendingRefreshResult = null;
      state.pendingRefreshSignature = '';
      state.pendingRefreshStatSignature = '';
      closeActiveCard();
      clearQueuedMarkdownComments();
      clearActiveTarget();
      layoutSpread();
      if (typeof showToast === 'function') {
        const bits = [];
        if (editCount) bits.push(`${editCount} edit${editCount === 1 ? '' : 's'}`);
        if (commentCount) bits.push(`${commentCount} comment${commentCount === 1 ? '' : 's'}`);
        showToast(`Sent ${bits.join(' and ')}`);
      }
      return true;
    } catch (error) {
      if (typeof showToast === 'function') {
        showToast(error && error.message ? error.message : 'Could not send edits');
      }
      return false;
    }
  }

  // --- Thread layer (sidecar store → inline cards/disclosure lines; the
  // contract is ~/agent-threads/contract.md) ---

  const THREAD_FLOW_SELECTOR = '.md-thread-card, .md-thread-resolved-summary, .md-thread-resolved-line, .md-thread-waiting-line';
  // Resolved threads with no anchor left pile at the article end under one count.
  const ORPHAN_THREAD_KEY = '__orphan__';

  // Prose anchor resolution: the innermost block containing the snippet,
  // disambiguated by context when the snippet is short/repeated; heading
  // fallback; null = lost (the card settles at the document end, marked).
  // A heading anchor's snippet is its source line; rendered text never
  // carries the ATX marker, so matching strips it.
  function snippetMatchText(snippet) {
    return normalizeChangeMatchText(snippet).replace(/^#{1,6} /, '');
  }

  // The nearest heading block, matched exactly — the honest fallback for any
  // anchor whose primary target (snippet or image) is gone from the page.
  function resolveThreadHeadingTarget(article, headingText) {
    const heading = normalizeChangeMatchText(headingText);
    if (!heading || !article) return null;
    for (const el of article.querySelectorAll('h1[data-md-anchor-id],h2[data-md-anchor-id],h3[data-md-anchor-id],h4[data-md-anchor-id],h5[data-md-anchor-id],h6[data-md-anchor-id]')) {
      if (normalizeChangeMatchText(getRenderedText(el)) === heading) return el;
    }
    return null;
  }

  function resolveThreadTarget(article, thread) {
    const anchor = (thread && thread.anchor) || {};
    if (!article) return null;
    // Image anchor: the block has no text, so locate it by its <img>'s authored
    // src. If the image is gone, fall to the heading — never match the alt
    // (in `snippet`) against prose, since it's a label, not page text.
    if (anchor.src) {
      const want = String(anchor.src);
      for (const el of article.querySelectorAll('[data-md-anchor-id]')) {
        const img = el.querySelector('img[data-md-src]');
        if (img && img.getAttribute('data-md-src') === want) return el;
      }
      return resolveThreadHeadingTarget(article, anchor.heading);
    }
    const snippet = snippetMatchText(anchor.snippet);
    if (!snippet) return null;
    const candidates = [];
    for (const el of article.querySelectorAll('[data-md-anchor-id]')) {
      if (normalizeChangeMatchText(getRenderedText(el)).includes(snippet)) candidates.push(el);
    }
    if (candidates.length) {
      let pool = candidates;
      const context = normalizeChangeMatchText(anchor.context);
      if (candidates.length > 1 && context) {
        const scoped = candidates.filter((el) => {
          const text = normalizeChangeMatchText(getRenderedText(el));
          return text === context || text.includes(context) || context.includes(text);
        });
        if (scoped.length) pool = scoped;
      }
      return pool.reduce((a, b) => (getRenderedText(a).length <= getRenderedText(b).length ? a : b));
    }
    return resolveThreadHeadingTarget(article, anchor.heading);
  }

  // The quoted text a comment thread anchors to, as live Ranges in `target` —
  // the readback of the selection highlight the draft wore while composing.
  // Comments on a sub-block selection only: an edit thread shows its marks in
  // place, and a whole-block or image comment's card already sits under the
  // block it means. The stored snippet and the DOM disagree on whitespace, so
  // build the normalized text with per-char offsets back into searchable
  // space, then map the hit to a Range. A miss (text changed since, heading
  // fallback) yields no readback.
  function createThreadAnchorRanges(target, thread) {
    const anchor = (thread && thread.anchor) || {};
    const first = (thread && thread.messages && thread.messages[0] && thread.messages[0].body) || '';
    if (!target || anchor.src || anchor.wholeBlock || parseEditEnvelope(first)) return [];
    const snip = snippetMatchText(anchor.snippet);
    if (!snip) return [];
    const { text } = getSearchableTextNodes(target);
    let norm = '';
    const offsets = []; // offsets[i] = searchable-space offset of norm[i]
    let prevSpace = true; // collapse runs + left-trim, matching normalizeChangeMatchText
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) {
        if (prevSpace) continue;
        norm += ' ';
        offsets.push(i);
        prevSpace = true;
      } else {
        norm += text[i];
        offsets.push(i);
        prevSpace = false;
      }
    }
    const index = norm.indexOf(snip);
    if (index < 0) return [];
    const range = createTextRangeWithin(target, offsets[index], offsets[index + snip.length - 1] + 1);
    return range ? [range] : [];
  }

  // The agent owns this (contract.md): `resolved` means it finished the user's
  // ask and needs nothing back, so the thread is history and folds into its
  // block's count. Anything else is `open` — the agent is blocked on the user —
  // and renders in full, because it is the one thing the user must act on. The
  // viewer no longer guesses from the logical clock: only the agent knows
  // whether an ask is actually done.
  function isThreadResolved(thread) {
    return !!thread && thread.status === 'resolved';
  }

  // The [Edit] envelope is the agent's wire format — never show it raw.
  // parseEditEnvelope / buildEnvelopeDiffNode moved to edit-marks.js.

  function isEditThread(thread) {
    const first = thread.messages && thread.messages[0];
    return !!(first && first.author === 'user' && parseEditEnvelope(first.body));
  }

  // Un-consumed edit threads render IN PLACE as sent diffs (the pending view
  // continuing through its lifecycle). Consumption today = the agent replied;
  // agent_seen_turn joins as a second signal when the enumeration tool lands.
  // An edit is consumed when it is APPLIED, which only `resolved` says. The
  // agent replying while still blocked has changed nothing — the suggestion is
  // still pending, so its block stays sealed and keeps showing the marks. (This
  // used to ask "has the agent spoken?", the same inference the agent now
  // declares for us; a blocked reply silently unsealed the block and the user's
  // marks vanished from the page.)
  function isUnconsumedEditThread(thread) {
    if (!isEditThread(thread)) return false;
    return thread.status !== 'resolved';
  }

  // Does this thread need the user? That is the only question the page's one
  // colour answers now. An open thread the agent has spoken last on is blocked
  // on them — the single thing here that wants action. A thread still awaiting
  // the agent needs nothing from them, and resolved needs nothing from anyone.
  // ("Whose turn" was the clock model's question; amber meant awaiting-agent and
  // green meant your-move, which painted the one card demanding action in the
  // colour that says all-clear.)
  function threadNeedsUser(thread) {
    if (thread.status === 'resolved') return false;
    const msgs = Array.isArray(thread.messages) ? thread.messages : [];
    return msgs.length > 0 && msgs[msgs.length - 1].author === 'agent';
  }

  // The agent's doc-side turn is over when every thread is resolved — the
  // agent's explicit end-of-work mark, and the contract orders it after the
  // doc write (agent-threads contract.md, resolve-after-visibility), so
  // all-resolved lands with the last change already on disk. Counting an open
  // agent-last thread as "bounced back" made this flip mid-turn: a reply can
  // land before the acting is done, so the poll caught the reply and expanded
  // the band while edits were still landing (the review viewer had the same
  // bug, worse — its regen reload made the expand look tied to the code
  // change). A thread left open — blocked on the user, or merely answered —
  // keeps golden: the reply is on screen and pulsing there, and expanding for
  // it is the user's call. The cost is that such a wave never auto-resumes
  // full; the cost of the old rule was motion mid-turn, and of the two only
  // one takes the screen out of the user's hands.
  function agentTurnOverInStore() {
    const threads = (state.threadStore && Array.isArray(state.threadStore.threads))
      ? state.threadStore.threads : [];
    return threads.length > 0 && threads.every((t) => isThreadResolved(t));
  }

  // The resume armed by a full-size send (sendEditBatch): the user chose full
  // mode, the send only borrowed the screen for the terminal receipt, so when
  // the store says the agent is done the doc takes the stage back. One-shot at
  // the moment the store turns: if the user has meanwhile taken the layout into
  // their own hands (band hidden by terminal typing or Esc, or already resized),
  // the moment passes and nothing moves — their hand wins over the restoration.
  function maybeResumeFullSize() {
    if (!state.resumeFullPending || !agentTurnOverInStore()) return;
    state.resumeFullPending = false;
    if (!band.isOpen() || band.isFull()) return;
    band.toggleFullSize();
  }

  // All of a block's resolved threads, as one line: a count and nothing else.
  // They are finished business and their result already shows as the document
  // change, so the page spends one line on them. It is a HEADER — its threads
  // unfold beneath it, so the control stays put under the cursor.
  // Folded, the whole history is this one row: the newest thread's hook, with
  // the rest surviving as "+N more". No count — you can see what it was.
  function buildResolvedFoldedRow(group) {
    const line = document.createElement('div');
    line.className = 'md-thread-resolved-summary';
    fillThreadHook(line, group[group.length - 1]);
    if (group.length > 1) {
      const more = document.createElement('span');
      more.className = 'md-anno-meta';
      more.textContent = `+${group.length - 1} more`;
      line.append(more);
    }
    return line;
  }

  // Open or fold a thread row, moving the state and the pixels together.
  //
  // A row's click never reaches handleArticleClick (the row stops propagation,
  // because the article's own click arms the block under it), so an armed block
  // would still be sitting in state.activeTarget with layoutSpread refusing to
  // rebuild — and the click read as dead. A click on a row IS the click
  // elsewhere that disarms a block, so say so here. Queued marks ride the
  // rebuild the way a committed edit does (relayoutThroughQueuedComments).
  //
  // A composer or an editing session still owns the DOM and outranks a fold, so
  // the render is left pending for the poll to flush rather than dropped: the
  // set and the page always converge, at worst one tick later.
  function applyThreadFold(mutate) {
    clearActiveTarget();
    mutate();
    if (state.activeCard || state.editing) state.threadRenderPending = true;
    else relayoutThroughQueuedComments();
  }

  // The fold control, by state. Folded, the row itself is the control — one
  // full-width target, no chrome — and its "+N more" already marks it as a
  // fold rather than a thread. Expanded, the first row is a thread line whose
  // click opens that thread, so folding back gets a gutter caret: the one
  // place a second control fits without spending a line. The caret exists
  // exactly when there is something to fold.
  function addResolvedFoldControl(el, key, expanded) {
    if (!el) return;
    const toggle = (event) => {
      event.preventDefault();
      event.stopPropagation();
      applyThreadFold(() => {
        if (state.resolvedExpanded.has(key)) state.resolvedExpanded.delete(key);
        else state.resolvedExpanded.add(key);
      });
    };
    if (!expanded) {
      el.title = 'Show earlier resolved';
      el.addEventListener('mousedown', (event) => event.stopPropagation());
      el.addEventListener('click', toggle);
      return;
    }
    el.classList.add('md-resolved-first');
    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'md-resolved-caret';
    caret.textContent = '▾';
    caret.title = 'Fold resolved';
    caret.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
    caret.addEventListener('click', toggle);
    el.appendChild(caret);
  }

  // One resolved thread, at rest behind the count: your opening ask and nothing
  // else. A thread always opens with your words, and your own prompt is what
  // reminds you what it was about — so it's the handle for finding the one you
  // want, rather than reading them all. An edit's first message is a diff, not
  // prose, so its marks stand in: they are still your words, never a synthesized
  // label. Click opens this one into its full card.
  // Your words lead — the hook you scan for — and the agent's reply fills the
  // tail. Shared by a resolved line and the folded count above it, so the same
  // thread reads identically wherever it surfaces.
  function fillThreadHook(line, thread) {
    const msgs = Array.isArray(thread.messages) ? thread.messages : [];
    const first = (msgs[0] && msgs[0].body) || '';
    const isEdit = !!parseEditEnvelope(first);
    const note = msgs.find((m, i) => i > 0 && m.author === 'user');
    const reply = msgs.find((m) => m.author === 'agent');
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    // ✎ marks an edit, so the list reads at a glance without opening anything.
    if (isEdit) {
      const glyph = document.createElement('span');
      glyph.className = 'md-anno-edit';
      glyph.textContent = '✎';
      line.append(glyph);
    }
    const text = document.createElement('span');
    text.className = 'md-anno-text';
    // Your own words lead — they are the hook you scan for. A comment's prompt,
    // or an edit's note; an edit without a note has no prose of yours (its first
    // message is a diff), so the agent's reply carries the line alone.
    const mine = isEdit ? (note ? note.body : '') : first;
    if (mine) text.append(document.createTextNode(clean(mine)));
    // The row is full width either way, so spend its tail on the agent's reply
    // instead of whitespace: the answer costs no extra height, truncates with an
    // ellipsis when long, and your hook still reads first. Label it — unlabeled
    // always means you.
    if (reply) {
      const who = document.createElement('span');
      // Needs a gap only when your prose runs into it. It can't be a
      // :first-child rule — the text before it is a text node, so the label is
      // still the first ELEMENT and the selector would never match.
      who.className = `md-anno-who${mine ? ' md-anno-who--after' : ''}`;
      who.textContent = 'agent';
      text.append(who);
      text.append(document.createTextNode(clean(reply.body)));
    }
    if (!text.textContent) text.textContent = clean(first);
    line.append(text);
  }

  // A hard line break, in any block — Shift+Enter while editing, or Enter as
  // the first key on a clicked block. Typed text normalizes whitespace to
  // single spaces; a deliberate break keeps a real "\n" inside an insertion
  // mark, so the envelope hands the agent the break exactly where it was made.
  // In a <pre> the "\n" shows as-is (whitespace is honest there). In prose it
  // rides a dedicated break atom (ins.md-pending-break) whose own pre-wrap
  // renders the break while the block stays collapsed, with a pilcrow making
  // it visible and struck-able. What the new line BECOMES in markdown source
  // (heading, paragraph, list item, continuation) is the agent's call — the
  // break's position is the user's, its form is not (md/user-intent.md).
  // insertLineBreakInBlock moved to edit-marks.js.

  function isCodeSurface(el) {
    return !!(el && el.closest && el.closest('pre'));
  }

  function buildResolvedThreadLine(thread) {
    const line = document.createElement('div');
    line.className = 'md-thread-resolved-line';
    fillThreadHook(line, thread);
    line.title = 'Click to open';
    line.addEventListener('mousedown', (event) => event.stopPropagation());
    line.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      applyThreadFold(() => state.expandedThreads.add(thread.id));
    });
    return line;
  }

  // A sent thread awaiting the agent is locked — the turn is the agent's and
  // there is nothing here to act on — so it rests as the same one-line row a
  // queued draft collapses to, rather than restating words you just wrote.
  // Click reads it back (opens the full card; the card folds again on click).
  // The working pulse rides this row while the agent runs.
  function buildWaitingThreadLine(thread) {
    const line = document.createElement('div');
    line.className = 'md-thread-waiting-line';
    fillThreadHook(line, thread);
    line.title = 'Waiting for the agent — click to open';
    line.addEventListener('mousedown', (event) => event.stopPropagation());
    line.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      applyThreadFold(() => state.expandedThreads.add(thread.id));
    });
    return line;
  }

  // An open thread's flow element: blocked-on-you renders the full card (it is
  // the worklist — folding it would hide the one thing that needs the user);
  // awaiting-the-agent rests as a one-line row until clicked open.
  function buildOpenThreadElement(thread, lost, opts) {
    if (threadNeedsUser(thread) || state.expandedThreads.has(thread.id)) {
      return buildThreadCard(thread, lost, opts);
    }
    return buildWaitingThreadLine(thread);
  }

  function buildThreadCard(thread, lost, { skipEnvelope = false } = {}) {
    const card = document.createElement('div');
    // Turn-color is for OPEN threads only — it says who owes the next move.
    // Resolved is finished business with no turn at all, so it stays grey; if it
    // wore the same green as a thread blocked on you, the one card that needs
    // you would be camouflaged by the ones that don't.
    const waiting = thread.status !== 'resolved' && !threadNeedsUser(thread);
    card.className = `md-thread-card ${thread.status === 'resolved'
      ? 'resolved'
      : (waiting ? 'waiting' : 'needs-user')}`;
    card.addEventListener('mousedown', (event) => event.stopPropagation());
    card.addEventListener('dblclick', (event) => event.stopPropagation());
    // A waiting or resolved card is the read-back state of its resting row, so
    // its whole surface folds back on click. Guarded: buttons and the reply
    // composer keep their clicks, and a text-selection drag is reading, not
    // folding.
    if (waiting || thread.status === 'resolved') {
      card.addEventListener('click', (event) => {
        if (event.target.closest && event.target.closest('button, .md-thread-reply')) return;
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed) return;
        if (state.threadReply && state.threadReply.threadId === thread.id) return;
        event.preventDefault();
        event.stopPropagation();
        applyThreadFold(() => state.expandedThreads.delete(thread.id));
      });
    }

    // No title (the first message IS the title), no `read` pill (that state is
    // gone — only blocked-or-done can be acted on), and no fold control on a
    // needs-user card: it is blocking the agent, so folding it would hide the
    // one thing that needs the user. Waiting and resolved cards fold on click
    // (above).
    // The head exists only to carry a lost-anchor warning.
    if (lost) {
      const head = document.createElement('div');
      head.className = 'md-thread-head';
      const note = document.createElement('span');
      note.className = 'md-thread-pill lost';
      note.textContent = 'quoted text no longer on the page';
      head.appendChild(note);
      card.appendChild(head);
    }

    // Your words are the default: a thread always opens with them (you comment or
    // edit; the agent only appends), so an unlabeled line is yours. Mark only the
    // agent, and mark every one of its messages — per message, not per run, so a
    // reply of yours after the agent needs no "you" to break the run.
    const msgs = thread.messages || [];
    for (let i = 0; i < msgs.length; i++) {
      // skipEnvelope: this thread's block is sealed above, showing these very
      // marks in place — re-rendering the [Edit] as a diff here would say it twice.
      if (skipEnvelope && i === 0) continue;
      const msg = msgs[i];
      const row = document.createElement('div');
      row.className = 'md-thread-msg';
      if (msg.author === 'agent') {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = 'agent';
        row.appendChild(who);
      }
      const parsed = msg.author === 'user' ? parseEditEnvelope(msg.body) : null;
      if (parsed) {
        if (parsed.lead) {
          const lead = document.createElement('span');
          lead.textContent = parsed.lead;
          row.appendChild(lead);
        }
        row.appendChild(buildEnvelopeDiffNode(parsed));
      } else {
        const body = document.createElement('span');
        body.textContent = msg.body || '';
        row.appendChild(body);
      }
      card.appendChild(row);
    }

    const actions = document.createElement('div');
    actions.className = 'md-thread-actions';
    const reply = document.createElement('button');
    reply.type = 'button';
    reply.textContent = 'Reply';
    reply.addEventListener('click', (event) => {
      event.stopPropagation();
      openThreadReply(card, thread);
    });
    actions.append(reply);
    card.appendChild(actions);
    return card;
  }

  // A sent-but-unconsumed edit, rendered in place of its block: the same
  // diff visual as pending, in the sent tint, with the note (when present)
  // riding underneath. No actions — the turn is over; a follow-up happens
  // through the thread once the agent replies.
  function buildSentDiffElement(thread) {
    const box = document.createElement('div');
    box.className = 'md-pending-diff sent md-thread-card-flow';
    box.addEventListener('mousedown', (event) => event.stopPropagation());
    box.addEventListener('click', (event) => event.stopPropagation());
    const parsed = parseEditEnvelope(thread.messages[0].body);
    if (parsed && parsed.lead) {
      const lead = document.createElement('div');
      lead.className = 'md-pending-diff-note';
      lead.textContent = parsed.lead;
      box.appendChild(lead);
    }
    if (parsed) box.appendChild(buildEnvelopeDiffNode(parsed));
    const note = (thread.messages || []).find((m, i) => i > 0 && m.author === 'user');
    if (note) {
      const noteRow = document.createElement('div');
      noteRow.className = 'md-pending-diff-note';
      noteRow.textContent = note.body || '';
      box.appendChild(noteRow);
    }
    return box;
  }

  // Threads render in BOTH spread pages (identical DOM keeps the duplicated
  // articles' heights aligned, so no counterpart placeholders are needed).
  // Runs after every doc re-render (layoutSpread) and on store changes.
  function renderThreadLayer(sync = true) {
    if (!state.article) return;
    for (const article of [state.article, state.secondaryArticle]) {
      if (!article) continue;
      for (const el of article.querySelectorAll(THREAD_FLOW_SELECTOR)) el.remove();
      for (const el of article.querySelectorAll('.md-sealed')) el.classList.remove('md-sealed');
    }
    const store = state.threadStore;
    const threads = store && Array.isArray(store.threads) ? store.threads : [];
    const resolvedByBlock = new Map(); // block key → { target, threads[] }, per pane
    const anchorRanges = []; // quoted-text readback for every card on show, both panes
    if (threads.length) {
      for (const article of [state.article, state.secondaryArticle]) {
        if (!article) continue;
        for (const thread of threads) {
          if (!thread || !thread.id) continue;
          const target = resolveThreadTarget(article, thread);
          const snip = snippetMatchText(thread.anchor && thread.anchor.snippet);
          const exactTarget = !!(target && snip
            && normalizeChangeMatchText(getRenderedText(target)).includes(snip));
          if (exactTarget && isUnconsumedEditThread(thread)) {
            // The sent edit stays visible in place until consumed. Decorated
            // rendered text when the mapping is exact; the source box for
            // structural hunks and conflict leads (the doc doesn't hold the
            // edit). Only a true snippet match may be touched — a heading
            // fallback is a locator, and replacing it would eat the heading.
            const parsed = parseEditEnvelope(thread.messages[0].body);
            if (parsed && parsed.kind === 'merged' && !parsed.lead
              && decorateMergedIntoBlock(target, parsed.segments, 'sent')) {
              // Sealed: the block's own (grey) border is the whole signal — no
              // "awaiting agent" chip. Grey because a sent edit needs nothing from
              // the user; amber is reserved for threads that do.
              target.classList.add('md-sealed');
              // Blocked on an edit: the block stays sealed (nothing was applied)
              // and the agent's question renders beneath it. The card skips the
              // envelope — the sealed block above IS that message — and carries
              // the note itself, so no separate note row either.
              if ((thread.messages || []).some((m) => m.author === 'agent')) {
                insertCommentFlowElementAfterTarget(target,
                  buildOpenThreadElement(thread, false, { skipEnvelope: true }));
                continue;
              }
              // Awaiting the agent: the seal alone represents the edit. A note is
              // your words on a sent, waiting thread — the same situation as a
              // waiting comment, so it rests as the same bordered row (click reads
              // the thread back; the card folds again on click). The row and the
              // seal pulse together while the agent works. Without a note the seal
              // stands alone.
              target.classList.add('md-await-agent');
              const noteMsg = (thread.messages || []).find((m, i) => i > 0 && m.author === 'user');
              if (noteMsg) {
                insertCommentFlowElementAfterTarget(target,
                  buildOpenThreadElement(thread, false, { skipEnvelope: true }));
              }
              continue;
            }
            // Marks can't sit in the live text (structural hunk / conflict lead),
            // so the source box stands in for the block. It shows the envelope and
            // the note but never the agent's reply — so when the agent is blocked,
            // its question still has to render, or the ask would be invisible.
            const box = buildSentDiffElement(thread);
            target.replaceWith(box);
            if ((thread.messages || []).some((m) => m.author === 'agent')) {
              box.insertAdjacentElement('afterend',
                buildOpenThreadElement(thread, false, { skipEnvelope: true }));
            } else {
              box.classList.add('md-await-agent'); // awaiting — pulse like a waiting comment
            }
            continue;
          }
          // Open threads blocked on the user render in full — that is the
          // user's worklist; ones awaiting the agent rest as a line. Resolved
          // ones are held back and emitted below as a single count per block.
          if (isThreadResolved(thread)) {
            const key = (target && getAnchorIdForTarget(target)) || ORPHAN_THREAD_KEY;
            if (!resolvedByBlock.has(key)) resolvedByBlock.set(key, { target, threads: [] });
            resolvedByBlock.get(key).threads.push(thread);
            continue;
          }
          const el = buildOpenThreadElement(thread, !target);
          // Card-on-show is buildOpenThreadElement's own condition: the
          // readback highlight exists exactly when a full card does.
          if (target && (threadNeedsUser(thread) || state.expandedThreads.has(thread.id))) {
            anchorRanges.push(...createThreadAnchorRanges(target, thread));
          }
          if (target) insertCommentFlowElementAfterTarget(target, el);
          else article.appendChild(el);
        }
        // One line per block for everything resolved. Unfolded, the threads
        // themselves render above their count, so the line also folds them back.
        for (const [key, { target, threads: group }] of resolvedByBlock) {
          // A lone resolved thread has no fold to manage: its row IS the
          // thread line — click opens the card, the card folds on click.
          const single = group.length === 1;
          const expanded = single || state.resolvedExpanded.has(key);
          const put = (el) => {
            if (target) insertCommentFlowElementAfterTarget(target, el);
            else article.appendChild(el);
          };
          // Two levels, and expansion costs no extra row: folded is the newest
          // hook alone; unfolded is a line per thread (your opening ask), with
          // the full card only for the one you open.
          const rows = expanded
            ? group.map((thread) => {
              if (!state.expandedThreads.has(thread.id)) return buildResolvedThreadLine(thread);
              if (target) anchorRanges.push(...createThreadAnchorRanges(target, thread));
              return buildThreadCard(thread, !target);
            })
            : [buildResolvedFoldedRow(group)];
          for (const row of rows) row.classList.add('md-resolved-item');
          if (!single) addResolvedFoldControl(rows[0], key, expanded);
          for (const row of rows) put(row);
        }
        resolvedByBlock.clear();
      }
    }
    // The readback rides the same render that shows the cards: open cards mark
    // their quoted text in the doc, everything else clears the mark.
    if (canUseSelectionHighlights()) {
      try {
        if (anchorRanges.length) window.CSS.highlights.set('md-thread-anchor', new window.Highlight(...anchorRanges));
        else window.CSS.highlights.delete('md-thread-anchor');
      } catch { /* decoration only — never block the thread render */ }
    }
    updateBottomSpacer();
    if (sync) syncSecondaryPane();
  }

  function closeThreadReply({ render = true } = {}) {
    if (!state.threadReply) return;
    const { root } = state.threadReply;
    state.threadReply = null;
    try { root.remove(); } catch {}
    if (render) scheduleThreadLayerRender();
  }

  function openThreadReply(card, thread) {
    closeThreadReply({ render: false });
    const composer = createComposer({
      placeholder: 'Reply...',
      rows: 2,
      onCancel: () => closeThreadReply(),
      onInput: () => autoGrowTextarea(composer.textarea),
      actions: [
        { label: 'Discard', onClick: () => closeThreadReply() },
        { label: 'Send', primary: true, onClick: () => submitThreadReply(thread, composer) },
      ],
    });
    composer.textarea.spellcheck = true;
    const holder = document.createElement('div');
    holder.className = 'md-thread-reply';
    holder.appendChild(composer.root);
    card.appendChild(holder);
    state.threadReply = { root: holder, threadId: thread.id, composer };
    composer.focus();
  }

  async function submitThreadReply(thread, composer) {
    if (typeof addMarkdownThreadMessage !== 'function') return;
    const text = composer.textarea.value.trim();
    if (!text || composer.primaryButton.disabled) return;
    composer.primaryButton.disabled = true;
    const doc = state.resolvedPath || state.filePath;
    let allowMissingRunbook = false;
    if (typeof preflightMarkdownRunbook === 'function') {
      const pf = await preflightMarkdownRunbook({ docPath: doc });
      if (pf && pf.canceled) { composer.primaryButton.disabled = false; return; }
      allowMissingRunbook = !!(pf && pf.acked);
    }
    try {
      const result = await addMarkdownThreadMessage({
        docPath: doc,
        threadId: thread.id,
        body: text,
        allowMissingRunbook,
      });
      if (!result || !result.success) {
        if (typeof showToast === 'function') showToast((result && result.error) || 'Could not send reply');
        composer.primaryButton.disabled = false;
        return;
      }
      state.threadReply = null; // its holder vanishes in the re-render
      // Replying reopens the thread to `open` (main.js) with the turn handed
      // back to the agent — the same just-sent state as a fresh comment, so it
      // rests as the waiting line rather than staying expanded.
      state.expandedThreads.delete(thread.id);
      adoptThreadStore(result.data);
      layoutSpread();
      if (typeof showToast === 'function') showToast('Reply sent');
    } catch (error) {
      if (typeof showToast === 'function') {
        showToast(error && error.message ? error.message : 'Could not send reply');
      }
      composer.primaryButton.disabled = false;
    }
  }

  function getAnchorElementsById(id) {
    if (!id || !state.spreadLayout) return [];
    return Array.from(state.spreadLayout.querySelectorAll(`[data-md-anchor-id="${escapeSelectorValue(id)}"]`));
  }

  function findAnchorElementByText(matchText) {
    const needle = String(matchText || '').trim();
    if (!needle || !state.article) return null;
    const normalizedNeedle = needle.replace(/\s+/g, ' ');
    for (const el of state.article.querySelectorAll('[data-md-anchor-id]')) {
      const text = getRenderedText(el).replace(/\s+/g, ' ');
      if (text.includes(normalizedNeedle)) return el;
    }
    return null;
  }

  // matchText quoted from the terminal is raw markdown source — a diff row, a
  // grep hit — so it still carries the syntax the rendered text sheds: ## on
  // headings, ** around emphasis, backticks, list markers. Find the source
  // line it sits on and map that through the anchors; the rendered-text scan
  // above stays for text quoted from rendered prose.
  function findAnchorElementBySourceText(matchText) {
    const needle = String(matchText || '').trim();
    if (!needle || !state.doc || !state.sourceText) return null;
    const lines = state.sourceText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(needle)) continue;
      const anchor = findAnchorForLine(state.doc.anchors, i + 1);
      const el = anchor ? getAnchorElement(anchor) : null;
      if (el) return el;
    }
    return null;
  }

  function landAt({ line, matchText, landingKind } = {}) {
    clearLandingTarget();
    if (!state.doc || !state.article || !state.primaryPane) return;

    // Number(null) and Number('') are 0, which would masquerade as a real
    // line request (lines are 1-based) and trip the "Line 0 not found" toast on
    // a plain file open. Collapse the no-line inputs to NaN so hasLine and the
    // reportLandingResult guard both treat them as "no line requested".
    const requestedLine = (line == null || line === '') ? NaN : Number(line);
    const hasLine = Number.isFinite(requestedLine);
    const requestedText = String(matchText || '').trim();
    const hasMatchText = requestedText.length > 0;

    // Resolve the block to land on, tracking how we got there so we can mirror the
    // IDE navigation feedback (exact / nearest / not found) instead of silently
    // falling back to the top of the document.
    let target = null;
    let resolution = 'none'; // 'exact' | 'nearest' | 'text' | 'first' | 'none'
    const anchor = hasLine ? findAnchorForLine(state.doc.anchors, requestedLine) : null;
    if (anchor) {
      target = getAnchorElement(anchor);
      if (target) {
        resolution = (anchor.startLine <= requestedLine && anchor.endLine >= requestedLine)
          ? 'exact'
          : 'nearest';
      }
    }
    if (!target) {
      const textTarget = findAnchorElementBySourceText(requestedText)
        || findAnchorElementByText(requestedText);
      if (textTarget) { target = textTarget; resolution = 'text'; }
    }
    if (!target) {
      target = state.article.querySelector('[data-md-anchor-id]');
      if (target) resolution = 'first';
    }
    if (!target) {
      // Nothing renderable to land on (e.g. empty document).
      if (hasLine) reportLandingResult('none', requestedLine);
      else if (hasMatchText) showMarkdownTextLandingMiss(requestedText);
      return;
    }

    const anchorId = target.getAttribute('data-md-anchor-id');
    const landedEls = anchorId ? Array.from(getAnchorElementsById(anchorId)) : [target];
    for (const el of landedEls) el.classList.add('md-landing-target');

    const targetTop = target.offsetTop;
    const desiredTop = Math.max(0, targetTop - state.primaryPane.clientHeight * 0.35);
    state.primaryPane.scrollTop = desiredTop;
    state.spreadGridTop = desiredTop; // landing jump re-bases the grid
    syncSecondaryPane();
    // Flash the landed block only when we actually hit a requested target — never
    // on a plain file open (resolution 'first') where there's nothing to point at.
    if (resolution === 'exact' || resolution === 'nearest' || resolution === 'text') {
      applyLandingPulse(landedEls, landingKind);
    }
    reportLandingResult(resolution, requestedLine);
    if (!hasLine && hasMatchText && resolution !== 'text') {
      showMarkdownTextLandingMiss(requestedText);
    }
  }

  // Toast feedback mirroring the IDE jump (showNavigationFeedback): silent on an
  // exact hit, a warning when we could only land near the requested target, an
  // error when the line could not be resolved at all. Plain file opens stay
  // quiet because there is no requested target to miss.
  function reportLandingResult(resolution, requestedLine) {
    if (typeof showToast !== 'function') return;
    if (!Number.isFinite(requestedLine)) return;
    if (resolution === 'exact') return;
    if (resolution === 'nearest' || resolution === 'text') {
      const fallback = resolution === 'text' ? 'showing matched text' : 'showing nearest section';
      showToast(`Line ${requestedLine} not found — ${fallback}`, { variant: 'warn' });
    } else {
      showToast(`Line ${requestedLine} not found`, { variant: 'error' });
    }
  }

  function showMarkdownTextLandingMiss(matchText) {
    if (typeof showToast !== 'function') return;
    const preview = String(matchText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    showToast(preview ? `Text not found in markdown: ${preview}` : 'Text not found in markdown', { variant: 'warn' });
  }

  async function open({ filePath, line, matchText, landingKind } = {}) {
    if (!filePath || typeof readMarkdownFile !== 'function') return false;
    const token = ++state.openToken;
    stopMarkdownAutoRefresh();
    if (state.search.isOpen && typeof closeSearchBar === 'function') {
      closeSearchBar();
    } else {
      closeSearch();
    }
    closeActiveCard();
    clearQueuedMarkdownComments();
    clearActiveTarget();
    clearMarkdownChangeHighlightState();
    closeThreadReply({ render: false });
    state.threadStore = null;
    state.threadStoreSig = '';
    state.threadRenderPending = false;
    state.resumeFullPending = false;
    state.resolvedExpanded = new Set();
    state.editing = null;
    state.blockOverlays = new Map();
    state.expandedHunkKey = null;
    state.pendingClickCaret = null;
    showLoading(filePath);
    if (typeof onOpen === 'function') onOpen(filePath);

    let result;
    try {
      result = await readMarkdownFile(filePath);
    } catch (error) {
      if (token !== state.openToken) return false;
      const message = error && error.message ? error.message : 'Could not load markdown';
      showError(message);
      if (typeof showToast === 'function') showToast(message);
      return false;
    }

    if (token !== state.openToken) return false;
    if (!result || !result.success) {
      const message = (result && result.error) || 'Could not load markdown';
      showError(message);
      if (typeof showToast === 'function') showToast(message);
      return false;
    }

    state.filePath = filePath;
    state.resolvedPath = result.path || filePath;
    state.sourceText = result.content || '';
    state.doc = renderMarkdownDocument(state.sourceText, markdownImageOptions(result));
    state.fileSignature = getMarkdownReadSignature(result);
    state.fileStatSignature = getMarkdownStatSignature(result);
    band.setTitle(state.resolvedPath);
    band.open();
    requestAnimationFrame(() => {
      layoutSpread();
      landAt({ line, matchText, landingKind });
      startMarkdownAutoRefresh(token);
      pollMarkdownThreadStore(token);
    });
    return true;
  }

  // Ctrl/Cmd/Alt — the same modifiers that escalate a clicked URL out of the
  // terminal's embedded viewer and into the browser.
  function isFollowModifier(event) {
    return !!(event && (event.ctrlKey || event.metaKey || event.altKey));
  }

  // Where a clicked link goes. A web URL leaves for the browser; a path opens the
  // file it names, which for another .md is this same viewer showing that doc.
  // Everything else is swallowed — the app shell must never navigate.
  function followLink(link) {
    const target = classifyMarkdownLink(link.getAttribute('href') || '', state.resolvedPath || state.filePath);
    if (target.kind === 'external') {
      if (typeof openURL === 'function') openURL(target.url);
      return;
    }
    if (target.kind !== 'path' || typeof openDocPath !== 'function') return;
    // Opening another doc resets the viewer, and queued comments, an open card and
    // a pending edit batch all belong to the doc they were written against — the
    // same reason a pending batch freezes auto-refresh. Unsent work outranks an
    // incidental click on a link, so say so instead of dropping it.
    if (hasBlockingMarkdownRefreshState()) {
      if (typeof showToast === 'function') showToast('Send or discard your changes to follow that link');
      return;
    }
    openDocPath(target.path);
  }

  function handleArticleClick(event) {
    // The click that ends a virtual drag is the drag's release, not a click.
    if (state.vdragConsumedClick) {
      state.vdragConsumedClick = false;
      event.preventDefault();
      return;
    }
    // A link in the article never navigates on its own: index.html is the whole
    // app, and a browser-style navigation would take the terminal with it. What
    // the click means is decided below.
    const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (link) event.preventDefault();

    if (state.editing) return; // caret moves natively inside the editable block
    // The plain click belongs to the doc, not to the link. Every word here is
    // something to comment on or rewrite, link text included — and arming a block
    // costs nothing (a caret and a hint, cleared by the next click elsewhere)
    // while following a link swaps the doc out or leaves the app. So the cheap
    // reversible act keeps the bare click and the disruptive one takes a
    // modifier, the same ctrl/cmd/alt escalation a clicked URL takes in the
    // terminal. The block hint names it whenever a link is under the caret.
    if (link && isFollowModifier(event)) {
      followLink(link);
      return;
    }

    // Pending marks are the handle for the edit's actions: clicking struck or
    // inserted text expands the strip; any other click folds it back.
    const pendingMark = event.target && event.target.closest
      ? event.target.closest('del.md-pending-del, ins.md-pending-ins')
      : null;
    if (pendingMark) {
      const block = pendingMark.closest('[data-md-hunk-key]');
      if (block) {
        event.preventDefault();
        toggleHunkStrip(block.dataset.mdHunkKey);
        return;
      }
    }
    if (state.expandedHunkKey) {
      state.expandedHunkKey = null;
      clearActiveTarget();
      layoutSpread();
      return; // the click-away folds; the next click acts
    }
    const target = event.target && event.target.closest
      ? event.target.closest('[data-md-anchor-id]')
      : null;
    if (!target || !state.spreadLayout || !state.spreadLayout.contains(target)) return;
    if (state.activeCard && state.activeCard.card.contains(event.target)) return;

    if (getCurrentSelectionContext()) {
      event.preventDefault();
      activateSelectionFromDom();
      return;
    }

    event.preventDefault();
    if (state.activeCard) {
      if (getActiveMarkdownCommentText()) {
        queueActiveMarkdownCommentDraft();
      } else {
        // Click-away commits what's in the box: text queues, empty discards
        // (emptying a reopened draft IS the delete — the mark has no ✕).
        // Esc keeps restore semantics.
        closeActiveCard({ restoreQueuedDraft: false });
        clearActiveTarget();
      }
    }
    // Hold the click position; it materializes as the editor caret on the
    // first editing key (md-editing-design.md). Surface it as a blinking
    // caret so the edit start point is visible before you type.
    state.pendingClickCaret = null;
    try {
      const range = document.caretRangeFromPoint(event.clientX, event.clientY);
      if (range && target.contains(range.startContainer)) {
        state.pendingClickCaret = getTextOffsetWithin(target, range.startContainer, range.startOffset);
      }
    } catch {}
    // Hit-test miss (image, padding edge): the entry default is the block's
    // end, so hold that explicitly and let the caret below show it — an
    // invisible default reads as a caret that could be anywhere.
    if (state.pendingClickCaret == null) {
      state.pendingClickCaret = getSearchableTextNodes(target).text.length;
    }
    setActiveTarget(target, { link });
    showEditCaret(target, state.pendingClickCaret);
  }

  // A blinking caret at the held click position — an empty span (no text, so
  // it never perturbs offsets or search), inserted between text nodes. It
  // lives only while the block is the active target (layoutSpread is guarded
  // on activeTarget, so no re-render wipes it); clears when the target does.
  function showEditCaret(target, offset) {
    clearEditCaret();
    try {
      const at = getTextPositionWithin(target, Math.max(0, offset));
      if (!at || !at.node || at.node.nodeType !== 3) return;
      const caret = document.createElement('span');
      caret.className = 'md-edit-caret';
      caret.setAttribute('contenteditable', 'false');
      caret.setAttribute('aria-hidden', 'true');
      const r = document.createRange();
      r.setStart(at.node, at.offset);
      r.collapse(true);
      r.insertNode(caret);
      state.editCaret = caret;
    } catch {}
  }

  function clearEditCaret() {
    const caret = state.editCaret;
    state.editCaret = null;
    if (!caret) return;
    const host = caret.parentNode;
    try { caret.remove(); } catch {}
    if (host && host.normalize) host.normalize(); // rejoin the split text nodes
  }

  function handlePaneWheelIntent(event) {
    if (!state.activeCard) return;
    if (state.activeCard.card && state.activeCard.card.contains(event.target)) return;
    if (getActiveMarkdownCommentText()) {
      queueActiveMarkdownCommentDraft();
      return;
    }
    closeActiveCard({ restoreQueuedDraft: false });
    clearActiveTarget();
  }

  function setActiveTarget(target, { selection = null, link = null } = {}) {
    if (!target) return;
    clearActiveTarget();
    clearLandingTarget();
    target.classList.add('md-comment-target-active');
    state.activeTarget = target;
    state.activeSelection = selection;
    state.activeTargetPane = selection && selection.pane
      ? selection.pane
      : (isInSecondaryPane(target) ? 'right' : 'left');
    showHint(target, { selection, link });
    updateSelectionHighlights();
    try { state.shell.focus({ preventScroll: true }); } catch {}
  }

  // Clicking link text arms the block like any other text, so the hint is where
  // the link says it is still a link — named only when you actually landed on
  // one, so it never nags on ordinary prose.
  const FOLLOW_HINT = platform === 'darwin' ? ' · ⌘click follows' : ' · ctrl+click follows';

  // The key guide lives in the band's bar (see ensureMounted), one fixed slot
  // for block and selection targets alike — page geometry and page flips
  // cannot take it off screen the way flow or floating chrome could be.
  function showHint(target, { selection = null, link = null } = {}) {
    hideHint();
    if (!state.barHint) return;
    state.barHint.textContent = 'letters comment · other keys edit' + (link ? FOLLOW_HINT : '');
    state.barHint.classList.add('on');
    state.hint = state.barHint;
  }

  function getSectionHierarchyForTarget(target) {
    const line = Number(target && target.getAttribute('data-source-start-line'));
    return getSectionHierarchyForLine(state.doc ? state.doc.headings : [], line);
  }

  function openCommentCard(initialComment = '', {
    queueMode = false,
    queueIndex = null,
    originalQueuedComment = null,
  } = {}) {
    const target = state.activeTarget;
    if (!target || state.activeCard) return false;
    hideHint();

    const card = document.createElement('div');
    card.className = 'md-comment-card';

    // Two exits with different blast radius. Escape backs out of this SESSION:
    // a revisit's original comment survives as its one-line mark. Discard
    // destroys the COMMENT — the typed draft, and on a revisit the queued
    // original too; it is also the only visible way to delete a queued
    // comment. Same grammar as the edit strip: the button destroys, Escape
    // retreats.
    const cancel = () => {
      closeActiveCard({ restoreQueuedDraft: queueMode });
      clearActiveTarget();
    };
    const discard = () => {
      closeActiveCard();
      clearActiveTarget();
    };
    // Enter always sends; queueing happens by moving to another paragraph. The
    // primary flushes everything — this comment plus anything already queued.
    const pendingCount = state.queuedComments.length + state.blockOverlays.size;
    const primaryLabel = pendingCount > 0 ? `Send all (${pendingCount + 1})` : 'Send';
    // Shared composer (comment-ui) — same widget as the review viewer. Placement,
    // queue/draft, autogrow and spread-fit stay md's; only the textarea + buttons
    // come from the shared piece. onInput drives autogrow/fit/footer.
    const composer = createComposer({
      placeholder: 'Comment...',
      seed: initialComment,
      rows: 2,
      onCancel: cancel,
      onInput: () => {
        autoGrowTextarea(composer.textarea);
        syncActiveCommentPlaceholder();
        fitActiveCommentCard();
      },
      actions: [
        { label: 'Discard', onClick: discard },
        { label: primaryLabel, primary: true, onClick: () => submitComment() },
      ],
    });
    composer.textarea.spellcheck = true;
    card.appendChild(composer.root);

    // The composer seats where the reader finished: after the selection's END
    // anchor, in the article of the pane the drag released on — the start may
    // be a page behind, and typing must not jump backward away from the
    // mouseup point. (A live card can sit in either article; a right-page
    // block click has always seated it in the secondary copy.)
    let seatEl = target;
    const seatSelection = state.activeSelection;
    if (seatSelection && (seatSelection.endAnchorId || seatSelection.anchorId)) {
      const article = seatSelection.pane === 'right' ? state.secondaryArticle : state.article;
      const seatId = seatSelection.endAnchorId || seatSelection.anchorId;
      const end = article ? article.querySelector(`[data-md-anchor-id="${seatId}"]`) : null;
      if (end) seatEl = end;
    }
    const placeholder = createCommentPlaceholderForTarget(seatEl);
    insertCommentFlowElementAfterTarget(seatEl, card);
    const activeSelection = originalQueuedComment && isMarkdownSelectionKind(originalQueuedComment.targetKind)
      ? originalQueuedComment
      : state.activeSelection;
    const targetKind = activeSelection && (activeSelection.selectedText || isMarkdownSelectionKind(activeSelection.targetKind))
      ? (isMarkdownSelectionKind(activeSelection.targetKind) ? activeSelection.targetKind : 'selection')
      : 'block';
    state.activeCard = {
      card,
      target,
      placeholder,
      textarea: composer.textarea,
      sendButton: composer.primaryButton,
      pane: state.activeTargetPane || (isInSecondaryPane(target) ? 'right' : 'left'),
      targetKind,
      anchorId: isMarkdownSelectionKind(targetKind) && activeSelection && activeSelection.anchorId
        ? activeSelection.anchorId
        : getAnchorIdForTarget(target),
      endAnchorId: isMarkdownSelectionKind(targetKind) && activeSelection && activeSelection.endAnchorId
        ? activeSelection.endAnchorId
        : (isMarkdownSelectionKind(targetKind) && activeSelection && activeSelection.anchorId
          ? activeSelection.anchorId
          : getAnchorIdForTarget(target)),
      selectedText: isMarkdownSelectionKind(targetKind) ? String(activeSelection.selectedText || '') : '',
      selectionStart: isMarkdownSelectionKind(targetKind) && Number.isFinite(activeSelection.selectionStart)
        ? activeSelection.selectionStart
        : 0,
      selectionEnd: isMarkdownSelectionKind(targetKind) && Number.isFinite(activeSelection.selectionEnd)
        ? activeSelection.selectionEnd
        : (
          isMarkdownSelectionKind(targetKind)
            ? (Number.isFinite(activeSelection.selectionStart) ? activeSelection.selectionStart : 0) + String(activeSelection.selectedText || '').length
            : 0
        ),
      queueMode,
      queueIndex,
      originalQueuedComment,
    };
    updateSelectionHighlights();

    autoGrowTextarea(composer.textarea);
    syncActiveCommentPlaceholder();
    fitActiveCommentCard();
    composer.focus();
    return true;
  }

  function openQueuedMarkdownCommentForEdit(comment) {
    if (!comment || !comment.target) return false;

    if (getActiveMarkdownCommentText()) {
      queueActiveMarkdownCommentDraft();
    } else if (state.activeCard) {
      closeActiveCard({ restoreQueuedDraft: !!state.activeCard.queueMode });
      clearActiveTarget();
    }

    const queueIndex = state.queuedComments.indexOf(comment);
    if (queueIndex === -1) return false;

    state.queuedComments.splice(queueIndex, 1);
    removeQueuedMarkdownCommentCard(comment);

    clearActiveTarget();
    clearLandingTarget();
    comment.target.classList.add('md-comment-target-active');
    state.activeTarget = comment.target;
    state.activeTargetPane = comment.pane || (isInSecondaryPane(comment.target) ? 'right' : 'left');
    state.activeSelection = isMarkdownSelectionKind(comment.targetKind) ? comment : null;
    return openCommentCard(comment.comment, {
      queueMode: true,
      queueIndex,
      originalQueuedComment: comment,
    });
  }

  // One send: the composer's Enter, the pill, and ⌘↩ are the same action —
  // everything pending (edit hunks with notes + comment drafts, the active
  // composer's text included) hands off as one turn.
  async function submitComment() {
    if (!state.activeCard) return;
    const { textarea, sendButton } = state.activeCard;
    if (sendButton.disabled) return;
    if (!textarea.value.trim() && !state.queuedComments.length && state.blockOverlays.size === 0) return;
    sendButton.disabled = true; // also guards against a double Enter
    const sent = await sendEditBatch();
    if (!sent && state.activeCard) sendButton.disabled = false; // failed; still open
  }

  function handleDocumentKeydown(event) {
    if (!state.shell || !band.isOpen()) return;
    // An open modal (viewer selector, path chooser, session picker) sits above
    // the viewer and owns the keyboard.
    if (document.querySelector('.at-modal-overlay')) return;
    if (isFindShortcut(event, platform)) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      if (typeof openSearchBar === 'function') openSearchBar('markdown');
      return;
    }
    const searchBarTarget = event.target && event.target.closest
      ? event.target.closest('#search-bar')
      : null;
    const currentSearchState = typeof getSearchState === 'function' ? getSearchState() : null;
    if (
      !searchBarTarget
      && event.key === 'Escape'
      && currentSearchState
      && currentSearchState.isOpen
      && currentSearchState.scope === 'markdown'
      && typeof closeSearchBar === 'function'
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      closeSearchBar();
      return;
    }
    // A composer whose DOM was ripped by a re-render must not keep the
    // keyboard hostage — heal the state instead of swallowing every key.
    if (state.threadReply && state.threadReply.root && !state.threadReply.root.isConnected) {
      closeThreadReply({ render: false });
    }
    if (state.activeCard && state.activeCard.card && !state.activeCard.card.isConnected) {
      closeActiveCard();
      clearActiveTarget();
    }
    if (event.key === 'Escape' && state.vdrag) {
      event.preventDefault();
      cancelVdrag();
      return;
    }
    // ⌘/Ctrl+C with an armed selection record: the native clipboard cannot
    // see a document-space selection (a cross-page record has no live DOM
    // range), so copy its text. A live native selection (double-click) and
    // any focused field keep the native copy.
    if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'c'
      && state.activeSelection && state.activeSelection.selectedText
      && state.shell && state.shell.contains(event.target)
      && isTypingTarget(event.target)) {
      const native = window.getSelection && window.getSelection();
      if (!native || native.isCollapsed) {
        event.preventDefault();
        try { navigator.clipboard.writeText(state.activeSelection.selectedText); } catch {}
        return;
      }
    }
    if (event.key === 'Escape' && state.threadReply) {
      event.preventDefault();
      closeThreadReply();
      return;
    }
    // An open reply composer owns the keyboard (like activeCard below) — flips
    // and comment dispatch must not fire under a typing reply.
    if (state.threadReply) return;
    // The card's own composer consumes Esc when focused; this rung catches a
    // card the keyboard can no longer reach, so Esc always has an exit.
    if (event.key === 'Escape' && state.activeCard) {
      event.preventDefault();
      closeActiveCard({ restoreQueuedDraft: !!state.activeCard.queueMode });
      clearActiveTarget();
      return;
    }
    if (state.activeCard) return;
    if (event.key === 'Escape' && state.activeTarget) {
      event.preventDefault();
      clearActiveTarget();
      return;
    }
    // Esc cancels the innermost active thing: an open editor reverts before
    // the band may hide.
    if (event.key === 'Escape' && state.editing) {
      event.preventDefault();
      revertBlockEditor();
      return;
    }
    // Nothing else consumed Esc → roll the band up (escToHide:false on the band,
    // so md owns this, after letting a card/target cancel first).
    if (event.key === 'Escape') {
      event.preventDefault();
      band.hide();
      return;
    }
    // Cmd/Ctrl+Enter ends the user's turn: commit any open editor, then hand
    // the batch off (write + threads + pointer). Empty batch = no-op.
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      if (state.editing || state.blockOverlays.size > 0) {
        event.preventDefault();
        if (state.editing) commitBlockEditor();
        sendEditBatch();
        return;
      }
    }
    // An open block editor owns the keyboard on its own surface: Enter sends
    // (like a comment and like ⌘↩ — the common finishing keystroke), and
    // Shift+Enter breaks the line in any block (the chat-input split; a
    // first-key Enter on a targeted block also breaks, via the entry path).
    // Rich-text shortcuts are swallowed (they would inject markup into the
    // document). Keys typed in the edit's note composer fall through to it —
    // it owns Enter (send) and Shift+Enter (newline) itself.
    if (state.editing) {
      const surface = state.editing.el;
      if (!surface || !surface.isConnected) {
        // The editing surface was detached by a re-render (no blur fires
        // for removed elements) — commit what was typed and release the lock.
        commitBlockEditor();
      } else {
        const inSurface = event.target === surface
          || !!(surface.contains && surface.contains(event.target));
        if (inSurface && event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          commitBlockEditor();
          sendEditBatch();
        } else if (inSurface && event.key === 'Enter' && event.shiftKey) {
          event.preventDefault();
          insertLineBreakInBlock();
        } else if (inSurface && (event.metaKey || event.ctrlKey) && !event.altKey
          && /^[zy]$/i.test(String(event.key))) {
          // ⌘/Ctrl+Z steps the session history back one action; Shift (or
          // Ctrl+Y) steps forward. The note composer keeps native undo —
          // this rung only fires with the caret on the surface.
          event.preventDefault();
          undoEditingStep(event.shiftKey || String(event.key).toLowerCase() === 'y');
        } else if (inSurface && (event.metaKey || event.ctrlKey) && /^[biu]$/i.test(event.key)) {
          event.preventDefault();
        }
        return;
      }
    }
    // Page-flip keys — focus must be inside the md band, so the terminal
    // keeps its own PageUp/arrows, and a composer field in the band keeps its
    // own Space/arrows too — otherwise Space page-flips instead of typing (it
    // silently ate spaces in the note/reply composers). A click hands
    // Space/arrows to the dispatch below, but PageUp/PageDown never belong to
    // a target: they keep flipping while one is armed — the caret is logical,
    // it survives the page move, and the bar guide stays up to say so.
    const flipTarget = event.target;
    const inBandField = !!flipTarget && (flipTarget.isContentEditable
      || /^(INPUT|TEXTAREA|SELECT)$/.test(flipTarget.tagName || ''));
    const pageOnlyKey = event.key === 'PageDown' || event.key === 'PageUp';
    if ((!state.activeTarget || pageOnlyKey) && state.shell.contains(flipTarget) && !inBandField) {
      const forward = event.key === 'PageDown' || event.key === 'ArrowDown'
        || (event.key === ' ' && !event.shiftKey);
      const backward = event.key === 'PageUp' || event.key === 'ArrowUp'
        || (event.key === ' ' && event.shiftKey);
      if (forward || backward) {
        event.preventDefault();
        flipSpread(forward ? 1 : -1);
        return;
      }
    }
    // Comment/edit dispatch only fires on a clicked target with its hint up,
    // and only from a typing surface — without these guards every printable
    // key in the app gets eaten while the band is open (shipped once via a
    // debug-log strip; pinned by a test now).
    if (!state.activeTarget || !state.hint) return;
    if (!isTypingTarget(event.target)) return;
    const paste = isPasteCommentShortcut(event);
    if (paste || isCommentEntryKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      if (paste) {
        // Seed the card with the clipboard; activeTarget is viewer state, so it
        // survives the async read.
        navigator.clipboard.readText().catch(() => '').then((text) => {
          openCommentCard(text || '');
        });
        return;
      }
      openCommentCard(event.key);
      return;
    }
    if (isEditEntryKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      openBlockEditor(state.activeTarget, event);
    }
  }

  return {
    close,
    closeSearch,
    getSearchSelectionText,
    hide: () => band.hide(),
    isOpen,
    // Visible on screen — narrower than isOpen(), which also counts the rolled-up
    // band (ownership for mutual exclusion). Search scope keys off this.
    isVisible: () => band.isOpen(),
    navigateSearch,
    open,
    openSearch,
    runSearch,
    toggle: () => band.toggle(),
    toggleFullSize: () => band.toggleFullSize(),
  };
}

module.exports = {
  createMarkdownViewer,
  findMarkdownSearchRanges,
  isPlainCommentKey,
};
