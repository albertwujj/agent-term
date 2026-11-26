// Commit-message editing on a review page — the md viewer's "edit is a
// comment" model on the review surface (docs/dev/maintainer/md-editing-design.md; marks semantics
// in agent-threads/md/user-intent.md). The commit section is a frozen render
// regenerated from git, so a user edit is a pure suggestion: strike-in-place
// marks over the rendered text, committed as an [Edit] thread in the review
// store with a region anchor. The agent amends the commit message; the regen
// shows the result. Nothing here writes anything — the host's io does.
//
// Clicks on the commit blocks (.commit-subject and the .commit-body
// paragraphs) follow the md viewer's rules (md-editing-design.md "Click,
// caret and highlight"): a click on a word arms the block for a comment (the
// comment yellow, no caret), and any character typed then opens a comment on
// the whole block (io.openBlockComment). A click on the space between two
// words, or after the last one, opens the editor with a block caret there,
// and one on a reopenable edit's own marks reopens it at the click. Over a
// selection inside one commit block, ⌫ strikes the selection and punctuation
// or Space types over it; letters are the page's quote comment. While
// editing the unit is the word (edit-marks.js, word-level editing): ⌫/Delete
// take one, arrows move one, the caret rests after a word. Esc reverts,
// Enter commits + sends, Shift+Enter breaks the line, ⌘Z steps back, ⌘E or
// To comment hands the typed words to a comment, and clicking away commits
// without sending (the review surface's composer rule).
//
// Electron-free: the host supplies IO; esbuild bundles this into the preload.

const { createComposer, normWS, toPromptAction, modKeyLabel, isModKey } = require('./comment-ui');
const { threadHasBeenResolved } = require('./agent-journal');
const {
  isPlainCommentKey,
  isEditEntryKey,
  createMarkEngine,
  gapCharAtPoint,
  blockEndAtPoint,
  settleGapInsertions,
  serializeMarkedBlock,
  overlayToEnvelope,
  wrapEditEnvelope,
  parseEditEnvelope,
} = require('./edit-marks');
const { snapRangeToWords } = require('./word-snap');

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

  function disarm() {
    if (armed && armed.block) armed.block.classList.remove('rv-edit-armed');
    armed = null;
  }

  // A key typed on an armed block opens a comment on the whole block; noted
  // so that comment offers no To edit (a whole block has no spot to edit at).
  // Any click forgets it.
  let blockComment = null;

  // The gap under (x, y) as a text offset: just before the space between two
  // words, or after the block's last word. Null elsewhere.
  function gapOffsetIn(block, x, y) {
    const gap = gapCharAtPoint(block, x, y);
    if (gap) return textOffsetIn(block, gap.node, gap.index);
    const end = blockEndAtPoint(block, x, y);
    return end ? textOffsetIn(block, end.node, end.offset) : null;
  }

  // ——— arming: a click on a commit block's words arms it for a comment ———
  function onDocClick(event) {
    if (session) return; // session has its own click-away handling
    const t = event.target;
    if (!t || !t.closest) { disarm(); return; }
    if (t.closest(OVERLAY_SEL)) return; // clicks in overlay UI never disarm-toggle
    blockComment = null;
    const block = t.closest(COMMIT_BLOCK_SEL);
    // A decorated block arms only while its edit is revisitable (pending and
    // wholly the user's); sent or agent-touched edits stay sealed.
    if (!block || (block.classList.contains('rv-edit-decorated') && !revisitInfo.has(block))) { disarm(); return; }
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel)) { disarm(); armed = { block }; return; } // the selection is the target
    // What's under the pointer picks the state: the user's own mark reopens
    // the edit at the click; a gap between two words (or after the last one)
    // opens the editor there; a word arms the block for a comment.
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(event.clientX, event.clientY);
    const at = range && block.contains(range.startContainer) ? textOffsetIn(block, range.startContainer, range.startOffset) : null;
    const onMark = !!t.closest('del.md-pending-del, ins.md-pending-ins');
    const gapAt = !onMark && event.detail <= 1 ? gapOffsetIn(block, event.clientX, event.clientY) : null;
    disarm();
    if (onMark || gapAt != null) {
      openSession(block, null, gapAt != null ? gapAt : at, null);
      if (session) {
        if (gapAt != null) {
          session.gapOpened = true;
          showGapCaret(gapAt);
        } else {
          restBetweenWords(engine.settleCaretAfterWord(session.block)); // your own word
        }
        return;
      }
    }
    armed = { block };
    block.classList.add('rv-edit-armed');
  }

  // ——— dispatch + session keys ———
  function onKeydownCapture(event) {
    if (session) { onSessionKey(event); return; }
    if (io.composerBlocked && io.composerBlocked()) return;
    const t = event.target;
    const tag = t && t.tagName ? t.tagName.toUpperCase() : '';
    if (tag === 'TEXTAREA' || tag === 'INPUT' || (t && t.isContentEditable)) return;

    // Selection inside ONE commit block: ⌫ strikes it as an edit; punctuation
    // or Space types over it. Letters and digits are the page's: its quote
    // comment takes the selection.
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel)) {
      const k = event.key;
      if (isEditEntryKey(event) && (k === 'Backspace' || k === 'Delete' || (typeof k === 'string' && [...k].length === 1))) {
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

    // An armed block holds no caret: every typed character opens a comment on
    // the whole block.
    if (!armed || !armed.block || !document.body.contains(armed.block)) return;
    if (isPlainCommentKey(event) && event.key !== ' ') {
      event.preventDefault();
      event.stopPropagation();
      const block = armed.block;
      disarm();
      blockComment = block;
      if (io.openBlockComment) io.openBlockComment(block, event.key);
    }
  }

  function enclosingCommitBlock(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el && el.closest ? el.closest(COMMIT_BLOCK_SEL) : null;
  }

  // ——— the edit session ———
  function pushUndo() {
    if (!session || session.undoLatch) return;
    session.undoLatch = true;
    queueMicrotask(() => { if (session) { session.undoLatch = false; syncToComment(); } });
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
    clearGapCaret();
    session.block.innerHTML = snap.html;
    try { session.block.focus({ preventScroll: true }); } catch {}
    setCaret(session.block, snap.caret);
    restBetweenWords(caretOffsetIn(session.block));
    syncToComment();
  }

  function cleanTextOf(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent;
  }

  // entryText: a comment's words moving in by To edit; they enter as those
  // keystrokes would have (over the selection, or at the caret).
  function openSession(block, entryEvent, caretOffset, entrySelection, entryText = null) {
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
    disarm();
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
      // What To comment needs: the selection the editor opened on (its text
      // and offsets).
      entrySelection: null,
      gapCaret: null,
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
    enterSession(session, block, entryEvent, caretOffset, entrySelection, entryText);
    syncToComment();
  }

  function enterSession(sess, block, entryEvent, caretOffset, entrySelection, entryText) {
    const k = entryEvent ? entryEvent.key : '';
    const typed = typeof entryText === 'string';
    if (entrySelection) {
      sess.entrySelection = {
        text: entrySelection.toString(),
        start: textOffsetIn(block, entrySelection.startContainer, entrySelection.startOffset),
        end: textOffsetIn(block, entrySelection.endContainer, entrySelection.endOffset),
      };
      if (typed) {
        if (entryText) {
          engine.strikeInBlock(block, entrySelection, 'after');
          engine.insertAtGap(entryText, block);
        } else {
          // The bare switch: the selection comes back live, ready to type over.
          const s = window.getSelection && window.getSelection();
          if (s) { s.removeAllRanges(); s.addRange(entrySelection); }
        }
        return;
      }
      if (k === 'Backspace' || k === 'Delete') {
        engine.eraseInBlock(block, entrySelection, { backward: k === 'Backspace', selection: true, repeat: !!entryEvent.repeat });
        restBetweenWords(caretOffsetIn(block));
        return;
      }
      // Typed over, the selection strikes and your words come in as their
      // own word after it.
      engine.strikeInBlock(block, entrySelection, 'after');
      engine.insertAtGap(k, block);
      return;
    }
    const max = block.textContent.length; // current content: marks included on a revisit
    const caret = Math.max(0, Math.min(caretOffset != null ? caretOffset : max, max));
    if (typed) {
      setCaret(block, caret);
      engine.insertAtGap(entryText, block);
      return;
    }
    if (!entryEvent || k.startsWith('Arrow')) { setCaret(block, caret); return; }
    if (k === 'Backspace' || k === 'Delete') {
      setCaret(block, caret);
      engine.eraseWord(block, { backward: k === 'Backspace', repeat: !!entryEvent.repeat });
      restBetweenWords(caretOffsetIn(block));
    } else if (k === 'Enter') {
      setCaret(block, caret);
      engine.insertLineBreakInBlock();
    } else {
      setCaret(block, caret);
      engine.insertAtGap(k, block);
    }
  }

  // The editing surface: typing intercepted wholesale — deletes strike,
  // printables insert marked, structure never changes (edit-marks engine).
  function wireSurface(el) {
    const onPaste = (event) => {
      event.preventDefault();
      onSelectionChange(); // the block caret holds only where it was put
      const atGap = clearGapCaret();
      const text = event.clipboardData ? String(event.clipboardData.getData('text/plain') || '') : '';
      const s = window.getSelection && window.getSelection();
      const over = !!(s && s.rangeCount && !s.getRangeAt(0).collapsed);
      if (over) engine.strikeInBlock(el, s.getRangeAt(0), 'after');
      const flat = text.replace(/\s+/g, ' ');
      if (atGap || over) engine.insertAtGap(flat.trim(), el); else engine.insertMarkedInBlock(flat);
    };
    const onBeforeInput = (event) => {
      const t = event.inputType || '';
      // Any input ends the gap caret; text typed there makes its own word.
      onSelectionChange(); // the block caret holds only where it was put
      const atGap = clearGapCaret();
      if (t.indexOf('delete') === 0) {
        event.preventDefault();
        const s = window.getSelection();
        const wasSelection = !!(s && s.rangeCount && !s.getRangeAt(0).collapsed);
        // ⌫/Delete take a word (Option/Ctrl+⌫ too); a selection, and the
        // line deletes, keep the browser's span.
        if (!wasSelection && /^delete(Content|Word)(Backward|Forward)$/.test(t)) {
          if (engine.eraseWord(el, { backward: t.endsWith('Backward') })) restBetweenWords(caretOffsetIn(el));
          return;
        }
        const ranges = event.getTargetRanges ? event.getTargetRanges() : [];
        const sr = ranges && ranges[0];
        if (sr) {
          const r = document.createRange();
          r.setStart(sr.startContainer, sr.startOffset);
          r.setEnd(sr.endContainer, sr.endOffset);
          engine.eraseInBlock(el, r, { backward: t.indexOf('Forward') === -1, selection: wasSelection });
          restBetweenWords(caretOffsetIn(el));
        }
        return;
      }
      if (t === 'insertText' || t === 'insertReplacementText' || t === 'insertFromComposition') {
        event.preventDefault();
        // At the block caret, or over a selection, the text is a new word;
        // at the bar (you are typing) it extends your word.
        const s = window.getSelection();
        const over = !!(s && s.rangeCount && !s.getRangeAt(0).collapsed);
        if (over) engine.strikeInBlock(el, s.getRangeAt(0), 'after');
        if (atGap || over) engine.insertAtGap(event.data || '', el); else engine.insertMarkedInBlock(event.data || '');
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
    // Inside the live block too, a single click on a gap puts the gap caret
    // there; a click on a word rests the caret after it.
    const onClick = (event) => {
      if (event.detail > 1 || !session || session.block !== el) return;
      const s = window.getSelection && window.getSelection();
      if (s && s.rangeCount && !s.getRangeAt(0).collapsed) return;
      const gap = gapCharAtPoint(el, event.clientX, event.clientY);
      if (gap) { showGapCaret(textOffsetIn(el, gap.node, gap.index)); return; }
      clearGapCaret();
      restBetweenWords(engine.settleCaretAfterWord(el));
    };
    // A selection made inside the open edit covers whole words too.
    const onMouseup = () => setTimeout(() => {
      const s = window.getSelection && window.getSelection();
      if (!s || !s.rangeCount || s.isCollapsed) return;
      const range = s.getRangeAt(0);
      if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return;
      const snapped = snapRangeToWords(range, () => el);
      if (!snapped) return;
      s.removeAllRanges();
      s.addRange(snapped);
    }, 0);
    // The gap caret lives exactly as long as the caret stays at its gap.
    const onSelectionChange = () => {
      if (!session || !session.gapCaret) return;
      const s = window.getSelection && window.getSelection();
      const r = s && s.rangeCount ? s.getRangeAt(0) : null;
      const here = r && r.collapsed && el.contains(r.startContainer) ? textOffsetIn(el, r.startContainer, r.startOffset) : null;
      if (here !== session.gapCaret.offset) clearGapCaret();
    };
    el.addEventListener('paste', onPaste);
    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('click', onClick);
    el.addEventListener('mouseup', onMouseup);
    document.addEventListener('selectionchange', onSelectionChange);
    el.setAttribute('contenteditable', 'true');
    el.spellcheck = true;
    el.classList.add('md-rendered-editing');
    return () => {
      el.removeEventListener('paste', onPaste);
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeEventListener('click', onClick);
      el.removeEventListener('mouseup', onMouseup);
      document.removeEventListener('selectionchange', onSelectionChange);
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
      onInput: (ctx) => { sess.note = ctx.textarea.value; syncToComment(); },
      actions: [
        // Revert drops the whole edit, a reopened one included (its thread is
        // discarded); Esc backs out of this session only.
        { label: 'Revert', onClick: () => revertWhole() },
        {
          // A revisit updates a thread that is already in the send tally; a
          // fresh edit adds one. The host resolves which from the id.
          label: (io.sendLabel && io.sendLabel(sess.revisit ? sess.revisit.threadId : null)) || 'Send',
          title: 'Enter',
          primary: true,
          onClick: () => commit(true),
        },
        toPromptAction(() => commit(true, { toPrompt: true })),
        // The mirror of the comment's To edit, present only while the edit is
        // one a comment could have made (syncToComment).
        {
          label: 'To comment',
          key: 'e',
          shortcut: modKeyLabel('e'),
          title: 'Take what you typed out of the message into a comment',
          onClick: () => toComment(),
        },
      ],
    });
    sess.toCommentButton = Array.from(composer.root.querySelectorAll('.cu-btn'))
      .find((b) => b.textContent.startsWith('To comment')) || null;
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
      // At a fresh gap caret Enter breaks the line there, as a first key on
      // an armed block does; once anything is done it sends.
      const fresh = !(session.undoStack && session.undoStack.length);
      const atGap = clearGapCaret() && fresh;
      if (event.shiftKey || atGap) engine.insertLineBreakInBlock();
      else commit(true);
      return;
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.metaKey && !event.ctrlKey) {
      // The caret moves a word at a time (Shift: the selection grows by words).
      event.preventDefault();
      event.stopPropagation();
      const backward = event.key === 'ArrowLeft';
      if (event.shiftKey) engine.extendByWord(session.block, backward);
      else {
        clearGapCaret();
        restBetweenWords(engine.moveByWord(session.block, backward));
      }
      return;
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      // The line move is the browser's; the caret then rests after the word
      // it landed in.
      const sess = session;
      setTimeout(() => {
        if (session !== sess) return;
        clearGapCaret();
        restBetweenWords(engine.settleCaretAfterWord(sess.block));
      }, 0);
      return;
    }
    if (isModKey(event, 'e')) {
      event.preventDefault();
      event.stopPropagation();
      toComment();
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
    // A double-click on a commit block selects its paragraph for a comment.
    // Its first click, at a word's edge, may have opened this editor at the
    // gap; while nothing has been typed, the second press ends the edit and
    // the page's double-click takes over.
    if (event.detail >= 2 && session.gapOpened && session.block.contains(t)
      && !session.undoStack.length && !(session.note || '').trim()) {
      revert();
      return;
    }
    if (session.block.contains(t)) return;
    if (session.composerWrap && session.composerWrap.contains(t)) return;
    commit(false);
  }

  function teardown(restoreHtml) {
    if (!session) return;
    clearGapCaret();
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

  // Revert on the strip: the whole edit goes. A reopened edit's thread is
  // discarded, as Revert drops a reopened edit in the md viewer.
  function revertWhole() {
    if (!session) return;
    const sess = session;
    if (!sess.revisit) { revert(); return; }
    teardown(sess.cleanHtml);
    if (io.discardThread) io.discardThread(sess.revisit.threadId);
  }

  // ——— the gap caret: the native caret just before the space, drawn as a
  // block (caret-shape) over exactly the space it will type into (md viewer's
  // showGapCaret) ———
  function showGapCaret(offset) {
    clearGapCaret();
    if (!session) return;
    const block = session.block;
    if (!engine.isBetweenWords(block, offset)) return;
    setCaret(block, offset);
    block.classList.add('md-gap-caret');
    session.gapCaret = { offset };
  }

  // A caret at rest sits between words and is the block caret: typing there
  // makes a new word with its own spaces. Only while you type is it the bar,
  // extending your word.
  function restBetweenWords(offset) {
    if (!session || offset == null) return;
    showGapCaret(offset);
  }

  function caretOffsetIn(el) {
    const s = window.getSelection && window.getSelection();
    if (!s || !s.rangeCount || !el.contains(s.focusNode)) return null;
    return textOffsetIn(el, s.focusNode, s.focusOffset);
  }

  // Ends the gap caret; true when there was one (the key that ended it acts
  // at the gap).
  function clearGapCaret() {
    const open = !!(session && session.gapCaret);
    if (session) session.gapCaret = null;
    for (const el of document.querySelectorAll('#commit .md-gap-caret')) el.classList.remove('md-gap-caret');
    return open;
  }

  // ——— To comment / To edit: words move between an edit and a comment ———
  function outerInsertions(block) {
    return Array.from(block.querySelectorAll('ins.md-pending-ins'))
      .filter((ins) => !(ins.parentElement && ins.parentElement.closest('ins.md-pending-ins')));
  }

  // An edit converts while it is one a comment could have made: text typed at
  // one spot or over the selection it opened on, as a new edit, with no note.
  // So To edit and To comment undo each other; anything more would be dropped.
  function convertsToComment(sess) {
    if (!sess || sess.revisit || (sess.note && sess.note.trim())) return false;
    const inss = outerInsertions(sess.block);
    if (inss.length > 1) return false;
    const dels = Array.from(sess.block.querySelectorAll('del.md-pending-del'));
    if (!dels.length) return true;
    if (!sess.entrySelection) return false;
    try {
      const span = document.createRange();
      span.setStartBefore(dels[0]);
      span.setEndAfter(dels[dels.length - 1]);
      if (span.toString() !== sess.entrySelection.text) return false;
      if (!inss.length) return true;
      const FOLLOWING = (window.Node && window.Node.DOCUMENT_POSITION_FOLLOWING) || 4;
      if (!(dels[dels.length - 1].compareDocumentPosition(inss[0]) & FOLLOWING)) return false;
      const between = document.createRange();
      between.setStartAfter(dels[dels.length - 1]);
      between.setEndBefore(inss[0]);
      return between.toString() === '';
    } catch {
      return false;
    }
  }

  function syncToComment() {
    if (session && session.toCommentButton) session.toCommentButton.hidden = !convertsToComment(session);
  }

  // To comment: the typed words leave the message and open as a comment, on
  // the selection the editor struck or else on the whole block.
  function toComment() {
    const sess = session;
    if (!convertsToComment(sess)) return;
    const inss = outerInsertions(sess.block);
    const text = inss.length ? inss[0].textContent.trim() : '';
    const struck = !!sess.block.querySelector('del.md-pending-del');
    const { block, entrySelection } = sess;
    revert();
    let range = null;
    if (struck && entrySelection) {
      const a = caretAt(block, entrySelection.start);
      const b = caretAt(block, entrySelection.end);
      if (a && b) {
        range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
      }
    } else {
      blockComment = block;
    }
    if (io.openBlockComment) io.openBlockComment(block, text, range);
  }

  // The commit block a quote can become an edit in: a selection inside one
  // block. A comment on a whole armed block has nowhere to edit at.
  function blockForRange(range) {
    if (!range) return null;
    const a = enclosingCommitBlock(range.startContainer);
    if (!a || a !== enclosingCommitBlock(range.endContainer) || a === blockComment) return null;
    return a;
  }

  // To edit from the quote composer: the words type over the quoted text.
  function editFromComment(range, text) {
    const block = blockForRange(range);
    if (!block || session) return false;
    disarm();
    const r = range.cloneRange();
    if (!block.contains(r.startContainer)) r.setStart(block, 0);
    if (!block.contains(r.endContainer)) r.setEnd(block, block.childNodes.length);
    openSession(block, null, null, r, text);
    return !!session;
  }

  // Over a gap the pointer turns amber, so a click's meaning shows before it.
  let gapHoverRaf = 0;
  let gapHoverAt = null;
  function onGapHover(event) {
    gapHoverAt = { x: event.clientX, y: event.clientY, el: event.target };
    if (gapHoverRaf) return;
    gapHoverRaf = requestAnimationFrame(() => {
      gapHoverRaf = 0;
      const p = gapHoverAt;
      const block = p && p.el && p.el.closest ? p.el.closest(COMMIT_BLOCK_SEL) : null;
      const editable = block && (!block.classList.contains('rv-edit-decorated') || revisitInfo.has(block));
      document.body.classList.toggle('rv-gap-hover', !!(editable && gapOffsetIn(block, p.x, p.y) != null));
    });
  }

  function commit(alsoSend, { toPrompt = false } = {}) {
    if (!session) return;
    const sess = session;
    clearGapCaret();
    settleGapInsertions(sess.block);
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
  // An unfinished [Edit] thread whose original text still matches a commit
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
      if (threadHasBeenResolved(t)) continue;
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
    document.addEventListener('mousemove', onGapHover);
  }

  return {
    bind,
    decorateEditThreads,
    decoratedBlockFor: (threadId) => decoratedState.get(threadId) || null,
    isEditing: () => !!session,
    blockForRange,
    editFromComment,
  };
}

module.exports = { createCommitEditController, COMMIT_BLOCK_SEL };
