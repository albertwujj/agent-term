const assert = require('assert');
const {
  journalPathForStore,
  parseJournal,
  mergeStoreWithJournal,
  threadHasAgentEvents,
} = require('../src/agent-journal');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

check('the journal sits beside its store, same stem', () => {
  assert.strictEqual(
    journalPathForStore('/repo/.git/review/main/main-comments.json'),
    '/repo/.git/review/main/main-agent.jsonl',
  );
  assert.strictEqual(
    journalPathForStore('/docs/.agent-threads/plan-comments.json'),
    '/docs/.agent-threads/plan-agent.jsonl',
  );
  // Only a comments store derives a journal — never an arbitrary file.
  assert.strictEqual(journalPathForStore('/docs/plan.md'), null);
  assert.strictEqual(journalPathForStore(''), null);
});

check('parse skips blank, torn, and action-less lines', () => {
  const text = [
    '{"thread":"t1","body":"done","ts":5,"turn":2}',
    '',
    '{"thread":"t1","status":"resolved","ts":6}',
    '{"no_thread_key":true}',
    '{"thread":"t2"}',                      // names a thread but does nothing
    '{"thread":"t2","body":"half-writ',     // torn final line (interrupted append)
  ].join('\n');
  const events = parseJournal(text);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].body, 'done');
  assert.strictEqual(events[1].status, 'resolved');
});

check('replies land as agent messages; status and anchor apply; unknown threads skip', () => {
  const store = {
    turn: 3,
    threads: [
      { id: 't1', anchor: { path: 'a.js', line: '4' }, anchor_status: 'lost',
        messages: [{ author: 'user', body: 'why?', ts: 10, turn: 3 }] },
    ],
  };
  const merged = mergeStoreWithJournal(store, [
    { thread: 't1', body: 'because', ts: 20, turn: 3 },
    { thread: 't1', status: 'resolved', ts: 21 },
    { thread: 't1', anchor: { line: '9' }, anchor_status: 'ok', ts: 22 },
    { thread: 'ghost', body: 'nobody home', ts: 23 },
  ]);
  const t = merged.threads[0];
  assert.strictEqual(t.messages.length, 2);
  assert.deepStrictEqual(t.messages[1], { author: 'agent', body: 'because', ts: 20, turn: 3 });
  assert.strictEqual(t.status, 'resolved');
  assert.strictEqual(t.anchor.line, '9');
  assert.strictEqual(t.anchor.path, 'a.js'); // anchor merge keeps untouched fields
  assert.strictEqual(t.anchor_status, 'ok');
  assert.strictEqual(merged.threads.length, 1);
  // The caller's store is never mutated — write paths keep the raw parts.
  assert.strictEqual(store.threads[0].messages.length, 1);
  assert.strictEqual(store.threads[0].status, undefined);
});

check('journal replies interleave with store follow-ups by ts', () => {
  // user → agent reply (journal) → user follow-up (store, later ts): the
  // reply must sit between the two user messages, not after them.
  const store = {
    threads: [{ id: 't1', messages: [
      { author: 'user', body: 'first', ts: 10 },
      { author: 'user', body: 'follow-up', ts: 30 },
    ] }],
  };
  const merged = mergeStoreWithJournal(store, [{ thread: 't1', body: 'reply', ts: 20 }]);
  assert.deepStrictEqual(merged.threads[0].messages.map((m) => m.body), ['first', 'reply', 'follow-up']);
  // …so the thread correctly reads as the user's word last.
  const last = merged.threads[0].messages[2];
  assert.strictEqual(last.author, 'user');
});

check('a user follow-up newer than the journal resolved reopens; an older one stays answered', () => {
  const store = {
    threads: [
      { id: 'late-follow-up', messages: [
        { author: 'user', body: 'q', ts: 10 },
        { author: 'user', body: 'and another thing', ts: 40 },
      ] },
      { id: 'answered', messages: [{ author: 'user', body: 'q', ts: 10 }] },
    ],
  };
  const merged = mergeStoreWithJournal(store, [
    { thread: 'late-follow-up', body: 'done', ts: 20 },
    { thread: 'late-follow-up', status: 'resolved', ts: 21 },
    { thread: 'answered', body: 'done', ts: 50 },
    { thread: 'answered', status: 'resolved', ts: 51 },
  ]);
  assert.strictEqual(merged.threads[0].status, 'open');      // follow-up IS the reopen
  assert.strictEqual(merged.threads[1].status, 'resolved');  // resolution postdates the words
});

check('a status event without ts loses to any timestamped user words', () => {
  const store = {
    threads: [{ id: 't1', messages: [{ author: 'user', body: 'q', ts: 10 }] }],
  };
  const merged = mergeStoreWithJournal(store, [{ thread: 't1', status: 'resolved' }]);
  assert.strictEqual(merged.threads[0].status, 'open');
});

check('threadHasAgentEvents is what seals a thread against Discard', () => {
  const events = parseJournal('{"thread":"t1","body":"looking"}');
  assert.strictEqual(threadHasAgentEvents(events, 't1'), true);
  assert.strictEqual(threadHasAgentEvents(events, 't2'), false);
  assert.strictEqual(threadHasAgentEvents([], 't1'), false);
});

check('store threads carry no status field; the merge derives everything', () => {
  const store = {
    threads: [{ id: 't1', messages: [{ author: 'user', body: 'q', ts: 10 }] }],
  };
  const replied = mergeStoreWithJournal(store, [{ thread: 't1', body: 'a', ts: 20 }]);
  assert.strictEqual(replied.threads[0].status, undefined); // stays absent = open
  const closed = mergeStoreWithJournal(store, [{ thread: 't1', status: 'resolved', ts: 20 }]);
  assert.strictEqual(closed.threads[0].status, 'resolved');
  // Reopen by recency needs no store field either.
  const reopened = mergeStoreWithJournal(
    { threads: [{ id: 't1', messages: [
      { author: 'user', body: 'q', ts: 10 }, { author: 'user', body: 'more', ts: 40 },
    ] }] },
    [{ thread: 't1', status: 'resolved', ts: 20 }],
  );
  assert.strictEqual(reopened.threads[0].status, 'open');
});

check('an empty or missing journal merges to the store as-is', () => {
  const store = { turn: 2, threads: [{ id: 't1', messages: [] }] };
  assert.deepStrictEqual(mergeStoreWithJournal(store, []), store);
  assert.deepStrictEqual(mergeStoreWithJournal(store, parseJournal('')), store);
});

console.log(`agent-journal: ${passed} checks passed`);
