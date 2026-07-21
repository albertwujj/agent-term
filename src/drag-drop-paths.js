function getTransferTypes(dataTransfer) {
  if (!dataTransfer || !dataTransfer.types) return [];
  const { types } = dataTransfer;
  if (Array.isArray(types)) return types;
  if (typeof types[Symbol.iterator] === 'function') return Array.from(types);
  if (typeof types.contains === 'function') {
    return ['Files', 'text/uri-list', 'text/plain']
      .filter((type) => types.contains(type));
  }
  return [];
}

function hasSupportedPathDropType(dataTransfer) {
  const types = getTransferTypes(dataTransfer);
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain');
}

function decodeFileUriToPath(uri, platform) {
  if (typeof uri !== 'string' || !uri.trim()) return null;

  let url;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }

  if (url.protocol !== 'file:') return null;

  const hostname = url.hostname.toLowerCase();
  const pathname = decodeURIComponent(url.pathname || '');

  if (platform === 'win32') {
    const windowsPath = pathname.replace(/\//g, '\\');
    if (hostname && hostname !== 'localhost') {
      return `\\\\${url.hostname}${windowsPath}`;
    }
    return windowsPath.replace(/^\\([A-Za-z]:)/, '$1');
  }

  if (hostname && hostname !== 'localhost') {
    return `//${url.hostname}${pathname}`;
  }
  return pathname;
}

function extractPathsFromUriList(text, platform) {
  if (typeof text !== 'string' || !text.trim()) return [];

  const paths = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const path = decodeFileUriToPath(line, platform);
    if (!path) return [];
    paths.push(path);
  }

  return paths;
}

function isLikelyAbsolutePath(text, platform) {
  if (typeof text !== 'string' || !text) return false;

  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\\/]+[\\/][^\\\/]+/.test(text);
  }

  return text.startsWith('/');
}

function extractPathsFromPlainText(text, platform) {
  if (typeof text !== 'string' || !text.trim()) return [];

  const uriPaths = extractPathsFromUriList(text, platform);
  if (uriPaths.length) return uriPaths;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];
  if (!lines.every((line) => isLikelyAbsolutePath(line, platform))) return [];
  return lines;
}

function dedupePaths(paths) {
  return [...new Set(paths.filter((path) => typeof path === 'string' && path))];
}

function extractDroppedPaths({ dataTransfer, getPathForFile, platform }) {
  if (!dataTransfer) return [];

  const filePaths = [];
  const files = dataTransfer.files || [];
  for (const file of files) {
    const path = getPathForFile(file);
    if (typeof path === 'string' && path) {
      filePaths.push(path);
    }
  }
  if (filePaths.length) return dedupePaths(filePaths);

  const uriListPaths = extractPathsFromUriList(dataTransfer.getData('text/uri-list'), platform);
  if (uriListPaths.length) return dedupePaths(uriListPaths);

  const plainTextPaths = extractPathsFromPlainText(dataTransfer.getData('text/plain'), platform);
  if (plainTextPaths.length) return dedupePaths(plainTextPaths);

  return [];
}

module.exports = {
  extractDroppedPaths,
  hasSupportedPathDropType,
};
