const assert = require('assert');
const { confirmBody, isConfirmMessage, pendingConfirm } = require('../src/decision-confirm');
const { mergeStoreWithJournal } = require('../src/agent-journal');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

const confirm = (ts, extra) => ({ author: 'user', body: confirmBody('Decision: refill rate'), ts, ...extra });
const thread = (messages, events) => mergeStoreWithJournal({ threads: [{ id: 't', messages }] }, events || []).threads[0];

check('the envelope names the decision in the heading\'s words', () => {
  assert.strictEqual(confirmBody('Decision: refill rate'), '[Confirm] Decision: refill rate');
  assert.ok(isConfirmMessage(confirm(1)));
  for (const body of ['Confirmed', '[Confirm]', '[Confirm] refill rate', 'ok [Confirm] Decision: x']) {
    assert.ok(!isConfirmMessage({ author: 'user', body }), body);
  }
  assert.ok(!isConfirmMessage({ author: 'agent', body: confirmBody('Decision: x') }));
});

check('a confirm waits on the agent, sent or not, until the agent acts after it', () => {
  assert.ok(pendingConfirm(thread([confirm(10)])));
  assert.ok(pendingConfirm(thread([confirm(10, { turn: 3 })])));
  assert.strictEqual(pendingConfirm(thread([{ author: 'user', body: 'why 10/s?', ts: 10 }])), null);
});

check('words added after the confirm keep it waiting', () => {
  assert.ok(pendingConfirm(thread([confirm(10), { author: 'user', body: 'and rename it', ts: 11 }])));
});

check('it joins a conversation the agent left open on the heading', () => {
  const t = thread([{ author: 'user', body: 'why 10/s?', ts: 10 }, confirm(30)],
    [{ thread: 't', body: 'p99 burst. Keep it?', status: 'open', ts: 20 }]);
  assert.strictEqual(t.messages.map((m) => m.author).join(), 'user,agent,user');
  assert.ok(pendingConfirm(t));
});

check('an agent reply or status after the confirm hands the state back to the package', () => {
  assert.strictEqual(pendingConfirm(thread([confirm(10)], [{ thread: 't', status: 'resolved', ts: 20 }])), null);
  assert.strictEqual(pendingConfirm(thread([confirm(10)], [{ thread: 't', body: 'Which one?', status: 'open', ts: 20 }])), null);
});

check('a recorded confirm stays recorded when a later follow-up reopens the thread', () => {
  const t = thread([confirm(10), { author: 'user', body: 'actually, wait', ts: 40 }],
    [{ thread: 't', status: 'resolved', ts: 20 }]);
  assert.strictEqual(t.status, undefined, 'the follow-up reopened it');
  assert.strictEqual(pendingConfirm(t), null);
});

check('a status without ts is old, like the merge reads it', () => {
  assert.ok(pendingConfirm(thread([confirm(10)], [{ thread: 't', status: 'resolved' }])));
});

console.log(`decision-confirm: ${passed} checks passed`);
