// Webview preload for the embedded web viewer — runs INSIDE the guest page.
//
// On a review page (<body data-review>), it renders the inline comment
// overlay and drives the interactive compose/reply/resolve flow. It is the
// page→main bridge: the injected-from-host model (executeJavaScript) can't do
// IPC from the page's main world, so this preload owns the overlay end-to-end
// and talks to main directly via ipcRenderer. Main remains the SOLE writer of
// the <slug>-comments.json store (read-modify-write); this only sends deltas
// and re-renders from the snapshot main returns.
//
// This is the full AgentTerm-review preload. Ordinary web pages use the much
// smaller web-viewer-remote-preload.js entry point instead; the body guard
// below remains as defense in depth if a page is ever routed incorrectly.
//
// Thread-state model is the md viewer's: needs-send / awaiting-agent /
// back-to-user / resolved, with the agent owning `resolved`. The encodings of
// the sent boundary differ by necessity: md's queue holds unsent comments out
// of the store (store-presence = sent), but this guest reloads wholesale on
// every re-render, so comments commit to the store on submit and the boundary
// is a TURN STAMP instead — a send marks every user message it hands over with
// the turn it went out on (md's `turn`, same field and meaning), and the ladder
// reads those numbers (see threadCard). Ordinal, never a clock: the axis is
// sends, which stand still while the user is at lunch. Durable too, so a
// relaunch still knows which words the agent already has. Remaining divergence is presentation only: md
// rests an awaiting thread as a one-line row; here it's the full card with a
// muted "awaiting" note. The send-count grammar IS shared: the primary counts
// the open threads its pointer will cover (sendLabel), and the secondary is
// Discard — it destroys the typed draft, never just closes. A committed but
// un-sent card carries that same Discard, because here click-away commits.

const { ipcRenderer } = require('electron');
const { normWS, nearestHeading, toast, createComposer, toPromptAction, highlightRange, clearHighlight, highlightRanges, rangeOfText, isPasteCommentShortcut } = require('./comment-ui'); // bundled in by esbuild
const { createCommitEditController } = require('./review-commit-edit');
const { parseEditEnvelope, buildEnvelopeDiffNode } = require('./edit-marks');
const { installWebViewerPreloadCommon } = require('./web-viewer-preload-common');

installWebViewerPreloadCommon({ ipcRenderer, platform: process.platform });

(function () {
  if (window.__rvInit) return;
  window.__rvInit = true;

  let commentsUrl = null;
  let store = { threads: [] };
  // The turn of this session's FIRST send (0 = the agent was never pinged this
  // session). Words stamped below it went to an agent that no longer exists, so
  // they offer Send again — the right reset for a fresh agent — while their
  // stamp still says they left the user's hands once, which is what keeps
  // Discard off them. See the reviewSends comment in main.js for the split.
  let sessionFirstTurn = 0;
  // Thread ids already resolved when the latest send went out. A resolved
  // thread missing from this set closed after the user last handed work over,
  // so they have not read it yet.
  let resolvedAtSend = new Set();

  // The store's own send counter, ticked once per user send (md's `turn`).
  function storeTurn() { return Number.isFinite(store.turn) ? store.turn : 0; }
  // The newest send that covered any of this thread's words (0 = none ever).
  function maxUserTurn(t) {
    let max = 0;
    (t.messages || []).forEach(function (m) {
      if ((m.author || 'user') === 'user' && Number.isFinite(m.turn) && m.turn > max) max = m.turn;
    });
    return max;
  }
  // Words the user has written that no send has covered — an un-stamped user
  // message. The agent appending a reply adds none, which is why this reads
  // authorship rather than message count.
  function hasUnsentWords(t) {
    return (t.messages || []).some(function (m) {
      return (m.author || 'user') === 'user' && !Number.isFinite(m.turn);
    });
  }
  // Has THIS session's agent been pinged at all? The pointer names the store
  // and says "the open threads", so one send covers every open thread at once —
  // there is no per-thread version of this question.
  function anySendThisSession() { return !!sessionFirstTurn; }
  // Resolved thread ids the user expanded. Resolved threads collapse to a one-line
  // disclosure by default (less clutter); this remembers the ones clicked open.
  // Guest-local, so a full reload re-collapses them — the intended default.
  const expandedSet = new Set();
  // Resolved threads the user folded by hand, overriding the keep-open below.
  // Guest-local like expandedSet, and cleared by a full reload the same way.
  const collapsedSet = new Set();
  // Commit-message editing (review-commit-edit.js): strike-in-place marks on
  // the commit blocks, committed as [Edit] threads. Bound on review pages only.
  let commitEdit = null;

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    if (!document.body || !document.body.dataset || !document.body.dataset.review) return;
    bindExternalLinks(); // review page only — a remote page keeps normal in-place browsing
    // Strip query AND fragment before deriving the store URL: the page's own
    // nav links leave a #fragment on the URL, and a later reload re-runs this
    // preload against it — matching on the bare .html keeps the overlay alive.
    const pageUrl = location.href.replace(/[?#].*$/, '');
    commentsUrl = pageUrl.replace(/\.html$/i, '-comments.json');
    if (!commentsUrl || commentsUrl === pageUrl) return;
    injectStyles();
    ensureQuoteUI();
    bindGutter();
    bindSelection();
    bindDoubleClick();
    bindCommitEditing();
    load();
    pulseDiffDelta(); // scope 1: pulse new diff lines vs the previous render (host-held baseline)
    // Host pings this when the window regains focus, so agent replies / status
    // changes written to disk show up without a manual reload.
    ipcRenderer.on('rv-refresh', function () { load({ pulse: true }); });
    // The host mirrors its agent-working state here so awaiting rows can pulse
    // while the agent runs — the guest can't see the host's PTY heuristics.
    ipcRenderer.on('rv-working', function (_e, on) {
      document.body.classList.toggle('rv-agent-working', !!on);
    });
    // The banners' "Notify agent" button (rendered into the page by review.py)
    // → forward its kind to the host, which prompts the agent with a fixed
    // message. Delegated, so it survives the comment re-renders. The paste is
    // an agent ping like Send's, so it lands like one (pingFinished) — but on
    // its own channel: a nudge hands no threads over, so it recedes without
    // arming Send's resume-to-full.
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.rv-regen') : null;
      if (!btn) return;
      e.preventDefault();
      ipcRenderer.invoke('rv-regenerate', { kind: btn.getAttribute('data-rv-regen') || 'refresh' })
        .then(function (res) { pingFinished(res, 'rv-nudged', 'Sent to agent'); });
    });
  });

  // A review is a document the app rendered, not a site you're browsing: an http
  // link in it (a rendered markdown preview, a commit-message URL) belongs in the
  // browser, the same place the md viewer sends its links. Navigating in place
  // would swap the review — comments, gutters and all — for a web page.
  //
  // Commenting owns the plain click here too: double-clicking a block is how you
  // comment on it, and a first click that followed a link would take the page out
  // from under the second. So a bare click on link text does nothing and ctrl/cmd/
  // alt+click follows, matching the md viewer. The page's own #fragment nav is
  // untouched.
  function bindExternalLinks() {
    document.addEventListener('click', function (e) {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || e.altKey) ipcRenderer.invoke('open-url', href);
    });
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function load(opts) {
    // Don't clobber an open composer/reply/edit mid-typing on an external refresh.
    if (document.querySelector('.rv-compose-row, .rv-replybox, .rv-edit-compose')) return;
    ipcRenderer.invoke('read-review-comments', commentsUrl).then(function (res) {
      store = (res && res.success && res.data) ? res.data : { threads: [] };
      if (res && res.success) {
        sessionFirstTurn = res.sessionFirstTurn || 0;
        resolvedAtSend = new Set(res.resolvedAtSend || []);
      }
      renderAndTrack(opts && opts.pulse);
    }).catch(function () { renderAndTrack(false); });
  }

  // --- compose: click a line-number gutter cell to comment on that line ---
  function bindGutter() {
    document.addEventListener('click', function (e) {
      const ln = e.target.closest && e.target.closest('td.ln[data-line][data-side]');
      if (!ln) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel)) return; // a real text selection, not a click
      openComposer(ln);
    });
  }

  // --- compose: select text in prose / commit message / markdown preview to
  // comment on that quote. Region anchor = {path, snippet} (no line/side); code
  // diffs keep the line gutter above. --- (normWS/nearestHeading/toast come from
  // the shared comment-ui module.)
  function regionPathOf(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const sec = el && el.closest && el.closest('section[data-path]');
    return sec ? sec.getAttribute('data-path') : '(prose)';
  }

  // The block (paragraph/heading/list-item/commit line) a node sits in — the unit
  // a double-click anchors to, and the context a short selection rides within.
  function enclosingBlock(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el || !el.closest) return null;
    return el.closest('p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, .commit-subject, .commit-body');
  }

  // Whether a selection needs surrounding context to be unambiguous to the agent.
  // Driven solely by self-locatability: a long, unique selection stands alone; a
  // short one, or one repeated in its block, needs the enclosing unit as context.
  const MIN_STANDALONE_CHARS = 40;
  function snippetAmbiguous(snippet, blockText) {
    const s = normWS(snippet);
    if (s.length < MIN_STANDALONE_CHARS) return true;     // too short to self-locate
    const bt = normWS(blockText || '');
    const first = bt.indexOf(s);
    if (first === -1) return true;                        // can't be placed -> needs context
    return first !== bt.lastIndexOf(s);                   // appears >1x -> ambiguous
  }

  // Captured before the button/composer steals focus and collapses the selection.
  let quoteSel = null;
  // The composer currently open ({ root, commit }). Clicking outside it commits the draft as a
  // comment (no send) — see the capture-phase mousedown in bindSelection. Cleared when it closes.
  let activeComposer = null;

  function ensureQuoteUI() {
    if (document.getElementById('rv-quote-btn')) return;
    const b = document.createElement('button');
    b.id = 'rv-quote-btn';
    b.textContent = 'Type to comment';
    b.title = 'Type to comment on the selection (or click)';
    b.style.display = 'none';
    b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep the selection
    b.onclick = function () { if (quoteSel) openQuoteComposer(); };
    document.body.appendChild(b);
  }

  function hideQuoteButton() {
    const b = document.getElementById('rv-quote-btn');
    if (b) b.style.display = 'none';
    clearHighlight();
  }

  function refreshQuoteButton() {
    if (document.querySelector('.rv-quote-compose, .rv-compose-row, .rv-replybox, .rv-edit-compose')) return;
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !normWS(String(sel))) { hideQuoteButton(); return; }
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    // Only prose / commit message / markdown preview are quote-commentable; code
    // diffs use the line gutter. Skip selections inside our own overlay.
    if (!el || !el.closest('.md-render, #commit')) { hideQuoteButton(); return; }
    if (el.closest('.rv-thread, .rv-quote-compose, .cu-composer, .rv-replybox, .md-rendered-editing')) { hideQuoteButton(); return; }
    const rect = range.getBoundingClientRect();
    const full = normWS(String(sel));
    const snippet = full.slice(0, 400);
    const block = enclosingBlock(node);
    // Whole-block selection (a double-click, or a drag that covers the block): the
    // snippet is capped at 400, so highlighting it on placement would clip a long
    // paragraph's tail. Flag it so the placed highlight covers the whole block.
    const wholeBlock = !!(block && normWS(block.textContent) === full);
    // Context rides along only when the selection is ambiguous to the agent (short
    // or non-unique in its block); a long, unique selection stands alone.
    const context = (block && snippetAmbiguous(snippet, block.textContent))
      ? normWS(block.textContent).slice(0, 600) : null;
    quoteSel = { snippet: snippet, context: context, wholeBlock: wholeBlock,
                 path: regionPathOf(node), heading: nearestHeading(node), rect: rect, range: range.cloneRange() };
    highlightRange(quoteSel.range); // mark the selection in place; persists while composing

    const b = document.getElementById('rv-quote-btn');
    b.style.display = 'block';
    let top = rect.bottom + 6, left = rect.left;
    if (left + 130 > window.innerWidth) left = window.innerWidth - 138;
    if (top + 30 > window.innerHeight) top = rect.top - 32;
    b.style.left = Math.max(8, left) + 'px';
    b.style.top = Math.max(8, top) + 'px';
  }

  // Double-click in prose = the easy "comment here" gesture: select the whole
  // enclosing paragraph (overriding the browser's single-word select), which
  // refreshQuoteButton turns into a standalone paragraph anchor. Drag-select stays
  // the precise path; a short drag still picks up its block as context.
  function bindDoubleClick() {
    // Suppress the browser's word-select on the 2nd+ click in prose, so the
    // paragraph highlight appears cleanly with no single-word flash; the dblclick
    // handler selects the whole enclosing block instead. Drag-select (a detail===1
    // mousedown + move) is untouched and stays the way to pick a precise word.
    document.addEventListener('mousedown', function (e) {
      if (e.detail < 2 || !e.target || !e.target.closest) return;
      if (!e.target.closest('.md-render, #commit')) return;
      if (e.target.closest('.rv-thread, .rv-quote-compose, .cu-composer, .rv-replybox, .md-rendered-editing, .rv-edit-compose')) return;
      e.preventDefault();
    });
    document.addEventListener('dblclick', function (e) {
      const t = e.target;
      if (!t || !t.closest || !t.closest('.md-render, #commit')) return;
      if (t.closest('.rv-thread, .rv-quote-compose, .cu-composer, .rv-replybox, .md-rendered-editing, .rv-edit-compose')) return;
      const block = enclosingBlock(t);
      if (!block) return;
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(block);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      refreshQuoteButton();
    });
  }

  function bindSelection() {
    document.addEventListener('mouseup', function () { setTimeout(refreshQuoteButton, 0); });
    document.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('#rv-quote-btn, .rv-quote-compose')) return;
      hideQuoteButton();
    });
    // Click away from an open composer = commit the draft as a comment (no send). Capture phase
    // so it beats the composer's own buttons; a mousedown INSIDE the composer (a button/textarea)
    // is skipped so that button handles it. This is why there's no separate "Comment" (no-send)
    // button — moving away IS the no-send commit.
    document.addEventListener('mousedown', function (e) {
      if (!activeComposer) return;
      if (!activeComposer.root || !document.body.contains(activeComposer.root)) { activeComposer = null; return; }
      if (activeComposer.root.contains(e.target)) return;
      activeComposer.commit();
    }, true);
    // Select, then just start typing — like the terminal/md viewer. With a
    // selection armed (button showing) and no composer open, a plain printable
    // key opens the composer seeded with it; no need to click the button first.
    // Cmd/Ctrl+V does the same, seeded with the clipboard.
    document.addEventListener('keydown', function (e) {
      const btn = document.getElementById('rv-quote-btn');
      if (!quoteSel || !btn || btn.style.display === 'none') return;
      if (document.querySelector('.rv-quote-compose')) return;
      const t = e.target, tag = t && t.tagName ? t.tagName.toUpperCase() : '';
      if (tag === 'TEXTAREA' || tag === 'INPUT' || (t && t.isContentEditable)) return;
      if (isPasteCommentShortcut(e)) {
        // Clipboard via main — the sandboxed guest has no clipboard API of its
        // own. quoteSel is a captured object, so it survives the async hop.
        e.preventDefault();
        ipcRenderer.invoke('rv-clipboard-text').then(function (text) {
          openQuoteComposer(String(text || ''));
        });
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;     // leave Cmd+C / shortcuts alone
      if (!e.key || e.key.length !== 1) return;            // printable chars only
      e.preventDefault();
      openQuoteComposer(e.key);
    });
  }

  function closeQuoteComposer() {
    const c = document.querySelector('.rv-quote-compose');
    if (c) c.remove();
    hideQuoteButton();
    activeComposer = null;
  }

  // --- commit-message editing: the md viewer's edit-is-a-comment model on the
  // commit blocks. The controller owns the dispatch/session; this host wires
  // its store IPC, the comment fallback for letters, and the quote-chip
  // cleanup when an edit begins. ---
  function bindCommitEditing() {
    commitEdit = createCommitEditController({
      platform: process.platform,
      onToast: toast,
      sendLabel: function (revisitThreadId) { return sendLabel(sendExtraFor(revisitThreadId)); },
      threadNeedsSend: threadNeedsSend,
      threadWhollyUnsent: threadWhollyUnsent,
      composerBlocked: function () {
        return !!document.querySelector('.rv-quote-compose, .rv-compose-row, .rv-replybox');
      },
      onEditStart: function () { hideQuoteButton(); },
      // A letter on an armed commit block comments on it — the whole-block
      // quote path, exactly what a double-click would have set up.
      openBlockComment: function (block, seedKey) {
        const range = document.createRange();
        range.selectNodeContents(block);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        refreshQuoteButton();
        if (quoteSel) openQuoteComposer(seedKey);
      },
      addEditThread: function (item) {
        return ipcRenderer.invoke('rv-add-thread', {
          commentsUrl: commentsUrl, anchor: item.anchor, body: item.body, note: item.note,
        }).then(function (res) {
          if (!res || !res.success) return res;
          store = res.data;
          renderAndTrack(false);
          if (item.alsoSend) sendThread('Edit sent to agent', { toPrompt: !!item.toPrompt });
          return res;
        });
      },
      updateEditThread: function (item) {
        return ipcRenderer.invoke('rv-update-edit-thread', {
          commentsUrl: commentsUrl, threadId: item.threadId, body: item.body, note: item.note,
        }).then(function (res) {
          if (!res || !res.success) return res;
          store = res.data;
          renderAndTrack(false);
          if (item.alsoSend) sendThread('Edit sent to agent', { toPrompt: !!item.toPrompt });
          return res;
        });
      },
      discardThread: function (id) { return discardThread(id, 'Edit'); },
      // "Send all" on a mark-less edit session still means the rest: ping
      // only if something is pending.
      sendPending: function (opts) {
        if (store.threads.some(threadNeedsSend)) sendThread('Sent to agent', opts);
      },
    });
    commitEdit.bind();
  }

  // Undo for a pending thread — a comment or a commit-message edit — allowed
  // only while it is wholly the user's (rv-discard-thread enforces the same
  // rule store-side).
  function discardThread(threadId, what) {
    return ipcRenderer.invoke('rv-discard-thread', { commentsUrl: commentsUrl, threadId: threadId })
      .then(function (res) {
        if (!res || !res.success) { toast((res && res.error) || 'Could not discard'); return; }
        store = res.data;
        renderAndTrack(false);
        toast((what || 'Comment') + ' discarded');
      });
  }

  // The send is a pointer at EVERY open thread (main recounts after the store
  // write), so the primary says what it flushes when that is more than this
  // one — the md viewer's "Send all (n)" grammar, and the same plain "Send":
  // the button's contrast is with moving away (comment kept, agent not
  // pinged), not with commenting.
  //
  // The tally is the threads carrying UN-SENT words, not every open thread. A
  // thread you already sent is still open while the agent owes you an answer,
  // and counting it again made the number climb every time you commented
  // behind a slow agent — while its own card says "sent — awaiting agent" and
  // offers no Send. The button describes your action, so it counts what this
  // action hands over. (The ping itself still points at every open thread;
  // main deliberately puts no number in it, since any count goes stale between
  // the paste and the agent's read.)
  function sendLabel(extra) {
    const n = store.threads.filter(threadNeedsSend).length + extra;
    return n > 1 ? 'Send all (' + n + ')' : 'Send';
  }

  // What THIS action adds to that tally. A thread already holding un-sent
  // words is counted; anything else — a new thread, one awaiting the agent,
  // a resolved one a follow-up reopens — is one more.
  function sendExtraFor(threadId) {
    const t = threadId == null ? null : store.threads.find(function (x) { return x.id === threadId; });
    return t && threadNeedsSend(t) ? 0 : 1;
  }

  // Open, the user's word last, and this session's agent has not had it: either
  // the thread holds words no send ever covered, or no send has gone out at all
  // since launch (the fresh-agent reset — the new CLI has seen none of it, and
  // one ping covers every open thread). Shared by the card ladder and the
  // commit-edit mark colours (pending amber/rose vs sent slate).
  function threadNeedsSend(t) {
    const msgs = t.messages || [];
    const last = msgs[msgs.length - 1];
    const userLast = (t.status || 'open') === 'open' && !!last && (last.author || 'user') === 'user';
    return userLast && (hasUnsentWords(t) || !anySendThisSession());
  }

  // Wholly the user's and wholly un-sent: open, every message user-authored,
  // and not one of them carrying a turn stamp. That is the window in which a
  // thread is still a draft the user can take back, so it is what Discard hangs
  // off. Narrower than threadNeedsSend on both sides — a follow-up typed on an
  // already-sent thread satisfies that, and so does a thread sent to a previous
  // session's agent; discarding either would delete words the agent has.
  // Reading the durable stamp is what makes this survive a relaunch.
  function threadWhollyUnsent(t) {
    const msgs = t.messages || [];
    if (!msgs.length || (t.status || 'open') !== 'open') return false;
    if (!msgs.every(function (m) { return (m.author || 'user') === 'user'; })) return false;
    return maxUserTurn(t) === 0;
  }

  function openQuoteComposer(initialText) {
    if (!quoteSel) return;
    // Remove any prior composer + hide the chip, but KEEP the in-place highlight so
    // the user can see what they're commenting on while typing. It's cleared on
    // cancel / submit / click-away (closeQuoteComposer / the mousedown handler),
    // not here — clearing it here is what made the highlight vanish on first keypress.
    const prevPanel = document.querySelector('.rv-quote-compose');
    if (prevPanel) prevPanel.remove();
    const qb = document.getElementById('rv-quote-btn');
    if (qb) qb.style.display = 'none';
    const anchor = { path: quoteSel.path, snippet: quoteSel.snippet, context: quoteSel.context || '',
                     wholeBlock: !!quoteSel.wholeBlock, heading: quoteSel.heading || '' };
    const panel = document.createElement('div');
    panel.className = 'rv-quote-compose'; // mount: the floating-panel positioning
    const c = createComposer({
      // No repeated quote — the selection is highlighted in place. Heading (the
      // agent's own words, not "(note N)") is the only label.
      anchorLabel: quoteSel.heading || '',
      placeholder: 'Comment on this selection…',
      seed: initialText || '',
      onCancel: closeQuoteComposer,
      actions: [
        { label: sendLabel(1), primary: true, title: 'Enter', onClick: function (ctx) { activeComposer = null; submitNew(anchor, ctx.textarea, ctx.root, true, closeQuoteComposer); } },
        toPromptAction(function (ctx) { activeComposer = null; submitNew(anchor, ctx.textarea, ctx.root, true, closeQuoteComposer, { toPrompt: true }); }),
        { label: 'Discard', onClick: closeQuoteComposer },
      ],
    });
    panel.appendChild(c.root);
    document.body.appendChild(panel);
    activeComposer = { root: panel, commit: function () {
      activeComposer = null;
      if (c.textarea.value.trim()) submitNew(anchor, c.textarea, c.root, false, closeQuoteComposer);
      else closeQuoteComposer();
    } };
    const r = quoteSel.rect;
    let top = r.bottom + 8, left = r.left;
    const pw = 340, ph = panel.offsetHeight || 150;
    if (left + pw > window.innerWidth) left = window.innerWidth - pw - 10;
    if (top + ph > window.innerHeight) top = Math.max(8, r.top - ph - 8);
    panel.style.left = Math.max(8, left) + 'px';
    panel.style.top = Math.max(8, top) + 'px';
    c.focus();
  }

  function insertAfterRvRows(row, node) {
    // Insert below the row AND below any comment/compose rows already under it,
    // so multiple threads keep store order and the composer lands last.
    let ref = row;
    while (ref.nextSibling && ref.nextSibling.nodeType === 1
      && /\brv-(row|compose-row)\b/.test(ref.nextSibling.className || '')) ref = ref.nextSibling;
    row.parentNode.insertBefore(node, ref.nextSibling);
  }

  function closeComposer() {
    const c = document.querySelector('.rv-compose-row');
    if (c) c.remove();
    activeComposer = null;
  }

  // A compose/thread row spans whatever table it sits in: 4 cells in a split
  // diff, 2 in a :::code context block (one gutter, one code column).
  function rowCellCount(row) {
    return (row && row.children && row.children.length) || 4;
  }

  function openComposer(lnCell) {
    closeComposer();
    const sec = lnCell.closest('section[data-path]');
    if (!sec) return;
    const codeCell = lnCell.nextElementSibling; // <td class="code"> follows <td class="ln">
    const anchor = {
      path: sec.getAttribute('data-path'),
      side: lnCell.getAttribute('data-side'),
      line: lnCell.getAttribute('data-line'),
      snippet: (codeCell ? codeCell.textContent : '').trim(),
    };
    const row = lnCell.closest('tr');
    const tr = document.createElement('tr');
    tr.className = 'rv-compose-row'; // mount: inline diff-table row
    const td = document.createElement('td');
    td.colSpan = rowCellCount(row);
    const c = createComposer({
      anchorLabel: anchor.path + ':' + anchor.line + ' (' + anchor.side + ')',
      placeholder: 'Comment on this line…',
      onCancel: closeComposer,
      actions: [
        { label: sendLabel(1), primary: true, title: 'Enter', onClick: function (ctx) { activeComposer = null; submitNew(anchor, ctx.textarea, ctx.root, true, closeComposer); } },
        toPromptAction(function (ctx) { activeComposer = null; submitNew(anchor, ctx.textarea, ctx.root, true, closeComposer, { toPrompt: true }); }),
        { label: 'Discard', onClick: closeComposer },
      ],
    });
    td.appendChild(c.root);
    tr.appendChild(td);
    insertAfterRvRows(row, tr);
    activeComposer = { root: tr, commit: function () {
      activeComposer = null;
      if (c.textarea.value.trim()) submitNew(anchor, c.textarea, c.root, false, closeComposer);
      else closeComposer();
    } };
    c.focus();
  }

  function submitNew(anchor, ta, el, alsoSend, onClose, opts) {
    const body = ta.value.trim();
    if (!body) {
      // An empty box is no comment, but Send keeps the "Send all (n)" the
      // label promised: close the box and flush the threads already pending.
      // Empty with nothing pending has nothing to do.
      if (alsoSend && store.threads.some(threadNeedsSend)) {
        if (onClose) onClose();
        sendThread('Sent to agent', opts);
      }
      return;
    }
    const btns = el.querySelectorAll('button');
    btns.forEach(function (b) { b.disabled = true; });
    ipcRenderer.invoke('rv-add-thread', { commentsUrl: commentsUrl, anchor: anchor, body: body }).then(function (res) {
      if (!res || !res.success) {
        toast((res && res.error) || 'Could not add comment');
        btns.forEach(function (b) { b.disabled = false; });
        return;
      }
      store = res.data;
      if (onClose) onClose();
      renderAndTrack(false);
      // The Send primary composes and pings the agent in one action. The
      // no-send commit stays silent: the card rendering in place is the
      // receipt, and a toast would land after the user has moved on.
      if (alsoSend) sendThread('Comment sent to agent', opts);
    });
  }

  // --- render threads ---
  let anchorRanges = []; // each placed region thread's exact anchored text Range

  // --- change pulse: on an EXTERNAL refresh (rv-refresh = the agent wrote to the store),
  // briefly highlight just what changed vs the previous render — new messages (agent replies)
  // and status changes — not the whole overlay. Content-keyed, so a card merely re-placed at a
  // new position doesn't flash. User-driven renders pass pulse=false: their own just-typed
  // comment shouldn't flash, and it becomes the baseline so it won't flash on the next refresh.
  // (This is the in-place path only; a full page reload starts prevState=null → no first-render
  // flash. Diff-line pulse on reload is the follow-up scope.)
  let prevState = null; // { msgKeys:Set, status:Map } from the last render, or null before the first

  function msgKey(tid, m) {
    return tid + ' ' + ((m && m.author) || 'user') + ' ' + ((m && m.ts) || '') + ' ' + ((m && m.body) || '');
  }
  function threadStateOf(threads) {
    const msgKeys = new Set(); const status = new Map();
    (threads || []).forEach(function (t) {
      status.set(t.id, t.status || 'open');
      (t.messages || []).forEach(function (m) { msgKeys.add(msgKey(t.id, m)); });
    });
    return { msgKeys: msgKeys, status: status };
  }
  function pulseEl(el) {
    if (!el) return;
    el.classList.remove('rv-pulse');
    void el.offsetWidth; // restart the animation if the node is already mid-pulse
    el.classList.add('rv-pulse');
    setTimeout(function () { el.classList.remove('rv-pulse'); }, 9300); // clear after the 3×3s cycles
  }
  // Pulse each thread's new message(s); if only its status changed, pulse the card. Cards carry
  // data-rv-tid and messages render in store order, so the index maps a message to its node.
  function applyPulses(before) {
    ((store && store.threads) || []).forEach(function (t) {
      const sel = (window.CSS && CSS.escape) ? CSS.escape(String(t.id)) : t.id;
      const card = document.querySelector('.rv-thread[data-rv-tid="' + sel + '"]');
      if (!card) return;
      const msgEls = card.querySelectorAll('.rv-msg');
      const msgs = t.messages || [];
      let pulsed = false;
      for (let i = 0; i < msgs.length; i++) {
        if (!before.msgKeys.has(msgKey(t.id, msgs[i])) && msgEls[i]) { pulseEl(msgEls[i]); pulsed = true; }
      }
      if (!pulsed) {
        const prev = before.status.get(t.id);
        if (prev !== undefined && prev !== (t.status || 'open')) pulseEl(card);
      }
    });
  }
  // Render, then (only when pulse && a prior render exists) highlight the delta. Always refresh
  // the baseline so the next refresh diffs against what is on screen now.
  function renderAndTrack(pulse) {
    const before = prevState;
    render();
    if (pulse && before) applyPulses(before);
    prevState = threadStateOf((store && store.threads) || []);
    reportThreadState();
  }

  // Tell the host where the agent's turn stands after every store snapshot.
  // The host uses the flip to restore full size after a send receded to golden
  // (web-viewer.js), so this must not report "over" mid-turn — and it did,
  // when the old runbook let the agent reply inline before editing and
  // committing: agent-last was a mid-work state the store poll routinely
  // caught, and the band expanded to full while the agent was still editing.
  // Only `resolved` reports the turn over, and the contract now orders it
  // last — written only after the commit, so all-resolved arrives with the
  // work already rendered (agent-threads contract.md, resolve-after-
  // visibility). A thread the agent leaves open — a question back, or merely
  // answered — keeps the band at golden, where the reply is already visible
  // and pulsing; expanding for it is the user's call.
  function reportThreadState() {
    const threads = (store && store.threads) || [];
    const agentTurnOver = threads.length > 0 && threads.every(function (t) {
      return t.status === 'resolved';
    });
    try { ipcRenderer.sendToHost('rv-threads-state', { agentTurnOver: agentTurnOver }); } catch {}
  }

  // --- diff-line pulse (scope 1): on an auto-refresh RELOAD, briefly highlight the new-side
  // lines the agent just added, vs the previous render. The reload wipes this guest, so the
  // prior render's key set lives in the HOST (rv-diff-baseline is a get-and-set keyed by the
  // review). A null prior = first render for this review -> baseline only, no flash. Content-
  // keyed by (path, line text), so renumbering / position drift never pulses.
  function pulseDiffDelta() {
    const items = [];
    document.querySelectorAll('section[data-path]').forEach(function (sec) {
      const path = sec.getAttribute('data-path') || '';
      sec.querySelectorAll('td.code.add[data-side="new"]').forEach(function (cell) {
        items.push({ key: path + ' ' + normWS(cell.textContent), el: cell });
      });
    });
    ipcRenderer.invoke('rv-diff-baseline', { reviewId: commentsUrl, keys: items.map(function (i) { return i.key; }) })
      .then(function (prior) {
        if (!prior) return; // first render for this review → baseline only, no pulse
        const seen = new Set(prior);
        items.forEach(function (i) { if (!seen.has(i.key)) pulseEl(i.el); });
      }).catch(function () {});
  }

  function render() {
    document.querySelectorAll('.rv-row, .rv-filehdr-thread, .rv-quote-thread').forEach(function (e) { e.remove(); });
    anchorRanges = [];
    const threads = (store && store.threads) || [];
    // Unresolved commit-message edits re-strike their block in place (the marks
    // ARE the edit); their cards then skip the redundant diff body.
    if (commitEdit) commitEdit.decorateEditThreads(threads);
    for (let i = 0; i < threads.length; i++) placeThread(threads[i]);
    highlightRanges('cu-anchor', anchorRanges); // mark each comment's exact text, not the whole block
  }

  function placeThread(t) {
    const a = t.anchor || {};
    // Region/quote anchor (prose / commit message / md preview, no side): placed
    // by its SNIPPET, page-wide and independent of any stored "(note N)" path, so
    // it survives prose being re-ordered/renumbered across a re-render.
    if (!a.side) { placeRegionThread(t); return; }
    // Code anchor: locate the file section, then the specific line.
    if (!a.path) return;
    const key = (window.CSS && CSS.escape) ? CSS.escape(a.path) : a.path;
    // A file can appear in several blocks — two :::diff ranges, or a :::diff plus
    // a :::code context block — each its own section with the same data-path.
    // The line lives in one of them, so search them all; the first section is
    // only the fallback home for a thread whose line is gone.
    const secs = document.querySelectorAll('section[data-path="' + key + '"]');
    if (!secs.length) return;
    let sec = secs[0];
    let row = null;
    if (t.anchor_status !== 'lost' && a.line != null && a.side) {
      for (let i = 0; i < secs.length && !row; i++) {
        const cell = secs[i].querySelector('[data-side="' + a.side + '"][data-line="' + a.line + '"]');
        if (cell) { row = cell.closest('tr'); sec = secs[i]; }
      }
    }
    const card = threadCard(t);
    if (row && row.parentNode) {
      const tr = document.createElement('tr');
      tr.className = 'rv-row';
      const td = document.createElement('td');
      td.colSpan = rowCellCount(row);
      td.appendChild(card);
      tr.appendChild(td);
      insertAfterRvRows(row, tr);
    } else {
      const box = document.createElement('div');
      box.className = 'rv-filehdr-thread';
      box.appendChild(card);
      const h2 = sec.querySelector('h2');
      if (h2 && h2.parentNode) h2.parentNode.insertBefore(box, h2.nextSibling);
      else sec.appendChild(box);
    }
  }

  // Place a region/quote thread next to the block that holds its quote, located
  // page-wide by snippet. If the quote is gone (lost) or spans blocks, fall back
  // to the agent's heading, then the stored section, then main — never dropped.
  function placeRegionThread(t) {
    const a = t.anchor || {};
    // A decorated commit-edit thread sits under its marked block — the marks
    // carry the diff, so the card passes hasHighlight and drops its quote.
    const decoratedBlock = commitEdit ? commitEdit.decoratedBlockFor(t.id) : null;
    if (decoratedBlock && decoratedBlock.parentNode) {
      const dbox = document.createElement('div');
      dbox.className = 'rv-quote-thread';
      dbox.appendChild(threadCard(t, true));
      decoratedBlock.parentNode.insertBefore(dbox, decoratedBlock.nextSibling);
      return;
    }
    const block = t.anchor_status === 'lost' ? null : findQuoteBlock(a.snippet, a.context);
    // Whole-block anchor → highlight the whole block (the capped snippet would clip
    // a long paragraph). Otherwise highlight just the quoted text.
    let range = null;
    if (block) {
      if (a.wholeBlock) { range = document.createRange(); range.selectNodeContents(block); }
      else { range = rangeOfText(block, a.snippet); }
    }
    const box = document.createElement('div');
    box.className = 'rv-quote-thread';
    // A real highlight → drop the redundant quote from the card; no highlight → keep it.
    box.appendChild(threadCard(t, !!range));
    if (block && block.parentNode) {
      if (range) anchorRanges.push(range);
      block.parentNode.insertBefore(box, block.nextSibling);
      return;
    }
    const fb = regionFallbackTarget(a);
    if (fb && fb.parentNode) fb.parentNode.insertBefore(box, fb.nextSibling);
    else (document.querySelector('main') || document.body).appendChild(box);
  }

  // The innermost rendered block, anywhere in the page's prose / commit message,
  // whose text contains the quote — skipping our own overlay cards (whose quoted
  // text would otherwise match). No match when the selection spans blocks.
  function findQuoteBlock(snippet, context) {
    const snip = normWS(snippet);
    if (!snip) return null;
    const ctx = normWS(context || '');
    const blocks = [];
    document.querySelectorAll('.md-render, #commit').forEach(function (root) {
      root.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,.commit-subject').forEach(function (b) {
        if (b.closest('.rv-thread, .rv-quote-thread, .rv-filehdr-thread, .rv-row, .rv-compose-row, .rv-quote-compose, .cu-composer, .rv-replybox')) return;
        blocks.push(b);
      });
    });
    function innermost(filter) {
      const m = blocks.filter(filter);
      for (let i = 0; i < m.length; i++) {
        const b = m[i];
        if (!m.some(function (o) { return o !== b && b.contains(o); })) return b;
      }
      return m[0] || null;
    }
    // Context-first: the enclosing unit is long/unique, so find the block holding
    // it (with the snippet inside) — disambiguates a short or repeated snippet.
    // Falls back to snippet-only when no context was stored.
    if (ctx) {
      const byCtx = innermost(function (b) {
        const txt = normWS(b.textContent);
        return txt.indexOf(ctx) !== -1 && txt.indexOf(snip) !== -1;
      });
      if (byCtx) return byCtx;
    }
    return innermost(function (b) { return normWS(b.textContent).indexOf(snip) !== -1; });
  }

  // Where to put a region thread whose quote is no longer on the page: the
  // agent's heading if it still exists, else the stored section's first heading.
  function regionFallbackTarget(a) {
    if (a.heading) {
      const heads = document.querySelectorAll('.md-render h1,.md-render h2,.md-render h3,.md-render h4,.md-render h5,.md-render h6,#commit h2');
      for (let i = 0; i < heads.length; i++) if (normWS(heads[i].textContent) === normWS(a.heading)) return heads[i];
    }
    if (a.path) {
      const key = (window.CSS && CSS.escape) ? CSS.escape(a.path) : a.path;
      const sec = document.querySelector('section[data-path="' + key + '"]');
      if (sec) return sec.querySelector('h1,h2,h3,h4,h5,h6') || sec.firstElementChild;
    }
    return null;
  }

  // A collapsed row's one-line handle on a thread: its first user comment. An
  // edit thread's raw body is an [Edit] envelope — read as the suggested NEW
  // text (text + insertions), which is how the user thinks of their edit.
  function threadGist(t, fallback) {
    const first = (t.messages || []).find(function (m) { return (m.author || 'user') === 'user'; }) || (t.messages || [])[0];
    const parsed = first && (first.author || 'user') === 'user' ? parseEditEnvelope(first.body) : null;
    let raw;
    if (parsed && parsed.kind === 'merged') {
      raw = 'Edit: ' + normWS(parsed.segments
        .filter(function (s) { return s.kind !== 'del'; })
        .map(function (s) { return s.text; }).join(''));
    } else {
      raw = normWS((first && first.body) || '') || fallback;
    }
    return raw.length > 160 ? raw.slice(0, 159) + '…' : raw;
  }

  function threadCard(t, hasHighlight) {
    const a = t.anchor || {};
    const isRegion = !a.side;
    const div = document.createElement('div');
    div.className = 'rv-thread rv-' + (t.status || 'open');
    if (t.id != null) div.setAttribute('data-rv-tid', t.id); // lets applyPulses find this card
    // An edit thread's first message is an [Edit] envelope (commit-message
    // editing) — rendered as a del/ins diff, or elided entirely when the marks
    // are already struck into the commit block above the card.
    const firstMsg = (t.messages || [])[0];
    const editParsed = firstMsg && (firstMsg.author || 'user') === 'user'
      ? parseEditEnvelope(firstMsg.body) : null;
    const editDecorated = !!(editParsed && commitEdit && commitEdit.decoratedBlockFor(t.id));
    const lost = t.anchor_status === 'lost'
      ? '<div class="rv-lost">↳ ' + (isRegion ? 'quoted text is no longer on the page'
          : ('original ' + esc(a.path) + ':' + esc(a.line) + ' — code changed')) + '</div>' : '';
    const moved = t.anchor_status === 'moved'
      ? '<div class="rv-moved">↻ re-anchored to the current line</div>' : '';
    // The in-place highlight + the card sitting right under its block already show
    // what this is about, so the repeated quote is redundant while anchored — keep
    // it only when there's no highlight (anchor lost / unplaceable), where it's the
    // only handle on what was commented on. An edit's diff body carries its own
    // original text, so it never needs the quote.
    const quote = (isRegion && a.snippet && !hasHighlight && !editParsed)
      ? '<blockquote class="rv-qtext">' + esc(a.snippet) + '</blockquote>' : '';
    const msgs = (t.messages || []).map(function (m, i) {
      if (i === 0 && editParsed) {
        return '<div class="rv-msg rv-user rv-edit-body" data-rv-edit-slot="1"><span class="rv-who">You</span></div>';
      }
      return '<div class="rv-msg rv-' + (m.author || 'user') + '"><span class="rv-who">'
        + (m.author === 'agent' ? 'Agent' : 'You') + '</span>' + esc(m.body) + '</div>';
    }).join('');
    const resolved = t.status === 'resolved';
    const last = (t.messages || [])[(t.messages || []).length - 1];
    // Resolved threads collapse to a single disclosure line — "✓ Resolved: <first
    // comment…>" — so closed threads stop crowding out the active ones. Click to
    // expand (remembered in expandedSet until the next full reload).
    //
    // EXCEPT the resolution you have not read yet. A code thread commonly runs
    // several turns before it closes, and the card sits beside the very lines
    // it is about, so the answer that ended it is what you came back for —
    // folding it the moment it arrives hides the payload. It keeps its card
    // until your NEXT send, then folds: the wave rule the awaiting cards
    // already follow, one wave later. No send this session folds everything,
    // since nothing resolved while you were watching.
    // Set membership against the last send's snapshot — "was it already closed
    // when I last handed work over?" The badge still folds it by hand any time.
    const resolvedUnread = resolved && !!sessionFirstTurn && !resolvedAtSend.has(t.id)
      && !collapsedSet.has(t.id);
    if (resolved && !expandedSet.has(t.id) && !resolvedUnread) {
      div.classList.add('rv-collapsed');
      div.innerHTML = '<button class="rv-resolved-head" title="Show thread">'
        + '<span class="rv-resolved-tag">✓ Resolved</span>' + esc(threadGist(t, '(resolved)')) + '</button>';
      div.querySelector('.rv-resolved-head').onclick = function () {
        expandedSet.add(t.id); collapsedSet.delete(t.id); renderAndTrack(false);
      };
      return div;
    }
    // The state ladder, md's model in diff-native form. Loud amber card = your
    // move (or your unsent words). A thread awaiting the agent recedes: the
    // CURRENT wave — covered by the latest send — keeps its dimmed card, since
    // in a diff the card beside the code is the context you just sent; an
    // EARLIER wave is old context and folds to a one-line row (click to read
    // back), the way md's waiting rows rest. Recency does the tidying.
    const userLast = (t.status || 'open') === 'open' && !!last && (last.author || 'user') === 'user';
    const needsSend = threadNeedsSend(t);
    const waiting = userLast && !needsSend;
    // Covered by a send older than the latest one: old context, folds to a line.
    const sentTurn = maxUserTurn(t);
    const earlierWave = sentTurn > 0 && sentTurn < storeTurn();
    if (waiting && earlierWave && !expandedSet.has(t.id)) {
      div.classList.add('rv-collapsed', 'rv-waiting');
      div.innerHTML = '<button class="rv-waiting-head" title="Sent — awaiting agent. Click to open">'
        + '<span class="rv-waiting-tag">sent</span>' + esc(threadGist(t, '(sent)')) + '</button>';
      div.querySelector('.rv-waiting-head').onclick = function () { expandedSet.add(t.id); renderAndTrack(false); };
      return div;
    }
    if (waiting) div.classList.add('rv-waiting');
    // Only `resolved` gets a pill, doubling as the collapse control. There is no
    // "read" state any more (contract.md): the agent ends a thread blocked or
    // done, and "open" is self-evident from the reply sitting right there.
    const badge = resolved
      ? '<button class="rv-badge rv-badge-btn" data-act="collapse" title="Collapse">resolved ▾</button>'
      : '';
    // Comment is a follow-up; the agent owns `resolved` (contract.md), so there
    // is no Resolve button to disagree with it — and no Reopen either, because
    // a follow-up IS the reopen. A thread carries Send only while it holds user
    // words the agent was never pinged about (its last message is the user's and
    // newer than the sent boundary): moving away from a composer commits the
    // comment to the store with no composer left, so the card must offer the
    // ping. Once covered by a send it rests as "awaiting agent" — the md
    // viewer's model — so a sent thread can't be re-sent by mistake; a fresh
    // follow-up moves past the boundary and brings Send back.
    // Discard is the way back out of a comment you did not mean to leave:
    // click-away commits to the store with no composer left behind, so the
    // card has to carry the undo — there is no empty-the-box delete here the
    // way md has one. It lives only while the thread is wholly yours and
    // wholly un-sent; once a send covers it the thread seals (awaiting) and a
    // follow-up is the vehicle. A pending commit-message edit is the same
    // thread in the same window, worded for the marks up in the commit block.
    const discardable = threadWhollyUnsent(t);
    div.innerHTML = badge + lost + moved + quote + msgs
      + '<div class="rv-thread-actions">'
      + '<button class="rv-link" data-act="comment">Comment</button>'
      + (needsSend ? '<button class="rv-link" data-act="send">' + esc(sendLabel(0)) + '</button>' : '')
      + (needsSend ? '<button class="rv-link" data-act="toprompt" title="' + esc(toPromptAction(function(){}).title) + '">To prompt</button>' : '')
      + (discardable ? '<button class="rv-link" data-act="discard">' + (editParsed ? 'Discard edit' : 'Discard') + '</button>' : '')
      + (waiting ? '<span class="rv-awaiting">sent — awaiting agent</span>' : '')
      + '</div>';
    const slot = div.querySelector('[data-rv-edit-slot]');
    if (slot) {
      if (editDecorated) {
        const note = document.createElement('span');
        note.className = 'rv-edit-inplace';
        note.textContent = 'suggested edit — marked in the commit message above';
        slot.appendChild(note);
      } else {
        slot.appendChild(buildEnvelopeDiffNode(editParsed));
      }
    }
    div.querySelector('[data-act=comment]').onclick = function () { openReply(div, t.id); };
    const sendBtn = div.querySelector('[data-act=send]');
    if (sendBtn) sendBtn.onclick = function () { sendThread('Sent to agent'); };
    const toPromptBtn = div.querySelector('[data-act=toprompt]');
    if (toPromptBtn) toPromptBtn.onclick = function () { sendThread(null, { toPrompt: true }); };
    const discardBtn = div.querySelector('[data-act=discard]');
    if (discardBtn) discardBtn.onclick = function () { discardThread(t.id, editParsed ? 'Edit' : 'Comment'); };
    const collapseBtn = div.querySelector('[data-act=collapse]');
    if (collapseBtn) collapseBtn.onclick = function () {
      expandedSet.delete(t.id); collapsedSet.add(t.id); renderAndTrack(false);
    };
    return div;
  }

  function openReply(div, threadId) {
    const existing = div.querySelector('.rv-replybox');
    if (existing) { existing.querySelector('textarea').focus(); return; }
    const box = document.createElement('div');
    box.className = 'rv-replybox'; // mount: appended under the thread
    const c = createComposer({
      placeholder: 'Comment…',
      rows: 2,
      onCancel: function () { box.remove(); activeComposer = null; },
      actions: [
        { label: sendLabel(sendExtraFor(threadId)), primary: true, title: 'Enter', onClick: function (ctx) { activeComposer = null; sendReply(threadId, ctx.textarea, ctx.root, true); } },
        toPromptAction(function (ctx) { activeComposer = null; sendReply(threadId, ctx.textarea, ctx.root, true, { toPrompt: true }); }),
        { label: 'Discard', onClick: function () { box.remove(); activeComposer = null; } },
      ],
    });
    box.appendChild(c.root);
    div.appendChild(box);
    activeComposer = { root: box, commit: function () {
      activeComposer = null;
      if (c.textarea.value.trim()) sendReply(threadId, c.textarea, c.root, false);
      else box.remove();
    } };
    c.focus();
  }

  function sendReply(threadId, ta, box, alsoSend, opts) {
    const body = ta.value.trim();
    if (!body) {
      // Empty follow-up = no follow-up; Send still flushes what's pending.
      if (alsoSend && store.threads.some(threadNeedsSend)) {
        box.remove();
        sendThread('Sent to agent', opts);
      }
      return;
    }
    box.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    ipcRenderer.invoke('rv-add-message', { commentsUrl: commentsUrl, threadId: threadId, author: 'user', body: body })
      .then(function (res) {
        if (!res || !res.success) {
          toast((res && res.error) || 'Could not reply');
          box.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
          return;
        }
        store = res.data;
        renderAndTrack(false);
        // The Send primary posts the follow-up and pings the agent in one
        // action; a no-send commit shows itself as the new message in place.
        if (alsoSend) sendThread('Comment sent to agent', opts);
      });
  }

  // How every agent ping lands, Send and banner nudge alike: a failure toasts
  // the reason; success toasts okMsg and tells the host on `channel`, which
  // recedes a full-size band to golden (web-viewer.js) — the pasted prompt,
  // the receipt, shows in the terminal sliding in underneath. Channels:
  // 'rv-sent' (a send — the host also arms the resume-to-full), 'rv-nudged'
  // (a banner nudge — recede only), 'rv-to-prompt' (rolls the band up via
  // main's 'to-prompt' event and disarms any resume an earlier send left
  // armed: full terminal, staying).
  function pingFinished(res, channel, okMsg) {
    // The user canceled the missing-runbook dialog themselves — no toast.
    if (res && res.canceled) return false;
    if (!res || !res.success) { toast((res && res.error) || 'Could not send'); return false; }
    toast(okMsg);
    try { ipcRenderer.sendToHost(channel); } catch {}
    return true;
  }

  // Ping the agent: pastes a pointer prompt ("read the N open threads in
  // <file>") into its terminal. Pure pointer — the store is the single source
  // of truth, so no thread content (not even the one just composed) rides in
  // the prompt; the count covers everything pending.
  function sendThread(okMsg, opts) {
    const toPrompt = !!(opts && opts.toPrompt);
    ipcRenderer.invoke('rv-send-to-agent', { commentsUrl: commentsUrl, toPrompt: toPrompt }).then(function (res) {
      const landed = pingFinished(res, toPrompt ? 'rv-to-prompt' : 'rv-sent',
        toPrompt ? 'In the prompt — finish and press Enter' : (okMsg || 'Sent to agent'));
      if (!landed) return;
      // The boundary moved: re-derive the cards now, so the just-covered threads
      // flip from Send to awaiting (and earlier waves fold) without waiting for
      // the next store read.
      if (res.sessionFirstTurn) {
        sessionFirstTurn = res.sessionFirstTurn;
        resolvedAtSend = new Set(res.resolvedAtSend || []);
        // The stamps live in the store, so re-read rather than re-derive.
        load();
      }
    });
  }

  function injectStyles() {
    if (document.getElementById('rv-style')) return;
    const st = document.createElement('style');
    st.id = 'rv-style';
    st.textContent = [
      '.rv-thread{border:1px solid #d1d9e0;border-left:3px solid #8b949e;border-radius:6px;background:#fff;',
      'padding:6px 9px;margin:6px 0;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2328;max-width:780px}',
      '.rv-row > td{background:#f6f8fa;padding:4px 10px}',
      '.rv-filehdr-thread{margin:6px 0}',
      '.rv-thread.rv-open{border-left-color:#d29922}',
      '.rv-thread.rv-read{border-left-color:#8250df}',
      '.rv-thread.rv-answered{border-left-color:#0969da}',
      '.rv-thread.rv-resolved{border-left-color:#1a7f37;opacity:.72}',
      '.rv-thread.rv-resolved.rv-collapsed{padding:2px 9px;opacity:.66}',
      '.rv-resolved-head{display:block;width:100%;text-align:left;background:none;border:0;padding:1px 0;',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#59636e;cursor:pointer;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rv-thread.rv-resolved.rv-collapsed:hover{opacity:.85}.rv-resolved-head:hover{color:#1f2328}',
      '.rv-resolved-tag{color:#1a7f37;font-weight:600;margin-right:6px}',
      '.rv-badge{float:right;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#59636e;border:1px solid #d1d9e0;border-radius:10px;padding:0 7px}',
      '.rv-badge-btn{background:none;cursor:pointer;font-family:inherit}.rv-badge-btn:hover{color:#1f2328;border-color:#8c959f}',
      '.rv-msg{margin:3px 0}.rv-who{font-weight:600;margin-right:6px}.rv-msg.rv-agent .rv-who{color:#0969da}',
      '.rv-lost{font-size:11px;color:#9a6700;margin-bottom:3px}',
      '.rv-moved{font-size:11px;color:#0550ae;margin-bottom:3px}',
      '.rv-thread-actions{margin-top:5px;display:flex;gap:12px}',
      '.rv-link{background:none;border:0;padding:0;color:#0969da;font:inherit;cursor:pointer}',
      '.rv-awaiting{color:#6e7781;font-style:italic}',
      // Awaiting the agent: the card recedes — grey edge, dimmed — so amber is
      // reserved for the one state that needs the user (md's turn-colour rule).
      // Placed after .rv-open so the grey wins on open+waiting cards.
      '.rv-thread.rv-waiting{border-left-color:#8b949e;opacity:.8}',
      '.rv-thread.rv-waiting.rv-collapsed{padding:2px 9px;opacity:.66}',
      '.rv-thread.rv-waiting.rv-collapsed:hover{opacity:.85}',
      '.rv-waiting-head{display:block;width:100%;text-align:left;background:none;border:0;padding:1px 0;',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#59636e;cursor:pointer;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rv-waiting-head:hover{color:#1f2328}',
      '.rv-waiting-tag{color:#6e7781;font-style:italic;font-weight:600;margin-right:6px}',
      // While the agent runs (host forwards its working state as rv-working), an
      // awaiting thread breathes its left accent — md's md-thread-working ported
      // to this palette, tempo-matched at 1.6s so the two viewers read as one
      // cue. The ACCENT breathes, not the "awaiting" words: this has to register
      // in peripheral vision while the eye is down in the diff, which takes a
      // wide luminance swing on a structural element (md learned that on a 2px
      // border; grey #8b949e → near-black, plus an edge line at peak). Both
      // presentations are .rv-thread.rv-waiting, so the full card and the folded
      // row breathe alike.
      '@keyframes rv-wait-pulse{0%,100%{border-left-color:#8b949e;box-shadow:-1.5px 0 0 rgba(31,35,40,0)}',
      '50%{border-left-color:#1f2328;box-shadow:-1.5px 0 0 rgba(31,35,40,.5)}}',
      'body.rv-agent-working .rv-thread.rv-waiting{animation:rv-wait-pulse 1.6s ease-in-out infinite}',
      '.rv-link:hover{text-decoration:underline}',
      '.rv-link:disabled{color:#8c959f;cursor:default;text-decoration:none}',
      // compose / reply
      '.rv-compose-row > td{background:#f6f8fa;padding:6px 10px}',
      // The composer widget (textarea/buttons/preview) is now .cu-* from comment-ui.
      '.rv-replybox{margin-top:6px}',
      // gutter affordance
      'td.ln[data-line][data-side]{position:relative;cursor:pointer}',
      'td.ln[data-line][data-side]:hover{background:#ddf4ff}',
      'td.ln[data-line][data-side]:hover::after{content:"+";position:absolute;right:2px;top:50%;',
      'transform:translateY(-50%);background:#0969da;color:#fff;width:13px;height:13px;border-radius:3px;',
      'font-size:11px;line-height:13px;text-align:center}',
      // region/quote commenting
      '#rv-quote-btn{position:fixed;z-index:2147483002;display:none;border:0;border-radius:6px;',
      'background:#0969da;color:#fff;padding:5px 11px;font:12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      'box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer}',
      '#rv-quote-btn:hover{background:#0860c8}',
      '.rv-quote-compose{position:fixed;z-index:2147483002;width:340px;max-width:92vw;background:#fff;',
      'border:1px solid #d1d9e0;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.22);padding:9px;',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2328}',
      '.rv-qtext{margin:2px 0 5px;padding:2px 8px;border-left:3px solid #d1d9e0;color:#59636e;',
      'font-size:11px;max-height:60px;overflow:auto}',
      // span both columns when the quote sits inside a two-column prose card
      '.rv-quote-thread{margin:6px 0;max-width:780px;column-span:all}',
      // change pulse — localized highlight on external re-render / diff reload. 3 cycles of ~3s
      // (a good human count — clearly repeated, not too many). Each cycle rises, HOLDS the tint
      // ~1s so it reads as a sustained pulse (not a blip), falls, then a short transparent gap
      // separates it from the next — so all three land visibly across the ~9s. Intensity kept.
      // The markdown viewer mirrors this curve as md-change-pulse-kf (src/markdown-viewer.js) on
      // its changed block; keep the two in sync.
      '@keyframes rv-pulse-kf{0%,72%,100%{background:transparent;box-shadow:inset 4px 0 0 transparent,inset 0 0 0 1px transparent}',
      '12%,45%{background:rgba(9,105,218,.38);box-shadow:inset 4px 0 0 #0969da,inset 0 0 0 1px rgba(9,105,218,.6)}}',
      '.rv-pulse{animation:rv-pulse-kf 3000ms ease-in-out 3;border-radius:4px}',
      // reduced motion: no animation — a strong static tint that clears when the class is removed.
      '@media (prefers-reduced-motion:reduce){.rv-pulse{animation:none;background:rgba(9,105,218,.30);box-shadow:inset 4px 0 0 #0969da}}',
      // --- commit-message editing (review-commit-edit.js) ---
      // Track-changes marks, the md viewer's palette: deleted struck rose,
      // inserted amber underline (never a fill — fills read as highlights);
      // sent edits rest in slate until the agent resolves them.
      '#commit del.md-pending-del{color:#9f1239;background:rgba(244,63,94,.12);text-decoration:line-through;border-radius:3px;padding:0 1px}',
      '#commit ins.md-pending-ins{color:#b45309;background:none;text-decoration:underline;text-decoration-thickness:2px;',
      'text-underline-offset:2px;text-decoration-color:rgba(217,119,6,.85);white-space:pre-wrap}',
      '#commit del.md-sent-del{color:#64748b;background:rgba(100,116,139,.14);text-decoration:line-through;border-radius:3px;padding:0 1px}',
      '#commit ins.md-sent-ins{color:#475569;background:none;text-decoration:underline;text-decoration-thickness:2px;',
      'text-underline-offset:2px;text-decoration-color:rgba(100,116,139,.7);white-space:pre-wrap}',
      '#commit ins.md-pending-break{white-space:pre-wrap}',
      '#commit ins.md-pending-break::before{content:"¶";color:rgba(217,119,6,.55)}',
      // The editing surface: entry is loud (md's rule) — a soft amber wash says
      // "this block is now an editor" without restyling the text itself.
      '#commit .md-rendered-editing{outline:none;background:rgba(217,119,6,.07);border-radius:4px;cursor:text}',
      // The held click caret: an empty span that blinks where the edit will
      // begin. Zero-width so it never perturbs the text or anchors.
      '.rv-edit-caret{display:inline-block;width:0;border-left:1.5px solid #b45309;height:1em;',
      'vertical-align:text-bottom;animation:rv-caret-blink 1.06s step-end infinite}',
      '@keyframes rv-caret-blink{0%,100%{opacity:1}50%{opacity:0}}',
      // The edit's one control: note + Revert + Send under the block. Spans the
      // commit body's columns (the section is two-column but the control is a
      // block-level thing, not column content).
      '.rv-edit-compose{column-span:all;max-width:780px;margin:6px 0;background:#f6f8fa;',
      'border:1px solid #d1d9e0;border-radius:6px;padding:8px 9px}',
      // Edit diff inside a card (the un-decorated fallback: lost anchors,
      // amended text) — same vocabulary at card scale.
      '.rv-thread .md-pending-diff-body{white-space:pre-wrap;margin-top:2px}',
      '.rv-thread .md-pending-diff-body del{color:#9f1239;background:rgba(244,63,94,.12);text-decoration:line-through;border-radius:3px;padding:0 1px}',
      '.rv-thread .md-pending-diff-body ins{color:#b45309;text-decoration:underline;text-decoration-thickness:2px;',
      'text-underline-offset:2px;text-decoration-color:rgba(217,119,6,.85)}',
      '.rv-thread .md-pending-diff-old{color:#9f1239;background:rgba(244,63,94,.08)}',
      '.rv-thread .md-pending-diff-new{color:#1a7f37;background:rgba(26,127,55,.08)}',
      '.rv-edit-inplace{color:#6e7781;font-style:italic}',
    ].join('');
    document.head.appendChild(st);
  }
})();
