const { Terminal } = require('@xterm/xterm');
const { WebglAddon } = require('@xterm/addon-webgl');
const { FitAddon } = require('@xterm/addon-fit');
const uFuzzy = require('@leeoniya/ufuzzy');
const {
  getSearchNavigationState,
  getSearchCountText,
  shouldNavigateSearchResults,
} = require('./search-ui-state');
const { extractDroppedPaths, hasSupportedPathDropType } = require('./drag-drop-paths');
const { handleTerminalKeydown } = require('./terminal-keyboard');
const { beginDecorationPress, resolveDecorationPress, decorationPressOptions, DEFAULT_DRAG_THRESHOLD_PX } = require('./terminal-decoration-press');
const { attachTerminalMouseShortcuts } = require('./terminal-mouse');
const { navigationNeedsModifier, hasNavigationModifier, matchForPress, markedLength } = require('./terminal-nav-destination');
const {
  DEFAULT_SELECTION_CONTEXT_LINES,
  buildTerminalCommentBatchMessage,
  buildTerminalCommentMessage,
} = require('./terminal-annotations');
const { createPicker } = require('./sessions-picker');
const { createViewerSelector } = require('./viewer-selector');
const chromeBar = require('./chrome-bar');
const resumeHint = require('./resume-hint');
const streamWatch = require('./stream/renderer-watch');
const streamIndicator = require('./stream/stream-indicator');
const { createHttpUrlOpener } = require('./url-open');
const { createWebViewer } = require('./web-viewer');
const { createMarkdownViewer } = require('./markdown-viewer');
const { createComposer, isPasteCommentShortcut } = require('./comment-ui');
const {
  ViewerHistory,
  ViewerStreamAccumulator,
  ViewerValidationMemory,
  collectBufferViewerCandidates,
  sameViewer,
  viewerFileUrlToPath,
} = require('./viewer-history');

// Custom title-bar / chrome bar — replaces the old session-banner row and
// the Electron application menu. Mounts once on load and updates in place
// whenever main pushes a chrome-state payload (hue / cli / prompt / isWorking).
chromeBar.mount({
  onContextMenu: () => { try { window.pty.chromeBarContextMenu(); } catch {} },
});

// Streaming indicator (status dot + toasts on transitions).
streamIndicator.init();
window.pty.onChromeState((payload) => {
  chromeBar.update(payload);
  // Re-fit the terminal in case the chrome height was applied (mac fallback path).
  setTimeout(() => { try { fitAddon.fit(); } catch {} }, 0);
});

// Sessions picker — main process pushes the snapshot once on startup.
let activePicker = null;
function closeActivePicker() {
  if (activePicker) {
    try { activePicker.destroy(); } catch {}
    activePicker = null;
    try { clearTerminalSelection(); } catch {}
    try { hideTerminalSelectionCommentHint(); } catch {}
    // Hand keyboard focus back to the terminal so the user can interact with
    // whatever the CLI launches (prompts, "do you trust this dir?", etc.)
    // without having to click first.
    try { terminal.focus(); } catch {}
  }
}
window.pty.onShowPicker((payload) => {
  closeActivePicker();
  try { clearTerminalSelection(); } catch {}
  try { hideTerminalSelectionCommentHint(); } catch {}
  const { sessions = [], activeIds = [] } = payload || {};
  activePicker = createPicker({
    sessions,
    activeIds,
    startHiddenPromptSearch: (payload) => window.pty.startHiddenPromptSearch(payload),
    cancelHiddenPromptSearch: (requestId) => window.pty.cancelHiddenPromptSearch(requestId),
    onPick: (id) => {
      // Surface the resume hint immediately — the CLI's resume dialog
      // may search against either the prompt we show in the chrome line
      // or the AI-emitted title shown inside the CLI's own resume UI.
      const picked = sessions.find(s => s.id === id);
      window.pty.pickerPick(id);
      if (picked) {
        resumeHint.show({
          cli: picked.cli,
          prompt: picked.prompt,
          title: picked.initialTitle || picked.title,
        });
      }
      closeActivePicker();
    },
    onStartNew: (cli) => { window.pty.pickerStartNew(cli); closeActivePicker(); },
    onClose: () => { window.pty.pickerClose(); closeActivePicker(); },
  });
});
window.pty.onHiddenPromptSearchProgress((payload) => {
  if (activePicker && typeof activePicker.handleHiddenSearchProgress === 'function') {
    activePicker.handleHiddenSearchProgress(payload);
  }
});
window.pty.onResumeHintSubmit(() => {
  resumeHint.recordSubmit();
});

const openHttpUrl = createHttpUrlOpener({
  openURL: (url) => window.pty.openURL(url),
  log: (message) => console.info(message),
});

// Embedded web page viewer (band hosting a <webview>). Plain-clicked URLs open
// here; Ctrl/Cmd-click falls through to openHttpUrl (system browser). Lazily
// built on first use so the DOM/webview cost is only paid if a URL is clicked.
// The webview's comment-overlay preload lives in the asar; main resolves its
// file:// URL. Fetch it once at startup so it's cached before the first click;
// the web viewer reads it via getPreloadUrl when creating the <webview>.
let webviewPreloadUrl = null;
if (window.pty && typeof window.pty.getWebviewPreloadUrl === 'function') {
  window.pty.getWebviewPreloadUrl().then((u) => { webviewPreloadUrl = u || null; }).catch(() => {});
}

let webViewer = null;
function dismissResumeHintOnViewerOpen() {
  resumeHint.destroy();
}

function getWebViewer() {
  if (!webViewer) {
    webViewer = createWebViewer({
      onOpen: dismissResumeHintOnViewerOpen,
      // Lets the collapsed handle snap its bottom edge to a terminal row
      // boundary so the row peeking below it isn't chopped mid-line.
      getTerminalGrid: () => {
        const rect = screenElement.getBoundingClientRect();
        const rows = Math.max(1, terminal.rows);
        return { top: rect.top, cellHeight: rect.height / rows };
      },
      // Self-review comment overlay (Track B): the webview preload reads/writes
      // the store itself; the host only supplies its URL.
      getPreloadUrl: () => webviewPreloadUrl,
      // For the viewer's own Cmd/Ctrl+F (find-in-page) shortcut detection.
      platform: window.pty.platform,
      onNavigateHistory: (action) => { handleViewerHistoryAction(action); },
      // Closing the viewer (GC) → tell main to stop the review auto-refresh.
      onClose: () => {
        if (!suppressViewerEvict) clearViewerCache(); // user ✕ → forget the cache
        try { window.pty.reviewViewerClosed && window.pty.reviewViewerClosed(); } catch {}
      },
      // The viewer hit an Entra device-compliance block it can't pass (see web-viewer's
      // checkDeviceAuthBlock): route the original url to the system browser, tear the band
      // down, drop it from the cache, and remember the host so repeat clicks skip the webview.
      onDeviceAuthBlock: (blockedUrl) => {
        const host = urlHost(blockedUrl);
        if (host) deviceGatedHosts.add(host);
        dropViewer(blockedUrl);
        closeWebViewer();
        routeToSystemBrowser(blockedUrl);
        showToast('Requires a managed device — opened in browser');
      },
    });
  }
  return webViewer;
}

// One ordered history across every individual URL, review, and markdown doc.
// The history owns a stable cursor: explicit opens become newest, while shortcut
// traversal selects without re-recording, so walking A -> B -> C never mutates
// into the old A/B ping-pong. Entries dedupe by exact viewer identity, not kind.
const viewerHistory = new ViewerHistory({ limit: 100 });
const viewerValidationMemory = new ViewerValidationMemory();
function recordViewer(kind, key) {
  viewerHistory.record({ kind, key });
}

// ✕ on a band = "done": close it and forget the whole recents cache (re-seedable from
// the stream on the next Ctrl+Shift+O). Guarded so the PROGRAMMATIC switch-closes below
// don't trip it — a switch must keep the cache so you can still cycle back. onClose runs
// synchronously inside close(), so the flag is set only for the duration of the close.
let suppressViewerEvict = false;
function clearViewerCache() { viewerHistory.clear(); }
function dropViewer(key) {
  for (const entry of viewerHistory.entries()) {
    if (entry.key === key) viewerHistory.remove(entry);
  }
}

// Hosts that dead-ended on a Microsoft Entra device-compliance / Conditional Access block
// this session (AADSTS53000/53001): the webview has no Windows device-auth broker, so it
// can't pass. Remembering the host means the FIRST hit flashes-then-routes to the system
// browser (which brokers device auth) and every repeat click skips the webview entirely.
const deviceGatedHosts = new Set();
function urlHost(u) { try { return new URL(u).host.toLowerCase(); } catch { return ''; } }
function routeToSystemBrowser(url) {
  if (/^file:/i.test(url)) return window.pty.openURL(url);
  return openHttpUrl(url, 'device-auth');
}

// One band at a time: close the other before showing this one. This fires the other
// band's onClose — the same hook a user ✕ uses — so suppress eviction across it.
function closeMarkdownViewer() {
  suppressViewerEvict = true;
  try { if (markdownViewer && markdownViewer.isOpen && markdownViewer.isOpen()) markdownViewer.close(); }
  catch {} finally { suppressViewerEvict = false; }
}
function closeWebViewer() {
  suppressViewerEvict = true;
  try { if (webViewer && webViewer.isOpen && webViewer.isOpen()) webViewer.close(); }
  catch {} finally { suppressViewerEvict = false; }
}
// True if either band (web / markdown) is currently showing something.
function anyViewerOpen() {
  try { if (webViewer && webViewer.isOpen && webViewer.isOpen()) return true; } catch {}
  try { if (markdownViewer && markdownViewer.isOpen && markdownViewer.isOpen()) return true; } catch {}
  return false;
}

// Plain click → embedded band; Ctrl/Cmd/Alt-click → system browser. Returns
// true when the embed handled it. `external` is the modifier verdict from the
// click site.
function openUrlFromTerminal(url, source, external, { recordHistory = true } = {}) {
  // review:// → render the agent's package via the bundled renderer, then open
  // the rendered page in the viewer (and route any issues back to the agent).
  if (/^review:\/\//i.test(url)) {
    closeMarkdownViewer();
    renderAndOpenReview(url);
    if (recordHistory) recordViewer('review', url);
    return true;
  }
  // A host already known to be device-gated (Entra CA) can't pass in the webview — skip the
  // band entirely and go straight to the system browser. No viewer, no cache.
  if (!external && deviceGatedHosts.has(urlHost(url))) {
    routeToSystemBrowser(url);
    showToast('Requires a managed device — opened in browser');
    return true;
  }
  if (!external) {
    try {
      if (getWebViewer().open(url)) {
        closeMarkdownViewer();
        if (recordHistory) recordViewer('url', url);
        return true;
      }
    } catch (err) {
      console.warn('[web-viewer] open failed, falling back to external', err);
    }
  }
  // External (or the viewer declined): system browser / handler. openHttpUrl
  // only passes http(s); file: URLs go straight to the OS opener.
  if (/^file:/i.test(url)) return window.pty.openURL(url);
  return openHttpUrl(url, source);
}

// review:// handler: render the package, open the rendered page, and feed any
// structural issues back to the agent (the auto-correction loop).
async function renderAndOpenReview(reviewUrl) {
  let pkgPath = '';
  try { pkgPath = decodeURIComponent(reviewUrl.replace(/^review:\/\//i, '')).trim(); } catch {}
  if (!pkgPath) { showToast('review:// link has no package path'); return false; }
  showToast('Rendering review…');
  let res;
  try {
    res = await window.pty.renderReviewPackage(pkgPath);
  } catch (err) {
    console.warn('[review] render failed', err);
    showToast('Render failed', { variant: 'error' });
    return false;
  }
  // Always open the viewer — even an unusable package (base: or missing scope)
  // opens to a red error page that says the agent's been notified, and that page
  // re-renders itself into the real review once they fix it. So a rejected link is
  // never a dead end the user has to re-click. The auto-refresh watch
  // (startReviewSync in main) is already running for this package; when the agent
  // repairs it the open view reloads in place and flashes. (Dirty / commit
  // mismatch never rejects — it opens a normal review carrying a live banner.)
  let opened = false;
  if (res && res.htmlPath) {
    try {
      const u = await window.pty.resolveFileUrl(res.htmlPath);
      if (u && u.success && u.url) opened = getWebViewer().open(u.url);
    } catch (err) {
      console.warn('[review] open failed', err);
    }
  }
  // Never auto-prompt the agent — any problem surfaces as an in-page banner with a
  // Notify button (the scope-error page, the out-of-date banner), pinged only on click.
  if (res && res.reject) {
    showToast('Review needs a fix — see the banner');
  } else if (!res || !res.ok) {
    showToast((res && res.error) || 'Render failed', { variant: 'error' });
  } else {
    showToast('Review opened');
  }
  return opened;
}

// Raw PTY capture is the durable source for full-screen TUIs: alternate buffers
// have no scrollback and repaint old rows away. The accumulator carries chunk
// boundaries, removes terminal control styling, retains OSC 8 URL targets, and
// records every individual URL/markdown candidate rather than one per type.
const streamViewerCandidates = new ViewerStreamAccumulator({ limit: 100 });
const seenReviewUrls = new Set();

function captureViewerCandidates(data) {
  const captured = streamViewerCandidates.push(data);
  for (const entry of captured) {
    viewerValidationMemory.observe(entry);
    if (entry.kind !== 'review' || seenReviewUrls.has(entry.key) || !looksLikeRealViewerUrl(entry.key)) continue;
    seenReviewUrls.add(entry.key);
    // First sighting captures the reviewed branch and auto-opens a real package.
    try { window.pty.captureReviewBranch(entry.key); } catch {}
    maybeAutoOpenReview(entry.key);
  }
}

// Auto-open a freshly-printed review:// so the user needn't click the link.
// Guards, in order: (1) once per URL per session; (2) the .md must actually
// exist — a stale or hypothetical path is skipped silently, never popped or
// toasted (the "md path is not valid" corner case); (3) if a viewer is already
// open, don't yank it away — just toast that a review is ready (the link in the
// terminal stays clickable). The capture site already filtered example links and
// fires this only the first time a URL appears, so this runs once on a fresh print.
const autoOpenedReviews = new Set();
async function maybeAutoOpenReview(url) {
  if (autoOpenedReviews.has(url)) return;
  autoOpenedReviews.add(url);
  let pkgPath;
  try { pkgPath = decodeURIComponent(url.replace(/^review:\/\//i, '')).trim(); } catch { return; }
  let exists = false;
  try { exists = await window.pty.reviewPackageExists(pkgPath); } catch {}
  if (!exists) return;
  if (anyViewerOpen()) {
    showToast('Agent posted a review — click the link to open');
    return;
  }
  openUrlFromTerminal(url, 'auto', false);
}

// Skip only obvious *example* links — an agent or doc writing "review://abc" as
// an illustration, not a real package. No filesystem check: a real review
// package is just an absolute path ending in .md; http(s) opens as-is. A
// file:// URL must name a document (extension after the last slash): bare
// hosts and directories never render as a page, and prose *mentioning* such
// URLs (a terminal conversation about this very filter, say) would otherwise
// seed Ctrl+Shift+O.
function looksLikeRealViewerUrl(url) {
  if (/^review:\/\//i.test(url)) {
    const p = url.replace(/^review:\/\//i, '');
    return /^\//.test(p) && /\.md$/i.test(p);
  }
  if (/^file:\/\//i.test(url)) {
    const path = url.replace(/^file:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
    return /\/[^/]+\.[a-z0-9]{1,8}$/i.test(path);
  }
  return true;
}

// Merge every available source before each navigation. Raw stream history keeps
// alt-screen output after repaint; rendered normal scrollback recovers text that
// search/click can see but raw extraction missed; the live alternate buffer adds
// its current frame. Exact identity de-duplication keeps one stable cursor entry.
function collectDiscoveredViewerCandidates() {
  const combined = [];
  const add = (entry) => {
    if (!entry || !looksLikeRealViewerUrl(entry.key) || viewerValidationMemory.isRejected(entry)) return;
    if (!combined.some((existing) => sameViewer(existing, entry))) combined.push(entry);
  };

  for (const entry of streamViewerCandidates.entries()) add(entry);
  const active = terminal && terminal.buffer && terminal.buffer.active;
  const normal = terminal && terminal.buffer && (terminal.buffer.normal || active);
  if (normal) for (const entry of collectBufferViewerCandidates(normal)) add(entry);
  if (active && active !== normal) {
    for (const entry of collectBufferViewerCandidates(active)) add(entry);
  }
  return combined;
}

// Local candidates must exist. Return the concrete open key for relative md
// paths; remote http(s) URLs are syntactically openable without a cheap probe.
// An ambiguous md name resolves to the same top choice the click chooser lists
// first (repo copy before siblings) — cycling is rapid-fire, so it never
// interrupts with a chooser; the selector and click paths do.
async function resolveViewerEntry(entry) {
  if (!entry) return null;
  if (entry.kind === 'md') {
    try {
      const r = await window.pty.statMarkdownFile(entry.key);
      if (r && r.success && r.path) return { entry, openKey: r.path };
    } catch {}
    return null;
  }
  if (entry.kind === 'review') {
    let packagePath = '';
    try { packagePath = decodeURIComponent(entry.key.replace(/^review:\/\//i, '')).trim(); } catch {}
    if (!packagePath) return null;
    try {
      return await window.pty.reviewPackageExists(packagePath) ? { entry, openKey: entry.key } : null;
    } catch {
      return null;
    }
  }
  if (entry.kind === 'url' && /^file:\/\//i.test(entry.key)) {
    const path = viewerFileUrlToPath(entry.key);
    if (!path) return null;
    try {
      return await window.pty.viewerFileExists(path) ? { entry, openKey: entry.key } : null;
    } catch {
      return null;
    }
  }
  return { entry, openKey: entry.key };
}

function purgeViewerEntry(entry) {
  viewerValidationMemory.reject(entry);
  viewerHistory.remove(entry);
  if (typeof streamViewerCandidates.remove === 'function') streamViewerCandidates.remove(entry);
}

// Re-open without recording again. Shortcut traversal must move only the
// cursor; explicit terminal clicks still call recordViewer through the normal
// open paths and become the newest entry.
async function openViewerFromHistory(entry, openKey) {
  if (!entry) return false;
  if (entry.kind === 'md') {
    closeWebViewer();
    const opened = await getMarkdownViewer().open({ filePath: openKey || entry.key });
    if (!opened) return false;
  } else if (entry.kind === 'review') {
    closeMarkdownViewer();
    if (!(await renderAndOpenReview(entry.key))) return false;
  } else {
    const opened = await Promise.resolve(
      openUrlFromTerminal(entry.key, 'recent', false, { recordHistory: false })
    );
    if (!opened) return false;
  }
  viewerHistory.select(entry);
  return true;
}

async function navigateViewerHistory(direction) {
  const move = direction === 'forward' ? 'forward' : 'back';
  viewerHistory.merge(collectDiscoveredViewerCandidates());
  const candidates = viewerHistory.traverse(move);
  if (!candidates.length) {
    showToast(viewerHistory.entries().length ? `No ${move === 'back' ? 'older' : 'newer'} viewer` : 'No viewer to open');
    return;
  }

  for (const candidate of candidates) {
    const resolved = await resolveViewerEntry(candidate);
    if (!resolved) { purgeViewerEntry(candidate); continue; }
    if (!(await openViewerFromHistory(candidate, resolved.openKey))) {
      purgeViewerEntry(candidate);
      continue;
    }
    const entries = viewerHistory.entries();
    const index = entries.findIndex((entry) => sameViewer(entry, candidate));
    if (entries.length > 1 && index >= 0) showToast(`${index + 1}/${entries.length}`);
    return;
  }
  showToast(viewerHistory.current ? `No ${move === 'back' ? 'older' : 'newer'} viewer` : 'No viewer to open');
}

// Serialize repeated keypresses so a slow filesystem check cannot make two
// presses race from the same cursor position.
let viewerNavigationQueue = Promise.resolve();
function queueViewerHistoryNavigation(direction) {
  viewerNavigationQueue = viewerNavigationQueue
    .then(() => navigateViewerHistory(direction))
    .catch((error) => console.warn('[viewer-history] navigation failed', error));
}

// Viewer selector (Cmd/Ctrl+Shift+U) — the same merged candidate list the
// O/I chords cycle through, but as a filterable overlay: type any fragment of
// the URL/path instead of chording past every intermediate entry.
let activeViewerSelector = null;
function closeViewerSelector() {
  if (!activeViewerSelector) return;
  try { activeViewerSelector.destroy(); } catch {}
  activeViewerSelector = null;
  // Hand keyboard focus back to the terminal, matching the sessions picker.
  try { terminal.focus(); } catch {}
}

function toggleViewerSelector() {
  if (activeViewerSelector) { closeViewerSelector(); return; }
  viewerHistory.merge(collectDiscoveredViewerCandidates());
  const entries = viewerHistory.entries();
  if (!entries.length) { showToast('No viewer to open'); return; }
  activeViewerSelector = createViewerSelector({
    entries,
    current: viewerHistory.current,
    onPick: (entry) => {
      closeViewerSelector();
      viewerNavigationQueue = viewerNavigationQueue
        .then(() => openViewerSelection(entry))
        .catch((error) => console.warn('[viewer-selector] open failed', error));
    },
    onRemove: (entry) => { purgeViewerEntry(entry); },
    onClose: () => { closeViewerSelector(); },
  });
}

// A dead entry is purged and reported, never silently skipped — unlike cycling
// there is no "next" candidate the user asked for.
//
// An md pick is an explicit gesture, so it gets the click path's ambiguity
// treatment: a bare name with several same-named files surfaces the chooser
// instead of silently opening the resolver's top choice (which is what the
// chooser-less O/I cycle takes). Dismissing the chooser neither purges nor
// toasts — the user saw the matches and declined.
async function openViewerSelection(entry) {
  if (entry.kind === 'md') {
    const choice = await window.pty.resolveMarkdownChoices(entry.key);
    if (choice && (choice.path || Array.isArray(choice.choices))) {
      let openKey = choice.path;
      if (!openKey) {
        openKey = await showPathChooser(choice.choices);
        if (!openKey) return;
      }
      if (await openViewerFromHistory(entry, openKey)) return;
    }
    purgeViewerEntry(entry);
    showToast(`Couldn't locate ${entry.key}`, { variant: 'error' });
    return;
  }
  const resolved = await resolveViewerEntry(entry);
  if (resolved && await openViewerFromHistory(entry, resolved.openKey)) return;
  purgeViewerEntry(entry);
  showToast('Viewer target is gone', { variant: 'error' });
}

// Single entry point for every chord source (main window and webview guest):
// selector toggles the overlay; back/forward dismisses it and cycles.
function handleViewerHistoryAction(action) {
  if (action === 'selector') { toggleViewerSelector(); return; }
  closeViewerSelector();
  queueViewerHistoryNavigation(action);
}

// Legacy channel remains for the existing e2e harness and older main bundles.
window.pty.onOpenRecentViewerUrl(() => { queueViewerHistoryNavigation('back'); });
if (typeof window.pty.onNavigateViewerHistory === 'function') {
  window.pty.onNavigateViewerHistory((action) => { handleViewerHistoryAction(action); });
}

// Auto-refresh: main re-rendered the open review (its package .md changed) →
// reload the viewer so the update shows, with comments re-anchored across it.
if (window.pty && typeof window.pty.onReviewRerendered === 'function') {
  window.pty.onReviewRerendered(() => {
    // Agent-driven reload. If the band was rolled up (terminal input collapses it via
    // withdrawViewersOnInput), show() it first so the reload's flash + diff-line pulse play
    // on-screen instead of on a hidden band — otherwise the agent's change goes unseen.
    try { if (webViewer && webViewer.isOpen && webViewer.isOpen()) { webViewer.show(); webViewer.reload(); } } catch {}
  });
}
// Comments-only change (an agent reply, no source edit) → refresh the overlay IN PLACE so the
// reply surfaces and pulses, without a full reload (which would wipe the pulse baseline).
if (window.pty && typeof window.pty.onReviewCommentsChanged === 'function') {
  window.pty.onReviewCommentsChanged(() => {
    try { if (webViewer && webViewer.isOpen && webViewer.isOpen()) { webViewer.show(); webViewer.pingRefresh(); } } catch {}
  });
}

// Work-branch / lock watcher: main polls the primary folder (git only) and pushes
// warnings here while on a work/<slug> branch — branch switched underneath (incl.
// work→work), lock/agent held by another, or uncommitted changes with
// no lock. A reddish-grey bar stays up while any warning holds and drops when git
// agrees again ('review-branch-synced'). Reset re-baselines to the current branch.
let branchFlash = null;
function ensureBranchFlashStyles() {
  if (document.getElementById('branch-flash-style')) return;
  const st = document.createElement('style');
  st.id = 'branch-flash-style';
  st.textContent = `
    .branch-flash {
      position: fixed; left: 50%; bottom: 0; transform: translateX(-50%) translateY(10px);
      z-index: 10003; display: flex; align-items: center; gap: 12px;
      max-width: calc(100vw - 24px);
      padding: 9px 14px; border: 1px solid #6e5757; border-bottom: 0;
      border-top-left-radius: 8px; border-top-right-radius: 8px;
      background: #574545; color: #f3e9e9;
      font: 12.5px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 -4px 16px rgba(0,0,0,0.35);
      opacity: 0; transition: opacity 320ms ease, transform 320ms ease;
      -webkit-app-region: no-drag;
    }
    .branch-flash.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .branch-flash-msg { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .branch-flash-btn { border: 1px solid #8a6f6f; border-radius: 5px; background: #6b5353;
      color: #f3e9e9; padding: 3px 10px; font: inherit; cursor: pointer; }
    .branch-flash-btn:hover { background: #7a5f5f; }`;
  document.head.appendChild(st);
}
function hideBranchChangedFlash() {
  if (!branchFlash) return;
  const el = branchFlash; branchFlash = null;
  el.bar.classList.remove('show');
  setTimeout(() => { try { el.bar.remove(); } catch {} }, 360);
}
function showBranchChangedFlash(data) {
  const texts = (data && data.texts) || [];
  if (!texts.length) { hideBranchChangedFlash(); return; }
  if (!branchFlash) {
    ensureBranchFlashStyles();
    const bar = document.createElement('div');
    bar.className = 'branch-flash';
    const msg = document.createElement('span');
    msg.className = 'branch-flash-msg';
    const reset = document.createElement('button');
    reset.className = 'branch-flash-btn';
    reset.textContent = 'Reset';
    reset.title = 'Re-baseline to the current branch';
    reset.addEventListener('click', () => { try { window.pty.resetBranchWatch(); } catch {} hideBranchChangedFlash(); });
    bar.append(msg, reset);
    document.body.appendChild(bar);
    branchFlash = { bar, msg, reset };
  }
  branchFlash.msg.textContent = texts.join('   ·   ');
  // Reset only makes sense for a branch-changed warning (it re-baselines the tracked
  // branch); the lock/dirty warnings clear on their own, so hide the button for those.
  branchFlash.reset.style.display = (data && data.resettable) ? '' : 'none';
  requestAnimationFrame(() => { if (branchFlash) branchFlash.bar.classList.add('show'); });
}
if (window.pty && typeof window.pty.onReviewBranchChanged === 'function') {
  window.pty.onReviewBranchChanged((data) => showBranchChangedFlash(data));
}
if (window.pty && typeof window.pty.onReviewBranchSynced === 'function') {
  window.pty.onReviewBranchSynced(() => hideBranchChangedFlash());
}

// When a decoration action handles a press, xterm's OSC 8 activation for the
// same press (it fires on mouseup, after our mousedown) must be suppressed,
// or a URL that is both a visible match and an OSC 8 link opens twice.
let pressConsumedByDecoration = false;

const terminal = new Terminal({
  cursorBlink: true,
  // Alt/Option-click is the search-everywhere chooser on decorations; xterm's
  // default (emit arrow keys to walk the prompt cursor to the click) would fire
  // on the same press.
  altClickMovesCursor: false,
  fontSize: 16,
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, "Courier New", monospace',
  scrollback: 100000,
  // Enables the overview ruler, where an unsent comment leaves a tick so the
  // scrollbar maps where it sits in the scrollback. Has to be set up front: the
  // width is part of the layout, so changing it later re-wraps the whole buffer.
  // The strip is transparent when nothing has marked it, which is most of the time.
  overviewRulerWidth: 10,
  allowProposedApi: true, // Required for registerDecoration() and registerMarker()
  linkHandler: {
    activate: (_event, text) => {
      if (pressConsumedByDecoration) {
        console.info(`[links] skipped osc8 (decoration handled this press): ${text}`);
        return;
      }
      const external = !!(_event && (_event.ctrlKey || _event.metaKey || _event.altKey));
      openUrlFromTerminal(text, 'osc8', external);
    },
  },
  theme: {
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#cccccc',
    cursorAccent: '#0c0c0c',
    selectionBackground: '#264f78',
    black: '#0c0c0c',
    red: '#c50f1f',
    green: '#13a10e',
    yellow: '#c19c00',
    blue: '#0037da',
    magenta: '#881798',
    cyan: '#3a96dd',
    white: '#cccccc',
    brightBlack: '#767676',
    brightRed: '#e74856',
    brightGreen: '#16c60c',
    brightYellow: '#f9f1a5',
    brightBlue: '#3b78ff',
    brightMagenta: '#b4009e',
    brightCyan: '#61d6d6',
    brightWhite: '#f2f2f2',
  },
});

// OSC 52 — the TUI-side "copy to clipboard" escape (e.g. copilot's own copy
// action). xterm.js ships no handler, so without this the CLI reports "Copied"
// while the host clipboard never changes. Write-only: '?' (clipboard read) is
// swallowed, never answered.
terminal.parser.registerOscHandler(52, (data) => {
  const payload = data.slice(data.indexOf(';') + 1);
  if (payload === '?') return true;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    if (text) navigator.clipboard.writeText(text);
  } catch {}
  return true;
});

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);

const container = document.getElementById('terminal');
terminal.open(container);
const screenElement = document.querySelector('.xterm-screen');

// WebGL atlas corruption (yellow garbage chars mid-text) is a long-tail
// unresolved class of bugs on macOS — see xterm.js #3357/#4665/#3303 and
// VS Code #69665/#174399. Triggers include sleep/wake, DPR shifts, and
// ANGLE→Metal timing races we can't reach from JS. Released artifact is
// Windows-only (npm run dist:win), so skip WebGL on macOS and let xterm
// fall back to its DOM renderer — slower on huge redraws, zero atlas bugs.
let webglAddon = null;
if (window.pty.platform !== 'darwin') {
  try {
    webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
      webglAddon = null;
    });
    terminal.loadAddon(webglAddon);
  } catch (e) {
    console.warn('WebGL addon failed to load, falling back to DOM:', e);
  }

  // Defensive atlas resets for the platforms that keep WebGL. Cheap no-ops
  // when the addon isn't loaded.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (webglAddon) webglAddon.clearTextureAtlas();
    });
  }
  if (window.matchMedia) {
    const watchDpr = () => {
      const mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const onChange = () => {
        if (webglAddon) webglAddon.clearTextureAtlas();
        watchDpr();
      };
      mql.addEventListener('change', onChange, { once: true });
    };
    watchDpr();
  }
}

// Fit terminal to container
fitAddon.fit();

function syncPtyResize() {
  fitAddon.fit();
  window.pty.resize(terminal.cols, terminal.rows);
}

// Start PTY with current dimensions
window.pty.start(terminal.cols, terminal.rows);

// Streaming buffer watcher: polls the active xterm buffer, pushes
// snapshots (or alt-screen flip events) to main via IPC. Quiet until
// main starts a run (first user prompt) — pre-run snapshots are
// dropped on the main side.
streamWatch.start(terminal);

// --- Freeze terminal output while commenting -------------------------------
// When output is streaming, pressing on the terminal pauses the local display so
// the text you want to comment on stops moving while you pick it. Incoming PTY
// data is buffered (never dropped) and flushed on resume; the hub stream upstream
// is untouched. Resume on Esc, right-click, a click of the pill, sending the
// comment(s), or typing into the shell.
let terminalOutputFrozen = false;
let lastTerminalOutputAt = 0;
const frozenTerminalChunks = [];
let terminalFrozenPill = null;
const TERMINAL_LIVE_OUTPUT_MS = 1500;
// An accidental freeze — a stray press that paused the view but led to no
// commenting — resolves itself after a quiet stretch. Engagement (moving over the
// frozen frame, changing the selection, opening a comment) pushes it back; an
// open or queued comment disarms it entirely (you're mid-comment). Sending a
// comment already thaws, so this only backstops the do-nothing case.
let terminalFreezeIdleTimer = null;
const TERMINAL_FREEZE_IDLE_MS = 4000;
// AgentTerm runs AI CLIs whose input box is pinned to the bottom of the screen —
// output streams *above* it, never into it. So a press in that bottom region is
// "back to the input," not "comment on output," and shouldn't pause the stream.
// The exempt zone hugs the input line (the cursor) but is never deeper than this
// many rows, so a cursor parked high mid-generation still only frees the strip
// where the box actually sits.
const TERMINAL_PROMPT_AREA_MAX_ROWS = 6;
// Nav keys xterm sends as ESC-prefixed sequences — the same shape as terminal-
// protocol replies, so onData's isAutoProtocol filter can't tell them apart and
// skips its thaw for both. Answering a running program (e.g. a codex permission
// prompt) is exactly arrow-key menu navigation, so a frozen view would move its
// highlight invisibly. A keydown IS genuine user input (a protocol reply never
// fires one), so we thaw on these keys from the key handler instead.
const TERMINAL_NAV_THAW_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
]);

function showTerminalFrozenPill() {
  if (terminalFrozenPill) return;
  ensureTerminalCommentStyles();
  const pill = document.createElement('div');
  pill.className = 'terminal-output-frozen-pill';
  pill.textContent = '❄ Output paused — right-click or Esc to resume';
  pill.title = 'Resume live output';
  pill.addEventListener('mousedown', (e) => e.stopPropagation());
  pill.addEventListener('click', (e) => { e.stopPropagation(); cancelTerminalFreeze(); });
  document.body.appendChild(pill);
  terminalFrozenPill = pill;
}
function hideTerminalFrozenPill() {
  if (!terminalFrozenPill) return;
  try { terminalFrozenPill.remove(); } catch {}
  terminalFrozenPill = null;
}
function clearTerminalFreezeIdleTimer() {
  if (!terminalFreezeIdleTimer) return;
  clearTimeout(terminalFreezeIdleTimer);
  terminalFreezeIdleTimer = null;
}
// Arm-or-refresh the auto-thaw. It always clears first, then re-arms only while
// the freeze is "bare" — frozen, no comment open, none queued. So calling it at
// any transition (freeze, selection change, mouse move, comment open/close) keeps
// the invariant without per-site bookkeeping: engagement re-arms it, a live
// comment leaves it disarmed, and a freeze nobody acts on thaws itself.
function armTerminalFreezeIdleTimer() {
  clearTerminalFreezeIdleTimer();
  if (!terminalOutputFrozen) return;
  if (activeTerminalComment || queuedTerminalComments.length) return;
  terminalFreezeIdleTimer = setTimeout(() => {
    terminalFreezeIdleTimer = null;
    if (!terminalOutputFrozen || activeTerminalComment || queuedTerminalComments.length) return;
    unfreezeTerminalOutput();
  }, TERMINAL_FREEZE_IDLE_MS);
}
function freezeTerminalOutput() {
  if (terminalOutputFrozen) return;
  terminalOutputFrozen = true;
  showTerminalFrozenPill();
  armTerminalFreezeIdleTimer();
}
function unfreezeTerminalOutput() {
  if (!terminalOutputFrozen) return;
  terminalOutputFrozen = false;
  clearTerminalFreezeIdleTimer();
  hideTerminalFrozenPill();
  if (frozenTerminalChunks.length) {
    const pending = frozenTerminalChunks.join('');
    frozenTerminalChunks.length = 0;
    try { terminal.write(pending); } catch {}
  }
}
// Esc / pill click / right-click: abandon any in-progress comment, then resume.
// Focus MUST land back on the terminal: the click that froze (and the double-click
// that opens a comment) leaves focus on the composer textarea — or, with a viewer
// open, in its <webview> guest — so without this the shell stays keyboard-dead
// after dismissing (arrows/Enter reach nothing, e.g. a codex selection prompt).
// closeTerminalComment is called with focusTerminal:false so we focus once, here,
// after the whole teardown.
function cancelTerminalFreeze() {
  clearPendingFreezePress(); // a hold-freeze in flight must not refreeze after the cancel
  if (!terminalOutputFrozen) return;
  // The queued batch survives resuming. This used to clear it, which made Esc
  // the fastest way to destroy comments already finished and set aside — while
  // the pill advertised it as "resume" and nothing else. Resuming and abandoning
  // are different intents and only one of them is reversible, so only the
  // labelled control does the destructive one. The cards stay anchored, the
  // ruler keeps its ticks and the footer keeps counting.
  //
  // The composer is a different matter: Esc on an open one cancels the draft
  // being written, which is what Esc means in a composer everywhere else. Only
  // work you already set aside is protected here.
  if (activeTerminalComment) closeTerminalComment({ focusTerminal: false });
  try { terminal.clearSelection(); } catch {}
  hideTerminalSelectionCommentHint();
  unfreezeTerminalOutput();
  try { terminal.focus(); } catch {}
}

// Typing in the shell means the user's attention is back on the terminal — roll up
// any OPEN viewer to its handle (reversible; the content stays alive) so the terminal
// is unobstructed and un-dimmed (the recede only applies while a viewer is open).
// hide() is a no-op unless the viewer is open, so this only acts when one is showing.
function withdrawViewersOnInput() {
  try { webViewer && webViewer.hide && webViewer.hide(); } catch {}
  try { markdownViewer && markdownViewer.hide && markdownViewer.hide(); } catch {}
}

// Terminal input → PTY (typing into the shell resumes a frozen view)
terminal.onData((data) => {
  // onData carries more than keystrokes: focus reports (CSI I / CSI O, mode
  // 1004) fire on every focus change, and terminal-protocol replies — cursor-
  // position (ESC[6n → ESC[r;cR), device attributes, palette queries — arrive
  // through this same channel. On macOS (real PTY, not ConPTY) the AI CLI
  // probes the terminal at startup — exactly when a launch-time auto-open
  // lands — and a fullscreen TUI (unsupported, but seen in the wild) probes
  // continuously. Treating replies as typing collapsed the viewer the instant
  // it opened and unfroze a commenting-frozen terminal. Same rule as main's
  // isAutoTerminalProtocol: any multi-byte ESC-prefixed sequence is protocol,
  // never user input; bare ESC (the Esc key) still counts. Deliberate tradeoff
  // (same as main): arrow/F/nav keys ride ESC prefixes too, so they don't
  // withdraw the viewer. Either way the data is forwarded to the pty so the
  // shell's protocol handling works. (Enter/control input also no longer
  // withdraws — see the printable-only gate below.)
  const isAutoProtocol = data.length > 1 && /^\u001b[\[\]OP_^]/.test(data);
  if (!isAutoProtocol) {
    if (terminalOutputFrozen) unfreezeTerminalOutput();
    // Genuine input reaching the shell (Enter, Esc, Ctrl-*) means attention is
    // back on the CLI — disarm the type-to-comment pill. Plain chars never get
    // here while armed (the pill's keydown handler opens the composer instead),
    // and mouse reports are ESC-prefixed, so the armed snapshot survives them.
    hideTerminalSelectionCommentHint();
    // Only a PRINTABLE char / paste (composing a command) rolls an open viewer up.
    // A bare Enter or other control input (answering a codex prompt) thaws but
    // keeps the viewer up, so the re-render the approval triggers stays visible.
    if (/[^\x00-\x1f\x7f]/.test(data)) withdrawViewersOnInput();
  }
  window.pty.write(data);
});

// PTY output → Terminal (buffered while frozen so the display holds still)
window.pty.onData((data) => {
  lastTerminalOutputAt = Date.now();
  captureViewerCandidates(data); // durable URL/md history, including alt-screen output
  if (terminalOutputFrozen) frozenTerminalChunks.push(data);
  else terminal.write(data);
});

// Handle PTY exit
window.pty.onExit((code) => {
  terminal.write(`\r\n[Process exited with code ${code}]\r\n`);
});

// Handle window resize
window.addEventListener('resize', () => {
  syncPtyResize();
});

// Also handle resize events from main process
window.pty.onResize(() => {
  syncPtyResize();
});

// Sync terminal title (from OSC sequences) to the Electron window title
terminal.onTitleChange((title) => {
  window.pty.setTitle(title);
});

// Focus terminal
terminal.focus();

// Paste from clipboard: if clipboard has an image (and no text), save it and paste the file path.
// Otherwise paste text as usual.
function pasteFromClipboard() {
  navigator.clipboard.readText().then((text) => {
    if (text) {
      terminal.paste(text);
    } else {
      // No text — try image
      window.pty.saveClipboardImage().then((imagePath) => {
        if (imagePath) terminal.paste(imagePath);
      });
    }
  });
}

// Insert current IDE caret position (file:line) into the terminal input.
function insertCaretPosition() {
  window.pty.getCaretPosition().then((result) => {
    if (result.success && result.status === 'ok' && result.file && result.line != null) {
      terminal.paste(` ${result.file}:${result.line} `);
      return;
    }

    if (result && result.status === 'ok') {
      const detail = result.file
        ? `${result.file}${result.line == null ? ' returned without a line' : ''}`
        : 'no file returned';
      showNavigationFeedback('caret', null, {
        status: 'error',
        message: `Could not resolve IDE caret location: ${detail}`,
      });
      return;
    }

    showNavigationFeedback(
      'caret',
      null,
      result && typeof result === 'object' ? result : { error: String(result) },
    );
  }).catch((error) => {
    showNavigationFeedback('caret', null, { error: error.message });
  });
}

function printCaretDiagnostic(message) {
  const lines = String(message)
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const payload = lines.length ? lines : ['(no diagnostics returned)'];
  const rendered = payload.map((line) => `[Ctrl+Alt+K] ${line}`).join('\r\n');
  terminal.write(`\r\n${rendered}\r\n`);
  showToast(payload[0].length > 160 ? `${payload[0].slice(0, 157)}...` : payload[0]);
}

function showCaretDiagnostics() {
  window.pty.getCaretDiagnostics().then((result) => {
    const message = result && typeof result === 'object'
      ? result.message || JSON.stringify(result)
      : String(result);

    printCaretDiagnostic(message);

    if (!result || result.status !== 'ok') {
      showNavigationFeedback('caret diagnostics', null, {
        status: 'error',
        message,
      });
    }
  }).catch((error) => {
    const message = error && error.message ? error.message : String(error);
    printCaretDiagnostic(message);
    showNavigationFeedback('caret diagnostics', null, { status: 'error', message });
  });
}

// Listen for Ctrl+K/Cmd+K from main process (intercepted via before-input-event).
window.pty.onInsertCaretPosition(() => insertCaretPosition());
window.pty.onShowCaretDiagnostics(() => showCaretDiagnostics());

// Unified key handler — keeps platform-native search and clipboard shortcuts.
terminal.attachCustomKeyEventHandler((event) => {
  const proceed = handleTerminalKeydown({
    event,
    terminal,
    platform: window.pty.platform,
    getSearchState: () => searchState,
    openSearchBar,
    closeSearchBar,
    pasteFromClipboard,
    writeClipboardText: (text) => navigator.clipboard.writeText(text),
    copyArmedSelection: () => {
      const text = armedTerminalSelectionContext ? armedTerminalSelectionContext.selectedText : '';
      if (!text) return false;
      navigator.clipboard.writeText(text);
      hideTerminalSelectionCommentHint();
      return true;
    },
  });
  // A nav-key keydown headed for the shell means the user is driving a running
  // program (navigating a prompt/menu), not commenting — thaw the frozen view so
  // that navigation is visible. onData can't do this: those keys look like
  // protocol replies to it (see TERMINAL_NAV_THAW_KEYS). Printables/Enter already
  // thaw via onData, so this only closes the arrow-key gap.
  if (proceed && event.type === 'keydown' && terminalOutputFrozen && TERMINAL_NAV_THAW_KEYS.has(event.key)) {
    unfreezeTerminalOutput();
  }
  return proceed;
});

let activeTerminalComment = null;
let terminalCommentOpenToken = 0;
let terminalCommentIdSeq = 0;
let terminalCommentFooter = null;
let terminalCommentSelectionHint = null;
let terminalCommentSelectionTimer = null;
// Snapshot of the selection context backing the "Type to comment" pill. Mouse-
// captured TUIs (alt-screen CLIs like copilot) make this necessary: every mouse
// event xterm reports to the app counts as user input, and xterm clears the
// local selection on ANY user input — so the selection behind an armed pill
// vanishes on the next reported mouse move/click/wheel. The pill (and the
// comment it opens) works off this snapshot, taken while the selection is real.
let armedTerminalSelectionContext = null;
// Decoration standing in for the native selection once xterm clears it — keeps
// "what am I commenting on" visible while the pill is armed off the snapshot.
let armedTerminalSelectionHighlight = null;
const queuedTerminalComments = [];
const SELECTION_COMMENT_CONTEXT_ROWS = DEFAULT_SELECTION_CONTEXT_LINES;

function cleanTerminalOutputLine(text) {
  return String(text == null ? '' : text).replace(/\s+$/g, '');
}

function ensureTerminalCommentStyles() {
  if (document.getElementById('terminal-comment-style')) return;
  const style = document.createElement('style');
  style.id = 'terminal-comment-style';
  style.textContent = `
    .terminal-comment-bubble {
      position: fixed;
      z-index: 10000;
      width: min(420px, calc(100vw - 28px));
      background: #202124;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 7px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.44);
      padding: 10px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #e8eaed;
      -webkit-app-region: no-drag;
    }
    /* Slim grip at the top of the bubble — drag it to move the bubble off
       whatever it covers. CSS-drawn pill (no glyph) so it can't render as tofu. */
    .terminal-comment-drag {
      height: 12px;
      margin: -4px -4px 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: move;
      user-select: none;
    }
    .terminal-comment-drag::before {
      content: '';
      width: 26px;
      height: 3px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.22);
    }
    .terminal-comment-drag:hover::before { background: rgba(255, 255, 255, 0.42); }
    /* The composer (textarea + Cancel/Send) is the shared comment-ui widget
       (.cu-composer.cu-dark); the bubble above is the only terminal-local chrome. */
    .terminal-comment-footer {
      position: fixed;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%);
      z-index: 10001;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 7px;
      background: #202124;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.44);
      color: #e8eaed;
      font: 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-app-region: no-drag;
    }
    /* The count is the way back to unsent work, so it reads as a control rather
       than as a label — but a quieter one than Discard beside it, since it is
       the safe action of the two. */
    .terminal-comment-footer button.terminal-comment-footer-count {
      min-width: 92px;
      color: #c9d1d9;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px;
      padding: 4px 8px;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .terminal-comment-footer button.terminal-comment-footer-count:hover:not(:disabled) {
      border-color: rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.06);
    }
    .terminal-comment-footer button.terminal-comment-footer-count:disabled {
      cursor: default;
    }
    /* Send is the one that finishes the work, so it carries the accent while
       Discard stays neutral — the destructive control should never be the
       most inviting thing in the row. */
    .terminal-comment-footer button.terminal-comment-footer-send {
      border-color: rgba(138, 180, 248, 0.55);
      color: #d7e3fc;
    }
    .terminal-comment-footer button.terminal-comment-footer-send:hover:not(:disabled) {
      background: rgba(138, 180, 248, 0.16);
    }
    .terminal-comment-footer button {
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 5px;
      padding: 5px 10px;
      font: inherit;
      color: #e8eaed;
      background: transparent;
      cursor: pointer;
    }
    .terminal-comment-footer button:hover {
      background: rgba(255, 255, 255, 0.08);
    }
    .terminal-output-frozen-pill {
      position: fixed;
      top: calc(var(--at-chrome-height, 0px) + 10px);
      left: 50%;
      transform: translateX(-50%);
      z-index: 10002;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(32, 33, 36, 0.96);
      color: #e8eaed;
      border: 1px solid rgba(138, 180, 248, 0.55);
      font: 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
      user-select: none;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
      -webkit-app-region: no-drag;
    }
    .terminal-output-frozen-pill:hover {
      background: rgba(48, 49, 52, 0.98);
    }
    .terminal-comment-queued-card {
      position: fixed;
      right: 18px;
      z-index: 9998;
      width: min(320px, calc(100vw - 28px));
      max-height: 96px;
      overflow: hidden;
      padding: 7px 9px;
      border: 1px solid rgba(138, 180, 248, 0.42);
      border-radius: 6px;
      background: rgba(32, 33, 36, 0.96);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.36);
      color: #e8eaed;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-app-region: no-drag;
      pointer-events: auto;
      cursor: pointer;
      transition: border-color 120ms ease, transform 120ms ease, background 120ms ease;
    }
    .terminal-comment-queued-card:hover {
      border-color: rgba(138, 180, 248, 0.72);
      background: rgba(37, 39, 43, 0.98);
      transform: translateX(-2px);
    }
    .terminal-comment-queued-card-label {
      display: block;
      margin-bottom: 3px;
      color: #8ab4f8;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
    }
    .terminal-comment-queued-card-body {
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.35;
    }
    .terminal-comment-selection-hint {
      position: fixed;
      z-index: 9999;
      border: 1px solid rgba(138, 180, 248, 0.32);
      border-radius: 5px;
      padding: 4px 8px;
      background: rgba(32, 33, 36, 0.9);
      color: #c9d1d9;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28);
      font: 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: none;
      -webkit-app-region: no-drag;
    }
  `;
  document.head.appendChild(style);
}

function positionTerminalCommentBubble(bubble, anchorX, anchorY) {
  const margin = 14;
  bubble.style.left = `${Math.max(margin, Math.min(anchorX, window.innerWidth - margin - 420))}px`;
  bubble.style.top = `${Math.max(margin, anchorY + 18)}px`;

  requestAnimationFrame(() => {
    if (!bubble.isConnected) return;
    const rect = bubble.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;
    if (rect.right > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - margin - rect.width);
    }
    if (rect.bottom > window.innerHeight - margin) {
      top = Math.max(margin, anchorY - rect.height - 12);
    }
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  });
}

// Drag the comment bubble by its grip — it floats over the terminal and may
// cover the line you're commenting on. Overrides positionTerminalCommentBubble's
// left/top and clamps to the viewport. The grip's mousedown stays inside the
// bubble, so the outside-click-queues handler doesn't fire.
function makeBubbleDraggable(bubble, handle) {
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = bubble.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const margin = 6;
    const onMove = (m) => {
      m.preventDefault();
      const left = Math.max(margin, Math.min(m.clientX - dx, window.innerWidth - margin - bubble.offsetWidth));
      const top = Math.max(margin, Math.min(m.clientY - dy, window.innerHeight - margin - bubble.offsetHeight));
      bubble.style.left = `${left}px`;
      bubble.style.top = `${top}px`;
      bubble.style.right = 'auto';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  });
}

// Cell-exact highlight for a comment — one decoration per visual row, covering
// just the selected cells (same mechanism as search highlights). The native
// selection is cleared when the bubble opens, so this is what keeps "what am I
// commenting on" visible while composing and on queued drafts.
function createTerminalSelectionHighlight(range, { ruler = false } = {}) {
  if (!range) return null;
  const buffer = terminal.buffer.active;
  const endRow = getSelectionEndRow(range);
  const parts = [];
  for (let row = range.start.row; row <= endRow; row++) {
    const startCol = row === range.start.row ? range.start.column : 0;
    const endCol = row === endRow ? getSelectionEndColumn(range) : terminal.cols;
    const marker = terminal.registerMarker(row - buffer.baseY - buffer.cursorY);
    if (!marker) continue;
    const decoration = terminal.registerDecoration({
      marker,
      x: startCol,
      width: Math.max(1, endCol - startCol),
      layer: 'top',
      // A tick in the overview ruler, so the scrollbar maps where unsent work
      // sits in the scrollback: the card itself hides once its row leaves the
      // viewport, and a count alone cannot say where to look. First row only —
      // a selection spanning several rows is one comment, not several.
      ...(ruler && row === range.start.row
        ? { overviewRulerOptions: { color: 'rgba(138, 180, 248, 0.9)', position: 'right' } }
        : {}),
    });
    if (!decoration) {
      marker.dispose();
      continue;
    }
    decoration.onRender((element) => {
      const viewportLine = marker.line - terminal.buffer.active.viewportY;
      if (isAlternateBufferActive() && viewportLine >= 0 && viewportLine < terminal.rows) {
        element.style.display = 'block';
      }
      element.style.backgroundColor = 'rgba(138, 180, 248, 0.3)';
      element.style.pointerEvents = 'none';
    });
    parts.push({ marker, decoration });
  }
  if (!parts.length) return null;
  return {
    dispose() {
      for (const part of parts) {
        part.decoration.dispose();
        part.marker.dispose();
      }
    },
  };
}

function getTerminalRowTop(bufferRow) {
  if (!screenElement || !terminal || !terminal.buffer) return null;
  const viewportLine = bufferRow - terminal.buffer.active.viewportY;
  if (viewportLine < 0 || viewportLine >= terminal.rows) return null;

  const rect = screenElement.getBoundingClientRect();
  const rowHeight = rect.height / Math.max(1, terminal.rows);
  return rect.top + viewportLine * rowHeight;
}

function positionQueuedTerminalCommentCard(comment) {
  if (!comment || !comment.card) return;
  const top = getTerminalRowTop(comment.targetRow);
  if (top == null) {
    comment.card.style.display = 'none';
    return;
  }

  comment.card.style.display = '';
  const maxTop = window.innerHeight - 126;
  comment.card.style.top = `${Math.max(14, Math.min(top + 2, maxTop))}px`;
}

function updateQueuedTerminalCommentCards() {
  for (const comment of queuedTerminalComments) {
    positionQueuedTerminalCommentCard(comment);
  }
}

function clearTerminalSelection() {
  try { terminal.clearSelection(); } catch {}
}

function hideTerminalSelectionCommentHint() {
  if (terminalCommentSelectionTimer) {
    clearTimeout(terminalCommentSelectionTimer);
    terminalCommentSelectionTimer = null;
  }
  if (terminalCommentSelectionHint) {
    terminalCommentSelectionHint.remove();
    terminalCommentSelectionHint = null;
  }
  armedTerminalSelectionContext = null;
  if (armedTerminalSelectionHighlight) {
    try { armedTerminalSelectionHighlight.dispose(); } catch {}
    armedTerminalSelectionHighlight = null;
  }
}

function normalizeTerminalSelectionRange(range) {
  if (!range || !range.start || !range.end) return null;
  const start = {
    row: Number.isFinite(range.start.y) ? range.start.y : 0,
    column: Number.isFinite(range.start.x) ? range.start.x : 0,
  };
  const end = {
    row: Number.isFinite(range.end.y) ? range.end.y : start.row,
    column: Number.isFinite(range.end.x) ? range.end.x : start.column,
  };
  if (end.row < start.row || (end.row === start.row && end.column < start.column)) {
    return { start: end, end: start };
  }
  return { start, end };
}

function getSelectionEndRow(range) {
  if (!range) return null;
  return range.end.column === 0 && range.end.row > range.start.row
    ? range.end.row - 1
    : range.end.row;
}

function getSelectionEndColumn(range) {
  if (!range) return 0;
  if (range.end.column === 0 && range.end.row > range.start.row) {
    return terminal.cols;
  }
  return range.end.column;
}

function collectLogicalSelectionLines(buffer, startLogicalRow, endLogicalRow) {
  const contextLines = [];
  let row = startLogicalRow;
  while (row <= endLogicalRow && row < buffer.length) {
    const { text, endIndex } = getRowText(row);
    contextLines.push({
      row,
      endRow: endIndex,
      text: cleanTerminalOutputLine(text),
    });
    row = Math.max(row + 1, endIndex + 1);
  }
  return contextLines;
}

function collectTerminalSelectionCommentContext() {
  if (!terminal.hasSelection()) return null;
  const selectedText = terminal.getSelection();
  const range = normalizeTerminalSelectionRange(terminal.getSelectionPosition());
  if (!selectedText || !range) return null;

  const buffer = terminal.buffer.active;
  const selectedEndRow = getSelectionEndRow(range);
  const startLogicalRow = getLogicalLineStart(buffer, range.start.row);
  const endLogicalRow = getLogicalLineStart(buffer, selectedEndRow);
  const contextStartRow = Math.max(0, startLogicalRow - SELECTION_COMMENT_CONTEXT_ROWS);
  const contextEndRow = Math.min(buffer.length - 1, endLogicalRow + SELECTION_COMMENT_CONTEXT_ROWS);
  const contextLines = collectLogicalSelectionLines(buffer, contextStartRow, contextEndRow);
  const selection = {
    start: {
      row: startLogicalRow,
      column: getLogicalLineOffset(buffer, startLogicalRow, range.start.row, range.start.column),
    },
    end: {
      row: endLogicalRow,
      column: getLogicalLineOffset(buffer, endLogicalRow, selectedEndRow, getSelectionEndColumn(range)),
    },
  };

  return {
    kind: 'selection',
    selectedText,
    selection,
    contextLines,
    targetRow: startLogicalRow,
    // Visual (wrapped-row) buffer coords, unlike `selection` above which is
    // logical — the cell-exact highlight needs what was on screen.
    visualRange: range,
  };
}

function positionTerminalSelectionCommentHint(hint, range) {
  const endRow = getSelectionEndRow(range);
  const top = getTerminalRowTop(endRow == null ? range.start.row : endRow);
  if (top == null) {
    // Selection scrolled off-screen (e.g. streaming output pushed it past the
    // viewport): hide rather than strand the pill at the terminal's edge. Mirrors
    // positionQueuedTerminalCommentCard, which hides its card the same way.
    hideTerminalSelectionCommentHint();
    return;
  }
  const rect = screenElement.getBoundingClientRect();
  const rowHeight = rect.height / Math.max(1, terminal.rows);
  const columnWidth = rect.width / Math.max(1, terminal.cols);
  const endColumn = Math.max(0, Math.min(terminal.cols, getSelectionEndColumn(range)));
  const anchorX = rect.left + endColumn * columnWidth;
  // Measured, not assumed: the pill's text is no longer a fixed two words, and a
  // hardcoded width would hang its right edge off the selection end.
  const width = hint.offsetWidth || 118;
  const left = Math.min(window.innerWidth - width - 18, Math.max(14, anchorX - width));
  const baseTop = top + rowHeight + 4;
  hint.style.left = `${left}px`;
  hint.style.top = `${Math.max(14, Math.min(baseTop, window.innerHeight - 42))}px`;
}

function showTerminalSelectionCommentHint() {
  if (activePicker || document.querySelector('.at-picker-overlay')) {
    hideTerminalSelectionCommentHint();
    return;
  }
  if (activeTerminalComment) {
    hideTerminalSelectionCommentHint();
    return;
  }
  const live = collectTerminalSelectionCommentContext();
  const context = live || armedTerminalSelectionContext;
  if (!context) {
    hideTerminalSelectionCommentHint();
    return;
  }
  armedTerminalSelectionContext = context;
  if (live) {
    // Native selection is visible again — the stand-in highlight would double it.
    if (armedTerminalSelectionHighlight) {
      try { armedTerminalSelectionHighlight.dispose(); } catch {}
      armedTerminalSelectionHighlight = null;
    }
  } else if (!armedTerminalSelectionHighlight) {
    armedTerminalSelectionHighlight = createTerminalSelectionHighlight(context.visualRange);
  }

  ensureTerminalCommentStyles();
  if (!terminalCommentSelectionHint) {
    const hint = document.createElement('div');
    hint.className = 'terminal-comment-selection-hint';
    // Names its own exit. The pill owns the next printable key, and it outlives
    // the freeze that put it up (the idle thaw leaves the selection alone), so a
    // pill can be sitting armed over settled output while you turn back to the
    // shell to type a command. "Type to comment" announces the capture; without
    // the second clause nothing announces the release.
    hint.textContent = 'Type to comment · esc dismisses';
    document.body.appendChild(hint);
    terminalCommentSelectionHint = hint;
  }
  positionTerminalSelectionCommentHint(terminalCommentSelectionHint, context.selection);
}

function scheduleTerminalSelectionCommentHint() {
  armTerminalFreezeIdleTimer(); // selecting text is engagement — push back the idle thaw
  // Snapshot NOW, not at debounce time: under app mouse capture the selection
  // can be cleared (report → user input → clearSelection) before the debounced
  // show runs, and the pill would never arm.
  const live = collectTerminalSelectionCommentContext();
  if (live) armedTerminalSelectionContext = live;
  // A pill that's already up must track its selection synchronously. Streaming
  // output fires onScroll faster than the debounce interval, so a debounced-only
  // refresh keeps getting reset and never runs — stranding the pill at a stale
  // pixel while its text scrolls out from under it (and never hiding it once the
  // selection scrolls off-screen). The debounce only guards first appearance, so
  // the pill doesn't flicker up mid-drag before the selection settles.
  if (terminalCommentSelectionHint) {
    if (terminalCommentSelectionTimer) {
      clearTimeout(terminalCommentSelectionTimer);
      terminalCommentSelectionTimer = null;
    }
    showTerminalSelectionCommentHint();
    return;
  }
  if (terminalCommentSelectionTimer) clearTimeout(terminalCommentSelectionTimer);
  terminalCommentSelectionTimer = setTimeout(() => {
    terminalCommentSelectionTimer = null;
    showTerminalSelectionCommentHint();
  }, 120);
}

function isPlainSelectionCommentKey(event) {
  return event
    && typeof event.key === 'string'
    && event.key.length === 1
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && !event.isComposing;
}

function isSelectionCommentTypingTarget(target) {
  if (!target || !target.closest) return true;
  if (activePicker || document.querySelector('.at-picker-overlay')) return false;
  const searchBar = document.getElementById('search-bar');
  if (searchBar && searchBar.style.display !== 'none') return false;
  if (target.closest('.terminal-comment-bubble, .terminal-comment-footer, .terminal-comment-selection-hint')) return false;
  if (target.id === 'search-input') return false;
  const tagName = target.tagName ? target.tagName.toUpperCase() : '';
  if (target.isContentEditable) return false;
  if (tagName === 'INPUT' || tagName === 'SELECT') return false;
  if (tagName === 'TEXTAREA' && !target.classList.contains('xterm-helper-textarea')) return false;
  return true;
}

function handleSelectionCommentHintKeydown(event) {
  if (!terminalCommentSelectionHint || activeTerminalComment) return;
  const paste = isPasteCommentShortcut(event);
  if (!paste && !isPlainSelectionCommentKey(event)) return;
  if (!isSelectionCommentTypingTarget(event.target)) return;
  if (!collectTerminalSelectionCommentContext() && !armedTerminalSelectionContext) {
    hideTerminalSelectionCommentHint();
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
  if (paste) {
    // Seed the bubble with the clipboard. The selection survives the async read:
    // output is frozen while a selection exists, and the paste never reaches the
    // terminal (prevented above).
    navigator.clipboard.readText().catch(() => '').then((text) => {
      openTerminalSelectionComment({ initialComment: text || '' });
    });
    return;
  }
  openTerminalSelectionComment({ initialComment: event.key });
}

function createQueuedTerminalCommentCard(comment) {
  ensureTerminalCommentStyles();
  const card = document.createElement('div');
  card.className = 'terminal-comment-queued-card';
  card.title = 'Click to edit';

  const label = document.createElement('span');
  label.className = 'terminal-comment-queued-card-label';
  label.textContent = comment.kind === 'selection' ? 'Queued selection - edit' : 'Queued line - edit';

  const body = document.createElement('div');
  body.className = 'terminal-comment-queued-card-body';
  body.textContent = comment.comment;

  card.append(label, body);
  card.addEventListener('mousedown', (e) => e.stopPropagation());
  card.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openQueuedTerminalCommentForEdit(comment);
  });
  card.addEventListener('dblclick', (e) => e.stopPropagation());
  document.body.appendChild(card);
  comment.card = card;
  positionQueuedTerminalCommentCard(comment);
}

function getActiveTerminalCommentText() {
  return activeTerminalComment && activeTerminalComment.textarea
    ? activeTerminalComment.textarea.value.trim()
    : '';
}

function buildQueuedTerminalComment(context, comment, highlight, existing = null) {
  return {
    id: existing && Number.isFinite(existing.id) ? existing.id : ++terminalCommentIdSeq,
    createdAt: existing && Number.isFinite(existing.createdAt) ? existing.createdAt : Date.now() + terminalCommentIdSeq / 1000,
    ...context,
    comment,
    highlight,
  };
}

function getPendingTerminalCommentCount() {
  return queuedTerminalComments.length + (getActiveTerminalCommentText() ? 1 : 0);
}

function isTerminalCommentQueueMode() {
  return queuedTerminalComments.length > 0
    || !!(activeTerminalComment && activeTerminalComment.queueMode);
}

function removeQueuedTerminalCommentCard(comment) {
  try {
    if (comment && comment.card) comment.card.remove();
  } catch {}
  if (comment) comment.card = null;
}

function disposeQueuedTerminalComment(comment) {
  try {
    if (comment && comment.highlight) comment.highlight.dispose();
  } catch {}
  removeQueuedTerminalCommentCard(comment);
}

function insertQueuedTerminalComment(comment, index) {
  const targetIndex = Number.isInteger(index)
    ? Math.max(0, Math.min(index, queuedTerminalComments.length))
    : queuedTerminalComments.length;
  queuedTerminalComments.splice(targetIndex, 0, comment);
  createQueuedTerminalCommentCard(comment);
  updateTerminalCommentFooter();
}

function getQueuedTerminalCommentContext(comment) {
  if (!comment || typeof comment !== 'object') return {};
  if (comment.kind === 'selection') {
    return {
      kind: 'selection',
      selectedText: comment.selectedText,
      selection: comment.selection,
      contextLines: comment.contextLines,
      targetRow: comment.targetRow,
    };
  }
  return {
    kind: 'line',
    targetLine: comment.targetLine,
    targetRow: comment.targetRow,
  };
}

// Scroll the next unsent comment into view, cycling through the batch.
//
// A queued card hides when its row leaves the viewport, so once output scrolls
// past, the footer count was the only trace left and it was inert text — you
// could see that unsent work existed and not reach it, while the one control
// that always worked was Discard. Walking the buffer top-down rather than in
// authoring order makes repeated clicks read as a sweep through the scrollback.
let queuedTerminalCommentCursor = 0;

function revealNextQueuedTerminalComment() {
  const ordered = queuedTerminalComments
    .filter((c) => Number.isFinite(c.targetRow))
    .sort((a, b) => a.targetRow - b.targetRow);
  if (!ordered.length) return;
  if (queuedTerminalCommentCursor >= ordered.length) queuedTerminalCommentCursor = 0;
  const target = ordered[queuedTerminalCommentCursor];
  queuedTerminalCommentCursor = (queuedTerminalCommentCursor + 1) % ordered.length;
  // Centred, like a search hit: the comment is usually about the lines around
  // its anchor, so landing it at the viewport edge would hide the context.
  terminal.scrollToLine(Math.max(0, target.targetRow - Math.floor(terminal.rows / 2)));
  updateQueuedTerminalCommentCards();
}

function ensureTerminalCommentFooter() {
  ensureTerminalCommentStyles();
  if (terminalCommentFooter) return terminalCommentFooter;

  const footer = document.createElement('div');
  footer.className = 'terminal-comment-footer';

  const count = document.createElement('button');
  count.type = 'button';
  count.className = 'terminal-comment-footer-count';
  count.addEventListener('click', () => revealNextQueuedTerminalComment());

  // Send belongs here because a queued batch can outlive every composer. The
  // composer's Enter still flushes, but that only reaches a batch you are
  // actively adding to; queue a few comments and walk away and Enter is nowhere,
  // which left Discard as the only control that still worked on the batch.
  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.className = 'terminal-comment-footer-send';
  sendButton.textContent = 'Send';

  const discardButton = document.createElement('button');
  discardButton.type = 'button';
  discardButton.textContent = 'Discard';

  footer.append(count, sendButton, discardButton);
  footer._count = count;
  footer._sendButton = sendButton;
  footer._discardButton = discardButton;

  const stopTerminalEvent = (e) => e.stopPropagation();
  footer.addEventListener('mousedown', stopTerminalEvent);
  footer.addEventListener('click', stopTerminalEvent);
  footer.addEventListener('dblclick', stopTerminalEvent);
  sendButton.addEventListener('click', () => {
    sendButton.disabled = true; // guards a double click through the async send
    Promise.resolve(submitTerminalCommentBatch()).finally(() => {
      if (terminalCommentFooter === footer) sendButton.disabled = false;
    });
  });
  discardButton.addEventListener('click', () => discardTerminalCommentBatch());

  document.body.appendChild(footer);
  terminalCommentFooter = footer;
  return footer;
}

function updateTerminalCommentFooter() {
  if (!isTerminalCommentQueueMode()) {
    if (terminalCommentFooter) {
      terminalCommentFooter.remove();
      terminalCommentFooter = null;
    }
    return;
  }

  const footer = ensureTerminalCommentFooter();
  const count = getPendingTerminalCommentCount();
  // Only queued drafts have a row to go to; the one being written is already in
  // front of you, so with nothing else pending the count stays a plain readout.
  const reachable = queuedTerminalComments.filter((c) => Number.isFinite(c.targetRow)).length;
  footer._count.textContent = `${count} comment${count === 1 ? '' : 's'}`;
  footer._count.disabled = reachable === 0;
  footer._count.title = reachable ? 'Scroll to the next unsent comment' : '';
}

function queueActiveTerminalCommentDraft() {
  const comment = getActiveTerminalCommentText();
  if (!activeTerminalComment || !comment) return false;
  const source = activeTerminalComment;

  const queued = buildQueuedTerminalComment(
    source.context,
    comment,
    source.highlight,
    source.originalQueuedComment || source,
  );
  source.highlight = null;
  insertQueuedTerminalComment(queued, source.queueIndex);
  closeTerminalComment({ focusTerminal: false });
  updateTerminalCommentFooter();
  return true;
}

function getActiveTerminalCommentRecord() {
  const comment = getActiveTerminalCommentText();
  if (!activeTerminalComment || !comment) return null;
  return buildQueuedTerminalComment(
    activeTerminalComment.context,
    comment,
    null,
    activeTerminalComment.originalQueuedComment || activeTerminalComment,
  );
}

function getPendingTerminalCommentRecords() {
  const activeRecord = getActiveTerminalCommentRecord();
  if (!activeRecord) return [...queuedTerminalComments];

  const comments = [...queuedTerminalComments];
  if (activeTerminalComment && activeTerminalComment.queueMode) {
    const index = Number.isInteger(activeTerminalComment.queueIndex)
      ? Math.max(0, Math.min(activeTerminalComment.queueIndex, comments.length))
      : comments.length;
    comments.splice(index, 0, activeRecord);
    return comments;
  }

  comments.push(activeRecord);
  return comments;
}

function restoreQueuedTerminalCommentDraft(comment) {
  if (!comment || !comment.originalQueuedComment) return false;
  const restored = comment.originalQueuedComment;
  restored.highlight = comment.highlight;
  restored.card = null;
  comment.highlight = null;
  insertQueuedTerminalComment(restored, comment.queueIndex);
  return true;
}

function clearQueuedTerminalComments() {
  for (const comment of queuedTerminalComments) {
    disposeQueuedTerminalComment(comment);
  }
  queuedTerminalComments.length = 0;
  updateTerminalCommentFooter();
}

function discardTerminalCommentBatch() {
  closeTerminalComment();
  clearQueuedTerminalComments();
}

async function submitTerminalCommentBatch() {
  const comments = getPendingTerminalCommentRecords();
  if (comments.length === 0) return;

  // Called from the composer's Enter (which already disabled its own button) and
  // not from a footer button anymore, so there's nothing here to toggle.
  const message = buildTerminalCommentBatchMessage(comments);
  try {
    const result = await window.pty.submitInlineComment(message);
    if (!result || !result.success) {
      showToast((result && result.error) || 'Could not send comments');
      return;
    }

    closeTerminalComment({ focusTerminal: false });
    for (const comment of comments) {
      disposeQueuedTerminalComment(comment);
    }
    queuedTerminalComments.length = 0;
    updateTerminalCommentFooter();
    clearTerminalSelection();
    unfreezeTerminalOutput();
    showToast(comments.length === 1 ? 'Comment sent' : `${comments.length} comments sent`);
    try { terminal.focus(); } catch {}
  } catch (error) {
    showToast(error && error.message ? error.message : 'Could not send comments');
  }
}

function closeTerminalComment({ focusTerminal = true, restoreQueuedDraft = false } = {}) {
  if (!activeTerminalComment) return;
  const comment = activeTerminalComment;
  activeTerminalComment = null;
  terminalCommentOpenToken++;
  const restoredQueuedDraft = restoreQueuedDraft
    ? restoreQueuedTerminalCommentDraft(comment)
    : false;

  try {
    if (comment.bubble) comment.bubble.remove();
  } catch {}
  try {
    if (comment.highlight && !restoredQueuedDraft) comment.highlight.dispose();
  } catch {}
  if (comment.onOutsidePointerDown) {
    document.removeEventListener('pointerdown', comment.onOutsidePointerDown, true);
  }
  if (comment.onDocumentKeyDown) {
    document.removeEventListener('keydown', comment.onDocumentKeyDown, true);
  }

  clearTerminalSelection();
  if (focusTerminal) {
    try { terminal.focus(); } catch {}
  }
  updateTerminalCommentFooter();
  armTerminalFreezeIdleTimer(); // comment closed — re-arm the idle thaw if still bare-frozen
}


function openTerminalCommentEditor({
  context,
  highlight,
  anchorX,
  anchorY,
  initialComment = '',
  queueMode = false,
  queueIndex = null,
  originalQueuedComment = null,
} = {}) {
  // The composer anchors to on-screen rows — hold the view still while it's up.
  // Same live-output gate as the press path: idle output needs no hold. The
  // selection that fed this composer has usually frozen the view already; this
  // covers a composer opened from an idle-output selection that then went live.
  if (Date.now() - lastTerminalOutputAt <= TERMINAL_LIVE_OUTPUT_MS) freezeTerminalOutput();
  hideTerminalSelectionCommentHint();
  ensureTerminalCommentStyles();
  const bubble = document.createElement('div');
  bubble.className = 'terminal-comment-bubble';

  const cancel = () => closeTerminalComment({ restoreQueuedDraft: queueMode });
  // Enter always sends; queueing happens by moving away from the composer. So the
  // primary flushes everything — this comment plus anything already queued.
  const queuedCount = queuedTerminalComments.length;
  const primaryLabel = queuedCount > 0 ? `Send all (${queuedCount + 1})` : 'Send';
  // Shared composer (comment-ui), dark variant so it sits on the terminal bubble.
  // The bubble, positioning, outside-click and queue/draft stay terminal-local;
  // only the textarea + buttons come from the shared piece. submit() is forward-
  // referenced — the action only fires after it's assigned.
  const composer = createComposer({
    theme: 'dark',
    placeholder: 'Comment...',
    seed: initialComment,
    rows: 3,
    onCancel: cancel,
    onInput: () => updateTerminalCommentFooter(),
    actions: [
      { label: 'Cancel', onClick: cancel },
      { label: primaryLabel, primary: true, onClick: () => submit() },
    ],
  });
  composer.textarea.spellcheck = true;
  const dragHandle = document.createElement('div');
  dragHandle.className = 'terminal-comment-drag';
  dragHandle.title = 'Drag to move';
  makeBubbleDraggable(bubble, dragHandle);
  bubble.appendChild(dragHandle);
  bubble.appendChild(composer.root);

  const stopTerminalEvent = (e) => e.stopPropagation();
  bubble.addEventListener('mousedown', stopTerminalEvent);
  bubble.addEventListener('click', stopTerminalEvent);
  bubble.addEventListener('dblclick', stopTerminalEvent);
  bubble.addEventListener('keydown', stopTerminalEvent);

  const openToken = ++terminalCommentOpenToken;
  const onOutsidePointerDown = (e) => {
    if (terminalCommentOpenToken !== openToken) return;
    if (bubble.contains(e.target)) return;
    if (terminalCommentFooter && terminalCommentFooter.contains(e.target)) return;
    if (terminalCommentSelectionHint && terminalCommentSelectionHint.contains(e.target)) return;
    if (getActiveTerminalCommentText()) {
      queueActiveTerminalCommentDraft();
      return;
    }
    closeTerminalComment({ focusTerminal: false, restoreQueuedDraft: queueMode });
  };
  const onDocumentKeyDown = (e) => {
    if (terminalCommentOpenToken !== openToken) return;
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeTerminalComment({ restoreQueuedDraft: queueMode });
  };

  activeTerminalComment = {
    bubble,
    highlight,
    context,
    textarea: composer.textarea,
    sendButton: composer.primaryButton,
    onOutsidePointerDown,
    onDocumentKeyDown,
    queueMode,
    queueIndex,
    originalQueuedComment,
  };
  armTerminalFreezeIdleTimer(); // a comment is now open — disarm the idle auto-thaw
  document.body.appendChild(bubble);
  positionTerminalCommentBubble(bubble, anchorX, anchorY);
  setTimeout(() => {
    if (terminalCommentOpenToken !== openToken) return;
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
  }, 0);

  const submit = async () => {
    const comment = composer.textarea.value.trim();
    if (!comment || composer.primaryButton.disabled) return;
    composer.primaryButton.disabled = true; // also guards against a double Enter

    // Enter always sends. If earlier comments were queued (by moving away from
    // them), flush the whole batch with this one; otherwise send this one alone.
    if (queuedTerminalComments.length > 0) {
      await submitTerminalCommentBatch();
      if (activeTerminalComment) composer.primaryButton.disabled = false; // batch failed; still open
      return;
    }

    const message = buildTerminalCommentMessage({ ...context, comment });
    try {
      const result = await window.pty.submitInlineComment(message);
      if (!result || !result.success) {
        showToast((result && result.error) || 'Could not send comment');
        composer.primaryButton.disabled = false;
        return;
      }
      closeTerminalComment();
      unfreezeTerminalOutput();
      showToast('Comment sent');
    } catch (error) {
      showToast(error && error.message ? error.message : 'Could not send comment');
      composer.primaryButton.disabled = false;
    }
  };

  updateTerminalCommentFooter();
  composer.focus();
  return true;
}

function openQueuedTerminalCommentForEdit(comment) {
  if (!comment) return false;

  if (getActiveTerminalCommentText()) {
    queueActiveTerminalCommentDraft();
  } else if (activeTerminalComment) {
    closeTerminalComment({
      focusTerminal: false,
      restoreQueuedDraft: !!activeTerminalComment.queueMode,
    });
  }

  const queueIndex = queuedTerminalComments.indexOf(comment);
  if (queueIndex === -1) return false;

  queuedTerminalComments.splice(queueIndex, 1);
  removeQueuedTerminalCommentCard(comment);
  updateTerminalCommentFooter();

  const highlight = comment.highlight;
  comment.highlight = null;

  const top = getTerminalRowTop(comment.targetRow);
  const anchorY = top == null ? window.innerHeight / 2 : top;
  const anchorX = Math.max(14, window.innerWidth - 360);
  return openTerminalCommentEditor({
    context: getQueuedTerminalCommentContext(comment),
    highlight,
    anchorX,
    anchorY,
    initialComment: comment.comment,
    queueMode: true,
    queueIndex,
    originalQueuedComment: comment,
  });
}

function openTerminalSelectionComment({ initialComment = '' } = {}) {
  const context = collectTerminalSelectionCommentContext() || armedTerminalSelectionContext;
  if (!context) return false;
  clearTerminalSelection();

  if (getActiveTerminalCommentText()) {
    queueActiveTerminalCommentDraft();
  } else {
    closeTerminalComment({
      focusTerminal: false,
      restoreQueuedDraft: !!(activeTerminalComment && activeTerminalComment.queueMode),
    });
  }

  hideTerminalSelectionCommentHint();
  const endRow = getSelectionEndRow(context.selection);
  const top = getTerminalRowTop(endRow == null ? context.targetRow : endRow);
  const rect = screenElement.getBoundingClientRect();
  // Ruler tick from the moment a comment is being written: this highlight is
  // handed to the queued draft if the composer is left, so the mark and the
  // unsent work have the same lifetime.
  const highlight = createTerminalSelectionHighlight(context.visualRange, { ruler: true });

  return openTerminalCommentEditor({
    context,
    highlight,
    anchorX: Math.max(14, rect.left + 16),
    anchorY: top == null ? rect.top + 20 : top,
    initialComment,
    queueMode: queuedTerminalComments.length > 0,
  });
}

function selectTerminalRange(start, end) {
  if (!start || !end) return;
  let rangeStart = start;
  let rangeEnd = end;
  if (
    rangeEnd.bufferRow < rangeStart.bufferRow ||
    (rangeEnd.bufferRow === rangeStart.bufferRow && rangeEnd.col < rangeStart.col)
  ) {
    rangeStart = end;
    rangeEnd = start;
  }

  const length = Math.max(
    1,
    (rangeEnd.bufferRow - rangeStart.bufferRow) * terminal.cols + (rangeEnd.col - rangeStart.col) + 1,
  );
  terminal.select(rangeStart.col, rangeStart.bufferRow, length);
}

function handleShiftSelectionMouseDown(event) {
  if (event.button !== 0 || !event.shiftKey || event.detail !== 1) return false;
  const start = getMouseBufferPosition(event);
  if (!start) return false;

  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
  hideTerminalSelectionCommentHint();
  clearTerminalSelection();
  selectTerminalRange(start, start);

  const onMove = (moveEvent) => {
    moveEvent.preventDefault();
    moveEvent.stopPropagation();
    const next = getMouseBufferPosition(moveEvent);
    if (next) selectTerminalRange(start, next);
  };
  const onUp = (upEvent) => {
    upEvent.preventDefault();
    upEvent.stopPropagation();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    scheduleTerminalSelectionCommentHint();
  };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
  return true;
}

// True when the press lands in the input box pinned at the bottom (see
// TERMINAL_PROMPT_AREA_MAX_ROWS). Anchored to the input line (the cursor) so it
// tracks the box as it grows, clamped to the bottom strip so a cursor sitting
// high in the output still only exempts where the box is. Scrolled up into
// history the cursor falls below the viewport, so nothing there counts.
function isPromptAreaMouseEvent(event) {
  const coords = terminal?._core?._mouseService?.getCoords?.(
    event, screenElement, terminal.cols, terminal.rows,
  );
  if (!coords) return false;
  const clickRow = coords[1] - 1; // 0-based row within the viewport
  const buffer = terminal.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY; // input line, viewport-relative
  const exemptStart = Math.max(cursorRow - 1, terminal.rows - TERMINAL_PROMPT_AREA_MAX_ROWS);
  return clickRow >= exemptStart;
}

// True while the running CLI has mouse reporting enabled (alt-screen TUIs like
// copilot): xterm forwards mouse gestures to the app instead of selecting.
function isAppMouseCaptureActive() {
  try { return !!terminal._core.coreMouseService.areMouseEventsActive; } catch { return false; }
}

// Pressing on streaming output freezes the local view, so the text you're about
// to select stops moving — but only once the press declares text intent: it
// moved past the drag threshold (a selection starting) or it's still held down
// after a beat. A quick click never freezes, so tapping a link opens it without
// also pausing the stream. Shift presses freeze immediately: shift declares
// selection intent at mousedown. Idle output (nothing recent) is left alone —
// there's nothing to hold still — and so is the bottom input box, where a press
// means "back to the input," not "comment on this."
const TERMINAL_FREEZE_HOLD_MS = 200;
let pendingFreezePress = null;

function clearPendingFreezePress() {
  if (!pendingFreezePress) return;
  clearTimeout(pendingFreezePress.timer);
  document.removeEventListener('mousemove', pendingFreezePress.onMove, true);
  document.removeEventListener('mouseup', pendingFreezePress.onUp, true);
  pendingFreezePress = null;
}

screenElement.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || terminalOutputFrozen) return;
  if (Date.now() - lastTerminalOutputAt > TERMINAL_LIVE_OUTPUT_MS) return;
  if (isPromptAreaMouseEvent(event)) return;
  if (event.shiftKey) {
    freezeTerminalOutput();
    return;
  }
  // A double/triple click is xterm's word/line select: selection intent is
  // already declared, so freeze now rather than waiting out the hold — the word
  // under the pointer must not scroll away mid-gesture.
  if (event.detail >= 2) {
    freezeTerminalOutput();
    return;
  }
  // While the CLI owns the mouse, a plain press/drag is the app's gesture and
  // can't start a local selection — there is nothing to freeze for. Shift
  // (above) stays: that's the local-selection escape hatch under capture.
  if (isAppMouseCaptureActive()) return;
  clearPendingFreezePress();
  const press = {
    x: event.clientX,
    y: event.clientY,
    timer: setTimeout(() => {
      clearPendingFreezePress();
      freezeTerminalOutput();
    }, TERMINAL_FREEZE_HOLD_MS),
    onMove: (moveEvent) => {
      if (
        Math.abs(moveEvent.clientX - press.x) > DEFAULT_DRAG_THRESHOLD_PX
        || Math.abs(moveEvent.clientY - press.y) > DEFAULT_DRAG_THRESHOLD_PX
      ) {
        clearPendingFreezePress();
        freezeTerminalOutput();
      }
    },
    onUp: () => clearPendingFreezePress(),
  };
  pendingFreezePress = press;
  document.addEventListener('mousemove', press.onMove, true);
  document.addEventListener('mouseup', press.onUp, true);
}, true);

// A plain press on the terminal dismisses an armed type-to-comment pill, the
// same way a click clears a native selection. Mouse-captured TUIs clear the
// selection themselves (report → user input), so with the armed snapshot now
// surviving that, dismissal needs its own gesture.
screenElement.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || event.shiftKey) return;
  hideTerminalSelectionCommentHint();
}, true);

// Right-click on a word types that whitespace-delimited token into the prompt —
// grab a path/branch/identifier for the command you're mid-typing (a separating
// space is added when the cursor sits against a half-typed argument). It goes
// through paste(), so the typing rules apply: a frozen view resumes and the
// viewport snaps back to the prompt. Right-click anywhere else keeps its old
// meaning: escape a frozen view (and while a comment bubble is open it ONLY
// escapes — a stray right-click must not type into the shell mid-comment).
screenElement.addEventListener('contextmenu', (event) => {
  const word = activeTerminalComment ? '' : getWordAtMouseEvent(event);
  if (!word && !terminalOutputFrozen) return;
  event.preventDefault();
  event.stopPropagation();
  if (word) {
    terminal.paste(pastedWordNeedsLeadingSpace() ? ` ${word}` : word);
    terminal.focus();
    return;
  }
  cancelTerminalFreeze();
}, true);

screenElement.addEventListener('mousedown', (event) => {
  handleShiftSelectionMouseDown(event);
}, true);

// Mouse shortcuts: middle-click scrolls to end everywhere.
attachTerminalMouseShortcuts({
  screenElement,
  terminal,
  isClickableMatchEvent: (event) => !!getClickableMatchAtMouseEvent(event),
});

screenElement.addEventListener('mousemove', (event) => {
  setHoveredMatch(getClickableMatchAtMouseEvent(event), event);
  if (terminalOutputFrozen) armTerminalFreezeIdleTimer(); // presence over the frozen frame = engagement
});

screenElement.addEventListener('mouseleave', () => {
  setHoveredMatch(null);
});

terminal.onSelectionChange(() => {
  scheduleTerminalSelectionCommentHint();
});
// Esc resumes a frozen view (and abandons any in-progress comment) — the easy
// cancel. Registered before any composer's own Esc so it wins while frozen.
//
// It also disarms a pill on an unfrozen view: an armed pill owns the next
// printable key, so on idle output (select a word, then start typing a command)
// there has to be a way to hand that key back to the shell. Scoped to keystrokes
// aimed at the terminal, so Esc still closes a viewer or a picker that has focus.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const disarmOnly = !terminalOutputFrozen;
  if (disarmOnly && !(terminalCommentSelectionHint && isSelectionCommentTypingTarget(event.target))) return;
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
  if (disarmOnly) {
    clearTerminalSelection();
    hideTerminalSelectionCommentHint();
    return;
  }
  cancelTerminalFreeze();
}, true);
document.addEventListener('keydown', handleSelectionCommentHintKeydown, true);

// Navigable text defers its action to mouseup so a press that becomes a drag is
// a text selection (letting you select — and comment on — a symbol or source
// line) while a press that stays put is a click that navigates.
let pendingDecorationPress = null;

screenElement.addEventListener('mousedown', (event) => {
  // Only a fresh sequence clears the OSC 8 guard. xterm activates a hyperlink on
  // every mouseup, so on a double click over a URL that is both a visible match
  // and an OSC 8 link, the second release would re-open what the first press
  // already navigated to.
  if (event.detail <= 1) pressConsumedByDecoration = false;
  // IDE-bound matches sit out a plain click and wait for ctrl/cmd, so nothing is
  // armed here and a double-click that selects a word to comment on it navigates
  // nowhere on its first press.
  const match = (event.button === 0 && !event.shiftKey)
    ? matchForPress(getClickableMatchAtMouseEvent(event), event)
    : null;
  pendingDecorationPress = beginDecorationPress({
    button: event.button,
    shiftKey: event.shiftKey,
    match,
    x: event.clientX,
    y: event.clientY,
    detail: event.detail,
  });
});

// Capture phase so the OSC 8 guard is set before xterm's own mouseup link
// activation runs; otherwise a URL that is both a match and an OSC 8 link could
// open twice on a plain click.
document.addEventListener('mouseup', (event) => {
  const press = pendingDecorationPress;
  pendingDecorationPress = null;
  const outcome = resolveDecorationPress(press, {
    button: event.button,
    x: event.clientX,
    y: event.clientY,
  });
  if (outcome !== 'navigate' || !press || !press.match) return;
  pressConsumedByDecoration = true;
  // It was a click, not a drag. Clear any sub-threshold selection xterm started
  // on the (un-prevented) mousedown, and do NOT stopPropagation this mouseup —
  // xterm needs it to end its own selection-drag state, or later mouse moves
  // keep extending a selection. The OSC 8 double-open is guarded by the flag.
  try { terminal.clearSelection(); } catch {}
  // Navigating moves attention to the viewer — release a bare freeze this press
  // may have caused (a slow click can outlast the hold threshold). A freeze
  // anchoring comment work stays.
  if (terminalOutputFrozen && !activeTerminalComment && !queuedTerminalComments.length) {
    unfreezeTerminalOutput();
  }
  const m = press.match;
  if (typeof m.action === 'function') m.action(m, decorationPressOptions(event));
}, true);

// Drag-and-drop file → paste escaped path into terminal
// Prevent Electron's default file navigation on drag-and-drop
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (hasSupportedPathDropType(e.dataTransfer)) {
    e.dataTransfer.dropEffect = 'copy';
  }
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const droppedPaths = extractDroppedPaths({
    dataTransfer: e.dataTransfer,
    getPathForFile: window.pty.getPathForFile,
    platform: window.pty.platform,
  });
  if (!droppedPaths.length) return;

  const escapedPaths = droppedPaths.map((path) => {
    let normalizedPath = path;
    if (window.pty.platform === 'win32') {
      // Convert Windows path to WSL path: C:\foo\bar → /mnt/c/foo/bar
      const m = normalizedPath.match(/^([A-Za-z]):[\\\/](.*)/);
      if (m) {
        normalizedPath = '/mnt/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/');
      }
    }
    return "'" + normalizedPath.replace(/'/g, "'\\''") + "'";
  });

  window.pty.write(escapedPaths.join(' '));
});

// Listen for logs from main process and display in DevTools console
window.pty.onMainLog((msg) => {
  console.log('[main]', msg);
});

// =============================================================================
// Find / Search System (Ctrl+F / Cmd+F)
// =============================================================================

const uf = new uFuzzy({ intraMode: 1 }); // SingleError mode: tolerates 1 typo per term

const searchState = {
  scope: 'terminal',
  isOpen: false,
  query: '',
  matches: [],           // live matches: { kind, row, col, length }
  currentIndex: -1,
  preSearchScrollY: 0,   // saved viewport position
  preSearchWasAtBottom: true,
  preSearchBufferType: 'normal',
  decorations: [],       // search highlight decorations (marker + decoration pairs)
  debounceTimer: null,
  isLoading: false,
};

function getActiveBufferType() {
  return terminal.buffer.active.type;
}

function isAlternateBufferActive() {
  return getActiveBufferType() === 'alternate';
}

function isAltScreenSearchMode() {
  return searchState.scope === 'terminal' && searchState.isOpen && isAlternateBufferActive();
}

function getOpenMarkdownViewer() {
  return markdownViewer && typeof markdownViewer.isOpen === 'function' && markdownViewer.isOpen()
    ? markdownViewer
    : null;
}

// Search follows what you're looking at: a rolled-up viewer still reports
// isOpen() (it owns the band, for mutual exclusion) but it isn't on screen, so
// Ctrl-F targets the terminal until the band is shown again. The other
// getOpenMarkdownViewer() call sites stay broad on purpose — they operate on an
// existing markdown search session, and its cleanup (viewer.closeSearch via the
// band's onHide) runs just after the band rolls up.
function getVisibleMarkdownViewer() {
  const viewer = getOpenMarkdownViewer();
  return viewer && typeof viewer.isVisible === 'function' && viewer.isVisible() ? viewer : null;
}

function getPreferredSearchScope(scope) {
  if (scope === 'terminal') return 'terminal';
  return getVisibleMarkdownViewer() ? 'markdown' : 'terminal';
}

function makeSearchMatchPlaceholders(count, kind) {
  return Array.from({ length: Math.max(0, count) }, () => ({ kind }));
}

function syncMarkdownSearchState(result = {}) {
  const matchCount = Number.isFinite(result.matchCount) ? result.matchCount : 0;
  searchState.matches = makeSearchMatchPlaceholders(matchCount, 'markdown');
  searchState.currentIndex = Number.isFinite(result.currentIndex) ? result.currentIndex : -1;
  searchState.query = typeof result.query === 'string' ? result.query : searchState.query;
  searchState.isLoading = false;
}

function isViewportAtBottom() {
  const buffer = terminal.buffer.active;
  return buffer.viewportY >= buffer.baseY;
}

// Get all buffer lines as an array of { row, text }.
//
// Reads buffer.active — search deliberately follows what you're looking at. In
// normal mode that's the full scrollback (up to scrollback:100000); in a
// full-screen TUI it's the alternate buffer, which keeps NO scrollback (just the
// visible rows), so search can only reach the current screen, not history, while
// the TUI is up (see isAltScreenSearchMode). Viewer-history navigation also
// scans this live frame, but supplements it with buffer.normal and the raw PTY
// accumulator so links erased by later alternate-screen repaints remain usable.
function getBufferLines() {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    lines.push({ row, text: line.translateToString() });
  }
  return lines;
}

function isLiveSearchMatch(match) {
  return !!match && match.kind === 'live';
}

function getCurrentSearchMatch() {
  if (searchState.currentIndex < 0 || searchState.currentIndex >= searchState.matches.length) return null;
  return searchState.matches[searchState.currentIndex];
}

function getBestInitialSearchIndex(matches) {
  const buffer = terminal.buffer.active;
  const viewportCenter = buffer.viewportY + Math.floor(terminal.rows / 2);
  let bestLiveIndex = -1;
  let bestLiveDist = Infinity;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (!isLiveSearchMatch(match)) continue;
    const dist = Math.abs(match.row - viewportCenter);
    if (dist < bestLiveDist) {
      bestLiveDist = dist;
      bestLiveIndex = i;
    }
  }

  if (bestLiveIndex >= 0) return bestLiveIndex;
  return matches.length > 0 ? 0 : -1;
}

function applyCurrentSearchPresentation() {
  if (isAltScreenSearchMode()) {
    return;
  }

  updateCurrentHighlight();
  const match = getCurrentSearchMatch();
  if (!match) return;
  scrollToCurrentMatch();
}

// Exact case-insensitive search across all buffer lines
function searchExact(query) {
  const lowerQuery = query.toLowerCase();
  const matches = [];
  const lines = getBufferLines();
  for (const { row, text } of lines) {
    const lowerText = text.toLowerCase();
    let idx = 0;
    while ((idx = lowerText.indexOf(lowerQuery, idx)) !== -1) {
      matches.push({ row, col: idx, length: query.length });
      idx += 1; // advance by 1 to find overlapping matches
    }
  }
  return matches;
}

// Fuzzy search using uFuzzy — fallback when exact yields 0 results
function searchFuzzy(query) {
  const lines = getBufferLines();
  const haystack = lines.map((l) => l.text);

  const idxs = uf.filter(haystack, query);
  if (!idxs || idxs.length === 0) return [];

  const info = uf.info(idxs, haystack, query);
  const order = uf.sort(info, haystack, query);

  const matches = [];
  for (const idx of order) {
    const lineIdx = idxs[info.idx[idx]];
    const row = lines[lineIdx].row;
    const ranges = info.ranges[idx]; // flat array of [start, end, start, end, ...]
    // Each pair is a contiguous highlight range
    for (let r = 0; r < ranges.length; r += 2) {
      const col = ranges[r];
      const length = ranges[r + 1] - ranges[r]; // uFuzzy ranges are [start, end) — end exclusive
      matches.push({ row, col, length });
    }
  }

  // Sort by row, then col
  matches.sort((a, b) => a.row - b.row || a.col - b.col);
  return matches;
}

// Run search: exact first, fuzzy fallback if 0 live exact hits and query >= 2 chars
async function runSearch(query) {
  if (searchState.scope === 'markdown') {
    const viewer = getOpenMarkdownViewer();
    if (!viewer) {
      closeSearchBar({ restoreFocus: false });
      return;
    }
    searchState.query = query;
    searchState.isLoading = !!query;
    const result = viewer.runSearch(query);
    syncMarkdownSearchState(result);
    updateSearchNavigationState();
    updateSearchCount();
    return;
  }

  const altScreenOnly = isAltScreenSearchMode();
  clearSearchDecorations();
  searchState.query = query;
  searchState.matches = [];
  searchState.currentIndex = -1;
  searchState.isLoading = !!query;

  if (!query) {
    searchState.isLoading = false;
    updateSearchNavigationState();
    updateSearchCount();
    return;
  }

  let liveMatches = searchExact(query).map((match) => ({
    ...match,
    kind: 'live',
  }));
  // Fuzzy only for word-like queries. Punctuation (e.g. "work//", "foo.bar") means
  // the user typed it literally, so keep it exact — fuzzy loosely matches such a
  // query to unrelated lines (matching just "work" and ignoring "//"), which shows
  // a hit count whose ranges don't line up with the query, desyncing count from
  // the visible highlights.
  if (liveMatches.length === 0 && query.length >= 2 && /^[\w\s]+$/.test(query)) {
    liveMatches = searchFuzzy(query).map((match) => ({
      ...match,
      kind: 'live',
    }));
  }

  searchState.isLoading = false;
  searchState.matches = liveMatches;

  if (searchState.matches.length > 0) {
    searchState.currentIndex = altScreenOnly ? -1 : getBestInitialSearchIndex(searchState.matches);
    createSearchDecorations();
    applyCurrentSearchPresentation();
  }

  updateSearchNavigationState();
  updateSearchCount();
}

// Create xterm decorations for live search matches in the active buffer
function createSearchDecorations() {
  clearSearchDecorations();
  const buffer = terminal.buffer.active;
  const altScreenOnly = isAltScreenSearchMode();

  for (let i = 0; i < searchState.matches.length; i++) {
    const match = searchState.matches[i];
    if (!isLiveSearchMatch(match)) continue;

    const isCurrent = i === searchState.currentIndex;

    const marker = terminal.registerMarker(match.row - buffer.baseY - buffer.cursorY);
    if (!marker) continue;

    const decoration = terminal.registerDecoration({
      marker,
      x: match.col,
      width: match.length,
      layer: 'top',
    });

    if (!decoration) {
      marker.dispose();
      continue;
    }

    const bgColor = altScreenOnly
      ? 'rgba(234, 179, 8, 0.32)'
      : (isCurrent ? 'rgba(234, 179, 8, 0.55)' : 'rgba(234, 179, 8, 0.18)');
    decoration.onRender((element) => {
      const viewportLine = marker.line - terminal.buffer.active.viewportY;
      if (isAlternateBufferActive() && viewportLine >= 0 && viewportLine < terminal.rows) {
        element.style.display = 'block';
      }
      element.style.backgroundColor = bgColor;
      element.style.pointerEvents = 'none'; // don't interfere with clickable decorations
    });

    searchState.decorations.push({ marker, decoration, matchIndex: i });
  }
}

// Update the highlight of current vs other matches without recreating all decorations
function updateCurrentHighlight() {
  if (isAltScreenSearchMode()) return;

  for (const entry of searchState.decorations) {
    const isCurrent = entry.matchIndex === searchState.currentIndex;
    const bgColor = isCurrent ? 'rgba(234, 179, 8, 0.55)' : 'rgba(234, 179, 8, 0.18)';
    // Update via onRender — the element may not be rendered yet
    entry.decoration.onRender((element) => {
      element.style.backgroundColor = bgColor;
    });
  }
}

// Clear all search decorations
function clearSearchDecorations() {
  for (const entry of searchState.decorations) {
    entry.decoration.dispose();
    entry.marker.dispose();
  }
  searchState.decorations = [];
}

// Scroll viewport to center the current live match
function scrollToCurrentMatch() {
  const match = getCurrentSearchMatch();
  if (!isLiveSearchMatch(match)) return;
  const targetLine = Math.max(0, match.row - Math.floor(terminal.rows / 2));
  terminal.scrollToLine(targetLine);
}

// Navigate to next match (with wrap-around)
function navigateToNextMatch() {
  if (searchState.scope === 'markdown') {
    const viewer = getOpenMarkdownViewer();
    if (!viewer || searchState.matches.length === 0) return;
    syncMarkdownSearchState(viewer.navigateSearch(1));
    updateSearchCount();
    return;
  }

  if (!shouldNavigateSearchResults({
    isAltScreenSearchMode: isAltScreenSearchMode(),
    matchCount: searchState.matches.length,
  })) return;
  searchState.currentIndex = (searchState.currentIndex + 1) % searchState.matches.length;
  applyCurrentSearchPresentation();
  updateSearchCount();
}

// Navigate to previous match (with wrap-around)
function navigateToPrevMatch() {
  if (searchState.scope === 'markdown') {
    const viewer = getOpenMarkdownViewer();
    if (!viewer || searchState.matches.length === 0) return;
    syncMarkdownSearchState(viewer.navigateSearch(-1));
    updateSearchCount();
    return;
  }

  if (!shouldNavigateSearchResults({
    isAltScreenSearchMode: isAltScreenSearchMode(),
    matchCount: searchState.matches.length,
  })) return;
  searchState.currentIndex = (searchState.currentIndex - 1 + searchState.matches.length) % searchState.matches.length;
  applyCurrentSearchPresentation();
  updateSearchCount();
}

function updateSearchNavigationState() {
  const prevBtn = document.getElementById('search-prev');
  const nextBtn = document.getElementById('search-next');
  const navigationState = getSearchNavigationState({
    isAltScreenSearchMode: isAltScreenSearchMode(),
  });
  const displayValue = navigationState.hidden ? 'none' : '';

  if (prevBtn) {
    prevBtn.disabled = navigationState.disabled;
    prevBtn.style.display = displayValue;
  }

  if (nextBtn) {
    nextBtn.disabled = navigationState.disabled;
    nextBtn.style.display = displayValue;
  }
}

// Update the match counter display
function updateSearchCount() {
  const countEl = document.getElementById('search-count');
  if (!countEl) return;
  const altScreenOnly = isAltScreenSearchMode();
  const liveCount = searchState.matches.filter((match) => isLiveSearchMatch(match)).length;
  countEl.textContent = getSearchCountText({
    isLoading: searchState.isLoading,
    isAltScreenSearchMode: altScreenOnly,
    query: searchState.query,
    matchCount: searchState.matches.length,
    liveCount,
    historyCount: 0,
    currentIndex: searchState.currentIndex,
  });
}

// Open the search bar
function openSearchBar(scope) {
  const bar = document.getElementById('search-bar');
  const input = document.getElementById('search-input');
  if (!bar || !input) return;

  const nextScope = getPreferredSearchScope(scope);
  if (searchState.isOpen && searchState.scope !== nextScope) {
    closeSearchBar({ restoreFocus: false });
  }

  searchState.scope = nextScope;
  const markdownSearch = nextScope === 'markdown' ? getOpenMarkdownViewer() : null;

  if (!searchState.isOpen && nextScope === 'terminal') {
    searchState.preSearchScrollY = terminal.buffer.active.viewportY;
    searchState.preSearchWasAtBottom = isViewportAtBottom();
    searchState.preSearchBufferType = getActiveBufferType();
  }

  searchState.isOpen = true;
  bar.style.display = 'flex';

  if (markdownSearch) {
    syncMarkdownSearchState(markdownSearch.openSearch());
  }

  updateSearchNavigationState();
  updateSearchCount();

  // Pre-fill from the active search target selection if any.
  if (markdownSearch) {
    const selected = markdownSearch.getSearchSelectionText();
    if (selected && selected.length < 200) {
      input.value = selected;
    }
  } else if (terminal.hasSelection()) {
    const sel = terminal.getSelection();
    if (sel && sel.length < 200) {
      input.value = sel;
    }
  }

  input.focus();
  input.select();

  // Run search if there's already text
  if (input.value) {
    void runSearch(input.value);
  }
}

// Close the search bar
function closeSearchBar({ restoreFocus = true } = {}) {
  const bar = document.getElementById('search-bar');
  if (!bar) return;

  clearTimeout(altScreenSearchRefreshTimer);
  const previousScope = searchState.scope;
  searchState.isOpen = false;
  bar.style.display = 'none';

  if (previousScope === 'markdown') {
    const viewer = getOpenMarkdownViewer();
    if (viewer) viewer.closeSearch();
  } else {
    clearSearchDecorations();
  }

  searchState.matches = [];
  searchState.currentIndex = -1;
  searchState.query = '';
  searchState.isLoading = false;
  searchState.scope = 'terminal';
  updateSearchNavigationState();

  if (previousScope === 'terminal' && getActiveBufferType() === searchState.preSearchBufferType) {
    if (searchState.preSearchWasAtBottom) {
      terminal.scrollToBottom();
    } else {
      terminal.scrollToLine(searchState.preSearchScrollY);
    }
  }
  if (restoreFocus && previousScope === 'terminal') terminal.focus();
}

// Initialize search bar event wiring
function initSearchBar() {
  const input = document.getElementById('search-input');
  const prevBtn = document.getElementById('search-prev');
  const nextBtn = document.getElementById('search-next');
  const closeBtn = document.getElementById('search-close');
  if (!input) return;
  const bar = document.getElementById('search-bar');

  if (bar) {
    bar.addEventListener('mousedown', (e) => e.stopPropagation());
    bar.addEventListener('click', (e) => e.stopPropagation());
  }

  // Debounced search on input
  input.addEventListener('input', () => {
    clearTimeout(searchState.debounceTimer);
    searchState.debounceTimer = setTimeout(() => {
      void runSearch(input.value);
    }, 150);
  });

  // Keyboard navigation inside search input
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const canNavigate = shouldNavigateSearchResults({
      isAltScreenSearchMode: isAltScreenSearchMode(),
      matchCount: searchState.matches.length,
    });

    if (e.key === 'Escape') {
      closeSearchBar();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!canNavigate) return;
      if (e.shiftKey) {
        navigateToPrevMatch();
      } else {
        navigateToNextMatch();
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!canNavigate) return;
      navigateToPrevMatch();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!canNavigate) return;
      navigateToNextMatch();
      return;
    }
  });

  // Stop keypress/keyup from reaching the terminal
  input.addEventListener('keypress', (e) => e.stopPropagation());
  input.addEventListener('keyup', (e) => e.stopPropagation());

  // Button handlers
  if (prevBtn) prevBtn.addEventListener('click', () => navigateToPrevMatch());
  if (nextBtn) nextBtn.addEventListener('click', () => navigateToNextMatch());
  if (closeBtn) closeBtn.addEventListener('click', () => closeSearchBar());
}

initSearchBar();

let altScreenSearchRefreshTimer = null;

function scheduleAltScreenSearchRefresh(delay = 50) {
  if (!isAltScreenSearchMode() || !searchState.query) return;
  clearTimeout(altScreenSearchRefreshTimer);
  altScreenSearchRefreshTimer = setTimeout(() => {
    if (!isAltScreenSearchMode() || !searchState.query) return;
    void runSearch(searchState.query);
  }, delay);
}

// =============================================================================
// Clickable Text Decoration System
// =============================================================================
//
// DEBUG MODE: Set to true to see processing logs in console
const DEBUG = false;

// Source code extensions - used for IDE/PyCharm file context navigation
const SOURCE_EXTENSIONS = /\.(js|ts|jsx|tsx|mjs|cjs|py|pyc|pyi|rb|rs|go|java|c|h|cpp|hpp|cc|cs|swift|kt|scala|php|pl|sh|bash|zsh|css|scss|sass|less|sql|html|htm|xml|json|yaml|yml|toml|ini|cfg|md|txt|rst)$/i;

// Resource file extensions - opened with OS default handler (not IDE)
const RESOURCE_EXTENSIONS = /\.(png|jpe?g|gif|svg|ico|webp|bmp|tiff?|pdf|docx?|xlsx?|pptx?|rtf|epub|mp[34]|wav|avi|mov|mkv|flac|ogg|webm|zip|tgz|gz|bz2|xz|rar|7z|zst|csv|tsv|parquet|avro)$/i;

// All file extensions - used to prevent filenames from being treated as symbols
const FILE_EXTENSIONS = /\.(js|ts|jsx|tsx|mjs|cjs|py|pyc|pyi|rb|rs|go|java|class|c|h|cpp|hpp|cc|cs|swift|kt|scala|php|pl|sh|bash|zsh|json|xml|yaml|yml|toml|ini|cfg|md|txt|rst|html|htm|css|scss|sass|less|sql|r|d|f|f90|m|mm|lua|tcl|v|sv|vhd|vhdl|zig|nim|cr|ex|exs|erl|hrl|hs|ml|mli|fs|fsi|clj|cljs|elm|dart|jl|groovy|gradle|cmake|coffee|vue|svelte|astro|wasm|proto|csv|tsv|env|conf|graphql|gql|avro|parquet|pdf|doc|docx|xls|xlsx|ppt|pptx|rtf|tex|epub|png|jpg|jpeg|gif|svg|ico|webp|bmp|tiff|tif|mp3|mp4|wav|avi|mov|mkv|flac|ogg|webm|zip|tar|gz|bz2|xz|rar|7z|tgz|zst|so|dll|dylib|a|o|obj|lib|exe|bin|dmg|iso|deb|rpm|msi|whl|egg|gem|jar|war|pdb|map|log|lock|bak|tmp|old|orig)$/i;
const MARKDOWN_EXTENSIONS = /\.(?:md|markdown|mdown)$/i;
const DISPLAY_PATH_PREFIX = /^(?:\.\.\.|…)(?:[\\/]+|[^\\/]+[\\/]+)/;
const TRAILING_PATH_PUNCTUATION = /[.,;:!?]+$/;

function normalizeNavigablePath(text) {
  if (!text) return null;
  let normalized = text.replace(DISPLAY_PATH_PREFIX, '');
  normalized = normalized.replace(TRAILING_PATH_PUNCTUATION, '');
  return normalized || null;
}

// --- Claude Code image attachments -----------------------------------------
// Claude Code prints attached/echoed images as `› [image]<path> (<size>)`. When
// the path outruns the row, Ink keeps the size pinned to the right of the first
// row and hangs the remainder onto following rows, indented to the column where
// the path began — splitting the path mid-token. These are hard newlines
// (isWrapped=false), and the bytes between the two path pieces are the size
// annotation plus padding, so neither xterm's wrap-stitching nor the generic
// path matchers ever see a whole path. Reassemble the pieces by geometry so the
// image resolves to one clickable target.
const IMAGE_ATTACHMENT_MARKER = '[image]';
// A trailing size like " (422KB)", " (1.2 MB)", " (<1 KB)".
const IMAGE_SIZE_ANNOTATION = /\s+\(\s*[<~]?\s*\d[\d.,]*\s?(?:[KMGT]i?)?B\)\s*$/i;

// Parse a candidate head row. Returns { pathCol, head } where head is the path
// fragment shown on this row (size annotation and trailing padding removed), or
// null when the row is not an image-attachment head.
function parseImageAttachmentHead(rowText) {
  const text = String(rowText == null ? '' : rowText).replace(/\s+$/, '');
  const markerIdx = text.indexOf(IMAGE_ATTACHMENT_MARKER);
  if (markerIdx === -1) return null;
  // The path may sit immediately after the marker or after a space
  // ("[image]/path" vs "[image] /path"); skip the gap so pathCol lands on the
  // path's first character (and the hang indent lines up with it).
  const afterMarker = markerIdx + IMAGE_ATTACHMENT_MARKER.length;
  const pathCol = afterMarker + text.slice(afterMarker).match(/^\s*/)[0].length;
  const head = text.slice(pathCol).replace(IMAGE_SIZE_ANNOTATION, '');
  // The head is a path fragment: non-empty and space-free.
  if (!head || /\s/.test(head)) return null;
  return { markerCol: markerIdx, pathCol, head };
}

// Stitch a head row plus its hanging-indented continuation rows into one path.
// Returns { headRow, endRow, pathCol, fullPath, segments:[{row,col,width,text}] }
// or null when `headRow` isn't an attachment head or the path isn't a resource.
function analyzeImageAttachment(buffer, headRow) {
  const headLine = buffer.getLine(headRow);
  if (!headLine) return null;
  const parsed = parseImageAttachmentHead(headLine.translateToString());
  if (!parsed) return null;
  const { markerCol, pathCol, head } = parsed;

  const segments = [{ row: headRow, col: pathCol, width: head.length, text: head }];
  let full = head;
  let endRow = headRow;

  // Ink only wraps a path that doesn't fit, so once the accumulated path ends in
  // a known resource extension it is complete — stop before swallowing unrelated
  // output below it.
  const complete = () => RESOURCE_EXTENSIONS.test(normalizeNavigablePath(full) || full);
  for (let row = headRow + 1; !complete() && row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) break;
    const raw = line.translateToString().replace(/\s+$/, '');
    // A hanging-indent continuation: blank out to the marker column, then a
    // single bare fragment (no interior space, no new marker). Ink hangs the
    // wrap under the "[image]" region, which can land a column or two left of
    // pathCol (before the space we skipped past), so anchor the required-blank
    // prefix at the marker — never left of "[image]" — not at the path.
    if (raw.length <= markerCol || raw.slice(0, markerCol).trim() !== '') break;
    const fragCol = markerCol + raw.slice(markerCol).match(/^\s*/)[0].length;
    const frag = raw.slice(fragCol);
    if (!frag || /\s/.test(frag) || frag.includes(IMAGE_ATTACHMENT_MARKER)) break;
    segments.push({ row, col: fragCol, width: frag.length, text: frag });
    full += frag;
    endRow = row;
  }

  if (!complete()) return null;
  return { headRow, endRow, pathCol, fullPath: normalizeNavigablePath(full) || full, segments };
}

// A parseRow-style match for one on-screen segment of the stitched path. `text`
// sizes the underline to the visible fragment; the action opens the reassembled
// whole path (an image opens with the OS default app via openResourceChoosing).
function imageAttachmentSegmentMatch(analysis, seg) {
  return {
    patternName: 'image_attachment',
    text: seg.text,
    start: seg.col,
    end: seg.col + seg.width,
    bufferRow: seg.row,
    style: 'default',
    priority: 'high',
    action: async (match, options = {}) => {
      const mod = options.modifiers || {};
      // The stitched path is always an image by construction, so it renders in
      // the band unless a modifier asks for the OS.
      if (isViewableImagePath(analysis.fullPath) && !imageWantsOsHandoff(mod)) {
        if (await openImageInViewer(analysis.fullPath)) return;
      }
      const result = await openResourceChoosing(analysis.fullPath, { forceChoose: !!mod.altKey });
      if (result && !result.success && !result.dismissed) {
        showToast(result.error || 'Could not open file');
      }
    },
  };
}

// Click resolution: does (bufferRow, col) land on a stitched image path? A click
// can land on the head row or any continuation, so scan the click row and a
// bounded window above it for the attachment head, then test the segment spans.
function imageAttachmentMatchAt(buffer, bufferRow, col) {
  for (let h = bufferRow; h >= 0 && h >= bufferRow - 24; h--) {
    const line = buffer.getLine(h);
    if (!line || !parseImageAttachmentHead(line.translateToString())) continue;
    const analysis = analyzeImageAttachment(buffer, h);
    if (analysis && analysis.endRow >= bufferRow) {
      const seg = analysis.segments.find(
        (s) => s.row === bufferRow && col >= s.col && col < s.col + s.width,
      );
      if (seg) return imageAttachmentSegmentMatch(analysis, seg);
    }
    if (h === bufferRow) break; // clicked a head row but outside the path span
  }
  return null;
}

function isMarkdownDocumentPath(text) {
  return MARKDOWN_EXTENSIONS.test(String(text || ''));
}

// Windows-side output prints WSL files in UNC form (\\wsl.localhost\<distro>\...,
// legacy \\wsl$\...). Everything downstream (openResource, navigateToFileLine,
// the md viewer) speaks WSL POSIX paths, so convert at the decoration boundary:
// strip the \\wsl…\<distro> prefix and flip separators. The distro segment is
// dropped — paths printed in this terminal come from its own distro.
const WSL_UNC_PREFIX = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+/i;
function wslUncToPosix(text) {
  return text.replace(WSL_UNC_PREFIX, '').replace(/\\/g, '/');
}

const HTML_EXTENSIONS = /\.(?:html?|xhtml)$/i;
function isHtmlDocumentPath(text) {
  return HTML_EXTENSIONS.test(String(text || ''));
}

// Images the viewer band can render itself. Looking at a screenshot the agent
// just produced is a reading action, the same as opening a doc, so it belongs in
// a built-in viewer rather than in whatever app the OS would hand it to — which
// is a full application switch for something that fits in the band. A modifier
// still sends it to the OS, same as any other viewer target.
//
// Deliberately narrower than RESOURCE_EXTENSIONS: pdf, archives and media stay
// handoffs, since the band has nothing better to do with them than the OS does.
const VIEWABLE_IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|svg|webp|bmp|ico)$/i;
function isViewableImagePath(text) {
  return VIEWABLE_IMAGE_EXTENSIONS.test(String(text || ''));
}

// Open an image in the viewer band. Returns false when the path can't be
// resolved to a file:// URL, leaving the caller to fall back to the OS — the
// same shape the .html branch uses.
//
// There is no external variant on purpose. On a URL the modifier means the
// system browser, but the escalation for an image is the OS default app: a
// browser tab is a worse place to look at a PNG than Preview is. So a modified
// click skips this entirely and takes the openResourceChoosing path below.
async function openImageInViewer(filePath) {
  const res = await window.pty.resolveFileUrl(filePath);
  if (res && res.success && res.url) {
    openUrlFromTerminal(res.url, 'image-file', false);
    return true;
  }
  return false;
}

// A modified click on an image asks for the OS instead of the band. Alt is
// included because it already means "choose among all matches" before opening.
function imageWantsOsHandoff(mod) {
  return !!(mod && (mod.ctrlKey || mod.metaKey || mod.altKey));
}

// Check if text looks like a file path (known extension or structured path)
function isLikelyFilePath(text) {
  if (SOURCE_EXTENSIONS.test(text)) return true;
  if (!text.includes('/')) return false;
  // Has slash — require real path evidence (not just "word/word" in prose)
  if (text.length < 3) return false;
  // Accept: known file extension, path prefix (/, ./, ../, ~/), or 4+ segments
  return FILE_EXTENSIONS.test(text) || /^(?:\.{0,2}|~)\//.test(text)
    || text.split('/').length >= 4;
}

// Matches identifiers that look like code symbols (underscore, camelCase, PascalCase)
const IS_SYMBOL_LIKE = /^(?:_[a-zA-Z0-9_]+|[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]*|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[A-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)$/;

// Check if a symbol match at (index, matchLength) in line is a file path component.
// Returns true → reject as path, false → allow as symbol.
function isLikelyPathNotSymbol(line, index, matchLength) {
  const charBefore = index > 0 ? line[index - 1] : '';
  const charAfter = line[index + matchLength] || '';
  if (charBefore !== '/' && charBefore !== '\\' && charAfter !== '/' && charAfter !== '\\') return false;

  // Extract the full path-like token around this match
  let ts = index;
  while (ts > 0 && /[a-zA-Z0-9_.\/\\-]/.test(line[ts - 1])) ts--;
  let te = index + matchLength;
  while (te < line.length && /[a-zA-Z0-9_.\/\\-]/.test(line[te])) te++;
  const fullToken = line.substring(ts, te).replace(/\\/g, '/');
  if (isLikelyFilePath(fullToken)) return true;

  // Not obviously a file path — check if adjacent segment is also a symbol.
  // If yes, treat as "A/B" notation; if no, treat as path.
  if (charBefore === '/' || charBefore === '\\') {
    let i = index - 2;
    while (i >= 0 && /[a-zA-Z0-9_]/.test(line[i])) i--;
    if (!IS_SYMBOL_LIKE.test(line.substring(i + 1, index - 1))) return true;
  }
  if (charAfter === '/' || charAfter === '\\') {
    let i = index + matchLength + 1;
    while (i < line.length && /[a-zA-Z0-9_]/.test(line[i])) i++;
    if (!IS_SYMBOL_LIKE.test(line.substring(index + matchLength + 1, i))) return true;
  }
  return false;
}

const CODE_KEYWORDS = /^(?:def|class|if|elif|else:|for|while|return|import|from|try:|except|finally:|with|yield|raise|pass|break|continue|lambda|assert|function|const|let|var|async|await|export|switch|case|throw|new|fn|pub|struct|enum|impl|match|use|type|interface|package)\b/;

function looksLikeCode(text) {
  // Strong signal: starts with a code keyword
  if (CODE_KEYWORDS.test(text)) return true;

  // Count code-like features
  let signals = 0;
  if (/\w+\(/.test(text)) signals++;         // function call
  if (/[=!<>]=|[<>]/.test(text)) signals++;  // operators
  if (/[{}\[\]()]/.test(text)) signals++;    // brackets/parens
  if (/\w\.\w/.test(text)) signals++;        // dot access
  if (/;\s*$/.test(text)) signals++;         // trailing semicolon
  if (/^\s*[#\/]/.test(text)) signals++;     // comment start
  if (/\w+\s*=\s*\S/.test(text)) signals++; // assignment

  // Lines with many words are likely prose with embedded code references;
  // require stronger evidence (e.g. "- process_user_group() discovers the user group...")
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  if (words >= 6) signals--;

  return signals >= 2;
}

function isLikelySourceLine(text) {
  let content;

  // Bordered: strip │ borders to get inner content
  const bordered = /^\s*[│┃|] (.+?)(?:\s+[│┃|])?\s*$/.exec(text);
  if (bordered) {
    content = bordered[1];
  } else {
    // Borderless: require 4+ leading spaces
    const trimmed = text.trimStart();
    if (text.length - trimmed.length < 4) return false;
    content = trimmed;
  }

  if (!content || !content.trim()) return false;

  const trimmed = content.trim();

  // Reject file paths
  if (isLikelyFilePath(trimmed)) return false;

  // Reject overly long lines (prose, not code)
  if (trimmed.length > 120) return false;

  return looksLikeCode(trimmed);
}

function hasLeadingLineRefContext(line, index) {
  const prefix = line.substring(0, index);
  return /\b[Ll]ines?\s+~?\d+(?:\s*-\s*~?\d+)?(?:,\s*~?\d+(?:\s*-\s*~?\d+)?)?\s+(?:in|of)\s+["'`]?$/i.test(prefix);
}

function getBorderedContentSpan(text) {
  const left = /^\s*[│┃|]\s/.exec(text);
  if (!left) return null;

  const start = left[0].length;
  let end = text.length;
  const right = /\s+[│┃|]\s*$/.exec(text.substring(start));
  if (right) end = start + right.index;

  return {
    content: text.substring(start, end),
    start,
    end,
  };
}

function getCursorDiffContentSpan(text) {
  const bordered = getBorderedContentSpan(text);
  if (bordered) return bordered;

  const gutter = /^(\s*)▎(.*)$/.exec(text);
  if (!gutter) return null;

  let start = gutter[1].length + 1;
  let content = gutter[2];
  if (content.startsWith(' ')) {
    start += 1;
    content = content.slice(1);
  }

  return {
    content,
    start,
    end: text.length,
  };
}

// A changed line allows content flush against the marker (`628 -*prose`), so the
// marker branch uses \s* after the marker; a context line has no marker, so it still
// requires \s{2,} to separate the number from content (keeps `42hello` from matching).
const STRICT_DIFF_LINE_REGEX = /^\s{2,}(\d+)(?:\s([+-])\s*|\s{2,})(\S.*)$/;
const INNER_DIFF_LINE_REGEX = /^\s*(\d+)(?:\s([+-])\s*|\s{2,})(\S.*)$/;

function parseDiffLineText(text, { allowInner = false } = {}) {
  const bordered = getBorderedContentSpan(text);
  const source = bordered ? bordered.content : text;
  const m = (bordered || allowInner ? INNER_DIFF_LINE_REGEX : STRICT_DIFF_LINE_REGEX).exec(source);
  if (!m) return null;

  return {
    lineNum: parseInt(m[1], 10),
    marker: m[2],
    codeText: m[3].trim(),
  };
}

const CURSOR_DIFF_HEADER_REGEX = /^(\S.*?)\s+\+\d+(?:\s+-\d+)?$/;
const CURSOR_DIFF_HEADER_PREFIX_REGEX = /^Edited\s+/i;

// Header that opens a Cursor diff box, e.g. "src/foo.md +3 -6" or
// "Edited src/foo.md +5" (often with a truncated "..." path prefix). The change-count
// suffix is the anchor; the captured path must still look like a file, so prose is rejected.
function parseCursorDiffHeader(text) {
  const bordered = getCursorDiffContentSpan(text);
  const source = (bordered ? bordered.content : text).trim().replace(CURSOR_DIFF_HEADER_PREFIX_REGEX, '');
  const m = CURSOR_DIFF_HEADER_REGEX.exec(source);
  if (!m) return null;
  const path = m[1].trim();
  const normalized = normalizeNavigablePath(path) || path;
  return isLikelyFilePath(normalized) ? { path } : null;
}

// A changed line inside a bordered diff that has NO line-number gutter (e.g. Cursor):
// the first column after the border is a +/- marker, content follows. Only prose is
// claimed here — code is left to source_line, paths/headers are excluded — and the
// caller still gates on a diff header above (findCursorDiffHeader) before decorating,
// since a lone "│ - bullet" is otherwise indistinguishable from a list in any box.
function parseCursorDiffBlockLine(text) {
  const bordered = getCursorDiffContentSpan(text);
  if (!bordered) return null;
  const inner = bordered.content;
  const marker = inner[0];
  if (marker !== '+' && marker !== '-') return null;
  const afterMarker = inner.slice(1);
  const content = afterMarker.trim();
  if (!content || content.length > 200) return null;
  if (isLikelyFilePath(content)) return null;
  if (looksLikeCode(content)) return null;
  const leading = afterMarker.length - afterMarker.trimStart().length;
  const contentStart = bordered.start + 1 + leading;
  return { marker, content, contentStart, contentEnd: contentStart + content.length };
}

// Capture recent errors to a global array for debugging (capped at 100)
window._decorErrors = [];
window.onerror = (msg, url, line, col, error) => {
  if (window._decorErrors.length >= 100) window._decorErrors.shift();
  window._decorErrors.push({ msg, url, line, col, stack: error?.stack });
  console.error('[decor error]', msg, error?.stack);
};

function debug(...args) {
  if (DEBUG) console.log('[decor]', ...args);
}

// Show visual feedback for clicks (temporary flash)
function showClickFeedback(text, patternName, status = 'info') {
  const feedback = document.createElement('div');
  feedback.textContent = `Clicked: ${text} (${patternName})`;

  const bgColors = {
    info: '#569cd6',
    success: '#6a9955',
    error: '#f44747',
  };

  feedback.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: ${bgColors[status] || bgColors.info};
    color: white;
    padding: 8px 16px;
    border-radius: 4px;
    font-family: sans-serif;
    font-size: 14px;
    z-index: 9999;
    animation: fadeOut 2s forwards;
  `;

  // Add fadeOut animation if not exists
  if (!document.getElementById('click-feedback-style')) {
    const style = document.createElement('style');
    style.id = 'click-feedback-style';
    style.textContent = `
      @keyframes fadeOut {
        0% { opacity: 1; }
        70% { opacity: 1; }
        100% { opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(feedback);
  setTimeout(() => feedback.remove(), 2000);
}

// Show a simple toast message (blue, 2-second fade)
// variant: 'info' (default, blue) | 'warn' (yellow) | 'error' (red), matching the
// IDE navigation feedback palette in showNavigationFeedback.
function showToast(message, { variant = 'info' } = {}) {
  const palette = {
    info: { bg: '#569cd6', fg: 'white' },
    warn: { bg: '#dcdcaa', fg: '#1e1e1e' },
    error: { bg: '#f44747', fg: 'white' },
  };
  const { bg, fg } = palette[variant] || palette.info;
  // Errors often carry info worth reading/copying (e.g. a render traceback), so an
  // error toast STAYS until dismissed and its text is selectable, with Copy + ✕
  // controls. info/warn stay transient (fade after 2s).
  const sticky = variant === 'error';
  const el = document.createElement('div');
  // Centered at the top so it's actually seen — a content-sized chip in the corner
  // was easy to miss. Bigger type + padding + a shadow; progress lingers a beat.
  el.style.cssText = `
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    background: ${bg}; color: ${fg};
    border-radius: 8px; z-index: 9999; box-shadow: 0 8px 28px rgba(0,0,0,.38);`
    + (sticky
      ? ` max-width: 72vw; max-height: 55vh; overflow: auto; padding: 10px 14px;
          font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;`
      : ` padding: 12px 20px; max-width: 60vw; text-align: center;
          font: 500 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          animation: fadeOut 2.8s forwards;`);
  if (!document.getElementById('click-feedback-style')) {
    const style = document.createElement('style');
    style.id = 'click-feedback-style';
    style.textContent = `@keyframes fadeOut { 0% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }`;
    document.head.appendChild(style);
  }
  if (sticky) {
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:6px; justify-content:flex-end; margin-bottom:6px;';
    const mk = (label, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'font:600 11px sans-serif; cursor:pointer; color:inherit;'
        + 'background:rgba(255,255,255,.22); border:0; border-radius:4px; padding:2px 8px;';
      b.onclick = onClick;
      return b;
    };
    const copy = mk('Copy', () => {
      try { navigator.clipboard.writeText(message); copy.textContent = 'Copied ✓'; } catch {}
    });
    actions.append(copy, mk('✕', () => el.remove()));
    const body = document.createElement('div');
    body.textContent = message;
    body.style.cssText = 'white-space: pre-wrap; user-select: text; -webkit-user-select: text;';
    el.append(actions, body);
  } else {
    el.textContent = message;
    setTimeout(() => el.remove(), 2800);
  }
  document.body.appendChild(el);
}

let markdownViewer = null;
function getMarkdownViewer() {
  if (!markdownViewer) {
    markdownViewer = createMarkdownViewer({
      onOpen: dismissResumeHintOnViewerOpen,
      focusTerminal: () => { try { terminal.focus(); } catch {} },
      readMarkdownFile: (filePath) => window.pty.readMarkdownFile(filePath),
      statMarkdownFile: (filePath) => window.pty.statMarkdownFile(filePath),
      submitMarkdownThreads: (payload) => window.pty.mdAddThreads(payload),
      preflightMarkdownRunbook: (payload) => window.pty.mdRunbookPreflight(payload),
      readMarkdownThreads: (payload) => window.pty.mdReadThreads(payload),
      addMarkdownThreadMessage: (payload) => window.pty.mdAddMessage(payload),
      writeMarkdownFile: (payload) => window.pty.mdWriteFile(payload),
      showToast,
      openURL: (url) => window.pty.openURL(url),
      openDocPath: (filePath) => openMarkdownDocLink(filePath),
      openSearchBar: (scope) => openSearchBar(scope),
      closeSearchBar: () => {
        if (searchState.scope === 'markdown') closeSearchBar();
      },
      getSearchState: () => searchState,
      // Closing the md band clears it as the current viewer (launch/replace
      // bookkeeping for the Ctrl+Shift+O cycle).
      onClose: () => {
        if (!suppressViewerEvict) clearViewerCache(); // user ✕ → forget the cache
      },
      platform: window.pty.platform,
      getTerminalMetrics: () => {
        const rect = screenElement.getBoundingClientRect();
        return {
          top: rect.top,
          height: rect.height,
          rows: terminal.rows,
        };
      },
    });
  }
  return markdownViewer;
}

// A link in an md doc naming another file. It lands where the same path lands
// when clicked in the terminal: .md in this viewer, .html in the web viewer,
// anything else with the OS. No chooser on the way — the path was resolved
// against the doc's own directory, so it is already absolute and unambiguous.
// Recording it as a viewer entry makes Ctrl+Shift+O the way back to the doc you
// followed the link from.
async function openMarkdownDocLink(filePath) {
  if (isMarkdownDocumentPath(filePath)) {
    const opened = await getMarkdownViewer().open({ filePath });
    if (opened) recordViewer('md', filePath);
    return;
  }
  if (isHtmlDocumentPath(filePath)) {
    const res = await window.pty.resolveFileUrl(filePath);
    if (res && res.success && res.url) openUrlFromTerminal(res.url, 'md-link', false);
    else showToast(`Couldn't locate ${filePath}`);
    return;
  }
  const osOpen = await openResourceChoosing(filePath);
  if (!osOpen || (!osOpen.success && !osOpen.dismissed)) showToast(`Couldn't open ${filePath}`);
}

// Show navigation result feedback
function showNavigationFeedback(filePath, line, result) {
  const feedback = document.createElement('div');
  // Named so a test can see that an IDE navigation was attempted at all — the
  // gesture rule is about whether the call fires, which is otherwise invisible
  // on a machine with no IDE listening.
  feedback.className = 'nav-feedback';

  let message;
  let bgColor;

  if (!result.status) {
    // TCP failure — no status field
    message = result.error || 'Navigation failed';
    bgColor = '#f44747'; // red
  } else if (result.status === 'ok') {
    message = `Navigated to ${filePath}` + (line != null ? `:${line}` : '');
    bgColor = '#6a9955'; // green
  } else if (result.status === 'text_moved') {
    message = 'Line moved';
    bgColor = '#dcdcaa'; // yellow
  } else if (result.status === 'multiple') {
    return; // PyCharm shows picker dialog
  } else if (result.status === 'not_found') {
    message = `Not found: ${result.message || filePath}`;
    bgColor = '#f44747'; // red
  } else {
    // error or unknown status
    message = result.message || 'Unknown error';
    bgColor = '#f44747'; // red
  }

  feedback.textContent = message;
  feedback.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: ${bgColor};
    color: ${bgColor === '#dcdcaa' ? '#1e1e1e' : 'white'};
    padding: 8px 16px;
    border-radius: 4px;
    font-family: sans-serif;
    font-size: 14px;
    z-index: 9999;
    animation: fadeOut 3s forwards;
  `;

  // Add fadeOut animation if not exists
  if (!document.getElementById('click-feedback-style')) {
    const style = document.createElement('style');
    style.id = 'click-feedback-style';
    style.textContent = `
      @keyframes fadeOut {
        0% { opacity: 1; }
        70% { opacity: 1; }
        100% { opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(feedback);
  setTimeout(() => feedback.remove(), 3000);
}

// Design: See decisions.md for full rationale. Key points:
//
// 1. APPEND-ONLY PROCESSING
//    - Only process new (unprocessed) rows, never re-process
//    - Never remove decorations (except on resize)
//    - Works because Claude Code output is mostly append-only
//    - Rare in-place changes (progress spinners) may have stale decorations - acceptable
//
// 2. ROW FILTERING
//    - Skip rows at or below cursor (still receiving input)
//    - Skip wrapped rows (processed with their parent to keep patterns intact)
//
// 3. TERMINOLOGY
//    - "Row" = buffer row (fixed width, what xterm.js getLine returns)
//    - "Logical line" = text ending with newline (may span multiple rows)
//    - We use registerDecoration() not ILinkProvider (need proactive underlines)
//
// =============================================================================

// Chooser for ambiguous file-opens: several candidates matched (a duplicate
// filename like README.md, or the cwd/home sweep), so list them and let the
// user pick. A type-to-filter input narrows the list like the session picker —
// case-insensitive, every space-separated term must match — with ↑/↓ + Enter to
// pick, click, or Esc / click-away to dismiss. The focused input is also what
// keeps keystrokes off the terminal: while it holds focus xterm's hidden
// textarea does not, so no capture-phase key-stealing is needed. Same top-center
// placement as the toast family; chrome-grey palette matching the viewer
// selector — app chrome over either backdrop. Resolves to the picked path or null.
function showPathChooser(choices) {
  return new Promise((resolve) => {
    const panel = document.createElement('div');
    // at-modal-overlay: document-level Esc handlers (viewer-band, md viewer)
    // yield to an open modal.
    panel.className = 'at-modal-overlay';
    panel.style.cssText = `
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      background: #26292e; color: #d0d5db; border: 1px solid #45484e;
      border-radius: 8px; z-index: 9999; box-shadow: 0 8px 28px rgba(0,0,0,.5);
      padding: 6px; width: min(640px, 80vw); box-sizing: border-box;
      font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;`;

    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Filter…';
    input.style.cssText = `display: block; width: 100%; box-sizing: border-box;
      margin: 2px 0 6px; padding: 5px 8px; background: #17191d; color: #e6e9ed;
      border: 1px solid #3a3d43; border-radius: 4px; outline: none; font: inherit;`;
    panel.appendChild(input);

    const listEl = document.createElement('div');
    listEl.style.cssText = 'max-height: 46vh; overflow-y: auto;';
    panel.appendChild(listEl);

    // Same-named files share a long directory prefix (the cwd), and that shared
    // head is exactly what a row's end-ellipsis would keep — leaving every row
    // reading identically. Drop the common prefix so the part that DISTINGUISHES
    // the candidates (its subdir) leads the row. Filtering + highlighting run on
    // this display string; the full path is still what the pick resolves to.
    function commonDirPrefix(paths) {
      if (paths.length < 2) return '';
      let pre = paths[0];
      for (const p of paths) {
        let i = 0;
        while (i < pre.length && i < p.length && pre[i] === p[i]) i++;
        pre = pre.slice(0, i);
        if (!pre) break;
      }
      const cut = pre.lastIndexOf('/');
      return cut > 0 ? pre.slice(0, cut + 1) : '';
    }
    const prefix = commonDirPrefix(choices);
    const items = choices.map((full) => ({ full, display: prefix ? full.slice(prefix.length) : full }));

    let filtered = items.slice();
    let selected = 0;
    let rows = [];

    const terms = () => input.value.toLowerCase().split(/\s+/).filter(Boolean);

    // Wrap each term hit in <mark>, building from text nodes (never innerHTML,
    // since paths are untrusted). Overlapping ranges are merged.
    function label(path, ts) {
      const frag = document.createDocumentFragment();
      if (!ts.length) { frag.appendChild(document.createTextNode(path)); return frag; }
      const low = path.toLowerCase();
      const ranges = [];
      for (const t of ts) {
        for (let i = low.indexOf(t); i !== -1; i = low.indexOf(t, i + t.length)) {
          ranges.push([i, i + t.length]);
        }
      }
      ranges.sort((a, b) => a[0] - b[0]);
      let cursor = 0;
      for (const [s, e] of ranges) {
        if (e <= cursor) continue;
        const start = Math.max(s, cursor);
        if (start > cursor) frag.appendChild(document.createTextNode(path.slice(cursor, start)));
        const mark = document.createElement('mark');
        mark.textContent = path.slice(start, e);
        mark.style.cssText = 'background: rgba(255,213,88,.22); color: inherit; border-radius: 2px; padding: 0 1px;';
        frag.appendChild(mark);
        cursor = e;
      }
      if (cursor < path.length) frag.appendChild(document.createTextNode(path.slice(cursor)));
      return frag;
    }
    function applySel() {
      rows.forEach((r, i) => { r.style.background = i === selected ? '#1f3556' : ''; });
      if (rows[selected]) rows[selected].scrollIntoView({ block: 'nearest' });
    }
    function select(i) { selected = i; applySel(); }
    function render() {
      const ts = terms();
      filtered = items.filter((it) => { const low = it.display.toLowerCase(); return ts.every((t) => low.includes(t)); });
      listEl.innerHTML = '';
      rows = filtered.map((it, i) => {
        const row = document.createElement('div');
        row.appendChild(label(it.display, ts));
        row.title = it.full;
        row.style.cssText = `padding: 3px 10px; border-radius: 4px; cursor: pointer;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`;
        row.onmouseenter = () => select(i);
        row.onclick = () => done(it.full);
        listEl.appendChild(row);
        return row;
      });
      if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
      applySel();
    }
    function done(picked) {
      window.removeEventListener('mousedown', onOutside, true);
      panel.remove();
      resolve(picked);
    }
    function onOutside(e) {
      if (!panel.contains(e.target)) done(null);
    }
    input.addEventListener('input', () => { selected = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (rows.length) select(Math.min(selected + 1, rows.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) select(Math.max(selected - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); if (rows.length) done(filtered[selected].full); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    window.addEventListener('mousedown', onOutside, true);
    document.body.appendChild(panel);
    render();
    // Defer focus so the click that opened the chooser doesn't blur it.
    setTimeout(() => input.focus(), 0);
  });
}

// Resolve a path with the full everywhere-sweep (cwd hit included) and let the
// user pick. Returns the picked absolute path, or null: { dismissed } when the
// user closed the chooser, { notFound } when the sweep came up empty.
async function chooseAmongAllMatches(filePath) {
  const res = await window.pty.resolvePathChoices(filePath);
  if (!res || (!res.path && !(res.choices || []).length)) return { notFound: true };
  if (res.path) return { path: res.path };
  const picked = await showPathChooser(res.choices);
  return picked ? { path: picked } : { dismissed: true };
}

// OS-open a path, routing an ambiguous result through the chooser. Dismissing
// the chooser reports { dismissed } so callers neither toast nor fall through
// to the IDE — the user already saw and declined the matches. forceChoose
// (Alt-click) sweeps everywhere up front instead of taking the nearest hit.
async function openResourceChoosing(filePath, { forceChoose = false } = {}) {
  if (forceChoose) {
    const chosen = await chooseAmongAllMatches(filePath);
    if (chosen.dismissed) return { success: false, dismissed: true };
    if (chosen.notFound) return { success: false, error: 'File not found' };
    return await window.pty.openResource(chosen.path);
  }
  const result = await window.pty.openResource(filePath);
  if (result && Array.isArray(result.choices) && result.choices.length) {
    const picked = await showPathChooser(result.choices);
    if (!picked) return { success: false, dismissed: true };
    return await window.pty.openResource(picked);
  }
  return result;
}

function buildFileRequest(filePath, line, column, matchText) {
  const request = { type: 'file', path: filePath };
  if (line != null) request.line = line;
  if (column != null) request.column = column;
  if (matchText != null) request.matchText = matchText;
  return request;
}

// Helper function to navigate to a file:line
async function navigateToFileLine(filePath, line, column, { copyResponse = false, matchText, landingKind, modifiers } = {}) {
  let navigablePath = normalizeNavigablePath(filePath) || filePath;
  const lineSuffix = line != null ? `:${line}` : '';
  const columnSuffix = column != null ? `:${column}` : '';
  debug(`Navigating to: ${navigablePath}${lineSuffix}${columnSuffix}`);

  // Alt-click (Option on Mac): sweep cwd AND the whole home folder and let the
  // user pick WHICH file, before deciding WHERE it opens — the picked path then
  // flows through the normal destinations below (md viewer, web viewer, IDE for
  // anchored clicks, OS open), just in absolute form.
  if (!copyResponse && modifiers && modifiers.altKey) {
    const chosen = await chooseAmongAllMatches(navigablePath);
    if (chosen.dismissed) return;
    if (chosen.notFound) {
      showToast(`Couldn't locate ${navigablePath}`);
      return;
    }
    navigablePath = chosen.path;
  }

  if (!copyResponse && isMarkdownDocumentPath(navigablePath)) {
    // A bare name (README.md) can match several files in the tree. Offer a
    // picker instead of silently opening the first `find` hit; a single match
    // resolves straight through, and a miss falls through to the open below
    // (which keeps the old not-found → OS/IDE fallback). Alt-click has already
    // picked an absolute path by here, so this just confirms it.
    const choice = await window.pty.resolveMarkdownChoices(navigablePath);
    if (choice && Array.isArray(choice.choices)) {
      const picked = await showPathChooser(choice.choices);
      if (!picked) return; // dismissed — the user saw the matches and declined
      navigablePath = picked;
    } else if (choice && choice.path) {
      navigablePath = choice.path;
    }
    if (searchState.isOpen) closeSearchBar({ restoreFocus: false });
    const opened = await getMarkdownViewer().open({
      filePath: navigablePath,
      line,
      matchText,
      landingKind,
    });
    if (opened) { closeWebViewer(); recordViewer('md', navigablePath); return; }
  }

  // .html paths open in the embedded web viewer (not the IDE). Resolve to a
  // file:// URL the webview can load; Ctrl/Cmd-click → system browser.
  if (isHtmlDocumentPath(navigablePath)) {
    const res = await window.pty.resolveFileUrl(navigablePath);
    if (res && res.success && res.url) {
      openUrlFromTerminal(res.url, 'html-file', !!copyResponse);
    } else {
      // An .html path always means the viewer, never the IDE. If we can't locate
      // the file (e.g. relative path not under the resolved cwd), say so.
      showToast(`Couldn't locate ${navigablePath}`);
    }
    return;
  }

  // Un-anchored clicks (no :line, no match text) prefer the OS over the IDE:
  // folders open in the file explorer (Explorer on Windows, Finder on Mac),
  // files in their default app. The IDE earns a click only when it adds
  // something — landing on a line, a match, or a symbol. When the OS side
  // can't find the path at all, fall through and let the IDE try its own
  // project-relative resolution.
  if (!copyResponse && line == null && matchText == null) {
    const osOpen = await openResourceChoosing(navigablePath);
    if (osOpen && (osOpen.success || osOpen.dismissed)) return;
  }

  const result = await window.pty.navigateToFile(navigablePath, line, column, matchText);
  debug('Navigation result:', result);
  if (copyResponse) {
    const request = buildFileRequest(navigablePath, line, column, matchText);
    const { scrollRequest, scrollResponse, ...response } = result;
    const text = JSON.stringify({ request, response, scrollRequest, scrollResponse }, null, 2);
    navigator.clipboard.writeText(text);
    showToast('Response copied to clipboard');
  } else {
    if (result.scrollResponse && (!result.scrollResponse.success || result.scrollResponse.status !== 'ok')) {
      const msg = result.scrollResponse.error || result.scrollResponse.message || 'scroll failed';
      showNavigationFeedback(navigablePath, line, { status: 'unknown_error', message: msg });
    } else {
      showNavigationFeedback(navigablePath, line, result);
    }
  }
}

// Helper function to navigate to a symbol
async function navigateToSymbol(symbolName, fileHint = null, { copyResponse = false } = {}) {
  debug(`Navigating to symbol: ${symbolName}${fileHint ? ` (hint: ${fileHint})` : ''}`);
  const result = await window.pty.navigateToSymbol(symbolName, fileHint);
  debug('Symbol result:', result);
  if (copyResponse) {
    const request = { type: 'symbol', name: symbolName };
    if (fileHint) request.fileHint = fileHint;
    const { scrollRequest, scrollResponse, ...response } = result;
    const text = JSON.stringify({ request, response, scrollRequest, scrollResponse }, null, 2);
    navigator.clipboard.writeText(text);
    showToast('Response copied to clipboard');
  } else {
    if (result.scrollResponse && (!result.scrollResponse.success || result.scrollResponse.status !== 'ok')) {
      const msg = result.scrollResponse.error || result.scrollResponse.message || 'scroll failed';
      showSymbolFeedback(symbolName, { status: 'unknown_error', message: msg });
    } else {
      showSymbolFeedback(symbolName, result);
    }
  }
}

// Show symbol navigation feedback
function showSymbolFeedback(symbolName, result) {
  const feedback = document.createElement('div');
  feedback.className = 'nav-feedback';

  let message;
  let bgColor;

  if (!result.status) {
    // TCP failure — no status field
    message = result.error || 'Symbol navigation failed';
    bgColor = '#f44747'; // red
  } else if (result.status === 'ok') {
    message = `Navigated to ${symbolName}`;
    bgColor = '#6a9955'; // green
  } else if (result.status === 'multiple') {
    return; // PyCharm shows picker dialog
  } else if (result.status === 'not_found') {
    message = `Not found: ${result.message || symbolName}`;
    bgColor = '#f44747'; // red
  } else {
    // error or unknown status
    message = result.message || 'Unknown error';
    bgColor = '#f44747'; // red
  }

  feedback.textContent = message;
  feedback.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: ${bgColor};
    color: ${bgColor === '#dcdcaa' ? '#1e1e1e' : 'white'};
    padding: 8px 16px;
    border-radius: 4px;
    font-family: sans-serif;
    font-size: 14px;
    z-index: 9999;
    animation: fadeOut 3s forwards;
  `;

  // Add fadeOut animation if not exists
  if (!document.getElementById('click-feedback-style')) {
    const style = document.createElement('style');
    style.id = 'click-feedback-style';
    style.textContent = `
      @keyframes fadeOut {
        0% { opacity: 1; }
        70% { opacity: 1; }
        100% { opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(feedback);
  setTimeout(() => feedback.remove(), 3000);
}

// Extract file context from a single line of text.
// Priority: diff headers > file:line patterns > bare file paths.
// Returns the file path string or null.
const _fcHeaderRegex = /(?:Update|Create)\(([^)]+)\)/;
const _fcPythonTB = /File "([^"]+)"/;
const _fcGithubLine = /([a-zA-Z0-9_./…-]+)#L\d+/;
const _fcParenLine = /([a-zA-Z0-9_./…-]+)\(\d+\)/;
const _fcFileLineCol = /([a-zA-Z0-9_./:…-]+):\d+:\d+/;
const _fcFileLine = /([a-zA-Z0-9_./:…-]+):\d+/;
const _fcBareToken = /[a-zA-Z0-9_./…-]+/g;
const _fcVersionLike = /^v?\d+\.\d+/;
const _fcTrailingLineRefBridge = /^\s*(?:,\s*~?\d+(?:\s*-\s*~?\d+)?)*\s*(?:in|of)\s+["'`]?$/i;
const _fcEditStats = /\s\+\d+(?:\s+-\d+)?(?:\s|[│┃|▎]|$)/;

function extractFileContextFromLine(text) {
  // 1. Diff headers
  let m = _fcHeaderRegex.exec(text);
  if (m) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized) return normalized;
  }

  // 2. File:line patterns (most specific first)
  m = _fcPythonTB.exec(text);
  if (m) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) return normalized;
  }

  m = _fcGithubLine.exec(text);
  if (m) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) return normalized;
  }

  m = _fcParenLine.exec(text);
  if (m) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) return normalized;
  }

  m = _fcFileLineCol.exec(text);
  if (m) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) return normalized;
  }

  m = _fcFileLine.exec(text);
  if (m) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) return normalized;
  }

  // 3. Bare file paths
  _fcBareToken.lastIndex = 0;
  while ((m = _fcBareToken.exec(text)) !== null) {
    const normalized = normalizeNavigablePath(m[0]);
    if (normalized && !_fcVersionLike.test(normalized) && isLikelyFilePath(normalized)) return normalized;
  }

  return null;
}

// Collect ALL file path candidates from a line with their text spans.
// Returns [{path, start, end}, ...] — used for position-aware resolution.
function extractAllFileContexts(text) {
  const results = [];
  const seenEnds = new Set();

  function add(path, start, end) {
    if (seenEnds.has(end)) return; // higher-priority pattern already claimed this position
    seenEnds.add(end);
    results.push({ path, start, end });
  }

  let m;

  // 1. Diff headers
  for (m of text.matchAll(/(?:Update|Create)\(([^)]+)\)/g)) {
    const start = m.index + m[0].indexOf(m[1]);
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized) add(normalized, start, start + m[1].length);
  }

  // 2. File:line patterns (most specific first)
  for (m of text.matchAll(/File "([^"]+)"/g)) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) {
      const start = m.index + m[0].indexOf(m[1]);
      add(normalized, start, start + m[1].length);
    }
  }

  for (m of text.matchAll(/([a-zA-Z0-9_./…-]+)#L\d+/g)) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) {
      const start = m.index + m[0].indexOf(m[1]);
      add(normalized, start, start + m[1].length);
    }
  }

  for (m of text.matchAll(/([a-zA-Z0-9_./…-]+)\(\d+\)/g)) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) {
      const start = m.index + m[0].indexOf(m[1]);
      add(normalized, start, start + m[1].length);
    }
  }

  for (m of text.matchAll(/([a-zA-Z0-9_./:…-]+):\d+:\d+/g)) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) {
      const start = m.index + m[0].indexOf(m[1]);
      add(normalized, start, start + m[1].length);
    }
  }

  for (m of text.matchAll(/([a-zA-Z0-9_./:…-]+):\d+/g)) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) {
      const start = m.index + m[0].indexOf(m[1]);
      add(normalized, start, start + m[1].length);
    }
  }

  // 3. Bare file paths
  for (m of text.matchAll(/(?:[.\/~…]|[a-zA-Z])[a-zA-Z0-9_.+~\/…-]*/g)) {
    const normalized = normalizeNavigablePath(m[0]);
    if (normalized && !_fcVersionLike.test(normalized) && isLikelyFilePath(normalized)) {
      add(normalized, m.index, m.index + m[0].length);
    }
  }

  return results;
}

function isExplicitDirectoryPath(path) {
  if (!path || !path.includes('/')) return false;
  if (!/^(?:\/|~\/|\.{1,2}\/)/.test(path)) return false;
  return !FILE_EXTENSIONS.test(path);
}

function joinDirectoryAndRelativePath(directory, relativePath) {
  if (!directory || !relativePath) return relativePath || directory;
  if (/^(?:\/|~\/|[a-zA-Z]:[\\/])/.test(relativePath)) return relativePath;
  return `${directory.replace(/[\\/]+$/, '')}/${relativePath.replace(/^[\\/]+/, '')}`;
}

function extractSplitEditDirectory(text) {
  const contexts = extractAllFileContexts(text);
  for (const ctx of contexts) {
    if (isExplicitDirectoryPath(ctx.path)) return ctx.path;
  }
  return null;
}

function extractSplitEditFile(text) {
  if (!_fcEditStats.test(text)) return null;
  const contexts = extractAllFileContexts(text);
  for (const ctx of contexts) {
    if (FILE_EXTENSIONS.test(ctx.path)) return ctx.path;
  }
  return null;
}

function findSplitEditFileContext(buffer, directoryRow) {
  const directoryLine = buffer.getLine(directoryRow);
  if (!directoryLine) return null;

  const directory = extractSplitEditDirectory(directoryLine.translateToString());
  if (!directory) return null;

  for (let r = directoryRow - 1; r >= Math.max(0, directoryRow - 3); r--) {
    const line = buffer.getLine(r);
    if (!line) continue;
    const filePath = extractSplitEditFile(line.translateToString());
    if (filePath) return joinDirectoryAndRelativePath(directory, filePath);
  }

  return null;
}

function findTrailingLineRefFileContext(bufferRow, charOffset) {
  if (charOffset == null) return null;
  const { text } = getRowText(bufferRow);
  if (!text) return null;

  const contexts = extractAllFileContexts(text);
  for (const ctx of contexts) {
    if (ctx.start < charOffset) continue;
    const bridge = text.substring(charOffset, ctx.start);
    if (_fcTrailingLineRefBridge.test(bridge)) return ctx.path;
  }

  return null;
}

function resolveLineRefFileContext(bufferRow, startOffset, endOffset) {
  return findTrailingLineRefFileContext(bufferRow, endOffset)
    || findFileContext(bufferRow, startOffset);
}

// Scan backward from bufferRow to find the nearest file context.
// When charOffset is provided, uses position-aware resolution on the current row.
function findFileContext(bufferRow, charOffset) {
  const buffer = terminal.buffer.active;
  for (let r = bufferRow; r >= Math.max(0, bufferRow - 200); r--) {
    const line = buffer.getLine(r);
    if (!line) continue;
    const text = line.translateToString();
    if (r === bufferRow && charOffset != null) {
      // Position-aware: pick rightmost file path candidate ending before click
      const contexts = extractAllFileContexts(text);
      let best = null;
      for (const ctx of contexts) {
        if (ctx.end <= charOffset && (best === null || ctx.end > best.end)) {
          best = ctx;
        }
      }
      if (best) return best.path;
    } else {
      const splitEditContext = findSplitEditFileContext(buffer, r);
      if (splitEditContext) return splitEditContext;

      const result = extractFileContextFromLine(text);
      if (result) return result;
    }
  }
  return null;
}

// For minus lines: scan forward to find next non-minus diff line
function findMinusTarget(bufferRow) {
  const buffer = terminal.buffer.active;
  for (let r = bufferRow + 1; r <= Math.min(buffer.length - 1, bufferRow + 100); r++) {
    const line = buffer.getLine(r);
    if (!line) continue;
    const text = line.translateToString();
    const parsed = parseDiffLineText(text);
    if (!parsed) continue;
    if (parsed.marker !== '-') {
      return { lineNum: parsed.lineNum, codeText: parsed.codeText };
    }
  }
  return null;
}

// Scan backward (bounded, within the enclosing box) for a Cursor diff header.
// Returns the file path, or null if this row isn't inside a recognizable diff box.
function findCursorDiffHeader(bufferRow) {
  const buffer = terminal.buffer.active;
  for (let r = bufferRow; r >= Math.max(0, bufferRow - 100); r--) {
    const line = buffer.getLine(r);
    if (!line) continue;
    const text = line.translateToString();
    const header = parseCursorDiffHeader(text);
    if (header) return header.path;
    // Stop once we leave the diff body: a non-gutter, non-blank line bounds the
    // scan to the current diff block.
    if (!getCursorDiffContentSpan(text) && text.trim() !== '') return null;
  }
  return null;
}

const LINE_REF_REGEX = /\b(?:[Ll]ines?\s+~?\d+(?:\s*-\s*~?\d+)?(?:,\s*~?\d+(?:\s*-\s*~?\d+)?)*|L~?\d+(?::\s*~?\d+|\s*-\s*~?\d+))/g;

function parseLineRefStartLine(text) {
  const m = /\b(?:[Ll]ines?\s+|L)~?(\d+)/.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

// Pattern definitions - easy to extend (add new patterns here)
// Patterns are checked in order; more specific patterns should come first
const patterns = [
  {
    name: 'diff_line',
    // Matches diff lines in Claude Code output:
    //   628 +        code...    (addition)
    //   628 -        code...    (deletion)
    //   625          code...    (context)
    //   628 -*prose...          (prose content flush against the marker, e.g. markdown)
    regex: /^(?:\s{2,}\d+(?:\s[+-]\s*|\s{2,})\S.*|\s*[│┃|]\s+.*)$/g,
    filter: (text, line, index) => index === 0 && parseDiffLineText(text) !== null,
    style: 'hover-only',
    trimToContent: true,
    expand(fullMatch, matchIndex) {
      const bordered = getBorderedContentSpan(fullMatch);
      if (!bordered || !parseDiffLineText(bordered.content, { allowInner: true })) return null;
      return [{
        text: bordered.content,
        start: matchIndex + bordered.start,
        end: matchIndex + bordered.end,
      }];
    },
    action: async (match, options) => {
      const parsed = parseDiffLineText(match.text, { allowInner: true });
      if (!parsed) return;
      const lineNum = parsed.lineNum;
      const marker = parsed.marker; // '+', '-', or undefined (context)
      const codeText = parsed.codeText;

      const filePath = findFileContext(match.bufferRow, match.start);
      if (!filePath) {
        showToast('Could not determine file path');
        return;
      }

      if (marker === '-') {
        const target = findMinusTarget(match.bufferRow);
        if (target) {
          // A deleted line resolves forward to the surviving line at the deletion
          // point; flag it 'anchor' so the viewer flashes it blue, matching how the
          // live change-diff marks a deletion.
          await navigateToFileLine(filePath, target.lineNum, null, { ...options, matchText: target.codeText, landingKind: 'anchor' });
        } else {
          showToast('Could not find target line for deleted code');
          return;
        }
      } else {
        // '+' → 'exact' (green, an addition); context line → 'neutral'.
        await navigateToFileLine(filePath, lineNum, null, { ...options, matchText: codeText, landingKind: marker === '+' ? 'exact' : 'neutral' });
      }
    },
  },
  {
    name: 'source_line',
    priority: 'low',
    // Matches source code lines — bordered or indented:
    //   │ def foo():                        │   (bordered)
    //   │     return bar                    │   (bordered, indented)
    //       def foo():                          (borderless, 4+ spaces)
    regex: /^(?:\s*[│┃|] | {4,}).+$/g,
    filter: (text, line, index) => {
      if (index !== 0) return false;
      return isLikelySourceLine(text);
    },
    style: 'hover-only',
    trimToContent: true,
    expand(fullMatch, matchIndex) {
      // Bordered: narrow to content between │ borders
      const bordered = /^\s*[│┃|] (.+?)(?:\s+[│┃|])?\s*$/.exec(fullMatch);
      if (bordered) {
        const innerStart = fullMatch.indexOf(bordered[1]);
        return [{
          text: bordered[1],
          start: matchIndex + innerStart,
          end: matchIndex + innerStart + bordered[1].length,
        }];
      }
      // Borderless: narrow to content after leading spaces
      const leadingSpaces = fullMatch.length - fullMatch.trimStart().length;
      const content = fullMatch.trimStart();
      return [{
        text: content,
        start: matchIndex + leadingSpaces,
        end: matchIndex + leadingSpaces + content.length,
      }];
    },
    action: async (match, options) => {
      const codeText = match.text.trim();

      const filePath = findFileContext(match.bufferRow, match.start);
      if (!filePath) {
        showToast('Could not determine file path');
        return;
      }

      await navigateToFileLine(filePath, null, null, { ...options, matchText: codeText });
    },
  },
  {
    name: 'diff_block',
    priority: 'low',
    // Prose/markdown diff lines in a bordered diff box that has no line-number gutter
    // (e.g. Cursor). source_line already handles code; this fills the prose gap. Only
    // decorated when a "<path> +N [-M]" header sits above it in the same box — that gate
    // lives in decorateLogicalRow (it needs the buffer), keeping this pattern text-only.
    regex: /^\s*[│┃|▎]\s?.+$/g,
    filter: (text) => parseCursorDiffBlockLine(text) !== null,
    style: 'hover-only',
    trimToContent: true,
    expand(fullMatch, matchIndex) {
      const parsed = parseCursorDiffBlockLine(fullMatch);
      if (!parsed) return null;
      return [{
        text: fullMatch.substring(parsed.contentStart, parsed.contentEnd),
        start: matchIndex + parsed.contentStart,
        end: matchIndex + parsed.contentEnd,
      }];
    },
    action: async (match, options) => {
      const filePath = findCursorDiffHeader(match.bufferRow);
      if (!filePath) {
        showToast('Could not determine file path');
        return;
      }
      await navigateToFileLine(filePath, null, null, { ...options, matchText: match.text.trim() });
    },
  },
  {
    name: 'line_ref',
    // Matches "Line 294", "line 310", "Lines 597-625" in prose
    // Also matches Claude read-range output like "L20:105"
    // Also matches continuation ranges: "line 1-10, 6-9" or "lines 1-10, 20-30, 40-50"
    // Resolves file path via backward scan at click time
    regex: LINE_REF_REGEX,
    style: 'hover-only',
    action: async (match, options) => {
      const lineNum = parseLineRefStartLine(match.text);
      if (lineNum == null) return;
      const filePath = resolveLineRefFileContext(match.bufferRow, match.start, match.end);
      if (!filePath) {
        showToast('Could not determine file path');
        return;
      }
      await navigateToFileLine(filePath, lineNum, null, options);
    },
    expand(fullMatch, matchIndex) {
      const prefixMatch = /^[Ll]ines?\s+/.exec(fullMatch);
      if (!prefixMatch) return null;

      // Extract all numeric ranges from the match
      const afterPrefix = fullMatch.substring(prefixMatch[0].length);
      const groups = afterPrefix.split(/,\s*/);

      if (groups.length <= 1) return null; // single range, use default behavior

      const subMatches = [];
      let searchFrom = prefixMatch[0].length;
      for (const group of groups) {
        const groupStart = fullMatch.indexOf(group, searchFrom);
        const lineNum = parseInt(group, 10);
        subMatches.push({
          text: group,
          start: matchIndex + groupStart,
          end: matchIndex + groupStart + group.length,
          action: async (_match, options) => {
            const filePath = resolveLineRefFileContext(_match.bufferRow, _match.start, _match.end);
            if (!filePath) {
              showToast('Could not determine file path');
              return;
            }
            await navigateToFileLine(filePath, lineNum, null, options);
          },
        });
        searchFrom = groupStart + group.length;
      }
      return subMatches;
    },
  },
  {
    name: 'url',
    regex: /(?:https?|file|review):\/\/[^\s<>"'`\x00-\x1f]+[^\s<>"'`\x00-\x1f.,;:!?\)\]}>]/g,
    action: async (match, options = {}) => {
      const mod = options.modifiers || {};
      // Any modifier (Ctrl/Cmd/Alt) → system browser. Plain click → embedded
      // viewer band. copyResponse covers the Ctrl+Alt debug chord.
      const external = !!(options.copyResponse || mod.ctrlKey || mod.metaKey || mod.altKey);
      openUrlFromTerminal(match.text, 'visible-url', external);
    },
  },
  {
    name: 'wsl_unc_path',
    // WSL files in Windows UNC form: \\wsl.localhost\<distro>\... (or legacy
    // \\wsl$\...). The POSIX patterns below tokenize on backslashes and would
    // only catch the trailing filename, so claim the whole span here and
    // dispatch in POSIX form. Component class excludes Windows-invalid name
    // chars — a UNC path can't contain them, and they'd swallow trailing prose.
    regex: /\\\\wsl(?:\.localhost|\$)\\[^\\\s<>:"|?*]+(?:\\[^\\\s<>:"|?*]+)+/gi,
    action: async (match, options) => {
      const normalized = normalizeNavigablePath(match.text);
      if (!normalized) return;
      const posix = wslUncToPosix(normalized);
      if (RESOURCE_EXTENSIONS.test(posix)) {
        const mod = (options && options.modifiers) || {};
        if (isViewableImagePath(posix) && !imageWantsOsHandoff(mod)) {
          if (await openImageInViewer(posix)) return;
        }
        const result = await openResourceChoosing(posix, { forceChoose: !!mod.altKey });
        if (result && !result.success && !result.dismissed) {
          showToast(result.error || 'Could not open file');
        }
        return;
      }
      await navigateToFileLine(posix, null, null, options);
    },
  },
  {
    name: 'resource_file',
    // Matches file paths ending with resource extensions (images, docs, media, archives, data)
    regex: /(?:[.\/~…]|[a-zA-Z])[a-zA-Z0-9_.+~\/…-]*\.(?:png|jpe?g|gif|svg|ico|webp|bmp|tiff?|pdf|docx?|xlsx?|pptx?|rtf|epub|mp[34]|wav|avi|mov|mkv|flac|ogg|webm|zip|tgz|gz|bz2|xz|rar|7z|zst|csv|tsv|parquet|avro)\b/gi,
    action: async (match, options = {}) => {
      const mod = options.modifiers || {};
      // An image renders in the band; a modifier means the OS instead, and alt
      // still raises the chooser first.
      if (isViewableImagePath(match.text) && !imageWantsOsHandoff(mod)) {
        if (await openImageInViewer(match.text)) return;
      }
      const result = await openResourceChoosing(match.text, { forceChoose: !!mod.altKey });
      if (result && !result.success && !result.dismissed) {
        showToast(result.error || 'Could not open file');
      }
    },
  },
  {
    name: 'plain_file',
    // Least-specific file matcher. Explicit file+line/matchText navigation should win.
    regex: /(?:[a-zA-Z]:)?(?:[.\/~…]|[a-zA-Z])[a-zA-Z0-9_.+~\/…-]*/g,
    filter: (text, line, index) => {
      const normalized = normalizeNavigablePath(text);
      const rest = line.substring(index + text.length);
      return normalized != null
        && isLikelyFilePath(normalized)
        && !RESOURCE_EXTENSIONS.test(normalized)
        && !hasLeadingLineRefContext(line, index)
        && !/^\(\d/.test(rest);
    },
    action: async (match, options) => {
      await navigateToFileLine(match.text, null, null, options);
    },
  },
  {
    name: 'qualified_symbol',
    priority: 'low',
    // Matches dot-separated identifiers with 2+ segments:
    // - ClassName.method, ClassName.data_member
    // - module.ClassName.method
    // - package.module.ClassName.attr
    // API resolves from rightmost segment leftward
    regex: /\b[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+\b/g,
    // Exclude matches that look like filenames (end with any file extension)
    filter: (text) => !FILE_EXTENSIONS.test(text),
    action: async (match, options) => {
      const fileHint = findFileContext(match.bufferRow, match.start);
      await navigateToSymbol(match.text, fileHint, options);
    },
  },
  {
    name: 'underscore_symbol',
    priority: 'low',
    // Matches identifiers with underscore: _private, my_var, __dunder__
    // Two patterns: _followed_by_stuff OR stuff_with_underscore
    regex: /\b_[a-zA-Z0-9_]+\b|\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]*\b/g,
    // Reject if this identifier is the stem of a filename (e.g., a_b_c in "a_b_c.py")
    // or a directory component in a file path (e.g., b_b in "a/b_b/c_c/d")
    filter: (matched, line, index) => {
      const rest = line.substring(index + matched.length);
      const extMatch = rest.match(/^(\.[a-zA-Z0-9]+)/);
      if (extMatch && FILE_EXTENSIONS.test(matched + extMatch[1])) return false;
      if (isLikelyPathNotSymbol(line, index, matched.length)) return false;
      return true;
    },
    action: async (match, options) => {
      const fileHint = findFileContext(match.bufferRow, match.start);
      await navigateToSymbol(match.text, fileHint, options);
    },
  },
  {
    name: 'camel_pascal_symbol',
    priority: 'low',
    // camelCase: lowercase start + uppercase transition (myVar, getUserName)
    // PascalCase: uppercase start + lower→upper transition (MyClass, HttpResponse)
    regex: /\b(?:[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[A-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g,
    filter: (matched, line, index) => {
      // Reject very short matches (e.g., "aB") — too noisy
      if (matched.length < 4) return false;
      // Reject if followed by a file extension (e.g., MyClass.js)
      const rest = line.substring(index + matched.length);
      const extMatch = rest.match(/^(\.[a-zA-Z0-9]+)/);
      if (extMatch && FILE_EXTENSIONS.test(matched + extMatch[1])) return false;
      if (isLikelyPathNotSymbol(line, index, matched.length)) return false;
      return true;
    },
    action: async (match, options) => {
      const fileHint = findFileContext(match.bufferRow, match.start);
      await navigateToSymbol(match.text, fileHint, options);
    },
  },

  // -------------------------------------------------------------------------
  // File:Line patterns - ordered from most specific to least specific
  // -------------------------------------------------------------------------

  {
    // Python traceback: File "path/to/file.py", line 42
    name: 'python_traceback',
    regex: /File "([^"]+)", line (\d+)/g,
    action: async (match, options) => {
      const parsed = /File "([^"]+)", line (\d+)/.exec(match.text);
      if (parsed) {
        await navigateToFileLine(parsed[1], parseInt(parsed[2], 10), null, options);
      }
    },
  },
  {
    // GitHub-style line reference: file.js#L42 or file.js#L42-L50
    name: 'github_line',
    regex: /[a-zA-Z0-9_.\/…-]+\.[a-zA-Z]+#L(\d+)(?:-L\d+)?/g,
    action: async (match, options) => {
      const hashIndex = match.text.indexOf('#L');
      const filePath = match.text.substring(0, hashIndex);
      const lineMatch = /#L(\d+)/.exec(match.text);
      if (lineMatch) {
        await navigateToFileLine(filePath, parseInt(lineMatch[1], 10), null, options);
      }
    },
  },
  {
    // File with line and column: file.js:42:15 (TypeScript, ESLint, etc.)
    // Must come before file_line to match the more specific pattern first
    name: 'file_line_col',
    regex: /[a-zA-Z0-9_.\/…-]+\.[a-zA-Z0-9]+:\d+:\d+/g,
    action: async (match, options) => {
      // Split from the end: file:line:col
      const parts = match.text.split(':');
      const col = parseInt(parts.pop(), 10);
      const line = parseInt(parts.pop(), 10);
      const filePath = parts.join(':'); // rejoin in case path had colons
      await navigateToFileLine(filePath, line, col, options);
    },
  },
  {
    // Parentheses style: file.js(42), file.js(42,15), or file.py(100-200, 300-400)
    name: 'paren_line',
    regex: /[a-zA-Z0-9_.\/…-]+\.[a-zA-Z0-9]+\(\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*\)/g,
    action: async (match, options) => {
      const parenIndex = match.text.indexOf('(');
      const filePath = match.text.substring(0, parenIndex);
      const innerMatch = /\((\d+)(?:,\s*(\d+))?\)/.exec(match.text);
      if (innerMatch) {
        const col = innerMatch[2] ? parseInt(innerMatch[2], 10) : null;
        await navigateToFileLine(filePath, parseInt(innerMatch[1], 10), col, options);
      }
    },
    expand(fullMatch, matchIndex) {
      const parenIndex = fullMatch.indexOf('(');
      const filePath = fullMatch.substring(0, parenIndex);
      const inner = fullMatch.substring(parenIndex + 1, fullMatch.length - 1);

      // If no hyphen present, use single-match behavior (preserves line,col)
      if (!inner.includes('-')) {
        return [{
          text: fullMatch,
          start: matchIndex,
          end: matchIndex + fullMatch.length,
          action: async (match, options) => {
            const m = /\((\d+)(?:,\s*(\d+))?\)/.exec(match.text);
            if (m) {
              const col = m[2] ? parseInt(m[2], 10) : null;
              await navigateToFileLine(filePath, parseInt(m[1], 10), col, options);
            }
          },
        }];
      }

      // Multi-reference mode: split by ", " and create one sub-match per group
      const groups = inner.split(/,\s*/);
      const subMatches = [];
      let searchFrom = parenIndex + 1; // position within fullMatch after '('
      for (const group of groups) {
        const groupStart = fullMatch.indexOf(group, searchFrom);
        const line = parseInt(group, 10); // first number in e.g. "100-200"
        subMatches.push({
          text: group,
          start: matchIndex + groupStart,
          end: matchIndex + groupStart + group.length,
          action: async (_match, options) => {
            await navigateToFileLine(filePath, line, null, options);
          },
        });
        searchFrom = groupStart + group.length;
      }
      return subMatches;
    },
  },
  {
    // Comment-prefixed bare line reference: # :344, # :190
    // Common in call trees / documentation where filename is on a prior line
    // Resolves file via backward scan (findFileContext)
    name: 'comment_line_ref',
    regex: /#\s*:~?\d+(?:-~?\d+)?/g,
    filter: (text, line, index) => {
      // Require # preceded by whitespace or start-of-line (avoid URL fragments like foo#:123)
      if (index > 0 && !/\s/.test(line[index - 1])) return false;
      return true;
    },
    action: async (match, options) => {
      const m = /:~?(\d+)/.exec(match.text);
      if (!m) return;
      const lineNum = parseInt(m[1], 10);
      const filePath = findFileContext(match.bufferRow, match.start);
      if (!filePath) {
        showToast('Could not determine file path');
        return;
      }
      await navigateToFileLine(filePath, lineNum, null, options);
    },
  },
  {
    // Basic file:line - most common format
    // Matches: src/main.js:42, ./file.py:10, /absolute/path.rs:100
    // Also handles extensionless files: Makefile:10, Dockerfile:5
    // Requires path to start with letter, dot, or slash (not just digits)
    // Uses negative lookahead (?!:\d) to avoid matching file:line:col (handled above)
    name: 'file_line',
    regex: /(?:[.\/…]|[a-zA-Z])[a-zA-Z0-9_.\/…-]*(?:\.[a-zA-Z0-9]+)?:~?\d+(?:-~?\d+)?(?!:\d)/g,
    action: async (match, options) => {
      const lastColonIndex = match.text.lastIndexOf(':');
      const filePath = match.text.substring(0, lastColonIndex);
      const line = parseInt(match.text.substring(lastColonIndex + 1).replace(/~/g, ''), 10);

      // Skip if filePath looks invalid (e.g., just numbers or too short)
      if (filePath.length < 2 || /^\d+$/.test(filePath)) {
        return;
      }

      await navigateToFileLine(filePath, line, null, options);
    },
  },
];

// Track processed rows - stores text at processing time for content-drift detection
const processedRows = new Map();  // bufferLineIndex -> text at processing time

// Store decorations by starting row (for cleanup on resize)
const decorations = new Map(); // bufferLineIndex -> { marker, decoration, matchKey }[]
const decorationElements = new Map(); // matchKey -> Set<HTMLElement>
const decorationStyles = new Map(); // matchKey -> { fgColor, isHoverOnly }
let altBufferDirty = false;
let decorationProcessScheduled = false;
let hoveredMatchKey = null;

function getMatchKey(match) {
  return `${match.bufferRow}:${match.start}:${match.end}:${match.patternName}:${match.text}`;
}

function applyDecorationElementStyle(element, { fgColor, isHoverOnly }, isHovered) {
  if (!element) return;
  element.style.borderBottom = isHovered
    ? `1px solid ${fgColor}, 0.7)`
    : (isHoverOnly ? 'none' : `1px dotted ${fgColor}, 0.3)`);
  element.style.backgroundColor = isHovered ? `${fgColor}, 0.08)` : 'transparent';
  element.style.pointerEvents = 'none';
  element.style.boxSizing = 'border-box';
}

function rememberDecorationElement(matchKey, element) {
  const previousKey = element._matchKey;
  if (previousKey && previousKey !== matchKey) {
    const previousElements = decorationElements.get(previousKey);
    if (previousElements) {
      previousElements.delete(element);
      if (previousElements.size === 0) decorationElements.delete(previousKey);
    }
  }

  let elements = decorationElements.get(matchKey);
  if (!elements) {
    elements = new Set();
    decorationElements.set(matchKey, elements);
  }
  elements.add(element);
  element._matchKey = matchKey;
}

function releaseDecorationElements(matchKey) {
  const elements = decorationElements.get(matchKey);
  if (elements) {
    for (const element of elements) {
      if (element && element._matchKey === matchKey) {
        delete element._matchKey;
      }
    }
  }
  decorationElements.delete(matchKey);
  decorationStyles.delete(matchKey);
}

function updateRenderedMatchStyle(matchKey) {
  if (!matchKey) return;
  const style = decorationStyles.get(matchKey);
  const elements = decorationElements.get(matchKey);
  if (!style || !elements) return;
  for (const element of elements) {
    applyDecorationElementStyle(element, style, hoveredMatchKey === matchKey);
  }
}

let hoveredMatchCursor = '';

function setHoveredMatch(match, event) {
  // The cursor answers "does clicking here do something", so it tracks the
  // modifier as well as the match: an IDE-bound match reads as plain text until
  // ctrl/cmd is held, and lights up the moment it is. Same reasoning as the md
  // viewer's I-beam over link text — a pointer that promises a jump the bare
  // click no longer makes is a lie. Kept above the same-match early return so
  // holding the modifier updates it without moving to another match.
  const nextCursor = (match && (!navigationNeedsModifier(match) || hasNavigationModifier(event)))
    ? 'pointer'
    : '';
  if (screenElement && nextCursor !== hoveredMatchCursor) {
    hoveredMatchCursor = nextCursor;
    screenElement.style.cursor = nextCursor;
  }

  const nextKey = match ? getMatchKey(match) : null;
  if (nextKey === hoveredMatchKey) return;

  const previousKey = hoveredMatchKey;
  hoveredMatchKey = nextKey;

  if (previousKey) updateRenderedMatchStyle(previousKey);
  if (nextKey) updateRenderedMatchStyle(nextKey);
}

// Parse a row for all pattern matches
function parseRow(text) {
  const matches = [];

  for (const pattern of patterns) {
    // Reset regex lastIndex for fresh matching
    pattern.regex.lastIndex = 0;

    for (const match of text.matchAll(pattern.regex)) {
      // Skip if pattern has a filter that rejects this match
      if (pattern.filter && !pattern.filter(match[0], text, match.index)) {
        continue;
      }
      const matchBase = {
        patternName: pattern.name,
        action: pattern.action,
        style: pattern.style,
        trimToContent: pattern.trimToContent,
        priority: pattern.priority || 'high',
      };
      if (pattern.expand) {
        const subMatches = pattern.expand(match[0], match.index);
        if (subMatches) {
          for (const sub of subMatches) {
            matches.push({
              text: sub.text,
              start: sub.start,
              end: sub.end,
              ...matchBase,
              action: sub.action || pattern.action,
            });
          }
          continue;
        }
      }
      {
        matches.push({
          text: match[0],
          start: match.index,
          end: match.index + match[0].length,
          ...matchBase,
        });
      }
    }
  }

  // Resolve overlapping matches with priority awareness:
  // High-priority matches (file:line, URLs, etc.) are placed first,
  // then low-priority matches (source_line, symbols) fill remaining gaps.
  const high = matches.filter(m => m.priority !== 'low');
  const low = matches.filter(m => m.priority === 'low');

  // Sort each group by start position, then by length descending
  const byPos = (a, b) => a.start - b.start || b.end - a.end;
  high.sort(byPos);
  low.sort(byPos);

  // Greedy non-overlapping selection for high-priority matches
  const placed = [];
  for (const match of high) {
    if (placed.length === 0 || match.start >= placed[placed.length - 1].end) {
      placed.push(match);
    }
  }

  // Fit low-priority matches into gaps not claimed by high-priority
  for (const match of low) {
    // Binary-style check: does this match overlap any placed match?
    const overlaps = placed.some(p =>
      match.start < p.end && match.end > p.start
    );
    if (!overlaps) {
      placed.push(match);
    }
  }

  // Re-sort by position for consistent output
  placed.sort(byPos);

  return placed;
}

// Get text content from a buffer row, joining wrapped lines
function getRowText(bufferLineIndex) {
  const buffer = terminal.buffer.active;
  let text = '';
  let currentIndex = bufferLineIndex;

  // Get first line
  const firstLine = buffer.getLine(currentIndex);
  if (!firstLine) return { text: '', endIndex: bufferLineIndex };

  text = firstLine.translateToString();
  currentIndex++;

  // Join wrapped continuations
  const parts = [text];
  while (currentIndex < buffer.length) {
    const line = buffer.getLine(currentIndex);
    if (!line || !line.isWrapped) break;
    parts.push(line.translateToString());
    currentIndex++;
  }

  return { text: parts.length === 1 ? parts[0] : parts.join(''), endIndex: currentIndex - 1 };
}

function getLogicalLineStart(buffer, bufferLineIndex) {
  let currentIndex = Math.max(0, bufferLineIndex);
  while (currentIndex > 0) {
    const line = buffer.getLine(currentIndex);
    if (!line || !line.isWrapped) break;
    currentIndex--;
  }
  return currentIndex;
}

function getMouseBufferPosition(event) {
  const coords = terminal?._core?._mouseService?.getCoords?.(
    event,
    screenElement,
    terminal.cols,
    terminal.rows,
  );
  if (!coords) return null;

  const [col, row] = coords;
  return {
    buffer: terminal.buffer.active,
    bufferRow: terminal.buffer.active.viewportY + row - 1,
    col: col - 1,
  };
}

function getLogicalLineOffset(buffer, logicalStart, bufferRow, col) {
  let offset = 0;
  for (let row = logicalStart; row < bufferRow; row++) {
    const line = buffer.getLine(row);
    if (!line) break;
    offset += line.translateToString().length;
  }
  return offset + Math.max(0, col);
}

// Prose punctuation hugging a token isn't part of it: "path/to/file.js," should
// paste as the path, "word" without its quotes. Trailing sentence punctuation
// always goes; brackets/quotes only when their partner isn't inside the token,
// so "func()" and "[tag]" stay whole. Leading dots are kept (./scripts, .env).
const TOKEN_CLOSERS = { ')': '(', ']': '[', '}': '{', '>': '<' };
const TOKEN_OPENERS = { '(': ')', '[': ']', '{': '}', '<': '>' };
function trimTokenEdges(token) {
  let w = String(token || '');
  for (;;) {
    const last = w[w.length - 1];
    if (!last) break;
    if ('.,;:!?\'"`'.includes(last)) { w = w.slice(0, -1); continue; }
    if (TOKEN_CLOSERS[last] && !w.includes(TOKEN_CLOSERS[last])) { w = w.slice(0, -1); continue; }
    break;
  }
  for (;;) {
    const first = w[0];
    if (!first) break;
    if ('\'"`'.includes(first)) { w = w.slice(1); continue; }
    if (TOKEN_OPENERS[first] && !w.includes(TOKEN_OPENERS[first])) { w = w.slice(1); continue; }
    break;
  }
  return w;
}

// The "long" word under the mouse: the whitespace-delimited token on the
// logical (unwrapped) line, edge punctuation trimmed. '' when the mouse is on
// whitespace or off the text.
function getWordAtMouseEvent(event) {
  const position = getMouseBufferPosition(event);
  if (!position) return '';
  const { buffer, bufferRow, col } = position;
  const logicalStart = getLogicalLineStart(buffer, bufferRow);
  const { text } = getRowText(logicalStart);
  if (!text) return '';
  const offset = getLogicalLineOffset(buffer, logicalStart, bufferRow, col);
  if (offset >= text.length || /\s/.test(text[offset])) return '';
  let start = offset;
  let end = offset;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  return trimTokenEdges(text.slice(start, end));
}

// A word pasted mid-prompt needs a separator: when the character just left of
// the cursor is non-space (a half-typed argument), prepend a space. A fresh
// prompt ends in space ("$ ", "> "), so nothing is added there.
function pastedWordNeedsLeadingSpace() {
  const buffer = terminal.buffer.active;
  if (buffer.cursorX <= 0) return false;
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  if (!line) return false;
  return /\S$/.test(line.translateToString(false, 0, buffer.cursorX));
}

function getClickableMatchAtMouseEvent(event) {
  const position = getMouseBufferPosition(event);
  if (!position) return null;

  const { buffer, bufferRow, col } = position;

  // Stitched image-attachment paths span rows and are invisible to parseRow;
  // resolve them first so a click anywhere on the path opens the whole file.
  const imageMatch = imageAttachmentMatchAt(buffer, bufferRow, col);
  if (imageMatch) return imageMatch;

  const logicalStart = getLogicalLineStart(buffer, bufferRow);
  const { text } = getRowText(logicalStart);
  if (!text) return null;

  const charOffset = getLogicalLineOffset(buffer, logicalStart, bufferRow, col);
  const matches = parseRow(text);
  for (const match of matches) {
    match.bufferRow = logicalStart;
    // The hit region is the marked span, so what is underlined is what responds.
    // On README.md:42 that is README.md; the :42 is ordinary text you can select.
    if (charOffset >= match.start && charOffset < match.start + markedLength(match)) {
      return match;
    }
  }

  return null;
}

// Create decoration for a match
function createDecoration(bufferLineIndex, match) {
  const buffer = terminal.buffer.active;

  // Calculate which screen row and column the match starts at
  let remainingOffset = match.start;
  let currentRow = bufferLineIndex;
  let col = 0;

  while (remainingOffset > 0) {
    const line = buffer.getLine(currentRow);
    if (!line) break;

    const lineLength = line.translateToString().length;
    if (remainingOffset < lineLength) {
      col = remainingOffset;
      break;
    }
    remainingOffset -= lineLength;
    currentRow++;
  }

  let adjustedCol = col;
  // The mark stops at the path; a trailing :42 is an argument to the jump, not
  // part of the name. Hit testing is unaffected, so the qualifier still clicks.
  let adjustedWidth = Math.min(markedLength(match), terminal.cols - col);

  if (match.trimToContent) {
    const trimLine = buffer.getLine(currentRow);
    if (trimLine) {
      const matchEnd = col + adjustedWidth;

      // Helper: is this cell meaningful (non-blank or colored)?
      const isMeaningful = (cell) => {
        if (!cell) return false;
        if (cell.getChars().trim() !== '') return true;
        if (!cell.isFgDefault() || !cell.isBgDefault()) return true;
        return false;
      };

      // Scan left→right for first meaningful cell
      let firstContent = matchEnd;
      for (let c = col; c < matchEnd; c++) {
        if (isMeaningful(trimLine.getCell(c))) { firstContent = c; break; }
      }

      // Scan right→left for last meaningful cell
      let lastContent = firstContent;
      for (let c = matchEnd - 1; c >= firstContent; c--) {
        if (isMeaningful(trimLine.getCell(c))) { lastContent = c; break; }
      }

      if (firstContent < matchEnd) {
        adjustedCol = firstContent;
        adjustedWidth = lastContent - firstContent + 1;
      }
    }
  }

  // Create marker at the row
  const marker = terminal.registerMarker(currentRow - buffer.baseY - buffer.cursorY);

  if (!marker) {
    console.warn('Failed to create marker at row', currentRow);
    return null;
  }

  const decoration = terminal.registerDecoration({
    marker,
    x: adjustedCol,
    width: adjustedWidth,
    layer: 'top',
  });

  if (!decoration) {
    console.warn('Failed to create decoration');
    marker.dispose();
    return null;
  }

  const matchKey = getMatchKey(match);

  // Read the visual text color from the terminal buffer cell
  const line = buffer.getLine(currentRow);
  let fgColor = 'rgba(212, 212, 212';  // fallback to theme foreground #d4d4d4
  // ANSI-16 palette matching the theme (lines 10-31)
  const ansi16 = [
    '30, 30, 30',     '244, 71, 71',    '106, 153, 85',   '220, 220, 170',
    '86, 156, 214',   '197, 134, 192',  '78, 201, 176',    '212, 212, 212',
    '128, 128, 128',  '244, 71, 71',    '106, 153, 85',    '220, 220, 170',
    '86, 156, 214',   '197, 134, 192',  '78, 201, 176',    '255, 255, 255',
  ];
  if (line) {
    const cell = line.getCell(adjustedCol);
    if (cell) {
      // When inverse (SGR 7) is active, the renderer swaps fg/bg visually.
      // So the visual text color comes from the logical bg, not fg.
      const inverse = cell.isInverse();
      const colorVal = inverse ? cell.getBgColor() : cell.getFgColor();
      const isRGB    = inverse ? cell.isBgRGB()    : cell.isFgRGB();
      const isPal    = inverse ? cell.isBgPalette() : cell.isFgPalette();
      const isDef    = inverse ? cell.isBgDefault() : cell.isFgDefault();

      if (isRGB) {
        const r = (colorVal >> 16) & 0xFF;
        const g = (colorVal >> 8) & 0xFF;
        const b = colorVal & 0xFF;
        fgColor = `rgba(${r}, ${g}, ${b}`;
      } else if (isPal) {
        let idx = colorVal;
        // Bold text with palette 0-7 is rendered as bright 8-15
        if (cell.isBold() && idx < 8) {
          idx += 8;
        }
        if (idx < 16) {
          fgColor = `rgba(${ansi16[idx]}`;
        }
      } else if (isDef) {
        // Default color: inverse swaps, so default-bg → theme bg as text color
        fgColor = inverse ? 'rgba(30, 30, 30' : 'rgba(212, 212, 212';
      }
    }
  }

  // Handle rendering and click
  // Note: Decoration elements are overlays, they don't contain the text.
  // We use border-bottom for underline effect, matching the text's foreground color.
  decoration.onRender((element) => {
    // xterm hides all decorations in the alternate buffer, so restore visibility
    // only for rows that are actually visible there. In the normal buffer we must
    // preserve xterm's own off-screen hiding behavior to avoid ghost underlines.
    const viewportLine = marker.line - terminal.buffer.active.viewportY;
    if (isAlternateBufferActive() && viewportLine >= 0 && viewportLine < terminal.rows) {
      element.style.display = 'block';
    }
    // The resting underline means one thing: a plain click acts here. A match
    // that waits for ctrl/cmd shows nothing until hovered, so README.md:42 (md
    // viewer) and src/renderer.js:88 (IDE) stop being two identical-looking
    // spans with different rules. Derived from the same predicate as the press,
    // so the mark and the gesture cannot drift apart. It also takes the dotted
    // underline off ordinary prose, where the bare-identifier symbol patterns
    // were claiming most technical words.
    const isHoverOnly = match.style === 'hover-only' || navigationNeedsModifier(match);
    decorationStyles.set(matchKey, { fgColor, isHoverOnly });
    rememberDecorationElement(matchKey, element);
    applyDecorationElementStyle(element, { fgColor, isHoverOnly }, hoveredMatchKey === matchKey);

    debug('Decoration rendered:', match.text, 'at col', adjustedCol, 'width', adjustedWidth);
  });

  debug('Created decoration for:', match.text, 'at row', currentRow, 'col', adjustedCol, 'width', adjustedWidth);
  return { marker, decoration, matchKey };
}

function disposeDecorationsForRow(row) {
  const rowDecorations = decorations.get(row);
  if (!rowDecorations) return;
  for (const entry of rowDecorations) {
    entry.decoration.dispose();
    entry.marker.dispose();
    releaseDecorationElements(entry.matchKey);
  }
  decorations.delete(row);
}

function clearStoredRow(row, buffer = terminal.buffer.active) {
  disposeDecorationsForRow(row);
  processedRows.delete(row);

  let nextRow = row + 1;
  while (processedRows.has(nextRow)) {
    const nextLine = buffer.getLine(nextRow);
    if (!nextLine || !nextLine.isWrapped) break;
    disposeDecorationsForRow(nextRow);
    processedRows.delete(nextRow);
    nextRow++;
  }
}

// Draw the underline over each on-screen segment of a stitched image attachment
// beginning at `row`. Returns the last row of the span, or -1 when `row` is not
// an attachment head. Idempotent: an unchanged, already-decorated span is left
// as-is. Clicks are resolved independently by imageAttachmentMatchAt, so these
// decorations are purely the visual affordance.
function decorateImageAttachmentRow(buffer, row) {
  const analysis = analyzeImageAttachment(buffer, row);
  if (!analysis) return -1;

  const headLine = buffer.getLine(row);
  const headRaw = headLine ? headLine.translateToString() : '';
  if (processedRows.get(row) === headRaw && decorations.has(row)) {
    return analysis.endRow; // already decorated and unchanged
  }

  clearStoredRow(row, buffer);
  const rowDecorations = [];
  for (const seg of analysis.segments) {
    try {
      const entry = createDecoration(seg.row, imageAttachmentSegmentMatch(analysis, seg));
      if (entry) rowDecorations.push(entry);
    } catch (e) {
      console.error('[decor] Failed image attachment decoration:', e.message);
    }
  }
  if (rowDecorations.length > 0) decorations.set(row, rowDecorations);
  for (let i = row; i <= analysis.endRow; i++) {
    const line = buffer.getLine(i);
    processedRows.set(i, line ? line.translateToString() : '');
  }
  return analysis.endRow;
}

function decorateLogicalRow(row, text, endIndex) {
  debug(`Row ${row}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

  const matches = parseRow(text);
  for (const match of matches) {
    match.bufferRow = row;
  }

  if (matches.length > 0) {
    debug(`  Found ${matches.length} matches:`, matches.map((m) => m.text));
  }

  const rowDecorations = [];
  for (const match of matches) {
    // diff_block lines are only real when a diff header sits above them in the same
    // box; gate here (needs the buffer) so non-diff "│ - bullet" boxes aren't decorated.
    if (match.patternName === 'diff_block' && !findCursorDiffHeader(match.bufferRow)) continue;
    try {
      const decorationEntry = createDecoration(row, match);
      if (decorationEntry) {
        rowDecorations.push(decorationEntry);
      }
    } catch (e) {
      console.error('[decor] Failed to create decoration:', e.message);
    }
  }

  if (rowDecorations.length > 0) {
    decorations.set(row, rowDecorations);
  }

  for (let i = row; i <= endIndex; i++) {
    processedRows.set(i, text);
  }
}

function rebuildAlternateViewportDecorations(buffer, viewportStart, viewportEnd) {
  let row = getLogicalLineStart(buffer, viewportStart);
  let processedCount = 0;

  while (row < viewportEnd) {
    const line = buffer.getLine(row);
    if (!line) {
      row++;
      continue;
    }
    if (line.isWrapped) {
      processedRows.set(row, '');
      row++;
      continue;
    }

    const imageEnd = decorateImageAttachmentRow(buffer, row);
    if (imageEnd >= 0) {
      processedCount++;
      row = imageEnd + 1;
      continue;
    }

    const { text, endIndex } = getRowText(row);
    const storedText = processedRows.get(row);
    if (storedText !== text) {
      clearStoredRow(row, buffer);
      decorateLogicalRow(row, text, endIndex);
      processedCount++;
    }
    row = endIndex + 1;
  }

  altBufferDirty = false;
  if (processedCount > 0) {
    debug(`Processed ${processedCount} alternate-buffer rows`);
  }
}

// Main decoration loop - runs every 500ms
// Only processes rows that are:
//   - In the visible viewport
//   - Above the cursor (rows at/below cursor may still be receiving input)
//   - Not already processed (append-only strategy)
function processVisibleRows() {
  const buffer = terminal.buffer.active;
  const viewportStart = buffer.viewportY;
  const viewportEnd = Math.min(buffer.length, viewportStart + terminal.rows);

  if (buffer.type === 'alternate') {
    if (!altBufferDirty) return;
    debug(`Processing alternate buffer: viewport=${viewportStart}-${viewportEnd}`);
    rebuildAlternateViewportDecorations(buffer, viewportStart, viewportEnd);
    return;
  }

  // Cursor position in absolute buffer coordinates
  // Rows at or below this are potentially still being written to
  const cursorRow = buffer.baseY + buffer.cursorY;

  debug(`Processing: viewport=${viewportStart}-${viewportEnd}, cursorRow=${cursorRow}, baseY=${buffer.baseY}, cursorY=${buffer.cursorY}`);

  let row = getLogicalLineStart(buffer, viewportStart);
  let processedCount = 0;

  while (row < viewportEnd && row < cursorRow) {
    // Skip if already processed — but check for content drift
    if (processedRows.has(row)) {
      const { text: currentText } = getRowText(row);
      if (currentText === processedRows.get(row)) {
        row++;
        continue;  // Same content, skip
      }
      // Content changed — dispose old decorations and re-process
      debug(`Row ${row} content changed, re-processing`);
      clearStoredRow(row, buffer);
      // Fall through to normal processing below
    }

    // Skip wrapped lines (they're processed with their parent)
    const line = buffer.getLine(row);
    if (!line) {
      row++;
      continue;
    }
    if (line.isWrapped) {
      processedRows.set(row, '');  // wrapped rows: sentinel value
      row++;
      continue;
    }

    // Claude Code image attachments span rows by hanging indent, not xterm wrap;
    // stitch and decorate them as one span before the generic per-row matchers.
    const imageEnd = decorateImageAttachmentRow(buffer, row);
    if (imageEnd >= 0) {
      processedCount++;
      row = imageEnd + 1;
      continue;
    }

    // Get full text (including wrapped continuations)
    const { text, endIndex } = getRowText(row);
    decorateLogicalRow(row, text, endIndex);
    processedCount++;
    row = endIndex + 1;
  }

  // Sweep: dispose stale decorations on in-viewport rows at/below cursor
  // (the range the main loop skips). Dispose-only — no new decorations.
  for (let sRow = Math.max(viewportStart, cursorRow); sRow < viewportEnd; sRow++) {
    if (!decorations.has(sRow)) continue;

    const { text: currentText } = getRowText(sRow);
    const storedText = processedRows.get(sRow);
    if (currentText === storedText) continue;

    debug(`Stale sweep: row ${sRow} content changed, disposing`);
    clearStoredRow(sRow, buffer);
  }

  if (processedCount > 0) {
    debug(`Processed ${processedCount} new rows`);
  }
}

// Clear all decorations (used on resize)
function clearAllDecorations() {
  for (const [, entries] of decorations) {
    for (const entry of entries) {
      entry.decoration.dispose();
      entry.marker.dispose();
      releaseDecorationElements(entry.matchKey);
    }
  }
  decorations.clear();
  processedRows.clear();
}

function scheduleDecorationProcessing() {
  if (decorationProcessScheduled) return;
  decorationProcessScheduled = true;
  requestAnimationFrame(() => {
    decorationProcessScheduled = false;
    processVisibleRows();
  });
}

terminal.buffer.onBufferChange((buffer) => {
  clearAllDecorations();
  altBufferDirty = buffer.type === 'alternate';

  if (searchState.isOpen && searchState.scope === 'terminal') {
    if (searchState.query) {
      void runSearch(searchState.query);
    } else {
      clearSearchDecorations();
      updateSearchCount();
    }
  }

  scheduleDecorationProcessing();
});

terminal.onWriteParsed(() => {
  if (!isAlternateBufferActive()) return;
  altBufferDirty = true;
  scheduleDecorationProcessing();
  scheduleAltScreenSearchRefresh();
});

terminal.onScroll(() => {
  updateQueuedTerminalCommentCards();
  scheduleTerminalSelectionCommentHint();
  if (!isAlternateBufferActive()) return;
  altBufferDirty = true;
  scheduleDecorationProcessing();
  scheduleAltScreenSearchRefresh();
});

// Handle resize: clear and reprocess
let searchResizeTimer = null;
window.addEventListener('resize', () => {
  updateQueuedTerminalCommentCards();
  scheduleTerminalSelectionCommentHint();
  clearAllDecorations();
  altBufferDirty = isAlternateBufferActive();
  scheduleDecorationProcessing();
  // Re-run search after resize settles (decorations shift with new column layout)
  if (searchState.isOpen && searchState.scope === 'terminal' && searchState.query) {
    clearSearchDecorations();
    clearTimeout(searchResizeTimer);
    searchResizeTimer = setTimeout(() => {
      void runSearch(searchState.query);
    }, 200);
  }
});

// Start decoration loop
const DECORATION_INTERVAL = 500; // ms
setInterval(processVisibleRows, DECORATION_INTERVAL);

// Run once immediately after a short delay (let terminal initialize)
setTimeout(processVisibleRows, 100);

// Agent-working signal: an open viewer band covers the live terminal tail, so a
// streaming reply is otherwise invisible. Mark body.agent-working while output is
// live (the AI CLI's own spinner keeps PTY output flowing through thinking, so
// this spans the whole turn and quiets at the prompt) AND a viewer is on-screen.
// The md viewer keys its low-profile "being worked on" pulse on the open comments
// awaiting a reply off this class, so it shows only when work is actually happening.
const AGENT_WORKING_WINDOW_MS = 2000;
setInterval(() => {
  const viewerOnScreen = !!document.querySelector('.vb-shell.open');
  const outputLive = Date.now() - lastTerminalOutputAt <= AGENT_WORKING_WINDOW_MS;
  document.body.classList.toggle('agent-working', viewerOnScreen && outputLive);
}, 300);
