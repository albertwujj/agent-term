// Strike-in-place mark engine + [Edit] envelope — the shared "edit is a
// comment" core (docs/maintainer/md-editing-design.md). A delete strikes the text in place
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

// The first-key dispatch (docs/maintainer/md-editing-design.md): letters comment — a–z and
// A–Z alike, since an aside starts sentence-case as naturally as not. Every
// other unmodified key edits at the caret: ⌫/Delete, Enter, arrows, digits,
// punctuation, Space. ASCII letters only — an accented or CJK character is
// text being typed into the document, not the start of an aside. IME
// composition never dispatches; modifier chords pass through.
function isCommentEntryKey(event) {
  return isPlainCommentKey(event) && /[a-zA-Z]/.test(event.key);
}

function isEditEntryKey(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
  const k = event.key;
  if (k === 'Backspace' || k === 'Delete' || k === 'Enter'
    || k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') return true;
  return typeof k === 'string' && [...k].length === 1 && !/[a-zA-Z]/.test(k);
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

  function strikeInBlock(block, range, caretMode) {
    onMutate();
    // Deleting text you inserted — it was never in the document, so remove it.
    const ins = markWrapping(range.commonAncestorContainer, 'ins.md-pending-ins');
    if (ins && ins.contains(range.startContainer) && ins.contains(range.endContainer)) {
      const sc = range.startContainer, so = range.startOffset;
      range.deleteContents();
      if (!ins.textContent.length) { collapseCaret(ins, 'before'); ins.remove(); }
      else collapseCaret(sc, so);
      return;
    }
    const sc = range.startContainer, so = range.startOffset, ec = range.endContainer, eo = range.endOffset;
    const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
    const walker = document.createTreeWalker(block, SHOW_TEXT, null);
    const touched = []; let n;
    while ((n = walker.nextNode())) { if (range.intersectsNode(n)) touched.push(n); }
    let firstDel = null, lastDel = null;
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
        // Already struck — no new mark, but it is part of the run the caret
        // settles around, so a ⌫ against old struck text hops past it
        // instead of dead-stopping.
        if (!firstDel) firstDel = struck;
        lastDel = struck;
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
      if (!firstDel) firstDel = del;
      lastDel = del;
    }
    if (lastDel) collapseCaret(caretMode === 'after' ? lastDel : firstDel, caretMode === 'after' ? 'after' : 'before');
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

  function insertMarkedInBlock(text) {
    if (!text) return;
    const s = editSel(); if (!s || !s.rangeCount) return;
    onMutate();
    const range = s.getRangeAt(0);
    range.deleteContents();
    escapeDelAtCaret(range);
    const host = markWrapping(range.startContainer, 'ins.md-pending-ins');
    const tn = document.createTextNode(text.replace(/\s/g, ' '));
    if (host) { range.insertNode(tn); }
    else { const el = document.createElement('ins'); el.className = 'md-pending-ins'; el.appendChild(tn); range.insertNode(el); }
    collapseCaret(tn, tn.length);
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

  return { strikeInBlock, escapeDelAtCaret, insertMarkedInBlock, insertLineBreakInBlock };
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
  serializeMarkedBlock,
  overlayToEnvelope,
  wrapEditEnvelope,
  parseEditEnvelope,
  buildEnvelopeDiffNode,
};
