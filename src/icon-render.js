// Per-window taskbar icon renderer.
//
// The icon shows the first N letters of the user's prompt in light grey
// (matching Windows taskbar button text), with a hue-colored pill underline
// pinned to the bottom edge. Together with the window title (which carries
// the rest of the prompt), the taskbar button reads continuously:
//   [icon: "Mig"] + "rate the database…" = "Migrate the database…"
//
// This module exports the pure-function pieces used by both production
// (src/main.js) and the local preview (scripts/preview-icon-and-thumbnail.js)
// so the preview is guaranteed to match what ships.

const ICON_OKLCH_L = 65;            // %, lightness
// Chroma 0.27 puts hues in primary-color recognition territory at L=65:
// near-30° reads as true red, ~150° as green, ~240° as blue, with vivid
// orange / teal / purple / magenta between. Marginal sRGB gamut-mapping
// occurs at yellow-green (~90-120°) and deep purple (~270°) but the
// rendered colors stay distinct and "common-color"-recognizable.
const ICON_OKLCH_C = 0.27;          // chroma
const ICON_LETTERS_N = 3;           // chars shown in the icon (default; renderer may use 4 if it fits)
const ICON_LETTERS_N_MAX = 4;       // upper bound: try 4 letters first if they fit at target font
// Max chars of the "rest" portion of the prompt that we put into the
// window title (via mainWindow.setTitle). The thumbnail popup's title
// strip is OS-rendered and would otherwise truncate mid-word on long
// titles. By picking a value low enough to always fit, we guarantee the
// chrome top of the popup never truncates — and we know exactly where
// the visible portion ends, so the thumbnail card can pick up cleanly
// from char TASKBAR_TITLE_REST_MAX without overlapping what's already
// visible above. Conservative: 25 chars fits in a typical 280px popup
// title strip at common DPI configs.
const TASKBAR_TITLE_REST_MAX = 25;

// Extract the first N letters of the prompt (skipping leading non-letter
// chars like '"' or '✻ ') plus the "rest" — everything past those N chars.
// The first letter is uppercased; subsequent chars preserve original case.
// Default N=3: icon shows the first 3 chars, title shows the rest, so the
// taskbar button reads "[icon: Mig] + 'rate the database schema'" =
// "Migrate the database schema" continuously.
function firstLettersAndRest(prompt, n = ICON_LETTERS_N) {
  // Empty / no-letter prompts return blank letters; the icon renderer
  // draws a "pill-only" placeholder in that case (hue identity preserved,
  // no question-mark text). Caller behavior is consistent for normal
  // prompts (idx ≥ 0) and unusual ones (empty / digits-only).
  if (!prompt) return { letters: '', rest: '' };
  const idx = prompt.search(/[A-Za-z]/);
  if (idx < 0) return { letters: '', rest: prompt };
  let letters = prompt[idx].toUpperCase();
  let restStart = idx + 1;
  for (let i = 1; i < n && restStart < prompt.length; i++) {
    letters += prompt[restStart];
    restStart++;
  }
  return { letters, rest: prompt.slice(restStart) };
}

// Build candidate letter strings for the icon, longest first. Used by
// iconRenderScript: at the target font size, the renderer picks the longest
// candidate that fits without truncation, falling back to fewer letters when
// the prompt's leading glyphs are too wide. Pairs naturally with `restFor`
// below so the title-bar text stays consistent with whatever candidate the
// icon actually drew.
function letterCandidates(prompt) {
  const out = [];
  for (let n = ICON_LETTERS_N_MAX; n >= ICON_LETTERS_N - 1; n--) {
    out.push(firstLettersAndRest(prompt, n).letters);
  }
  return out;
}

// Build the canvas script that draws the icon. Run via
// webContents.executeJavaScript(); returns a base64 PNG data URL.
//
// Layout strategy:
//   · Hue underline pill is pinned to the bottom edge of the icon.
//   · Letters are cap-centered (cap midline at icon center) so they sit at
//     the same vertical position as the adjacent Windows taskbar button text
//     (which the OS centers in the button row).
//   · Letters are drawn as far right as physically possible: the right
//     side bearing (empty space inside the rightmost glyph's em-box) is
//     measured and used as a positive offset on the textAlign=right anchor,
//     so the actual letter ink lands flush with the icon's right edge. Any
//     advance that overshoots the canvas falls into the empty bearing — no
//     ink gets clipped.
//   · The renderer picks the longest letter candidate (e.g., 4 letters
//     before falling back to 3) that fits the icon's width at the target
//     font size. No truncation: if 4 don't fit, we use 3.
//
// `letterCandidatesArr` is an ordered list of strings, longest first, e.g.
// ['Migr', 'Mig', 'Mi']. Built by letterCandidates(prompt) above.
function iconRenderScript(hue, letterCandidatesArr) {
  const fill = `oklch(${ICON_OKLCH_L}% ${ICON_OKLCH_C} ${hue})`;
  const candidates = (Array.isArray(letterCandidatesArr) && letterCandidatesArr.length > 0)
    ? letterCandidatesArr
    : ['???'];
  return `(function(){
    const C = 256;
    const c = document.createElement('canvas');
    c.width = C; c.height = C;
    const ctx = c.getContext('2d');

    // Hue pill: thickness ~10% of icon (~2.5px effective on a 24px icon),
    // anchored flush to the bottom edge.
    const ulPx = Math.round(C * 0.105);
    const ulY  = C - ulPx;
    const ulGap = Math.max(3, Math.round(C * 0.018));  // baseline-to-pill clearance for descenders
    const halfBudget = C / 2 - ulPx - ulGap;            // vertical budget below cap midline before the pill

    const fontFamily = '"Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
    // Target font: cap height ~10 effective px on a 24px icon — slightly
    // larger than Windows taskbar button text (cap ~8.5 effective px) so
    // the icon letters read as emphasized but in the same family.
    const targetFontPx = Math.round(C * 0.6);
    // Tiny left safety margin so anti-aliased pixels from the leftmost
    // letter never get clipped at x=0 by the canvas boundary.
    const leftMargin = Math.round(C * 0.02);
    const maxInkWidth = C - leftMargin;

    const candidates = ${JSON.stringify(candidates)};

    // Helper: measure a candidate at a given font size. Returns the metrics
    // and a width-fit decision. We use actualBoundingBoxLeft/Right (the
    // actual ink span) rather than the font's advance width — advance
    // includes right-side bearing whitespace that doesn't visually count
    // against fitting, so we'd otherwise reject 4-letter sets that fit ink-wise.
    function measure(letters, fontPx) {
      ctx.font = '400 ' + fontPx + 'px ' + fontFamily;
      const m = ctx.measureText(letters);
      const capH = m.actualBoundingBoxAscent;
      const descH = m.actualBoundingBoxDescent;
      // ink span in pixels; with textAlign=left default, BB-left is negative
      // (ink is right of the left-edge anchor) and BB-right is positive.
      const inkWidth = m.actualBoundingBoxRight + m.actualBoundingBoxLeft;
      const rightSideBearing = m.width - m.actualBoundingBoxRight;
      const fitsHeight = (capH / 2) + descH <= halfBudget;
      const fitsWidth = inkWidth <= maxInkWidth;
      return { m, capH, descH, inkWidth, rightSideBearing, fitsHeight, fitsWidth };
    }

    // Pick the longest candidate that fits at the target font without
    // shrinking. If even the shortest doesn't fit, shrink the font for the
    // shortest candidate.
    let chosen = null;
    for (const cand of candidates) {
      const r = measure(cand, targetFontPx);
      if (r.fitsHeight && r.fitsWidth) {
        chosen = { letters: cand, fontPx: targetFontPx, ...r };
        break;
      }
    }
    if (!chosen) {
      const fallback = candidates[candidates.length - 1];
      let fontPx = targetFontPx - 2;
      while (fontPx > 20) {
        const r = measure(fallback, fontPx);
        if (r.fitsHeight && r.fitsWidth) {
          chosen = { letters: fallback, fontPx, ...r };
          break;
        }
        fontPx -= 2;
      }
    }
    if (!chosen) return JSON.stringify({ url: c.toDataURL('image/png'), n: 0 });

    // ---- Blank state: no letters, render only the hue pill spanning the
    // ---- full width of the icon. Pre-prompt placeholder — the hue is
    // ---- visible from the moment the CLI boots, no "???" text shown.
    if (!chosen.letters || chosen.letters.length === 0) {
      const ulRight = C;
      const ulLeft = 0;
      const r = ulPx / 2;
      ctx.fillStyle = ${JSON.stringify(fill)};
      ctx.beginPath();
      ctx.moveTo(ulLeft + r, ulY);
      ctx.arcTo(ulRight, ulY, ulRight, ulY + r, r);
      ctx.lineTo(ulRight, ulY + ulPx - r);
      ctx.arcTo(ulRight, ulY + ulPx, ulRight - r, ulY + ulPx, r);
      ctx.lineTo(ulLeft + r, ulY + ulPx);
      ctx.arcTo(ulLeft, ulY + ulPx, ulLeft, ulY + ulPx - r, r);
      ctx.lineTo(ulLeft, ulY + r);
      ctx.arcTo(ulLeft, ulY, ulLeft + r, ulY, r);
      ctx.closePath();
      ctx.fill();
      return JSON.stringify({ url: c.toDataURL('image/png'), n: 0 });
    }

    // ---- draw the letters, ink flush right ----
    // textAlign=right anchors at the right edge of the advance box; ink
    // ends rightSideBearing pixels left of that. Push the anchor right by
    // rightSideBearing so the ink's right edge lands at x=C.
    ctx.font = '400 ' + chosen.fontPx + 'px ' + fontFamily;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#cccccc';
    const baseline = C / 2 + chosen.capH / 2;     // cap-centered
    ctx.fillText(chosen.letters, C + chosen.rightSideBearing, baseline);

    // ---- hue pill underline, spanning the actual ink width ----
    const ulRight = C;
    const ulLeft = ulRight - chosen.inkWidth;
    const r = ulPx / 2;
    ctx.fillStyle = ${JSON.stringify(fill)};
    ctx.beginPath();
    ctx.moveTo(ulLeft + r, ulY);
    ctx.arcTo(ulRight, ulY, ulRight, ulY + r, r);
    ctx.lineTo(ulRight, ulY + ulPx - r);
    ctx.arcTo(ulRight, ulY + ulPx, ulRight - r, ulY + ulPx, r);
    ctx.lineTo(ulLeft + r, ulY + ulPx);
    ctx.arcTo(ulLeft, ulY + ulPx, ulLeft, ulY + ulPx - r, r);
    ctx.lineTo(ulLeft, ulY + r);
    ctx.arcTo(ulLeft, ulY, ulLeft + r, ulY, r);
    ctx.closePath();
    ctx.fill();

    // Return both the data URL AND the chosen letter count so the caller
    // can keep the window title's "rest" consistent — if the icon used
    // 4 letters, the title should start from index 4 (not 3) so the user
    // doesn't see the same character appear in both the icon and the title.
    return JSON.stringify({ url: c.toDataURL('image/png'), n: chosen.letters.length });
  })()`;
}

// Split the "rest" portion of a prompt into the part that fits in the
// chrome top (taskbar button title, set via mainWindow.setTitle) and the
// overflow that picks up where chrome top leaves off. Two strategies:
//   · Word boundary: scan back for any non-word character (whitespace OR
//     punctuation — ./;,:- etc., everything matched by \W) within the
//     first `maxLen` chars; if one sits at ≥70% of the limit, cut there.
//     Counting punctuation as a break candidate (not just whitespace)
//     means URLs and paths split at their natural separators, so almost
//     every realistic prompt finds a clean cut without falling through
//     to the mid-character fallback. Whitespace gets consumed by the
//     cut; other non-word characters stay attached to the title side so
//     the URL/path reads as "host.com/" + "path" rather than the slash
//     jumping to the next surface.
//   · Mid-character (fallback): no usable break point in the window.
//     Cut at exactly `maxLen` and let the caller decorate both halves
//     with '…'. This branch is acceptable on the taskbar button because
//     horizontal space is severely limited — wider surfaces (thumbnail
//     card, live preview) never need it; their renderer word-wraps with
//     the same \W boundary definition and accepts visual overflow over
//     a mid-word data cut.
// Returns: { title, overflow, midWord }. Caller decides what to do with
// midWord (typically: append/prepend '…' decorations).
function splitChromeTopAndOverflow(rest, maxLen) {
  if (!rest) return { title: '', overflow: '', midWord: false };
  if (rest.length <= maxLen) {
    return { title: rest, overflow: '', midWord: false };
  }
  const tail = rest.slice(0, maxLen);
  let cut = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (/\W/.test(tail[i])) { cut = i; break; }
  }
  if (cut >= maxLen * 0.7) {
    if (/\s/.test(tail[cut])) {
      return {
        title:    rest.slice(0, cut),
        overflow: rest.slice(cut + 1),
        midWord:  false,
      };
    }
    return {
      title:    rest.slice(0, cut + 1),
      overflow: rest.slice(cut + 1),
      midWord:  false,
    };
  }
  return {
    title:    rest.slice(0, maxLen),
    overflow: rest.slice(maxLen),
    midWord:  true,
  };
}

// Compact URLs and file paths for size-constrained taskbar/preview display.
// The taskbar button has very little horizontal room (icon chip + ~30 chars
// of title text on a typical Windows taskbar), and a verbose prompt that
// includes "https://github.com/owner/repo/issues/12345" or
// "/home/me/proj/src/sub/file.py" leaves no room for the rest of the prompt.
//
// Conservative substitutions, scoped to compact identity surfaces:
//   · URLs:   https://host.com/path/1234 → …34
//             Last two chars of the last path segment win; root URLs fall
//             back to the host stem.
//             Applied per-URL so multiple URLs in one prompt each shorten.
//   · Paths:  /a/b/c/d/file.ext  → file
//             ~/a/b/file.py      → file
//             src/file.js        → file
//             Preserves the filename stem so identity ("I was editing
//             main") survives without extension noise.
//
// In-app chrome, picker rows, and tooltips keep the verbatim prompt. The
// live-preview footer also keeps stripped refs verbatim for verification.
function truncatePathsForTaskbar(text) {
  return extractPathsAndUrls(text).text;
}

// Same substitutions as truncatePathsForTaskbar but ALSO returns the
// originals so the live-preview footer can surface them as verbatim
// references. Three ref kinds:
//   · url:     https://host.com/path/1234 → …34
//   · path:    /a/b/c/file.ext          → file
//   · mention: @scope/file.ext          → file        (scope and @ dropped)
// The @-mention form covers Claude Code / Cursor style file refs like
// "@ai/build-api-guide.md": scope and marker are collapsible noise when
// space is tight, and the filename stem is the human identifier.
function extractPathsAndUrls(text) {
  if (typeof text !== 'string' || !text) return { text: '', refs: [] };
  const refs = [];
  function stripFileExtension(filename) {
    const dot = filename.lastIndexOf('.');
    // Keep dotfiles like ".env" readable; they don't have a stem before the dot.
    return dot > 0 ? filename.slice(0, dot) : filename;
  }
  function compactHostname(hostname) {
    if (!hostname) return '';
    const clean = hostname.replace(/^\[|\]$/g, '');
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(clean) || clean.includes(':')) {
      return clean;
    }
    const labels = clean.split('.').filter(Boolean);
    if (labels.length <= 1) return clean;
    labels.pop();
    return labels.join('.');
  }
  function compactUrl(url) {
    const segments = String(url.pathname || '').split('/').filter(Boolean);
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      let decoded = last;
      try { decoded = decodeURIComponent(last); } catch {}
      const stem = stripFileExtension(decoded) || decoded;
      return stem ? `…${stem.slice(-2)}` : stem;
    }
    return compactHostname(url.hostname);
  }
  function compactPath(pathStr) {
    const trailingSlash = pathStr.endsWith('/');
    const body = trailingSlash ? pathStr.slice(0, -1) : pathStr;
    const slashSegments = body.split('/');
    const lastSlashSegment = slashSegments[slashSegments.length - 1] || '';
    const backslashSegments = lastSlashSegment.split('\\');
    const filename = backslashSegments[backslashSegments.length - 1] || '';
    if (!filename || filename === '~') return null;
    const displayName = trailingSlash ? filename : stripFileExtension(filename);
    return `${displayName}${trailingSlash ? '/' : ''}`;
  }
  // Boundaries: whitespace, start/end, OR quote chars (single, double,
  // backtick). Quoted paths like `'/mnt/foo/bar.md'` are common in user
  // prompts (escaping spaces or just for emphasis) and we want to strip
  // them too. Quote chars are kept around the substitution so the
  // resulting text reads as the user wrote it ("'bar.md'").
  let out = text.replace(/https?:\/\/[^\s`'"]+/gi, (match) => {
    let display = '';
    try { display = compactUrl(new URL(match)); } catch {}
    if (!display) return match;
    refs.push({ kind: 'url', full: match });
    return display;
  });
  out = out.replace(/(^|[\s`'"])([/~][^\s`'"]+)(?=$|[\s`'"])/g, (match, lead, pathStr) => {
    const displayName = compactPath(pathStr);
    if (!displayName) return match;
    refs.push({ kind: 'path', full: pathStr });
    return `${lead}${displayName}`;
  });
  out = out.replace(/(^|[\s`'"])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[^\s\/`'"]+\.[^\s\/`'"]+)(?=$|[\s`'"])/g, (match, lead, pathStr) => {
    const displayName = compactPath(pathStr);
    if (!displayName) return match;
    refs.push({ kind: 'path', full: pathStr });
    return `${lead}${displayName}`;
  });
  out = out.replace(/(^|[\s`'"])(@[^\s@\/`'"]+\/[^\s`'"]+)(?=$|[\s`'"])/g, (match, lead, mentionStr) => {
    const segments = mentionStr.slice(1).split('/').filter(s => s.length > 0);
    if (segments.length < 2) return match;
    const filename = segments[segments.length - 1];
    refs.push({ kind: 'mention', full: mentionStr });
    return `${lead}${stripFileExtension(filename)}`;
  });
  return { text: out, refs };
}

module.exports = {
  ICON_OKLCH_L,
  ICON_OKLCH_C,
  ICON_LETTERS_N,
  ICON_LETTERS_N_MAX,
  TASKBAR_TITLE_REST_MAX,
  firstLettersAndRest,
  letterCandidates,
  iconRenderScript,
  truncatePathsForTaskbar,
  extractPathsAndUrls,
  splitChromeTopAndOverflow,
};
