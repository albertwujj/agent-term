// Guards the editing core end to end, driving the REAL src/markdown-viewer.js
// in jsdom through the actual gestures (click → key → edit → blur/Enter/Esc →
// undo → ⌘↩):
//  - first-key dispatch opens the editor; every block — paragraphs, headings,
//    and markup (bold, links, lists) — edits directly on the rendered text
//    (contenteditable); the source is frozen and never touched
//  - committing decorates the block in place — wrapped paragraphs and
//    headings included — never duplicating it
//  - write-back preserves untouched soft-wrap points and the heading marker
//  - Enter commits a rendered edit; Esc reverts; undo dissolves the batch
//  - ⌘↩ sends: the [Edit] envelope carries <del>/<ins>, the disk is NOT
//    written (an edit is a comment), unconsumed edits render sent (slate)
//  - agent changes get the green bar; it ages one level per user send.
// This exists because a strip refactor once crashed the whole pending render
// pass (pending edits lost all presentation) and no test noticed.

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.requestAnimationFrame = dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.matchMedia = dom.window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
}));
if (!dom.window.CSS) dom.window.CSS = { escape: (s) => s };
// The selection-comment path needs the CSS Custom Highlight API; jsdom lacks
// it. Stub the two entry points the viewer checks so the REAL selection code
// runs against real jsdom ranges (not a reimplementation).
if (!dom.window.CSS.highlights) dom.window.CSS.highlights = new Map();
if (!dom.window.Highlight) dom.window.Highlight = class { constructor() {} };
dom.window.Range.prototype.getClientRects = dom.window.Range.prototype.getClientRects
  || (() => [{ width: 10, height: 10, left: 0, right: 10, top: 0, bottom: 10 }]);
dom.window.Range.prototype.getBoundingClientRect = dom.window.Range.prototype.getBoundingClientRect
  || (() => ({ width: 10, height: 10, left: 0, right: 10, top: 0, bottom: 10 }));

const { createMarkdownViewer } = require('../src/markdown-viewer');

// Source lines (1-based): 1 heading | 3-4 wrapped paragraph | 6 single-line
// paragraph | 8 markup line | 10 tail paragraph (stale-thread target)
const FIXTURE = [
  '# Heading Words Here',
  '',
  'A scratch document for validating the comment round-trip. Each',
  'section invites a different kind of comment.',
  '',
  'Second paragraph on one source line only.',
  '',
  'This line has **bold** inline markup in it.',
  '',
  'Tail paragraph stays put.',
  '',
  'A closing paragraph kept clean for the preflight check.',
  '',
  'A spare paragraph kept clean for the enter-send check.',
].join('\n');

// Store mock mimicking main's md-add-threads: tick the turn, one open thread
// per payload, note as a second message.
// Pre-seeded stale sent thread: its envelope line is a PREFIX of the live
// tail paragraph (the doc moved on). It must never strike live text — the
// honest fallback is the sent source box replacing the target.
let store = {
  version: 1,
  turn: 1,
  threads: [{
    id: 't-stale',
    title: '',
    anchor: { snippet: 'Tail paragraph', context: '', wholeBlock: false, heading: '' },
    anchor_status: 'ok',
    status: 'open',
    messages: [{ author: 'user', body: '[Edit]\nTail paragraph<del> junk</del>\n[/Edit]', ts: 1, turn: 1 }],
  }],
};
const sentBatches = [];
let focusTerminalCalls = 0;
// Preflight mock: default "runbook found"; tests flip it to acked/canceled.
let preflightResult = { runbook: '/fake/agent-threads/md/user-intent.md' };
let lastAllowMissingRunbook = null;
const writes = [];
let threadSeq = 0;
// Mutable disk: the test simulates agent writes by mutating these directly.
let diskContent = FIXTURE;
let diskMtime = 1;

const noop = () => {};
const viewer = createMarkdownViewer({
  readMarkdownFile: async () => ({ success: true, path: '/fake/doc.md', content: diskContent, mtimeMs: diskMtime, size: diskContent.length }),
  statMarkdownFile: async () => ({ success: true, mtimeMs: diskMtime, size: diskContent.length }),
  submitMarkdownThreads: async ({ threads, batchKind, allowMissingRunbook }) => {
    sentBatches.push({ threads, batchKind });
    lastAllowMissingRunbook = allowMissingRunbook;
    store = { ...store, turn: store.turn + 1 };
    for (const t of threads) {
      store.threads.push({
        id: `t-${++threadSeq}`,
        title: '',
        anchor: t.anchor,
        anchor_status: 'ok',
        status: 'open',
        messages: [
          { author: 'user', body: t.body, ts: 1, turn: store.turn },
          ...(t.note ? [{ author: 'user', body: t.note, ts: 1, turn: store.turn }] : []),
        ],
      });
    }
    return { success: true, data: store };
  },
  preflightMarkdownRunbook: async () => preflightResult,
  readMarkdownThreads: async () => ({ success: true, data: store }),
  addMarkdownThreadMessage: async () => ({ success: true, data: store }),
  writeMarkdownFile: async ({ content }) => {
    writes.push(content);
    diskContent = content;
    diskMtime += 1;
    return { success: true, path: '/fake/doc.md', mtimeMs: diskMtime, size: content.length };
  },
  showToast: noop,
  openURL: noop,
  getTerminalMetrics: () => ({ cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 }),
  focusTerminal: () => { focusTerminalCalls += 1; },
  openSearchBar: noop,
  closeSearchBar: noop,
  getSearchState: () => ({ isOpen: false }),
  onClose: noop,
  platform: 'darwin',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const primary = () => document.querySelectorAll('.md-viewer-body')[0];
const key = (init) => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, ...init }));

function clickBlock(matchText) {
  const el = Array.from(primary().querySelectorAll('[data-md-anchor-id]'))
    .find((b) => b.textContent.includes(matchText));
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return el;
}

function editing() {
  return primary().querySelector('.md-rendered-editing');
}

// Simulates the outcome of native typing in the contenteditable block, then
// ends the edit via blur, Enter, or Escape.
async function renderedEdit(matchText, newText, endKey = 'blur') {
  clickBlock(matchText);
  await sleep(5);
  key({ key: 'Backspace' });
  await sleep(5);
  const el = editing();
  if (!el) throw new Error(`no rendered editor on ${matchText}`);
  el.textContent = newText;
  // A key fires on the focused editing surface, not the document (capture on
  // document still sees it) — the editor's send/break keys guard on the target.
  if (endKey === 'blur') el.dispatchEvent(new dom.window.Event('blur'));
  else el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: endKey }));
  await sleep(10);
  return el;
}

// Actions rest folded; clicking a pending mark expands the strip first.
async function clickStripButton(label) {
  if (!primary().querySelector('.md-pending-strip:not(.sent)')) {
    const mark = primary().querySelector('del.md-pending-del, ins.md-pending-ins');
    if (mark) {
      mark.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await sleep(10);
    }
  }
  const strip = primary().querySelector('.md-pending-strip:not(.sent)');
  Array.from(strip.querySelectorAll('button')).find((b) => b.textContent === label)
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`); }
}

async function run() {
  await viewer.open({ filePath: '/fake/doc.md' });
  await sleep(30);

  // --- stale sent thread must not bite live text (line-boundary rule) ---
  check('stale thread does not strike text into a longer live line',
    primary().querySelectorAll('p del.md-sent-del').length === 0);
  check('stale thread falls back to the sent box', primary().querySelectorAll('.md-pending-diff.sent').length === 1);

  // --- letters with no clicked target must pass through untouched ---
  {
    const before = document.body.innerHTML.length;
    const ev = new dom.window.KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true });
    const notPrevented = document.dispatchEvent(ev);
    await sleep(10);
    check('a letter without an active target is not consumed',
      notPrevented && !ev.defaultPrevented && document.body.innerHTML.length === before);
  }

  // --- wrapped paragraph: edits directly on the rendered text ---
  clickBlock('A scratch document');
  await sleep(5);
  key({ key: 'Backspace' });
  await sleep(5);
  const para = editing();
  check('backspace enters editing on the rendered block', !!para && para.contentEditable === 'true');
  check('no textarea for a mappable block', !document.querySelector('.md-block-editor'));
  const editStripBtns = Array.from(document.querySelectorAll('.md-editing-strip button'));
  check('a labeled send rides the live edit', editStripBtns.some((b) => b.textContent.startsWith('Send')), editStripBtns.map((b) => b.textContent));
  check('the live-edit control sits inline in the pane', !!(document.querySelector('.md-editing-strip')
    && document.querySelector('.md-editing-strip').closest('.md-spread-pane')));
  check('a clickable undo rides the live edit', editStripBtns.some((b) => b.textContent === 'Undo'));
  check('the live-edit control carries the note field (same control as revisit)',
    !!document.querySelector('.md-editing-strip textarea'));
  {
    // Strike-in-place: the entry Backspace strikes the last char rather than
    // removing it — the text stays whole, one char now sits in a <del>.
    const original = FIXTURE.split('\n').slice(2, 4).join('\n');
    const struck = para && para.querySelector('del.md-pending-del');
    check('entry backspace strikes the last character in place',
      !!struck && struck.textContent === original.slice(-1) && para.textContent === original,
      { struck: struck && struck.textContent, text: para && para.textContent.slice(-8) });
  }

  para.textContent = 'A scratch for validating the comment round-trip. Each\nsection invites a different kind of comment.';
  para.dispatchEvent(new dom.window.Event('blur'));
  await sleep(10);
  const wrapped = primary().querySelector('p.md-pending-block');
  check('wrapped paragraph decorates in place on commit', !!wrapped);
  check('no source box for a mappable edit', primary().querySelectorAll('.md-pending-diff:not(.sent)').length === 0);
  check('decoration strikes exactly the deleted word',
    wrapped && wrapped.querySelector('del.md-pending-del') && wrapped.querySelector('del.md-pending-del').textContent.trim() === 'document');
  check('the block is decorated, not duplicated',
    Array.from(primary().querySelectorAll('p')).filter((el) => el.textContent.includes('A scratch')).length === 1);
  check('the in-edit strip leaves with the edit', !document.querySelector('.md-editing-strip'));
  check('a resting pending edit carries no strip', !primary().querySelector('.md-pending-strip:not(.sent)'));
  wrapped.querySelector('del.md-pending-del').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(10);
  const wrappedNow = primary().querySelector('p.md-pending-block');
  const strip = primary().querySelector('.md-pending-strip:not(.sent)');
  check('clicking the struck text expands the action strip',
    !!(strip && wrappedNow && wrappedNow.nextElementSibling === strip));
  const labels = strip ? Array.from(strip.querySelectorAll('button')).map((b) => b.textContent) : [];
  check('the revealed edit is the shared composer bubble (Undo + Send)',
    !!(strip && labels.includes('Undo') && labels.some((l) => l.startsWith('Send'))), labels);
  check('the note is the composer textarea, same widget as a comment',
    !!(strip && strip.querySelector('textarea') && /note/i.test(strip.querySelector('textarea').placeholder || '')));
  clickBlock('Second paragraph'); // click-away folds
  await sleep(10);
  check('click-away folds the strip', !primary().querySelector('.md-pending-strip:not(.sent)'));

  await clickStripButton('Undo');
  await sleep(10);
  check('undo restores the paragraph',
    Array.from(primary().querySelectorAll('p')).some((el) => el.textContent.includes('A scratch document')));
  check('undo leaves no pending presentation',
    primary().querySelectorAll('.md-pending-diff:not(.sent), .md-pending-block, .md-pending-strip:not(.sent)').length === 0);

  // --- a word-merge edit strikes only what was removed (no duplication) ---
  // "one source" -> "onesource" (delete the space). A prior word-snap turned
  // this into a duplicated "one onesource"; the minimal diff strikes just the
  // removed space.
  {
    clickBlock('Second paragraph');
    await sleep(5);
    key({ key: 'Backspace' });
    await sleep(5);
    const ed = editing();
    ed.textContent = 'Second paragraph on onesource line only.';
    ed.dispatchEvent(new dom.window.Event('blur'));
    await sleep(10);
    const merged = primary().querySelector('p.md-pending-block');
    const del = merged && merged.querySelector('del.md-pending-del');
    check('word-merge edit strikes only the removed space',
      !!del && del.textContent === ' ' && !merged.querySelector('ins.md-pending-ins'), del && JSON.stringify(del.textContent));
    check('word-merge edit does not duplicate the word',
      merged && (merged.textContent.match(/source/g) || []).length === 1, merged && merged.textContent);
    await clickStripButton('Undo'); // undo
    await sleep(10);
  }

  // --- undo works even when a commit-adjacent click left a comment target ---
  await renderedEdit('A scratch document', 'A scratch for validating the comment round-trip. Each\nsection invites a different kind of comment.');
  clickBlock('Second paragraph'); // sets the active comment target
  await sleep(10);
  await clickStripButton('Undo');
  await sleep(10);
  check('undo re-renders even with an active comment target',
    !primary().querySelector('p.md-pending-block') && !primary().querySelector('.md-pending-strip:not(.sent)')
    && Array.from(primary().querySelectorAll('p')).some((el) => el.textContent.includes('A scratch document')));

  // --- heading edits on its rendered text, marker invisible ---
  clickBlock('Heading');
  await sleep(5);
  key({ key: 'Backspace' });
  await sleep(5);
  const h1edit = editing();
  check('heading edits on the rendered text without its marker',
    !!h1edit && h1edit.tagName === 'H1' && !h1edit.textContent.includes('#'));
  h1edit.textContent = 'Heading Deeds Here';
  h1edit.dispatchEvent(new dom.window.Event('blur'));
  await sleep(10);
  const h1 = primary().querySelector('h1.md-pending-block');
  check('heading decorates in place after commit', !!h1);
  check('heading decoration carries del/ins', !!(h1 && h1.querySelector('del.md-pending-del') && h1.querySelector('ins.md-pending-ins')));
  await clickStripButton('Undo');
  await sleep(10);

  // --- stray spaces from word deletion stay on the typeset path ---
  for (const [label, value] of [['double space', 'Heading  Here'], ['trailing space', 'Heading Words '], ['leading space', ' Words Here']]) {
    await renderedEdit('Heading', value);
    check(`${label} still decorates the heading in place`,
      !!primary().querySelector('h1.md-pending-block') && primary().querySelectorAll('.md-pending-diff:not(.sent)').length === 0);
    await clickStripButton('Undo');
    await sleep(10);
  }

  // --- Esc reverts a rendered edit ---
  await renderedEdit('Second paragraph', 'Second paragraph rewritten entirely.', 'Escape');
  check('esc reverts the rendered edit',
    Array.from(primary().querySelectorAll('p')).some((el) => el.textContent === 'Second paragraph on one source line only.')
    && !editing() && primary().querySelectorAll('.md-pending-block').length === 0);

  // --- markup block strikes in place, like prose (the source textarea is gone) ---
  {
    // Click the markup line, select the word "bold" (its own text node inside
    // <strong>), and ⌫: the entry key strikes the selection in place on the
    // rendered contenteditable — no source textarea anywhere.
    clickBlock('bold');
    await sleep(5);
    const markupP = Array.from(primary().querySelectorAll('p')).find((el) => el.textContent.includes('bold'));
    const boldNode = markupP.querySelector('strong').firstChild;
    const range = document.createRange();
    range.setStart(boldNode, 0);
    range.setEnd(boldNode, 'bold'.length);
    const sel = dom.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    key({ key: 'Backspace' });
    await sleep(5);
    const ed = editing();
    check('markup block edits on the rendered surface, no source textarea',
      !!ed && ed.contentEditable === 'true' && !document.querySelector('.md-block-editor'));
    const struck = ed && ed.querySelector('del.md-pending-del');
    check('striking a markup word marks it in place, not in a textarea',
      !!struck && struck.textContent === 'bold' && !document.querySelector('.md-block-editor'), struck && struck.textContent);
    ed.dispatchEvent(new dom.window.Event('blur'));
    await sleep(10);
    const marked = primary().querySelector('p.md-pending-block');
    // The overlay strikes the RENDERED word inside its <strong>; the raw ** never
    // enters the decoration (nor, therefore, the [Edit] envelope that overlayToEnvelope
    // derives from these same marks — the real-app drive asserts the sent body).
    check('the markup edit rests decorated in place, striking the rendered word',
      !!marked && marked.querySelector('strong del.md-pending-del')
      && marked.querySelector('strong del.md-pending-del').textContent === 'bold');
    check('the markup decoration carries no source syntax',
      !!marked && !marked.innerHTML.includes('**') && primary().querySelectorAll('.md-pending-diff:not(.sent)').length === 0);
    await clickStripButton('Undo'); // clean the block for the sections below
    await sleep(10);
  }

  // --- queued comments rest as marks; click reopens the composer ---
  clickBlock('bold');
  await sleep(5);
  key({ key: 'k' }); // letter enters comment mode
  await sleep(10);
  const composer = document.querySelector('.md-comment-card textarea, textarea.cu-ta');
  check('a letter on a target opens the comment composer', !!composer);
  composer.value = 'keep this list tight';
  clickBlock('Second paragraph'); // click away queues the draft
  await sleep(10);
  const qmark = primary().querySelector('.md-queued-comment-mark');
  check('a clicked-away comment rests as a small mark, not a card',
    !!qmark && !primary().querySelector('.md-queued-comment-card'));
  check('the mark reads the draft back on hover', qmark && qmark.title.includes('keep this list tight'), qmark && qmark.title);
  qmark.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(10);
  const reopened = document.querySelector('.md-comment-card textarea, textarea.cu-ta');
  check('clicking the mark reopens the composer with the draft', !!reopened && reopened.value === 'keep this list tight');
  reopened.value = '';
  clickBlock('Second paragraph'); // empty draft dissolves
  await sleep(10);
  check('an emptied draft leaves nothing behind',
    !primary().querySelector('.md-queued-comment-mark') && !document.querySelector('.md-comment-card textarea, textarea.cu-ta'));
  clickBlock('Second paragraph'); // clear the lingering active target
  await sleep(10);
  key({ key: 'Escape' });
  await sleep(10);

  // --- an edit and a comment on the SAME block coexist, and the edit stays
  //     rollback-able. layoutSpread freezes on any queued comment (its rebuild
  //     would wipe the marks), which used to leave a commit/undo on a commented
  //     block unrendered — the edit was neither shown nor undoable. ---
  clickBlock('Second paragraph');
  await sleep(5);
  key({ key: 'n' }); // letter -> comment on this block
  await sleep(10);
  const shComposer = document.querySelector('.md-comment-card textarea, textarea.cu-ta');
  check('a comment opens on the block to be edited', !!shComposer);
  if (shComposer) shComposer.value = 'a note on this block';
  clickBlock('bold'); // click away queues the comment
  await sleep(10);
  check('the comment rests as a mark before the edit', !!primary().querySelector('.md-queued-comment-mark'));
  // Edit the SAME block while its comment is queued.
  await renderedEdit('Second paragraph', 'Second paragraph on ONE source line only.', 'blur');
  await sleep(10);
  check('an edit on a commented block renders (not frozen by the queued comment)',
    primary().querySelectorAll('.md-viewer-body .md-pending-block, .md-viewer-body ins.md-pending-ins, .md-viewer-body del.md-pending-del').length > 0);
  check('the comment mark survives the edit re-render', !!primary().querySelector('.md-queued-comment-mark'));
  // The edit's Undo is reachable: clicking the struck/inserted text reveals the bubble.
  const shMark = primary().querySelector('.md-viewer-body ins.md-pending-ins, .md-viewer-body del.md-pending-del');
  shMark.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(10);
  const shStrip = primary().querySelector('.md-pending-strip:not(.sent)');
  check('the edit is rollback-able on a commented block (Undo in the bubble)',
    !!(shStrip && Array.from(shStrip.querySelectorAll('button')).some((b) => b.textContent === 'Undo')));
  await clickStripButton('Undo');
  await sleep(10);
  check('undo clears the edit but keeps the comment',
    primary().querySelectorAll('.md-pending-block, ins.md-pending-ins, del.md-pending-del').length === 0
      && !!primary().querySelector('.md-queued-comment-mark'));
  // Clean up so the block is pristine for the selection section below.
  primary().querySelector('.md-queued-comment-mark').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(10);
  const shCleanup = document.querySelector('.md-comment-card textarea, textarea.cu-ta');
  if (shCleanup) shCleanup.value = '';
  clickBlock('bold');
  await sleep(10);
  key({ key: 'Escape' });
  await sleep(10);

  // --- SELECTION comment (drag-select + letter) also rests as a mark ---
  // (the block-comment path above shares the queue plumbing, but the
  // selection path reaches it differently — this is the case the real app
  // exercises and the jsdom suite previously missed.)
  {
    const target = Array.from(primary().querySelectorAll('p'))
      .find((el) => el.textContent.includes('one source line only'));
    const node = Array.from(target.childNodes).find((n) => n.nodeType === 3 && n.textContent.includes('source'));
    const at = node.textContent.indexOf('source');
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 'source'.length);
    const sel = dom.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    primary().dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(10);
    key({ key: 'c' }); // letter opens the selection comment composer
    await sleep(10);
    const selComposer = document.querySelector('.md-comment-card textarea, textarea.cu-ta');
    check('a letter on a live selection opens the comment composer', !!selComposer);
    if (selComposer) {
      selComposer.value = 'tighten this phrase';
      clickBlock('This line has'); // click away queues the selection comment
      await sleep(10);
      check('a queued SELECTION comment rests as a mark, not a card',
        !!primary().querySelector('.md-queued-comment-mark') && !primary().querySelector('.md-queued-comment-card'));
      const selMark = primary().querySelector('.md-queued-comment-mark');
      check('the selection-comment mark reads the draft back', selMark && selMark.title.includes('tighten this phrase'));
      selMark.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await sleep(10);
      const selReopen = document.querySelector('.md-comment-card textarea, textarea.cu-ta');
      check('clicking the selection mark reopens its composer', !!selReopen && selReopen.value === 'tighten this phrase');
      selReopen.value = '';
      clickBlock('This line has');
      await sleep(10);
      clickBlock('This line has');
      await sleep(10);
      key({ key: 'Escape' });
      await sleep(10);
    }
  }

  // --- agent change lands with the fresh green bar (age 0) ---
  diskContent = diskContent.replace(
    'section invites a different kind of comment.',
    'section invites a different kind of comment today.',
  );
  diskMtime += 1;
  await sleep(1700); // refresh poll + debounce
  const changedP = () => Array.from(primary().querySelectorAll('p')).find((el) => el.textContent.includes('comment today'));
  check('agent change lands with the fresh green bar',
    !!changedP() && changedP().classList.contains('md-change-bar')
    && !changedP().classList.contains('md-change-age-1') && !changedP().classList.contains('md-change-age-2'));

  // --- three rendered edits, one batch: wrap points and marker preserved ---
  await renderedEdit('A scratch document', 'A scratch document for validating the comment. Each\nsection invites a different kind of comment today.');
  await renderedEdit('Second paragraph', 'Second paragraph on a single source line only.');
  await renderedEdit('Heading', 'Heading Here');

  key({ key: 'Enter', metaKey: true });
  await sleep(30);
  check('send never writes the document (an edit is a comment)', writes.length === 0, writes.length);
  check('three edit threads sent', sentBatches.length === 1 && sentBatches[0].threads.length === 3, sentBatches[0] && sentBatches[0].threads.length);
  const bodies = (sentBatches[0] ? sentBatches[0].threads : []).map((t) => t.body || '');
  check('soft-wrapped edit reaches the agent, line boundary intact',
    bodies.some((b) => b.includes('for validating the comment') && b.includes('. Each')), bodies);
  check('heading edit keeps its marker in the envelope',
    bodies.some((b) => b.includes('# Heading')), bodies);
  check('single-line edit reaches the agent',
    bodies.some((b) => b.includes('source line only')), bodies);
  check('envelopes carry merged <del>/<ins>', bodies.some((b) => /\[Edit\]\n.*<del>.*<\/del><ins>.*<\/ins>.*\n\[\/Edit\]/s.test(b)), bodies);
  check('empty tags are omitted from envelopes', bodies.every((b) => !b.includes('<ins></ins>') && !b.includes('<del></del>')));
  check('batchKind is edits', sentBatches[0] && sentBatches[0].batchKind === 'edits');
  await sleep(20);
  check('sent paragraph decorates slate in place', !!primary().querySelector('p.md-sent-block'));
  check('sent heading decorates slate in place', !!primary().querySelector('h1.md-sent-block'));
  check('no pending presentation remains after send',
    primary().querySelectorAll('.md-pending-block, .md-pending-diff:not(.sent)').length === 0);
  check('the agent-change bar ages one level on send (turn clock)',
    !!changedP() && changedP().classList.contains('md-change-bar') && changedP().classList.contains('md-change-age-1'));

  // --- the sent edit seals its block: amber border, no chip, no in-place re-edit ---
  check('the sent edit seals its block', !!primary().querySelector('p.md-sealed') && !!primary().querySelector('h1.md-sealed'));
  check('the sealed block drops the awaiting-agent chip (the border is the signal)',
    !primary().textContent.includes('awaiting agent'));
  clickBlock('Second paragraph');
  await sleep(5);
  key({ key: 'Backspace' });
  await sleep(5);
  check('a sealed block refuses in-place editing (roll back to change)', !editing());
  key({ key: 'Escape' });
  await sleep(5);

  // --- runbook preflight: cancel sends nothing; ack sends with the flag ---
  {
    const writesBefore = writes.length;
    const sentBefore = sentBatches.length;
    // Cancel: the edit stays pending, nothing sent (and never written). Use a
    // clean block — the earlier batch sealed "Second paragraph" (a sent edit is
    // no longer editable in place).
    preflightResult = { canceled: true };
    await renderedEdit('A closing paragraph', 'A closing paragraph, revised for preflight.');
    key({ key: 'Enter', metaKey: true });
    await sleep(20);
    check('preflight cancel writes nothing and sends nothing',
      writes.length === writesBefore && sentBatches.length === sentBefore);
    check('preflight cancel leaves the edit pending', !!primary().querySelector('p.md-pending-block'));

    // Ack: the same pending edit now sends, flagged allow-missing-runbook.
    preflightResult = { runbook: null, acked: true };
    key({ key: 'Enter', metaKey: true });
    await sleep(30);
    check('preflight ack sends the batch', sentBatches.length === sentBefore + 1);
    check('preflight ack passes allowMissingRunbook', lastAllowMissingRunbook === true, lastAllowMissingRunbook);
    check('preflight ack still writes nothing', writes.length === writesBefore);
  }

  // --- Enter on the edit surface sends (like a comment and like Cmd+Enter);
  //     Shift+Enter never sends (a line break belongs in a text box) ---
  {
    preflightResult = { runbook: '/fake/agent-threads/md/user-intent.md' };
    const sentBefore = sentBatches.length;
    const fcBefore = focusTerminalCalls;
    clickBlock('A spare paragraph');
    await sleep(5);
    key({ key: 'Backspace' }); // opens the in-place editor on the active block
    await sleep(5);
    const el = editing();
    check('the spare block opens for editing', !!el);
    el.textContent = 'A spare paragraph, revised for the send check.';
    // Shift+Enter never sends on the in-place surface — the editor stays open.
    el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Enter', shiftKey: true }));
    await sleep(10);
    check('shift+enter does not send', sentBatches.length === sentBefore, sentBatches.length - sentBefore);
    check('shift+enter keeps the editor open', !!editing());
    // Plain Enter: commits and sends, exactly like Cmd+Enter.
    el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    await sleep(30);
    check('enter sends the edit', sentBatches.length === sentBefore + 1, sentBatches.length - sentBefore);
    check('enter seals the sent block', !!primary().querySelector('p.md-sealed') && !editing());
    check('enter hands the keyboard back to the terminal', focusTerminalCalls > fcBefore);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0); // the viewer's poll interval would keep node alive
}

run().catch((e) => { console.error(e); process.exit(1); });
