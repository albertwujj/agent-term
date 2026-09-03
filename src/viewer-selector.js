// Viewer selector (Cmd/Ctrl+Shift+U) — modal overlay listing every known viewer
// candidate, merged from scrollback and the live stream, with a filter input: a
// viewer buried deep in the recents list is one typed fragment away. Vanilla DOM,
// no framework — patterned on sessions-picker.
//
// The known list is what this session has shown. A resumed session reprints a
// slice of its transcript, so a doc from before that slice is not in it, and a
// doc never mentioned never was. Once the filter has three characters the
// selector also searches the disk for every file the band renders (markdown,
// html, images, video, audio, pdf: band-viewable.js): one walk per open
// (repo, siblings, home, see viewer-disk-search.js), filtered in memory per
// keystroke, listed as a second section under the known rows with a running
// count in its heading.
// The walk starts on the first qualifying keystroke, the way the sessions
// picker's hidden-prompt search does, so the section appears by itself.
// Opening a disk row records it, so the second time it is a known row.
//
// Public API:
//   const handle = createViewerSelector({
//     entries: [{ kind: 'md'|'url'|'review', key }, ...],  // newest first
//     current: { kind, key } | null,   // the viewer open right now, if any
//     onPick(entry):    user chose an entry to open; a disk row carries
//                       source: 'disk' and an absolute path as its key, kind
//                       'md' for a doc and 'file' for anything else the band
//                       renders (opened through the file route)
//     onRemove(entry):  user pressed Delete on an entry (purge from history)
//     onClose():        user dismissed (Esc / clicked outside)
//     startDiskSearch({ requestId }):  begin the on-disk walk (optional; the
//                       section is omitted without it)
//     cancelDiskSearch(requestId):     stop it (selector closed while walking)
//   });
//   handle.handleDiskSearchProgress(payload);  // { requestId, done, tier,
//                       cwd, home, files, partial } from the walk, one per
//                       tier + done; partial = that tier ran out of budget
//   handle.destroy();   // tear down (called by caller after onPick / onClose)
//
// Filtering matches the session picker and search: case-insensitive
// term-intersection substring match against the entry's key, with matched
// ranges highlighted. No fuzzy scoring — the key text is what the user saw in
// the terminal, so a remembered fragment is the natural query. Disk rows match
// on their label: repo-relative for a repo doc, ~/-relative under home.
//
// Keyboard:
//   ↑/↓, Tab/Shift+Tab   navigate rows
//   Enter                open the highlighted entry
//   Delete               remove the highlighted entry from the recents list
//   Backspace            same as Delete when the filter is empty
//   Esc                  dismiss → onClose

const {
  parseSearchTerms,
  textMatchesSearchTerms,
  findAllTermRanges,
} = require('./search-terms');
const { diskLabel } = require('./viewer-disk-search');
const { bandViewableKind } = require('./band-viewable');
const { viewerFileUrlToPath } = require('./viewer-history');

// The disk section wakes at three typed characters (spaces aside), like the
// picker's hidden-prompt search, and shows this many rows before asking for
// more letters: the list is for opening one file, and the filter narrows.
const DISK_SEARCH_MIN_CHARS = 3;
const DISK_ROWS_MAX = 12;
let diskSearchSeq = 0;

function diskTermLength(text) {
  return parseSearchTerms(text).join('').length;
}

// A disk row that a known row already stands for. A known file:// row (an
// image or pdf opened from the terminal) covers the disk row for that path.
// Known md keys are what the terminal printed: absolute, ~/-relative,
// repo-relative, or a bare name, so each of those forms is tried against the
// disk path. A bare known name hides every same-named file on disk: the known
// row already resolves through the chooser that lists them.
function knownCoversDiskEntry(known, entry) {
  if (known.kind === 'url') {
    return /^file:/i.test(known.key) && viewerFileUrlToPath(known.key) === entry.key;
  }
  if (known.kind !== 'md' || entry.kind !== 'md') return false;
  const key = String(known.key || '').replace(/^\.\/+/, '');
  if (!key) return false;
  return entry.key === key || entry.label === key || entry.key.endsWith('/' + key);
}

// Kind tag + stripe hue per row: a fast peripheral cue for "what sort of page
// is this" while the eye scans the key text. A local file is tagged by what
// the band renders it as (band-viewable.js), whether it arrived as a file://
// URL from the terminal or as a path from the disk walk.
function entryTag(entry) {
  if (entry.kind === 'md') return 'md';
  if (entry.kind === 'review') return 'review';
  if (entry.kind === 'file') return bandViewableKind(entry.key) || 'file';
  return /^file:/i.test(entry.key) ? (bandViewableKind(entry.key) || 'file') : 'web';
}

const TAG_HUES = {
  md: 150, html: 80, image: 30, video: 350, audio: 200, pdf: 20, web: 240, file: 80, review: 310,
};

function sameEntry(a, b) {
  return !!a && !!b && a.kind === b.kind && a.key === b.key;
}

function createViewerSelector({
  entries = [],
  current = null,
  onPick,
  onRemove,
  onClose,
  startDiskSearch,
  cancelDiskSearch,
} = {}) {
  let all = entries.map((e) => ({ kind: e.kind, key: e.key }));
  let filterText = '';
  let visibleRows = [];
  // The one disk walk of this open: null until the filter first qualifies.
  // files accumulate tier by tier; cwd/home arrive with the first tier and
  // shape the labels.
  let disk = null;
  const diskSearchAvailable = typeof startDiskSearch === 'function';
  // Land the initial selection on the most recent viewer that is NOT the one
  // already open (cmd-tab semantics): plain chord + Enter switches away.
  let selectedIndex = current && all.length > 1 && sameEntry(all[0], current) ? 1 : 0;

  // ---- DOM ----
  const overlay = document.createElement('div');
  // at-modal-overlay marks the modal for document-level Esc handlers to yield
  // (viewer-band's esc-to-hide, the md viewer's keydown) — the modal owns Esc.
  overlay.className = 'at-vsel-overlay at-modal-overlay';
  overlay.innerHTML = `
    <div class="at-vsel-modal" role="dialog" aria-modal="true">
      <div class="at-vsel-header">Open a viewer</div>
      <input class="at-vsel-input" type="text" autocomplete="off" spellcheck="false"
             placeholder="Filter by URL or path…" />
      <div class="at-vsel-list" role="listbox"></div>
      <div class="at-vsel-footer">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        <span>del remove</span>
        <span>esc close</span>
      </div>
    </div>
  `;
  injectStyles();

  const input = overlay.querySelector('.at-vsel-input');
  const listEl = overlay.querySelector('.at-vsel-list');

  // ---- helpers ----

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function highlightTerms(text, terms) {
    const raw = String(text || '');
    const ranges = findAllTermRanges(raw, terms);
    if (ranges.length === 0) return escapeHtml(raw);
    const out = [];
    let idx = 0;
    for (const range of ranges) {
      if (range.start > idx) out.push(escapeHtml(raw.slice(idx, range.start)));
      out.push('<mark class="at-vsel-match">' + escapeHtml(raw.slice(range.start, range.end)) + '</mark>');
      idx = range.end;
    }
    if (idx < raw.length) out.push(escapeHtml(raw.slice(idx)));
    return out.join('');
  }

  function filterEntries(text) {
    const terms = parseSearchTerms(text);
    const list = terms.length === 0
      ? all
      : all.filter((entry) => textMatchesSearchTerms(entry.key, terms));
    return { list, terms };
  }

  // ---- disk search ----

  function ensureDiskSearch() {
    if (disk || !diskSearchAvailable) return;
    const requestId = `disk-${Date.now()}-${++diskSearchSeq}`;
    disk = { requestId, running: true, done: false, partial: false, cwd: null, home: null, files: [], seen: new Set() };
    try { startDiskSearch({ requestId }); }
    catch { disk.running = false; disk.done = true; }
  }

  function handleDiskSearchProgress(payload = {}) {
    if (!disk || payload.requestId !== disk.requestId) return;
    if (payload.cwd) disk.cwd = payload.cwd;
    if (payload.home) disk.home = payload.home;
    if (payload.partial) disk.partial = true;
    const files = Array.isArray(payload.files) ? payload.files : [];
    for (const file of files) {
      const key = String(file || '');
      if (!key || disk.seen.has(key)) continue;
      disk.seen.add(key);
      disk.files.push({
        kind: bandViewableKind(key) === 'md' ? 'md' : 'file',
        key,
        label: diskLabel(key, { cwd: disk.cwd, home: disk.home }),
        tier: payload.tier || null,
        source: 'disk',
      });
    }
    if (payload.done) { disk.running = false; disk.done = true; }
    render();
  }

  function filterDiskEntries(terms) {
    if (!disk || terms.length === 0) return [];
    return disk.files.filter((entry) =>
      textMatchesSearchTerms(entry.label, terms)
      && !all.some((known) => knownCoversDiskEntry(known, entry)));
  }

  // A tier the budget cut short is said in the heading: "none matching" from
  // a partial walk would read as the disk's answer when it is the clock's.
  function diskHeading(matchCount, filterDisplay) {
    const term = `<code>${escapeHtml(filterDisplay)}</code>`;
    const count = matchCount > 0 ? `${matchCount} matching ${term}` : `none matching ${term}`;
    if (disk.running) {
      return matchCount > 0 ? `On disk — ${count} · searching…` : 'On disk — searching…';
    }
    return disk.partial ? `On disk — ${count} · partial walk` : `On disk — ${count}`;
  }

  function appendRow(entry, i, terms) {
    const row = document.createElement('div');
    row.className = 'at-vsel-row';
    const tag = entryTag(entry);
    const isCurrent = sameEntry(entry, current);
    const badge = isCurrent ? '<span class="at-vsel-open-badge">open</span>' : '';
    row.innerHTML = `
      <span class="at-vsel-stripe" style="background:oklch(60% 0.14 ${TAG_HUES[tag]})"></span>
      <span class="at-vsel-key">${highlightTerms(entry.label || entry.key, terms)}</span>
      ${badge}
      <span class="at-vsel-tag">${tag}</span>
    `;
    row.addEventListener('click', () => activate(i));
    listEl.appendChild(row);
  }

  // ---- render ----

  function render() {
    const { list, terms } = filterEntries(filterText);
    listEl.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'at-vsel-divider';
    const filterDisplay = filterText.trim();
    if (!filterDisplay) {
      heading.textContent = all.length > 0
        ? 'Recent viewers'
        : (diskSearchAvailable ? 'No viewers yet · type a name to find one on disk' : 'No viewers yet');
    } else if (list.length > 0) {
      heading.innerHTML = `Viewers — ${list.length} of ${all.length} matching <code>${escapeHtml(filterDisplay)}</code>`;
    } else {
      heading.innerHTML = `No viewers match <code>${escapeHtml(filterDisplay)}</code>`;
    }
    listEl.appendChild(heading);
    list.forEach((entry, i) => appendRow(entry, i, terms));

    // Disk section: present once the walk has started (three typed
    // characters), under the known rows, capped so a broad term asks for
    // more letters instead of a scroll.
    let shown = [];
    if (disk && diskTermLength(filterText) >= DISK_SEARCH_MIN_CHARS) {
      const matches = filterDiskEntries(terms);
      shown = matches.slice(0, DISK_ROWS_MAX);
      const diskDivider = document.createElement('div');
      diskDivider.className = 'at-vsel-divider at-vsel-disk-divider';
      diskDivider.innerHTML = diskHeading(matches.length, filterDisplay);
      listEl.appendChild(diskDivider);
      shown.forEach((entry, i) => appendRow(entry, list.length + i, terms));
      if (matches.length > shown.length) {
        const more = document.createElement('div');
        more.className = 'at-vsel-more';
        more.textContent = `${matches.length - shown.length} more · keep typing to narrow`;
        listEl.appendChild(more);
      }
    }
    visibleRows = [...list, ...shown];

    if (selectedIndex > visibleRows.length - 1) selectedIndex = visibleRows.length - 1;
    if (selectedIndex < 0) selectedIndex = 0;
    applySelectionStyles();
  }

  function applySelectionStyles() {
    const rows = listEl.querySelectorAll('.at-vsel-row');
    rows.forEach((r, idx) => {
      r.classList.toggle('at-vsel-row-selected', idx === selectedIndex);
      r.setAttribute('aria-selected', idx === selectedIndex ? 'true' : 'false');
    });
    const active = rows[selectedIndex];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function moveSelection(delta) {
    if (visibleRows.length === 0) return;
    selectedIndex = (selectedIndex + delta + visibleRows.length) % visibleRows.length;
    applySelectionStyles();
  }

  function activate(index) {
    const entry = visibleRows[index];
    if (!entry) return;
    if (typeof onPick === 'function') onPick({ ...entry });
  }

  function removeSelected() {
    const entry = visibleRows[selectedIndex];
    if (!entry) return;
    // A disk row is not in any history to forget.
    if (entry.source === 'disk') return;
    all = all.filter((candidate) => !sameEntry(candidate, entry));
    if (typeof onRemove === 'function') onRemove({ ...entry });
    render();
  }

  // ---- event handlers ----

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (typeof onClose === 'function') onClose();
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(+1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveSelection(-1); return; }
    if (e.key === 'Enter')     { e.preventDefault(); activate(selectedIndex); return; }
    if (e.key === 'Tab') {
      // Consume Tab (it would move focus to the terminal behind the modal)
      // and treat it as row navigation, matching the sessions picker.
      e.preventDefault();
      moveSelection(e.shiftKey ? -1 : +1);
      return;
    }
    const emptyBackspace = e.key === 'Backspace' && filterText.length === 0
      && !e.altKey && !e.ctrlKey && !e.metaKey;
    if (e.key === 'Delete' || emptyBackspace) {
      e.preventDefault();
      removeSelected();
      return;
    }
  }

  input.addEventListener('input', () => {
    filterText = input.value;
    selectedIndex = 0;
    if (diskTermLength(filterText) >= DISK_SEARCH_MIN_CHARS) ensureDiskSearch();
    render();
  });
  input.addEventListener('keydown', onKeyDown);

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay && typeof onClose === 'function') onClose();
  });

  // ---- mount ----

  document.body.appendChild(overlay);
  render();
  // Defer focus so the event that triggered the selector doesn't blur us.
  setTimeout(() => input.focus(), 0);

  function destroy() {
    if (disk && disk.running && typeof cancelDiskSearch === 'function') {
      try { cancelDiskSearch(disk.requestId); } catch {}
      disk.running = false;
    }
    try { overlay.remove(); } catch {}
  }

  return {
    destroy,
    handleDiskSearchProgress,
    // exposed for tests
    _state: () => ({
      filterText,
      selectedIndex,
      visibleRows,
      disk: disk
        ? { requestId: disk.requestId, running: disk.running, done: disk.done, partial: disk.partial, files: disk.files.length }
        : null,
    }),
  };
}

// ---- styles ----

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  // Chrome-grey palette, keyed to the viewer band's bar/buttons (#45484e /
  // #5a5d63 over the light page): the selector is transient app chrome, not
  // page content, so it wears the chrome greys and looks the same whether it
  // floats over the black terminal or an open light viewer.
  style.textContent = `
.at-vsel-overlay {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(0,0,0,0.55);
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 8vh;
  font: 13px "Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace;
}
.at-vsel-modal {
  background: #26292e;
  border: 1px solid #45484e;
  border-radius: 8px;
  width: min(720px, 92vw);
  max-height: 70vh;
  display: flex; flex-direction: column;
  color: #d0d5db;
  box-shadow: 0 16px 48px rgba(0,0,0,0.5);
  overflow: hidden;
}
.at-vsel-header {
  padding: 12px 16px 6px;
  font-size: 13px;
  color: #9aa1a9;
  letter-spacing: 0.02em;
}
.at-vsel-input {
  margin: 0 12px 8px;
  padding: 8px 10px;
  background: #17191d;
  border: 1px solid #3a3d43;
  border-radius: 4px;
  color: #e6e9ed;
  font: inherit;
  outline: none;
}
.at-vsel-input:focus {
  border-color: #4a90e2;
}
.at-vsel-list {
  overflow-y: auto;
  padding: 0 8px 8px;
  flex: 1 1 auto;
}
.at-vsel-divider {
  padding: 12px 12px 6px;
  font-size: 11px;
  color: #8a9098;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.at-vsel-divider code {
  background: #33363c;
  padding: 1px 6px;
  border-radius: 3px;
  color: #d0d5db;
  text-transform: none;
}
.at-vsel-disk-divider {
  margin-top: 6px;
  border-top: 1px solid #33363c;
}
.at-vsel-more {
  padding: 6px 12px 4px;
  font-size: 11px;
  color: #8a9098;
}
.at-vsel-row {
  display: flex; align-items: baseline; gap: 10px;
  padding: 7px 10px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}
.at-vsel-row:hover {
  background: #2f3238;
}
.at-vsel-row-selected {
  background: #1f3556;
}
.at-vsel-row-selected:hover {
  background: #234071;
}
.at-vsel-stripe {
  flex: 0 0 auto;
  width: 3px;
  border-radius: 1.5px;
  align-self: stretch;
}
.at-vsel-key {
  flex: 1 1 auto; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: #eceff3;
}
.at-vsel-open-badge {
  background: #1d3a1d;
  color: #b6d6b6;
  border-radius: 3px;
  padding: 0 6px;
  font-size: 11px;
  flex: 0 0 auto;
}
.at-vsel-tag {
  flex: 0 0 auto;
  font-size: 11px;
  color: #8a9098;
}
.at-vsel-match {
  background: rgba(255, 213, 88, 0.22);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.at-vsel-footer {
  border-top: 1px solid #3a3d43;
  padding: 8px 14px;
  display: flex; gap: 16px;
  font-size: 11px;
  color: #9aa1a9;
  background: #202329;
}
  `;
  document.head.appendChild(style);
}

module.exports = { createViewerSelector };
