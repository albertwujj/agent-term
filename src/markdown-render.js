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

// Raw HTML is never parsed (html: false above), so a document's tags render as
// the literal text the author typed. The one exception is <img>: markdown image
// syntax has no size control, so sized images are authored as HTML tags across
// the ecosystem (GitHub READMEs being the canonical case). A text token
// containing one is split around a real image token, which the src rewriting
// and anchor machinery then treat like any authored image. Only src, alt,
// width and height cross over; every other attribute is dropped. A <p> wrapper
// line would be left rendering as stray text once its images become images, so
// it is removed only from an inline run where the split produced one.
const HTML_IMG_TAG = /<img\s[^<>]*>/gi;
const HTML_P_WRAPPER = /^<\/?p(?:\s[^<>]*)?>$/i;

function parseImgTagAttrs(tag) {
  const attrs = {};
  const attrPattern = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g;
  let match;
  while ((match = attrPattern.exec(tag))) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function buildImageToken(TokenCtor, attrs, level) {
  const token = new TokenCtor('image', 'img', 0);
  token.level = level;
  token.content = attrs.alt || '';
  token.attrs = [['src', attrs.src], ['alt', '']];
  if (/^\d+%?$/.test(attrs.width || '')) token.attrPush(['width', attrs.width]);
  if (/^\d+%?$/.test(attrs.height || '')) token.attrPush(['height', attrs.height]);
  if (token.content) {
    const alt = new TokenCtor('text', '', 0);
    alt.level = level + 1;
    alt.content = token.content;
    token.children = [alt];
  } else {
    token.children = [];
  }
  return token;
}

function recognizeHtmlImages(tokens) {
  for (const token of tokens) {
    if (token.type !== 'inline' || !Array.isArray(token.children)) continue;
    const TokenCtor = token.constructor;
    let produced = false;
    const rebuilt = [];
    for (const child of token.children) {
      if (child.type !== 'text' || !/<img\s/i.test(child.content)) {
        rebuilt.push(child);
        continue;
      }
      const pieces = [];
      let last = 0;
      let match;
      HTML_IMG_TAG.lastIndex = 0;
      while ((match = HTML_IMG_TAG.exec(child.content))) {
        const attrs = parseImgTagAttrs(match[0]);
        if (!attrs.src) continue; // a src-less tag stays literal text
        pieces.push({ text: child.content.slice(last, match.index) });
        pieces.push({ image: attrs });
        last = match.index + match[0].length;
      }
      if (pieces.length === 0) {
        rebuilt.push(child);
        continue;
      }
      pieces.push({ text: child.content.slice(last) });
      for (const piece of pieces) {
        if (piece.image) {
          rebuilt.push(buildImageToken(TokenCtor, piece.image, child.level));
          produced = true;
        } else if (piece.text) {
          const text = new TokenCtor('text', '', 0);
          text.level = child.level;
          text.content = piece.text;
          rebuilt.push(text);
        }
      }
    }
    if (!produced) continue;
    token.children = rebuilt.filter((child) => !(
      child.type === 'text' && HTML_P_WRAPPER.test(child.content.trim())
    ));
  }
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

// A hidden token renders nothing (markdown-it hides the paragraph inside a
// tight list item, leaving the <li> to carry the text), so an anchor on it
// would name an element that never exists: a line jump into a tight list
// would resolve to that paragraph, find no element, and report the line as
// not found. The list item is the block for those lines.
function isAnchorableToken(token) {
  return token
    && !token.hidden
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
  recognizeHtmlImages(tokens);
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
