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
//
// Automatic moves. The band moves on its own in three places, and nowhere else:
// an agent's handoff opens a viewer (the host's auto-open), a Send recedes a
// full band to golden so the terminal shows the agent picking it up (the
// acknowledgment), and the band returns to full once the agent has answered
// that Send. Everything else is the user's hand. One invariant covers all
// three: no automatic move lands while the user is typing, in a viewer or in
// the terminal — nothing moves the text being typed. userIsTyping() is that
// check; the host registers what typing in the terminal means (setTypingProbe)
// and calls it before its own automatic moves, and the return consults it here.

const VIEWER_BAND_STYLE_ID = 'viewer-band-style';
const SHARE_FRACTION = { major: 0.62, minor: 0.38 };

// The bar's resize cursor, drawn here so it is the same on macOS and Windows
// and sized to the 26px bar (about half its height): two triangles, white
// with a thin dark outline so they read over the grey bar, the light doc and
// the dark terminal, with the way the bar cannot go greyed — macOS's own
// frame-resize grammar, which Windows lacks (it draws every resize cursor as
// one plain double arrow). The hotspot is the gap between them; the native
// cursor stays as the fallback.
function barCursor(upAlpha, downAlpha, fallback) {
  const tri = (points, alpha) => `<polygon points="${points}" fill="#fff" fill-opacity="${alpha}" `
    + `stroke="#1a1a1a" stroke-opacity="${Math.max(alpha, 0.55)}" stroke-width="1" stroke-linejoin="round"/>`;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="16" viewBox="0 0 12 16">'
    + tri('6,1.25 10.75,6.75 1.25,6.75', upAlpha)
    + tri('1.25,9.25 10.75,9.25 6,14.75', downAlpha)
    + '</svg>';
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 6 8, ${fallback}`;
}
const BAR_CURSOR = {
  both: barCursor(1, 1, 'ns-resize'),
  upOnly: barCursor(1, 0.3, 'n-resize'),
  downOnly: barCursor(0.3, 1, 's-resize'),
};

// Text entry: where a keystroke lands as text. A focused one inside a band is
// typing on the band's own terms, so the band needs no host probe for it.
function isTextEntry(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  if (el.getAttribute && el.getAttribute('contenteditable') === 'true') return true;
  return el.tagName === 'INPUT' && !/^(?:button|checkbox|radio|submit|reset|range|color|file|image)$/i.test(el.type || '');
}
// Writing: a comment, reply or edit — a textarea or an editable block, not a
// search field. Starting to write at golden settles the size there.
function isWritingSurface(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.getAttribute && el.getAttribute('contenteditable') === 'true');
}

let typingProbe = null;
function setTypingProbe(fn) { typingProbe = typeof fn === 'function' ? fn : null; }
function userIsTyping() {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (active && active.closest && active.closest('.vb-shell') && isTextEntry(active)) return true;
  try { return !!(typingProbe && typingProbe()); } catch { return false; }
}

// Whether the CLI says its turn is over: true (idle), false (working), or null
// when its title carries no such evidence. Window-wide, so it lives here and
// every band re-checks its return when it changes.
let agentIdle = null;
const liveBands = new Set();
function setAgentIdle(value) {
  const next = value === true ? true : value === false ? false : null;
  if (next === agentIdle) return;
  agentIdle = next;
  for (const band of liveBands) band.evaluateReturn();
}

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
      top: calc(var(--at-chrome-height, 0px) + var(--at-chrome-bottom-gap, 0px) + var(--at-launcher-height, 0px));
      left: 0; right: 0; width: 100vw;
      height: var(--vb-open-h, 62vh);
      min-height: var(--vb-min-h, 280px);
      transform: translateY(-8px);
      opacity: 0;
      /* Closed: inert by construction. The shell stays mounted at its last open
         height, so pointer-events alone is not enough — a descendant that sets
         its own pointer-events would still hit-test through the invisible
         shell, and a focus() call would still land on it. visibility:hidden
         removes it from hit-testing and focus, once the fade has run. */
      visibility: hidden;
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
                  box-shadow 320ms ease,
                  visibility 0s linear 150ms;
    }
    /* Shown and hidden are both visible, differing only in height — so hide/show
       animates as a roll-up/down: the band is top-anchored, so shrinking height
       rides the bottom edge (the bar) up to park as a slim handle. */
    .vb-shell.open, .vb-shell.hidden {
      opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0);
      transition-delay: 0s; /* visible at once; the delay is for closing only */
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
      /* The bar is the band's bottom edge, the divider between doc and
         terminal: drag it to resize (see bindBarGestures); a tap still rolls
         the band up or brings it back. */
      user-select: none; cursor: ${BAR_CURSOR.both};
      backdrop-filter: blur(0px) saturate(1) brightness(1);
      -webkit-backdrop-filter: blur(0px) saturate(1) brightness(1);
      transition: background-color 280ms ease, border-color 280ms ease,
                  backdrop-filter 280ms ease, flex-basis 200ms ease;
    }
    .vb-bar:hover { background: #53565c; }
    /* The cursor is the drag's only sign, and it points the ways the bar can
       go: down only from the rolled-up handle, up only at full, both at golden
       (BAR_CURSOR). */
    .vb-shell.vb-full .vb-bar { cursor: ${BAR_CURSOR.upOnly}; }
    .vb-shell.hidden .vb-bar { cursor: ${BAR_CURSOR.downOnly}; }
    /* Where a drag will land the band, drawn over the part that changes: the
       terminal it will take when growing (tinted, the landing line at its
       foot), the doc it will give up when shrinking (veiled, the landing line
       at its head). The doc itself reflows once, on release. */
    .vb-drag-guide {
      position: fixed; left: 0; right: 0; z-index: 8201; pointer-events: none;
      box-sizing: border-box; display: none;
    }
    .vb-drag-guide.on { display: block; }
    .vb-drag-guide.grow {
      background: color-mix(in srgb, var(--at-hue, rgb(88, 166, 255)) 22%, transparent);
      border-bottom: 2px solid var(--at-hue, rgba(88, 166, 255, 0.9));
    }
    .vb-drag-guide.shrink {
      background: rgba(10, 12, 16, 0.42);
      border-top: 2px solid var(--at-hue, rgba(88, 166, 255, 0.9));
    }
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
    /* Snap — hide/show is a mode switch (terminal ⇄ terminal+viewer), so it lands
       instantly, like a tab change; the class is on for only a couple of frames
       around the state flip. golden↔full resizes stay animated (they reshape a
       surface the eye is already on, where continuity helps). */
    .vb-shell.vb-snap, .vb-shell.vb-snap *,
    body:has(.vb-shell.vb-snap) #terminal { transition: none !important; }
    /* Refresh flash — a viewer pulses the band (shell glow + bar/title flash) to
       signal it just reloaded / re-rendered. Simple viewers call flash(); md drives
       .vb-refreshed itself as a pulse-until-its-new-content-lands. Animates against
       the band's own base values above, so it reads on any viewer theme. */
    .vb-shell.vb-refreshed { animation: vb-refresh-shell 3000ms ease-out 3; }
    .vb-shell.vb-refreshed .vb-bar { animation: vb-refresh-bar 3000ms ease-out 3; }
    .vb-shell.vb-refreshed .vb-title { animation: vb-refresh-text 3000ms ease-out 3; }
    /* Rolled up, the shell's shadow pulse has no body to frame — the bar's flash
       alone lights the (normally invisible) handle strip, which IS the hidden-state
       announcement: content changed behind this handle. */
    .vb-shell.hidden.vb-refreshed { animation: none; }
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
  defaultSize = 'golden', // 'golden' | 'full' — the open size a fresh reveal lands on
  closeTitle = 'Close',
  escToHide = true,   // false → the viewer drives Esc itself (e.g. md cancels an
                      // open comment card first, then hides via its own handler)
  getTerminalGrid,
  onClose,
  onShow,
  onHide,
  focusTerminal,      // where the keyboard goes when the band rolls up or closes
                      // while holding focus (a click in the band lands focus on
                      // its shell, a bar button, a composer, a webview guest)
} = {}) {
  let shell = null;
  let bar = null;
  let barLeft = null;
  let barRight = null;
  let content = null;
  let titleEl = null;
  let state = 'closed'; // 'closed' | 'hidden' | 'open'
  let restSize = defaultSize === 'full' ? 'full' : 'golden';
  let sizeMode = restSize; // open-height target: 'golden' (the major share) | 'full' (viewport)
  const fraction = SHARE_FRACTION[share] || SHARE_FRACTION.major;
  // The Send's round trip. recededForSend: the band sits at golden because a
  // Send put it there, not the user's hand. returnArmed: that Send's answer
  // brings full back. threads: the viewer's last report on its store,
  // { answered, resolved }, or null until one arrives after the Send.
  let recededForSend = false;
  let returnArmed = false;
  let threads = null;

  // The band overlays the terminal, so its bottom edge is where visible terminal
  // starts. Anything the host anchors to a terminal row (the type-to-comment
  // pill, queued comment cards) has to re-check itself whenever that edge moves —
  // announce it rather than have the host poll. Content-agnostic, like the rest
  // of the band: listeners read the geometry off the DOM themselves.
  function emitGeometryChange() {
    // The document's own constructor, not the bare global: under jsdom the two
    // are different realms and dispatchEvent rejects a foreign Event.
    const { CustomEvent } = document.defaultView;
    document.dispatchEvent(new CustomEvent('viewer-band-geometry', {
      detail: { name, state },
    }));
  }

  function makeBtn(label, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'vb-btn';
    btn.title = title;
    btn.textContent = label;
    // Don't let a bar-widget click bubble to the bar's toggle handler. The
    // event goes along so a widget can offer a modifier-click variant.
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
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
    // Every bar gesture, since none shows on its own (see bindBarGestures).
    bar.title = 'Drag to resize · click to hide / show · double-click to toggle full size';

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
    // Starting to write in the band (a comment, a reply, an edit) settles the
    // size where it is: a return that landed later would re-flow the page under
    // the next sentence. A guest page reports its own (cancelReturn).
    shell.addEventListener('focusin', (e) => { if (isWritingSurface(e.target)) cancelReturn(); });

    shell.append(content, bar); // content above the bottom bar
    document.body.appendChild(shell);
    liveBands.add(api);
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
  // The golden major share (the split-view reading size).
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

  // Run a state flip with transitions off (see .vb-snap). Two frames before
  // re-arming: the first paints the snapped state, the second guarantees the
  // transition styles return only after that paint.
  function snap(change) {
    shell.classList.add('vb-snap');
    change();
    const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
    raf(() => raf(() => { if (shell) shell.classList.remove('vb-snap'); }));
  }

  // A band that leaves the screen must not keep the keyboard: focus inside it
  // (the shell itself, a bar button, a composer, a webview guest) would make the
  // window read as frozen — every key lands on something that is no longer
  // there. Hand it to the terminal, the one surface always underneath.
  function releaseFocus() {
    if (!shell || typeof focusTerminal !== 'function') return;
    const active = document.activeElement;
    if (!active || !shell.contains(active)) return;
    try { focusTerminal(); } catch {}
  }

  function open() {
    mount();
    endRoundTrip(); // a fresh page owes nothing to an earlier Send
    applyOpenSize();
    shell.classList.remove('hidden');
    shell.classList.add('open');
    state = 'open';
    emitGeometryChange();
  }
  // Roll up to just the bar handle, keeping content alive so showing is instant.
  function hide() {
    if (state !== 'open') return;
    endRoundTrip(); // the user put the band away; nothing brings it back on its own
    sizeMode = restSize; // collapsing resets to the band's default size
    snap(() => {
      shell.classList.remove('vb-full');
      shell.style.setProperty('--vb-collapsed-h', collapsedHeight() + 'px');
      shell.classList.remove('open');
      shell.classList.add('hidden');
    });
    state = 'hidden';
    releaseFocus();
    emitGeometryChange();
    if (typeof onHide === 'function') onHide();
  }
  function show() {
    if (state !== 'hidden') return;
    snap(() => {
      applyOpenSize();
      shell.classList.remove('hidden');
      shell.classList.add('open');
    });
    state = 'open';
    emitGeometryChange();
    if (typeof onShow === 'function') onShow();
  }
  function toggle() {
    if (state === 'open') hide();
    else if (state === 'hidden') show();
  }
  // Land the band on an open size ('golden' | 'full'), from open or the handle.
  function applySize(name) {
    sizeMode = name === 'full' ? 'full' : 'golden';
    if (state === 'hidden') show();          // show() applies the size it was just given
    else { applyOpenSize(); emitGeometryChange(); }
  }
  // The bar's double-click and the size chord: golden⇄full while open; from the
  // hidden handle it reveals at full — so toggle() reveals at the band's default
  // size and this always lands full, whatever the default. Always the user's
  // hand, so a size picked here holds: no automatic move overrides it.
  function toggleFullSize() {
    if (state === 'closed' || !shell) return;
    endRoundTrip();
    applySize(state === 'open' && sizeMode === 'full' ? 'golden' : 'full');
  }
  function isFull() { return state === 'open' && sizeMode === 'full'; }

  // ---- The Send's round trip (see "Automatic moves" at the top) ----

  function endRoundTrip() {
    recededForSend = false;
    returnArmed = false;
    threads = null;
  }
  // A Send hands the turn to the agent. At full size that leaves the user blind
  // to the pickup, so drop to golden: the terminal slides in underneath with
  // the pasted prompt, the receipt. recede() alone is for a Send still being
  // prepared (md waits there for agent-threads to be cloned); the Send itself
  // calls recedeForSend(), which also arms the return.
  function recede() {
    if (!isFull()) return;
    applySize('golden');
    recededForSend = true;
  }
  // Arms the return only when this Send (or the one it completes) receded the
  // band: a band the user already sat at golden stays there.
  function recedeForSend() {
    recede();
    if (!recededForSend) return;
    returnArmed = true;
    threads = null; // only a report made after this Send counts
  }
  // The viewer's store, after every snapshot: answered = no thread still waits
  // on the agent (each is resolved, or ends with its reply); resolved = each is
  // resolved.
  function reportThreads(report) {
    threads = report ? { answered: !!report.answered, resolved: !!report.resolved } : null;
    evaluateReturn();
  }
  // Full comes back once the agent has answered everything and the CLI says
  // its turn is over. Both, because a reply can land before the edits it
  // describes (agent-threads lets the agent answer first, then act), and an
  // idle CLI alone says nothing about the threads. A CLI whose title gives no
  // idle evidence falls back to every thread resolved, the agent's explicit
  // end-of-work mark. One-shot, and dropped rather than deferred when the user
  // is typing: a size change landing later would be one they did not pick.
  function evaluateReturn() {
    if (!returnArmed || state !== 'open' || sizeMode !== 'golden' || !threads) return;
    const done = agentIdle === null ? threads.resolved : (agentIdle && threads.answered);
    if (!done) return;
    endRoundTrip();
    if (userIsTyping()) return;
    applySize('full');
  }
  // The user started writing: the size they are writing at is theirs, so the
  // Send that follows from there arms nothing either.
  function cancelReturn() { endRoundTrip(); }

  // Retarget the size fresh reveals land on — for a band whose default depends
  // on what it hosts (the web band: review pages full, plain pages golden). A
  // band already open keeps its current size; the new default takes effect from
  // the next reveal.
  function setDefaultSize(name) {
    restSize = name === 'full' ? 'full' : 'golden';
    if (state !== 'open') sizeMode = restSize;
  }

  // Bar gestures: a single TAP rolls up / restores (the everyday toggle, same in golden
  // or full); a DOUBLE-CLICK toggles full ↔ golden — so from full you drop to golden to
  // read the agent's output in the terminal tail at full size, then double-click back.
  // The tap is deferred a beat so a double-click doesn't collapse-then-restore first
  // (jiggle) — the dblclick cancels the pending tap. Both stopPropagation so a
  // click/dblclick on the bar never reaches the comment gesture on the terminal text
  // behind it. Widgets (.vb-btn) stopPropagation on their own, so they never reach here.
  //
  // A DRAG of the bar resizes: the bar is the band's bottom edge, the divider
  // between doc and terminal, so pulling it down grows the band and pushing it up
  // shrinks it. With three sizes the drag is a pull, not an aim: past one row
  // (DRAG_STEP_PX) it is one size in its direction (golden → full, full → golden,
  // golden → rolled up), and the pointer passing halfway to the size beyond makes
  // it two (full → rolled up, the handle → full). A guide shows where the bar will
  // land; release commits, Esc or pulling back cancels. Nothing reflows while the
  // pointer moves — the doc re-lays once, on release.
  const DRAG_STEP_PX = 16;
  let dragGuide = null;
  let dragEndedAt = 0;
  // Bottom edge of the band at each level: 0 rolled up, 1 golden, 2 full.
  function levelBottoms() {
    const top = shell.getBoundingClientRect().top;
    return [top + collapsedHeight(), top + goldenHeight(), top + maxOpenHeight()];
  }
  function currentLevel() {
    if (state === 'hidden') return 0;
    return sizeMode === 'full' ? 2 : 1;
  }
  function dragTarget(start, startY, y, bottoms) {
    const dy = y - startY;
    if (Math.abs(dy) < DRAG_STEP_PX) return start;
    const dir = dy > 0 ? 1 : -1;
    let target = start + dir;
    if (target < 0 || target > 2) return start;
    for (let next = target + dir; next >= 0 && next <= 2; next += dir) {
      const half = (bottoms[target] + bottoms[next]) / 2;
      if (dir > 0 ? y > half : y < half) target = next; else break;
    }
    return target;
  }
  function showDragGuide(start, level, bottoms) {
    if (!dragGuide) {
      dragGuide = document.createElement('div');
      dragGuide.className = 'vb-drag-guide';
      document.body.appendChild(dragGuide);
    }
    const from = bottoms[start];
    const to = bottoms[level];
    dragGuide.style.top = Math.min(from, to) + 'px';
    dragGuide.style.height = Math.max(2, Math.abs(to - from)) + 'px';
    dragGuide.classList.toggle('grow', to > from);
    dragGuide.classList.toggle('shrink', to < from);
    dragGuide.classList.add('on');
  }
  function hideDragGuide() { if (dragGuide) dragGuide.classList.remove('on'); }
  // The user's hand, so it ends any Send's round trip, as a double-click does.
  function setLevelByHand(level) {
    if (level === 0) { hide(); return; }
    endRoundTrip();
    applySize(level === 2 ? 'full' : 'golden');
  }

  function bindBarGestures() {
    let tapTimer = null;
    let drag = null; // { pointerId, startY, start, target, bottoms, moved }
    const endDrag = (commit) => {
      if (!drag) return;
      const { start, target, moved, pointerId } = drag;
      drag = null;
      document.removeEventListener('keydown', onDragKey, true);
      try { if (bar.releasePointerCapture) bar.releasePointerCapture(pointerId); } catch {}
      hideDragGuide();
      if (!moved) return;
      dragEndedAt = Date.now(); // the click this drag's release fires is not a tap
      if (commit && target !== start) setLevelByHand(target);
    };
    const onDragKey = (e) => {
      if (e.key !== 'Escape' || !drag) return;
      e.preventDefault();
      e.stopPropagation();
      endDrag(false);
    };
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target.closest && e.target.closest('.vb-btn'))) return;
      if (state === 'closed') return;
      drag = { pointerId: e.pointerId, startY: e.clientY, start: currentLevel(), target: currentLevel(),
        bottoms: levelBottoms(), moved: false };
      try { if (bar.setPointerCapture) bar.setPointerCapture(e.pointerId); } catch {}
      document.addEventListener('keydown', onDragKey, true);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!drag.moved && Math.abs(e.clientY - drag.startY) < DRAG_STEP_PX) return;
      drag.moved = true;
      drag.target = dragTarget(drag.start, drag.startY, e.clientY, drag.bottoms);
      if (drag.target === drag.start) hideDragGuide();
      else showDragGuide(drag.start, drag.target, drag.bottoms);
    });
    bar.addEventListener('pointerup', (e) => {
      if (drag && e.pointerId === drag.pointerId) endDrag(true);
    });
    bar.addEventListener('pointercancel', () => endDrag(false));
    const justDragged = () => Date.now() - dragEndedAt < 500;
    bar.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.vb-btn')) return;
      e.stopPropagation();
      if (justDragged()) return;
      if (tapTimer) return; // the 2nd click of a double — dblclick will handle it
      tapTimer = setTimeout(() => { tapTimer = null; toggle(); }, 250);
    });
    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest && e.target.closest('.vb-btn')) return;
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; } // cancel the pending tap
      e.preventDefault();
      e.stopPropagation();
      if (justDragged()) return; // a drag's release and a click after it are not a double
      toggleFullSize();
    });
  }
  // Full dismiss; the viewer's onClose frees content (GC the webview, etc.).
  function close() {
    if (state === 'closed' || !shell) return;
    endRoundTrip();
    sizeMode = restSize; // the next open is a fresh reveal, at the default size
    shell.classList.remove('open', 'hidden', 'vb-full');
    state = 'closed';
    releaseFocus();
    emitGeometryChange();
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
    else return;
    // After the re-snap, not on the raw resize: the host's own resize listener
    // runs first and would read the pre-snap edge.
    emitGeometryChange();
  });

  const api = {
    mount, open, hide, show, toggle, toggleFullSize, close, isOpen, isHidden, isFull, setDefaultSize,
    setTitle, makeBtn, flash,
    recede, recedeForSend, reportThreads, evaluateReturn, cancelReturn,
    get shell() { return shell; },
    get bar() { return bar; },
    get barLeft() { return barLeft; },
    get barRight() { return barRight; },
    get content() { return content; },
    get titleEl() { return titleEl; },
  };
  return api;
}

module.exports = { createViewerBand, userIsTyping, setTypingProbe, setAgentIdle };
