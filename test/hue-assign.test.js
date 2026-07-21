// Tests for src/hue-assign.js — pure pickNextHue() max-min selector.

const assert = require('assert');
const { pickNextHue } = require('../src/hue-assign');

let testsPassed = 0, testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

// Circular distance helper for assertions.
function circDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

console.log('hue-assign');

test('empty active list → fallback (defaults to 0)', () => {
  assert.strictEqual(pickNextHue([]), 0);
  // Caller-supplied fallback preserves backward compat with the original
  // cycleIconParams(sessionIndex).hue value.
  assert.strictEqual(pickNextHue([], 168), 168);
  assert.strictEqual(pickNextHue([], 24), 24);
});

test('null / undefined / non-array → fallback', () => {
  assert.strictEqual(pickNextHue(null), 0);
  assert.strictEqual(pickNextHue(undefined, 96), 96);
  assert.strictEqual(pickNextHue('not an array', 42), 42);
});

test('list of all non-numeric values → fallback', () => {
  // After cleaning the array becomes empty — should fall back.
  assert.strictEqual(pickNextHue([null, 'x', NaN, undefined], 144), 144);
});

test('one active session → opposite side of the wheel', () => {
  assert.strictEqual(pickNextHue([0]),   180);
  assert.strictEqual(pickNextHue([90]),  270);
  assert.strictEqual(pickNextHue([180]), 0);   // (180+180) mod 360
  assert.strictEqual(pickNextHue([270]), 90);
});

test('two active sessions → midpoint of larger arc', () => {
  // [0, 90]: gaps 90 (0→90) and 270 (90→360→0). Largest = 270, mid = 90 + 135 = 225.
  assert.strictEqual(pickNextHue([0, 90]),  225);
  // [0, 180]: equal gaps; first wins (0→180 gap = 180). Mid = 90.
  assert.strictEqual(pickNextHue([0, 180]), 90);
});

test('three active equally spaced (120° apart) → midpoint of first gap', () => {
  const result = pickNextHue([0, 120, 240]);
  // All gaps equal (120); first wins. Mid of 0→120 = 60.
  assert.strictEqual(result, 60);
});

test('wrap-around: hues clustered near 0/360 boundary', () => {
  // Active at 350 and 10 — they're 20° apart through 360. The big empty
  // arc is 10°→350° (forward direction, 340°), midpoint = 10+170 = 180.
  const result = pickNextHue([10, 350]);
  assert.strictEqual(result, 180);
});

test('input normalization — out-of-range hues are mod 360', () => {
  // 360 == 0, 720 == 0, -30 == 330.
  // After normalization: [0, 0, 330] dedupes to [0, 330]. Largest gap:
  // 330→360→0 = 30 (small), 0→330 forward = 330 (largest). Mid = 0 + 165 = 165.
  assert.strictEqual(pickNextHue([360, 720, -30]), 165);
});

test('duplicates dedupe correctly', () => {
  // [0, 0, 0] dedupes to [0]; one-active path → 180.
  assert.strictEqual(pickNextHue([0, 0, 0]), 180);
});

test('skips non-numeric entries silently', () => {
  // After cleaning: [0, 180]. Same as the two-session test.
  assert.strictEqual(pickNextHue([0, null, 'foo', undefined, 180, NaN]), 90);
});

test('output is always equidistant from nearest neighbors', () => {
  // Property check: for many random configurations, the result's nearest-
  // neighbor distance should be >= every other point's nearest-neighbor
  // distance (it's the max-min point).
  function nearestDist(h, others) {
    let best = Infinity;
    for (const o of others) {
      const d = circDist(h, o);
      if (d < best) best = d;
    }
    return best;
  }
  const cases = [
    [0, 60, 120],
    [45, 90, 200, 300],
    [0, 5, 10],   // very clustered
    [10, 100, 250],
  ];
  for (const active of cases) {
    const picked = pickNextHue(active);
    const pickedDist = nearestDist(picked, active);
    // Verify no other angle gives a strictly larger min-distance (sample
    // every degree).
    for (let candidate = 0; candidate < 360; candidate++) {
      const d = nearestDist(candidate, active);
      assert.ok(d <= pickedDist + 1e-9,
        `for active=${active}, candidate=${candidate} has dist ${d} > picked=${picked} (dist=${pickedDist})`);
    }
  }
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
