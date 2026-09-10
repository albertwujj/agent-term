// Which AI CLI a shell command starts, and the picker's reading of the text
// in its input as a launch. One table serves main (the line the user
// submits to the shell) and the picker (the text being typed), so the two
// never disagree about what counts as a launch.

// First match wins; "gh copilot" is checked before bare "copilot" so the
// longer form takes precedence.
const CLI_PATTERNS = [
  { name: 'copilot', re: /^gh\s+copilot(?:\s|$)/i },
  { name: 'claude',  re: /^claude(?:\s|$)/i },
  { name: 'codex',   re: /^codex(?:\s|$)/i },
  { name: 'copilot', re: /^copilot(?:\s|$)/i },
  { name: 'agent',   re: /^agent(?:\s|$)/i },
  { name: 'agent',   re: /^cursor-agent(?:\s|$)/i },
];

// The names the picker completes a typed prefix to.
const KNOWN_CLIS = ['claude', 'codex', 'copilot', 'agent'];

function detectCli(cmd) {
  const trimmed = String(cmd || '').trim();
  for (const p of CLI_PATTERNS) {
    if (p.re.test(trimmed)) return p.name;
  }
  return null;
}

// The picker's reading of its input as a launch. The first word names the
// CLI, exactly or as a unique prefix ("cl" is claude); whatever follows is
// carried as options. An invocation the patterns know in full ("gh
// copilot") is a launch as typed. Null means the text is a shell command.
//
//   cli      the CLI's name
//   command  the launch line handed to main ("claude --resume")
//   typed    the characters the user typed of the name, for the bold prefix
//            in the row ('' when the name was not completed)
//   args     the options after the name, '' when there are none
function parseLaunch(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const space = trimmed.search(/\s/);
  const head = space < 0 ? trimmed : trimmed.slice(0, space);
  const args = space < 0 ? '' : trimmed.slice(space + 1).trim();
  const lower = head.toLowerCase();
  let cli = null;
  if (KNOWN_CLIS.includes(lower)) {
    cli = lower;
  } else {
    const matches = KNOWN_CLIS.filter(c => c.startsWith(lower));
    if (matches.length === 1) cli = matches[0];
  }
  if (cli) return { cli, command: args ? `${cli} ${args}` : cli, typed: head, args };
  const known = detectCli(trimmed);
  if (known) return { cli: known, command: trimmed, typed: '', args: '' };
  return null;
}

module.exports = { CLI_PATTERNS, KNOWN_CLIS, detectCli, parseLaunch };
