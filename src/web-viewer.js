// Embedded web page viewer — hosts a remote page (or a local review .html)
// inside a <webview>, opened by plain-clicking a URL in terminal output. The
// chrome (band shell, bar, hide/show/close, sizing, hue) is the shared
// viewer-band; this only provides the webview content + nav buttons. There is no
// commenting here — the review overlay lives in the webview preload
// (web-viewer-preload.js), which runs inside the guest page and talks to main.
//
// Navigation is intentionally minimal — back / forward / reload / close, no
// address bar — because the URL arrives from the terminal, not typed.
// Requires webviewTag:true on the host BrowserWindow (set in main.js).

const { createViewerBand } = require('./viewer-band');
const { isFindShortcut } = require('./search-shortcut');

function normalizeHttpUrl(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw.trim());
    // http(s) for remote pages; file: for local pages (e.g. review HTML).
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function ensureWebStyles() {
  if (document.getElementById('web-viewer-style')) return;
  const style = document.createElement('style');
  style.id = 'web-viewer-style';
  // The webview fills the band's content slot. White backstop so a loading page
  // doesn't flash the band's dark shell.
  style.textContent = `
    .web-viewer-view { width: 100%; height: 100%; border: 0; background: #dadde1; }
    .web-find { position: absolute; top: 8px; right: 16px; z-index: 10; display: none;
      align-items: center; gap: 6px; background: #fff; border: 1px solid #d1d9e0;
      border-radius: 8px; padding: 5px 8px; box-shadow: 0 4px 14px rgba(31,35,40,.18);
      font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .web-find input { border: 0; outline: 0; font: inherit; width: 170px; background: transparent; color: #1f2328; }
    .web-find-count { color: #6e7781; min-width: 46px; text-align: right; font-variant-numeric: tabular-nums; }
    .web-find button { border: 0; background: #f6f8fa; color: #1f2328; border-radius: 5px;
      cursor: pointer; font: inherit; padding: 2px 7px; line-height: 1; }
    .web-find button:hover { background: #eef1f4; }
  `;
  document.head.appendChild(style);
}

function createWebViewer({ onOpen, onClose, onDeviceAuthBlock, onShortcut, getTerminalGrid, getPreloadUrl, platform } = {}) {
  let view = null;
  let backBtn = null;
  let fwdBtn = null;
  let copyBtn = null;
  let navReady = false;
  let destroyTimer = null;
  let entryUrl = null;       // the url passed to open() — what we route to the browser on a block
  let blockedFired = false;  // fire onDeviceAuthBlock at most once per open()
  // A full-size review send receded to golden; resume full when the guest reports
  // the agent's turn over. Same loop as the md viewer (see maybeResumeFullSize
  // there); here the guest owns the store, so it reports state over IPC instead.
  let resumeFullPending = false;
  // A <webview> is a separate document host CSS can't reach, so its page renders the OS-native
  // scrollbar — the classic wide bar on Windows, while the host's terminal/md panes are styled
  // thin. Inject a matching slim scrollbar into the guest on each load so the viewer is
  // consistent across platforms. Cosmetic only; a neutral translucent thumb reads on light/dark.
  const GUEST_SCROLLBAR_CSS =
    '::-webkit-scrollbar{width:11px;height:11px}' +
    '::-webkit-scrollbar-track{background:transparent}' +
    '::-webkit-scrollbar-thumb{background:rgba(128,128,128,.45);border-radius:7px;border:2px solid transparent;background-clip:content-box}' +
    '::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.7);background-clip:content-box}' +
    '::-webkit-scrollbar-corner{background:transparent}';

  // The web/review viewer takes the major share (62vh), leaving the terminal's
  // live tail below. Close GC's the webview after the fade (the persistent
  // partition keeps the login; reopening builds a fresh page).
  const band = createViewerBand({
    name: 'web',
    share: 'major',
    bg: '#16181c',
    minHeight: 280,
    closeTitle: 'Close (free memory)',
    getTerminalGrid,
    // Rolling up hides the page, so its find bar — absolutely positioned over the
    // band — must not stay floating over the collapsed strip.
    onHide: () => closeFind(),
    onClose: () => {
      closeFind();
      resumeFullPending = false;
      if (destroyTimer) clearTimeout(destroyTimer);
      destroyTimer = setTimeout(() => { destroyView(); destroyTimer = null; }, 200);
      if (typeof onClose === 'function') onClose();
    },
  });

  function refreshNav() {
    if (!view) return;
    try {
      backBtn.disabled = !view.canGoBack();
      fwdBtn.disabled = !view.canGoForward();
    } catch {}
  }

  function safeUrl() {
    try { return view.getURL() || ''; } catch { return ''; }
  }

  // Copy the current page URL to the clipboard, with brief inline ✓ feedback. Bound to the
  // bar's ⧉ button (the discoverable path) and to right-clicking the bar (free, matches the
  // muscle memory). The button is recreated per session; copyBtn may be null before nav setup.
  let copyResetTimer = null;
  function copyUrl() {
    const url = safeUrl();
    if (!url) return;
    try { navigator.clipboard.writeText(url); } catch {}
    if (!copyBtn) return;
    copyBtn.textContent = '✓';
    copyBtn.title = 'Copied';
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copyBtn.textContent = '⧉'; copyBtn.title = 'Copy URL'; copyResetTimer = null;
    }, 1000);
  }

  // Device-compliance / Conditional Access dead-ends — where the IdP demands a managed,
  // compliant, or registered device — can't be satisfied here: the webview has no Windows
  // device-auth broker (unlike Edge). When an SSO redirect lands on one, hand the ORIGINAL
  // clicked url back so the host can route it to the system browser and tear this down.
  //
  // IdP-agnostic on purpose, but it must PRESERVE the one-time in-viewer login:
  // fire only on (1) an auth/SSO host — so content pages that merely mention these terms
  // aren't scraped — AND (2) a hard device-wall signature, never a plain login form (which the
  // viewer can complete, its cookie persisting). The signal is in the page body, not the URL
  // (Entra: "AADSTS53000" / "Error Code: 53000"; others phrase it). \b guards 6-digit codes.
  const AUTH_HOST_RE = /(^|[.-])(login|signin|sso|auth|adfs|idp|sts|accounts?|oauth|openid)([.-]|$)|microsoftonline|\bokta\b|onelogin|pingidentity|auth0|duosecurity|secureauth/i;
  const DEVICE_BLOCK_RE = /(?:AADSTS|error\s*code[:\s]\s*)5300[01]\b|conditional access|compliant device|managed device|registered device|device (?:is ?n.t|is not|must be|needs to be)[^.]{0,24}(?:registered|compliant|managed|enrolled|trusted)|enroll[a-z]*[^.]{0,16}device|beyondcorp|untrusted device/i;
  function checkDeviceAuthBlock() {
    if (blockedFired || !view || typeof onDeviceAuthBlock !== 'function') return;
    let host = '';
    try { host = new URL(safeUrl()).host; } catch { return; }
    if (!AUTH_HOST_RE.test(host)) return;
    view.executeJavaScript('(document.body && document.body.innerText || "").slice(0, 40000)').then((text) => {
      if (blockedFired || typeof text !== 'string' || !DEVICE_BLOCK_RE.test(text)) return;
      blockedFired = true;
      onDeviceAuthBlock(entryUrl);
    }).catch(() => {});
  }

  // Self-review pages get their comment overlay from the webview preload, which
  // reads/writes the store itself. The host only nudges it to re-read (e.g. after
  // the agent wrote replies to disk). No-op until the guest's preload is live.
  function pingReviewRefresh() {
    if (!view) return;
    try { view.send('rv-refresh'); } catch {}
  }

  // Mirror the host's agent-working state (the body class the renderer drives
  // off PTY activity) into the guest, where the overlay pulses its awaiting
  // rows — the guest can't see the host DOM. Sent on change and on each load
  // (a fresh guest starts without the class).
  let lastWorkingSent = null;
  function pushWorkingState(force) {
    if (!view) return;
    const on = document.body.classList.contains('agent-working');
    if (!force && on === lastWorkingSent) return;
    lastWorkingSent = on;
    try { view.send('rv-working', on); } catch {}
  }
  const workingObserver = new MutationObserver(() => pushWorkingState(false));
  workingObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  function ensureNavButtons() {
    if (navReady) return;
    backBtn = band.makeBtn('◀', 'Back', () => { try { view && view.goBack(); } catch {} });
    fwdBtn = band.makeBtn('▶', 'Forward', () => { try { view && view.goForward(); } catch {} });
    // Hard reload: the user reaches for ⟳ when the page looks wrong, and the wrongness can
    // live in the partition's disk cache (e.g. an index page cached under its original
    // application/xhtml+xml content-type — see normalizeViewerContentType in main.js). A
    // cache-bypassing refetch replaces the poisoned entry while cookies (the login) survive.
    const reloadBtn = band.makeBtn('⟳', 'Reload', () => { try { view && view.reloadIgnoringCache(); } catch {} });
    copyBtn = band.makeBtn('⧉', 'Copy URL', copyUrl);
    band.barLeft.append(backBtn, fwdBtn, reloadBtn, copyBtn);
    try { band.bar.addEventListener('contextmenu', (e) => { e.preventDefault(); copyUrl(); }); } catch {}
    navReady = true;
  }

  function ensureView() {
    if (view) return;
    band.mount();
    ensureWebStyles();
    ensureNavButtons();
    view = document.createElement('webview');
    view.className = 'web-viewer-view';
    // Persistent partition → clear an SSO wall once; cookies survive teardown.
    view.setAttribute('partition', 'persist:webviewer');
    // Keep allowpopups: it's what routes a target=_blank / window.open through
    // main's window-open handler, which denies the window and sends the URL to the
    // system browser. Without it Chromium blocks the popup before that handler
    // runs, and the click dies silently.
    view.setAttribute('allowpopups', '');

    view.addEventListener('did-navigate', () => { band.setTitle(safeUrl()); refreshNav(); });
    view.addEventListener('did-navigate-in-page', refreshNav);
    view.addEventListener('page-title-updated', (e) => {
      band.setTitle(e.title ? `${e.title} — ${safeUrl()}` : safeUrl());
    });
    view.addEventListener('dom-ready', () => {
      refreshNav();
      try { view.insertCSS(GUEST_SCROLLBAR_CSS).catch(() => {}); } catch {}
      pushWorkingState(true);
    });
    // In-page find results → update the count.
    view.addEventListener('found-in-page', (e) => {
      if (!findCount) return;
      const r = (e && e.result) || {};
      findCount.textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : 'No results';
    });
    // Cmd/Ctrl+F inside the guest page is forwarded here (the guest is focused, so
    // the host's xterm key handler never sees it) → open the find bar. Only while
    // the page is on screen — never over a collapsed strip.
    view.addEventListener('ipc-message', (e) => {
      if (e.channel === 'rv-find' && band.isOpen()) openFind();
      if (e.channel === 'viewer-shortcut' && typeof onShortcut === 'function') {
        const action = e.args && e.args[0];
        if (action === 'selector' || action === 'toggle' || action === 'size') onShortcut(action);
      }
      // A review send hands the turn to the agent. At full size that leaves the
      // user blind to the pickup, so recede to the golden split — the terminal
      // slides in underneath with the pasted pointer prompt (the receipt) — and
      // arm the resume, since full was the user's choice.
      if (e.channel === 'rv-sent' && band.isFull()) {
        band.toggleFullSize();
        resumeFullPending = true;
      }
      // The guest re-reads the store on every refresh and reports where the
      // agent's turn stands. One-shot at the moment it turns: the flag clears
      // whether or not motion happens, and motion only if the band is open at
      // golden — a band the user hid or resized stays where their hand put it.
      if (e.channel === 'rv-threads-state' && resumeFullPending) {
        const s = e.args && e.args[0];
        if (s && s.agentTurnOver) {
          resumeFullPending = false;
          if (band.isOpen() && !band.isFull()) band.toggleFullSize();
        }
      }
    });
    // Each finished load on a Microsoft login host is checked for a device-compliance block.
    view.addEventListener('did-finish-load', checkDeviceAuthBlock);

    band.content.appendChild(view);
  }

  // --- in-page find (Cmd+F) — the web viewer's own find, since the terminal/md
  // search scopes don't cover the webview and the guest swallows the keystroke. ---
  let findBar = null, findInput = null, findCount = null, findQuery = '';
  function ensureFindBar() {
    if (findBar || !band.shell) return;
    findBar = document.createElement('div');
    findBar.className = 'web-find';
    findInput = document.createElement('input');
    findInput.type = 'text';
    findInput.placeholder = 'Find in page';
    findInput.spellcheck = false;
    findCount = document.createElement('span');
    findCount.className = 'web-find-count';
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.textContent = label; b.title = title;
      b.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep input focus
      b.addEventListener('click', fn);
      return b;
    };
    findBar.append(findInput, findCount,
      mk('‹', 'Previous (Shift+Enter)', () => step(false)),
      mk('›', 'Next (Enter)', () => step(true)),
      mk('✕', 'Close', closeFind));
    findInput.addEventListener('input', () => doFind(findInput.value));
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); step(!e.shiftKey); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); findInput.select(); }
    });
    band.shell.appendChild(findBar);
  }
  function openFind() {
    ensureFindBar();
    if (!findBar) return;
    findBar.style.display = 'flex';
    findInput.focus(); findInput.select();
    if (findInput.value) doFind(findInput.value);
  }
  function closeFind() {
    if (!findBar || findBar.style.display === 'none') return;
    findBar.style.display = 'none';
    findQuery = '';
    if (findCount) findCount.textContent = '';
    try { if (view) view.stopFindInPage('clearSelection'); } catch {}
    // Hand focus back to the page only while it's on screen — closing the bar as
    // the band rolls up (or closes) must not focus the hidden guest.
    try { if (view && band.isOpen()) view.focus(); } catch {}
  }
  function doFind(q) {
    findQuery = q;
    if (!q) { try { if (view) view.stopFindInPage('clearSelection'); } catch {} if (findCount) findCount.textContent = ''; return; }
    try { if (view) view.findInPage(q); } catch {}
  }
  function step(forward) {
    if (!findQuery || !view) return;
    try { view.findInPage(findQuery, { findNext: true, forward: forward }); } catch {}
  }
  // Esc closes the find bar first, beating the band's Esc-to-hide: a window-capture
  // listener fires before the band's document-capture one.
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !findBar || findBar.style.display === 'none') return;
    e.preventDefault();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    closeFind();
  }, true);
  // Cmd/Ctrl+F while the viewer is open opens find here too — mirroring the md
  // viewer, so it works when a host element (the terminal) is focused, not only
  // when the webview is (that case is the guest preload forwarding 'rv-find').
  // Capture + stopImmediate so it beats the terminal's xterm key handler.
  document.addEventListener('keydown', function (e) {
    if (!band.isOpen() || !isFindShortcut(e, platform)) return;
    e.preventDefault();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    openFind();
  }, true);

  function destroyView() {
    if (heldReloadTimer) { clearTimeout(heldReloadTimer); heldReloadTimer = null; }
    if (!view) return;
    try { view.remove(); } catch {}
    view = null;
  }

  // `review: true` marks a rendered review package (the renderer knows at the
  // review:// seam). A review is a doc the user works in — like the md viewer,
  // a fresh reveal takes the full screen. A plain clicked URL stays golden: a
  // glance beside the session, not a takeover.
  function open(rawUrl, { review = false } = {}) {
    const target = normalizeHttpUrl(rawUrl);
    if (!target) return false;
    band.setDefaultSize(review ? 'full' : 'golden');
    resumeFullPending = false; // a new page is a fresh start; no stale resume
    entryUrl = target;
    blockedFired = false;
    if (destroyTimer) { clearTimeout(destroyTimer); destroyTimer = null; }
    // A reload held for a composer on the previous page must not fire on this one.
    if (heldReloadTimer) { clearTimeout(heldReloadTimer); heldReloadTimer = null; }
    ensureView();
    band.open();
    band.setTitle(target);
    // Attach the comment-overlay preload before the first navigation so it's live
    // for review pages. If it's not ready on the very first click the overlay
    // simply waits for reopen.
    const purl = typeof getPreloadUrl === 'function' ? getPreloadUrl() : null;
    if (purl && view.getAttribute('preload') !== purl) view.setAttribute('preload', purl);
    // Each clicked URL is a normal navigation, so back returns to the previous
    // page. Navigate via src (reliable pre-dom-ready).
    view.setAttribute('src', target);
    if (typeof onOpen === 'function') onOpen(target);
    return true;
  }

  // Reload the current page (review auto-refresh after the agent edits the
  // package); the comment-overlay preload re-runs and re-reads the store. Pulse
  // the band so the auto-reload is noticed — same flash the md viewer uses.
  //
  // A full reload wipes the guest page, INCLUDING a comment draft mid-typing.
  // So first ask the guest whether a composer is open, and if so hold the
  // reload, retrying until the draft is sent/committed/cancelled — the same
  // policy as the md viewer (pendingRefreshResult waits out an open card) and
  // the terminal (output freezes while commenting). Every composer exit is a
  // user action (click-away commits the draft), so nothing is ever dropped.
  // The band's manual ⟳ stays immediate (and cache-bypassing): explicit user action.
  // On any check failure, fall through to reloading — never hold forever.
  const GUEST_COMPOSING_CHECK =
    "!!document.querySelector('.rv-quote-compose, .rv-compose-row, .rv-replybox, .rv-edit-compose')";
  let heldReloadTimer = null;
  function reload() {
    if (heldReloadTimer) { clearTimeout(heldReloadTimer); heldReloadTimer = null; }
    if (!view) return;
    let composing = null;
    try { composing = view.executeJavaScript(GUEST_COMPOSING_CHECK); } catch {}
    Promise.resolve(composing).catch(() => false).then((busy) => {
      if (busy && view) { heldReloadTimer = setTimeout(reload, 1500); return; }
      try { band.flash(); if (view) view.reload(); } catch {}
    });
  }
  // Nudge the guest overlay to re-read the comment store IN PLACE (agent reply arrived) — the
  // pulse path, no reload. Only meaningful on a review page; a no-op otherwise. While rolled
  // up the guest's thread pulse plays off-screen, so flash the handle — the band-level cue.
  function pingRefresh() {
    if (band.isHidden()) band.flash();
    pingReviewRefresh();
  }

  // Returning to the window nudges the overlay to re-read the comment store.
  window.addEventListener('focus', () => { if (band.isOpen()) pingReviewRefresh(); });

  return {
    open,
    reload,
    pingRefresh,
    close: () => band.close(),
    hide: () => band.hide(),
    show: () => band.show(),
    toggle: () => band.toggle(),
    toggleFullSize: () => band.toggleFullSize(),
    // Open OR rolled-up (hidden) both mean this viewer owns the band — so mutual
    // exclusion (closeWebViewer / anyViewerOpen) still acts on a collapsed viewer
    // instead of leaving its handle stacked under the other viewer. Matches the md
    // viewer's isOpen(). (Internal strict-open checks use band.isOpen() directly.)
    isOpen: () => band.isOpen() || band.isHidden(),
  };
}

module.exports = { createWebViewer, normalizeHttpUrl };
