// An email address in terminal output. The bounds keep it off the other shapes
// that carry an @: a package spec (@scope/pkg, pkg@1.2.3) has no letters-only
// top-level domain, a git remote (git@host:org/repo) runs on past the host, and
// the user part of a URL (ssh://git@host/repo) sits after a slash.
const EMAIL_SOURCE = String.raw`(?<![\w.%+\/-])[\w%+-][\w.%+-]*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?![\w-]|[:\/]\S)`;

// What the main process passes to the OS handler: a web page, a local page, and
// mailto:, which only opens a draft, so a printed address can't send anything.
function opensExternally(rawUrl) {
  return /^(?:(?:https?|file):\/\/|mailto:)/i.test(String(rawUrl || ''));
}

// What the window says while the OS brings another app forward for a URL or a
// local path. Which app opens a file is the OS's choice, so a file is named
// rather than its app.
function handoffLabel(target) {
  const text = String(target || '');
  if (/^mailto:/i.test(text)) return 'Opening in mail app…';
  if (/^https?:/i.test(text)) return 'Opening in browser…';
  let pathText = text;
  if (/^file:/i.test(text)) {
    try { pathText = decodeURIComponent(new URL(text).pathname); } catch {}
  }
  const name = pathText.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return name ? `Opening ${name}…` : 'Opening…';
}

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
  EMAIL_SOURCE,
  opensExternally,
  handoffLabel,
  normalizeHttpUrl,
  createHttpUrlOpener,
  urlClickWantsExternal,
};
