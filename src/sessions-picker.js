// Sessions picker — modal overlay that surfaces past sessions for resume and
// auto-completes CLI names for new sessions. Vanilla DOM, no framework.
//
// Public API:
//   const handle = createPicker({
//     sessions: [{ id, hue, cli, title, prompt, isActive, lastEventAt }, ...],
//     activeIds: [number],          // ids that are currently active (disabled in list)
//     onPick(id):           user resumed a past session
//     onStartNew(cli):      user started a new session (cli = 'claude'|'codex'|... or null for shell)
//     onClose():            user dismissed the picker (Esc / clicked outside / Enter on row 0 with no CLI)
//   });
//   handle.destroy();   // tear down (called by caller after onPick / onStartNew / onClose)
//
// The text input does double duty:
//   - filters the past-sessions list by case-insensitive word intersection on
//     title + prompt text
//   - drives the "Start new session" row's CLI suggestion via prefix match
//     against KNOWN_CLIS; an exact-or-unique-prefix match autocompletes to
//     that CLI; otherwise the literal filter text is shown (and would be
//     typed verbatim into the shell on Enter).
//
// Keyboard:
//   ↑/↓        navigate between rows (skipping disabled active rows)
//   Enter      activate the highlighted row
//   Esc        dismiss → onClose
//   Delete     on a past-session row: remove it from the picker for this
//              session (in-memory only; sessions-log unchanged)

const KNOWN_CLIS = ['claude', 'codex', 'copilot', 'agent'];
const cliIcons = require('./cli-icons');
const { cleanAiTitle, aiTitleDedupeKey } = require('./ai-title');
const {
  normalizeSearchText,
  parseSearchTerms,
  textMatchesSearchTerms,
  findAllTermRanges,
} = require('./search-terms');
// Brand glyph in past-session rows: small + dim, placed at the row's
// right edge near the age timestamp. The icon is secondary metadata
// (the prompt text is what the user is scanning), so it lives in the
// peripheral right-side cluster, not in the prompt's eye-line.
const ROW_ICON_PX = 14;
const DEEP_SEARCH_MIN_CHARS = 3;
const DEEP_SEARCH_DEBOUNCE_MS = 250;

function createPicker({
  sessions = [],
  activeIds = [],
  startHiddenPromptSearch,
  cancelHiddenPromptSearch,
  deepSearchDebounceMs = DEEP_SEARCH_DEBOUNCE_MS,
  onPick,
  onStartNew,
  onClose,
} = {}) {
  const activeSet = new Set(activeIds);
  let dismissedIds = new Set();   // local per-render filter, lets user temporarily hide rows
  let filterText = '';
  let selectedIndex = 0;          // 0 = "start new" row; 1..N map into visibleRows[]
  let visibleRows = [];
  let mode = 'normal';            // normal | deep
  let deepSearchTimer = null;
  let deepSearchSeq = 0;
  let activeSearchRequestId = null;
  let deepSearchState = null;     // {requestId, term, running, done, matchCount, sessions}

  // ---- DOM ----
  const overlay = document.createElement('div');
  // at-modal-overlay: document-level Esc handlers (viewer-band's esc-to-hide,
  // the md viewer's keydown) yield while the picker is up.
  overlay.className = 'at-picker-overlay at-modal-overlay';
  overlay.innerHTML = `
    <div class="at-picker-modal" role="dialog" aria-modal="true">
      <div class="at-picker-header">Resume or start a session</div>
      <input class="at-picker-input" type="text" autocomplete="off" spellcheck="false"
             placeholder="Type a CLI name (claude, codex, copilot, agent) or filter past sessions…" />
      <div class="at-picker-list" role="listbox"></div>
      <div class="at-picker-footer">
        <span>↑↓ navigate</span>
        <span>↵ select</span>
        <span>del hide</span>
        <span>esc skip</span>
      </div>
    </div>
  `;
  injectStyles();

  const input = overlay.querySelector('.at-picker-input');
  const listEl = overlay.querySelector('.at-picker-list');
  const modalEl = overlay.querySelector('.at-picker-modal');

  // ---- helpers ----

  function detectCliFromFilter(text) {
    const t = (text || '').trim().toLowerCase();
    if (!t) return null;
    if (KNOWN_CLIS.includes(t)) return t;
    const matches = KNOWN_CLIS.filter(c => c.startsWith(t));
    if (matches.length === 1) return matches[0];
    return null;
  }

  function filterSessions(text) {
    const t = normalizeSearchText(text).toLowerCase();
    const terms = parseSearchTerms(t);
    const beforeFilter = sessions.filter(s => !dismissedIds.has(s.id));
    let list = beforeFilter;
    if (terms.length > 0) {
      list = list.filter(s => {
        // Free-form term-intersection match: prompt + lastPrompt + subject titles.
        // Both `initialTitle` (frozen subject) and `title` (latest OSC) go
        // in — the user might remember either. We deliberately EXCLUDE
        // s.cli from the haystack — typing "cl" with the intent "start a
        // claude" already pins row 0 to the new-claude action; we don't
        // want to also flood the past list with every claude session ever,
        // since that drowns out the cases where the user typed something
        // topical like "rate database".
        const haystack = [
          cleanAiTitle(s.initialTitle, s.cli),
          cleanAiTitle(s.title, s.cli),
          s.prompt,
          s.lastPrompt,
          // Branches captured from review:// links — find a session by the
          // branch it reviewed.
          (s.capturedBranches || []).join(' '),
        ].filter(Boolean).join(' ');
        return textMatchesSearchTerms(haystack, terms);
      });
    }
    list.sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
    return { list, total: beforeFilter.length, term: t, terms };
  }

  function normalizedDeepTerm(text) {
    return normalizeSearchText(text).toLowerCase();
  }

  function currentDeepResult() {
    const term = normalizedDeepTerm(filterText);
    if (!deepSearchState || deepSearchState.term !== term) return null;
    if (!deepSearchState.matchCount) return null;
    return deepSearchState;
  }

  function currentDeepStatus() {
    const term = normalizedDeepTerm(filterText);
    if (!deepSearchState || deepSearchState.term !== term) return null;
    return deepSearchState;
  }

  function deepVisibleRows() {
    const result = currentDeepResult();
    if (!result || !Array.isArray(result.sessions)) return [];
    return result.sessions.filter(s => !dismissedIds.has(s.id));
  }

  function hiddenMatchLabel(count, running = false) {
    const n = `${count}${running ? '+' : ''}`;
    return `${n} hidden prompt ${count === 1 ? 'match' : 'matches'}`;
  }

  function hiddenStatHtml(result) {
    if (!result || !result.matchCount) return '';
    return ` — <button type="button" class="at-picker-inline-action at-picker-hidden-stat">${escapeHtml(hiddenMatchLabel(result.matchCount, result.running))}</button>`;
  }

  function deepModeCountLabel(result) {
    if (!result || !result.matchCount) return '';
    const n = `${result.matchCount}${result.running ? '+' : ''}`;
    return `${n} ${result.matchCount === 1 ? 'match' : 'matches'}`;
  }

  function attachHeadingActions(heading) {
    const stat = heading.querySelector('.at-picker-hidden-stat');
    if (stat) {
      stat.addEventListener('click', (e) => {
        e.preventDefault();
        mode = 'deep';
        selectedIndex = 0;
        render();
      });
    }
  }

  function cancelActiveHiddenSearch() {
    if (deepSearchTimer) {
      clearTimeout(deepSearchTimer);
      deepSearchTimer = null;
    }
    if (activeSearchRequestId && typeof cancelHiddenPromptSearch === 'function') {
      try { cancelHiddenPromptSearch(activeSearchRequestId); } catch {}
    }
    activeSearchRequestId = null;
  }

  function scheduleDeepSearch() {
    cancelActiveHiddenSearch();
    const term = normalizedDeepTerm(filterText);
    deepSearchSeq++;
    if (typeof startHiddenPromptSearch !== 'function' || term.length < DEEP_SEARCH_MIN_CHARS) {
      deepSearchState = null;
      if (mode === 'deep') mode = 'normal';
      return;
    }

    const seq = deepSearchSeq;
    const query = filterText.trim();
    deepSearchTimer = setTimeout(() => {
      deepSearchTimer = null;
      if (seq !== deepSearchSeq) return;
      const requestId = `hidden-${Date.now()}-${seq}`;
      activeSearchRequestId = requestId;
      deepSearchState = {
        requestId,
        term,
        running: true,
        done: false,
        matchCount: 0,
        sessions: [],
      };
      render();
      try { startHiddenPromptSearch({ requestId, query }); }
      catch {
        if (activeSearchRequestId !== requestId) return;
        activeSearchRequestId = null;
        deepSearchState = { ...deepSearchState, running: false, done: true };
        render();
      }
    }, Math.max(0, deepSearchDebounceMs));
  }

  function mergeHiddenSearchSessions(existingSessions, incomingSessions) {
    const merged = [];
    const byId = new Map();
    for (const s of existingSessions || []) {
      const copy = { ...s, hiddenMatches: Array.isArray(s.hiddenMatches) ? s.hiddenMatches.slice() : [] };
      merged.push(copy);
      byId.set(copy.id, copy);
    }
    for (const s of incomingSessions || []) {
      if (!s || typeof s.id !== 'number') continue;
      const existing = byId.get(s.id);
      if (existing) {
        existing.hiddenMatchCount = s.hiddenMatchCount || existing.hiddenMatchCount || 0;
        existing.hiddenMatches = Array.isArray(s.hiddenMatches) ? s.hiddenMatches.slice() : existing.hiddenMatches;
        Object.assign(existing, {
          hue: s.hue,
          cli: s.cli,
          title: s.title,
          prompt: s.prompt,
          lastEventAt: s.lastEventAt,
          isActive: s.isActive,
          isHidden: s.isHidden,
        });
      } else {
        const copy = { ...s, hiddenMatches: Array.isArray(s.hiddenMatches) ? s.hiddenMatches.slice() : [] };
        merged.push(copy);
        byId.set(copy.id, copy);
      }
    }
    return merged;
  }

  function handleHiddenSearchProgress(payload = {}) {
    if (!deepSearchState) return;
    if (!payload || payload.requestId !== deepSearchState.requestId) return;
    if (payload.query && normalizedDeepTerm(payload.query) !== deepSearchState.term) return;

    const sessions = mergeHiddenSearchSessions(deepSearchState.sessions, payload.sessions);
    const computedCount = sessions.reduce((sum, s) => sum + (s.hiddenMatchCount || 0), 0);
    const matchCount = Number.isFinite(Number(payload.matchCount))
      ? Number(payload.matchCount)
      : computedCount;
    const done = !!payload.done;
    deepSearchState = {
      ...deepSearchState,
      sessions,
      matchCount,
      done,
      running: !done,
    };
    if (done && activeSearchRequestId === deepSearchState.requestId) {
      activeSearchRequestId = null;
    }
    if (mode === 'deep' && matchCount === 0) mode = 'normal';
    render();
  }

  // Wrap matched terms inside `text` with <mark>, escaping the rest for
  // safety. Terms are merged before rendering so overlapping partial matches
  // never produce nested mark elements.
  function highlightRanges(text, ranges) {
    const raw = String(text || '');
    const validRanges = (Array.isArray(ranges) ? ranges : [])
      .map(r => ({
        start: Math.max(0, Math.min(raw.length, Number(r.start) || 0)),
        end: Math.max(0, Math.min(raw.length, Number(r.end) || 0)),
      }))
      .filter(r => r.end > r.start)
      .sort((a, b) => a.start - b.start || b.end - a.end);
    if (validRanges.length === 0) return escapeHtml(raw);

    const out = [];
    let idx = 0;
    for (const range of validRanges) {
      if (range.start < idx) continue;
      if (range.start > idx) out.push(escapeHtml(raw.slice(idx, range.start)));
      out.push('<mark class="at-picker-match">' + escapeHtml(raw.slice(range.start, range.end)) + '</mark>');
      idx = range.end;
    }
    if (idx < raw.length) out.push(escapeHtml(raw.slice(idx)));
    return out.join('');
  }

  function highlightSearchTerms(text, terms) {
    return highlightRanges(text, findAllTermRanges(text, terms));
  }

  function renderHiddenMatchLines(matches) {
    if (!Array.isArray(matches) || matches.length === 0) return '';
    return matches.map((m) => {
      const ranges = Array.isArray(m.ranges)
        ? m.ranges
        : [{ start: m.matchStart, end: m.matchEnd }];
      return `
      <div class="at-picker-hidden-match-line">
        <span class="at-picker-last-prefix">↳</span>
        <span class="at-picker-match-viewport">
          <span class="at-picker-match-text">${highlightRanges(m.text, ranges)}</span>
        </span>
      </div>
    `;
    }).join('');
  }

  function alignHiddenMatchLines() {
    const viewports = listEl.querySelectorAll('.at-picker-match-viewport');
    for (const viewport of viewports) {
      const textEl = viewport.querySelector('.at-picker-match-text');
      const mark = viewport.querySelector('mark');
      if (!textEl || !mark) continue;

      textEl.style.transform = '';
      const viewportWidth = viewport.clientWidth || 0;
      const textWidth = textEl.scrollWidth || 0;
      if (!viewportWidth || !textWidth || textWidth <= viewportWidth) continue;

      const targetX = Math.round(viewportWidth * 0.40);
      const markX = mark.offsetLeft || 0;
      const blankLimit = 24;
      const maxTx = blankLimit;
      const minTx = Math.min(0, viewportWidth - textWidth - blankLimit);
      const tx = Math.max(minTx, Math.min(maxTx, targetX - markX));
      textEl.style.transform = `translateX(${Math.round(tx)}px)`;
    }
  }

  function scheduleAlignHiddenMatchLines() {
    const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
    raf(() => alignHiddenMatchLines());
  }

  function relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  // ---- render ----

  function render() {
    const previousSelectedSessionId = mode === 'deep' && visibleRows[selectedIndex]
      ? visibleRows[selectedIndex].id
      : null;
    const filtered = filterSessions(filterText);
    const isDeepMode = mode === 'deep';
    const deepStatus = currentDeepStatus();
    const deepResult = deepStatus && deepStatus.matchCount ? deepStatus : null;
    visibleRows = isDeepMode ? deepVisibleRows() : filtered.list;
    if (isDeepMode && previousSelectedSessionId !== null) {
      const nextSelected = visibleRows.findIndex(s => s.id === previousSelectedSessionId);
      if (nextSelected !== -1) selectedIndex = nextSelected;
    }
    const detectedCli = detectCliFromFilter(filterText);
    let newSessionLabel;
    if (detectedCli) {
      // Row 0 is the "start new" autocomplete affordance — the user is
      // typing, looking for feedback on what they typed and how it
      // expanded. Render the CLI name in TEXT with the typed prefix
      // bolded so they can see character-by-character that "cl" →
      // "claude" (vs. an icon which would tell them nothing about the
      // match). The icon's job — visual identification of an existing
      // session — happens on the past-session rows below.
      const typed = filterText.trim();
      const matchedLen = Math.min(typed.length, detectedCli.length);
      const prefix = typed.slice(0, matchedLen);
      const rest = detectedCli.slice(matchedLen);
      newSessionLabel = `Start new <strong>${escapeHtml(prefix)}</strong>${escapeHtml(rest)} session`;
    } else if (filterText.trim()) {
      newSessionLabel = `Run <code>${escapeHtml(filterText.trim())}</code> in shell`;
    } else {
      newSessionLabel = 'Start a new session — choose a CLI by typing its name';
    }

    listEl.innerHTML = '';

    if (!isDeepMode) {
      // Row 0: start new
      const newRow = document.createElement('div');
      newRow.className = 'at-picker-row at-picker-row-new';
      newRow.dataset.kind = 'new';
      newRow.innerHTML = `
        <span class="at-picker-stripe at-picker-stripe-new"></span>
        <span class="at-picker-newlabel">+ ${newSessionLabel}</span>
      `;
      newRow.addEventListener('click', () => activate(0));
      listEl.appendChild(newRow);
    }

    // ---- Past-sessions section: heading + (rows | empty state) ----
    // Heading reflects the current filter:
    //   no filter, ≥1 past:    "Past sessions"
    //   no filter, 0 past:     section omitted
    //   filter, matches:       "Past sessions — N of TOTAL matching `<text>`"
    //   filter, no matches:    "No past sessions match `<text>`" (still useful so the user knows the search ran)
    const filterDisplay = filtered.term ? filterText.trim() : '';
    if (isDeepMode) {
      const heading = document.createElement('div');
      heading.className = 'at-picker-divider';
      heading.innerHTML = `Hidden prompt matches for <code>${escapeHtml(filterDisplay)}</code> — ${escapeHtml(deepModeCountLabel(deepStatus))}`;
      listEl.appendChild(heading);
      attachHeadingActions(heading);
    } else if (filterDisplay) {
      const heading = document.createElement('div');
      heading.className = 'at-picker-divider';
      const stat = hiddenStatHtml(deepResult);
      if (visibleRows.length > 0) {
        heading.innerHTML = `Past sessions — ${visibleRows.length} of ${filtered.total} matching <code>${escapeHtml(filterDisplay)}</code>${stat}`;
      } else {
        const suffix = deepStatus && deepStatus.running && deepStatus.matchCount === 0
          ? ' — searching hidden prompts'
          : stat;
        const noMatchLabel = deepStatus && deepStatus.done && deepStatus.matchCount === 0
          ? 'No visible or hidden matches for'
          : 'No visible matches for';
        heading.innerHTML = `${noMatchLabel} <code>${escapeHtml(filterDisplay)}</code>${suffix}`;
      }
      listEl.appendChild(heading);
      attachHeadingActions(heading);
    } else if (visibleRows.length > 0) {
      const heading = document.createElement('div');
      heading.className = 'at-picker-divider';
      heading.textContent = 'Past sessions';
      listEl.appendChild(heading);
    }

    visibleRows.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'at-picker-row';
      row.dataset.kind = 'past';
      row.dataset.id = String(s.id);
      const isActive = activeSet.has(s.id) || s.isActive;
      const isHidden = !!s.isHidden;
      // Visible-active rows are disabled (the user already has them).
      // Hidden-active rows are clickable: clicking brings them back to the
      // taskbar instead of resuming. Past (non-active) rows are clickable
      // for resume as before.
      if (isActive && !isHidden) row.classList.add('at-picker-row-disabled');
      const stripeColor = (typeof s.hue === 'number')
        ? `oklch(65% 0.27 ${s.hue})`
        : '#444';
      // Brand glyph for the CLI — rendered small and dim at the row's
      // right edge, near the age timestamp. It's secondary metadata; the
      // prompt text on the left is what the user is scanning. (Previous
      // versions placed the glyph on the left, which competed with the
      // prompt for visual weight.)
      let cliTag = '';
      if (s.cli) {
        const icon = cliIcons.iconSvg(s.cli, ROW_ICON_PX);
        cliTag = `<span class="at-picker-cli-right" title="${escapeHtml(s.cli)}">${icon || escapeHtml(s.cli)}</span>`;
      }
      // Highlight matched substrings in the prompt so the user can see why
      // each row matched. cli is intentionally NOT highlighted (it isn't in
      // the search haystack any more — see filterSessions for the rationale).
      const prompt = s.prompt
        ? highlightSearchTerms(s.prompt, filtered.terms)
        : '<span class="at-picker-dim">(no prompt captured)</span>';
      const age = escapeHtml(relativeTime(s.lastEventAt));
      let badge = '';
      if (isActive && isHidden) {
        badge = '<span class="at-picker-active-badge at-picker-hidden-badge">hidden — bring forward</span>';
      } else if (isActive) {
        badge = '<span class="at-picker-active-badge">active</span>';
      }
      // Conditional subtitle lines.
      //   · last prompt — recency hint ("what was I most recently working
      //     on") with a ↳ continuation glyph. Suppressed when there's no
      //     follow-up (lastPrompt == prompt) or no prompt at all.
      //   · title lines — symmetric with the prompts pair above:
      //       initialTitle (italic, the session's frozen subject), then
      //       ↳ latest title (italic) when it has materially drifted.
      //     Both fall through redundancy filters (empty / equal to cli /
      //     equal to either prompt) and dedupe against each other. For
      //     older sessions without an `initial:true` event, initialTitle
      //     is null and we fall back to showing s.title alone — same
      //     visual outcome as the single-title design.
      const showLast = s.lastPrompt && s.lastPrompt !== s.prompt;
      const titleCandidates = [];
      const titleKeys = new Set([
        aiTitleDedupeKey(s.cli, s.cli),
        aiTitleDedupeKey(s.prompt, s.cli),
        aiTitleDedupeKey(s.lastPrompt, s.cli),
      ].filter(Boolean));
      function addTitleCandidate(rawTitle) {
        const t = cleanAiTitle(rawTitle, s.cli);
        const key = aiTitleDedupeKey(t, s.cli);
        if (!key || titleKeys.has(key)) return;
        titleKeys.add(key);
        titleCandidates.push(t);
      }
      addTitleCandidate(s.initialTitle);
      addTitleCandidate(s.title);
      const lastLine = showLast
        ? `<div class="at-picker-last-line"><span class="at-picker-last-prefix">↳</span> ${highlightSearchTerms(s.lastPrompt, filtered.terms)}</div>`
        : '';
      const titleLines = titleCandidates.map((t, idx) => {
        const prefix = idx === 0 ? '' : '<span class="at-picker-last-prefix">↳</span> ';
        return `<div class="at-picker-title-line">${prefix}${highlightSearchTerms(t, filtered.terms)}</div>`;
      }).join('');
      const hiddenMatchLines = isDeepMode ? renderHiddenMatchLines(s.hiddenMatches) : '';
      row.innerHTML = `
        <span class="at-picker-stripe" style="background:${stripeColor}"></span>
        <div class="at-picker-body">
          <div class="at-picker-line1">
            <span class="at-picker-prompt-line">${prompt}</span>
            ${badge}
            ${cliTag}
            <span class="at-picker-age">${age}</span>
          </div>
          ${lastLine}
          ${titleLines}
          ${hiddenMatchLines}
        </div>
      `;
      const activationIndex = isDeepMode ? i : i + 1;
      if (!isActive) {
        row.addEventListener('click', () => activate(activationIndex));
      } else if (isHidden) {
        row.addEventListener('click', () => {
          // Bring-forward action (different from resume): tell the target
          // window via IPC to setSkipTaskbar(false) + focus, then close
          // the picker without spawning anything in this window.
          cancelActiveHiddenSearch();
          try { window.pty.pickerBringForward(s.id); } catch {}
          if (typeof onClose === 'function') onClose();
        });
      }
      listEl.appendChild(row);
    });

    // Clamp selection
    const maxIndex = Math.max(0, (isDeepMode ? visibleRows.length : 1 + visibleRows.length) - 1);
    if (selectedIndex > maxIndex) selectedIndex = maxIndex;
    if (selectedIndex < 0) selectedIndex = 0;
    applySelectionStyles();
    if (isDeepMode) scheduleAlignHiddenMatchLines();
  }

  function applySelectionStyles() {
    const rows = listEl.querySelectorAll('.at-picker-row');
    rows.forEach((r, idx) => {
      r.classList.toggle('at-picker-row-selected', idx === selectedIndex);
      r.setAttribute('aria-selected', idx === selectedIndex ? 'true' : 'false');
    });
    const active = rows[selectedIndex];
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveSelection(delta) {
    const isDeepMode = mode === 'deep';
    const total = isDeepMode ? visibleRows.length : 1 + visibleRows.length;
    if (total === 0) return;
    let next = selectedIndex;
    for (let attempts = 0; attempts < total; attempts++) {
      next = (next + delta + total) % total;
      if (!isDeepMode && next === 0) break;                         // row 0 always selectable
      const session = visibleRows[isDeepMode ? next : next - 1];
      // Visible-active rows are skipped (nothing to do); hidden-active
      // rows are selectable (Enter brings them forward); past rows are
      // selectable (Enter resumes them).
      const isDisabled = session && (activeSet.has(session.id) || session.isActive) && !session.isHidden;
      if (!isDisabled) break;
    }
    selectedIndex = next;
    applySelectionStyles();
  }

  function activate(index) {
    if (mode !== 'deep' && index === 0) {
      const cli = detectCliFromFilter(filterText);
      if (cli && typeof onStartNew === 'function') {
        cancelActiveHiddenSearch();
        return onStartNew(cli);
      }
      const literal = filterText.trim();
      if (literal && typeof onStartNew === 'function') {
        cancelActiveHiddenSearch();
        return onStartNew(literal);
      }
      // Empty filter on row 0 with no CLI → fresh shell.
      if (typeof onClose === 'function') {
        cancelActiveHiddenSearch();
        return onClose();
      }
      return;
    }
    const session = visibleRows[mode === 'deep' ? index : index - 1];
    if (!session) return;
    const isActiveRow = activeSet.has(session.id) || session.isActive;
    if (isActiveRow && session.isHidden) {
      cancelActiveHiddenSearch();
      try { window.pty.pickerBringForward(session.id); } catch {}
      if (typeof onClose === 'function') onClose();
      return;
    }
    if (isActiveRow) return;   // visible-active rows: nothing to activate
    if (typeof onPick === 'function') {
      cancelActiveHiddenSearch();
      onPick(session.id);
    }
  }

  function dismissCurrent() {
    if (mode !== 'deep' && selectedIndex === 0) return;
    const session = visibleRows[mode === 'deep' ? selectedIndex : selectedIndex - 1];
    if (!session) return;
    dismissedIds.add(session.id);
    render();
  }

  function shouldBackspaceDismiss(e) {
    if (e.key !== 'Backspace') return false;
    if (selectedIndex === 0) return false;
    if (filterText.length > 0) return false;
    if (e.altKey || e.ctrlKey || e.metaKey) return false;
    return true;
  }

  // ---- event handlers ----

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelActiveHiddenSearch();
      if (typeof onClose === 'function') onClose();
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(+1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveSelection(-1); return; }
    if (e.key === 'Enter')     { e.preventDefault(); activate(selectedIndex); return; }
    if (e.key === 'Tab') {
      // Tab is "move focus to next element" by default — without a trap it
      // jumps to the terminal behind the modal. We consume it and route it:
      //   · primary: advance/retract the selection through past matches
      //     (Tab = ↓, Shift+Tab = ↑) so users can hop into the past list
      //     after typing a search term
      //   · fallback: when there are no past matches, treat Tab as the
      //     CLI prefix autocomplete it used to be — "cl" + Tab → fill in
      //     "claude"
      e.preventDefault();
      if (visibleRows.length > 0) {
        moveSelection(e.shiftKey ? -1 : +1);
        return;
      }
      const cli = detectCliFromFilter(filterText);
      if (cli && cli !== filterText.trim()) {
        input.value = cli;
        filterText = cli;
        selectedIndex = 0;
        render();
      }
      return;
    }
    if (e.key === 'Delete' || shouldBackspaceDismiss(e)) {
      e.preventDefault();
      dismissCurrent();
      return;
    }
  }

  input.addEventListener('input', () => {
    filterText = input.value;
    mode = 'normal';
    deepSearchState = null;
    selectedIndex = 0;             // reset to "Start new" on any filter change
    render();
    scheduleDeepSearch();
  });

  // Single keydown listener on the input only. The previous double listener
  // (input + modal) caused Enter to bubble and fire activate() twice, which
  // double-sent the picker-start-new IPC and typed the CLI invocation twice
  // — once launching the CLI, the second time landing in the CLI's prompt.
  input.addEventListener('keydown', onKeyDown);

  // Click outside the modal closes the picker (treated as Esc).
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay && typeof onClose === 'function') {
      cancelActiveHiddenSearch();
      onClose();
    }
  });

  // ---- mount ----

  document.body.appendChild(overlay);
  render();
  // Defer focus so the click that triggered the picker doesn't blur us.
  setTimeout(() => input.focus(), 0);

  return {
    destroy: () => {
      deepSearchSeq++;
      cancelActiveHiddenSearch();
      try { overlay.remove(); } catch {}
    },
    // exposed for tests
    handleHiddenSearchProgress,
    _state: () => ({ filterText, selectedIndex, visibleRows, dismissedIds, mode, deepSearchState }),
  };
}

// ---- styles ----

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.at-picker-overlay {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(0,0,0,0.85);
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 8vh;
  font: 13px "Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace;
}
.at-picker-modal {
  background: #0c0c0c;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  width: min(720px, 92vw);
  max-height: 80vh;
  display: flex; flex-direction: column;
  color: #cccccc;
  box-shadow: 0 16px 48px rgba(0,0,0,0.6);
  overflow: hidden;
}
.at-picker-header {
  padding: 12px 16px 6px;
  font-size: 13px;
  color: #a0a0a0;
  letter-spacing: 0.02em;
}
.at-picker-input {
  margin: 0 12px 8px;
  padding: 8px 10px;
  background: #181818;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  color: #e6e6e6;
  font: inherit;
  outline: none;
}
.at-picker-input:focus {
  border-color: #4a90e2;
}
.at-picker-list {
  overflow-y: auto;
  padding: 0 8px 8px;
  flex: 1 1 auto;
}
.at-picker-divider {
  padding: 12px 12px 6px;
  font-size: 11px;
  color: #707070;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.at-picker-inline-action {
  appearance: none;
  border: 0;
  padding: 0;
  margin: 0;
  background: transparent;
  color: #a8c7ee;
  font: inherit;
  text-transform: inherit;
  letter-spacing: inherit;
  cursor: pointer;
}
.at-picker-inline-action:hover {
  color: #d6e7ff;
}
.at-picker-row {
  display: flex; align-items: stretch; gap: 10px;
  padding: 8px 10px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}
.at-picker-row:hover {
  background: #181818;
}
.at-picker-row-selected {
  background: #1f3556;
}
.at-picker-row-selected:hover {
  background: #234071;
}
.at-picker-row-disabled {
  opacity: 0.45;
  cursor: default;
}
.at-picker-row-disabled:hover {
  background: transparent;
}
.at-picker-stripe {
  flex: 0 0 auto;
  width: 3px;
  border-radius: 1.5px;
  align-self: stretch;
}
.at-picker-stripe-new {
  background: transparent;
}
.at-picker-newlabel {
  align-self: center;
  color: #e6e6e6;
}
.at-picker-newlabel strong {
  color: #ffffff;
  font-weight: 700;
}
.at-picker-newlabel code {
  background: #181818;
  padding: 1px 6px;
  border-radius: 3px;
  color: #d8d8d8;
}
.at-picker-body {
  flex: 1 1 auto;
  min-width: 0;
}
.at-picker-line1 {
  display: flex; align-items: baseline; gap: 8px;
  flex-wrap: nowrap; min-width: 0;
}
.at-picker-cli-right {
  /* Past-session brand glyph at the row's right edge — small, dim, and
     placed in the metadata cluster next to age/badge. SVG currentColor
     resolves to this element's color so we can adjust the dimness in
     CSS without per-row inline styles. */
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  color: #707070;
  margin-left: 4px;
}
.at-picker-cli-right svg.at-cli-icon {
  display: block;
}
.at-picker-cli-right:not(:has(svg)) {
  /* Fallback for unknown CLIs — show the cli name as a small dim tag. */
  font-size: 11px;
}
.at-picker-title,
.at-picker-prompt-line {
  flex: 1 1 auto; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: #f0f0f0;
}
.at-picker-active-badge {
  background: #1d3a1d;
  color: #b6d6b6;
  border-radius: 3px;
  padding: 0 6px;
  font-size: 11px;
  flex: 0 0 auto;
}
.at-picker-hidden-badge {
  /* Hidden-active rows are clickable to bring back, so style the badge as
     an action affordance — slightly more prominent and a different hue
     than plain "active" so the user spots it. */
  background: #2a3548;
  color: #aac6ec;
}
.at-picker-match {
  /* Subtle warm tint that doesn't overwhelm the row but is visible at a
     glance against the dark prompt text. Inherits row foreground so
     selected/disabled state still controls overall color. */
  background: rgba(255, 213, 88, 0.22);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.at-picker-age {
  flex: 0 0 auto;
  font-size: 11px;
  color: #909090;
}
.at-picker-prompt {
  margin-top: 4px;
  font-size: 12px;
  color: #a0a0a0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.at-picker-last-line {
  /* The session's most-recent prompt — recency cue ("what was I last
     working on"). Slightly dimmer than the identity line to put it in a
     supporting role, but still readable since the user may scan it. */
  margin-top: 3px;
  color: #c8c8c8;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.at-picker-last-prefix {
  color: #707070;
  margin-right: 4px;
}
.at-picker-title-line {
  /* CLI's most-recent OSC title — the search key for the CLI's own resume
     dialog. Dim italic; user reads this once on pick and remembers what
     to type in the CLI's resume search. */
  margin-top: 2px;
  color: #909090;
  font-style: italic;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.at-picker-hidden-match-line {
  margin-top: 3px;
  color: #c8c8c8;
  display: flex;
  min-width: 0;
  align-items: baseline;
}
.at-picker-match-viewport {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  -webkit-mask-image: linear-gradient(to right, transparent 0, black 14px, black calc(100% - 14px), transparent 100%);
  mask-image: linear-gradient(to right, transparent 0, black 14px, black calc(100% - 14px), transparent 100%);
}
.at-picker-match-text {
  display: inline-block;
  white-space: nowrap;
  will-change: transform;
  font-variant-ligatures: none;
}
.at-picker-dim {
  color: #707070;
}
.at-picker-footer {
  border-top: 1px solid #2a2a2a;
  padding: 8px 14px;
  display: flex; gap: 16px;
  font-size: 11px;
  color: #808080;
  background: #0a0a0a;
}
  `;
  document.head.appendChild(style);
}

module.exports = { createPicker, KNOWN_CLIS };
