function normalizeHttpUrl(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function createHttpUrlOpener({ openURL, log = () => {} } = {}) {
  if (typeof openURL !== 'function') {
    throw new TypeError('createHttpUrlOpener requires openURL');
  }

  return async function openHttpUrl(rawUrl, source = 'unknown') {
    const url = normalizeHttpUrl(rawUrl);
    if (!url) return false;

    try {
      await openURL(url);
      return true;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      log(`[links] failed ${source}: ${url}: ${message}`);
      return false;
    }
  };
}

// Where a clicked terminal URL goes. A web page opens in the system browser on a
// plain click: logins, SSO cookies and device auth live there, and the embedded
// band keeps running into them. Ctrl/Cmd/Alt pulls the page into the band
// instead. A local file:// page is the reverse — the band renders it on a plain
// click and a modifier hands it to the OS — and review:// always renders in-app.
function urlClickWantsExternal(rawUrl, modifiers) {
  const modified = !!(modifiers && (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey));
  const web = /^\s*https?:\/\//i.test(String(rawUrl || ''));
  return web ? !modified : modified;
}

module.exports = {
  normalizeHttpUrl,
  createHttpUrlOpener,
  urlClickWantsExternal,
};
