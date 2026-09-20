// Real PTY → main status detector → HTTP snapshot/heartbeat regression.
// Fake CLIs emit the verified vendor OSC formats and continuous idle animation.
// The local hub records the actual boolean the phone receives. No agent runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launchElectron } from './electron.mjs';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-activity-title-'));
const received = [];
const hub = http.createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  received.push({ url: req.url, body: JSON.parse(text || '{}') });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  // No active detail viewer: working runs use the slow 30s heartbeat.
  res.end(JSON.stringify({ ok: true, viewerAgeMs: null }));
});
await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 15_000) {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < timeout, message);
    await sleep(80);
  }
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const cases = {
  codex: { ready: 'Ready | codex | Fix activity', busy: 'Thinking | codex | Fix activity ⠋',
    wait: '[ ! ] Action Required | codex | Fix activity' },
  claude: { ready: '✳ Fix activity', busy: '◐ Fix activity', wait: '✳ Fix activity' },
  agent: { ready: 'Fix activity - ✅ Ready', busy: 'Fix activity - ⏳ Working ...',
    wait: 'Fix activity - 🔐 Waiting for confirmation' },
  copilot: { ready: 'GitHub Copilot', busy: 'Fix activity - Thinking - GitHub Copilot',
    wait: 'GitHub Copilot' },
};

async function exercise(cli, titles) {
  const dir = path.join(tmp, cli);
  fs.mkdirSync(dir);
  const control = path.join(dir, 'state');
  const ack = path.join(dir, 'ack');
  const fake = path.join(dir, 'fake.cjs');
  fs.writeFileSync(control, 'busy');
  fs.writeFileSync(fake, `
    const fs = require('node:fs');
    const titles = ${JSON.stringify(titles)};
    const control = ${JSON.stringify(control)};
    const ack = ${JSON.stringify(ack)};
    if (${JSON.stringify(cli)} === 'codex' &&
      process.argv[3] !== 'tui.terminal_title=["status","app-name","thread","spinner"]') process.exit(2);
    process.stdin.resume();
    let last, frame = 0;
    process.stdout.write('Activity test output\\r\\nHold this text to comment\\r\\n');
    setInterval(() => {
      const state = fs.readFileSync(control, 'utf8');
      if (state !== last) {
        last = state;
        if (state === 'restore') process.stdout.write('\\x1b[23;0t');
        else if (state !== 'silence') {
          const title = titles[state] || 'custom title without status';
          // Split the OSC introducer and ST across PTY events.
          process.stdout.write('\\x1b]');
          setTimeout(() => process.stdout.write('0;' + title + '\\x1b'), 5);
          setTimeout(() => process.stdout.write('\\\\'), 10);
        }
        setTimeout(() => fs.writeFileSync(ack, state), 20);
        return;
      }
      if (state !== 'silence') process.stdout.write('\\rIdle sparkle frame ' + (++frame) + '   ');
    }, 100);
  `);
  const app = await launchElectron({ executablePath: require('electron'),
    args: ['--no-sandbox', `--user-data-dir=${path.join(dir, 'userdata')}`, repo],
    env: { ...process.env, AGENT_STREAM_HUB_URL: `http://127.0.0.1:${hub.address().port}`,
      TMUX: '', STY: '', ZELLIJ: '' }, timeout: 45_000 });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.xterm-helper-textarea');
    await sleep(1000);
    if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`${cli}() { ${quote(process.execPath)} ${quote(fake)} "$@"; }`);
    await page.keyboard.press('Enter');
    await sleep(300);
    await page.evaluate(command => window.pty.pickerStartNew(command), cli);
    await until(() => fs.existsSync(ack), `${cli}: fake CLI did not launch`);
    await sleep(300);
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('please verify activity detection');
    await page.keyboard.press('Enter');
    const workingOf = item => item.body.payload?.isWorking ?? item.body.isWorking;
    const waitForWorking = async (expected, after, heartbeatOnly = false, timeout = 15_000) => {
      let match;
      await until(() => (match = received.findIndex((item, index) => index >= after &&
        (!heartbeatOnly || item.url.endsWith('/heartbeat')) && workingOf(item) === expected)) >= 0,
      `${cli}: hub did not receive working=${expected}`, timeout);
      return match;
    };
    await waitForWorking(true, received.length);
    const state = async (next, expected, heartbeatOnly = false, timeout = 15_000) => {
      const after = received.length;
      fs.writeFileSync(control, next);
      await until(() => fs.existsSync(ack) && fs.readFileSync(ack, 'utf8') === next,
        `${cli}: fake CLI did not acknowledge ${next}`);
      return waitForWorking(expected, after, heartbeatOnly, timeout);
    };
    if (cli === 'codex') {
      // Before any idle state can select a fast timer, freeze rendering so
      // the title-only transition has no snapshot to carry it to the hub.
      const box = await page.locator('.xterm-screen').boundingBox();
      await page.keyboard.down('Shift');
      await page.mouse.click(box.x + 70, box.y + 10);
      await page.keyboard.up('Shift');
      await page.locator('.terminal-output-frozen-pill').waitFor({ state: 'visible' });
      await state('ready', false, true, 4000);
      await state('busy', true, true, 4000);
      await page.keyboard.press('Escape');
      await page.locator('.terminal-output-frozen-pill').waitFor({ state: 'hidden' });
      console.log('PASS codex: unattended title-only transitions bypass the 30s heartbeat');
    }
    if (cli === 'copilot') {
      // A bare brand can also mean a new turn before intent arrives. None of
      // these ambiguous titles may suppress the existing activity detector.
      await state('ready', true);
      await state('wait', true);
      await state('silence', false);
      console.log('PASS copilot: ambiguous titles retain output-recency detection');
      return;
    }
    const idleAt = await state('ready', false);
    await sleep(5500); // continuous redraws must not revive working after the old timeout
    assert.ok(received.slice(idleAt).filter(x => typeof workingOf(x) === 'boolean')
      .every(x => workingOf(x) === false), `${cli}: idle animation falsely reported work`);
    await state('busy', true);
    await state('wait', false);

    if (cli === 'codex') {
      // Freeze the display through the actual commenting gesture. Title status
      // must keep reaching the phone in heartbeats without renderer parsing.
      const box = await page.locator('.xterm-screen').boundingBox();
      await page.keyboard.down('Shift');
      await page.mouse.click(box.x + 70, box.y + 10);
      await page.keyboard.up('Shift');
      await page.locator('.terminal-output-frozen-pill').waitFor({ state: 'visible' });
      await state('busy', true, true);
      await state('ready', false, true);
      await page.keyboard.press('Escape');
      await page.locator('.terminal-output-frozen-pill').waitFor({ state: 'hidden' });
    }
    await state('unknown', true); // unsupported/disabled format restores legacy behavior
    await state('ready', false);
    await state('restore', true); // CLI exit/title restore withdraws the idle veto
    await state('silence', false); // the existing five-second quiet timeout still applies
    console.log(`PASS ${cli}: idle animation, work, wait, unknown format, restore, quiet timeout`);
  } finally {
    await app.close();
  }
}

try {
  for (const [cli, titles] of Object.entries(cases)) await exercise(cli, titles);
} finally {
  await new Promise(resolve => hub.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
