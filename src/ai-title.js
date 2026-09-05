// Helpers for AI CLI OSC titles.
//
// Claude/Codex-style CLIs use terminal titles as status surfaces. The raw
// strings can include spinners, CLI brand labels, and repeated dot-separated
// task titles. These helpers convert them into stable display text and
// semantic keys before taskbar/picker rendering.

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
  s = s.replace(/^[\u2800-\u28ff✳✻✢✶✽✦✧*•●○◐◓◒◑]+\s*/u, '');
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

function cleanAiTitleSegments(title, cli) {
  const ignored = ignoredKeysForCli(cli);
  const seen = new Set();
  const out = [];
  // Codex's supported ["app-name", "thread"] title is "codex | <name>".
  // Only strip its leading app field: a conversation name may contain '|'.
  const text = cli === 'codex'
    ? String(title || '').replace(/^codex\s+\|\s*/i, '')
    : String(title || '');
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
  if (cli === 'codex') {
    // The default OSC title is only a project label. Accept the explicit
    // app-name + thread output contract, including on read of old logs.
    // Before Codex has a name its thread field is a UUID, not a subject.
    const match = /^codex\s+\|\s*(.+)$/i.exec(String(title || ''));
    if (!match || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(match[1].trim())) return false;
  }
  return !!cleanAiTitle(title, cli);
}

function aiCliLaunchCommand(command) {
  // A supported per-invocation override, scoped to Codex launches we own.
  // Keep app-name so even an unnamed new thread emits an OSC readiness title.
  // No shell wrappers, input rewriting, config writes, or metadata guessing.
  return String(command || '').replace(/^codex(?=\s|$)/i,
    'codex -c \'tui.terminal_title=["app-name","thread"]\'');
}

module.exports = {
  cleanAiTitle,
  cleanAiTitleSegments,
  aiTitleDedupeKey,
  isConversationTitle,
  aiCliLaunchCommand,
};
