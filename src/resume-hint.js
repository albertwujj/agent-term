// Resume-hint — small renderer overlay shown after the user picks a past
// session in the agent-term picker. Two responsibilities:
//
//   1. Tell the user how to launch /resume in the CLI (until they do).
//      Initial wording:
//        "↻ Press Enter to /resume → filter for the prompt above, or try "<title>""
//      Main.js's pty-input handler is armed (pendingResumeIntercept) and
//      will replace the user's first plain Enter with a timed /resume
//      submission. The user provides the timing — they wait for the CLI's
//      input prompt to appear, then press Enter once.
//
//   2. Tell the user what to type as the filter in the CLI's resume
//      dialog (post-Enter wording drops only the Enter instruction).
//      The prompt is visible in the chrome line immediately above this
//      hint. Some CLIs also surface their own title in resume UI, so when
//      we have a distinct title we show it as an alternate search term.
//
// Lifecycle:
//   show({ cli, prompt, title })      — mount the overlay in pre-Enter state
//   1st submit                        — transition to post-Enter state
//                                       (drop the "Press Enter to /resume" part)
//   3rd submit                        — dismiss (1st = our /resume submission,
//                                       2nd = user picks a session in the CLI
//                                       list, 3rd = first new prompt — at that
//                                       point the hint has served its purpose)
//   click ✕ / destroy()              — explicit dismiss; also notifies main
//                                       to cancel the pendingResumeIntercept
//                                       flag so the next Enter isn't swallowed
//                                       into a /resume.

const { aiTitleDedupeKey, cleanAiTitle } = require('./ai-title');

const HINT_HEIGHT_PX = 32;
const AUTO_DISMISS_ENTERS = 3;

let mountedRoot = null;
let stylesInjected = false;
let enterCount = 0;

const HINT_CSS = `
.at-resume-hint {
  position: fixed;
  top: calc(env(titlebar-area-height, 42px) + 1px);  /* just below the chrome bar's hue divider */
  left: 0;
  right: 0;
  height: ${HINT_HEIGHT_PX}px;
  z-index: 8900;
  display: flex;
  align-items: center;
  padding: 0 14px;
  gap: 8px;
  background: #14171c;
  border-bottom: 1px solid #1c1c1c;
  font: 13px "Segoe UI", "Segoe UI Variable", system-ui, sans-serif;
  color: #d0d0d0;
  user-select: none;
}
.at-resume-hint-icon {
  flex: 0 0 auto;
  font-size: 14px;
  color: #a0c8ff;
  line-height: 1;
}
/* Pre-Enter wording shown by default; hidden after the first submit via
   the .post-enter class on the host. */
.at-resume-hint-pre {
  flex: 0 0 auto;
  color: #d0d0d0;
}
.at-resume-hint-pre kbd {
  display: inline-block;
  padding: 1px 6px;
  margin: 0 2px;
  font: inherit;
  font-size: 12px;
  background: #232830;
  border: 1px solid #2f3540;
  border-radius: 3px;
  color: #e6e6e6;
}
.at-resume-hint-pre code {
  font-family: "Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace;
  font-size: 12px;
  color: #e6e6e6;
}
.at-resume-hint-pre .arrow {
  margin: 0 4px;
  color: #707070;
}
/* Post-Enter wording (hidden by default; shown after the first submit). */
.at-resume-hint-label {
  flex: 0 0 auto;
  color: #909090;
  display: none;
}
.at-resume-hint.post-enter .at-resume-hint-pre { display: none; }
.at-resume-hint.post-enter .at-resume-hint-label { display: inline; }
.at-resume-hint-primary {
  flex: 0 0 auto;
  color: #e6e6e6;
}
.at-resume-hint-extra {
  flex: 0 0 auto;
  color: #909090;
}
.at-resume-hint-spacer {
  flex: 1 1 auto;
  min-width: 0;
}
.at-resume-hint-title {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #e6e6e6;
  font-family: "Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace;
  font-size: 12px;
}
.at-resume-hint-close {
  flex: 0 0 auto;
  background: none;
  border: none;
  color: #909090;
  cursor: pointer;
  font-size: 14px;
  padding: 2px 8px;
  border-radius: 3px;
  line-height: 1;
}
.at-resume-hint-close:hover {
  background: rgba(255,255,255,0.06);
  color: #d0d0d0;
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
  if (enterCount === 1) {
    mountedRoot.classList.add('post-enter');
  }
  if (enterCount >= AUTO_DISMISS_ENTERS) destroy({ cancelIntercept: false });
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

  if (hasPrompt) {
    return {
      primary: 'the prompt above',
      title: hasDistinctTitle ? title : '',
    };
  }
  return {
    primary: '',
    title: title || '(this session)',
  };
}

// Pure helper that returns the hint's inner HTML for a given title/prompt.
// Used by the preview script and ensureMounted; production also re-uses
// it via show().
function renderHintMarkup(input) {
  const parts = hintParts(input);
  const primary = parts.primary
    ? `<span class="at-resume-hint-primary">${escapeHtml(parts.primary)}</span>`
    : '';
  const extra = parts.primary && parts.title
    ? '<span class="at-resume-hint-extra">, or try</span>'
    : '';
  const title = parts.title
    ? `<span class="at-resume-hint-title" title="${escapeHtml(parts.title)}">${escapeHtml(parts.title)}</span>`
    : '';
  const spacer = parts.title ? '' : '<span class="at-resume-hint-spacer"></span>';
  return `
    <span class="at-resume-hint-icon">↻</span>
    <span class="at-resume-hint-pre">Press <kbd>Enter</kbd> to send <code>/resume</code><span class="arrow">→</span>filter for</span>
    <span class="at-resume-hint-label">Filter for</span>
    ${primary}
    ${extra}
    ${title}
    ${spacer}
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
  show,
  destroy,
};
