# Session titles — what counts as a conversation name

A session's identity title is the name the picker shows for a
conversation: the CLI's own word for what the session is about, sitting
under the verbatim first prompt. It comes from the OSC title the CLI
pushes to the terminal, which is the only channel every CLI already
speaks. Nothing here reads a CLI's private session files.

The difficulty is that an OSC title is a status surface, not a name.
CLIs push spinner frames, brand banners, and project labels down the
same channel, and only some of what arrives is a name for the
conversation. The rules below decide what is.

## What each CLI emits

**Claude Code** pushes the conversation's topic, prefixed with a spinner
glyph while it works (`✳ Fix window titles`), and its brand banner
(`Claude Code`) before the topic exists. It may also push several
dot-separated segments at once, repeating one of them.

**Cursor** (`agent`) pushes the literal banner `Cursor Agent` at startup,
then the task title once it has one.

**Codex** pushes, by default, the project directory's name and then
spinner frames of it — `agent-term-debug`, `⠋ agent-term-debug`. That is
never a conversation name. Codex can name the thread in the title
instead, through its `tui.terminal_title` setting, which takes a list of
item identifiers. With `["app-name", "thread"]` it emits:

```
codex                                     before a thread exists
codex | 01a072d1-e0bd-72e0-818c-…         thread created, not yet named
codex | Investigate WSL launch failures   named
```

The separator is ` | `, and the app field is what distinguishes this
output from the default project label. Keeping `app-name` in the list is
therefore load-bearing, not decoration — it is also what makes an unnamed
new thread still emit a readiness title. Verified against codex-cli
0.153.4; `codex doctor` reports the setting resolving to items
`app-name, thread-title`, and warns on identifiers it does not know.

## Asking Codex for the name

The picker's own launches — start-new and resume alike — prepend the
setting as a per-invocation override, in `aiCliLaunchCommand`:

```
codex -c 'tui.terminal_title=["app-name","thread"]'
```

`-c` overrides one key for that process only, so it wins over the user's
config file and leaves it untouched. The override is scoped to launches
AgentTerm issues and to Codex: no shell wrappers, no rewriting what the
user typed, no config writes, no guessing at metadata.

A resume goes through the same launch. AgentTerm does not hand Codex a
thread id — it starts a fresh process and the user picks the conversation
in Codex's own `/resume` dialog — but the process outlives that dialog,
so the setting still governs the resumed thread's title.

A `codex` the user types in the shell is not ours to rewrite, so it keeps
the default project title. To get names there, the user adds it to their
own configuration:

```toml
[tui]
terminal_title = ["app-name", "thread"]
```

## The predicate

`isConversationTitle` in `ai-title.js` decides whether a title is a name
for the conversation. For every CLI but Codex it is the existing "cleans
away to nothing" test: `cleanAiTitle` strips spinner prefixes, drops
brand labels for that CLI, and de-duplicates repeated segments, so a
banner cleans to the empty string and fails. `Cursor Agent` is in that
brand vocabulary; without it the banner survives cleaning and becomes an
identity.

Codex is the exception, because its rejects are not brand labels — a
project name looks like ordinary text. There the predicate demands the
`codex | …` shape, and rejects a thread field that is still a UUID.

The predicate gates two things:

- **What is written.** In `main.js`, both the first-prompt fold and the
  `set-title` handler skip the log append when it fails. Titles are also
  gated on the boot vocabulary and on the semantic key having moved, so
  spinner churn does not append on every tick.
- **What is read.** `listSessions` runs it again over `title` events for
  Codex and Cursor sessions, so labels already recorded by earlier builds
  are repaired on read. The log is never rewritten; the fold simply
  declines them. The taskbar thumbnail's activity timeline applies the
  same test, so a legacy label is not a beat in the session's narrative
  either.

Claude's identity and drift semantics are deliberately untouched by all
of this.

## Display

`cleanAiTitle` strips the leading `codex | ` app field for display, so
the picker line, the resume hint, and the macOS window title read the
conversation's name alone. It strips only the leading field: a name may
itself contain `|`.

The fold keeps two titles per session. `title` is the identity — the
first name that arrived after the first prompt — and `lastTitle` is
last-wins, what the window most recently ran. They differ when a resume
picked a different conversation in the CLI's own dialog, which is
possible precisely because AgentTerm does not pass a thread id; the
picker shows that as a drift line.

## Tests

`test/ai-title.test.js` covers the predicate and the launch rewrite,
`test/sessions-log.test.js` the read-time repair, and
`test/sessions-picker.test.js` the rendered title line. The launch paths
are covered end to end in `test/e2e/attach-identity-title.mjs`, where the
fake `codex` refuses to emit a topic unless the override actually reached
it — so the test fails if the wiring regresses, not merely the helper.
