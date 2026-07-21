// Dynamic max-min hue assignment for new sessions.
//
// Each agent-term session is identified by a per-session hue on the OKLCH
// wheel — visible as the chip underline on the taskbar icon, the chrome
// bar's bottom divider, and the picker rows' left stripe. To keep
// concurrent sessions visually distinct, we pick each new session's hue
// to be the one maximally far from every currently-active session's hue.
//
// Algorithm (greedy max-min on a circle):
//   1. Sort the live hues.
//   2. Find the largest gap between consecutive sorted hues, treating
//      the wheel as circular (last-to-first wraps through 360°).
//   3. The new hue is the midpoint of that gap.
//
// Single-pick greedy is the right shape here — we don't need globally
// optimal coverage, just "as far as possible from everyone else right now."
// New picks settle into the largest empty arc; closed sessions free up
// their arc for future picks. Resumed sessions keep their original hue
// (don't re-pick) so cross-surface identity stays stable across launches.

// `fallback` is returned when there are no active hues to space against —
// preserves backward compatibility with the original index-based cycle:
// the caller passes the legacy `cycleIconParams(sessionIndex).hue` as the
// fallback, so single-window use continues to produce the same hue
// sequence per session index that earlier versions produced. The max-min
// behavior only kicks in when there are concurrent sessions whose hues
// we should space away from.
function pickNextHue(activeHues, fallback = 0) {
  if (!Array.isArray(activeHues) || activeHues.length === 0) {
    return fallback;
  }
  // Normalize, drop non-numbers, deduplicate (collapsing duplicate hues
  // is correct: they share an arc, so their gap influence is the same as
  // a single point).
  const cleaned = Array.from(new Set(
    activeHues
      .filter(h => typeof h === 'number' && !Number.isNaN(h))
      .map(h => ((h % 360) + 360) % 360),
  )).sort((a, b) => a - b);

  if (cleaned.length === 0) return fallback;
  if (cleaned.length === 1) {
    // Opposite side of the wheel.
    return (cleaned[0] + 180) % 360;
  }

  let maxGap = -1;
  let gapStart = cleaned[0];
  for (let i = 0; i < cleaned.length; i++) {
    const here = cleaned[i];
    const next = i === cleaned.length - 1 ? cleaned[0] + 360 : cleaned[i + 1];
    const gap = next - here;
    if (gap > maxGap) {
      maxGap = gap;
      gapStart = here;
    }
  }
  return ((gapStart + maxGap / 2) % 360 + 360) % 360;
}

module.exports = { pickNextHue };
