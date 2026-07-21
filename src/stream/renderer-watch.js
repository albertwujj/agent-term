// Renderer-side buffer watcher.
//
// Polls the xterm buffer at a low cadence (default 500ms). On each poll:
//   · If buffer type flipped (normal ↔ alternate): push BOTH the
//     previous buffer's last screen AND the new buffer's initial screen
//     to main via streamBufferFlip. The stitcher will produce a DROPPED
//     marker for the discontinuity.
//   · Normal buffer: push the SCROLL DELTA — every row from the previous
//     poll's viewport top down to the current bottom. A fast burst can
//     scroll many screens between two polls; capturing only the current
//     viewport (as we used to) silently drops everything that scrolled
//     off the top in between. The delta includes one viewport of overlap
//     with the prior snapshot, which the stitcher uses to align + append.
//     Lossless up to MAX_SNAPSHOT_ROWS scrolled per poll.
//   · Alternate buffer: push the viewport as-is. A full-screen TUI
//     repaints in place and keeps no scrollback, so there is no delta to
//     recover — the viewport IS the complete state.
//
// Text-only change detection is intentional — style-only changes are rare
// in practice and not worth the per-frame deep compare. They get picked up
// on the next text change.

const { encodeRange, encodeViewport, rowsTextEqual } = require('./encoder');

const POLL_MS = 500;
// Cap on rows captured in a single delta. Matches the viewer's logical-
// buffer cap — it keeps only its last ~1000 rows, so sending more after a
// pathological burst (>1000 lines scrolled in one 500ms poll) is wasted
// bytes. Beyond the cap we ship the tail and the stitcher marks a BREAK.
const MAX_SNAPSHOT_ROWS = 1000;

function start(terminal) {
  if (!terminal || !terminal.buffer) return () => {};

  let lastType = terminal.buffer.active.type;
  let lastRows = null;
  // Absolute baseY captured on the previous normal-buffer poll. The next
  // delta starts here so rows that scrolled off the top in between are
  // still included. Reset to null across flips (and while in alt-screen)
  // so the first normal poll after a transition starts a fresh delta.
  let lastBaseY = null;

  function snapshot(buffer) {
    return encodeViewport(buffer, terminal.rows, terminal.cols);
  }

  function tick() {
    let nowType;
    try { nowType = terminal.buffer.active.type; } catch { return; }
    if (nowType !== lastType) {
      const prevBuf = (lastType === 'normal') ? terminal.buffer.normal : terminal.buffer.alternate;
      const newBuf = terminal.buffer.active;
      let prevRows = [];
      let newRows = [];
      try { prevRows = snapshot(prevBuf); } catch {}
      try { newRows = snapshot(newBuf); } catch {}
      try {
        window.pty.streamBufferFlip({
          prevType: lastType,
          prevRows,
          newType: nowType,
          newRows,
          cols: terminal.cols,
        });
      } catch {}
      lastType = nowType;
      lastRows = newRows;
      lastBaseY = null;
      return;
    }

    const buf = terminal.buffer.active;
    let rows;
    if (nowType === 'normal') {
      const baseY = buf.baseY;
      const bottom = Math.min(buf.length, baseY + terminal.rows);
      // Start at the previous poll's viewport top (min() guards the
      // unexpected case of baseY moving backwards). Clamp the height so a
      // huge burst can't emit one enormous POST.
      let begin = (lastBaseY === null) ? baseY : Math.min(lastBaseY, baseY);
      if (bottom - begin > MAX_SNAPSHOT_ROWS) begin = bottom - MAX_SNAPSHOT_ROWS;
      try { rows = encodeRange(buf, begin, bottom, terminal.cols); } catch { return; }
      lastBaseY = baseY;
    } else {
      try { rows = encodeViewport(buf, terminal.rows, terminal.cols); } catch { return; }
    }

    if (!rowsTextEqual(rows, lastRows)) {
      try {
        window.pty.streamBufferUpdate({
          rows,
          cols: terminal.cols,
          type: nowType,
        });
      } catch {}
      lastRows = rows;
    }
  }

  const timer = setInterval(tick, POLL_MS);
  return () => clearInterval(timer);
}

module.exports = { start };
