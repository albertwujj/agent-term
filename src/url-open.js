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

module.exports = {
  normalizeHttpUrl,
  createHttpUrlOpener,
};
