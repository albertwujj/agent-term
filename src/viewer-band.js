// Shared viewer band — the host chrome that BOTH the web/review viewer and the
// markdown viewer sit in. One implementation of: the top-anchored band, its
// golden-ratio sizing + grid-snap, the open/hidden/closed lifecycle and
// transitions, the collapsed frosted handle, the session-hue divider, Esc-to-
// hide, and the bottom bar (a click-to-toggle strip with a ✕ that closes, a
// title slot, and a free slot for viewer-specific widgets).
//
// Deliberately CONTENT- and COMMENT-agnostic: each viewer fills the content slot
// (a <webview> or the markdown article pane) and drops its own widgets into the bar
// slot. Comment-send affordances are buttons in that slot — their clicks
// stopPropagation, so they never toggle the band — which keeps the bar
// interaction identical across viewers and spares the band any comment
// special-case. A future shared comment UI plugs into the same slot.
//
// Sizing: `share: 'major'` takes ~62vh (golden major), 'minor' ~38vh; the band's
// bottom is grid-snapped to a terminal row so the row peeking below isn't chopped.

const VIEWER_BAND_STYLE_ID = 'viewer-band-style';
const SHARE_FRACTION = { major: 0.62, minor: 0.38 };

function ensureBandStyles() {
  if (document.getElementById(VIEWER_BAND_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = VIEWER_BAND_STYLE_ID;
  style.textContent = `
    .vb-shell {
      /* Expanded bar colour; the collapsed hover frost derives from it. */
      --vb-bar: #4a4d53;
      /* Edge-vignette colour: a neutral near-black, so the content's top/bottom edges
         read as a soft dark recess (depth on the light surface). A session-hue tint
         was tried and dropped — it muddied the edge rather than helping. To bring a
         faint tint back, mix a little var(--at-hue) in here. */
      --vb-edge: #0c0c0c;
      position: fixed;
      top: calc(var(--at-chrome-height, 0px) + var(--at-chrome-bottom-gap, 0px));
      left: 0; right: 0; width: 100vw;
      height: var(--vb-open-h, 62vh);
      min-height: var(--vb-min-h, 280px);
      transform: translateY(-8px);
      opacity: 0;
      pointer-events: none;
      z-index: 8200;
      display: flex;
      flex-direction: column;
      background: var(--vb-bg, #16181c);
      border: 0;
      box-shadow: 0 7px 14px -3px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      transition: opacity 150ms ease, transform 150ms ease, height 200ms ease,
                  min-height 200ms ease,
                  background-color var(--vb-bg-transition-duration, 320ms) ease,
                  box-shadow 320ms ease;
    }
    /* Shown and hidden are both visible, differing only in height — so hide/show
       animates as a roll-up/down: the band is top-anchored, so shrinking height
       rides the bottom edge (the bar) up to park as a slim handle. */
    .vb-shell.open, .vb-shell.hidden {
      opacity: 1; pointer-events: auto; transform: translateY(0);
    }
    .vb-shell.hidden {
      height: var(--vb-collapsed-h, 26px);
      min-height: 0;
      background: transparent;   /* let the bar's hover-blur sample the terminal */
      transform: none;
      box-shadow: none;
    }
    .vb-shell.hidden .vb-content { pointer-events: none; }
    .vb-shell.hidden .vb-bar {
      flex-basis: var(--vb-collapsed-h, 26px);
      /* Park the ✕ at the right corner — the whole strip is the click-to-expand
         target, so a centered ✕ is easy to hit by mistake (it closes, not expands). */
      justify-content: flex-end;
      background: transparent;   /* invisible resting strip; reach for the top edge */
      border-top-width: 0;
    }
    .vb-shell.hidden .vb-bar:hover {
      background: color-mix(in srgb, color-mix(in srgb, var(--vb-bar) 50%, #000) 72%, transparent);
      backdrop-filter: blur(12px) saturate(1) brightness(1);
      -webkit-backdrop-filter: blur(12px) saturate(1) brightness(1);
    }
    .vb-shell.hidden .vb-bar-left, .vb-shell.hidden .vb-bar-right,
    .vb-shell.hidden .vb-title { display: none; }
    .vb-shell.hidden .vb-close {
      margin: 0; padding: 0; border: none; background: transparent;
      width: auto; height: auto; color: #aab1ba; font-size: 12px; line-height: 1;
      opacity: 0; transition: opacity 160ms ease, color 160ms ease;
    }
    .vb-shell.hidden .vb-bar:hover .vb-close { opacity: 1; }
    .vb-shell.hidden .vb-close:hover { background: transparent; color: #d0d5db; }
    /* Open: expand the chrome hue divider into a gradient band at the viewport's
       top edge; collapsed/closed, it reverts to the quiet 1px line. */
    body:has(.vb-shell.open) .at-chrome-hue-divider {
      height: 6px;
      background: linear-gradient(to top, var(--at-hue, #1c1c1c), transparent);
    }
    /* While a viewer band is OPEN, the terminal is the secondary pane — so recede
       it: pull it gently toward grey (contrast down, a touch brighter) to ease the
       dark↔light contrast with the bright viewer and read it as backgrounded. Only
       when fully open (hidden/closed reverts, since the terminal is primary again);
       animated by the transition. Tune --vb-term-dim (0 = off, ~0.2 = strong) — keep
       it subtle so the live tail stays legible at a glance. */
    :root { --vb-term-dim: 0.22; }
    #terminal { transition: filter 240ms ease; }
    body:has(.vb-shell.open) #terminal {
      filter: contrast(calc(1 - var(--vb-term-dim) * 0.8))
              brightness(calc(1 + var(--vb-term-dim) * 0.5));
    }
    .vb-bar {
      flex: 0 0 26px;
      display: flex; align-items: center; gap: 4px; padding: 0 8px;
      /* A medium grey bridging the (light) content above and the dark terminal
         below; the hue accents the TOP (content|bar) seam, the bottom melts
         into the terminal. */
      background: var(--vb-bar);
      border-top: 1px solid var(--at-hue, rgba(100, 116, 139, 0.85));
      /* Crisp bottom edge so the bar reads as a distinct strip instead of melting
         into the dimmed (greyed) terminal below it. */
      border-bottom: 1px solid rgba(0, 0, 0, 0.4);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      user-select: none; cursor: pointer;
      backdrop-filter: blur(0px) saturate(1) brightness(1);
      -webkit-backdrop-filter: blur(0px) saturate(1) brightness(1);
      transition: background-color 280ms ease, border-color 280ms ease,
                  backdrop-filter 280ms ease, flex-basis 200ms ease;
    }
    .vb-bar:hover { background: #53565c; }
    .vb-bar-left { display: flex; align-items: center; gap: 4px; }
    .vb-bar-right { display: flex; align-items: center; gap: 4px; }
    .vb-btn {
      width: 22px; height: 18px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid #696c72; border-radius: 4px;
      background: #5a5d63; color: #dadee3;
      cursor: pointer; font-size: 11px; line-height: 1; padding: 0;
      transition: background-color 200ms ease, color 200ms ease, border-color 200ms ease;
    }
    .vb-btn:hover { background: #63666c; }
    .vb-btn:disabled { opacity: 0.4; cursor: default; }
    .vb-title {
      flex: 1 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: #dadee3; font-size: 11px; font-weight: 500; line-height: 14px;
      padding: 0 4px;
      pointer-events: none; /* clicks fall through to the toggle strip */
      transition: color 280ms ease, opacity 220ms ease;
    }
    .vb-close { margin-left: auto; }
    /* min-height:0 lets the content shrink to 0 as the band rolls up; without it
       the flex default keeps a sliver showing and clips the bar. */
    .vb-content { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; width: 100%;
      position: relative; }
    /* Edge vignette — a soft, neutral dark inner-shadow at the top AND bottom of
       the content slot, so the page tucks into shadow at its edges (depth / a polished
       frame). On the SHARED band as an OVERLAY (not a blur), so it works for every
       viewer — md DOM and the web/diff <webview> alike (paint composites over the
       guest; a backdrop-filter could not). Every stop is the SAME colour
       (var(--vb-edge)) with only alpha stepping down to 0 (ending at "transparent"),
       so the dark veil fades fully out — no leftover colour band. The alpha steps
       ease out over many stops (26→16→9→4→1→0) so there's no visible step/band. Only while
       open (the collapsed handle has no content to frame). Tune --vb-edge / alphas /
       the 22px height. */
    .vb-shell.open .vb-content::before,
    .vb-shell.open .vb-content::after {
      content: '';
      position: absolute; left: 0; right: 0;
      height: 14px;
      pointer-events: none;
      z-index: 5;
    }
    .vb-shell.open .vb-content::before {
      top: 0;
      background: linear-gradient(to bottom,
        color-mix(in srgb, var(--vb-edge) 26%, transparent) 0%,
        color-mix(in srgb, var(--vb-edge) 16%, transparent) 18%,
        color-mix(in srgb, var(--vb-edge) 9%, transparent) 38%,
        color-mix(in srgb, var(--vb-edge) 4%, transparent) 60%,
        color-mix(in srgb, var(--vb-edge) 1%, transparent) 80%,
        transparent 100%);
    }
    .vb-shell.open .vb-content::after {
      bottom: 0;
      background: linear-gradient(to top,
        color-mix(in srgb, var(--vb-edge) 26%, transparent) 0%,
        color-mix(in srgb, var(--vb-edge) 16%, transparent) 18%,
        color-mix(in srgb, var(--vb-edge) 9%, transparent) 38%,
        color-mix(in srgb, var(--vb-edge) 4%, transparent) 60%,
        color-mix(in srgb, var(--vb-edge) 1%, transparent) 80%,
        transparent 100%);
    }
    /* Refresh flash — a viewer pulses the band (shell glow + bar/title flash) to
       signal it just reloaded / re-rendered. Simple viewers call flash(); md drives
       .vb-refreshed itself as a pulse-until-its-new-content-lands. Animates against
       the band's own base values above, so it reads on any viewer theme. */
    .vb-shell.vb-refreshed { animation: vb-refresh-shell 3000ms ease-out 3; }
    .vb-shell.vb-refreshed .vb-bar { animation: vb-refresh-bar 3000ms ease-out 3; }
    .vb-shell.vb-refreshed .vb-title { animation: vb-refresh-text 3000ms ease-out 3; }
    @keyframes vb-refresh-shell {
      0%, 100% { box-shadow: 0 7px 14px -3px rgba(0, 0, 0, 0.45); }
      38% {
        box-shadow:
          inset 0 8px 16px rgba(12, 12, 12, 0.34),
          inset 0 -8px 16px rgba(12, 12, 12, 0.34),
          0 10px 28px rgba(0, 0, 0, 0.20);
      }
    }
    @keyframes vb-refresh-bar {
      0%, 100% { background: var(--vb-bar); border-top-color: var(--at-hue, rgba(100, 116, 139, 0.85)); }
      16% { background: #2c517f; border-top-color: rgba(88, 166, 255, 1); }
      40% { background: #26313f; border-top-color: rgba(56, 139, 253, 0.9); }
    }
    @keyframes vb-refresh-text {
      0%, 100% { color: #dadee3; }
      18% { color: #ffffff; }
      40% { color: #cfe4ff; }
    }
  `;
  document.head.appendChild(style);
}

// onClose / onShow / onHide are content hooks; getTerminalGrid → { top, cellHeight }
// for grid-snap. The returned api exposes the DOM the viewer fills (content, barLeft,
// titleEl) plus the lifecycle the viewer drives.
function createViewerBand({
  name = 'viewer',
  share = 'major',
  bg = null,
  minHeight = 280,
  closeTitle = 'Close',
  escToHide = true,   // false → the viewer drives Esc itself (e.g. md cancels an
                      // open comment card first, then hides via its own handler)
  getTerminalGrid,
  onClose,
  onShow,
  onHide,
} = {}) {
  let shell = null;
  let bar = null;
  let barLeft = null;
  let barRight = null;
  let content = null;
  let titleEl = null;
  let state = 'closed'; // 'closed' | 'hidden' | 'open'
  let sizeMode = 'golden'; // open-height target: 'golden' (the major share) | 'full' (viewport)
  const fraction = SHARE_FRACTION[share] || SHARE_FRACTION.major;

  function makeBtn(label, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'vb-btn';
    btn.title = title;
    btn.textContent = label;
    // Don't let a bar-widget click bubble to the bar's toggle handler.
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  function mount() {
    if (shell) return api;
    ensureBandStyles();
    shell = document.createElement('div');
    shell.className = `vb-shell vb-${name}`;
    if (bg) shell.style.setProperty('--vb-bg', bg);
    shell.style.setProperty('--vb-min-h', `${minHeight}px`);

    content = document.createElement('div');
    content.className = 'vb-content';

    bar = document.createElement('div');
    bar.className = 'vb-bar';
    bar.title = 'Click to hide / show';

    barLeft = document.createElement('div');
    barLeft.className = 'vb-bar-left';

    titleEl = document.createElement('div');
    titleEl.className = 'vb-title';

    barRight = document.createElement('div');
    barRight.className = 'vb-bar-right';

    const closeBtn = makeBtn('✕', closeTitle, () => close());
    closeBtn.classList.add('vb-close');

    // barRight rides between the title and the ✕: a right-side slot for widgets
    // that should sit apart from the (left-aligned) title, e.g. a "copy body".
    bar.append(barLeft, titleEl, barRight, closeBtn);
    // Tap the bar → roll up / restore (same in golden or full); double-click → full
    // screen. See bindBarGestures.
    bindBarGestures();

    shell.append(content, bar); // content above the bottom bar
    document.body.appendChild(shell);
    return api;
  }

  // Snap a target height so the band's BOTTOM lands on a terminal row boundary.
  function gridSnapHeight(targetPx, minRows) {
    if (typeof getTerminalGrid !== 'function' || !shell) return targetPx;
    let grid;
    try { grid = getTerminalGrid(); } catch { return targetPx; }
    const cell = grid && grid.cellHeight;
    if (!cell || cell <= 0 || !Number.isFinite(cell)) return targetPx;
    const shellTop = shell.getBoundingClientRect().top;
    const rows = Math.max(minRows || 1, Math.round((shellTop + targetPx - grid.top) / cell));
    return Math.round(grid.top + rows * cell - shellTop);
  }
  function collapsedHeight() { return gridSnapHeight(26, 1); }
  // The golden major share (the default open size).
  function goldenHeight() {
    const vh = window.innerHeight || 800;
    const shellTop = shell ? shell.getBoundingClientRect().top : 0;
    return gridSnapHeight(Math.max(minHeight, Math.min(vh * fraction, vh - shellTop - 42)), 6);
  }
  // Full screen: fill the viewport down to (near) the bottom.
  function maxOpenHeight() {
    const vh = window.innerHeight || 800;
    const shellTop = shell ? shell.getBoundingClientRect().top : 0;
    return gridSnapHeight(vh - shellTop - 8, 6);
  }
  function openHeight() { return sizeMode === 'full' ? maxOpenHeight() : goldenHeight(); }

  // Keep the semantic size state on the shell as well as in JS. Viewers can use
  // this to adapt their presentation while the shared height transition runs
  // (the markdown viewer, for example, lifts its muted split-view palette when
  // the terminal is no longer visible). Read layout first, then update the class
  // and height without a layout read between them so both transitions start in
  // the same style change.
  function applyOpenSize() {
    const height = openHeight();
    shell.classList.toggle('vb-full', sizeMode === 'full');
    shell.style.setProperty('--vb-open-h', height + 'px');
  }

  function open() {
    mount();
    applyOpenSize();
    shell.classList.remove('hidden');
    shell.classList.add('open');
    state = 'open';
  }
  // Roll up to just the bar handle, keeping content alive so showing is instant.
  function hide() {
    if (state !== 'open') return;
    sizeMode = 'golden'; // collapsing resets to the reading size; double-click for full again
    shell.classList.remove('vb-full');
    shell.style.setProperty('--vb-collapsed-h', collapsedHeight() + 'px');
    shell.classList.remove('open');
    shell.classList.add('hidden');
    state = 'hidden';
    if (typeof onHide === 'function') onHide();
  }
  function show() {
    if (state !== 'hidden') return;
    applyOpenSize();
    shell.classList.remove('hidden');
    shell.classList.add('open');
    state = 'open';
    if (typeof onShow === 'function') onShow();
  }
  function toggle() {
    if (state === 'open') hide();
    else if (state === 'hidden') show();
  }
  // Bar gestures: a single TAP rolls up / restores (the everyday toggle, same in golden
  // or full); a DOUBLE-CLICK toggles full ↔ golden — so from full you drop to golden to
  // read the agent's output in the terminal tail at full size, then double-click back.
  // The tap is deferred a beat so a double-click doesn't collapse-then-restore first
  // (jiggle) — the dblclick cancels the pending tap. Both stopPropagation so a
  // click/dblclick on the bar never reaches the comment gesture on the terminal text
  // behind it. Widgets (.vb-btn) stopPropagation on their own, so they never reach here.
  function bindBarGestures() {
    let tapTimer = null;
    bar.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.vb-btn')) return;
      e.stopPropagation();
      if (tapTimer) return; // the 2nd click of a double — dblclick will handle it
      tapTimer = setTimeout(() => { tapTimer = null; toggle(); }, 250);
    });
    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest && e.target.closest('.vb-btn')) return;
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; } // cancel the pending tap
      e.preventDefault();
      e.stopPropagation();
      sizeMode = (sizeMode === 'full') ? 'golden' : 'full'; // toggle full <-> golden
      if (state === 'hidden') show();
      else if (state === 'open') applyOpenSize();
    });
  }
  // Full dismiss; the viewer's onClose frees content (GC the webview, etc.).
  function close() {
    if (state === 'closed' || !shell) return;
    shell.classList.remove('open', 'hidden');
    state = 'closed';
    if (typeof onClose === 'function') onClose();
  }
  function isOpen() { return state === 'open'; }
  function isHidden() { return state === 'hidden'; }
  function setTitle(t) { if (titleEl) titleEl.textContent = t || ''; }

  // Fire-and-forget refresh pulse for simple viewers (e.g. the review webview after
  // an auto-reload). md instead drives .vb-refreshed itself, holding the pulse until
  // its new content lands — same CSS either way.
  function flash() {
    if (!shell) return;
    shell.classList.remove('vb-refreshed');
    void shell.offsetWidth; // restart the animation even if it's mid-pulse
    shell.classList.add('vb-refreshed');
  }

  if (escToHide) {
    document.addEventListener('keydown', (event) => {
      // Esc rolls up (reversible) when shown; collapsed/closed it's left for the CLI.
      // An open modal (viewer selector, path chooser, session picker) owns Esc —
      // this capture listener fires before the modal's own handlers ever could.
      if (event.key === 'Escape' && state === 'open') {
        if (document.querySelector('.at-modal-overlay')) return;
        event.preventDefault();
        event.stopPropagation();
        hide();
      }
    }, true);
  }

  // Keep the band/handle bottom snapped to the terminal grid as the window resizes.
  window.addEventListener('resize', () => {
    if (!shell) return;
    if (state === 'open') applyOpenSize();
    else if (state === 'hidden') shell.style.setProperty('--vb-collapsed-h', collapsedHeight() + 'px');
  });

  const api = {
    mount, open, hide, show, toggle, close, isOpen, isHidden, setTitle, makeBtn, flash,
    get shell() { return shell; },
    get bar() { return bar; },
    get barLeft() { return barLeft; },
    get barRight() { return barRight; },
    get content() { return content; },
    get titleEl() { return titleEl; },
  };
  return api;
}

module.exports = { createViewerBand };
