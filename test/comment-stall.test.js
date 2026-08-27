const assert = require('assert');
const {
  decideStall,
  threadUnaddressed,
  unaddressedCount,
  STALL_IDLE_MS,
  STALL_MAX_AGE_MS,
  SEND_INPUT_EPSILON_MS,
} = require('../src/comment-stall');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

const open = (id) => ({ id, status: 'open', messages: [{ author: 'user', body: 'q', ts: 1 }] });
const answered = (id) => ({ id, status: 'open', messages: [
  { author: 'user', body: 'q', ts: 1 }, { author: 'agent', body: 'a', ts: 2 },
] });
const resolved = (id) => ({ ...answered(id), status: 'resolved' });

check('unaddressed = open with the user\'s word last; blocked and resolved are not stalls', () => {
  assert.strictEqual(threadUnaddressed(open('a')), true);
  // New stores omit `status` entirely — absent reads as open.
  assert.strictEqual(threadUnaddressed({ id: 'a', messages: [{ author: 'user', body: 'q', ts: 1 }] }), true);
  // An agent reply that left the thread open is "blocked on the user" — the
  // user's move, never a stall.
  assert.strictEqual(threadUnaddressed(answered('a')), false);
  assert.strictEqual(threadUnaddressed(resolved('a')), false);
  assert.strictEqual(unaddressedCount([open('a'), answered('b'), open('c')]), 2);
});

const SEND = 100000;
function env(over = {}) {
  return {
    now: SEND + STALL_IDLE_MS + 1000,
    lastInputTime: SEND,          // the send's own paste bumped the input clock
    lastAgentOutputTime: 0,
    coveredThreads: [open('a')],
    ...over,
  };
}

check('idle past the threshold with unaddressed covered threads → remind', () => {
  assert.strictEqual(decideStall({ sendTime: SEND }, env()), 'remind');
});

check('agent activity resets the quiet clock → wait', () => {
  const e = env({ lastAgentOutputTime: SEND + STALL_IDLE_MS });
  assert.strictEqual(decideStall({ sendTime: SEND }, e), 'wait');
});

check('not yet idle long enough → wait', () => {
  assert.strictEqual(decideStall({ sendTime: SEND }, env({ now: SEND + STALL_IDLE_MS - 1 })), 'wait');
});

check('user input after the send disarms for good — the user took the wheel', () => {
  const e = env({ lastInputTime: SEND + SEND_INPUT_EPSILON_MS + 1 });
  assert.strictEqual(decideStall({ sendTime: SEND }, e), 'disarm-user');
});

check('the send\'s own paste is inside the epsilon, so it never reads as user input', () => {
  const e = env({ lastInputTime: SEND + SEND_INPUT_EPSILON_MS - 1 });
  assert.strictEqual(decideStall({ sendTime: SEND }, e), 'remind');
});

check('every covered thread addressed (replied-open or resolved) → done', () => {
  assert.strictEqual(decideStall({ sendTime: SEND }, env({ coveredThreads: [answered('a'), resolved('b')] })), 'done');
});

check('covered ids that vanished (discarded) drop out; none left → done', () => {
  assert.strictEqual(decideStall({ sendTime: SEND }, env({ coveredThreads: [] })), 'done');
});

check('a watch past max age expires unfired', () => {
  const e = env({ now: SEND + STALL_MAX_AGE_MS + 1 });
  assert.strictEqual(decideStall({ sendTime: SEND }, e), 'expire');
});

check('user-input disarm outranks done and remind alike', () => {
  const e = env({
    lastInputTime: SEND + SEND_INPUT_EPSILON_MS + 1,
    coveredThreads: [answered('a')],
  });
  assert.strictEqual(decideStall({ sendTime: SEND }, e), 'disarm-user');
});

console.log(`comment-stall: ${passed} checks passed`);
