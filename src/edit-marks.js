// Strike-in-place mark engine + [Edit] envelope — the shared "edit is a
// comment" core (docs/dev/maintainer/md-editing-design.md). A delete strikes the text in place
// (never removes it), a keystroke inserts it marked; the <del>/<ins> marks ARE
// the edit — no diff, no reconstruction — and flatten into the [Edit] envelope
// the agent reads (agent-threads/md/user-intent.md). Hosts: the md viewer's
// block editor and the review viewer's commit-message editor. Electron-free on
// purpose so esbuild can bundle it into the sandboxed webview preload.

function isPlainCommentKey(event) {
  return event
    && typeof event.key === 'string'
    && event.key.length === 1
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && !event.isComposing;
}

// The first-key dispatch (docs/dev/maintainer/md-editing-design.md): letters
// and digits comment — a–z, A–Z and 0–9 alike, since an aside starts
// sentence-case as naturally as not, and with a count ("3 issues:") as
// naturally as with a word. Every other unmodified key edits at the caret:
// ⌫/Delete, Enter, arrows, punctuation, Space. ASCII only — an accented or
// CJK character is text being typed into the document, not the start of an
// aside. IME composition never dispatches; modifier chords pass through.
function isCommentEntryKey(event) {
  return isPlainCommentKey(event) && /[a-zA-Z0-9]/.test(event.key);
}

function isEditEntryKey(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
  const k = event.key;
  if (k === 'Backspace' || k === 'Delete' || k === 'Enter'
    || k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') return true;
  return typeof k === 'string' && [...k].length === 1 && !/[a-zA-Z0-9]/.test(k);
}

// Entry keys split by whether they mutate: ⌫/Delete, every printable char —
// Space included — and Enter (a line break at the click caret) apply
// immediately: the keystroke IS the edit, and each only reaches dispatch
// with a block deliberately targeted (untargeted Space page-flips). A no-op
// entry read as "the key didn't work". Arrows enter the editor without
// inserting.
function isMutatingEntryKey(event) {
  const k = event.key;
  if (k === 'Backspace' || k === 'Delete' || k === 'Enter') return true;
  if (k.startsWith('Arrow')) return false;
  return [...k].length === 1;
}

const { pageUnits, newWordSpacing, wordEraseSpan, HOLD_WORD_MS } = require('./word-snap');

function markWrapping(node, sel) {
  const el = node && node.nodeType === 3 ? node.parentElement : node;
  return el && el.closest ? el.closest(sel) : null;
}

// The mark mutators, bound to a host: beforeMutate fires once at the top of
// every mutating call (the md viewer pushes its per-action undo snapshot
// there; a host without one passes nothing). Everything else is pure DOM.
function createMarkEngine({ beforeMutate } = {}) {
  const onMutate = typeof beforeMutate === 'function' ? beforeMutate : () => {};
  function editSel() { return window.getSelection && window.getSelection(); }
  function collapseCaret(node, mode) {
    const s = editSel(); if (!s) return; const r = document.createRange();
    if (mode === 'before') r.setStartBefore(node);
    else if (mode === 'after') r.setStartAfter(node);
    else r.setStart(node, mode); // mode is a numeric offset
    r.collapse(true); s.removeAllRanges(); s.addRange(r);
  }

  // Neighbouring strikes are one strike, and so are two with only spaces
  // between them: with both words gone, the space between goes too. Joined,
  // the run reads as one <del> to the agent and a later erase run hops it in
  // one press. Text nodes keep their identity, so a caret anchored on struck
  // text survives the join.
  function joinStrikes(block) {
    const isDel = (n) => !!n && n.nodeType === 1 && n.matches('del.md-pending-del');
    for (const del of block.querySelectorAll('del.md-pending-del')) {
      if (!del.parentNode) continue; // already joined into the one before
      let next = del.nextSibling;
      for (;;) {
        if (isDel(next)) {
          while (next.firstChild) del.appendChild(next.firstChild);
          next.remove();
        } else if (next && next.nodeType === 3 && /^[ \t\u00a0]+$/.test(next.data) && isDel(next.nextSibling)) {
          del.appendChild(next);
        } else break;
        next = del.nextSibling;
      }
    }
  }

  function strikeInBlock(block, range, caretMode) {
    onMutate();
    // Deleting text you inserted — it was never in the document, so remove it.
    const ins = markWrapping(range.commonAncestorContainer, 'ins.md-pending-ins');
    if (ins && ins.contains(range.startContainer) && ins.contains(range.endContainer)) {
      const land = screenOffset(block, range.startContainer, range.startOffset);
      range.deleteContents();
      if (!ins.textContent.length) ins.remove();
      joinStrikes(block); // the strikes either side of a removed insertion meet
      caretAtScreenOffset(block, land);
      return;
    }
    const sc = range.startContainer, so = range.startOffset, ec = range.endContainer, eo = range.endOffset;
    const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
    const walker = document.createTreeWalker(block, SHOW_TEXT, null);
    const touched = []; let n;
    while ((n = walker.nextNode())) { if (range.intersectsNode(n)) touched.push(n); }
    // The caret settles at the edge of what this erase struck: the struck
    // text itself, or for text struck earlier, its whole strike (so a ⌫
    // against an old strike hops past it instead of dead-stopping).
    let first = null, last = null;
    for (const tn of touched) {
      const s = (tn === sc) ? so : 0;
      const e = (tn === ec) ? eo : tn.data.length;
      if (e <= s) continue;
      let mid = tn;
      if (s > 0) mid = mid.splitText(s);
      if (mid.data.length > (e - s)) mid.splitText(e - s);
      const parent = mid.parentNode;
      const struck = parent && parent.closest ? parent.closest('del.md-pending-del') : null;
      if (struck) {
        if (!first) first = { node: mid, struck: true };
        last = { node: mid, struck: true };
        continue;
      }
      const insHost = parent && parent.closest ? parent.closest('ins.md-pending-ins') : null;
      if (insHost) {
        parent.removeChild(mid);
        if (!insHost.textContent.length) insHost.remove();
        continue;
      }
      const del = document.createElement('del');
      del.className = 'md-pending-del';
      parent.insertBefore(del, mid);
      del.appendChild(mid);
      if (!first) first = { node: mid };
      last = { node: mid };
    }
    joinStrikes(block);
    if (!last) return;
    const after = caretMode === 'after';
    const edge = after ? last : first;
    collapseCaret(edge.struck ? markWrapping(edge.node, 'del.md-pending-del') : edge.node, after ? 'after' : 'before');
  }

  // A caret parked inside struck text (arrow walks and clicks land there — the
  // position after a strike's last char and the one beyond the <del> are the
  // same screen spot) must not put new text inside the del, where it would
  // render struck. At the strike's edge the caret hops out; mid-strike the del
  // splits and the insertion takes the seam.
  function escapeDelAtCaret(range) {
    const del = markWrapping(range.startContainer, 'del.md-pending-del');
    if (!del || !del.parentNode) return;
    const pre = document.createRange();
    pre.selectNodeContents(del);
    pre.setEnd(range.startContainer, range.startOffset);
    const before = pre.toString().length;
    if (before <= 0) range.setStartBefore(del);
    else if (before >= del.textContent.length) range.setStartAfter(del);
    else {
      const tail = document.createElement('del');
      tail.className = 'md-pending-del';
      const rest = document.createRange();
      rest.selectNodeContents(del);
      rest.setStart(range.startContainer, range.startOffset);
      tail.appendChild(rest.extractContents());
      del.parentNode.insertBefore(tail, del.nextSibling);
      range.setStartAfter(del);
    }
    range.collapse(true);
  }

  // The text nodes a range covers, each with its covered span and the mark
  // it sits in (null: original text).
  function coveredText(block, range) {
    const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
    const walker = document.createTreeWalker(block, SHOW_TEXT, null);
    const parts = []; let n;
    while ((n = walker.nextNode())) {
      if (!range.intersectsNode(n)) continue;
      const s = (n === range.startContainer) ? range.startOffset : 0;
      const e = (n === range.endContainer) ? range.endOffset : n.data.length;
      if (e > s) parts.push({ node: n, s, e, mark: markWrapping(n, 'del.md-pending-del, ins.md-pending-ins') });
    }
    return parts;
  }

  // Caret offsets counted in on-screen text, struck text included: a
  // take-back moves nodes in and out of marks, so only the text count
  // survives it as a landing point.
  function screenOffset(block, node, offset) {
    const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
    const point = document.createRange();
    point.setStart(node, offset);
    point.collapse(true);
    const walker = document.createTreeWalker(block, SHOW_TEXT, null);
    let count = 0; let n;
    while ((n = walker.nextNode())) {
      if (n === node) return count + offset;
      if (point.comparePoint(n, n.data.length) > 0) break;
      count += n.data.length;
    }
    return count;
  }

  function caretAtScreenOffset(block, offset) {
    const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
    const walker = document.createTreeWalker(block, SHOW_TEXT, null);
    let left = offset; let last = null; let n;
    while ((n = walker.nextNode())) {
      if (left < n.data.length) { collapseCaret(n, left); return; }
      left -= n.data.length;
      last = n;
    }
    if (last) collapseCaret(last, last.data.length);
  }

  // Lift one text node out of its strike: the del splits around it, and
  // whatever wraps the node inside the del splits with it.
  function unstrike(node, del) {
    const parent = del.parentNode;
    const next = del.nextSibling;
    const tail = document.createRange();
    tail.setStartAfter(node);
    tail.setEnd(del, del.childNodes.length);
    const rest = tail.extractContents();
    const lift = document.createRange();
    lift.setStartBefore(node);
    lift.setEnd(del, del.childNodes.length);
    parent.insertBefore(lift.extractContents(), next);
    // The splits clone each wrapper on both sides; the sides the node left
    // keep empty shells.
    const dropShells = (root) => root.querySelectorAll('*').forEach((el) => { if (!el.textContent.length) el.remove(); });
    dropShells(rest);
    dropShells(del);
    if (rest.textContent.length) {
      const tailDel = document.createElement('del');
      tailDel.className = 'md-pending-del';
      tailDel.appendChild(rest);
      parent.insertBefore(tailDel, next);
    }
    if (!del.textContent.length) del.remove();
  }

  // Erasing your own change takes it back: an insertion leaves, a strike
  // comes back as plain text. Original text in the range is left alone.
  // Returns whether anything changed.
  function takeBackInBlock(block, range, caretMode) {
    const parts = coveredText(block, range).filter((p) => p.mark);
    if (!parts.length) return false;
    onMutate();
    const after = caretMode === 'after';
    const from = screenOffset(block, range.startContainer, range.startOffset);
    let to = screenOffset(block, range.endContainer, range.endOffset);
    let land = after ? to : from;
    for (const { node, s, e, mark } of parts) {
      let mid = node;
      if (s > 0) mid = mid.splitText(s);
      if (mid.data.length > (e - s)) mid.splitText(e - s);
      if (mark.nodeName === 'INS') {
        if (after) land -= mid.data.length; // removed text before the landing point
        to -= mid.data.length;
        mid.remove();
        if (!mark.textContent.length) mark.remove();
      } else {
        unstrike(mid, mark);
      }
    }
    joinStrikes(block); // the strikes either side of a removed insertion meet
    // Spaces are struck or typed only along with a word, so a mark left
    // holding only spaces beside a word taken back is that word's leftover:
    // strike "the file", take back "file" then "the", and the space between
    // comes back too; take back a word typed into a gap, and the space it
    // came with leaves.
    for (const mark of Array.from(block.querySelectorAll('del.md-pending-del, ins.md-pending-ins'))) {
      if (mark.textContent.trim() || mark.classList.contains('md-pending-break')) continue;
      const first = textNodesOf(mark)[0];
      if (!first) continue;
      const start = screenOffset(block, first, 0);
      const end = start + mark.textContent.length;
      if (end !== from && start !== to) continue;
      if (mark.nodeName === 'INS') {
        if (end <= land) land -= mark.textContent.length;
        mark.remove();
      } else {
        while (mark.firstChild) mark.parentNode.insertBefore(mark.firstChild, mark);
        mark.remove();
      }
    }
    caretAtScreenOffset(block, land);
    return true;
  }

  // ⌫/Delete. Erasing original text strikes it; erasing your own change
  // takes it back. A run of erases (each landing where the caret was left)
  // keeps the job its first erase found: a striking run hops older strikes,
  // so erasing on through a passage never brings one back; a taking-back
  // run stops at the end of the marks while the key is held, and the next
  // press strikes on. A selection takes back only when it holds nothing
  // original.
  let run = null;
  let keyRepeat = false;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' || event.key === 'Delete') keyRepeat = !!event.repeat;
  }, true);
  function eraseInBlock(block, range, { backward = true, selection = false, repeat = keyRepeat, mode: freshMode = null } = {}) {
    const caretMode = selection || !backward ? 'after' : 'before';
    const s = editSel();
    // Where the last erase left the caret, counted on screen: a host may
    // re-seat the caret at the same spot (the gap caret does).
    const continuing = !selection && !!run && run.block === block && run.backward === backward
      && !!s && s.isCollapsed && block.contains(s.anchorNode)
      && screenOffset(block, s.anchorNode, s.anchorOffset) === run.at;
    let mode = continuing ? run.mode
      : freshMode || (coveredText(block, range).some((p) => !p.mark) ? 'strike' : 'takeBack');
    if (mode === 'takeBack' && !takeBackInBlock(block, range, caretMode)) {
      if (repeat) return;
      mode = 'strike';
    }
    if (mode === 'strike') strikeInBlock(block, range, caretMode);
    const landed = editSel();
    run = landed && landed.rangeCount && block.contains(landed.anchorNode)
      ? { block, backward, mode, at: screenOffset(block, landed.anchorNode, landed.anchorOffset) }
      : null;
  }

  // ——— The page's words (docs/dev/maintainer/md-editing-design.md) ———
  // The page's text is made of whole units, words and punctuation marks:
  // you strike or restore a unit and insert between units, never inside one
  // (an edit is an intent for the agent, so part of a word is never what is
  // meant). The text you typed is ordinary text: ⌫ takes a letter, arrows
  // move a letter, a click lands where it is.

  // The block's on-screen units (pageUnits; struck text included: it is on
  // the page), split where your typing meets the page's text. Each carries
  // whether you typed it and whether it is all struck. Also returns the
  // per-character typed and struck flags.
  function editWords(block) {
    let text = '';
    const typed = [];
    const struck = [];
    for (const n of textNodesOf(block)) {
      const ins = !!markWrapping(n, 'ins.md-pending-ins');
      const del = !ins && !!markWrapping(n, 'del.md-pending-del');
      text += n.data;
      for (let i = 0; i < n.data.length; i++) { typed.push(ins); struck.push(del); }
    }
    const words = [];
    for (const w of pageUnits(text)) {
      const push = (start, end) => words.push({
        start, end, typed: typed[start], struck: struck.slice(start, end).every(Boolean),
      });
      let start = w.start;
      for (let i = w.start + 1; i < w.end; i++) {
        if (typed[i] !== typed[i - 1]) { push(start, i); start = i; }
      }
      push(start, w.end);
    }
    return { text, words, typed, struck };
  }

  function rangeAtScreen(block, from, to) {
    const nodes = textNodesOf(block);
    const point = (k, isEnd) => {
      let left = k; let last = null;
      for (const n of nodes) {
        if (left < n.data.length || (isEnd && left === n.data.length)) return [n, left];
        left -= n.data.length;
        last = n;
      }
      return last ? [last, last.data.length] : [block, 0];
    };
    const r = document.createRange();
    r.setStart(...point(from, false));
    r.setEnd(...point(to, true));
    return r;
  }

  function caretScreenOffset(block) {
    const s = editSel();
    if (!s || !s.rangeCount || !block.contains(s.focusNode)) return null;
    return screenOffset(block, s.focusNode, s.focusOffset);
  }

  // Whether the character the caret meets going back (or forward) is your
  // own text: there the keys act a letter at a time, as in any text box.
  function yoursBeside(block, backward) {
    const caret = caretScreenOffset(block);
    if (caret == null) return false;
    return !!editWords(block).typed[backward ? caret - 1 : caret];
  }

  // What ⌫ (backward) or Delete at the caret takes, on the first text it
  // reaches: { from, to, text, yours, restores } in screen offsets, or null.
  // Your own text (yours) goes as the browser's span says (a letter; with
  // Option/Ctrl, a word), as far as your text goes. A page unit goes whole,
  // a word or a punctuation mark (⌫ at `waits.|` takes the `.`, the next
  // `waits`), and backward the spaces between the unit and the caret go
  // with it, so striking on through a sentence makes one strike
  // (wordEraseSpan). restores: the page text there is all struck, so it
  // comes back. `range` is the browser's target range, when there is one.
  function eraseTarget(block, { backward = true, range = null } = {}) {
    const caret = caretScreenOffset(block);
    if (caret == null) return null;
    const { text, words, typed, struck } = editWords(block);
    const step = backward ? -1 : 1;
    let k = backward ? caret - 1 : caret; // the first of your text, or of the page's non-space, the press reaches
    while (k >= 0 && k < text.length && !typed[k] && /\s/.test(text[k])) k += step;
    if (k < 0 || k >= text.length) return null;
    if (typed[k]) {
      let from = k;
      let to = k + 1;
      if (range && k === (backward ? caret - 1 : caret)) {
        let edge = caret; // the far edge of your text beside the caret
        while (typed[backward ? edge - 1 : edge]) edge += step;
        const far = screenOffset(block, backward ? range.startContainer : range.endContainer,
          backward ? range.startOffset : range.endOffset);
        if (backward) { from = Math.max(far, edge); to = caret; } else { from = caret; to = Math.min(far, edge); }
        if (to <= from) { from = k; to = k + 1; }
      }
      return { from, to, text: text.slice(from, to), yours: true, restores: false };
    }
    const word = words.find((w) => w.start <= k && k < w.end);
    if (!word) return null;
    const { from, to } = wordEraseSpan(text, word, caret, backward);
    const restores = [...text.slice(from, to)].every((ch, i) => /\s/.test(ch) || struck[from + i]);
    return { from, to, text: text.slice(from, to), yours: false, restores };
  }

  // ⌫ (backward) or Delete at the caret (eraseTarget): your own text leaves,
  // an original unit strikes, a struck unit comes back. A run of presses
  // keeps the job its first found (eraseInBlock); held, a page unit goes
  // every HOLD_WORD_MS. Returns whether anything was erased.
  let lastWordErase = 0;
  function eraseAtCaret(block, { backward = true, range = null, repeat = keyRepeat } = {}) {
    const target = eraseTarget(block, { backward, range });
    if (!target) return false;
    if (target.yours) {
      eraseInBlock(block, rangeAtScreen(block, target.from, target.to), { backward, repeat, mode: 'takeBack' });
      return true;
    }
    const now = Date.now();
    if (repeat && now - lastWordErase < HOLD_WORD_MS) return false;
    lastWordErase = now;
    eraseInBlock(block, rangeAtScreen(block, target.from, target.to),
      { backward, repeat, mode: target.restores ? 'takeBack' : 'strike' });
    // The caret rests on the space before the word it landed at; the run
    // goes on from there.
    const rest = restCaret(block);
    if (run && rest != null) run.at = rest;
    return true;
  }

  // Whether `offset` is a resting spot between the page's units, where the
  // caret is the block and typing starts a new word: not inside a page unit,
  // and not touching your own text (there the caret is the bar and typing
  // goes on with your text), in a block with text.
  function isBetweenWords(block, offset) {
    const { text, words, typed } = editWords(block);
    if (offset == null || !text.trim()) return false;
    if (typed[offset - 1] || typed[offset]) return false;
    return !words.some((w) => w.start < offset && offset < w.end);
  }

  // A caret resting at a word's start, after spaces that follow a word,
  // rests at that word's end instead: the block caret then sits on the
  // space, where a new word goes, rather than on the next word's first
  // letter. The text typed there comes out the same. A word at the block's
  // start, after a line break, or right after an opening bracket keeps the
  // caret at its start.
  function restingOffset(block, offset) {
    if (offset == null) return offset;
    let text = '';
    const struck = [];
    for (const n of textNodesOf(block)) {
      const del = !!markWrapping(n, 'del.md-pending-del');
      text += n.data;
      for (let i = 0; i < n.data.length; i++) struck.push(del);
    }
    const space = (k) => /[ \t\u00a0]/.test(text[k] || '') && !struck[k]; // a struck space is going away
    if (!/\S/.test(text[offset] || '') || !space(offset - 1)) return offset;
    let k = offset;
    while (k > 0 && space(k - 1)) k--;
    return k > 0 && /\S/.test(text[k - 1]) ? k : offset;
  }

  // Seat the current caret at its resting spot; returns that offset.
  function restCaret(block) {
    const s = editSel();
    if (!s || !s.rangeCount || !s.isCollapsed) return null;
    const caret = caretScreenOffset(block);
    if (caret == null) return null;
    const rest = restingOffset(block, caret);
    if (rest !== caret) caretAtScreenOffset(block, rest);
    return rest;
  }

  // ←/→ across the page's text (the host lets the browser move a letter
  // through yours, yoursBeside): the caret moves to the end of the unit
  // before or after, a word or a punctuation mark (at the block's edge it
  // stays). Returns where it rests.
  function moveByWord(block, backward) {
    const caret = caretScreenOffset(block);
    if (caret == null) return null;
    const s = editSel();
    const r = s.getRangeAt(0);
    const from = s.isCollapsed ? caret
      : screenOffset(block, backward ? r.startContainer : r.endContainer, backward ? r.startOffset : r.endOffset);
    const stops = [0, ...editWords(block).words.map((w) => w.end)];
    const to = backward ? stops.filter((e) => e < from).pop() : stops.find((e) => e > from);
    const rest = to == null ? from : to;
    caretAtScreenOffset(block, rest);
    return rest;
  }

  // A caret that landed inside a page unit (a click, a line move) rests
  // after it: after a word's letters, before the punctuation after them. In
  // your own text it stays. Returns the offset it rests at.
  function settleCaretAfterWord(block) {
    const s = editSel();
    if (!s || !s.rangeCount || !s.isCollapsed) return null;
    const caret = caretScreenOffset(block);
    if (caret == null) return null;
    const word = editWords(block).words.find((w) => !w.typed && w.start < caret && caret < w.end);
    if (!word) return caret;
    caretAtScreenOffset(block, word.end);
    return word.end;
  }

  // Shift+←/→ across the page's text: the selection's moving end goes a word
  // at a time.
  function extendByWord(block, backward) {
    const s = editSel();
    if (!s || !s.rangeCount || typeof s.modify !== 'function') return;
    s.modify('extend', backward ? 'backward' : 'forward', 'word');
  }

  // Returns the insertion the text went into (a new <ins>, or the one the
  // caret was already inside), or null when nothing was inserted.
  function insertMarkedInBlock(text) {
    if (!text) return null;
    const s = editSel(); if (!s || !s.rangeCount) return null;
    onMutate();
    const range = s.getRangeAt(0);
    range.deleteContents();
    escapeDelAtCaret(range);
    const host = markWrapping(range.startContainer, 'ins.md-pending-ins');
    const tn = document.createTextNode(text.replace(/\s/g, ' '));
    let ins = host;
    if (host) { range.insertNode(tn); }
    else {
      ins = document.createElement('ins'); ins.className = 'md-pending-ins'; ins.appendChild(tn); range.insertNode(ins);
      // Text typed right against an insertion of yours is part of it: one
      // insertion to the agent, as neighbouring strikes are one strike.
      const isIns = (n) => !!n && n.nodeType === 1 && n.matches('ins.md-pending-ins') && !n.matches('.md-pending-break');
      const beside = (n, dir) => { let m = n[dir]; while (m && m.nodeType === 3 && !m.data.length) m = m[dir]; return m; };
      const prev = beside(ins, 'previousSibling');
      const next = beside(ins, 'nextSibling');
      if (isIns(prev)) { prev.appendChild(tn); ins.remove(); ins = prev; }
      else if (isIns(next)) { next.insertBefore(tn, next.firstChild); ins.remove(); ins = next; }
    }
    collapseCaret(tn, tn.length);
    return ins;
  }

  // The first text typed at a resting caret (between words: the block
  // caret) makes a word of its own, with a space on whichever side lacks
  // one: before it after a word (`foo bar` + `baz` at the space reads
  // `foo baz bar`), after it before a word (at the start of `bar`, the same
  // result). The caret stays inside the insertion, before any space added
  // after it, so the next keys extend the word. Erasing the word takes the
  // added space with it. Closing punctuation right after a word attaches to
  // it instead: `foo, bar`. The insertion is flagged so commit can tidy
  // typed spaces against the added ones (settleGapInsertions).
  function insertAtGap(text, block) {
    if (!text) return null;
    const caret = caretScreenOffset(block);
    const spacing = caret == null ? null
      : newWordSpacing(text, caret, textNodesOf(block).map((n) => n.data).join(''));
    if (!spacing) return insertMarkedInBlock(text);
    const trail = spacing.trail;
    const ins = insertMarkedInBlock(`${spacing.lead}${text}${trail}`);
    if (!ins) return null;
    ins.setAttribute('data-md-gap', '');
    if (trail) {
      const s = editSel();
      const r = s && s.rangeCount ? s.getRangeAt(0) : null;
      if (r && r.startContainer.nodeType === 3 && r.startOffset > 0) collapseCaret(r.startContainer, r.startOffset - 1);
    }
    return ins;
  }

  function insertLineBreakInBlock() {
    const s = editSel(); if (!s || !s.rangeCount) return;
    onMutate();
    const range = s.getRangeAt(0);
    range.deleteContents();
    escapeDelAtCaret(range);
    const tn = document.createTextNode('\n');
    if (markWrapping(range.startContainer, 'pre')) {
      const host = markWrapping(range.startContainer, 'ins.md-pending-ins');
      if (host) { range.insertNode(tn); }
      else { const el = document.createElement('ins'); el.className = 'md-pending-ins'; el.appendChild(tn); range.insertNode(el); }
      collapseCaret(tn, tn.length);
      return;
    }
    // Always a fresh atom, even mid-insertion (a nested ins is fine — the
    // envelope reads the outer mark's textContent), so the pilcrow/pre-wrap
    // styling stays scoped to the break itself. Caret lands after the atom:
    // the next typed char must join the surrounding run, not the atom.
    const el = document.createElement('ins');
    el.className = 'md-pending-ins md-pending-break';
    el.appendChild(tn);
    range.insertNode(el);
    collapseCaret(el, 'after');
  }

  return {
    strikeInBlock, eraseInBlock, escapeDelAtCaret, insertMarkedInBlock, insertAtGap, insertLineBreakInBlock,
    eraseTarget, eraseAtCaret, yoursBeside, moveByWord, settleCaretAfterWord, extendByWord, isBetweenWords, restingOffset,
  };
}


function textNodesOf(block) {
  const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
  const walker = document.createTreeWalker(block, SHOW_TEXT, null);
  const nodes = []; let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

// The on-screen character beside (node, index), walking across text nodes:
// step -1 is the one before, +1 the one after. '' past the block's edge.
function screenCharBeside(nodes, node, index, step) {
  let i = nodes.indexOf(node);
  let at = index + step;
  while (i >= 0 && i < nodes.length) {
    const data = nodes[i].data;
    if (at >= 0 && at < data.length) return data[at];
    i += step;
    if (i < 0 || i >= nodes.length) break;
    at = step < 0 ? nodes[i].data.length - 1 : 0;
  }
  return '';
}

// The gap under a click: one whitespace character between two non-space
// characters on screen (struck text counts: it is still on the page), in
// prose (never in a code block), outside the user's own marks. A click is at
// the gap when the caret would land beside that space, the nearest letter
// boundary as any editor places it: on the space itself, or on the near half
// of the letter either side. A click past a line's end is never at a gap.
// Returns { node, index } of the space, or null.
const GAP_MARKS = 'del.md-pending-del, ins.md-pending-ins, del.md-sent-del, ins.md-sent-ins';
function gapCharAtPoint(block, x, y) {
  if (!block || typeof document.caretRangeFromPoint !== 'function') return null;
  let hit = null;
  try { hit = document.caretRangeFromPoint(x, y); } catch { return null; }
  if (!hit || !block.contains(hit.startContainer) || hit.startContainer.nodeType !== 3) return null;
  const nodes = textNodesOf(block).filter((n) => n.data.length);
  const hitIndex = nodes.indexOf(hit.startContainer);
  if (hitIndex < 0) return null;
  const starts = [];
  let total = 0;
  for (const n of nodes) { starts.push(total); total += n.data.length; }
  const text = nodes.map((n) => n.data).join('');
  const at = (k) => {
    for (let i = nodes.length - 1; i >= 0; i--) if (k >= starts[i]) return { node: nodes[i], offset: k - starts[i] };
    return null;
  };
  const caret = starts[hitIndex] + hit.startOffset;
  for (const g of [caret, caret - 1]) {
    if (!/\s/.test(text[g] || '') || !/\S/.test(text[g - 1] || '') || !/\S/.test(text[g + 1] || '')) continue;
    const space = at(g);
    const parent = space.node.parentElement;
    if (!parent || parent.closest('pre') || parent.closest(GAP_MARKS)) continue;
    // The point must be on the letter, space, letter run itself: past a
    // line's end the nearest boundary can sit beside a space too.
    const from = at(g - 1);
    const to = at(g + 1);
    const run = document.createRange();
    run.setStart(from.node, from.offset);
    run.setEnd(to.node, to.offset + 1);
    const onRun = Array.from(run.getClientRects()).some((r) => r.width > 0
      && x >= r.left && x < r.right && y >= r.top && y <= r.bottom);
    if (onRun) return { node: space.node, index: space.offset };
  }
  return null;
}

// The end of a block is a gap too, the place to add a word after the last
// one: a click on the near (right) half of its last character puts the caret
// after it. Returns { node, offset } of that spot, or null.
function blockEndAtPoint(block, x, y) {
  if (!block || typeof document.caretRangeFromPoint !== 'function') return null;
  let hit = null;
  try { hit = document.caretRangeFromPoint(x, y); } catch { return null; }
  if (!hit || !block.contains(hit.startContainer) || hit.startContainer.nodeType !== 3) return null;
  const nodes = textNodesOf(block).filter((n) => n.data.length);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const last = node.data.search(/\S\s*$/);
    if (last < 0) continue; // whitespace only: look further back
    if (hit.startContainer !== node || hit.startOffset !== last + 1) return null;
    const parent = node.parentElement;
    if (!parent || parent.closest('pre') || parent.closest(GAP_MARKS)) return null;
    const box = document.createRange();
    box.setStart(node, last);
    box.setEnd(node, last + 1);
    const onIt = Array.from(box.getClientRects()).some((r) => r.width > 0
      && x >= r.left && x < r.right && y >= r.top && y <= r.bottom);
    return onIt ? { node, offset: last + 1 } : null;
  }
  return null;
}

// The block caret on a block: `caret-shape: block` (CSS .md-gap-caret)
// covers the character after the caret, a space at a gap. At the block's end
// there is none, and Chromium draws the block a digit wide, twice a space.
// There the native caret hides and the block's ::after draws one a space
// wide (a space in this block's own font) and as tall as the text, blinking
// in the caret's place (CSS .md-gap-caret-end). The custom properties live
// on the block element itself, outside the content the marks serialize.
function markGapCaret(block, atEnd) {
  block.classList.add('md-gap-caret');
  block.classList.toggle('md-gap-caret-end', !!atEnd);
  if (!atEnd) return;
  const nodes = textNodesOf(block).filter((n) => n.data.length);
  const glyph = (node, k) => {
    const r = document.createRange();
    r.setStart(node, k);
    r.setEnd(node, k + 1);
    return typeof r.getBoundingClientRect === 'function' ? r.getBoundingClientRect() : { width: 0, height: 0 }; // no layout: the CSS fallbacks
  };
  let spaceW = 0;
  for (let i = nodes.length - 1; i >= 0 && !spaceW; i--) {
    const k = nodes[i].data.lastIndexOf(' ');
    if (k >= 0) spaceW = glyph(nodes[i], k).width;
  }
  const last = nodes.filter((n) => /\S/.test(n.data)).pop();
  const caretH = last ? glyph(last, last.data.search(/\S\s*$/)).height : 0;
  block.style.setProperty('--md-space-w', spaceW > 0 ? `${spaceW}px` : '0.28em');
  if (caretH > 0) block.style.setProperty('--md-caret-h', `${caretH}px`);
  else block.style.removeProperty('--md-caret-h');
}

function unmarkGapCaret(block) {
  block.classList.remove('md-gap-caret', 'md-gap-caret-end');
  block.style.removeProperty('--md-space-w');
  block.style.removeProperty('--md-caret-h');
  if (!block.getAttribute('style')) block.removeAttribute('style');
}

// Commit-time tidy for words typed into gaps: a gap insertion left holding only
// whitespace goes, and one ending in typed spaces keeps none of them where the
// gap's own space follows (`foo baz  bar` reads `foo baz bar`) or the block
// ends, and one before a word (`baz  bar`, a space typed before the added
// one).
function settleGapInsertions(block) {
  for (const ins of Array.from(block.querySelectorAll('ins.md-pending-ins[data-md-gap]'))) {
    if (!ins.textContent.trim()) { ins.remove(); continue; }
    if (!/\s$/.test(ins.textContent)) continue;
    const tail = textNodesOf(ins).pop();
    const next = screenCharBeside(textNodesOf(block), tail, tail.data.length - 1, 1);
    if (next && !/\s/.test(next)) {
      // Before a word: one space between, however many were typed.
      while (/\s\s$/.test(ins.textContent)) {
        const last = textNodesOf(ins).filter((n) => n.data.length).pop();
        last.data = last.data.slice(0, -1);
        if (!last.data.length) last.remove();
      }
      continue;
    }
    // Each keystroke is its own text node, so the typed spaces can span several.
    while (/\s$/.test(ins.textContent)) {
      const last = textNodesOf(ins).pop();
      last.data = last.data.replace(/\s+$/, '');
      if (!last.data.length) last.remove();
    }
  }
}

// Snapshot a block's marked content for the overlay: strip editing artifacts
// (contenteditable's NBSPs and stray <br>), drop empty marks, keep the del/ins.
function serializeMarkedBlock(el) {
  const clone = el.cloneNode(true);
  clone.removeAttribute('contenteditable');
  clone.classList.remove('md-rendered-editing');
  clone.querySelectorAll('br').forEach((b) => b.remove());
  const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
  const walk = document.createTreeWalker(clone, SHOW_TEXT, null);
  let n; while ((n = walk.nextNode())) n.nodeValue = n.nodeValue.replace(/\u00a0/g, " ");
  clone.querySelectorAll('del.md-pending-del, ins.md-pending-ins').forEach((m) => { if (!m.textContent.length) m.remove(); });
  return clone.innerHTML;
}

// Flatten marked HTML to the envelope's rendered-text form: only <del>/<ins>
// survive; every other tag drops away (the agent maps rendered marks to the
// source — the marks always sit over what the user saw).
function overlayToEnvelope(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  let out = '';
  const walk = (node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) out += child.nodeValue;
      else if (child.nodeName === 'DEL') out += `<del>${child.textContent}</del>`;
      else if (child.nodeName === 'INS') out += `<ins>${child.textContent}</ins>`;
      else walk(child);
    });
  };
  walk(tmp);
  return out;
}

function wrapEditEnvelope(inner, marker) {
  return `[Edit]\n${marker || ''}${inner}\n[/Edit]`;
}

function parseEditEnvelope(body) {
  const text = String(body || '');
  const at = text.indexOf('[Edit]');
  const end = text.indexOf('[/Edit]');
  if (at === -1 || end === -1 || end < at) return null;
  const lead = text.slice(0, at).trim();
  const inner = text.slice(at + 6, end).replace(/^\n/, '').replace(/\n$/, '');
  const lines = inner.split('\n');
  // Any body with marks is a merged edit — parse the whole inner (a strike-in-
  // place edit on a soft-wrapped block spans lines, its newlines staying as
  // text between marks). Only a markless -/+ body is structural.
  if (/<del>|<ins>/.test(inner)) {
    const segments = [];
    const re = /<del>([\s\S]*?)<\/del>|<ins>([\s\S]*?)<\/ins>/g;
    let last = 0;
    let m;
    while ((m = re.exec(inner)) !== null) {
      if (m.index > last) segments.push({ kind: 'text', text: inner.slice(last, m.index) });
      if (m[1] != null) segments.push({ kind: 'del', text: m[1] });
      else segments.push({ kind: 'ins', text: m[2] });
      last = m.index + m[0].length;
    }
    if (last < inner.length) segments.push({ kind: 'text', text: inner.slice(last) });
    return { lead, kind: 'merged', segments };
  }
  const rows = lines.map((l) => (
    l.startsWith('- ') || l === '-' ? { sign: 'old', text: l.slice(2) }
      : (l.startsWith('+ ') || l === '+' ? { sign: 'new', text: l.slice(2) } : { sign: 'ctx', text: l })
  ));
  return { lead, kind: 'lines', rows };
}

function buildEnvelopeDiffNode(parsed) {
  const body = document.createElement('div');
  body.className = 'md-pending-diff-body';
  if (parsed.kind === 'merged') {
    for (const seg of parsed.segments) {
      if (seg.kind === 'text') body.append(document.createTextNode(seg.text));
      else {
        const el = document.createElement(seg.kind);
        el.textContent = seg.text;
        body.appendChild(el);
      }
    }
  } else {
    for (const row of parsed.rows) {
      const div = document.createElement('div');
      div.className = row.sign === 'old' ? 'md-pending-diff-old'
        : (row.sign === 'new' ? 'md-pending-diff-new' : 'md-pending-diff-ctx');
      div.textContent = row.text === '' ? ' ' : row.text;
      body.appendChild(div);
    }
  }
  return body;
}

module.exports = {
  isPlainCommentKey,
  isCommentEntryKey,
  isEditEntryKey,
  isMutatingEntryKey,
  markWrapping,
  createMarkEngine,
  gapCharAtPoint,
  blockEndAtPoint,
  settleGapInsertions,
  markGapCaret,
  unmarkGapCaret,
  serializeMarkedBlock,
  overlayToEnvelope,
  wrapEditEnvelope,
  parseEditEnvelope,
  buildEnvelopeDiffNode,
};
