// Resume-hint — renderer band shown after the user picks a past session
// in the agent-term picker. It carries one instruction per moment, in
// label form rather than sentences: the terminal below is full of prose,
// so the band keeps to a few words around one object (the Enter keycap
// before the shortcut fires, the title chip after), with segments split
// by a middle dot.
//
//   pre-Enter      "Wait for the input box · [Enter] sends /resume"
//                  Main's pty-input handler is armed (pendingResumeIntercept)
//                  and replaces the user's first plain Enter with a timed
//                  /resume submission. The user supplies the timing: CLI boot
//                  length is unknowable from outside, and an upgrade or trust
//                  dialog may sit in front of the input box, so the human is
//                  the only reliable "ready now" signal. The wording says
//                  when, because timing is the user's job.
//   post-Enter     "Filter for [<title>]"
//                  Shown once the intercept fired and the CLI's resume dialog
//                  is on screen. The CLI's own title, as a chip: resume UIs
//                  surface it, and the title feed is reliable. "Filter for
//                  the prompt above" (the chrome line directly above) is the
//                  strict fallback when the title is missing or is just the
//                  prompt itself.
//   intercept-off  "Type /resume once the input box is up · then filter for
//                  [<title>]"
//                  Main cancels the intercept on any non-Enter input (the
//                  user answered a startup dialog with arrows or y, or is
//                  typing their own command). Enter is plain again, so the
//                  band stops promising the shortcut and carries the full
//                  guidance instead.
//
// The band is sized and coloured to be noticed on first sight: 44px tall,
// 15px type, tinted with a fixed guidance blue behind a left accent bar so
// it reads as a message rather than chrome, slides in once, and the Enter
// key carries a slow pulse until it is pressed. One typeface, one object
// per state, one bold. The accent is deliberately NOT the session hue:
// colour on a message surface encodes role, and identity already lives on
// the divider and taskbar icon. A fixed accent keeps the band the same
// recognisable object across sessions and free of the accidental
// error/success/warning reads a random hue lands on; it also joins the
// app's colour grammar (hue = identity, amber = warn, green = ok,
// this blue = guidance).
//
// Lifecycle:
//   show({ cli, prompt, title })      — mount in the pre-Enter state
//   recordInterceptOff()              — main cancelled the intercept; switch
//                                       to the intercept-off wording
//   1st submit                        — pre-Enter → post-Enter (intercept-off
//                                       keeps its wording: its submits are
//                                       indistinguishable from dialog answers)
//   2nd submit                        — the pick in the CLI's resume list: the
//                                       flow is done in the normal case, so the
//                                       band collapses to a thin strip. Hover
//                                       re-opens it — the 2nd Enter isn't
//                                       provably the pick (it may have answered
//                                       a dialog), so the guidance stays
//                                       recoverable until the flow provably
//                                       ended.
//   3rd submit                        — first new prompt: dismiss
//   click ✕ / destroy()              — explicit dismiss; also tells main to
//                                       drop pendingResumeIntercept so the
//                                       next Enter isn't swallowed into a
//                                       /resume.

const { aiTitleDedupeKey, cleanAiTitle } = require('./ai-title');

const HINT_HEIGHT_PX = 44;
const COLLAPSED_HEIGHT_PX = 7;
const COLLAPSE_ENTERS = 2;
const AUTO_DISMISS_ENTERS = 3;

let mountedRoot = null;
let stylesInjected = false;
let enterCount = 0;

const HINT_CSS = `
.at-resume-hint {
  --at-resume-accent: #a0c8ff;
  position: fixed;
  top: calc(env(titlebar-area-height, 42px) + 1px);  /* just below the chrome bar's hue divider */
  left: 0;
  right: 0;
  height: ${HINT_HEIGHT_PX}px;
  z-index: 8900;
  display: flex;
  align-items: center;
  padding: 0 12px 0 20px;
  gap: 8px;
  box-sizing: border-box;
  /* Guidance accent at low strength: stands apart from the near-black
     chrome above and terminal below, and stays the same in every session
     (the divider above keeps the identity hue). */
  background: color-mix(in srgb, var(--at-resume-accent) 14%, #0c0c0c);
  border-bottom: 1px solid color-mix(in srgb, var(--at-resume-accent) 35%, #0c0c0c);
  box-shadow: inset 4px 0 0 var(--at-resume-accent);
  font: 15px/20px "Segoe UI", "Segoe UI Variable", system-ui, sans-serif;
  color: #c8c8c8;
  user-select: none;
  animation: at-resume-hint-in 240ms ease-out;
}
@keyframes at-resume-hint-in {
  from { transform: translateY(-100%); opacity: 0; }
  to   { transform: none; opacity: 1; }
}
/* The wording is a row: the state's words, then (after Enter) the title
   chip or the prompt reference. Baseline alignment keeps the words and
   the chip on one line; the chip ellipsizes on its own so its border
   stays closed, and the row as a whole centres in the band. */
.at-resume-hint-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 5px;
  white-space: nowrap;
  overflow: hidden;
}
.at-resume-hint-text > * { flex: 0 0 auto; }
.at-resume-hint .sep {
  color: #707070;
  margin: 0 7px;
}
/* One wording per state. Pre-Enter shows by default; .post-enter and
   .intercept-off on the host swap it for theirs. The tail (chip or prompt
   reference) belongs to the two later states only. */
.at-resume-hint-pre {
  color: #c8c8c8;
}
.at-resume-hint-manual,
.at-resume-hint-tail {
  display: none;
}
.at-resume-hint-pre kbd {
  display: inline-block;
  padding: 1px 10px 2px;
  margin: 0 6px;   /* clears the pulse ring so the word-spaces stay visible */
  font: inherit;
  font-weight: 600;
  line-height: 20px;
  background: #262c36;
  border: 1px solid #3c4452;
  border-bottom-width: 2px;
  border-radius: 5px;
  color: #ffffff;
  animation: at-resume-hint-key 2s ease-in-out infinite;
}
/* A slow ring on the one key being asked for; ends with the pre-Enter
   wording, so it never outlives the request. */
@keyframes at-resume-hint-key {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--at-resume-accent) 0%, transparent); }
  45%      { box-shadow: 0 0 0 4px color-mix(in srgb, var(--at-resume-accent) 55%, transparent); }
}
.at-resume-hint-label {
  color: #c8c8c8;
  display: none;
}
.at-resume-hint.post-enter .at-resume-hint-pre { display: none; }
.at-resume-hint.post-enter .at-resume-hint-label,
.at-resume-hint.post-enter .at-resume-hint-tail { display: inline-block; }
.at-resume-hint.intercept-off .at-resume-hint-pre,
.at-resume-hint.intercept-off .at-resume-hint-label { display: none; }
.at-resume-hint.intercept-off .at-resume-hint-manual,
.at-resume-hint.intercept-off .at-resume-hint-tail { display: inline-block; }
.at-resume-hint-lead {
  color: #ffffff;
  font-weight: 600;
}
/* The title as an object: the thing to type, bounded like the keycap. */
.at-resume-hint-chip {
  flex: 0 1 auto !important;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 1px 10px 2px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--at-resume-accent) 18%, #0c0c0c);
  border: 1px solid color-mix(in srgb, var(--at-resume-accent) 45%, #0c0c0c);
  color: #ffffff;
  font-weight: 600;
  line-height: 20px;
}
.at-resume-hint-close {
  flex: 0 0 auto;
  background: none;
  border: none;
  color: #909090;
  cursor: pointer;
  font-size: 16px;
  padding: 4px 10px;
  border-radius: 4px;
  line-height: 1;
}
.at-resume-hint-close:hover {
  background: rgba(255,255,255,0.08);
  color: #e6e6e6;
}
/* Collapsed: after the 2nd submit (the pick in the CLI's list) the flow
   is done in the normal case — the band recedes to a thin strip so it
   stops occluding the conversation, but stays recoverable by hover in
   case that Enter wasn't actually the pick. */
.at-resume-hint.collapsed {
  height: ${COLLAPSED_HEIGHT_PX}px;
  overflow: hidden;
  cursor: pointer;
  transition: height 160ms ease;
}
.at-resume-hint.collapsed .at-resume-hint-text,
.at-resume-hint.collapsed .at-resume-hint-close {
  opacity: 0;
  transition: opacity 120ms ease;
}
.at-resume-hint.collapsed:hover {
  height: ${HINT_HEIGHT_PX}px;
}
.at-resume-hint.collapsed:hover .at-resume-hint-text,
.at-resume-hint.collapsed:hover .at-resume-hint-close {
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .at-resume-hint, .at-resume-hint-pre kbd { animation: none; }
  .at-resume-hint.collapsed,
  .at-resume-hint.collapsed .at-resume-hint-text,
  .at-resume-hint.collapsed .at-resume-hint-close { transition: none; }
}
`;

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = HINT_CSS;
  document.head.appendChild(style);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function normalizeHintCompare(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Dismiss + notify main to cancel the resume intercept so the next Enter
// isn't accidentally swallowed into a /resume after the user explicitly
// dismissed the hint.
function destroy({ cancelIntercept = true } = {}) {
  if (mountedRoot) {
    try { mountedRoot.remove(); } catch {}
    mountedRoot = null;
  }
  enterCount = 0;
  if (cancelIntercept) {
    try { if (window.pty && window.pty.cancelResumeIntercept) window.pty.cancelResumeIntercept(); } catch {}
  }
}

// Main owns the PTY writes, including local terminal input, the resume
// intercept, and remote/stream submissions. Count its semantic submit event
// instead of xterm key events so every path that advances the AI CLI is seen.
function recordSubmit() {
  if (!mountedRoot) return;
  enterCount += 1;
  if (enterCount === 1 && !mountedRoot.classList.contains('intercept-off')) {
    mountedRoot.classList.add('post-enter');
  }
  if (enterCount === COLLAPSE_ENTERS) mountedRoot.classList.add('collapsed');
  if (enterCount >= AUTO_DISMISS_ENTERS) destroy({ cancelIntercept: false });
}

// Main cancelled the intercept on non-Enter input before it fired: the
// next Enter is plain, so the band stops promising the shortcut. Only
// reachable before the first submit (main cancels only while armed).
function recordInterceptOff() {
  if (!mountedRoot || mountedRoot.classList.contains('post-enter')) return;
  mountedRoot.classList.add('intercept-off');
}

function hintParts(input) {
  const opts = (input && typeof input === 'object') ? input : { title: input };
  const prompt = String(opts.prompt || '').trim();
  const rawTitle = String(opts.title || '').trim();
  const title = cleanAiTitle(rawTitle, opts.cli);
  const hasPrompt = !!prompt;
  const promptKey = aiTitleDedupeKey(prompt, opts.cli) || normalizeHintCompare(prompt);
  const titleKey = aiTitleDedupeKey(title, opts.cli) || normalizeHintCompare(title);
  const hasDistinctTitle = !!title && titleKey !== promptKey;

  // Title leads; a title that is just the prompt adds nothing, so the
  // prompt reference stands in then. promptRef says whether "the prompt
  // above" is available as the fallback.
  return {
    title: hasDistinctTitle ? title : '',
    promptRef: hasPrompt,
  };
}

// Pure helper that returns the hint's inner HTML for a given title/prompt.
// Used by the preview script and ensureMounted; production also re-uses
// it via show().
function renderHintMarkup(input) {
  const parts = hintParts(input);
  // The tail is the one thing to remember: the title as a chip, else the
  // prompt above, else (callers with no context at all) the session itself.
  const tail = parts.title
    ? `<span class="at-resume-hint-tail at-resume-hint-chip" title="${escapeHtml(parts.title)}">${escapeHtml(parts.title)}</span>`
    : `<span class="at-resume-hint-tail at-resume-hint-lead">${parts.promptRef ? 'the prompt above' : 'this session'}</span>`;
  const sep = '<span class="sep">·</span>';
  return `
    <span class="at-resume-hint-text"><span class="at-resume-hint-pre">Wait for the input box${sep}<kbd>Enter</kbd> sends /resume</span><span class="at-resume-hint-manual">Type /resume once the input box is up${sep}then filter for</span><span class="at-resume-hint-label">Filter for</span>${tail}</span>
    <button class="at-resume-hint-close" aria-label="Dismiss" title="Dismiss">✕</button>
  `;

}

// Mount the hint. payload: { cli, prompt, title }
function show({ cli, prompt, title } = {}) {
  destroy({ cancelIntercept: false });   // clear any prior mount; don't double-cancel
  injectStyles();
  enterCount = 0;
  const el = document.createElement('div');
  el.className = 'at-resume-hint';
  el.innerHTML = renderHintMarkup({ cli, prompt, title });
  document.body.appendChild(el);
  el.querySelector('.at-resume-hint-close').addEventListener('click', () => destroy());
  mountedRoot = el;
}

module.exports = {
  HINT_HEIGHT_PX,
  HINT_CSS,
  AUTO_DISMISS_ENTERS,
  renderHintMarkup,
  recordSubmit,
  recordInterceptOff,
  show,
  destroy,
};
