// Tests for src/cli-conversation.js: reading the probes' output, the resume
// rule, and the probe scripts themselves against real processes: one holding
// a Cursor chat store open, and ones with a Claude Code session record.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const {
  cursorChatScript,
  readCursorChat,
  claudeRecordScript,
  readClaudeRecord,
  conversationProbe,
  resumeLaunch,
  sameConversation,
} = require('../src/cli-conversation');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const CHAT = 'e9a5cddb-0e7d-454c-bf8f-9f1cd6c56270';
const line = (store, cwd, meta) => `chat\t${store}\t${cwd}\t${meta}`;
const storeFor = (dir, id = CHAT) => `/home/u/.cursor/chats/${md5(dir)}/${id}/store.db`;

(async () => {
  await check('a held chat resumes from the cwd its meta.json names', () => {
    // Real probe output for a session on 2026-11-06 that had moved to this
    // chat with the CLI's own /resume.
    const out = line('/home/yunxwu/.cursor/chats/2352974df244488b1a5f720ef4f06b48/' + CHAT + '/store.db',
      '/home/yunxwu/primary',
      '{"schemaVersion":1,"createdAtMs":1793979798199,"hasConversation":true,"updatedAtMs":1793980976981,"cwd":"/home/yunxwu/primary"}') + '\n';
    assert.deepStrictEqual(readCursorChat(out, md5), { id: CHAT, dir: '/home/yunxwu/primary' });
  });

  await check('only a directory whose md5 names the bucket is taken', () => {
    // An old chat has no cwd in its meta.json: the agent's cwd stands in.
    assert.deepStrictEqual(readCursorChat(line(storeFor('/w/a'), '/w/a', '{"schemaVersion":1}'), md5),
      { id: CHAT, dir: '/w/a' });
    // A chat the CLI's own /resume opened from another workspace resumes
    // from that workspace, which its meta.json names, not the agent's cwd.
    assert.deepStrictEqual(readCursorChat(line(storeFor('/w/b'), '/w/a', '{"cwd":"/w/b"}'), md5),
      { id: CHAT, dir: '/w/b' });
    // Neither names it: resuming by id from either would open an empty chat.
    assert.deepStrictEqual(readCursorChat(line(storeFor('/w/c'), '/w/a', '{"cwd":"/w/b"}'), md5), { id: null });
    assert.deepStrictEqual(readCursorChat(line(storeFor('/w/c'), '', ''), md5), { id: null });
  });

  await check('two chats at once cannot be told apart; one chat seen twice is one', () => {
    const other = '0d96eecd-5e1d-47ba-adf1-545fd873f436';
    const two = [line(storeFor('/w/a'), '/w/a', ''), line(storeFor('/w/a', other), '/w/a', '')].join('\n');
    assert.deepStrictEqual(readCursorChat(two, md5), { id: null });
    const same = [line(storeFor('/w/a'), '/w/a', ''), line(storeFor('/w/a'), '/w/a', '')].join('\r\n');
    assert.deepStrictEqual(readCursorChat(same, md5), { id: CHAT, dir: '/w/a' });
  });

  await check('nothing held, or nothing but noise, is no answer', () => {
    assert.strictEqual(readCursorChat('', md5), null);
    assert.strictEqual(readCursorChat('Welcome to Ubuntu\nchat\t/home/u/notes/store.db\t/w\t\n', md5), null);
  });

  await check('resumeLaunch: a Cursor or Claude session with a recorded conversation, else the dialog', () => {
    const conversation = { id: CHAT, dir: '/home/u/repo' };
    assert.deepStrictEqual(resumeLaunch({ cli: 'agent', conversation }),
      { cwd: '/home/u/repo', args: ['--resume', CHAT] });
    assert.deepStrictEqual(resumeLaunch({ cli: 'claude', conversation }),
      { cwd: '/home/u/repo', args: ['--resume', CHAT] });
    assert.strictEqual(resumeLaunch({ cli: 'codex', conversation }), null);
    assert.strictEqual(resumeLaunch({ cli: 'copilot', conversation }), null);
    assert.strictEqual(resumeLaunch({ cli: 'agent', conversation: null }), null);
    assert.strictEqual(resumeLaunch({ cli: 'agent' }), null);
    assert.strictEqual(resumeLaunch({ cli: 'agent', conversation: { id: 'x; rm -rf ~', dir: '/w' } }), null);
    assert.strictEqual(resumeLaunch({ cli: 'agent', conversation: { id: CHAT, dir: 'relative' } }), null);
    assert.strictEqual(resumeLaunch(null), null);
  });

  await check('a Claude record names the session on screen and the directory it runs in', () => {
    // Real record (trimmed) of a Claude Code 2.1.319 session on 2026-11-06.
    const rec = '{"pid":3503872,"sessionId":"0cf37dde-178d-4396-9d8a-06aa40218778","cwd":"/home/yunxwu/agent-term-debug",'
      + '"startedAt":1793985107291,"version":"2.1.319","kind":"interactive","entrypoint":"cli","status":"busy"}';
    assert.deepStrictEqual(readClaudeRecord(`Welcome to Ubuntu\nclaude\t${rec}\n`),
      { id: '0cf37dde-178d-4396-9d8a-06aa40218778', dir: '/home/yunxwu/agent-term-debug' });
  });

  await check('Claude: only interactive sessions count, and two of them cannot be told apart', () => {
    const record = (sessionId, extra = {}) => 'claude\t' + JSON.stringify({ sessionId, cwd: '/w', ...extra });
    const other = '0d96eecd-5e1d-47ba-adf1-545fd873f436';
    // A `claude -p` the agent runs as a tool is a descendant too.
    assert.deepStrictEqual(readClaudeRecord([record(CHAT, { kind: 'interactive' }), record(other, { kind: 'print' })].join('\n')),
      { id: CHAT, dir: '/w' });
    // An older record without kind counts as interactive.
    assert.deepStrictEqual(readClaudeRecord(record(CHAT)), { id: CHAT, dir: '/w' });
    assert.deepStrictEqual(readClaudeRecord([record(CHAT), record(other)].join('\n')), { id: null });
    assert.deepStrictEqual(readClaudeRecord([record(CHAT), record(CHAT)].join('\r\n')), { id: CHAT, dir: '/w' });
    // No usable directory: the id alone would resume from wherever the shell is.
    assert.deepStrictEqual(readClaudeRecord(record(CHAT, { cwd: 'relative' })), { id: null });
    assert.strictEqual(readClaudeRecord(record('not-a-uuid')), null);
    assert.strictEqual(readClaudeRecord('claude\t{not json\n'), null);
    assert.strictEqual(readClaudeRecord(''), null);
  });

  await check('conversationProbe: Cursor and Claude, nothing else', () => {
    assert.strictEqual(conversationProbe('agent').script, cursorChatScript);
    assert.strictEqual(conversationProbe('claude').read, readClaudeRecord);
    for (const cli of ['codex', 'copilot', null, undefined, 'constructor', '__proto__']) {
      assert.strictEqual(conversationProbe(cli), null, String(cli));
    }
  });

  await check('sameConversation: a cleared record is the same as none', () => {
    assert.ok(sameConversation(null, { id: null }));
    assert.ok(sameConversation({ id: CHAT, dir: '/a' }, { id: CHAT, dir: '/a' }));
    assert.ok(!sameConversation({ id: CHAT, dir: '/a' }, { id: CHAT, dir: '/b' }));
    assert.ok(!sameConversation({ id: CHAT, dir: '/a' }, null));
  });

  if (fs.existsSync('/proc/self/fd') || process.platform === 'darwin') {
    await check('probe script: finds the chat a grandchild of the shell holds open', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-chat-'));
      const workspace = path.join(root, 'work');
      fs.mkdirSync(workspace);
      const chatDir = path.join(root, 'chats', md5(workspace), CHAT);
      fs.mkdirSync(chatDir, { recursive: true });
      const store = path.join(chatDir, 'store.db');
      fs.writeFileSync(store, '');
      fs.writeFileSync(path.join(chatDir, 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd: workspace }) + '\n');
      // The shell runs a wrapper (a child) that opens the store from the
      // workspace and runs the "agent" (a grandchild), both holding it open.
      const inner = 'cd "$1" && exec 3<"$2" && sleep 30';
      const shell = spawn('sh', ['-c', `sh -c '${inner}' _ "$1" "$2" & wait`, '_', workspace, store],
        { stdio: 'ignore', detached: true });
      const run = (pidExpr) => execFileSync('bash', ['-c', cursorChatScript(pidExpr)]).toString();
      try {
        let found = null;
        for (let i = 0; i < 50 && !found; i++) {
          found = readCursorChat(run(String(shell.pid)), md5);
          if (!found) await new Promise((r) => setTimeout(r, 100));
        }
        assert.deepStrictEqual(found, { id: CHAT, dir: workspace });
        // Another shell's tree sees none of it.
        assert.strictEqual(readCursorChat(run('$$'), md5), null);
      } finally {
        try { process.kill(-shell.pid, 'SIGKILL'); } catch {}
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    await check('Claude probe script: reads the record of the child that has one; exits 0 with none, 1 without a pid', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-claude-'));
      const sessions = path.join(root, 'claude', 'sessions');
      fs.mkdirSync(sessions, { recursive: true });
      const shell = spawn('sh', ['-c', 'sleep 30 & sleep 30 & wait'], { stdio: 'ignore', detached: true });
      const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
      const run = (pidExpr) => execFileSync('bash', ['-c', claudeRecordScript(pidExpr)], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      try {
        let children = [];
        for (let i = 0; i < 50 && children.length < 2; i++) {
          try { children = execFileSync('pgrep', ['-P', String(shell.pid)]).toString().trim().split(/\s+/).filter(Boolean); } catch {}
          if (children.length < 2) await new Promise((r) => setTimeout(r, 100));
        }
        assert.strictEqual(children.length, 2, 'the shell runs two children');
        // Nothing recorded yet: the walk still ends well.
        assert.strictEqual(readClaudeRecord(run(String(shell.pid))), null);
        fs.writeFileSync(path.join(sessions, `${children[0]}.json`),
          JSON.stringify({ pid: Number(children[0]), sessionId: CHAT, cwd: root, kind: 'interactive' }) + '\n');
        assert.deepStrictEqual(readClaudeRecord(run(String(shell.pid))), { id: CHAT, dir: root });
        assert.throws(() => run('$(cat -- /nonexistent/agent-term-pid)'), (err) => err.status === 1);
      } finally {
        try { process.kill(-shell.pid, 'SIGKILL'); } catch {}
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
