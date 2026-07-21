const MarkdownIt = require('markdown-it');

const ANCHORABLE_BLOCK_TYPES = new Set([
  'heading_open',
  'paragraph_open',
  'list_item_open',
  'blockquote_open',
  'table_open',
  'hr',
  'fence',
  'code_block',
]);

const ANCHOR_TYPE_WEIGHT = {
  paragraph_open: 0,
  heading_open: 1,
  fence: 1,
  code_block: 1,
  list_item_open: 2,
  blockquote_open: 3,
  table_open: 3,
  hr: 4,
};

function createMarkdownIt() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
  });

  md.renderer.rules.fence = renderFence;
  md.renderer.rules.code_block = renderCodeBlock;
  return md;
}

const markdown = createMarkdownIt();

function renderFence(tokens, idx, options, env, slf) {
  const token = tokens[idx];
  const info = token.info ? markdown.utils.unescapeAll(token.info).trim() : '';
  const langName = info ? info.split(/\s+/g)[0] : '';
  const langClass = langName
    ? ` class="${options.langPrefix}${markdown.utils.escapeHtml(langName)}"`
    : '';
  return `<pre${slf.renderAttrs(token)}><code${langClass}>${markdown.utils.escapeHtml(token.content)}</code></pre>\n`;
}

function renderCodeBlock(tokens, idx, options, env, slf) {
  const token = tokens[idx];
  return `<pre${slf.renderAttrs(token)}><code>${markdown.utils.escapeHtml(token.content)}</code></pre>\n`;
}

// Image srcs are authored as paths relative to the markdown file (or absolute
// POSIX paths), but the article lives in a window whose base URL is the app's
// own index.html — so every local src must be rewritten to an explicit file://
// URL. rootUrl is the platform prefix for absolute POSIX paths (plain file://
// on macOS, file://wsl.localhost/<distro> on Windows, where the docs live
// inside WSL). URLs that already carry a scheme (https, data, ...) pass
// through untouched.
function hasUrlScheme(src) {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//');
}

function normalizePosixPath(path) {
  const out = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join('/')}`;
}

// markdown-it pre-encodes link destinations (space -> %20), so decode each
// segment before re-encoding to avoid double-encoding.
function encodePathSegment(segment) {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {}
  return encodeURIComponent(decoded);
}

function resolveImageSrc(src, { rootUrl, docDir, version }) {
  const raw = String(src || '').trim();
  if (!raw || hasUrlScheme(raw)) return null;
  const absolute = raw.startsWith('/') ? raw : `${docDir}/${raw}`;
  const encoded = normalizePosixPath(absolute).split('/').map(encodePathSegment).join('/');
  // The query is ignored when Chromium resolves the file, but it keys the
  // image cache — so a refreshed doc refetches images the agent regenerated.
  const query = Number.isFinite(version) ? `?v=${version}` : '';
  return `${rootUrl}${encoded}${query}`;
}

function rewriteImageSources(tokens, imageOptions) {
  const canResolve = !!(imageOptions && imageOptions.rootUrl && imageOptions.docDir);
  for (const token of tokens) {
    if (token.type !== 'inline' || !Array.isArray(token.children)) continue;
    for (const child of token.children) {
      if (child.type !== 'image') continue;
      const original = child.attrGet('src');
      // Keep the authored src on the element: an image carries no anchorable
      // text, so a comment on it anchors by this path instead. Authored (not the
      // resolved absolute URL + cache-buster) so it stays stable across renders
      // and travels with the doc.
      if (original) child.attrSet('data-md-src', original);
      if (canResolve) {
        const resolved = resolveImageSrc(original, imageOptions);
        if (resolved) child.attrSet('src', resolved);
      }
    }
  }
}

function isAnchorableToken(token) {
  return token
    && ANCHORABLE_BLOCK_TYPES.has(token.type)
    && Array.isArray(token.map)
    && Number.isFinite(token.map[0])
    && Number.isFinite(token.map[1])
    && token.map[1] >= token.map[0];
}

function assignAnchors(tokens) {
  const anchors = [];
  let nextId = 1;

  for (const token of tokens) {
    if (!isAnchorableToken(token)) continue;

    const id = `md-a-${nextId++}`;
    const startLine = token.map[0] + 1;
    const endLine = Math.max(startLine, token.map[1]);

    token.attrSet('data-md-anchor-id', id);
    token.attrSet('data-source-start-line', String(startLine));
    token.attrSet('data-source-end-line', String(endLine));
    token.attrJoin('class', 'md-anchor');

    anchors.push({
      id,
      type: token.type,
      startLine,
      endLine,
    });
  }

  return anchors;
}

function collectHeadings(tokens) {
  const headings = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.type !== 'heading_open' || !Array.isArray(token.map)) continue;
    const levelMatch = /^h([1-6])$/.exec(token.tag || '');
    if (!levelMatch) continue;
    const inline = tokens[i + 1];
    const title = inline && inline.type === 'inline'
      ? String(inline.content || '').trim()
      : '';
    if (!title) continue;
    const startLine = token.map[0] + 1;
    headings.push({
      level: Number(levelMatch[1]),
      title,
      startLine,
      endLine: Math.max(startLine, token.map[1]),
    });
  }
  return headings;
}

function getSectionHierarchyForLine(headings, line) {
  if (!Array.isArray(headings) || !Number.isFinite(line)) return [];
  const stack = [];
  for (const heading of headings) {
    if (!heading || heading.startLine > line) break;
    const level = Math.max(1, Math.min(6, heading.level || 1));
    stack[level - 1] = heading;
    stack.length = level;
  }
  return stack.filter(Boolean).map((heading) => heading.title);
}

function anchorSortKey(anchor) {
  const range = Math.max(0, anchor.endLine - anchor.startLine);
  const weight = Object.prototype.hasOwnProperty.call(ANCHOR_TYPE_WEIGHT, anchor.type)
    ? ANCHOR_TYPE_WEIGHT[anchor.type]
    : 9;
  return [range, weight, anchor.startLine];
}

function compareAnchor(a, b) {
  const ak = anchorSortKey(a);
  const bk = anchorSortKey(b);
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return ak[i] - bk[i];
  }
  return 0;
}

function findAnchorForLine(anchors, line) {
  if (!Array.isArray(anchors) || anchors.length === 0 || !Number.isFinite(line)) return null;

  const containing = anchors
    .filter((anchor) => anchor.startLine <= line && anchor.endLine >= line)
    .sort(compareAnchor);
  if (containing.length > 0) return containing[0];

  const after = anchors
    .filter((anchor) => anchor.startLine > line)
    .sort((a, b) => a.startLine - b.startLine || compareAnchor(a, b));
  if (after.length > 0) return after[0];

  const before = anchors
    .filter((anchor) => anchor.endLine < line)
    .sort((a, b) => b.endLine - a.endLine || compareAnchor(a, b));
  return before[0] || null;
}

function renderMarkdownDocument(source, imageOptions) {
  const text = String(source == null ? '' : source);
  const env = {};
  const tokens = markdown.parse(text, env);
  rewriteImageSources(tokens, imageOptions);
  const headings = collectHeadings(tokens);
  const anchors = assignAnchors(tokens);
  const html = markdown.renderer.render(tokens, markdown.options, env);
  return { html, anchors, headings };
}

module.exports = {
  findAnchorForLine,
  getSectionHierarchyForLine,
  renderMarkdownDocument,
};
