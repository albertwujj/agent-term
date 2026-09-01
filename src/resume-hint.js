// Resume-hint — renderer band shown after the user picks a past session
// in the agent-term picker. It carries one instruction per moment:
//
//   pre-Enter      "When the input box appears, press Enter to send /resume."
//                  Main's pty-input handler is armed (pendingResumeIntercept)
//                  and replaces the user's first plain Enter with a timed
//                  /resume submission. The user supplies the timing: CLI boot
//                  length is unknowable from outside, and an upgrade or trust
//                  dialog may sit in front of the input box, so the human is
//                  the only reliable "ready now" signal. The wording says
//                  when, because timing is the user's job.
//   post-Enter     "Filter for "<title>", or try the prompt above"
//                  Shown once the intercept fired and the CLI's resume dialog
//                  is on screen. The CLI's own title leads: resume UIs surface
//                  it, and the title feed is reliable. The prompt in the
//                  chrome line directly above is the fallback when the title
//                  is missing or is just the prompt itself, and the alternate
//                  search term when both exist.
//   intercept-off  "Type /resume when the input box appears, then filter for
//                  "<title>", or try the prompt above"
//                  Main cancels the intercept on any non-Enter input (the
//                  user answered a startup dialog with arrows or y, or is
//                  typing their own command). Enter is plain again, so the
//                  band stops promising the shortcut and carries the full
//                  guidance instead.
//
// The band is sized and coloured to be noticed on first sight: 44px tall,
// 15px type, tinted with the session hue behind a left accent bar so it
// reads as a message rather than chrome, slides in once, and the Enter key
// carries a slow pulse until it is pressed. One typeface; the keycap is the
// only object, the phrase to remember is the only bold, and the alternate
// title is quoted.
//
// Lifecycle:
//   show({ cli, prompt, title })      — mount in the pre-Enter state
//   recordInterceptOff()              — main cancelled the intercept; switch
//                                       to the intercept-off wording
//   1st submit                        — pre-Enter → post-Enter (intercept-off
//                                       keeps its wording: its submits are
//                                       indistinguishable from dialog answers)
//   3rd submit                        — dismiss (1st = /resume, 2nd = pick in
//                                       the CLI list, 3rd = first new prompt)
//   click ✕ / destroy()              — explicit dismiss; also tells main to
//                                       drop pendingResumeIntercept so the
//                                       next Enter isn't swallowed into a
//                                       /resume.

const { aiTitleDedupeKey, cleanAiTitle } = require('./ai-title');

const HINT_HEIGHT_PX = 44;
const AUTO_DISMISS_ENTERS = 3;

let mountedRoot = null;
let stylesInjected = false;
let enterCount = 0;

const HINT_CSS = `
.at-resume-hint {
  --at-resume-accent: var(--at-hue, #a0c8ff);
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
  /* Session hue at low strength: the divider's colour bleeds into the
     band, so it belongs to this session yet stands apart from the
     near-black chrome above and terminal below. */
  background: color-mix(in srgb, var(--at-resume-accent) 14%, #0c0c0c);
  border-bottom: 1px solid color-mix(in srgb, var(--at-resume-accent) 35%, #0c0c0c);
  box-shadow: inset 4px 0 0 var(--at-resume-accent);
  font: 15px/20px "Segoe UI", "Segoe UI Variable", system-ui, sans-serif;
  color: #c8c8c8;
  user-select: none;
  transition: background 300ms ease, border-color 300ms ease, box-shadow 300ms ease;
  animation: at-resume-hint-in 240ms ease-out;
}
@keyframes at-resume-hint-in {
  from { transform: translateY(-100%); opacity: 0; }
  to   { transform: none; opacity: 1; }
}
/* All wording is one inline run: sans, mono and the keycap share a
   baseline by inline-flow rules, and the run centres in the band as a
   whole. The run ellipsizes at the ✕. */
.at-resume-hint-text {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* One wording per state. Pre-Enter shows by default; .post-enter and
   .intercept-off on the host swap it for theirs. The filter tail belongs
   to the two later states only. */
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
.at-resume-hint.post-enter .at-resume-hint-tail { display: inline; }
.at-resume-hint.intercept-off .at-resume-hint-pre,
.at-resume-hint.intercept-off .at-resume-hint-label { display: none; }
.at-resume-hint.intercept-off .at-resume-hint-manual,
.at-resume-hint.intercept-off .at-resume-hint-tail { display: inline; }
.at-resume-hint-lead {
  color: #ffffff;
  font-weight: 600;
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
@media (prefers-reduced-motion: reduce) {
  .at-resume-hint, .at-resume-hint-pre kbd { animation: none; }
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

  // Title leads; a title that is just the prompt adds nothing, so only the
  // prompt reference is shown then. promptRef says whether "the prompt
  // above" is available as the fallback or the alternate.
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
  const title = parts.title
    ? `“<span class="at-resume-hint-title" title="${escapeHtml(parts.title)}">${escapeHtml(parts.title)}</span>”`
    : '';
  const prompt = parts.promptRef
    ? '<span class="at-resume-hint-prompt">the prompt above</span>'
    : '';
  // The lead is the one thing to remember: the title, else the prompt
  // above, else (callers with no context at all) the session itself.
  const lead = `<span class="at-resume-hint-lead">${title || prompt || 'this session'}</span>`;
  const alt = title && prompt
    ? `<span class="at-resume-hint-extra">, or try</span> ${prompt}`
    : '';
  return `
    <span class="at-resume-hint-text"><span class="at-resume-hint-pre">When the input box appears, press <kbd>Enter</kbd> to send /resume.</span><span class="at-resume-hint-manual">Type /resume when the input box appears, then filter for </span><span class="at-resume-hint-label">Filter for </span><span class="at-resume-hint-tail">${lead}${alt}</span></span>
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
