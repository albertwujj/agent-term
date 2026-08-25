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
// Each update push also carries a `substantial` classification for the
// host's "agent active" clock (job-watch's supersede gate): a scroll
// (baseY advanced — real lines entered scrollback) or a screen change
// with enough new text rows is substantial; a near-duplicate repaint —
// spinner frame, token counter, a status line clearing when a task
// finishes — is churn and must not read as the agent waking (see
// isSubstantialChange in encoder.js). Buffer flips are substantial by
// definition — main treats streamBufferFlip that way without a flag.
//
// Text-only change detection is intentional — style-only changes are rare
// in practice and not worth the per-frame deep compare. They get picked up
// on the next text change.

const { encodeRange, encodeViewport, rowsTextEqual, isSubstantialChange } = require('./encoder');

const POLL_MS = 500;
// Cap on rows captured in a single delta. Matches the viewer's logical-
// buffer cap — it keeps only its last ~1000 rows, so sending more after a
// pathological burst (>1000 lines scrolled in one 500ms poll) is wasted
// bytes. Beyond the cap we ship the tail and the stitcher marks a BREAK.
const MAX_SNAPSHOT_ROWS = 1000;

function start(terminal, opts) {
  if (!terminal || !terminal.buffer) return () => {};
  const pollMs = (opts && opts.pollMs) || POLL_MS;

  let lastType = terminal.buffer.active.type;
  let lastRows = null;
  // Absolute baseY captured on the previous normal-buffer poll. The next
  // delta starts here so rows that scrolled off the top in between are
  // still included. Reset to null across flips (and while in alt-screen)
  // so the first normal poll after a transition starts a fresh delta.
  let lastBaseY = null;
  // Viewport as of the previous push, kept separately from lastRows
  // (which holds the scroll DELTA in the normal buffer) so the
  // substantial-vs-churn classification always compares screen to screen.
  let lastViewport = null;

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
      lastViewport = newRows;
      lastBaseY = null;
      return;
    }

    const buf = terminal.buffer.active;
    let rows;
    let viewport;
    let scrolled = false;
    if (nowType === 'normal') {
      const baseY = buf.baseY;
      scrolled = lastBaseY !== null && baseY > lastBaseY;
      const bottom = Math.min(buf.length, baseY + terminal.rows);
      // Start at the previous poll's viewport top (min() guards the
      // unexpected case of baseY moving backwards). Clamp the height so a
      // huge burst can't emit one enormous POST.
      let begin = (lastBaseY === null) ? baseY : Math.min(lastBaseY, baseY);
      if (bottom - begin > MAX_SNAPSHOT_ROWS) begin = bottom - MAX_SNAPSHOT_ROWS;
      try { rows = encodeRange(buf, begin, bottom, terminal.cols); } catch { return; }
      viewport = rows.slice(Math.max(0, baseY - begin));
      lastBaseY = baseY;
    } else {
      try { rows = encodeViewport(buf, terminal.rows, terminal.cols); } catch { return; }
      viewport = rows;
    }

    if (!rowsTextEqual(rows, lastRows)) {
      const substantial = scrolled || lastViewport === null ||
        isSubstantialChange(lastViewport, viewport, terminal.rows);
      try {
        window.pty.streamBufferUpdate({
          rows,
          cols: terminal.cols,
          type: nowType,
          substantial,
        });
      } catch {}
      lastRows = rows;
      lastViewport = viewport;
    }
  }

  const timer = setInterval(tick, pollMs);
  return () => clearInterval(timer);
}

module.exports = { start };
