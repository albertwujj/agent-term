// Windows can fall back to the executable's icon after a suspend/session
// transition even though BrowserWindow.setIcon succeeded earlier. Keep the
// latest icon we applied and reassert it after Electron reports that the
// machine or user session has returned. This module is Electron-free so the
// debounce and failure behaviour can be covered by the unit suite.

const RESTORE_DELAY_MS = 250;

function createTaskbarIconRestorer({
  platform = process.platform,
  getWindow,
  log = () => {},
  delayMs = RESTORE_DELAY_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let currentIcon = null;
  let restoreTimer = null;
  const restoreSources = new Set();

  function setOnWindow(icon, source) {
    if (platform !== 'win32' || !icon || typeof getWindow !== 'function') return false;
    try {
      const win = getWindow();
      if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
      win.setIcon(icon);
      return true;
    } catch (err) {
      log('[taskbar-icon] apply failed source=' + source + ': ' + (err && err.message));
      return false;
    }
  }

  function apply(icon) {
    if (!setOnWindow(icon, 'state-change')) return false;
    currentIcon = icon;
    return true;
  }

  function scheduleRestore(source = 'system') {
    if (platform !== 'win32' || !currentIcon) return false;
    restoreSources.add(source);
    if (restoreTimer) return true;
    restoreTimer = setTimeoutFn(() => {
      restoreTimer = null;
      const sources = [...restoreSources].join('+');
      restoreSources.clear();
      if (setOnWindow(currentIcon, sources)) {
        log('[taskbar-icon] reapplied source=' + sources);
      }
    }, delayMs);
    if (restoreTimer && typeof restoreTimer.unref === 'function') restoreTimer.unref();
    return true;
  }

  function dispose() {
    if (restoreTimer) clearTimeoutFn(restoreTimer);
    restoreTimer = null;
    restoreSources.clear();
    currentIcon = null;
  }

  return { apply, scheduleRestore, dispose };
}

module.exports = { RESTORE_DELAY_MS, createTaskbarIconRestorer };
