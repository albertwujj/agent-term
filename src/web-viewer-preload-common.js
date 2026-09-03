// Small preload surface shared by ordinary remote pages and AgentTerm review
// pages. Keep this module free of review/comment code: every generic webview
// evaluates it inside the guest renderer, including untrusted remote sites.

const { getViewerShortcutAction } = require('./viewer-shortcut');

function installWebViewerPreloadCommon({ ipcRenderer, platform }) {
  if (window.__atWebViewerCommonInit) return;
  window.__atWebViewerCommonInit = true;

  // A guest page has its own renderer process. Only an actual 500ms+ task
  // produces IPC or disk traffic; there is no polling heartbeat.
  try {
    const longTaskObserver = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (entry.duration < 500) return;
        try {
          ipcRenderer.sendToHost('viewer-diagnostic',
            'long-task duration=' + Math.round(entry.duration) + 'ms');
        } catch {}
      });
    });
    longTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch {}

  // A guest WebContents owns its focused keystrokes, so forward only the few
  // host-level viewer shortcuts. Ordinary typing remains entirely in the page.
  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey &&
        (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      try { ipcRenderer.sendToHost('rv-find'); } catch {}
      return;
    }
    const action = getViewerShortcutAction(event, platform);
    if (!action) return;
    event.preventDefault();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    try { ipcRenderer.sendToHost('viewer-shortcut', action); } catch {}
  }, true);
}

module.exports = { installWebViewerPreloadCommon };
