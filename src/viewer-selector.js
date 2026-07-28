// Viewer selector (Cmd/Ctrl+Shift+U) — modal overlay listing every known viewer
// candidate, merged from scrollback and the live stream, with a filter input: a
// viewer buried deep in the recents list is one typed fragment away. Vanilla DOM,
// no framework — patterned on sessions-picker.
//
// Public API:
//   const handle = createViewerSelector({
//     entries: [{ kind: 'md'|'url'|'review', key }, ...],  // newest first
//     current: { kind, key } | null,   // the viewer open right now, if any
//     onPick(entry):    user chose an entry to open
//     onRemove(entry):  user pressed Delete on an entry (purge from history)
//     onClose():        user dismissed (Esc / clicked outside)
//   });
//   handle.destroy();   // tear down (called by caller after onPick / onClose)
//
// Filtering matches the session picker and search: case-insensitive
// term-intersection substring match against the entry's key, with matched
// ranges highlighted. No fuzzy scoring — the key text is what the user saw in
// the terminal, so a remembered fragment is the natural query.
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

// Kind tag + stripe hue per row: a fast peripheral cue for "what sort of page
// is this" while the eye scans the key text.
function entryTag(entry) {
  if (entry.kind === 'md') return 'md';
  if (entry.kind === 'review') return 'review';
  return /^file:/i.test(entry.key) ? 'file' : 'web';
}

const TAG_HUES = { md: 150, web: 240, file: 80, review: 310 };

function sameEntry(a, b) {
  return !!a && !!b && a.kind === b.kind && a.key === b.key;
}

function createViewerSelector({
  entries = [],
  current = null,
  onPick,
  onRemove,
  onClose,
} = {}) {
  let all = entries.map((e) => ({ kind: e.kind, key: e.key }));
  let filterText = '';
  let visibleRows = [];
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

  // ---- render ----

  function render() {
    const { list, terms } = filterEntries(filterText);
    visibleRows = list;
    listEl.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'at-vsel-divider';
    const filterDisplay = filterText.trim();
    if (!filterDisplay) {
      heading.textContent = 'Recent viewers';
    } else if (visibleRows.length > 0) {
      heading.innerHTML = `Viewers — ${visibleRows.length} of ${all.length} matching <code>${escapeHtml(filterDisplay)}</code>`;
    } else {
      heading.innerHTML = `No viewers match <code>${escapeHtml(filterDisplay)}</code>`;
    }
    listEl.appendChild(heading);

    visibleRows.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'at-vsel-row';
      const tag = entryTag(entry);
      const isCurrent = sameEntry(entry, current);
      const badge = isCurrent ? '<span class="at-vsel-open-badge">open</span>' : '';
      row.innerHTML = `
        <span class="at-vsel-stripe" style="background:oklch(60% 0.14 ${TAG_HUES[tag]})"></span>
        <span class="at-vsel-key">${highlightTerms(entry.key, terms)}</span>
        ${badge}
        <span class="at-vsel-tag">${tag}</span>
      `;
      row.addEventListener('click', () => activate(i));
      listEl.appendChild(row);
    });

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

  return {
    destroy: () => { try { overlay.remove(); } catch {} },
    // exposed for tests
    _state: () => ({ filterText, selectedIndex, visibleRows }),
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
