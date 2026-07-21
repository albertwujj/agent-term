// Side-by-side comparison of how the half-color icon "eases to" the letter.
// Same row of prompts repeated under several approaches stacked vertically.

const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const SAMPLES = [
  { idx: 0, prompt: 'Migrate the database schema' },     // M — wide
  { idx: 1, prompt: 'Watch the build progress' },        // W — widest
  { idx: 2, prompt: 'Fix the auth bug' },                // F
  { idx: 3, prompt: 'Investigate the flaky test' },      // I — narrow
  { idx: 4, prompt: 'Code review the PR' },              // C
  { idx: 5, prompt: 'Refactor the middleware' },         // R
  { idx: 6, prompt: 'Update the markdown docs' },        // U
];

// Sample mix tilted toward wide letters so the overlap problem shows up.
const SAMPLES_FOR_WIDE = SAMPLES;

// Final comparisons around the n3 + letter-width underline (last best):
const VARIANTS = [
  { id: 'n3-ul-letterw',     label: '1) BASELINE — n3 + letter-width 2px (last best)' },
  { id: 'n3-ul-letterw-1',   label: '2) n3 + letter-width 1px (thinner)' },
  { id: 'n3-ul-letterw-3',   label: '3) n3 + letter-width 3px (thicker)' },
  { id: 'n3-ul-letterw-pill',label: '4) n3 + letter-width 2px with rounded ends (pill)' },
  { id: 'n2-ul-letterw',     label: '5) n2 + letter-width 2px (less info, more breathing room)' },
  { id: 'n4-ul-letterw',     label: '6) n4 + letter-width 2px (more info, tighter)' },
];

const ICON_HUE_STEP = 24;
const OKLCH_L = 65;
const OKLCH_C = 0.17;

function firstLetterOf(prompt) {
  const idx = (prompt || '').search(/[A-Za-z]/);
  if (idx < 0) return { letter: '?', restFrom: 0 };
  return { letter: prompt[idx].toUpperCase(), restFrom: idx + 1 };
}

function renderScript(sessions, variants, scale) {
  return `(function(){
    const SCALE = ${scale};
    const TASKBAR_HEIGHT = 48 * SCALE;
    const ICON = 24 * SCALE;
    const ICON_RX = 6 * SCALE;
    const BUTTON_W = 220 * SCALE;
    const PAD_LEFT_FIRST = 12 * SCALE;
    const ICON_X_PAD = 12 * SCALE;
    const FONT_PX = 12 * SCALE;
    const LABEL_PX = 13 * SCALE;
    const PANEL_LABEL_HEIGHT = 32 * SCALE;
    const PANEL_GAP = 6 * SCALE;

    const sessions = ${JSON.stringify(sessions)};
    const variants = ${JSON.stringify(variants)};
    const W = PAD_LEFT_FIRST + sessions.length * BUTTON_W + 12 * SCALE;
    const ROW_H = PANEL_LABEL_HEIGHT + TASKBAR_HEIGHT;
    const H = variants.length * (ROW_H + PANEL_GAP) + PANEL_GAP;

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    function leftRoundedRectPath(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.arcTo(x, y + h, x, y + h - r, r);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.closePath();
    }

    function drawIcon(variantId, s, ix, iy) {
      const w = ICON, h = ICON;
      const chipBaseW = w / 2;
      const chipExtra = w * 0.10;          // breathing room for fades
      const hueColor = 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ')';

      // Clip everything we draw to the icon's pixel rectangle. In production
      // the icon IS a fixed-size PNG, so anything past the icon's bounds is
      // automatically not visible. Without this clip the mockup misleads —
      // letters drawn past the right edge would land in the text region.
      ctx.save();
      ctx.beginPath();
      ctx.rect(ix, iy, w, h);
      ctx.clip();

      // Concave-right chip: flat top + flat bottom, both extending to the
      // right edge; the right edge is a concave arc that dips INWARD (toward
      // the chip's center) so the letter nestles into the cup. Optionally
      // combined with an alpha fade on the right.
      //
      // Knobs:
      //   chipExtraFrac — how far past chipBaseW the chip's flat edges extend
      //   concaveFrac   — how far the right-edge arc dips inward, as a fraction
      //                   of chipFullW (depth of the C-shape's mouth)
      //   leftR         — corner radius on the left side
      //   fadeStartFrac — alpha-fade start (1.0 = no fade)
      // Knobs:
      //   shape — 'concave' | 'fade-to-letter'
      //   For 'fade-to-letter':
      //     fadeLengthFrac — width of the fade region as fraction of icon width
      //     gapFrac        — fully-transparent gap between fade end and letter
      //                      start, as fraction of icon width
      //     fadeEased      — cubic-eased fade instead of linear
      //   Letter:
      //     letterPos = 'right-fit' (per-glyph dynamic), fontFrac = font size
      const knobs = {
        'n3-ul-letterw':       { shape: 'underline', ulPx: 2, ulMode: 'letter', ulRound: false, fontPx: FONT_PX, nLetters: 3, fontWeight: 400 },
        'n3-ul-letterw-1':     { shape: 'underline', ulPx: 1, ulMode: 'letter', ulRound: false, fontPx: FONT_PX, nLetters: 3, fontWeight: 400 },
        'n3-ul-letterw-3':     { shape: 'underline', ulPx: 3, ulMode: 'letter', ulRound: false, fontPx: FONT_PX, nLetters: 3, fontWeight: 400 },
        'n3-ul-letterw-pill':  { shape: 'underline', ulPx: 2, ulMode: 'letter', ulRound: true,  fontPx: FONT_PX, nLetters: 3, fontWeight: 400 },
        'n2-ul-letterw':       { shape: 'underline', ulPx: 2, ulMode: 'letter', ulRound: false, fontPx: FONT_PX, nLetters: 2, fontWeight: 400 },
        'n4-ul-letterw':       { shape: 'underline', ulPx: 2, ulMode: 'letter', ulRound: false, fontPx: FONT_PX, nLetters: 4, fontWeight: 400 },
      }[variantId];
      const chipFullW = chipBaseW + w * (knobs.chipExtraFrac || 0);
      const concaveDepth = chipFullW * (knobs.concaveFrac || 0);
      const fadeStart = chipBaseW * (knobs.fadeStartFrac || 1);
      const leftR = knobs.leftR || 0;
      const hueColorVar = 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ')';
      const transparentVar = 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ' / 0)';

      // Set the font early; per-variant weight + size.
      const fontWeight = knobs.fontWeight || 500;
      ctx.font = fontWeight + ' ' + Math.round(h * (knobs.fontFrac || 0.5)) + 'px "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // ---- underline: N letters at button-text size + color, with a thin
      //      colored bar UNDER the letters carrying the per-session hue.
      if (knobs.shape === 'underline') {
        const ulPx = knobs.ulPx * SCALE;
        const ulY = iy + h - ulPx - 1 * SCALE;     // 1px gap from icon bottom
        const hueColor = 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ')';
        ctx.fillStyle = '#cccccc';
        ctx.font = (knobs.fontWeight || 400) + ' ' + knobs.fontPx + 'px "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const rightPad = 1 * SCALE;
        const n = knobs.nLetters || 2;
        // Compute letters inline (avoids JSON-roundtrip lookup issues).
        const fIdx = s.prompt.search(/[A-Za-z]/);
        let letters = '?'.repeat(n);
        if (fIdx >= 0) {
          letters = s.prompt[fIdx].toUpperCase();
          for (let i = 1; i < n && fIdx + i < s.prompt.length; i++) {
            letters += s.prompt[fIdx + i];
          }
        }
        // Letter vertically centered in the icon so it aligns with the
        // title text (which is also vertically centered in the taskbar row).
        const letterY = iy + h / 2;
        // Measure for the letter-width underline mode.
        const letterMetrics = ctx.measureText(letters);
        const letterWidth = letterMetrics.width;
        ctx.fillText(letters, ix + w - rightPad, letterY);

        // Underline.
        ctx.fillStyle = hueColor;
        let ulLeft, ulW;
        if (knobs.ulMode === 'letter') {
          ulLeft = ix + w - rightPad - letterWidth;
          ulW = letterWidth;
        } else {
          ulLeft = ix;
          ulW = w;
        }
        if (knobs.ulRound) {
          const r = ulPx / 2;
          ctx.beginPath();
          ctx.moveTo(ulLeft + r, ulY);
          ctx.arcTo(ulLeft + ulW, ulY, ulLeft + ulW, ulY + r, r);
          ctx.lineTo(ulLeft + ulW, ulY + ulPx - r);
          ctx.arcTo(ulLeft + ulW, ulY + ulPx, ulLeft + ulW - r, ulY + ulPx, r);
          ctx.lineTo(ulLeft + r, ulY + ulPx);
          ctx.arcTo(ulLeft, ulY + ulPx, ulLeft, ulY + ulPx - r, r);
          ctx.lineTo(ulLeft, ulY + r);
          ctx.arcTo(ulLeft, ulY, ulLeft + r, ulY, r);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(ulLeft, ulY, ulW, ulPx);
        }
        ctx.restore();
        return;
      }

      // ---- stripe-two: thin colored bar on the left + first TWO letters
      //      of the prompt at button-text size/color, leading into the rest
      //      of the prompt text.
      if (knobs.shape === 'stripe-two') {
        const stripeW = knobs.stripePx;
        if (stripeW > 0) {
          const hueColor = 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ')';
          ctx.fillStyle = hueColor;
          if (knobs.stripeRound) {
            const stripeR = stripeW / 2;
            const inset = stripeW;          // bring stripe in from icon top/bottom
            ctx.beginPath();
            ctx.moveTo(ix + stripeR, iy + inset);
            ctx.arcTo(ix, iy + inset, ix, iy + inset + stripeR, stripeR);
            ctx.lineTo(ix, iy + h - inset - stripeR);
            ctx.arcTo(ix, iy + h - inset, ix + stripeR, iy + h - inset, stripeR);
            ctx.lineTo(ix + stripeW - stripeR, iy + h - inset);
            ctx.arcTo(ix + stripeW, iy + h - inset, ix + stripeW, iy + h - inset - stripeR, stripeR);
            ctx.lineTo(ix + stripeW, iy + inset + stripeR);
            ctx.arcTo(ix + stripeW, iy + inset, ix + stripeW - stripeR, iy + inset, stripeR);
            ctx.closePath();
            ctx.fill();
          } else {
            ctx.fillRect(ix, iy, stripeW, h);
          }
        }
        // N letters at button-text size, right-aligned within the icon's
        // letter zone. Compute letters inline to avoid any JSON-roundtrip
        // weirdness with precomputed lookup objects.
        const lc = knobs.letterColor === 'hue'
          ? 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ')'
          : '#cccccc';
        ctx.fillStyle = lc;
        ctx.font = (knobs.fontWeight || 400) + ' ' + knobs.fontPx + 'px "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const rightPad = 1;
        const n = knobs.nLetters || 2;
        const fIdx = s.prompt.search(/[A-Za-z]/);
        let letters = '?'.repeat(n);
        if (fIdx >= 0) {
          letters = s.prompt[fIdx].toUpperCase();
          for (let i = 1; i < n && fIdx + i < s.prompt.length; i++) {
            letters += s.prompt[fIdx + i];
          }
        }
        ctx.fillText(letters, ix + w - rightPad, iy + h / 2);
        ctx.restore();
        return;
      }

      // ---- bracket: "[" shape — top + left + bottom edges colored, right
      //      side open so the letter flows directly into the rest of text.
      if (knobs.shape === 'bracket') {
        const borderW = w * knobs.borderFrac;
        const fullR = ICON_RX;
        const innerR = Math.max(2, fullR - borderW);
        const hueColor = 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ')';
        const innerX = ix + borderW;
        const innerY = iy + borderW;
        const innerH = h - borderW * 2;

        ctx.fillStyle = hueColor;
        ctx.beginPath();
        // Outer perimeter going around three sides of the icon (top, left,
        // bottom), with the right edge replaced by a horizontal cut at the
        // inner top + bottom of the bracket.
        // Start at the inner-bottom-right corner of the bracket.
        ctx.moveTo(ix + w, iy + h);
        // Bottom edge: rightward (already there) → leftward to bottom-left corner
        ctx.lineTo(ix + fullR, iy + h);
        // Bottom-left rounded corner.
        ctx.arcTo(ix, iy + h, ix, iy + h - fullR, fullR);
        // Left edge upward.
        ctx.lineTo(ix, iy + fullR);
        // Top-left rounded corner.
        ctx.arcTo(ix, iy, ix + fullR, iy, fullR);
        // Top edge rightward to top-right corner of icon.
        ctx.lineTo(ix + w, iy);
        // Down the right edge to inner-top-right.
        ctx.lineTo(ix + w, innerY);
        // Inner top edge leftward.
        ctx.lineTo(innerX + innerR, innerY);
        // Inner top-left rounded corner.
        ctx.arcTo(innerX, innerY, innerX, innerY + innerR, innerR);
        // Inner left edge downward.
        ctx.lineTo(innerX, innerY + innerH - innerR);
        // Inner bottom-left rounded corner.
        ctx.arcTo(innerX, innerY + innerH, innerX + innerR, innerY + innerH, innerR);
        // Inner bottom edge rightward.
        ctx.lineTo(ix + w, innerY + innerH);
        // Back down to start.
        ctx.lineTo(ix + w, iy + h);
        ctx.closePath();
        ctx.fill();

        // Letter inside the bracket, right-aligned (close to the open side
        // where the rest of text begins).
        ctx.fillStyle = '#cccccc';
        ctx.font = '400 ' + FONT_PX + 'px "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const letterRightPad = 2;
        ctx.fillText(s.letter, ix + w - letterRightPad, innerY + innerH / 2);
        ctx.restore();
        return;
      }

      // ---- border: colored frame, letter inside near right ----
      // The frame is a "donut": outer rect path + inner rect path, filled
      // with even-odd rule. The inner area is NEVER filled by the icon, so
      // whatever was on the canvas before (mockup: #1c1c1c, real Windows:
      // taskbar button bg through the PNG's transparent pixels) shows there.
      if (knobs.shape === 'border') {
        const borderW = w * knobs.borderFrac;
        const fullR = ICON_RX;
        const innerR = Math.max(2, fullR - borderW);
        const hueColor = 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ')';
        const innerX = ix + borderW;
        const innerY = iy + borderW;
        const innerW = w - borderW * 2;
        const innerH = h - borderW * 2;

        ctx.beginPath();
        // Outer rounded rect (clockwise).
        ctx.moveTo(ix + fullR, iy);
        ctx.arcTo(ix + w, iy, ix + w, iy + fullR, fullR);
        ctx.arcTo(ix + w, iy + h, ix + w - fullR, iy + h, fullR);
        ctx.arcTo(ix, iy + h, ix, iy + h - fullR, fullR);
        ctx.arcTo(ix, iy, ix + fullR, iy, fullR);
        ctx.closePath();
        // Inner rounded rect — same beginPath, even-odd will subtract it.
        ctx.moveTo(innerX + innerR, innerY);
        ctx.arcTo(innerX + innerW, innerY, innerX + innerW, innerY + innerR, innerR);
        ctx.arcTo(innerX + innerW, innerY + innerH, innerX + innerW - innerR, innerY + innerH, innerR);
        ctx.arcTo(innerX, innerY + innerH, innerX, innerY + innerH - innerR, innerR);
        ctx.arcTo(innerX, innerY, innerX + innerR, innerY, innerR);
        ctx.closePath();
        if (knobs.withGradient) {
          const grad = ctx.createLinearGradient(ix, iy, ix, iy + h);
          grad.addColorStop(0, 'oklch(72% ${OKLCH_C} ' + s.hue + ')');
          grad.addColorStop(1, 'oklch(58% ${OKLCH_C} ' + s.hue + ')');
          ctx.fillStyle = grad;
        } else {
          ctx.fillStyle = hueColor;
        }
        ctx.fill('evenodd');

        // Letter at button-text size/color, right-aligned inside the frame.
        ctx.fillStyle = '#cccccc';
        ctx.font = '400 ' + FONT_PX + 'px "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const letterRightPad = Math.max(2, borderW * 0.5);
        ctx.fillText(s.letter, innerX + innerW - letterRightPad, innerY + innerH / 2);
        ctx.restore();   // close icon-bounds clip
        return;
      }

      // ---- letter-only short-circuit: no chip, no fade, no frame ----
      // We're already inside the icon-bounds clip set up above (so any
      // letter pixels past the icon edges are simply not drawn). The
      // corresponding ctx.restore() closes that clip.
      if (knobs.shape === 'letter-only') {
        const letterColor = 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ')';
        // Determine font size. autoFit shrinks the font if the letter would
        // overflow the icon width.
        let fontPx = Math.round(h * (knobs.fontFrac || 0.5));
        ctx.font = (knobs.fontWeight || 700) + ' ' + fontPx + 'px "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
        if (knobs.autoFit) {
          let m = ctx.measureText(s.letter);
          const maxW = w * 0.92;       // small safety margin from icon edges
          while (m.width > maxW && fontPx > 8) {
            fontPx -= 1;
            ctx.font = (knobs.fontWeight || 700) + ' ' + fontPx + 'px "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
            m = ctx.measureText(s.letter);
          }
        }
        if (knobs.withBgTint) {
          ctx.fillStyle = 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ' / 0.18)';
          const fullR = ICON_RX;
          ctx.beginPath();
          ctx.moveTo(ix + fullR, iy);
          ctx.arcTo(ix + w, iy, ix + w, iy + fullR, fullR);
          ctx.arcTo(ix + w, iy + h, ix + w - fullR, iy + h, fullR);
          ctx.arcTo(ix, iy + h, ix, iy + h - fullR, fullR);
          ctx.arcTo(ix, iy, ix + fullR, iy, fullR);
          ctx.closePath();
          ctx.fill();
        }
        if (knobs.withShadow) {
          ctx.shadowColor = 'rgba(0,0,0,0.55)';
          ctx.shadowBlur = h * 0.06;
          ctx.shadowOffsetY = h * 0.04;
        }
        ctx.fillStyle = letterColor;
        ctx.fillText(s.letter, ix + w / 2, iy + h / 2 + h * 0.02);
        ctx.restore();   // close icon-bounds clip
        return;
      }
      let precomputedLetterX = null;
      let precomputedFadeEndX = null;
      let precomputedFadeStartX = null;
      let precomputedChipEndX = null;
      if (knobs.shape === 'fade-to-letter' || knobs.shape === 'half-chip') {
        const padding = w * 0.04;
        const m = ctx.measureText(s.letter);
        precomputedLetterX = ix + w - padding - m.width / 2;
        const letterLeftX = precomputedLetterX - m.width / 2;
        const gap = w * (knobs.gapFrac || 0);
        if (knobs.shape === 'fade-to-letter') {
          precomputedFadeEndX = letterLeftX - gap;
          precomputedFadeStartX = precomputedFadeEndX - w * (knobs.fadeLengthFrac || 0.3);
        } else {
          precomputedChipEndX = letterLeftX - gap;
        }
      }

      ctx.save();
      ctx.beginPath();
      const rightR = knobs.rightR || 0;
      if (knobs.shape === 'full-fade' || knobs.shape === 'fade-to-letter') {
        // Full-icon rounded rectangle. Alpha gradient does the easing.
        const fullR = ICON_RX;
        ctx.moveTo(ix + fullR, iy);
        ctx.arcTo(ix + w, iy, ix + w, iy + fullR, fullR);
        ctx.arcTo(ix + w, iy + h, ix + w - fullR, iy + h, fullR);
        ctx.arcTo(ix, iy + h, ix, iy + h - fullR, fullR);
        ctx.arcTo(ix, iy, ix + fullR, iy, fullR);
      } else if (knobs.shape === 'half-chip') {
        // Half-chip ending at chipEndX (= letter-left-edge - gap, dynamic).
        // Left corners rounded by leftR; right corners rounded by rightR
        // (rightR can be 'half-h' for a fully rounded pill side).
        const chipL = knobs.leftR;
        let chipR = knobs.rightR;
        if (chipR === 'half-h') chipR = h / 2;
        const xL = ix, xR = precomputedChipEndX;
        const yT = iy, yB = iy + h;
        ctx.moveTo(xL + chipL, yT);
        if (chipR > 0) {
          ctx.lineTo(xR - chipR, yT);
          ctx.arcTo(xR, yT, xR, yT + chipR, chipR);
          ctx.lineTo(xR, yB - chipR);
          ctx.arcTo(xR, yB, xR - chipR, yB, chipR);
        } else {
          ctx.lineTo(xR, yT);
          ctx.lineTo(xR, yB);
        }
        ctx.lineTo(xL + chipL, yB);
        ctx.arcTo(xL, yB, xL, yB - chipL, chipL);
        ctx.lineTo(xL, yT + chipL);
        ctx.arcTo(xL, yT, xL + chipL, yT, chipL);
      } else if (knobs.shape === 'concave') {
        // Flat top + flat bottom + inward-curving right edge.
        ctx.moveTo(ix + leftR, iy);
        ctx.lineTo(ix + chipFullW, iy);
        ctx.quadraticCurveTo(
          ix + chipFullW - concaveDepth, iy + h / 2,
          ix + chipFullW, iy + h
        );
        ctx.lineTo(ix + leftR, iy + h);
        ctx.arcTo(ix, iy + h, ix, iy + h - leftR, leftR);
        ctx.lineTo(ix, iy + leftR);
        ctx.arcTo(ix, iy, ix + leftR, iy, leftR);
      } else if (knobs.shape === 'rect') {
        // Plain rounded rectangle, only the LEFT corners rounded.
        ctx.moveTo(ix + leftR, iy);
        ctx.lineTo(ix + chipFullW, iy);
        ctx.lineTo(ix + chipFullW, iy + h);
        ctx.lineTo(ix + leftR, iy + h);
        ctx.arcTo(ix, iy + h, ix, iy + h - leftR, leftR);
        ctx.lineTo(ix, iy + leftR);
        ctx.arcTo(ix, iy, ix + leftR, iy, leftR);
      } else if (knobs.shape === 'asym-round') {
        // All 4 corners rounded; right corners smaller than left for smoothness.
        ctx.moveTo(ix + leftR, iy);
        ctx.lineTo(ix + chipFullW - rightR, iy);
        ctx.arcTo(ix + chipFullW, iy, ix + chipFullW, iy + rightR, rightR);
        ctx.lineTo(ix + chipFullW, iy + h - rightR);
        ctx.arcTo(ix + chipFullW, iy + h, ix + chipFullW - rightR, iy + h, rightR);
        ctx.lineTo(ix + leftR, iy + h);
        ctx.arcTo(ix, iy + h, ix, iy + h - leftR, leftR);
        ctx.lineTo(ix, iy + leftR);
        ctx.arcTo(ix, iy, ix + leftR, iy, leftR);
      } else if (knobs.shape === 'lens') {
        // Top and bottom curve smoothly inward, meeting at a soft right tip
        // (single y point on the right). No sharp corners on the right.
        const tipX = ix + chipFullW;
        ctx.moveTo(ix + leftR, iy);
        // Top curve from top-left edge down to right tip.
        ctx.quadraticCurveTo(ix + chipFullW * 0.7, iy, tipX, iy + h / 2);
        // Bottom curve from right tip back to bottom-left edge.
        ctx.quadraticCurveTo(ix + chipFullW * 0.7, iy + h, ix + leftR, iy + h);
        ctx.arcTo(ix, iy + h, ix, iy + h - leftR, leftR);
        ctx.lineTo(ix, iy + leftR);
        ctx.arcTo(ix, iy, ix + leftR, iy, leftR);
      } else if (knobs.shape === 'teardrop') {
        // Smoothly tapering from rounded left to a soft right tip — like a
        // horizontal teardrop. Top edge is slightly convex (bulges up),
        // bottom edge bulges down, both ending at the right tip.
        const tipX = ix + chipFullW;
        ctx.moveTo(ix + leftR, iy);
        // Top edge: gentle convex curve to right tip.
        ctx.bezierCurveTo(
          ix + chipBaseW * 0.7, iy - h * 0.05,
          ix + chipBaseW * 1.1, iy,
          tipX, iy + h / 2
        );
        // Bottom edge: mirror.
        ctx.bezierCurveTo(
          ix + chipBaseW * 1.1, iy + h,
          ix + chipBaseW * 0.7, iy + h + h * 0.05,
          ix + leftR, iy + h
        );
        ctx.arcTo(ix, iy + h, ix, iy + h - leftR, leftR);
        ctx.lineTo(ix, iy + leftR);
        ctx.arcTo(ix, iy, ix + leftR, iy, leftR);
      }
      ctx.closePath();
      ctx.clip();

      // Fill — branches by shape.
      if (knobs.shape === 'half-chip') {
        ctx.fillStyle = hueColorVar;
        ctx.fillRect(ix, iy, precomputedChipEndX - ix, h);
        if (knobs.withFade) {
          // Thin fade overlay on the right portion of the chip — softens the
          // hard edge without changing the chip's silhouette.
          const overlayW = w * (knobs.fadeOverlayFrac || 0.15);
          const overlayStartX = Math.max(ix, precomputedChipEndX - overlayW);
          const fade = ctx.createLinearGradient(overlayStartX, iy, precomputedChipEndX, iy);
          fade.addColorStop(0, 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ' / 0)');
          fade.addColorStop(1, 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ' / 0)');
          // Wait, we want to fade FROM solid TO transparent over the overlay
          // region. The way to do this: paint solid, then alpha-mask.
          // Simpler: re-fill the overlay region with a transparent-to-solid
          // gradient running RIGHT-to-LEFT, then composite. But that overlaps.
          // Cleaner: clear the overlay region, then draw it with a fading
          // alpha. We'll use globalCompositeOperation 'destination-out'.
          const erase = ctx.createLinearGradient(overlayStartX, iy, precomputedChipEndX, iy);
          erase.addColorStop(0, 'rgba(0,0,0,0)');
          erase.addColorStop(1, 'rgba(0,0,0,1)');
          ctx.save();
          ctx.globalCompositeOperation = 'destination-out';
          ctx.fillStyle = erase;
          ctx.fillRect(overlayStartX, iy, precomputedChipEndX - overlayStartX, h);
          ctx.restore();
        }
      } else if (knobs.shape === 'fade-to-letter') {
        // Solid color from icon-left up to fadeStartX, gradient to transparent
        // at fadeEndX (which is at the letter's left edge minus gap), nothing
        // past that — letter sits on a clean transparent background.
        const fadeStartX = Math.max(ix, precomputedFadeStartX);
        const fadeEndX = precomputedFadeEndX;
        ctx.fillStyle = hueColorVar;
        ctx.fillRect(ix, iy, fadeStartX - ix, h);
        if (fadeEndX > fadeStartX) {
          const fade = ctx.createLinearGradient(fadeStartX, iy, fadeEndX, iy);
          if (knobs.fadeEased) {
            const stops = 8;
            for (let k = 0; k <= stops; k++) {
              const t = k / stops;
              const eased = 1 - Math.pow(1 - t, 3);
              const alpha = (1 - eased).toFixed(3);
              fade.addColorStop(t, 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ' / ' + alpha + ')');
            }
          } else {
            fade.addColorStop(0, hueColorVar);
            fade.addColorStop(1, transparentVar);
          }
          ctx.fillStyle = fade;
          ctx.fillRect(fadeStartX, iy, fadeEndX - fadeStartX, h);
        }
      } else if (knobs.shape === 'full-fade') {
        const fadeStartX = ix + w * knobs.fullFadeStartFrac;
        const fadeEndX   = ix + w * knobs.fullFadeEndFrac;
        ctx.fillStyle = hueColorVar;
        ctx.fillRect(ix, iy, fadeStartX - ix, h);
        const fade = ctx.createLinearGradient(fadeStartX, iy, fadeEndX, iy);
        if (knobs.fullFadeEased) {
          const stops = 8;
          for (let k = 0; k <= stops; k++) {
            const t = k / stops;
            const eased = 1 - Math.pow(1 - t, 3);
            const alpha = (1 - eased).toFixed(3);
            fade.addColorStop(t, 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ' / ' + alpha + ')');
          }
        } else {
          fade.addColorStop(0, hueColorVar);
          fade.addColorStop(1, transparentVar);
        }
        ctx.fillStyle = fade;
        ctx.fillRect(fadeStartX, iy, fadeEndX - fadeStartX, h);
      } else if (knobs.fadeStartFrac < 1.0) {
        const fade = ctx.createLinearGradient(ix + fadeStart, iy, ix + chipFullW, iy);
        fade.addColorStop(0, hueColorVar);
        fade.addColorStop(1, transparentVar);
        ctx.fillStyle = hueColorVar;
        ctx.fillRect(ix, iy, fadeStart, h);
        ctx.fillStyle = fade;
        ctx.fillRect(ix + fadeStart, iy, chipFullW - fadeStart, h);
      } else {
        ctx.fillStyle = hueColorVar;
        ctx.fillRect(ix, iy, chipFullW, h);
      }
      // Inset top highlight on the colored area only — confine to the chip's
      // visible extent so the letter doesn't get a phantom white sheen.
      const hi = ctx.createLinearGradient(ix, iy, ix, iy + h * 0.35);
      hi.addColorStop(0, 'rgba(255,255,255,0.18)');
      hi.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hi;
      let hiW;
      if (knobs.shape === 'fade-to-letter')      hiW = precomputedFadeEndX - ix;
      else if (knobs.shape === 'half-chip')      hiW = precomputedChipEndX - ix;
      else if (knobs.shape === 'full-fade')      hiW = w;
      else                                        hiW = chipFullW;
      ctx.fillRect(ix, iy, hiW, h * 0.35);
      ctx.restore();

      // Letter in taskbar text color/font, on the right portion of the icon.
      ctx.fillStyle = '#cccccc';
      ctx.font = '500 ' + Math.round(h * (knobs.fontFrac || 0.5)) + 'px "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // letterPos:
      //   number  — fixed center as fraction of icon width
      //   'auto'  — center in gap between chip's right edge and icon's right edge
      //   'right-fit' — per-glyph: position so letter's right edge sits inside
      //                 the icon (with a tiny padding); wide letters slide left,
      //                 narrow letters slide right. No clipping.
      let letterX;
      const pos = (knobs.letterPos !== undefined) ? knobs.letterPos : (knobs.letterFrac);
      if (pos === 'right-fit') {
        const padding = w * 0.04;
        const m = ctx.measureText(s.letter);
        letterX = ix + w - padding - m.width / 2;
      } else if (pos === 'auto') {
        letterX = ix + (chipFullW + w) / 2;
      } else {
        letterX = ix + w * pos;
      }
      ctx.fillText(s.letter, letterX, iy + h / 2 + h * 0.02);
      ctx.restore();   // close icon-bounds clip
    }

    function drawTitleAt(text, tx, ty, maxW) {
      ctx.save();
      ctx.fillStyle = '#e6e6e6';
      ctx.font = '400 ' + FONT_PX + 'px "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      let t = text;
      if (ctx.measureText(t).width > maxW) {
        while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
        t = t + '…';
      }
      ctx.fillText(t, tx, ty);
      ctx.restore();
    }

    variants.forEach((v, panelIdx) => {
      const panelTop = PANEL_GAP + panelIdx * (ROW_H + PANEL_GAP);
      const labelTop = panelTop;
      const taskbarTop = panelTop + PANEL_LABEL_HEIGHT;

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '600 ' + LABEL_PX + 'px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.label, 14 * SCALE, labelTop + PANEL_LABEL_HEIGHT / 2);

      ctx.fillStyle = '#1c1c1c';
      ctx.fillRect(0, taskbarTop, W, TASKBAR_HEIGHT);
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(0, taskbarTop, W, 1 * SCALE);

      const iconY = taskbarTop + (TASKBAR_HEIGHT - ICON) / 2;
      sessions.forEach((s, i) => {
        const buttonX = PAD_LEFT_FIRST + i * BUTTON_W;
        const iconX = buttonX + ICON_X_PAD;
        drawIcon(v.id, s, iconX, iconY);
        const textX = iconX + ICON;
        const textMaxW = (buttonX + BUTTON_W) - textX - 8 * SCALE;
        // Variants whose icon shows N letters encode N at the start of the
        // id ("n2", "n3", "n3-bold", "n2-ul3", etc.). Row text starts from
        // the (N+1)th character so the icon's letters + title visually merge.
        // Note: this whole renderScript is built as an outer template literal,
        // so \d would collapse to plain "d" in the generated source — escape
        // it as \\d so the regex in the rendered output is /^n(\d)/.
        const m = String(v.id).match(/^n(\\d)/);
        const n = m ? parseInt(m[1], 10) : 0;
        let titleText;
        if (n > 0) {
          const lIdx = s.prompt.search(/[A-Za-z]/);
          titleText = (lIdx < 0) ? s.prompt : s.prompt.slice(lIdx + n);
        } else {
          titleText = s.rest;
        }
        drawTitleAt(titleText, textX, taskbarTop + TASKBAR_HEIGHT / 2, textMaxW);
      });
    });

    return c.toDataURL('image/png');
  })()`;
}

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'icon-preview');
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({ show: false, width: 1200, height: 600 });
  await win.loadURL('data:text/html,<html><body></body></html>');

  // Compute lettersN and restN for n = 1..5 so each variant can pick how many.
  function firstNLetters(prompt, n) {
    const idx = prompt.search(/[A-Za-z]/);
    if (idx < 0) return { letters: '?'.repeat(n), rest: prompt };
    let letters = prompt[idx].toUpperCase();
    let restStart = idx + 1;
    for (let i = 1; i < n && restStart < prompt.length; i++) {
      letters += prompt[restStart];
      restStart++;
    }
    return { letters, rest: prompt.slice(restStart) };
  }

  const sessions = SAMPLES.map(s => {
    const { letter, restFrom } = firstLetterOf(s.prompt);
    const lettersByN = {};
    for (let n = 1; n <= 5; n++) lettersByN[n] = firstNLetters(s.prompt, n);
    return {
      idx: s.idx,
      hue: (s.idx * ICON_HUE_STEP) % 360,
      letter,
      rest: s.prompt.slice(restFrom),
      lettersByN,
      prompt: s.prompt,    // needed by the inline N-letter computation in the renderer
    };
  });

  for (const scale of [1, 2]) {
    const dataURL = await win.webContents.executeJavaScript(renderScript(sessions, VARIANTS, scale));
    const png = Buffer.from(dataURL.replace(/^data:image\/png;base64,/, ''), 'base64');
    const file = path.join(outDir, scale === 1 ? 'taskbar-half-variants-1x.png' : 'taskbar-half-variants-2x.png');
    fs.writeFileSync(file, png);
    console.log(`scale ${scale}x → ${file}`);
  }

  shell.openPath(outDir);
  win.destroy();
  app.quit();
});
