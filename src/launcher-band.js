// Launcher band — the strip under the chrome bar that offers the AI CLIs
// once the picker has handed the window to the shell: Esc, a click outside
// it, or a shell command run from its Run row (a cd, most often). The
// picker's chooser is gone at that point, and a CLI name typed by hand
// skips the options the picker's launches carry (Codex's title setting,
// ai-title.js), so the strip keeps the chooser in view until a CLI starts
// here. The renderer mounts it together with the picker, beneath it, so
// the terminal reserves its height from the start and the picker's
// dismissal moves nothing.
//
//   Start [claude] [codex] [copilot] [agent]   ⇧ click to add options first · ⌘⇧S for the picker   ✕
//
// A click starts that CLI the way the picker's Enter does; Shift+click
// types the launch line and leaves it at the prompt (the picker's
// Shift+Enter), for options added by hand. The CLIs the user has run come
// first, most recent first (launcherClis), then the rest.
//
// The strip is layout, not an overlay: it sets --at-launcher-height on the
// body, which #terminal (index.html) and the viewer band (viewer-band.js)
// add to their offset, so no terminal row is covered; onResize lets the
// renderer re-fit the terminal. It goes when a pick starts a CLI, when a
// CLI starts by any other route (the renderer watches chrome state), or on
// ✕; the picker coming back mounts it again beneath itself.
//
// Same band grammar as resume-hint.js: 44px, the guidance blue, a left
// accent, labels rather than sentences, one row.

const cliIcons = require('./cli-icons');
const { KNOWN_CLIS } = require('./cli-detect');

const HEIGHT_PX = 44;

let mountedRoot = null;
let stylesInjected = false;

const CSS = `
.at-launcher {
  --at-launcher-accent: #a0c8ff;
  position: fixed;
  top: calc(env(titlebar-area-height, 42px) + 1px);  /* just below the chrome bar's hue divider */
  left: 0;
  right: 0;
  height: ${HEIGHT_PX}px;
  z-index: 8900;
  display: flex;
  align-items: center;
  padding: 0 12px 0 20px;
  gap: 8px;
  box-sizing: border-box;
  background: color-mix(in srgb, var(--at-launcher-accent) 14%, #0c0c0c);
  border-bottom: 1px solid color-mix(in srgb, var(--at-launcher-accent) 35%, #0c0c0c);
  box-shadow: inset 4px 0 0 var(--at-launcher-accent);
  font: 15px/20px "Segoe UI", "Segoe UI Variable", system-ui, sans-serif;
  color: #c8c8c8;
  user-select: none;
  animation: at-launcher-in 240ms ease-out;
}
@keyframes at-launcher-in {
  from { transform: translateY(-100%); opacity: 0; }
  to   { transform: none; opacity: 1; }
}
.at-launcher-lead {
  color: #ffffff;
  font-weight: 600;
  margin-right: 2px;
}
.at-launcher-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 10px 2px 8px;
  font: inherit;
  font-weight: 600;
  line-height: 20px;
  color: #ffffff;
  background: color-mix(in srgb, var(--at-launcher-accent) 18%, #0c0c0c);
  border: 1px solid color-mix(in srgb, var(--at-launcher-accent) 45%, #0c0c0c);
  border-bottom-width: 2px;
  border-radius: 5px;
  cursor: pointer;
}
.at-launcher-chip:hover {
  background: color-mix(in srgb, var(--at-launcher-accent) 30%, #0c0c0c);
}
.at-launcher-chip svg { width: 14px; height: 14px; display: block; opacity: 0.9; }
.at-launcher-hint {
  flex: 1 1 auto;
  min-width: 0;
  margin-left: 10px;
  color: #8a8a8a;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.at-launcher-hint .sep { margin: 0 7px; color: #606060; }
.at-launcher-hint kbd {
  font: inherit;
  color: #b0b0b0;
}
.at-launcher-close {
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
.at-launcher-close:hover {
  background: rgba(255,255,255,0.08);
  color: #e6e6e6;
}
@media (prefers-reduced-motion: reduce) {
  .at-launcher { animation: none; }
}
`;

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// The chips' order: the CLIs the user has run, most recent first, then the
// rest of the known ones. `sessions` is the picker's list (most recent
// first); unknown CLI names (no brand icon) are left out.
function launcherClis(sessions = []) {
  const used = [];
  for (const s of sessions) {
    const cli = s && s.cli;
    if (cli && cliIcons.knownCli(cli) && !used.includes(cli)) used.push(cli);
  }
  return used.concat(KNOWN_CLIS.filter(c => !used.includes(c)));
}

function pickerChord(platform) {
  return platform === 'darwin' ? '⌘⇧S' : 'Ctrl+Shift+S';
}

// Pure helper: the strip's inner HTML for a list of CLIs.
function renderMarkup({ clis = KNOWN_CLIS, platform = 'darwin' } = {}) {
  const chips = clis.map((cli) => {
    const icon = cliIcons.iconSvg(cli, 14) || '';
    return `<button class="at-launcher-chip" data-cli="${escapeHtml(cli)}" type="button">${icon}<span>${escapeHtml(cli)}</span></button>`;
  }).join('');
  const sep = '<span class="sep">·</span>';
  return `
    <span class="at-launcher-lead">Start</span>${chips}
    <span class="at-launcher-hint"><kbd>⇧</kbd> click to add options first${sep}<kbd>${escapeHtml(pickerChord(platform))}</kbd> for the picker</span>
    <button class="at-launcher-close" aria-label="Dismiss" title="Dismiss">✕</button>
  `;
}

function setHeightVar(px) {
  try {
    if (px) document.body.style.setProperty('--at-launcher-height', px + 'px');
    else document.body.style.removeProperty('--at-launcher-height');
  } catch {}
}

let onResizeCurrent = null;

function destroy() {
  if (!mountedRoot) return;
  try { mountedRoot.remove(); } catch {}
  mountedRoot = null;
  setHeightVar(0);
  const onResize = onResizeCurrent;
  onResizeCurrent = null;
  if (typeof onResize === 'function') onResize();
}

// Mount the strip. onStart(cli, { typeOnly }) is the pick; the picker chord
// in the hint text goes through main, not through the strip.
function show({ clis, platform, onStart, onResize } = {}) {
  destroy();
  injectStyles();
  const el = document.createElement('div');
  el.className = 'at-launcher';
  el.innerHTML = renderMarkup({ clis: clis && clis.length ? clis : KNOWN_CLIS, platform });
  el.addEventListener('click', (ev) => {
    const chip = ev.target && ev.target.closest && ev.target.closest('.at-launcher-chip');
    if (chip) {
      ev.preventDefault();
      if (typeof onStart === 'function') onStart(chip.dataset.cli, { typeOnly: !!ev.shiftKey });
      return;
    }
    if (ev.target && ev.target.closest && ev.target.closest('.at-launcher-close')) destroy();
  });
  document.body.appendChild(el);
  mountedRoot = el;
  onResizeCurrent = onResize || null;
  setHeightVar(HEIGHT_PX);
  if (typeof onResize === 'function') onResize();
}

function isMounted() {
  return !!mountedRoot;
}

module.exports = {
  HEIGHT_PX,
  CSS,
  launcherClis,
  renderMarkup,
  show,
  destroy,
  isMounted,
};
