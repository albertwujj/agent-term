// Helpers for AI CLI OSC titles. Rules and per-CLI output:
// docs/dev/session-titles.md.
//
// Claude/Codex-style CLIs use terminal titles as status surfaces. The raw
// strings can include spinners, CLI brand labels, and repeated dot-separated
// task titles. These helpers convert them into stable display text and
// semantic keys before taskbar/picker rendering, and decide which of them
// name the conversation at all.

const { cliTitleStatus } = require('./cli-title-status');

const BRAND_LABELS = {
  claude: ['claude', 'claude code'],
  codex: ['codex'],
  copilot: ['copilot', 'github copilot'],
  agent: ['agent', 'cursor', 'cursor agent'],
};

const GLOBAL_IGNORED = new Set([
  'agent-term',
]);

function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function stripStatusPrefix(text) {
  let s = collapseWhitespace(text);
  // Braille spinner frames are U+2800..U+28FF. Claude also uses symbols such
  // as ✳/✻, and some terminals render the current marker as a leading "*".
  s = s.replace(/^[\u2800-\u28ff✳✱✻✢✶✽✦✧*•●○◐◓◒◑]+\s*/u, '');
  return collapseWhitespace(s);
}

function titleKey(text) {
  return collapseWhitespace(text)
    .toLowerCase()
    .replace(/[.?!]+$/g, '');
}

function ignoredKeysForCli(cli) {
  const keys = new Set(GLOBAL_IGNORED);
  for (const label of BRAND_LABELS[String(cli || '').toLowerCase()] || []) {
    keys.add(label);
  }
  return keys;
}

// The thread's name in a Codex title, or null when the title names none.
// Codex titles come in two shapes (docs/dev/session-titles.md):
//   configured   "codex | <thread>", with an optional status in front, from
//                a `tui.terminal_title` the user set (AgentTerm's launches
//                asked for it until they stopped passing -c)
//   default      "<thread> | <project>" once Codex has named the thread, and
//                "<project>" alone before that, with a braille spinner in
//                front while a turn runs (Codex 0.167.0)
// Only the app field or the project field is stripped: a thread name may
// itself contain '|'. Title generation and activity can each append a
// braille spinner; it goes before display, semantic deduplication, and UUID
// checks.
function codexThread(title) {
  const subject = cliTitleStatus(title, 'codex').title.replace(/(?:\s+[\u2800-\u28ff]+)+\s*$/u, '');
  const configured = /^codex\s+\|\s*(.*)$/i.exec(subject);
  if (configured) return configured[1];
  const named = /^(.+)\s\|\s[^|]+$/.exec(subject.replace(/^[\u2800-\u28ff]+\s*/u, ''));
  return named ? named[1] : null;
}

function cleanAiTitleSegments(title, cli) {
  const ignored = ignoredKeysForCli(cli);
  const seen = new Set();
  const out = [];
  const subject = cliTitleStatus(title, cli).title;
  // A Codex title without a thread keeps its old cleanup: the project label,
  // which isConversationTitle rejects.
  const thread = cli === 'codex' ? codexThread(title) : null;
  const text = cli === 'codex'
    ? (thread !== null ? thread : subject.replace(/(?:\s+[\u2800-\u28ff]+)+\s*$/u, ''))
    : subject;
  for (const rawPart of text.split(/\s+·\s+/u)) {
    const part = stripStatusPrefix(rawPart);
    if (!part) continue;
    const key = titleKey(part);
    if (!key || ignored.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}

function cleanAiTitle(title, cli) {
  return cleanAiTitleSegments(title, cli).join(' · ');
}

function aiTitleDedupeKey(title, cli) {
  return cleanAiTitleSegments(title, cli).map(titleKey).join(' · ');
}

function isConversationTitle(title, cli) {
  const subject = cleanAiTitle(title, cli);
  if (cli === 'codex') {
    // A project label alone names no conversation. Before Codex has a name
    // the configured thread field is a UUID, not a subject. Both shapes are
    // accepted on read of old logs too.
    const thread = codexThread(title);
    if (thread === null || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(subject)) return false;
  }
  return !!subject;
}

function aiCliLaunchCommand(command) {
  const line = String(command || '');
  if (!/^codex(?=\s|$)/i.test(line)) return line;
  // One option, scoped to Codex launches we own: keep the conversation in
  // scrollback for AgentTerm's selection, search, and comment marks, even
  // when Codex defaults to a fullscreen transcript (docs/dev/cli-rendering.md).
  // No -c override: any -c runs Codex's app server inside the TUI instead of
  // the shared daemon, and that server re-reads the account at every launch,
  // which a corporate gateway can refuse (docs/dev/session-titles.md). The
  // thread's name comes from Codex's thread store instead (cli-conversation.js).
  // No shell wrappers, input rewriting, or config writes.
  if (/(?:^|\s)--no-alt-screen(?:\s|$)/.test(line)) return line;
  return line.replace(/^codex(?=\s|$)/i, 'codex --no-alt-screen');
}

module.exports = {
  cleanAiTitle,
  cleanAiTitleSegments,
  aiTitleDedupeKey,
  isConversationTitle,
  aiCliLaunchCommand,
};
