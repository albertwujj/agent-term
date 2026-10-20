// Symbol scan on a review page: right-click a symbol and every occurrence of it
// in the review lights up, so you can scroll and read how it is used. Reading
// each use in its surroundings is the point, so the scan holds no focus and no
// input: the page stays scrollable, selectable and commentable underneath, and
// the highlights stand until Esc or a right-click off any word.
//
// What is searched: the word under the pointer (letters, digits, `_`), whole
// words only and case-sensitive, so `id` never lands inside `width`. A
// right-click inside a selection searches exactly the selection instead, for
// `foo.bar` or part of a name.
//
// Where they are: a rail along the right edge marks each occurrence at its
// place in the page, and a click on a mark scrolls there. A pill names the
// symbol and its count. The symbol outlives the agent's re-render (a full
// reload of the page) through sessionStorage; the matches are found again in
// the new text.
//
// Electron-free: the host supplies the page's seams; esbuild bundles this into
// the review preload.

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch) {
  return !!ch && WORD_CHAR.test(ch);
}

// The run of word characters `offset` sits in, or ends at (a caret just past
// the last letter); null off a word.
function wordAround(text, offset) {
  let at = offset;
  if (!isWordChar(text[at])) {
    if (!isWordChar(text[at - 1])) return null;
    at -= 1;
  }
  let start = at;
  let end = at + 1;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  return { start, end };
}

// Start offsets of every occurrence of `query` in `text`; with `word`, only
// those with no word character on either side.
function findOccurrences(text, query, { word }) {
  const starts = [];
  if (!query) return starts;
  let from = 0;
  for (;;) {
    const at = text.indexOf(query, from);
    if (at === -1) break;
    if (!word || (!isWordChar(text[at - 1]) && !isWordChar(text[at + query.length]))) {
      starts.push(at);
      from = at + query.length;
    } else {
      from = at + 1;
    }
  }
  return starts;
}

// The block a text node belongs to: a code cell, a paragraph, a heading. A
// word or a match never runs from one block into the next.
const BLOCK = 'td, th, li, p, pre, h1, h2, h3, h4, h5, h6, blockquote, dt, dd, summary, div, section';

// The searchable text under `root` as one string, with a newline between
// blocks, and the way back from an offset in it to a text node. Subtrees
// matching `exclude` are left out whole.
function indexText(root, exclude) {
  const nodes = [];
  const starts = [];
  const startOf = new Map();
  let text = '';
  let lastBlock = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
      return node.matches(exclude) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    if (!node.data) continue;
    const block = node.parentElement && node.parentElement.closest(BLOCK);
    if (text && block !== lastBlock) text += '\n';
    lastBlock = block;
    nodes.push(node);
    starts.push(text.length);
    startOf.set(node, text.length);
    text += node.data;
  }
  return { text, nodes, starts, startOf };
}

// The text node holding offset `pos`, and the offset within it.
function locate(index, pos) {
  let lo = 0;
  let hi = index.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return { node: index.nodes[lo], offset: pos - index.starts[lo] };
}

function rangeAt(index, start, end) {
  const a = locate(index, start);
  const b = locate(index, end - 1);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset + 1);
  return range;
}

function rectsContain(range, x, y) {
  return Array.from(range.getClientRects()).some(function (r) {
    return x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1;
  });
}

const STYLE = [
  '::highlight(rv-sym){background-color:rgba(130,80,223,.2);text-decoration:underline 2px rgba(130,80,223,.85)}',
  '::highlight(rv-sym-focus){background-color:rgba(130,80,223,.42)}',
  '.rv-sym-rail{position:fixed;top:0;right:0;bottom:0;width:10px;z-index:2147483000;',
  'background:rgba(130,80,223,.06);border-left:1px solid rgba(130,80,223,.18)}',
  '.rv-sym-mark{position:absolute;left:1px;right:1px;height:3px;border-radius:1px;background:#8250df;cursor:pointer}',
  // A 3px mark is the picture; the hit area is taller.
  '.rv-sym-mark::before{content:"";position:absolute;left:-1px;right:-1px;top:-3px;bottom:-3px}',
  '.rv-sym-mark:hover{background:#5a32a3}',
  '.rv-sym-mark-focus{background:#5a32a3;left:0;right:0}',
  '.rv-sym-pill{position:fixed;right:20px;bottom:12px;z-index:2147483000;display:flex;align-items:center;gap:7px;',
  'background:#fff;border:1px solid rgba(130,80,223,.45);border-radius:999px;padding:3px 4px 3px 10px;',
  'box-shadow:0 2px 8px rgba(31,35,40,.15);font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2328}',
  '.rv-sym-pill code{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#5a32a3;',
  'max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:pre}',
  '.rv-sym-count{color:#59636e;font-variant-numeric:tabular-nums}',
  '.rv-sym-close{border:0;background:none;color:#59636e;cursor:pointer;font-size:13px;line-height:1;',
  'padding:2px 6px;border-radius:999px}',
  '.rv-sym-close:hover{background:#eef1f4;color:#1f2328}',
].join('');

// io: { root(): Element, exclude: selector, storageKey, platform,
//       busy(): bool (a composer is open), onWordPick(): the page's own
//       selection-driven UI stands down }
function createSymbolScan(io) {
  let active = null;      // { query, word }
  let matches = [];       // [{ start, range }] in page order
  let focusIndex = -1;    // the occurrence picked or jumped to
  let pressSelection = null;
  let rail = null;
  let pill = null;
  let recomputeTimer = null;
  let railFrame = 0;

  function ensureUI() {
    if (rail) return;
    const st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);
    rail = document.createElement('div');
    rail.className = 'rv-sym-rail rv-sym-ui';
    rail.addEventListener('mousedown', function (e) { e.preventDefault(); });
    rail.addEventListener('click', function (e) {
      const mark = e.target.closest && e.target.closest('.rv-sym-mark');
      if (mark) jump(Number(mark.dataset.i));
    });
    pill = document.createElement('div');
    pill.className = 'rv-sym-pill rv-sym-ui';
    pill.innerHTML = '<code></code><span class="rv-sym-count"></span>'
      + '<button class="rv-sym-close" title="Clear (Esc)">×</button>';
    pill.addEventListener('mousedown', function (e) { e.preventDefault(); });
    pill.querySelector('.rv-sym-close').addEventListener('click', clear);
  }

  function setHighlights() {
    if (!matches.length) {
      CSS.highlights.delete('rv-sym');
      CSS.highlights.delete('rv-sym-focus');
      return;
    }
    const all = new Highlight();
    matches.forEach(function (m) { all.add(m.range); });
    CSS.highlights.set('rv-sym', all);
    const focus = matches[focusIndex];
    if (focus) {
      const h = new Highlight(focus.range);
      h.priority = 1;
      CSS.highlights.set('rv-sym-focus', h);
    } else {
      CSS.highlights.delete('rv-sym-focus');
    }
  }

  // One mark per occupied pixel row of the rail: a dense run of matches reads
  // as a solid band, and the mark's click lands on the first of them.
  function renderRail() {
    railFrame = 0;
    if (!rail || !active) return;
    rail.textContent = '';
    const docH = Math.max(document.documentElement.scrollHeight, 1);
    const railH = rail.clientHeight;
    const rows = new Map();
    matches.forEach(function (m, i) {
      const r = m.range.getBoundingClientRect();
      const top = Math.min(railH - 3, Math.round(((r.top + window.scrollY) / docH) * railH));
      const row = rows.get(top);
      if (!row) rows.set(top, { first: i, focus: i === focusIndex });
      else if (i === focusIndex) row.focus = true;
    });
    rows.forEach(function (row, top) {
      const mark = document.createElement('div');
      mark.className = 'rv-sym-mark' + (row.focus ? ' rv-sym-mark-focus' : '');
      mark.style.top = top + 'px';
      mark.dataset.i = String(row.first);
      rail.appendChild(mark);
    });
  }

  function scheduleRail() {
    if (!railFrame) railFrame = requestAnimationFrame(renderRail);
  }

  function renderPill() {
    pill.querySelector('code').textContent = active.query;
    pill.querySelector('.rv-sym-count').textContent = String(matches.length);
  }

  // Find the active symbol's occurrences in the page as it stands. `focusAt`
  // is the text offset of the occurrence to mark as picked; without one the
  // picked occurrence keeps its place in the order.
  function run(index, focusAt) {
    const starts = findOccurrences(index.text, active.query, { word: active.word });
    matches = [];
    starts.forEach(function (start) {
      const range = rangeAt(index, start, start + active.query.length);
      // Text that is not drawn (a closed <details>) has nothing to scroll to.
      if (range.getClientRects().length) matches.push({ start: start, range: range });
    });
    if (focusAt != null) focusIndex = matches.findIndex(function (m) { return m.start === focusAt; });
    else if (focusIndex >= matches.length) focusIndex = -1;
    ensureUI();
    if (!rail.isConnected) document.body.append(rail, pill);
    setHighlights();
    renderPill();
    renderRail();
  }

  function show(query, word, index, focusAt) {
    active = { query: query, word: word };
    focusIndex = -1;
    try { sessionStorage.setItem(io.storageKey, JSON.stringify(active)); } catch {}
    run(index, focusAt);
  }

  function clear() {
    active = null;
    matches = [];
    focusIndex = -1;
    try { sessionStorage.removeItem(io.storageKey); } catch {}
    setHighlights();
    if (rail) { rail.remove(); pill.remove(); }
  }

  function recompute() {
    recomputeTimer = null;
    if (active) run(indexText(io.root(), io.exclude), null);
  }

  function jump(i) {
    const m = matches[i];
    if (!m) return;
    const r = m.range.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + r.top - window.innerHeight / 2 + r.height / 2 });
    focusIndex = i;
    setHighlights();
    renderRail();
  }

  // The selection the right-click landed in, if any. Read at the press, since
  // macOS selects the word under a right-click before the menu event fires.
  function selectionUnder(x, y) {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const raw = String(sel);
    const query = raw.trim();
    if (!query || /\n/.test(query) || !rectsContain(range, x, y)) return null;
    return {
      query: query,
      node: range.startContainer,
      offset: range.startOffset + (raw.length - raw.trimStart().length),
    };
  }

  function isContextPress(e) {
    return e.button === 2 || (io.platform === 'darwin' && e.button === 0 && e.ctrlKey);
  }

  function onPress(e) {
    pressSelection = isContextPress(e) ? selectionUnder(e.clientX, e.clientY) : null;
  }

  function onContextMenu(e) {
    const t = e.target;
    if (t && t.closest && t.closest('.rv-sym-ui')) { e.preventDefault(); return; }
    const root = io.root();
    if (!root || !t || !root.contains(t) || (t.closest && t.closest(io.exclude))) return;
    e.preventDefault();
    const picked = pressSelection;
    pressSelection = null;
    const index = indexText(root, io.exclude);
    if (picked) {
      const base = index.startOf.get(picked.node);
      show(picked.query, false, index, base == null ? null : base + picked.offset);
      return;
    }
    const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
    const base = pos && index.startOf.get(pos.offsetNode);
    const word = base == null ? null : wordAround(index.text, base + pos.offset);
    if (!word || !rectsContain(rangeAt(index, word.start, word.end), e.clientX, e.clientY)) {
      clear();
      return;
    }
    // The word is the target, not a selection: drop the one macOS made, and
    // anything it armed.
    const sel = window.getSelection && window.getSelection();
    if (sel) sel.removeAllRanges();
    io.onWordPick();
    show(index.text.slice(word.start, word.end), true, index, word.start);
  }

  function onKey(e) {
    if (e.key !== 'Escape' || !active) return;
    const t = e.target;
    const tag = t && t.tagName ? t.tagName.toUpperCase() : '';
    if (tag === 'TEXTAREA' || tag === 'INPUT' || (t && t.isContentEditable) || io.busy()) return;
    e.preventDefault();
    clear();
  }

  function bind() {
    window.addEventListener('mousedown', onPress, true);
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKey);
    // The page re-renders under the scan (thread cards, the commit editor):
    // find the matches again once it settles. Layout shifts move the marks.
    const root = io.root();
    if (root) {
      new MutationObserver(function () {
        if (!active) return;
        clearTimeout(recomputeTimer);
        recomputeTimer = setTimeout(recompute, 150);
      }).observe(root, { childList: true, subtree: true, characterData: true });
      new ResizeObserver(function () { if (active) scheduleRail(); }).observe(root);
    }
    window.addEventListener('resize', function () { if (active) scheduleRail(); });
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(io.storageKey) || 'null'); } catch {}
    if (saved && typeof saved.query === 'string' && saved.query) {
      active = { query: saved.query, word: !!saved.word };
      recompute();
    }
  }

  return { bind, clear };
}

module.exports = {
  isWordChar,
  wordAround,
  findOccurrences,
  indexText,
  rangeAt,
  createSymbolScan,
};
