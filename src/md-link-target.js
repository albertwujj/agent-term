// Where a link in a rendered markdown doc points.
//
// An authored destination is one of three things: a web URL, an in-doc fragment,
// or another file named relative to the doc you're reading. The viewer needs the
// third resolved to an absolute path before it can open it, and that resolution
// is the doc's own directory — a link is written from where the doc sits.
//
// Paths are POSIX: everything downstream (readMarkdownFile, openResource, the
// terminal's own path clicks) speaks WSL POSIX on Windows too.

// Two-plus letters, so a Windows drive prefix (C:\docs) stays a path.
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

function decodePart(part) {
  // markdown-it percent-encodes link destinations (a space becomes %20). A
  // malformed escape keeps the raw text — better a miss than a throw.
  try { return decodeURIComponent(part); } catch { return part; }
}

// Collapse . and .. segments. Leading .. on a relative path is kept (there is no
// root to climb past); an absolute path stops at /.
function normalizeSegments(pathText) {
  const absolute = pathText.startsWith('/');
  const out = [];
  for (const segment of pathText.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..' && out.length && out[out.length - 1] !== '..') { out.pop(); continue; }
    if (segment === '..' && absolute) continue;
    out.push(segment);
  }
  return (absolute ? '/' : '') + out.join('/');
}

function classifyMarkdownLink(href, docPath) {
  const raw = typeof href === 'string' ? href.trim() : '';
  if (!raw) return { kind: 'none' };
  if (/^https?:\/\//i.test(raw)) return { kind: 'external', url: raw };
  if (raw.startsWith('#')) return { kind: 'fragment', fragment: raw.slice(1) };
  // mailto:, file:, data: and friends: named, but not ours to open.
  if (SCHEME.test(raw)) return { kind: 'unsupported', href: raw };

  // A path. Its own #fragment / ?query belong to the destination doc, not to the
  // file name, so they come off before resolving.
  const bare = decodePart(raw.split('#')[0].split('?')[0]);
  if (!bare) return { kind: 'none' };
  if (bare.startsWith('/')) return { kind: 'path', path: normalizeSegments(bare) };

  const doc = typeof docPath === 'string' ? docPath : '';
  const slash = doc.lastIndexOf('/');
  if (slash < 0) return { kind: 'none' }; // no directory to resolve against
  return { kind: 'path', path: normalizeSegments(doc.slice(0, slash + 1) + bare) };
}

module.exports = { classifyMarkdownLink };
