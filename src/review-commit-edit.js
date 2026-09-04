// Commit-message editing on a review page — the md viewer's "edit is a
// comment" model on the review surface (docs/dev/maintainer/md-editing-design.md; marks semantics
// in agent-threads/md/user-intent.md). The commit section is a frozen render
// regenerated from git, so a user edit is a pure suggestion: strike-in-place
// marks over the rendered text, committed as an [Edit] thread in the review
// store with a region anchor. The agent amends the commit message; the regen
// shows the result. Nothing here writes anything — the host's io does.
//
// First-key dispatch, scoped to the commit blocks (.commit-subject and the
// .commit-body paragraphs): a click arms the block and holds a blinking caret;
// letters keep the comment path (io.openBlockComment); every other unmodified
// key opens the block editor at the caret with the keystroke applied. A
// selection inside one commit block routes edit keys the same way (⌫ strikes
// the selection; a non-letter printable types over it). While editing: Esc
// reverts, Enter commits + sends, Shift+Enter breaks the line, ⌘Z steps back,
// clicking away commits without sending (the review surface's composer rule).
//
// Electron-free: the host supplies IO; esbuild bundles this into the preload.

const { createComposer, normWS , toPromptAction } = require('./comment-ui');
const {
  isCommentEntryKey,
  isEditEntryKey,
  createMarkEngine,
  serializeMarkedBlock,
  overlayToEnvelope,
  wrapEditEnvelope,
  parseEditEnvelope,
} = require('./edit-marks');

const COMMIT_BLOCK_SEL = '#commit .commit-subject, #commit .commit-body p';
const OVERLAY_SEL = '.rv-thread, .rv-quote-thread, .rv-filehdr-thread, .rv-row, '
  + '.rv-compose-row, .rv-quote-compose, .cu-composer, .rv-replybox, .rv-edit-compose';

// Text offset of (node, offset) within root, and back — the minimal caret
// bookkeeping the session needs (undo restore, entry-caret placement). The md
// viewer has a richer shared model; commit blocks are plain text, so a bare
// text-node walk is exact.
function textOffsetIn(root, node, offset) {
  if (node && node.nodeType === 1) {
    // Element position: the boundary before its offset-th child.
    let acc = 0;
    const kids = node.childNodes;
    for (let i = 0; i < Math.min(offset, kids.length); i++) acc += kids[i].textContent.length;
    return textOffsetInPrefix(root, node) + acc;
  }
  const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
  const walker = document.createTreeWalker(root, SHOW_TEXT, null);
  let sum = 0; let n;
  while ((n = walker.nextNode())) {
    if (n === node) return sum + offset;
    sum += n.data.length;
  }
  return sum;
}

// Total text length of everything before `el` inside root.
function textOffsetInPrefix(root, el) {
  const r = document.createRange();
  r.selectNodeContents(root);
  try { r.setEndBefore(el); } catch { return 0; }
  return r.toString().length;
}

function caretAt(root, offset) {
  const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
  const walker = document.createTreeWalker(root, SHOW_TEXT, null);
  let remaining = Math.max(0, offset); let n; let lastNode = null;
  while ((n = walker.nextNode())) {
    lastNode = n;
    if (remaining <= n.data.length) return { node: n, offset: remaining };
    remaining -= n.data.length;
  }
  return lastNode ? { node: lastNode, offset: lastNode.data.length } : null;
}

function setCaret(root, offset) {
  const at = caretAt(root, offset);
  const sel = window.getSelection && window.getSelection();
  if (!at || !sel) return;
  try {
    const range = document.createRange();
    range.setStart(at.node, at.offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {}
}

function createCommitEditController(io) {
  // io: {
  //   addEditThread({anchor, body, note, alsoSend}) -> Promise<{success,...}>,
  //   updateEditThread({threadId, body, note, alsoSend}) -> Promise<{success,...}>,
  //   discardThread(threadId) -> Promise (or undefined),
  //   sendPending({toPrompt}),   // flush pending threads; no-op when none
  //   openBlockComment(block, seedKey),
  //   composerBlocked() -> bool,
  //   sendLabel(revisitThreadId|null) -> string,   // null = this edit is new
  //   threadNeedsSend(thread) -> bool,   // pending (amber) vs sent (slate) marks
  //   threadWhollyUnsent(thread) -> bool, // gate for revisit/dissolve-discard
  //   onToast(msg),
  //   platform,
  // }
  let armed = null;   // { block } — clicked commit block, caret span in place
  // The session. baseHtml is what Esc restores (for a revisit: the marked
  // state at open); cleanHtml is the un-marked original the block returns to
  // on commit, when the store becomes the single truth again; origText is the
  // clean text the anchor quotes. `revisit` carries the stored thread being
  // re-entered.
  let session = null;
  // Blocks currently decorated from stored edit threads: el -> original innerHTML.
  const decorated = new Map();
  let decoratedState = new Map(); // threadId -> block (this render pass)
  // Pending edits still wholly the user's (open, every message user-authored):
  // clicking back into the block re-enters the edit — an accidental click-away
  // must not cost a discard-and-retype. block -> { threadId, cleanHtml, note }.
  const revisitInfo = new Map();

  const engine = createMarkEngine({ beforeMutate: () => pushUndo() });

  function commitBlocks() {
    return Array.from(document.querySelectorAll(COMMIT_BLOCK_SEL));
  }

  function caretSpan() { return document.querySelector('span.rv-edit-caret'); }
  function clearCaretSpan() {
    const s = caretSpan();
    if (s && s.parentNode) { const p = s.parentNode; s.remove(); p.normalize(); }
  }

  function disarm() {
    clearCaretSpan();
    armed = null;
  }

  // ——— arming: a click in a commit block holds the caret ———
  function onDocClick(event) {
    if (session) return; // session has its own click-away handling
    const t = event.target;
    if (!t || !t.closest) { disarm(); return; }
    if (t.closest(OVERLAY_SEL)) return; // clicks in overlay UI never disarm-toggle
    const block = t.closest(COMMIT_BLOCK_SEL);
    // A decorated block arms only while its edit is revisitable (pending and
    // wholly the user's); sent or agent-touched edits stay sealed.
    if (!block || (block.classList.contains('rv-edit-decorated') && !revisitInfo.has(block))) { disarm(); return; }
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel)) { disarm(); armed = { block }; return; } // selection path: no caret span
    disarm();
    armed = { block };
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(event.clientX, event.clientY);
    const span = document.createElement('span');
    span.className = 'rv-edit-caret';
    if (range && block.contains(range.startContainer)) {
      range.collapse(true);
      range.insertNode(span);
    } else {
      block.appendChild(span);
    }
  }

  // ——— dispatch + session keys ———
  function onKeydownCapture(event) {
    if (session) { onSessionKey(event); return; }
    if (io.composerBlocked && io.composerBlocked()) return;
    const t = event.target;
    const tag = t && t.tagName ? t.tagName.toUpperCase() : '';
    if (tag === 'TEXTAREA' || tag === 'INPUT' || (t && t.isContentEditable)) return;

    // Selection inside ONE commit block: ⌫ strikes it as an edit; a non-letter
    // printable types over it. Letters keep the quote-comment path untouched.
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel) && isEditEntryKey(event)) {
      const k = event.key;
      if (k === 'Backspace' || k === 'Delete' || (typeof k === 'string' && [...k].length === 1)) {
        const range = sel.rangeCount ? sel.getRangeAt(0) : null;
        const block = range && enclosingCommitBlock(range.commonAncestorContainer);
        if (block && block.contains(range.startContainer) && block.contains(range.endContainer)) {
          event.preventDefault();
          event.stopPropagation();
          openSession(block, event, null, range);
          return;
        }
      }
      return;
    }

    if (!armed || !armed.block || !document.body.contains(armed.block)) return;
    if (isCommentEntryKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      const block = armed.block;
      disarm();
      if (io.openBlockComment) io.openBlockComment(block, event.key);
      return;
    }
    if (isEditEntryKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      openSession(armed.block, event, armedCaretOffset(), null);
    }
  }

  function enclosingCommitBlock(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el && el.closest ? el.closest(COMMIT_BLOCK_SEL) : null;
  }

  function armedCaretOffset() {
    const span = caretSpan();
    if (!span || !armed || !armed.block) return null;
    return textOffsetInPrefix(armed.block, span);
  }

  // ——— the edit session ———
  function pushUndo() {
    if (!session || session.undoLatch) return;
    session.undoLatch = true;
    queueMicrotask(() => { if (session) session.undoLatch = false; });
    const sel = window.getSelection && window.getSelection();
    let caret = 0;
    if (sel && sel.rangeCount && session.block.contains(sel.getRangeAt(0).startContainer)) {
      const r = sel.getRangeAt(0);
      caret = textOffsetIn(session.block, r.startContainer, r.startOffset);
    }
    session.undoStack.push({ html: session.block.innerHTML, caret });
    session.redoStack = [];
  }

  function undoStep(redo) {
    if (!session) return;
    const from = redo ? session.redoStack : session.undoStack;
    if (!from.length) return;
    const to = redo ? session.undoStack : session.redoStack;
    const sel = window.getSelection && window.getSelection();
    let caret = 0;
    if (sel && sel.rangeCount && session.block.contains(sel.getRangeAt(0).startContainer)) {
      const r = sel.getRangeAt(0);
      caret = textOffsetIn(session.block, r.startContainer, r.startOffset);
    }
    to.push({ html: session.block.innerHTML, caret });
    const snap = from.pop();
    session.block.innerHTML = snap.html;
    try { session.block.focus({ preventScroll: true }); } catch {}
    setCaret(session.block, snap.caret);
  }

  function cleanTextOf(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent;
  }

  function openSession(block, entryEvent, caretOffset, entrySelection) {
    if (session) return;
    const revisit = revisitInfo.get(block) || null;
    if (block.classList.contains('rv-edit-decorated') && !revisit) {
      disarm();
      if (io.onToast) {
        io.onToast(block.classList.contains('rv-edit-pending')
          ? 'This edit has agent replies — follow up on its card'
          : 'This edit is sent — awaiting the agent');
      }
      return;
    }
    clearCaretSpan();
    armed = null;
    if (io.onEditStart) io.onEditStart(); // host hides its quote chip/highlight
    block.normalize();
    session = {
      block,
      revisit,
      baseHtml: block.innerHTML, // Esc target: for a revisit, the marked state
      cleanHtml: revisit ? revisit.cleanHtml : block.innerHTML,
      origText: revisit ? cleanTextOf(revisit.cleanHtml) : block.textContent,
      note: revisit ? (revisit.note || '') : '',
      undoStack: [],
      redoStack: [],
      undoLatch: false,
    };
    if (revisit) {
      // The session owns the block now; the decoration pass must not restore
      // over live typing, and the block sheds its sealed look while editable.
      decorated.delete(block);
      revisitInfo.delete(block);
      block.classList.remove('rv-edit-decorated', 'rv-edit-pending', 'rv-edit-revisitable');
    }
    session.unwire = wireSurface(block);
    attachStrip(session, block);
    try { block.focus({ preventScroll: true }); } catch {}

    const k = entryEvent ? entryEvent.key : '';
    if (entrySelection) {
      engine.strikeInBlock(block, entrySelection, 'after');
      if (k !== 'Backspace' && k !== 'Delete') engine.insertMarkedInBlock(k);
      return;
    }
    const max = block.textContent.length; // current content: marks included on a revisit
    const caret = Math.max(0, Math.min(caretOffset != null ? caretOffset : max, max));
    if (!entryEvent || k.startsWith('Arrow')) { setCaret(block, caret); return; }
    if (k === 'Backspace') {
      if (caret > 0) {
        const a = caretAt(block, caret - 1), b = caretAt(block, caret);
        if (a && b) {
          const r = document.createRange();
          r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset);
          engine.strikeInBlock(block, r, 'before');
        }
      } else setCaret(block, 0);
    } else if (k === 'Delete') {
      const a = caretAt(block, caret), b = caretAt(block, caret + 1);
      if (a && b && (a.node !== b.node || a.offset !== b.offset)) {
        const r = document.createRange();
        r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset);
        engine.strikeInBlock(block, r, 'after');
      } else setCaret(block, caret);
    } else if (k === 'Enter') {
      setCaret(block, caret);
      engine.insertLineBreakInBlock();
    } else {
      setCaret(block, caret);
      engine.insertMarkedInBlock(k);
    }
  }

  // The editing surface: typing intercepted wholesale — deletes strike,
  // printables insert marked, structure never changes (edit-marks engine).
  function wireSurface(el) {
    const onPaste = (event) => {
      event.preventDefault();
      const text = event.clipboardData ? String(event.clipboardData.getData('text/plain') || '') : '';
      const s = window.getSelection && window.getSelection();
      if (s && s.rangeCount && !s.getRangeAt(0).collapsed) engine.strikeInBlock(el, s.getRangeAt(0), 'after');
      engine.insertMarkedInBlock(text.replace(/\s+/g, ' '));
    };
    const onBeforeInput = (event) => {
      const t = event.inputType || '';
      if (t.indexOf('delete') === 0) {
        event.preventDefault();
        const s = window.getSelection();
        const wasSelection = !!(s && s.rangeCount && !s.getRangeAt(0).collapsed);
        const ranges = event.getTargetRanges ? event.getTargetRanges() : [];
        const sr = ranges && ranges[0];
        if (sr) {
          const r = document.createRange();
          r.setStart(sr.startContainer, sr.startOffset);
          r.setEnd(sr.endContainer, sr.endOffset);
          engine.strikeInBlock(el, r, wasSelection ? 'after' : (t.indexOf('Forward') !== -1 ? 'after' : 'before'));
        }
        return;
      }
      if (t === 'insertText' || t === 'insertReplacementText' || t === 'insertFromComposition') {
        event.preventDefault();
        const s = window.getSelection();
        if (s && s.rangeCount && !s.getRangeAt(0).collapsed) engine.strikeInBlock(el, s.getRangeAt(0), 'after');
        engine.insertMarkedInBlock(event.data || '');
        return;
      }
      // no new blocks, no formatting, no native undo (it can't see our marks)
      if (t.startsWith('format') || t === 'insertParagraph' || t === 'insertLineBreak'
        || t === 'insertFromDrop' || t === 'insertHorizontalRule'
        || t === 'insertOrderedList' || t === 'insertUnorderedList'
        || t === 'historyUndo' || t === 'historyRedo') {
        event.preventDefault();
      }
    };
    el.addEventListener('paste', onPaste);
    el.addEventListener('beforeinput', onBeforeInput);
    el.setAttribute('contenteditable', 'true');
    el.spellcheck = true;
    el.classList.add('md-rendered-editing');
    return () => {
      el.removeEventListener('paste', onPaste);
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeAttribute('contenteditable');
      el.classList.remove('md-rendered-editing');
    };
  }

  // The edit's one control (md's grammar): note textarea + Revert + Send under
  // the block. column-span:all in CSS so it escapes the commit body's columns.
  function attachStrip(sess, block) {
    const wrap = document.createElement('div');
    wrap.className = 'rv-edit-compose';
    const composer = createComposer({
      placeholder: 'Note for the agent about this edit...',
      seed: sess.note || '',
      rows: 2,
      onCancel: () => revert(),
      onInput: (ctx) => { sess.note = ctx.textarea.value; },
      actions: [
        { label: 'Revert', onClick: () => revert() },
        {
          // A revisit updates a thread that is already in the send tally; a
          // fresh edit adds one. The host resolves which from the id.
          label: (io.sendLabel && io.sendLabel(sess.revisit ? sess.revisit.threadId : null)) || 'Send',
          title: 'Enter',
          primary: true,
          onClick: () => commit(true),
        },
        toPromptAction(() => commit(true, { toPrompt: true })),
      ],
    });
    wrap.appendChild(composer.root);
    block.parentNode.insertBefore(wrap, block.nextSibling);
    sess.composerWrap = wrap;
    sess.composer = composer;
  }

  function onSessionKey(event) {
    if (!session) return;
    const inStrip = session.composerWrap && session.composerWrap.contains(event.target);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      revert();
      return;
    }
    if (inStrip) return; // the composer's own keydown handles Enter/Esc there
    const inBlock = session.block === event.target || session.block.contains(event.target);
    if (!inBlock) return;
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) engine.insertLineBreakInBlock();
      else commit(true);
      return;
    }
    const mod = io.platform === 'darwin' ? event.metaKey : event.ctrlKey;
    if (mod && !event.altKey && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      event.stopPropagation();
      undoStep(event.shiftKey);
    }
  }

  // Click-away commits the edit as a thread without sending — the review
  // composer rule ("moving away IS the no-send commit"). Capture phase so it
  // beats other handlers; clicks inside the block or its strip stay live.
  function onDocMousedownCapture(event) {
    if (!session) return;
    const t = event.target;
    if (session.block.contains(t)) return;
    if (session.composerWrap && session.composerWrap.contains(t)) return;
    commit(false);
  }

  function teardown(restoreHtml) {
    if (!session) return;
    const sess = session;
    session = null;
    if (sess.unwire) sess.unwire();
    if (sess.composerWrap) sess.composerWrap.remove();
    if (restoreHtml != null) sess.block.innerHTML = restoreHtml;
  }

  function revert() {
    if (!session) return;
    const sess = session;
    teardown(sess.baseHtml);
    if (sess.revisit) {
      // Back to the resting decorated state: the thread is untouched, so the
      // block is still its pending, revisitable decoration.
      decorated.set(sess.block, sess.cleanHtml);
      revisitInfo.set(sess.block, sess.revisit);
      sess.block.classList.add('rv-edit-decorated', 'rv-edit-pending', 'rv-edit-revisitable');
    }
  }

  function commit(alsoSend, { toPrompt = false } = {}) {
    if (!session) return;
    const sess = session;
    const hasMarks = !!sess.block.querySelector('del.md-pending-del, ins.md-pending-ins');
    const serialized = hasMarks ? serializeMarkedBlock(sess.block) : '';
    const inner = hasMarks ? overlayToEnvelope(serialized) : '';
    const marked = /<del>|<ins>/.test(inner);
    if (!marked) {
      // A revisit whose marks all dissolved IS the discard; a fresh session
      // with no marks was never an edit. Send still keeps its "Send all (n)"
      // promise: once the discard settles, the host flushes any threads
      // still pending (a no-op when nothing is).
      let done = null;
      if (sess.revisit) {
        teardown(sess.cleanHtml);
        if (io.discardThread) done = io.discardThread(sess.revisit.threadId);
      } else revert();
      if (alsoSend && io.sendPending) Promise.resolve(done).then(() => io.sendPending({ toPrompt }));
      return;
    }
    const body = wrapEditEnvelope(inner);
    const note = (sess.note || '').trim();
    // Restore the block first: the stored thread is the single truth, and the
    // decoration pass re-marks it from the store on the next render.
    teardown(sess.cleanHtml);
    const write = sess.revisit
      ? io.updateEditThread({ threadId: sess.revisit.threadId, body, note, alsoSend: !!alsoSend, toPrompt })
      : io.addEditThread({
          anchor: {
            path: '(commit message)',
            snippet: normWS(sess.origText).slice(0, 600),
            context: '',
            wholeBlock: true,
            heading: 'Commit message',
          },
          body, note, alsoSend: !!alsoSend, toPrompt,
        });
    Promise.resolve(write).then((res) => {
      if (!res || !res.success) {
        if (io.onToast) io.onToast((res && res.error) || 'Could not save edit');
      }
    });
  }

  // ——— rendering stored edit threads in place ———
  // An unresolved [Edit] thread whose original text still matches a commit
  // block re-strikes that block: text+del segments must reproduce the block
  // verbatim (commit blocks are plain text, so the reconstruction is exact).
  // Pending (un-sent) edits wear the amber/rose marks; sent ones slate.
  function decorateEditThreads(threads) {
    for (const [el, html] of decorated) {
      el.innerHTML = html;
      el.classList.remove('rv-edit-decorated', 'rv-edit-pending', 'rv-edit-waiting', 'rv-edit-revisitable');
    }
    decorated.clear();
    decoratedState = new Map();
    revisitInfo.clear();
    const blocks = commitBlocks();
    for (const t of (threads || [])) {
      if ((t.status || 'open') === 'resolved') continue;
      if (t.anchor_status === 'lost') continue;
      const first = t.messages && t.messages[0];
      if (!first || (first.author || 'user') !== 'user') continue;
      const parsed = parseEditEnvelope(first.body);
      if (!parsed || parsed.kind !== 'merged') continue;
      const original = parsed.segments
        .filter((s) => s.kind !== 'ins')
        .map((s) => s.text).join('');
      const block = blocks.find((b) => !decorated.has(b)
        && (!session || session.block !== b)
        && normWS(b.textContent) === normWS(original));
      if (!block) continue;
      const cleanHtml = block.innerHTML;
      decorated.set(block, cleanHtml);
      const pending = !io.threadNeedsSend || io.threadNeedsSend(t);
      const userOnly = (t.messages || []).every((m) => (m.author || 'user') === 'user');
      block.textContent = '';
      for (const seg of parsed.segments) {
        if (seg.kind === 'text') block.append(document.createTextNode(seg.text));
        else {
          const el = document.createElement(seg.kind === 'del' ? 'del' : 'ins');
          el.className = seg.kind === 'del'
            ? (pending ? 'md-pending-del' : 'md-sent-del')
            : (pending ? 'md-pending-ins' : 'md-sent-ins');
          el.textContent = seg.text;
          block.appendChild(el);
        }
      }
      block.classList.add('rv-edit-decorated', pending ? 'rv-edit-pending' : 'rv-edit-waiting');
      // Pending and wholly the user's → clicking back in re-enters the edit.
      // The note seeds only from the two-message shape (envelope + note);
      // follow-up comments are conversation, not the note.
      //
      // Revisit (and its dissolve-is-discard exit) only while the thread is
      // wholly un-sent — the same rule Discard follows everywhere, enforced
      // store-side too. A SENT edit still pending after a relaunch is amber
      // (pending) but sealed: a send covered it, so re-entering it in place
      // would rewrite words the agent has; a follow-up is the vehicle there.
      const whollyUnsent = io.threadWhollyUnsent ? io.threadWhollyUnsent(t) : (pending && userOnly);
      if (pending && userOnly && whollyUnsent) {
        block.classList.add('rv-edit-revisitable');
        revisitInfo.set(block, {
          threadId: t.id,
          cleanHtml,
          note: (t.messages || []).length === 2 ? String(t.messages[1].body || '') : '',
        });
      }
      decoratedState.set(t.id, block);
    }
    return decoratedState;
  }

  function bind() {
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeydownCapture, true);
    document.addEventListener('mousedown', onDocMousedownCapture, true);
  }

  return {
    bind,
    decorateEditThreads,
    decoratedBlockFor: (threadId) => decoratedState.get(threadId) || null,
    isEditing: () => !!session,
  };
}

module.exports = { createCommitEditController, COMMIT_BLOCK_SEL };
