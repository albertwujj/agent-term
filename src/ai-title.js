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
  agent: ['agent', 'cursor'],
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
  for (const rawPart of String(title || '').split(/\s+·\s+/u)) {
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

module.exports = {
  cleanAiTitle,
  cleanAiTitleSegments,
  aiTitleDedupeKey,
};
