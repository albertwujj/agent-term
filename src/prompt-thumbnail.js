// Activity-card thumbnail bitmap renderer.
//
// Produces a card used as the DWM iconic representation for two surfaces:
//   · The small thumbnail (~280x158) in the taskbar popup.
//   · The Aero Peek live preview (~1280x720) shown when the user hovers
//     into the small thumbnail and gets the full-screen preview.
//
// Both surfaces render the SAME content via buildScript at different sizes.
// A card never pretends to be a screenshot — it's a status summary with the
// session's identity (verbatim first prompt) up top, recent activity in the
// body, and the CLI-emitted title(s) at the bottom. Surface-consistent so
// the user doesn't have to re-learn between thumbnail and live preview.
//
// Layout (top to bottom):
//   ┌──────────────────────────────────────────────┐
//   │ claude · working                             │ ← cli icon + status
//   │ Investigate the timeout in the worker pool   │ ← verbatim firstPrompt
//   │ that I noticed yesterday afternoon           │   (wraps; truncates with …)
//   │ ──────────────────────────────────────────── │ ← dim divider
//   │ ↳ Now also check the connection pool         │ ← lastPrompt (↳ prefix)
//   │   Add tests for the race condition           │ ← intermediate
//   │   Pause backfill, workers timing out         │ ← older still
//   │                                               │
//   │ Investigating worker timeouts                │ ← initialTitle (italic)
//   │ ↳ Connection pool issues                     │ ← lockedTitle (↳, only on drift)
//   └──────────────────────────────────────────────┘
//
// The verbatim firstPrompt is the session's identity (the user typed it,
// they remember it). The body shows newest-first recent prompts EXCLUDING
// the first (already in the header — don't duplicate). The bottom carries
// the CLI's distilled titles — initialTitle frozen at first emission,
// lockedTitle if it has since drifted. Suppression mirrors the picker
// rows: a title that equals cli/firstPrompt/lastPrompt collapses, two
// identical titles collapse to one.
//
// No hue stripe — hue identity lives on the taskbar icon's underline pill
// and the picker rows; thumbnail doesn't need to carry it too.
//
// The actual rasterization happens on a Chromium <canvas> via
// webContents.executeJavaScript(); this module just builds the script string.

// Light theme palette — mimics DWM's Aero Peek fallback surface so the
// pre-bitmap frame and our bitmap render the same pixels. Our bitmap
// covers the ENTIRE popup region including where DWM's chrome bar
// appears in the fallback; if we don't paint a chrome strip ourselves,
// the bar visually disappears the moment our bitmap loads and the user
// sees a flash at the top.
//
// Sampled directly from a normal-state fallback screenshot (5120x2735,
// native 300%-scale physical-pixel capture, fine vertical scan at
// x=600..640):
//   y=0..66    flat #f3f3f3        ← chrome bar (sharp boundary at y=68)
//   y=68..end  #ffffff → #9a9a9a   ← body gradient, neutral greyscale
//   gradient is no-hue-shift, near-linear over ~2.7k rows.
// Chrome bar height: 67/2735 ≈ 2.45% of total popup height.
//
// (Earlier measurement was 6.5%, sampled from a screenshot taken while
// MS Teams was active — Teams attaches a "share" UI to the window that
// inflates the chrome region. The normal-state proportion is ~2.45%.)
const BG_CHROME_BAR      = '#f3f3f3';
const BG_GRADIENT_TOP    = '#ffffff';
const BG_GRADIENT_BOTTOM = '#9a9a9a';
const CHROME_BAR_FRAC    = 0.0245;
const FG = '#1a1a1a';                       // dark text on silver
const FG_DIM = 'rgba(60,60,60,0.65)';       // titles, dimmer secondary
const FG_FAINT = 'rgba(80,80,80,0.5)';      // elide marker, very faint
const FG_ACCENT_WORK = '#2e7d32';           // darker green for legibility on light
const FG_ACCENT_IDLE = 'rgba(80,80,80,0.6)';
const FONT_STACK = '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace';

// Chrome-matching palette for the small thumbnail. The thumbnail popup
// uses a different chrome theme from the live preview: dark chrome with
// light text (Win11 tooltip-style), not the light chrome the live
// preview body sits under. Sampled directly from the thumbnail popup
// in a fallback-state screenshot:
//   chrome bg   = #3f3f3f   (dark grey)
//   chrome text = #d6d6d6   (light grey)
// We match both so our bitmap reads as a continuation of the title bar
// above it. Font is Segoe UI Variable Text (same as chrome) — heavily
// ClearType-hinted at small sizes, so glyphs survive DWM's bilinear
// upscale better than monospace fonts.
const BG_THUMB        = '#3f3f3f';
const FG_THUMB_TEXT   = '#d6d6d6';
const FONT_STACK_UI   = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

// Emits the canvas-script snippet that paints the card background.
// Returns a string of JS to be inlined into a `(async function(){ ... })()`
// IIFE that already has `c` (canvas) and `ctx` (2D context) in scope.
// Kept as a string-producing helper rather than a runtime function on the
// emitted canvas script because both surfaces compose their full script
// at build time — one shared text snippet keeps the two surfaces in
// lockstep without round-tripping through a separate eval.
// Declares `chromeBarH` in the surrounding scope (no IIFE wrapper) so
// downstream content layout can offset its top cursor below the bar.
//
// solidColor: when provided, paints a uniform fill and sets chromeBarH=0.
// Used for the small thumbnail card which (a) is too small for a chrome
// strip to read as anything but a glitch, and (b) doesn't suffer the
// flash issue the live preview does — DWM's transition into the small
// thumbnail isn't visible to the user.
function backgroundPaintSnippet(solidColor) {
  if (solidColor) {
    return `
      ctx.fillStyle = ${JSON.stringify(solidColor)};
      ctx.fillRect(0, 0, c.width, c.height);
      const chromeBarH = 0;
    `;
  }
  return `
    const chromeBarH = Math.max(2, Math.round(c.height * ${CHROME_BAR_FRAC}));
    {
      const grad = ctx.createLinearGradient(0, chromeBarH, 0, c.height);
      grad.addColorStop(0, ${JSON.stringify(BG_GRADIENT_TOP)});
      grad.addColorStop(1, ${JSON.stringify(BG_GRADIENT_BOTTOM)});
      ctx.fillStyle = grad;
      ctx.fillRect(0, chromeBarH, c.width, c.height - chromeBarH);
      ctx.fillStyle = ${JSON.stringify(BG_CHROME_BAR)};
      ctx.fillRect(0, 0, c.width, chromeBarH);
    }
  `;
}

const cliIcons = require('./cli-icons');

// Build a data URL for the cli's brand icon at the size the header wants
// (used as a leading glyph instead of the cli name text). Returns null
// when the cli has no icon — caller falls back to text. Explicit color
// rather than currentColor: SVGs loaded into canvas via Image have no
// CSS context so currentColor resolves to black, which is invisible on
// our dark card background.
function cliIconDataURL(cli, sizePx) {
  const svg = cliIcons.iconSvg(cli, sizePx, FG);
  if (!svg) return null;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

// Small thumbnail card — designed to complement, not duplicate, the
// chrome top of the thumbnail popup (which is OS-rendered from the
// window title we set). The card's primary job is to show the part of
// the first prompt that the chrome top truncates off, with a `…` prefix
// signaling "continuation from above."
//
// Card content (priority):
//   1. firstPromptOverflow (the chars beyond what chrome top shows). The
//      most common case for long prompts. Renders with `…` prefix.
//   2. recentActivity (newest at bottom) if the prompt fully fits in
//      chrome top but the session has had follow-up activity.
//   3. firstPrompt itself as the only line, if the session is brand-new
//      and short.
//
// Visual model when rendering recentActivity (case 2): newest at bottom,
// older history fading upward, oldest dropping off the top. Mirrors how
// the actual terminal scrolls.
//
// Larger uniform font: thumbnail popups are read by humans who often have
// scaled displays (300% scale on retina panels, for example). The card
// uses ~12% of canvas height as font size so the displayed text reads
// comfortably even with modest popup dimensions.
//
// opts: {
//   width, height,
//   firstPromptOverflow,                  // chars of firstPrompt NOT in chrome top
//   recentActivity: [{type, text, t}],    // chronological (oldest first), EXCLUDES firstPrompt
//   firstPrompt,                          // fallback content when overflow + activity both empty
// }
function buildScript(opts) {
  const {
    width = 280,
    height = 158,
    firstPromptOverflow = '',
    recentActivity = [],
    firstPrompt = '',
    // Override knobs used by scripts/preview-thumbnail.js to compare
    // sharpness variants without rebuilding. Production defaults were
    // picked from a side-by-side preview (npx electron scripts/preview-
    // thumbnail.js) on a simulated 4.2x bilinear upscale matching DWM's
    // upscale on a 300%-scale display. Weight 700 + 14.5% size came out
    // most legible: bold strokes survive the upscale, slightly larger
    // glyphs accept fewer chars per line in exchange for sharper edges.
    fontWeight = '700',
    fontPxRatio = 0.125,
    fontStack: fontStackOverride = FONT_STACK_UI,
    textColor = FG_THUMB_TEXT,
  } = opts || {};

  const fontStack = JSON.stringify(fontStackOverride);
  // Parse textColor (hex like '#919191') into rgb components so the
  // multi-item branch can emit rgba(r,g,b,alpha) with depth-based fade.
  const colorMatch = String(textColor).match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  const tr = colorMatch ? parseInt(colorMatch[1], 16) : 26;
  const tg = colorMatch ? parseInt(colorMatch[2], 16) : 26;
  const tb = colorMatch ? parseInt(colorMatch[3], 16) : 26;

  // Three-tier content selection. The card renders ONE of these in order
  // of priority — never mixed — so the user's eye lands on a clear,
  // bounded payload rather than juggling multiple stacked sections.
  let items;
  if (firstPromptOverflow) {
    // The overflow already carries its own '…' prefix when the chrome top
    // was cut mid-word (see splitChromeTopAndOverflow in icon-render.js).
    // When cut at a word boundary, no decoration — the overflow reads as
    // a clean continuation.
    items = [{ type: 'prompt', text: firstPromptOverflow }];
  } else if (recentActivity && recentActivity.length > 0) {
    items = recentActivity.map(it => ({ type: it.type || 'prompt', text: it.text || '' }));
  } else if (firstPrompt) {
    items = [{ type: 'prompt', text: firstPrompt }];
  } else {
    items = [];
  }

  return `(async function(){
    const c = document.createElement('canvas');
    c.width = ${width};
    c.height = ${height};
    const ctx = c.getContext('2d');

    ${backgroundPaintSnippet(BG_THUMB)}

    const pad = Math.max(12, Math.round(c.width * 0.035));
    const textLeft = pad;
    const textRight = c.width - pad;
    const textWidth = textRight - textLeft;

    const items = ${JSON.stringify(items)};

    // Font sized to match the OS-rendered chrome-top title text on the
    // thumbnail popup (~12-13 CSS px on Win11). The card sits directly
    // under chrome top, so visually consistent sizing prevents a jarring
    // size shift. ~11% of canvas height gives ~12 canvas px on a 112-tall
    // thumbnail; DWM upscales the bitmap to the popup, so on-screen this
    // reads at roughly the same size as chrome top text.
    //
    // Crispness notes (the bitmap gets bilinear-upscaled ~4x by DWM
    // because of its 200-px-per-side cap; every glyph edge blurs into
    // ~4 phys px). We can't fix the upscale, but these settings minimize
    // its impact:
    //  · Weight 700 (bold) — thick strokes lose proportionally less
    //    width to the AA smear than regular/semibold.
    //  · Larger glyphs (14.5% of canvas height) — more pixels per
    //    character means relatively less blur per stroke.
    //  · Segoe UI Variable Text — Win11's chrome-bar font, heavily
    //    ClearType-hinted at small sizes; survives upscale better than
    //    monospace fonts whose hinting targets larger code-size use.
    //  · lineH and y-positions get Math.round'd before fillText so glyphs
    //    sit on integer pixels — fractional baselines compound the blur.
    //  · 'optimizeLegibility' nudges Chromium toward higher-quality
    //    hinting at small sizes (cost is rendering time, fine here).
    const fontPx = Math.max(11, Math.round(c.height * ${fontPxRatio}));
    const lineH = Math.round(fontPx * 1.30);
    const promptFont = '${fontWeight} ' + fontPx + 'px ' + ${fontStack};
    const titleFont  = 'italic ${fontWeight} ' + fontPx + 'px ' + ${fontStack};
    if ('textRendering' in ctx) ctx.textRendering = 'optimizeLegibility';

    function wrapText(text, maxW, font) {
      ctx.font = font;
      // Honour hard line breaks. The user's typed/pasted prompt can contain
      // newlines (multi-line input is common when pasting code, lists, or
      // structured queries) and the wrapped output should preserve them as
      // real row breaks — splitting on /\\s+/ alone collapses every \\n into
      // a single space and the prompt reads as one run-on paragraph.
      const segments = String(text || '').split(/\\r?\\n/);
      const lines = [];
      for (const seg of segments) {
        if (seg.length === 0) {
          lines.push('');
          continue;
        }
        const words = seg.split(/[ \\t\\f\\v]+/).filter(Boolean);
        let current = '';
        for (const w of words) {
          const test = current ? current + ' ' + w : w;
          if (ctx.measureText(test).width <= maxW) {
            current = test;
            continue;
          }
          if (current) {
            lines.push(current);
            current = '';
          }
          // Token too wide to share a line. Peel off the longest prefix
          // that ends at a non-word character (whitespace or punctuation
          // — ./;,:- etc., everything \\W matches) and still fits the
          // canvas width. URLs and paths have plenty of structural
          // separators, so this almost always finds a clean cut. We
          // never mid-character-cut on canvas surfaces — if a pure
          // alphanumeric run is wider than the line and has no internal
          // break points, we render it whole and accept the visual
          // overflow rather than splitting a word mid-stream.
          let rest = w;
          while (rest && ctx.measureText(rest).width > maxW) {
            let cut = 0;
            for (let i = 1; i < rest.length; i++) {
              if (!/\\W/.test(rest[i - 1])) continue;
              if (ctx.measureText(rest.slice(0, i)).width <= maxW) cut = i;
              else break;
            }
            if (cut === 0) break;
            lines.push(rest.slice(0, cut));
            rest = rest.slice(cut);
          }
          current = rest;
        }
        if (current) lines.push(current);
      }
      return lines;
    }
    function clipWithEllipsis(text, maxW, font) {
      ctx.font = font;
      if (ctx.measureText(text).width <= maxW) return text;
      // Back off at non-word boundaries (whitespace OR punctuation, same
      // \\W definition wrapText uses) so the truncated tail ends on a
      // complete token and reads as a deliberate cut rather than a
      // glitch. If no internal break point lets a prefix + '…' fit, fall
      // through and return the original text — the canvas will visually
      // clip it, which preserves the legible start of the content rather
      // than collapsing to a bare '…'.
      let bestPrefix = null;
      for (let i = 1; i < text.length; i++) {
        if (!/\\W/.test(text[i - 1])) continue;
        const candidate = text.slice(0, i).replace(/\\W+$/, '');
        if (!candidate) continue;
        if (ctx.measureText(candidate + '…').width <= maxW) {
          bestPrefix = candidate;
        } else {
          break;
        }
      }
      return bestPrefix !== null ? bestPrefix + '…' : text;
    }

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // Two render modes depending on what items look like:
    //   · Single item (overflow text or short firstPrompt fallback):
    //     word-wrap it across multiple lines from the TOP of the card.
    //     The user reads top-down, picking up where chrome top left off.
    //   · Multiple items (recent-activity case): bottom-up rendering
    //     with newest at the bottom edge, older entries above fading
    //     upward (terminal-scroll style).
    if (items.length === 1) {
      const item = items[0];
      const isTitle = (item.type === 'title');
      const font = isTitle ? titleFont : promptFont;
      const lines = wrapText(item.text, textWidth, font);
      const maxLines = Math.max(1, Math.floor((c.height - 2 * pad) / lineH));
      const visible = lines.slice(0, maxLines);
      if (lines.length > maxLines && visible.length > 0) {
        const lastIdx = visible.length - 1;
        visible[lastIdx] = clipWithEllipsis(visible[lastIdx] + ' …', textWidth, font);
      }
      ctx.font = font;
      // Same fill color as chrome title text — the card reads as a visual
      // continuation of the title bar above it.
      ctx.fillStyle = ${JSON.stringify(textColor)};
      // Start below the chrome bar with a small breathing margin so glyphs
      // never overlap the flat #f3f3f3 strip at the top.
      let cursorY = Math.max(pad, chromeBarH + 2);
      for (const line of visible) {
        ctx.fillText(line, textLeft, Math.round(cursorY));
        cursorY += lineH;
      }
    } else {
      // Bottom-up rendering for the activity list. Each item word-wraps
      // fully (no artificial line cap) — long prompts read in full. If
      // an item doesn't entirely fit:
      //   · Newest item (depth=0): clip to the lines that fit; the last
      //     visible line gets an ellipsis. The user always sees at least
      //     the start of the most recent activity.
      //   · Older item: stop. Older entries beyond that point drop off
      //     the top intact rather than getting partially rendered.
      const itemGap = Math.round(lineH * 0.25);   // visual gap between items
      let bottomY = c.height - pad;
      let depth = 0;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const isTitle = (item.type === 'title');
        const font = isTitle ? titleFont : promptFont;
        ctx.font = font;
        const allLines = wrapText(item.text, textWidth, font);
        if (allLines.length === 0) continue;

        // How many lines from this item fit in the remaining space?
        // Top boundary is pad OR chromeBarH+2 — whichever is larger — so
        // items never render into the flat chrome-bar strip.
        const topBoundary = Math.max(pad, chromeBarH + 2);
        const availableH = bottomY - topBoundary;
        const maxFit = Math.max(0, Math.floor((availableH - fontPx) / lineH) + 1);
        let lines;
        if (allLines.length <= maxFit) {
          lines = allLines;
        } else if (depth === 0 && maxFit > 0) {
          // Newest item is too tall to fit fully — clip to what fits and
          // mark the cut with an ellipsis on the last visible line.
          lines = allLines.slice(0, maxFit);
          const lastIdx = lines.length - 1;
          lines[lastIdx] = clipWithEllipsis(lines[lastIdx] + ' …', textWidth, font);
        } else {
          // Older item that doesn't fit fully — stop. Older items above
          // drop off the top.
          break;
        }

        // Vertical space: (N-1) line gaps + one font height for the last
        // line (textBaseline=top means a line at y occupies y → y+fontPx).
        const itemHeight = (lines.length - 1) * lineH + fontPx;
        const topY = bottomY - itemHeight;
        const fade = Math.min(0.40, depth * 0.08);
        // Chrome-matching text color fading toward bg as items age.
        // Titles get an additional alpha multiplier so they sit visually
        // dimmer than prompts at the same depth.
        const baseAlpha = isTitle ? 0.65 : 1.0;
        const a = baseAlpha * (1 - fade);
        ctx.fillStyle = 'rgba(${tr},${tg},${tb},' + a.toFixed(2) + ')';
        for (let j = 0; j < lines.length; j++) {
          ctx.fillText(lines[j], textLeft, Math.round(topY + j * lineH));
        }
        bottomY = topY - itemGap;
        depth += 1;
      }
    }

    return c.toDataURL('image/png');
  })()`;
}

// ---- buildLivePreviewScript ----
//
// Larger card for the Aero Peek full-screen live preview. Complementary
// to the small thumbnail (not just a bigger version): instead of "what's
// recent at a glance," the live preview reads as "the session's story" —
// chronological list of all prompts with relative timestamps, bookend
// labels on Initial / Latest, titles inline near their related prompts,
// and middle-elision for long sessions.
//
// Layout sketch:
//
//   claude · working                          started 2h 13m ago
//
//   Initial prompt · 2h 13m ago
//     Investigate the timeout in the worker pool that I noticed
//     yesterday afternoon
//     ↪ Investigating worker timeouts
//
//   1h 50m ago
//     Pause backfill, the workers are timing out
//
//   ⋯ 2 more prompts ⋯
//
//   Latest · 8m ago
//     Now also check the connection pool exhaustion case
//     ↪ Connection pool issues
//
// opts: {
//   width, height,
//   cli, isWorking,
//   allPrompts: [{ prompt, t }],   // chronological, oldest first
//   initialTitle, lockedTitle,
//   sessionStartTime,
// }

function relativeAge(diffMs) {
  if (!Number.isFinite(diffMs) || diffMs < 0 || diffMs < 60000) return 'just now';
  const m = Math.floor(diffMs / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm > 0 ? `${h}h ${mm}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// The live preview's top section already shows the first prompt's
// continuation, so the activity-list bookends only need to highlight
// the newest event. Older overflow gets collapsed under a single
// "⋯ N earlier events ⋯" marker at the top of the list.
const LIVE_MAX_BLOCKS = 10;

function buildLivePreviewBlocks(events, now) {
  const N = events.length;
  if (N === 0) return [];

  function labelFor(t, isLast) {
    const age = relativeAge(now - t);
    return isLast ? `Latest · ${age}` : age;
  }
  function toBlock(ev, isLast) {
    return {
      type: ev.type,
      label: labelFor(ev.t, isLast),
      text: ev.text,
      inlineTitles: ev.inlineTitles || [],
    };
  }

  if (N <= LIVE_MAX_BLOCKS) {
    return events.map((ev, i) => toBlock(ev, i === N - 1));
  }

  const tail = events.slice(-LIVE_MAX_BLOCKS);
  const elidedCount = N - LIVE_MAX_BLOCKS;
  const tailBlocks = tail.map((ev, i) => toBlock(ev, i === tail.length - 1));
  return [{ isElide: true, count: elidedCount }, ...tailBlocks];
}

// Collapse adjacent title events into the preceding prompt event's
// `inlineTitles` array. Titles are short and conceptually attached to
// whatever prompt triggered them, so showing each on its own block row
// wastes vertical space and visually fragments the narrative. Multiple
// consecutive titles (initial title + drift to a locked title) collapse
// onto one " · "-joined indented line beneath the prompt.
function collapseInlineTitles(events) {
  const out = [];
  for (const ev of events) {
    if (ev.type === 'title' && out.length > 0 && out[out.length - 1].type === 'prompt') {
      const last = out[out.length - 1];
      if (!last.inlineTitles) last.inlineTitles = [];
      if (!last.inlineTitles.includes(ev.text)) last.inlineTitles.push(ev.text);
    } else {
      out.push({ ...ev });
    }
  }
  return out;
}

// Target on-screen text size for the live-preview card, in CSS pixels.
// At canvas-pixel time we multiply by displayScale so the bitmap, when
// composited 1:1 to physical pixels by DWM, reads at this CSS-pixel size
// on the user's screen — matching the chrome bar (16px Cascadia Mono)
// and the terminal body underneath.
const LIVE_BODY_CSS_PX = 16;
const LIVE_LABEL_CSS_PX = 12;
const LIVE_ELIDE_CSS_PX = 13;
// Windows taskbar hover UI paints the thumbnail strip and taskbar on top
// of the live-preview bitmap. Keep the metadata footer above that covered
// area instead of anchoring it to the bitmap's physical bottom edge.
const LIVE_TASKBAR_OVERLAY_SAFE_CSS_PX = 180;

function buildLivePreviewScript(opts) {
  const {
    width = 1280,
    height = 720,
    cli = '',
    isWorking = false,
    events = [],
    sessionStartTime = 0,
    displayScale = 1,
    firstPrompt = '',
    firstPromptOverflow = '',
    refs = [],
    initialTitle = '',
    thumbWidth = 0,
    thumbHeight = 0,
  } = opts || {};

  const fontStack = JSON.stringify(FONT_STACK);
  // Icon size in canvas pixels matches the metadata-strip text scale (label
  // font) so the brand glyph sits cleanly beside the cli name in the strip.
  const iconSizePx = Math.max(16, Math.round(LIVE_LABEL_CSS_PX * displayScale * 1.25));
  const iconDataURL = cliIconDataURL(cli, iconSizePx);

  const now = Date.now();
  const startedAgo = sessionStartTime > 0 ? relativeAge(now - sessionStartTime) : '';

  // Two-tier de-duplication across the chrome top and live-preview body:
  //   · Chrome top covers the head of firstPrompt (first ~25 chars).
  //   · firstPromptOverflow carries everything past that point — same
  //     payload the small thumbnail card uses, since the thumb and live
  //     preview never display simultaneously and there's no reason for
  //     them to show different slices of the same prompt.
  //   · Activity list excludes the firstPrompt event entirely so the live
  //     preview never repeats text that's already visible elsewhere.
  // Titles emitted in the firstPrompt's window (i.e., before the second
  // prompt) get attached to the top section's overflow; titles tied to
  // later prompts get collapsed onto a " · "-joined line beneath them.
  const collapsed = collapseInlineTitles(events);
  let topInlineTitles = [];
  const activityEvents = [];
  let foundFirst = false;
  for (const ev of collapsed) {
    if (!foundFirst && ev.type === 'prompt' && ev.text === firstPrompt) {
      topInlineTitles = ev.inlineTitles || [];
      foundFirst = true;
      continue;
    }
    activityEvents.push(ev);
  }
  // initialTitle is already shown in the OS chrome strip (via setTitle in
  // main.js). Drop it from topInlineTitles so the body's "↪ …" line doesn't
  // repeat what the user is already reading at the top of the popup.
  if (initialTitle) {
    topInlineTitles = topInlineTitles.filter(t => t !== initialTitle);
  }
  // If no firstPrompt match (pre-prompt state), titles already collected
  // as standalone 'title' events stay in activityEvents — handled by the
  // block renderer's title-block branch.
  const blocks = buildLivePreviewBlocks(activityEvents, now);

  return `(async function(){
    const c = document.createElement('canvas');
    c.width = ${width};
    c.height = ${height};
    const ctx = c.getContext('2d');

    ${backgroundPaintSnippet()}

    // Padding scales with the display scale factor (not canvas height)
    // so it stays at a constant CSS-px size on screen. 24 CSS-px gives
    // breathing room without eating noticeable real estate.
    const pad = Math.round(24 * ${displayScale});
    const textLeft = pad;
    const textRight = c.width - pad;
    const textWidth = textRight - textLeft;

    const cli = ${JSON.stringify(cli)};
    const isWorking = ${isWorking ? 'true' : 'false'};
    const startedAgo = ${JSON.stringify(startedAgo)};
    const blocks = ${JSON.stringify(blocks)};
    const firstPromptOverflow = ${JSON.stringify(firstPromptOverflow || '')};
    const topInlineTitles = ${JSON.stringify(topInlineTitles)};
    const refs = ${JSON.stringify(refs || [])};
    const iconDataURL = ${JSON.stringify(iconDataURL || '')};
    const iconSizePx = ${iconSizePx};
    const THUMB_W = ${Number(thumbWidth) || 0};
    const THUMB_H = ${Number(thumbHeight) || 0};
    const THUMB_FONT_STACK = ${JSON.stringify(FONT_STACK_UI)};

    const FG = ${JSON.stringify(FG)};
    const FG_DIM = ${JSON.stringify(FG_DIM)};
    const FG_FAINT = ${JSON.stringify(FG_FAINT)};
    const FG_WORK = ${JSON.stringify(FG_ACCENT_WORK)};
    const FG_IDLE = ${JSON.stringify(FG_ACCENT_IDLE)};

    // Pre-load brand icon
    let cliIconImg = null;
    if (iconDataURL) {
      cliIconImg = new Image();
      try {
        await new Promise((res, rej) => {
          cliIconImg.onload = res; cliIconImg.onerror = rej; cliIconImg.src = iconDataURL;
        });
      } catch { cliIconImg = null; }
    }

    function wrapText(text, maxW, font, useCtx) {
      const cc = useCtx || ctx;
      cc.font = font;
      // Honour hard line breaks. The user's typed/pasted prompt can contain
      // newlines (multi-line input is common when pasting code, lists, or
      // structured queries) and the wrapped output should preserve them as
      // real row breaks — splitting on /\\s+/ alone collapses every \\n into
      // a single space and the prompt reads as one run-on paragraph.
      const segments = String(text || '').split(/\\r?\\n/);
      const lines = [];
      for (const seg of segments) {
        if (seg.length === 0) {
          lines.push('');
          continue;
        }
        const words = seg.split(/[ \\t\\f\\v]+/).filter(Boolean);
        let current = '';
        for (const w of words) {
          const test = current ? current + ' ' + w : w;
          if (cc.measureText(test).width <= maxW) {
            current = test;
            continue;
          }
          if (current) {
            lines.push(current);
            current = '';
          }
          // Token too wide to share a line. Peel off the longest prefix
          // that ends at a non-word character (whitespace or punctuation
          // — ./;,:- etc., everything \\W matches) and still fits the
          // canvas width. URLs and paths have plenty of structural
          // separators, so this almost always finds a clean cut. We
          // never mid-character-cut on canvas surfaces — if a pure
          // alphanumeric run is wider than the line and has no internal
          // break points, we render it whole and accept the visual
          // overflow rather than splitting a word mid-stream.
          let rest = w;
          while (rest && cc.measureText(rest).width > maxW) {
            let cut = 0;
            for (let i = 1; i < rest.length; i++) {
              if (!/\\W/.test(rest[i - 1])) continue;
              if (cc.measureText(rest.slice(0, i)).width <= maxW) cut = i;
              else break;
            }
            if (cut === 0) break;
            lines.push(rest.slice(0, cut));
            rest = rest.slice(cut);
          }
          current = rest;
        }
        if (current) lines.push(current);
      }
      return lines;
    }
    // Compute the position in firstPromptOverflow where the small thumb
    // card stops rendering, so the live preview's top section can pick
    // up exactly there with zero character overlap. We do the math on a
    // phantom canvas matching the thumb's dimensions / font / padding so
    // the cut point is pixel-accurate rather than a char-count estimate.
    // The two surfaces never display simultaneously, but the user's eye
    // moves from one to the other during the Aero Peek transition; any
    // repeated chars re-trigger reading, so dropping repetition keeps
    // the transition feeling like a continuation rather than a restart.
    function thumbCutPosition(text) {
      if (!text || THUMB_W <= 0 || THUMB_H <= 0) return 0;
      const tc = document.createElement('canvas');
      tc.width = THUMB_W;
      tc.height = THUMB_H;
      const tctx = tc.getContext('2d');
      // Mirror the thumb's buildScript layout math exactly.
      const tpad = Math.max(12, Math.round(tc.width * 0.035));
      const tFontPx = Math.max(11, Math.round(tc.height * 0.125));
      const tLineH = Math.round(tFontPx * 1.30);
      const tFont = '700 ' + tFontPx + 'px ' + THUMB_FONT_STACK;
      const tTextWidth = tc.width - 2 * tpad;
      const tMaxLines = Math.max(1, Math.floor((tc.height - 2 * tpad) / tLineH));
      const tLines = wrapText(text, tTextWidth, tFont, tctx);
      if (tLines.length <= tMaxLines) return text.length;
      // Walk visible lines forward through the original text. Each wrapped
      // line is a substring of the input (modulo whitespace that wrapText
      // collapsed at line boundaries), so indexOf from the running cursor
      // finds where it lands and we advance past it.
      let pos = 0;
      for (let i = 0; i < tMaxLines; i++) {
        const idx = text.indexOf(tLines[i], pos);
        if (idx === -1) return pos;
        pos = idx + tLines[i].length;
      }
      return pos;
    }
    const liveBodyText = firstPromptOverflow.slice(thumbCutPosition(firstPromptOverflow));
    function clipWithEllipsis(text, maxW, font) {
      ctx.font = font;
      if (ctx.measureText(text).width <= maxW) return text;
      // Back off at non-word boundaries (whitespace OR punctuation, same
      // \\W definition wrapText uses) so the truncated tail ends on a
      // complete token and reads as a deliberate cut rather than a
      // glitch. If no internal break point lets a prefix + '…' fit, fall
      // through and return the original text — the canvas will visually
      // clip it, which preserves the legible start of the content rather
      // than collapsing to a bare '…'.
      let bestPrefix = null;
      for (let i = 1; i < text.length; i++) {
        if (!/\\W/.test(text[i - 1])) continue;
        const candidate = text.slice(0, i).replace(/\\W+$/, '');
        if (!candidate) continue;
        if (ctx.measureText(candidate + '…').width <= maxW) {
          bestPrefix = candidate;
        } else {
          break;
        }
      }
      return bestPrefix !== null ? bestPrefix + '…' : text;
    }

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    // Start below the chrome bar (#f3f3f3 flat strip painted in
    // backgroundPaintSnippet) with a small scaled gap so glyphs sit on
    // the gradient body rather than the bar. chromeBarH is declared in
    // the surrounding scope by backgroundPaintSnippet().
    let cursorY = Math.max(pad, chromeBarH + Math.round(8 * ${displayScale}));

    // Font sizes scale by the display's scale factor so the bitmap reads
    // at terminal-matching CSS-pixel sizes on screen. e.g. on a 300%
    // display, body text at LIVE_BODY_CSS_PX=16 CSS px is 48 canvas px;
    // DWM composites the bitmap to physical pixels 1:1, so the visible
    // size is 16 CSS px — same as the chrome bar / terminal body.
    const scale = ${displayScale};
    const labelFontPx  = Math.round(${LIVE_LABEL_CSS_PX}  * scale);
    const bodyFontPx   = Math.round(${LIVE_BODY_CSS_PX}   * scale);
    const titleFontPx  = Math.round(${LIVE_BODY_CSS_PX}   * scale);
    const elideFontPx  = Math.round(${LIVE_ELIDE_CSS_PX}  * scale);
    const labelFont  = '400 ' + labelFontPx  + 'px ' + ${fontStack};
    const bodyFont   = '500 ' + bodyFontPx   + 'px ' + ${fontStack};
    const titleFont  = 'italic 400 ' + titleFontPx + 'px ' + ${fontStack};
    const elideFont  = 'italic 400 ' + elideFontPx + 'px ' + ${fontStack};

    const labelLineH = labelFontPx * 1.4;
    const bodyLineH  = bodyFontPx  * 1.35;
    const titleLineH = titleFontPx * 1.35;
    const elideLineH = elideFontPx * 1.5;
    const blockGap   = Math.round(scale * 14);

    // Activity-block prompts are allowed many more lines than before so
    // long pastes / multi-line prompts read in full instead of clipping
    // to a "…" after 3 rows. The activity loop's bottom-limit check still
    // bounds total height — this just lets individual prompts breathe up
    // to that limit rather than artificially capping each one short.
    const MAX_PROMPT_LINES = 12;
    const MAX_TITLE_LINES = 1;
    const bodyIndent = Math.round(scale * 12);

    function wrappedLines(text, maxLines, font, indent) {
      const allLines = wrapText(text, textWidth - indent, font);
      const lines = allLines.slice(0, maxLines);
      if (allLines.length > maxLines && lines.length > 0) {
        const lastIdx = lines.length - 1;
        lines[lastIdx] = clipWithEllipsis(lines[lastIdx] + ' …', textWidth - indent, font);
      }
      return lines;
    }

    function drawLines(lines, font, fillStyle, indent, lineH) {
      ctx.font = font;
      ctx.fillStyle = fillStyle;
      for (const line of lines) {
        ctx.fillText(line, textLeft + indent, Math.round(cursorY));
        cursorY += lineH;
      }
    }

    // Helper: draws a wrapped, capped block of body or italic text and
    // advances cursorY. Returns the number of lines actually drawn so
    // callers can decide whether to continue or break.
    function drawWrapped(text, maxLines, font, fillStyle, indent, lineH) {
      const lines = wrappedLines(text, maxLines, font, indent);
      drawLines(lines, font, fillStyle, indent, lineH);
      return lines.length;
    }

    // ---- TOP SECTION: first-prompt tail (past where thumb card cuts) ----
    // Three-tier cascade with zero overlap: chrome top (popup title bar)
    // shows the head of firstPrompt, the small thumb card renders as
    // much of the overflow as fits its 280x158 canvas, and this section
    // picks up wherever the thumb's wrap landed. For short prompts the
    // thumb consumes everything and this section is empty — that's fine,
    // the activity timeline below takes the space. Titles emitted in the
    // first prompt's window get inlined here too (as a " · "-joined ↪
    // line), since they belong to the firstPrompt context regardless of
    // which surface the prompt text itself happens to land on.
    const MAX_TOP_PROMPT_LINES = 8;
    if (liveBodyText) {
      drawWrapped(liveBodyText, MAX_TOP_PROMPT_LINES, bodyFont, FG, 0, bodyLineH);
      if (topInlineTitles.length > 0) {
        drawWrapped('↪ ' + topInlineTitles.join(' · '), 1, titleFont, FG_DIM, bodyIndent, titleLineH);
      }
      cursorY += Math.round(scale * 12);
    } else if (topInlineTitles.length > 0) {
      // No continuation but the first prompt did emit titles — surface
      // them at the top so the user sees the session's distilled labels
      // first, before the activity timeline.
      drawWrapped('↪ ' + topInlineTitles.join(' · '), 1, titleFont, FG_DIM, 0, titleLineH);
      cursorY += Math.round(scale * 12);
    }

    // ---- ACTIVITY BLOCKS ----
    // Reserve space at the bottom for the metadata footer (cli icon +
    // name + status + started time) AND a references block above it
    // (URLs / paths / @-mentions stripped from the prompt body). The
    // activity loop stops before reaching either reserve zone.
    const footerLineH = Math.max(labelFontPx, iconSizePx);
    const footerReserve = footerLineH + Math.round(scale * 12);
    const MAX_REFS_DISPLAYED = 4;
    const refsFontPx = labelFontPx;
    const refsLineH = Math.round(refsFontPx * 1.4);
    const refsVisible = Math.min(refs.length, MAX_REFS_DISPLAYED);
    const refsExtraRow = refs.length > MAX_REFS_DISPLAYED ? 1 : 0;
    const refsTotalRows = refsVisible + refsExtraRow;
    const refsReserve = refsTotalRows > 0
      ? refsTotalRows * refsLineH + Math.round(scale * 14)
      : 0;
    const taskbarOverlaySafeInset = Math.min(
      Math.round(${LIVE_TASKBAR_OVERLAY_SAFE_CSS_PX} * scale),
      Math.max(0, Math.round(c.height * 0.28)),
    );
    const safeBottomY = c.height - pad - taskbarOverlaySafeInset;
    const activityBottomLimit = safeBottomY - footerReserve - refsReserve;

    function prepareElideBlock(count) {
      return {
        isElide: true,
        count,
        height: elideLineH + blockGap,
      };
    }

    function prepareActivityBlock(block, heightLimit) {
      const isTitle = (block.type === 'title');
      const prefix = isTitle ? '↪ ' : '';
      const contentFont = isTitle ? titleFont : bodyFont;
      const contentFillStyle = isTitle ? FG_DIM : FG;
      const contentLineH = isTitle ? titleLineH : bodyLineH;
      const maxLines = isTitle ? MAX_TITLE_LINES : MAX_PROMPT_LINES;
      let maxContentLines = maxLines;

      if (Number.isFinite(heightLimit)) {
        const contentRoom = heightLimit - labelLineH - blockGap;
        maxContentLines = Math.min(maxLines, Math.floor(contentRoom / contentLineH));
      }
      if (maxContentLines <= 0) return null;

      const contentLines = wrappedLines(prefix + block.text, maxContentLines, contentFont, bodyIndent);
      if (contentLines.length === 0) return null;

      let height = labelLineH + contentLines.length * contentLineH;
      let inlineTitleLines = [];
      if (!isTitle && block.inlineTitles && block.inlineTitles.length > 0) {
        const inlineText = '↪ ' + block.inlineTitles.join(' · ');
        if (Number.isFinite(heightLimit)) {
          const inlineRoom = heightLimit - height - blockGap;
          const inlineMaxLines = Math.min(1, Math.floor(inlineRoom / titleLineH));
          if (inlineMaxLines > 0) {
            inlineTitleLines = wrappedLines(inlineText, inlineMaxLines, titleFont, bodyIndent);
          }
        } else {
          inlineTitleLines = wrappedLines(inlineText, 1, titleFont, bodyIndent);
        }
        height += inlineTitleLines.length * titleLineH;
      }

      return {
        label: block.label,
        isTitle,
        contentFont,
        contentFillStyle,
        contentLineH,
        contentLines,
        inlineTitleLines,
        height: height + blockGap,
      };
    }

    function selectActivityBlocks() {
      const renderableBlocks = blocks.filter(block => !block.isElide);
      const alreadyElidedCount = blocks.reduce(
        (sum, block) => sum + (block.isElide ? block.count : 0),
        0,
      );
      const maxHeight = Math.max(0, activityBottomLimit - cursorY);
      const selected = [];
      let usedHeight = 0;
      let omittedVisibleCount = 0;

      for (let i = renderableBlocks.length - 1; i >= 0; i--) {
        const remaining = maxHeight - usedHeight;
        const prepared = prepareActivityBlock(renderableBlocks[i], Infinity);
        if (prepared && prepared.height <= remaining) {
          selected.unshift(prepared);
          usedHeight += prepared.height;
          continue;
        }

        if (i === renderableBlocks.length - 1) {
          const truncated = prepareActivityBlock(renderableBlocks[i], remaining);
          if (truncated) {
            selected.unshift(truncated);
            usedHeight += truncated.height;
            omittedVisibleCount = i;
          } else {
            omittedVisibleCount = i + 1;
          }
        } else {
          omittedVisibleCount = i + 1;
        }
        break;
      }

      const omittedCount = alreadyElidedCount + omittedVisibleCount;
      if (omittedCount > 0) {
        const elideBlock = prepareElideBlock(omittedCount);
        if (elideBlock.height <= maxHeight - usedHeight) {
          selected.unshift(elideBlock);
        }
      }

      return selected;
    }

    for (const block of selectActivityBlocks()) {
      if (block.isElide) {
        ctx.font = elideFont;
        ctx.fillStyle = FG_FAINT;
        ctx.textAlign = 'center';
        const noun = block.count === 1 ? 'event' : 'events';
        ctx.fillText('⋯ ' + block.count + ' earlier ' + noun + ' ⋯',
                     c.width / 2, Math.round(cursorY));
        ctx.textAlign = 'left';
        cursorY += elideLineH + blockGap;
        continue;
      }

      // Label (timestamp).
      ctx.font = labelFont;
      ctx.fillStyle = FG_DIM;
      ctx.fillText(block.label, textLeft, Math.round(cursorY));
      cursorY += labelLineH;

      // Prompt body (or standalone title text — rare, pre-prompt path).
      drawLines(block.contentLines, block.contentFont, block.contentFillStyle, bodyIndent, block.contentLineH);

      // Inline titles attached to this prompt — collapsed onto one " · "
      // -joined line so a session with N titles doesn't burn N rows.
      if (block.inlineTitleLines.length > 0) {
        drawLines(block.inlineTitleLines, titleFont, FG_DIM, bodyIndent, titleLineH);
      }

      cursorY += blockGap;
    }

    // ---- REFERENCES BLOCK ----
    // Verbatim URLs / paths / @-mentions stripped from the prompt body
    // (chrome strip / thumb card / live preview top all show shortened
    // forms like "…34" or "filename"; this block shows
    // the originals so the user can read what was actually referenced).
    // Sits just above the metadata footer, one per line, dim color so it
    // doesn't compete with the prompt and activity above.
    if (refsTotalRows > 0) {
      const refsFont = '400 ' + refsFontPx + 'px ' + ${fontStack};
      const refsTop = safeBottomY - footerReserve - refsReserve + Math.round(scale * 10);
      ctx.font = refsFont;
      ctx.fillStyle = FG_DIM;
      let refY = refsTop;
      for (let i = 0; i < refsVisible; i++) {
        const ref = refs[i];
        const line = clipWithEllipsis(ref.full, textWidth, refsFont);
        ctx.fillText(line, textLeft, Math.round(refY));
        refY += refsLineH;
      }
      if (refsExtraRow) {
        ctx.fillStyle = FG_FAINT;
        ctx.fillText('+ ' + (refs.length - refsVisible) + ' more',
                     textLeft, Math.round(refY));
      }
    }

    // ---- METADATA FOOTER: cli icon · name · status · started X ago ----
    // Peripheral metadata at the bottom edge. The gradient is at its
    // darkest here (~#9a9a9a), so we use solid dark text rather than
    // alpha-blended dim greys — those would wash out and be unreadable
    // against the dark end of the gradient.
    {
      const footerY = safeBottomY - footerLineH;
      let cursorX = textLeft;
      const iconY = footerY + Math.max(0, Math.round((labelFontPx - iconSizePx) / 2));
      if (cliIconImg) {
        ctx.drawImage(cliIconImg, cursorX, iconY, iconSizePx, iconSizePx);
        cursorX += iconSizePx + Math.round(scale * 6);
      } else if (cli) {
        ctx.font = '600 ' + labelFontPx + 'px ' + ${fontStack};
        ctx.fillStyle = FG;
        ctx.fillText(cli, cursorX, footerY);
        cursorX += ctx.measureText(cli).width;
      }
      ctx.font = labelFont;
      if (cli) {
        ctx.fillStyle = FG;
        const sep1 = ' · ';
        ctx.fillText(sep1, cursorX, footerY);
        cursorX += ctx.measureText(sep1).width;
        ctx.fillStyle = isWorking ? FG_WORK : FG_IDLE;
        const statusText = isWorking ? 'working' : 'idle';
        ctx.fillText(statusText, cursorX, footerY);
        cursorX += ctx.measureText(statusText).width;
      }
      if (startedAgo) {
        ctx.fillStyle = 'rgba(40,40,40,0.85)';
        const sep2 = (cli ? ' · ' : '');
        const fullText = sep2 + 'started ' + startedAgo;
        ctx.fillText(fullText, cursorX, footerY);
      }
    }

    return c.toDataURL('image/png');
  })()`;
}

module.exports = { buildScript, buildLivePreviewScript };
