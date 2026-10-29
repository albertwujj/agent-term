const assert = require('assert');
const { parseScopeArg, changedInputs, createReviewSync, REVIEW_POLL_MS, nextPollDelay } = require('../src/review-sync');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

const inputs = (over = {}) => ({ md: 'md1', diff: 'diff1', dirty: false, head: 'h1', ...over });

// A scripted repo + package: readInputs reads `world` as it stands, and each
// render records the world it read, so a test can change the world mid-render.
function harness(world, { onRender } = {}) {
  const renders = [];
  const sync = createReviewSync({
    readInputs: async () => ({ ...world }),
    render: async (moved) => {
      renders.push({ moved, saw: { ...world } });
      if (onRender) return onRender(renders.length);
    },
  }, inputs());
  return { sync, renders };
}

(async () => {
  await check('scope: range wins, then base, else null', () => {
    assert.strictEqual(parseScopeArg('---\nrange: a1..b2\n---\nbody'), 'a1..b2');
    assert.strictEqual(parseScopeArg('---\ntitle: x\nbase: origin/main\n---\n'), 'origin/main');
    assert.strictEqual(parseScopeArg('---\nbase: m\nrange: a..b\n---\n'), 'a..b');
    assert.strictEqual(parseScopeArg('no front matter\nrange: a..b\n'), null);
    assert.strictEqual(parseScopeArg(null), null);
  });

  await check('changed inputs are named; an unreadable probe is no news', () => {
    assert.deepStrictEqual(changedInputs(inputs(), inputs()), []);
    assert.deepStrictEqual(changedInputs(inputs(), inputs({ head: 'h2', md: 'md2' })), ['md', 'head']);
    assert.deepStrictEqual(changedInputs(inputs(), inputs({ md: null, diff: null, head: null })), []);
    assert.deepStrictEqual(changedInputs(inputs(), inputs({ dirty: true })), ['dirty']);
  });

  await check('in sync: no render', async () => {
    const { sync, renders } = harness(inputs());
    assert.deepStrictEqual(await sync.tick(), []);
    assert.strictEqual(renders.length, 0);
  });

  await check('a change renders once, then the loop is in sync', async () => {
    const world = inputs({ head: 'h2' });
    const { sync, renders } = harness(world);
    assert.deepStrictEqual(await sync.tick(), ['head']);
    assert.deepStrictEqual(await sync.tick(), []);
    assert.strictEqual(renders.length, 1);
  });

  // The session that found this: the agent commits (HEAD moves), the poll
  // starts a render, and the agent bumps the package's range mid-render. The
  // page shows the pre-bump package, so the next tick must render again.
  await check('a package write mid-render re-renders on the next tick', async () => {
    const world = inputs({ head: 'h2' });
    const { sync, renders } = harness(world, {
      onRender: (n) => { if (n === 1) world.md = 'md2'; },
    });
    await sync.tick();
    assert.deepStrictEqual(renders[0].saw.md, 'md1');
    assert.deepStrictEqual(await sync.tick(), ['md']);
    assert.strictEqual(renders.length, 2);
    assert.strictEqual(renders[1].saw.md, 'md2');
    assert.deepStrictEqual(await sync.tick(), []);
  });

  await check('a tick during a render does not start a second one, and the change it saw still renders', async () => {
    const world = inputs({ head: 'h2' });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { sync, renders } = harness(world, {
      onRender: (n) => (n === 1 ? gate : undefined),
    });
    const first = sync.tick();
    await new Promise((resolve) => setImmediate(resolve));
    world.md = 'md2';
    assert.deepStrictEqual(await sync.tick(), ['md', 'head']);
    assert.strictEqual(renders.length, 1);
    release();
    await first;
    assert.deepStrictEqual(await sync.tick(), ['md']);
    assert.strictEqual(renders.length, 2);
  });

  await check('a render that did not take keeps the baseline, so the next tick retries', async () => {
    const world = inputs({ head: 'h2' });
    const { sync, renders } = harness(world, { onRender: (n) => (n === 1 ? false : undefined) });
    await sync.tick();
    assert.deepStrictEqual(await sync.tick(), ['head']);
    assert.strictEqual(renders.length, 2);
    assert.deepStrictEqual(await sync.tick(), []);
  });

  await check('quick polls keep the beat; a slow one gets a rest, not a queue', () => {
    assert.strictEqual(nextPollDelay(0), REVIEW_POLL_MS);
    assert.strictEqual(nextPollDelay(600), REVIEW_POLL_MS - 600);
    assert.strictEqual(nextPollDelay(REVIEW_POLL_MS / 2), REVIEW_POLL_MS / 2);
    assert.strictEqual(nextPollDelay(5000), REVIEW_POLL_MS / 2);
    assert.strictEqual(nextPollDelay(-50), REVIEW_POLL_MS, 'a clock step back is no time taken');
  });

  console.log(`review-sync: ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
