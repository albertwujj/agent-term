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
function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function resolveImageSrc(src, { rootUrl, docDir, version, versionByPath }) {
  const raw = String(src || '').trim();
  if (!raw || hasUrlScheme(raw)) return null;
  const absolute = raw.startsWith('/') ? raw : `${docDir}/${raw}`;
  const segments = normalizePosixPath(absolute).split('/').map(decodePathSegment);
  const path = segments.join('/');
  // The query is ignored when Chromium resolves the file, but it keys the
  // image cache — so a bumped version refetches an image the agent regenerated.
  // The image file's own mtime (versionByPath, fed by the viewer's image poll)
  // wins; the doc's mtime covers images that have not been statted yet.
  const own = versionByPath ? versionByPath.get(path) : undefined;
  const v = Number.isFinite(own) ? own : version;
  const query = Number.isFinite(v) ? `?v=${v}` : '';
  return { url: `${rootUrl}${segments.map(encodeURIComponent).join('/')}${query}`, path };
}

// Raw HTML is never parsed (html: false above): parsing it would hand an
// agent-written document control of the app's DOM, and the anchor, comment and
// diff machinery works over markdown structure. Instead a small fixed set of
// tags, the ones GitHub-authored docs use for sized images and their captions,
// is recognized after the parse and mapped onto real markdown-it tokens. No
// attribute crosses over except the four an image needs, and the text around
// them stays ordinary inline text: anchorable, selectable, editable, diffed.
//   <img src …>    an image token; src, alt, width and height carry over, so
//                  src rewriting and image anchoring treat it like any
//                  authored image. A src-less tag stays literal text.
//   <br>           a hard break.
//   <sub>…</sub>   the sub/sup tokens, when the pair is balanced within the
//   <sup>…</sup>   run; a stray open or close stays literal text.
//   <p …>…</p>     a wrapper around the whole run is dropped, and its
//                  align="center" becomes the md-center class on the paragraph
//                  (the GitHub idiom for a centered image with a caption). A
//                  <p> anywhere else in a run stays literal text.
// Every other tag renders as the literal text the author typed.
const HTML_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)(\s[^<>]*)?\/?>/g;

function parseTagAttrs(tag) {
  const attrs = {};
  const attrPattern = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g;
  let match;
  while ((match = attrPattern.exec(tag))) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

// A recognized tag as an item, or null for one that stays literal text.
function classifyTag(match) {
  const [raw, slash, rawName, rawAttrs] = match;
  const name = rawName.toLowerCase();
  const close = slash === '/';
  if (close && rawAttrs && rawAttrs.trim()) return null;
  switch (name) {
    case 'img': {
      if (close) return null;
      const attrs = parseTagAttrs(raw);
      return attrs.src ? { tag: 'img', attrs, raw } : null;
    }
    case 'br':
      return close ? null : { tag: 'br', raw };
    case 'sub':
    case 'sup':
      return { tag: name, close, raw };
    case 'p':
      return { tag: 'p', close, attrs: close ? {} : parseTagAttrs(raw), raw };
    default:
      return null;
  }
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

function buildTextToken(TokenCtor, content, level) {
  const token = new TokenCtor('text', '', 0);
  token.level = level;
  token.content = content;
  return token;
}

function buildTagToken(TokenCtor, type, tag, nesting, level) {
  const token = new TokenCtor(type, tag, nesting);
  token.level = level;
  return token;
}

// Split an inline run's text children around the recognized tags. Items are
// { child } for a token kept as is, { text } for a text slice, or a classified
// tag; each carries the level of the child it came from.
function splitRunAroundTags(children) {
  const items = [];
  let anyTag = false;
  for (const child of children) {
    if (child.type !== 'text' || !child.content.includes('<')) {
      items.push({ child });
      continue;
    }
    let last = 0;
    let match;
    HTML_TAG.lastIndex = 0;
    while ((match = HTML_TAG.exec(child.content))) {
      const tag = classifyTag(match);
      if (!tag) continue;
      if (match.index > last) items.push({ text: child.content.slice(last, match.index), level: child.level });
      items.push({ ...tag, level: child.level });
      anyTag = true;
      last = match.index + match[0].length;
    }
    if (last === 0) {
      items.push({ child });
    } else if (last < child.content.length) {
      items.push({ text: child.content.slice(last), level: child.level });
    }
  }
  return anyTag ? items : null;
}

function isSoftbreakItem(item) {
  return !!(item.child && item.child.type === 'softbreak');
}

function isBlankItem(item) {
  return isSoftbreakItem(item) || (item.text !== undefined && !item.text.trim());
}

// Drop a <p …>…</p> wrapping the whole run, with the line breaks that set it
// off from its content. Returns the open tag's attrs, or null without one.
function unwrapParagraphTags(items) {
  let first = 0;
  while (first < items.length && isBlankItem(items[first])) first++;
  let last = items.length - 1;
  while (last > first && isBlankItem(items[last])) last--;
  const open = items[first];
  const close = items[last];
  if (!open || !close || last <= first) return null;
  if (open.tag !== 'p' || open.close || close.tag !== 'p' || !close.close) return null;
  items.splice(last, 1);
  items.splice(first, 1);
  while (items.length && isSoftbreakItem(items[0])) items.shift();
  while (items.length && isSoftbreakItem(items[items.length - 1])) items.pop();
  return open.attrs;
}

// Mark the sub/sup opens and closes that pair up in order; the rest stay text.
function pairSubSup(items) {
  const stack = [];
  for (const item of items) {
    if (item.tag !== 'sub' && item.tag !== 'sup') continue;
    if (!item.close) {
      stack.push(item);
      continue;
    }
    const top = stack[stack.length - 1];
    if (top && top.tag === item.tag) {
      stack.pop();
      top.paired = true;
      item.paired = true;
    }
  }
}

function recognizeHtmlTags(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'inline' || !Array.isArray(token.children)) continue;
    const items = splitRunAroundTags(token.children);
    if (!items) continue;
    const TokenCtor = token.constructor;
    const wrapper = unwrapParagraphTags(items);
    if (wrapper && String(wrapper.align || '').toLowerCase() === 'center') {
      const open = tokens[i - 1];
      if (open && open.type === 'paragraph_open') open.attrJoin('class', 'md-center');
    }
    pairSubSup(items);
    token.children = items.map((item) => {
      if (item.child) return item.child;
      if (item.tag === 'img') return buildImageToken(TokenCtor, item.attrs, item.level);
      if (item.tag === 'br') return buildTagToken(TokenCtor, 'hardbreak', 'br', 0, item.level);
      if ((item.tag === 'sub' || item.tag === 'sup') && item.paired) {
        return item.close
          ? buildTagToken(TokenCtor, `${item.tag}_close`, item.tag, -1, item.level)
          : buildTagToken(TokenCtor, `${item.tag}_open`, item.tag, 1, item.level);
      }
      return buildTextToken(TokenCtor, item.text !== undefined ? item.text : item.raw, item.level);
    });
  }
}

function rewriteImageSources(tokens, imageOptions) {
  const canResolve = !!(imageOptions && imageOptions.rootUrl && imageOptions.docDir);
  const imagePaths = new Set();
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
        if (resolved) {
          child.attrSet('src', resolved.url);
          imagePaths.add(resolved.path);
        }
      }
    }
  }
  return [...imagePaths];
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
  recognizeHtmlTags(tokens);
  // Local image files the doc embeds, as absolute decoded POSIX paths — the
  // viewer's image poll stats these to catch regenerated images.
  const imagePaths = rewriteImageSources(tokens, imageOptions);
  const headings = collectHeadings(tokens);
  const anchors = assignAnchors(tokens);
  const html = markdown.renderer.render(tokens, markdown.options, env);
  return { html, anchors, headings, imagePaths };
}

module.exports = {
  findAnchorForLine,
  getSectionHierarchyForLine,
  renderMarkdownDocument,
};
