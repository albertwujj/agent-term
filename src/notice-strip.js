// Notice strip — a short heads-up in the resume band's visual language: a
// dark surface, an accent bar at the left, the UI's sans type, and a ✕ at
// the right of the same line. Amber, where the band's blue is guidance: it
// explains what happened rather than asking for a step. Two uses:
//
//   noticeElement(message)   a note row the resume band hangs under itself
//                            (resume-hint.js), so it arrives and leaves with
//                            the band
//   showNotice(message, { top })
//                            a standalone strip across the window, for a
//                            notice with no band to belong to
//
// The ✕ removes the notice alone.

const NOTICE_CSS = `
.at-notice {
  --at-notice-accent: #d7ba7d;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 6px 12px 6px 20px;
  box-sizing: border-box;
  background: color-mix(in srgb, var(--at-notice-accent) 13%, #0c0c0c);
  border-bottom: 1px solid color-mix(in srgb, var(--at-notice-accent) 30%, #0c0c0c);
  box-shadow: inset 4px 0 0 var(--at-notice-accent);
  font: 14px/20px "Segoe UI", "Segoe UI Variable", system-ui, sans-serif;
  color: #ddd5c3;
  user-select: none;
}
.at-notice-standalone {
  position: fixed;
  left: 0;
  right: 0;
  z-index: 8950;   /* over the bands that share the top (8900), under the chrome bar (9000) */
  animation: at-notice-in 240ms ease-out;
}
@keyframes at-notice-in {
  from { transform: translateY(-100%); opacity: 0; }
  to   { transform: none; opacity: 1; }
}
.at-notice-text {
  flex: 1 1 auto;
  min-width: 0;
}
.at-notice-close {
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
.at-notice-close:hover {
  background: rgba(255,255,255,0.08);
  color: #e6e6e6;
}
@media (prefers-reduced-motion: reduce) {
  .at-notice-standalone { animation: none; }
}
`;

function injectNoticeStyles() {
  if (document.getElementById('at-notice-style')) return;
  const style = document.createElement('style');
  style.id = 'at-notice-style';
  style.textContent = NOTICE_CSS;
  document.head.appendChild(style);
}

function noticeElement(message) {
  injectNoticeStyles();
  const el = document.createElement('div');
  el.className = 'at-notice';
  const text = document.createElement('span');
  text.className = 'at-notice-text';
  text.textContent = message;
  const close = document.createElement('button');
  close.className = 'at-notice-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.title = 'Dismiss';
  close.textContent = '✕';
  close.addEventListener('click', () => el.remove());
  el.append(text, close);
  return el;
}

function showNotice(message, { top = '0px' } = {}) {
  const el = noticeElement(message);
  el.classList.add('at-notice-standalone');
  el.style.top = top;
  document.body.appendChild(el);
  return el;
}

module.exports = { NOTICE_CSS, noticeElement, showNotice };
