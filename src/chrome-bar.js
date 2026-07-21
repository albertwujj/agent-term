// Custom title-bar content rendered into the Electron `titleBarOverlay`
// region on Windows. Replaces:
//   · the OS default narrow title strip (we extend it to 42px)
//   · the in-renderer session banner (was src/session-banner.js)
//   · the application menu line (was buildAppMenu in src/main.js)
//
// What it shows (left to right):
//   · Prompt text — the verbatim user prompt, full 16px Cascadia Mono
//     (same font as the terminal body below). Dim italic fallback when
//     no prompt yet ("waiting for prompt…" / "Sessions").
//   · Working dot — small green circle when AI producing output.
//
// Per-session identity color: rendered as a thin (3px) hue-colored line
// at the BOTTOM of the chrome bar — a delineator between chrome and the
// terminal body. Doesn't compete with the prompt text for attention or
// space. The taskbar icon and picker rows carry the same hue via their
// own geometry (taskbar = chip-letter underline, picker = left stripe);
// the COLOR is the shared identity, not the mechanism.
//
// Interaction:
//   · Whole bar is a -webkit-app-region: drag region for window dragging.
//   · Right-click on the prompt area copies the full captured prompt.

const BAR_HEIGHT_PX = 42;
const BODY_FONT = '16px "Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, "Courier New", monospace';
// 1px hue divider — Windows-native chrome weight. Lives as a separate
// full-width fixed element BELOW the chrome bar (not as the bar's own
// border) so it extends edge-to-edge across the whole window, past
// where env(titlebar-area-width) ends and the system caption buttons
// begin. On the chrome bar itself we use a no-border layout.
const HUE_LINE_PX = 1;
// Breathing room between the hue divider and the terminal's first row.
// Without it the xterm grid hugs the 1px line and the divider reads as
// part of the terminal output rather than a chrome separator. Exposed as
// the --at-chrome-bottom-gap CSS variable; index.html adds it to the
// terminal's margin-top + subtracts from its height so xterm gets a
// shorter row count instead of being clipped at the bottom.
const CHROME_BOTTOM_GAP_PX = 6;

// Stylesheet for the bar. Exported so the preview script can inject the
// same CSS into a standalone page and render the bar at multiple states.
const BAR_CSS = `
.at-chrome {
  position: fixed;
  top: env(titlebar-area-y, 0);
  left: env(titlebar-area-x, 0);
  width: env(titlebar-area-width, 100%);
  height: env(titlebar-area-height, ${BAR_HEIGHT_PX}px);
  z-index: 9000;
  display: flex; align-items: center;
  background: #0c0c0c;
  font: ${BODY_FONT};
  color: #cccccc;
  user-select: none;
  -webkit-app-region: drag;
  padding: 0 14px;
  box-sizing: border-box;
}
.at-chrome-hue-divider {
  /* Hue divider, drawn as a separate fixed element so it spans the
     entire window width — past env(titlebar-area-width) where the
     caption buttons end. Sits at the bottom of the chrome bar / top of
     the terminal body. */
  position: fixed;
  top: env(titlebar-area-height, ${BAR_HEIGHT_PX}px);
  left: 0;
  right: 0;
  height: ${HUE_LINE_PX}px;
  z-index: 9000;
  background: var(--at-hue, #1c1c1c);
  pointer-events: none;
}
.at-chrome-text {
  flex: 1 1 auto;
  align-self: stretch;
  display: flex;
  align-items: center;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #e6e6e6;
  -webkit-app-region: no-drag;
}
.at-chrome-text.dim {
  color: #909090;
  font-style: italic;
}
.at-chrome-dot {
  flex: 0 0 auto;
  width: 6px; height: 6px; border-radius: 50%;
  background: #2a2a2a;
  margin: 0 8px 0 6px;
  transition: background-color 0.15s ease;
  -webkit-app-region: no-drag;
}
.at-chrome-dot.working {
  background: #a3d977;
  box-shadow: 0 0 5px rgba(163,217,119,0.6);
}
`;

let mountedRoot = null;
let stylesInjected = false;
let lastState = null;

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = BAR_CSS;
  document.head.appendChild(style);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function ensureMounted({ onContextMenu } = {}) {
  if (mountedRoot) return mountedRoot;
  injectStyles();
  const el = document.createElement('div');
  el.className = 'at-chrome';
  el.innerHTML = `
    <span class="at-chrome-text dim">Sessions</span>
    <span class="at-chrome-dot"></span>
  `;
  document.body.appendChild(el);
  el.style.webkitAppRegion = 'drag';
  el.addEventListener('mousedown', (ev) => {
    if (ev.button !== 2) return;
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (typeof onContextMenu === 'function') onContextMenu();
  });
  // Full-width hue divider, sibling of the chrome bar — sits at the
  // exact bottom of the titleBarOverlay region and extends past
  // env(titlebar-area-width) so it covers the area beneath the system
  // caption buttons too.
  const divider = document.createElement('div');
  divider.className = 'at-chrome-hue-divider';
  document.body.appendChild(divider);
  mountedRoot = el;
  document.body.style.setProperty('--at-chrome-height', BAR_HEIGHT_PX + 'px');
  document.body.style.setProperty('--at-chrome-bottom-gap', CHROME_BOTTOM_GAP_PX + 'px');
  return el;
}

// Pure helper used by the preview script — given a state, return the
// inner HTML markup for the bar. Production's update() does the same
// composition by mutating the DOM in place.
function renderBarMarkup(state) {
  const s = state || {};
  let text, dim;
  if (s.prompt) {
    text = s.prompt;
    dim = false;
  } else if (s.cli) {
    text = 'waiting for prompt…';
    dim = true;
  } else {
    text = 'Sessions';
    dim = true;
  }
  const dotMarkup = s.cli
    ? `<span class="at-chrome-dot${s.isWorking ? ' working' : ''}"></span>`
    : '';
  return `
    <span class="at-chrome-text${dim ? ' dim' : ''}">${escapeHtml(text)}</span>
    ${dotMarkup}
  `;
}

// Return the CSS color string for a session hue, or null when there
// isn't one yet (pre-CLI / picker state).
function hueColor(hue) {
  if (typeof hue !== 'number') return null;
  return `oklch(65% 0.27 ${hue})`;
}

// Update the bar state. payload: { hue, cli, prompt, isWorking }
function update(payload) {
  lastState = payload || {};
  if (!mountedRoot) return;

  // Hue accent: drive the full-width divider color via a CSS variable on
  // the document root. Setting it on :root means both the chrome bar AND
  // the divider sibling element (which doesn't share a DOM parent with
  // the chrome bar element) pick up the same value through inheritance.
  // No hue → variable removed, divider falls back to neutral #1c1c1c.
  const color = hueColor(lastState.hue);
  if (color) {
    document.documentElement.style.setProperty('--at-hue', color);
  } else {
    document.documentElement.style.removeProperty('--at-hue');
  }

  mountedRoot.innerHTML = renderBarMarkup(lastState);
}

function mount(opts) {
  ensureMounted(opts);
  if (lastState) update(lastState);
}

module.exports = {
  BAR_HEIGHT_PX,
  BAR_CSS,
  renderBarMarkup,
  hueColor,
  mount,
  update,
};
