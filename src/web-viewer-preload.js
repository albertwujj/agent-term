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
// Self-contained on purpose: requires only `electron` so it loads under the
// default sandbox with no bundling. No-op on any non-review page (remote
// Gerrit etc.), so it's safe as the partition-wide webview preload.
//
// Divergence from the md viewer's thread layer, deferred to the planned
// unification (review adopts the md model): there, a sent thread awaiting the
// agent rests as a one-line row (click to open). This viewer has no unsent
// queue — comments hit the store on submit — so that doesn't map cleanly;
// port it with the model. The send-count grammar IS shared already: the
// primary counts the open threads its pointer will cover (sendLabel), and
// the secondary is Discard — it destroys the typed draft, never just closes.

const { ipcRenderer } = require('electron');
const { normWS, nearestHeading, toast, createComposer, highlightRange, clearHighlight, highlightRanges, rangeOfText, isPasteCommentShortcut } = require('./comment-ui'); // bundled in by esbuild
const { getViewerShortcutAction } = require('./viewer-shortcut');

(function () {
  if (window.__rvInit) return;
  window.__rvInit = true;

  let commentsUrl = null;
  let store = { threads: [] };
  // Resolved thread ids the user expanded. Resolved threads collapse to a one-line
  // disclosure by default (less clutter); this remembers the ones clicked open.
  // Guest-local, so a full reload re-collapses them — the intended default.
  const expandedSet = new Set();

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    bindHostShortcuts(); // Host shortcuts work on any viewer page, including remote pages.
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
    load();
    pulseDiffDelta(); // scope 1: pulse new diff lines vs the previous render (host-held baseline)
    // Host pings this when the window regains focus, so agent replies / status
    // changes written to disk show up without a manual reload.
    ipcRenderer.on('rv-refresh', function () { load({ pulse: true }); });
    // The out-of-date banner's "Regenerate with latest" button (rendered into the
    // page by review.py) → forward its kind to the host, which prompts the
    // agent with a fixed message. Delegated, so it survives the comment re-renders.
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.rv-regen') : null;
      if (!btn) return;
      e.preventDefault();
      ipcRenderer.invoke('rv-regenerate', { kind: btn.getAttribute('data-rv-regen') || 'refresh' });
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
    // Don't clobber an open composer/reply mid-typing on an external refresh.
    if (document.querySelector('.rv-compose-row, .rv-replybox')) return;
    ipcRenderer.invoke('read-review-comments', commentsUrl).then(function (res) {
      store = (res && res.success && res.data) ? res.data : { threads: [] };
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
    if (document.querySelector('.rv-quote-compose, .rv-compose-row, .rv-replybox')) return;
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !normWS(String(sel))) { hideQuoteButton(); return; }
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    // Only prose / commit message / markdown preview are quote-commentable; code
    // diffs use the line gutter. Skip selections inside our own overlay.
    if (!el || !el.closest('.md-render, #commit')) { hideQuoteButton(); return; }
    if (el.closest('.rv-thread, .rv-quote-compose, .cu-composer, .rv-replybox')) { hideQuoteButton(); return; }
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
      if (e.target.closest('.rv-thread, .rv-quote-compose, .cu-composer, .rv-replybox')) return;
      e.preventDefault();
    });
    document.addEventListener('dblclick', function (e) {
      const t = e.target;
      if (!t || !t.closest || !t.closest('.md-render, #commit')) return;
      if (t.closest('.rv-thread, .rv-quote-compose, .cu-composer, .rv-replybox')) return;
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

  // The guest is a separate WebContents, so host-window shortcuts do not see
  // keystrokes while the page has focus. Forward find and viewer chords.
  function bindHostShortcuts() {
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        try { ipcRenderer.sendToHost('rv-find'); } catch {}
        return;
      }
      const action = getViewerShortcutAction(e, process.platform);
      if (!action) return;
      e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      try { ipcRenderer.sendToHost('viewer-shortcut', action); } catch {}
    }, true);
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

  // The send is a pointer at EVERY open thread (main recounts after the store
  // write), so the primary says what it flushes when that is more than this
  // one — the md viewer's "Send all (n)" grammar, and the same plain "Send":
  // the button's contrast is with moving away (comment kept, agent not
  // pinged), not with commenting. extraOpen is what THIS action adds to the
  // open count: 1 for a new thread or a reply that reopens a resolved one,
  // 0 for a reply on an already-open thread.
  function sendLabel(extraOpen) {
    const n = store.threads.filter(function (t) { return (t.status || 'open') === 'open'; }).length + extraOpen;
    return n > 1 ? 'Send all (' + n + ')' : 'Send';
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
        { label: sendLabel(1), primary: true, onClick: function (ctx) { activeComposer = null; submitNew(anchor, ctx.textarea, ctx.root, true, closeQuoteComposer); } },
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
    td.colSpan = 4;
    const c = createComposer({
      anchorLabel: anchor.path + ':' + anchor.line + ' (' + anchor.side + ')',
      placeholder: 'Comment on this line…',
      onCancel: closeComposer,
      actions: [
        { label: sendLabel(1), primary: true, onClick: function (ctx) { activeComposer = null; submitNew(anchor, ctx.textarea, ctx.root, true, closeComposer); } },
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

  function submitNew(anchor, ta, el, alsoSend, onClose) {
    const body = ta.value.trim();
    if (!body) return;
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
      // The Send primary composes and pings the agent in one action.
      if (alsoSend) sendThread('Comment sent to agent');
      else toast('Comment added');
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

  // Tell the host where the agent's turn stands after every store snapshot:
  // over when no thread still awaits it — each one resolved, or open with the
  // agent's reply as the last word (bounced back to the user). The host uses
  // the flip to restore full size after a send receded to golden (web-viewer.js).
  function reportThreadState() {
    const threads = (store && store.threads) || [];
    const agentTurnOver = threads.length > 0 && threads.every(function (t) {
      if (t.status === 'resolved') return true;
      const msgs = t.messages || [];
      const last = msgs[msgs.length - 1];
      return !!last && last.author === 'agent';
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
    const sec = document.querySelector('section[data-path="' + key + '"]');
    if (!sec) return;
    let row = null;
    if (t.anchor_status !== 'lost' && a.line != null && a.side) {
      const cell = sec.querySelector('[data-side="' + a.side + '"][data-line="' + a.line + '"]');
      row = cell ? cell.closest('tr') : null;
    }
    const card = threadCard(t);
    if (row && row.parentNode) {
      const tr = document.createElement('tr');
      tr.className = 'rv-row';
      const td = document.createElement('td');
      td.colSpan = 4;
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
      const heads = document.querySelectorAll('.md-render h1,.md-render h2,.md-render h3,.md-render h4,.md-render h5,.md-render h6');
      for (let i = 0; i < heads.length; i++) if (normWS(heads[i].textContent) === normWS(a.heading)) return heads[i];
    }
    if (a.path) {
      const key = (window.CSS && CSS.escape) ? CSS.escape(a.path) : a.path;
      const sec = document.querySelector('section[data-path="' + key + '"]');
      if (sec) return sec.querySelector('h1,h2,h3,h4,h5,h6') || sec.firstElementChild;
    }
    return null;
  }

  function threadCard(t, hasHighlight) {
    const a = t.anchor || {};
    const isRegion = !a.side;
    const div = document.createElement('div');
    div.className = 'rv-thread rv-' + (t.status || 'open');
    if (t.id != null) div.setAttribute('data-rv-tid', t.id); // lets applyPulses find this card
    const lost = t.anchor_status === 'lost'
      ? '<div class="rv-lost">↳ ' + (isRegion ? 'quoted text is no longer on the page'
          : ('original ' + esc(a.path) + ':' + esc(a.line) + ' — code changed')) + '</div>' : '';
    const moved = t.anchor_status === 'moved'
      ? '<div class="rv-moved">↻ re-anchored to the current line</div>' : '';
    // The in-place highlight + the card sitting right under its block already show
    // what this is about, so the repeated quote is redundant while anchored — keep
    // it only when there's no highlight (anchor lost / unplaceable), where it's the
    // only handle on what was commented on.
    const quote = (isRegion && a.snippet && !hasHighlight)
      ? '<blockquote class="rv-qtext">' + esc(a.snippet) + '</blockquote>' : '';
    const msgs = (t.messages || []).map(function (m) {
      return '<div class="rv-msg rv-' + (m.author || 'user') + '"><span class="rv-who">'
        + (m.author === 'agent' ? 'Agent' : 'You') + '</span>' + esc(m.body) + '</div>';
    }).join('');
    const resolved = t.status === 'resolved';
    // Resolved threads collapse to a single disclosure line — "✓ Resolved: <first
    // comment…>" — so closed threads stop crowding out the active ones. Click to
    // expand (remembered in expandedSet until the next full reload).
    if (resolved && !expandedSet.has(t.id)) {
      const first = (t.messages || []).find(function (m) { return (m.author || 'user') === 'user'; }) || (t.messages || [])[0];
      const raw = normWS((first && first.body) || '') || '(resolved)';
      const gist = raw.length > 160 ? raw.slice(0, 159) + '…' : raw;
      div.classList.add('rv-collapsed');
      div.innerHTML = '<button class="rv-resolved-head" title="Show thread">'
        + '<span class="rv-resolved-tag">✓ Resolved</span>' + esc(gist) + '</button>';
      div.querySelector('.rv-resolved-head').onclick = function () { expandedSet.add(t.id); renderAndTrack(false); };
      return div;
    }
    // Only `resolved` gets a pill, doubling as the collapse control. There is no
    // "read" state any more (contract.md): the agent ends a thread blocked or
    // done, and "open" is self-evident from the reply sitting right there.
    const badge = resolved
      ? '<button class="rv-badge rv-badge-btn" data-act="collapse" title="Collapse">resolved ▾</button>'
      : '';
    // Comment is a follow-up; the agent owns `resolved` (contract.md), so there
    // is no Resolve button to disagree with it — and no Reopen either, because
    // a follow-up IS the reopen. An OPEN thread also carries Send: moving away
    // from a composer commits the comment to the store with no composer left,
    // so the card itself must offer the ping — it fires the same pointer at
    // every open thread that any composer's Send does.
    const open = (t.status || 'open') === 'open';
    div.innerHTML = badge + lost + moved + quote + msgs
      + '<div class="rv-thread-actions">'
      + '<button class="rv-link" data-act="comment">Comment</button>'
      + (open ? '<button class="rv-link" data-act="send">' + esc(sendLabel(0)) + '</button>' : '')
      + '</div>';
    div.querySelector('[data-act=comment]').onclick = function () { openReply(div, t.id); };
    const sendBtn = div.querySelector('[data-act=send]');
    if (sendBtn) sendBtn.onclick = function () { sendThread('Sent to agent'); };
    const collapseBtn = div.querySelector('[data-act=collapse]');
    if (collapseBtn) collapseBtn.onclick = function () { expandedSet.delete(t.id); renderAndTrack(false); };
    return div;
  }

  function openReply(div, threadId) {
    const existing = div.querySelector('.rv-replybox');
    if (existing) { existing.querySelector('textarea').focus(); return; }
    const box = document.createElement('div');
    box.className = 'rv-replybox'; // mount: appended under the thread
    // A follow-up on a non-open thread reopens it (main.js), so it adds one
    // to the open count the send will point at.
    const target = store.threads.find(function (x) { return x.id === threadId; });
    const reopens = !target || (target.status || 'open') !== 'open';
    const c = createComposer({
      placeholder: 'Comment…',
      rows: 2,
      onCancel: function () { box.remove(); activeComposer = null; },
      actions: [
        { label: sendLabel(reopens ? 1 : 0), primary: true, onClick: function (ctx) { activeComposer = null; sendReply(threadId, ctx.textarea, ctx.root, true); } },
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

  function sendReply(threadId, ta, box, alsoSend) {
    const body = ta.value.trim();
    if (!body) return;
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
        // The Send primary posts the follow-up and pings the agent in one action.
        if (alsoSend) sendThread('Comment sent to agent');
        else toast('Comment added');
      });
  }

  // Ping the agent: pastes a pointer prompt ("read the N open threads in
  // <file>") into its terminal. Pure pointer — the store is the single source
  // of truth, so no thread content (not even the one just composed) rides in
  // the prompt; the count covers everything pending.
  function sendThread(okMsg) {
    ipcRenderer.invoke('rv-send-to-agent', { commentsUrl: commentsUrl }).then(function (res) {
      if (!res || !res.success) { toast((res && res.error) || 'Could not send'); return; }
      toast(okMsg || 'Sent to agent');
      // The host recedes a full-size band to golden on a send (web-viewer.js) —
      // the turn just passed to the agent, whose pickup shows in the terminal.
      try { ipcRenderer.sendToHost('rv-sent'); } catch {}
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
    ].join('');
    document.head.appendChild(st);
  }
})();
