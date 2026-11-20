#!/usr/bin/env node
// Run --apply with AgentTerm closed. Windows users run this from WSL with
// --user-data pointing to the Windows AgentTerm profile under /mnt/c.
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { parseArgs } = require('node:util');
const sessionsLog = require('../src/sessions-log');
const { resumeLaunch } = require('../src/cli-conversation');

const USAGE = 'Usage: node scripts/repair/backfill-cursor-conversations.js --user-data <dir> [--cursor-config <dir>] [--apply]';
const hashDirectory = (dir) => createHash('md5').update(dir).digest('hex');
const normalize = (text) => text.normalize('NFC').replace(/\s+/g, ' ').trim();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
}

function readDirectory(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function indexChats(config, buckets, wanted) {
  const chats = new Map();
  for (const [bucket, dir] of buckets) {
    const folder = path.join(config, 'chats', bucket);
    for (const entry of readDirectory(folder)) {
      if (!entry.isDirectory() || !resumeLaunch({ cli: 'agent', conversation: { id: entry.name, dir } })) continue;
      const chatDir = path.join(folder, entry.name);
      const meta = readJson(path.join(chatDir, 'meta.json'));
      if (!meta?.hasConversation || !fs.existsSync(path.join(chatDir, 'store.db'))) continue;
      if (meta.cwd && meta.cwd !== dir) continue;
      if (!Number.isFinite(meta.createdAtMs) || !Number.isFinite(meta.updatedAtMs)) continue;
      const history = readJson(path.join(chatDir, 'prompt_history.json'));
      const prompts = new Map();
      for (const text of Array.isArray(history) ? history : []) {
        if (typeof text !== 'string') continue;
        const key = normalize(text);
        if (wanted.has(key)) prompts.set(key, 'prompt history');
      }
      const chat = { id: entry.name, dir, meta, prompts };
      const copies = chats.get(chat.id) || [];
      copies.push(chat);
      chats.set(chat.id, copies);
    }
  }
  return chats;
}

async function indexTranscripts(config, chats, wanted) {
  const projects = path.join(config, 'projects');
  for (const project of readDirectory(projects)) {
    if (!project.isDirectory()) continue;
    const root = path.join(projects, project.name, 'agent-transcripts');
    for (const entry of readDirectory(root)) {
      const id = entry.isDirectory() ? entry.name : path.basename(entry.name, '.jsonl');
      const copies = chats.get(id);
      if (copies?.length !== 1) continue;
      const file = entry.isDirectory() ? path.join(root, id, id + '.jsonl') : path.join(root, entry.name);
      if (!fs.existsSync(file)) continue;
      const [chat] = copies;
      const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      for await (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.role !== 'user' || !Array.isArray(record.message?.content)) continue;
        const body = record.message.content.filter(part => part?.type === 'text').map(part => part.text).join('\n');
        const enclosed = [...body.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map(match => match[1]);
        for (const text of [body, ...enclosed].map(normalize)) {
          if (wanted.has(text)) chat.prompts.set(text, 'transcript');
        }
      }
    }
  }
}

function candidates(session, prompts, chats) {
  const latest = prompts.at(-1);
  return chats.filter(chat => chat.dir === session.cwd).map(chat => {
    const matches = prompts.filter(({ text, t }) => chat.prompts.has(text)
      && chat.meta.createdAtMs <= t + 10_000 && chat.meta.updatedAtMs >= t - 300_000);
    return { chat, count: new Set(matches.map(match => match.text)).size,
      latest: matches.includes(latest) ? chat.prompts.get(latest.text) : null };
  }).filter(candidate => candidate.count > 0)
    .sort((a, b) => Number(!!b.latest) - Number(!!a.latest) || b.count - a.count);
}

async function main() {
  const { values } = parseArgs({ options: {
    'user-data': { type: 'string' },
    'cursor-config': { type: 'string' },
    apply: { type: 'boolean' },
    help: { type: 'boolean' },
  } });
  if (values.help) return console.log(USAGE);
  if (!values['user-data']) throw new Error(USAGE);
  const userData = path.resolve(values['user-data']);
  if (!fs.statSync(path.join(userData, 'sessions.jsonl')).isFile()) throw new Error(USAGE);
  const config = values['cursor-config'] || process.env.CURSOR_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'cursor') : path.join(os.homedir(), '.cursor'));
  const events = sessionsLog.readLog(userData);
  const recorded = new Set(events.filter(event => event.e === 'conversation').map(event => event.id));
  const missing = sessionsLog.listSessions(userData).filter(session => session.cli === 'agent'
    && session.cwd?.startsWith('/') && !recorded.has(session.id));
  const promptsById = new Map(missing.map(session => [session.id, []]));
  for (const event of events) {
    if (event.e === 'prompt' && typeof event.prompt === 'string') {
      promptsById.get(event.id)?.push({ text: normalize(event.prompt), t: event.t });
    }
  }
  const wanted = new Set([...promptsById.values()].flatMap(prompts =>
    prompts.map(prompt => prompt.text).filter(text => text.length >= 24)));
  const chats = indexChats(config, new Map(missing.map(session => [hashDirectory(session.cwd), session.cwd])), wanted);
  await indexTranscripts(config, chats, wanted);
  const stores = [...chats.values()].flat();
  const verified = [];
  for (const session of missing) {
    const found = candidates(session, promptsById.get(session.id), stores);
    const [first, second] = found;
    const unique = first?.latest && !second?.latest;
    if (unique) verified.push({ session: session.id, chat: first.chat });
    const evidence = found.slice(0, 3).map(({ chat, count, latest }) =>
      `${chat.id} ${chat.dir} (${count} distinct prompt matches${latest ? `, latest in ${latest}` : ''})`);
    const status = unique ? 'verified' : first ? 'needs review' : 'no match';
    console.log(`${session.id} ${status}${evidence.length ? ': ' + evidence.join('; ') : ''}`);
  }
  if (!values.apply) {
    console.log(`Dry run. ${verified.length} of ${missing.length} missing IDs can be backfilled.`);
    return;
  }
  const current = new Set(sessionsLog.readLog(userData).filter(event => event.e === 'conversation').map(event => event.id));
  let applied = 0;
  for (const { session, chat } of verified) {
    if (current.has(session) || sessionsLog.readActiveFile(userData, session)) {
      console.log(`${session} skipped because AgentTerm has since recorded an ID or still holds the session.`);
      continue;
    }
    sessionsLog.appendEvent(userData, { e: 'conversation', id: session, conversation: chat.id, dir: chat.dir });
    applied++;
  }
  console.log(`Backfilled ${applied} of ${missing.length} missing IDs.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
