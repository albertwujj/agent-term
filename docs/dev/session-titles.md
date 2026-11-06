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

**Claude Code** pushes the conversation's topic, with `◐`/`◑` while busy
and `✳` when idle in 2.1.278. Older versions use braille busy frames. It
pushes its brand banner (`Claude Code`) before the topic exists. It may
also push several dot-separated segments at once, repeating one of them.

**Cursor** (`agent`) pushes the literal banner `Cursor Agent` at startup,
then the task title once it has one. Its optional status indicators append
an emoji and status, such as ` - ⏳ Working ...` or ` - ✅ Ready`.

**Codex** 0.167.0 pushes, by default, the project directory's name until it
has named the thread, then the thread's name in front of it, with a braille
spinner in front while a turn runs:

```
agent-term-debug                                  before the thread has a name
⠋ agent-term-debug                                working, not yet named
Reply PONG | agent-term-debug                     named (about 12 s after the first prompt)
⠋ Reply PONG | agent-term-debug                   named, working
```

The name is the one Codex's own `codex resume` picker lists for the thread.
Codex 0.155.1 showed only the project in its default title.

A user can choose the title's items instead, through Codex's
`tui.terminal_title` setting, which takes a list of item identifiers. With
`["status", "app-name", "thread", "spinner"]` (what AgentTerm's launches
asked for until they stopped passing `-c`, below) it emits:

```
Ready | codex                                     before a thread exists
Ready | codex | 01a072d1-e0bd-72e0-818c-…          thread created, not yet named
Ready | codex | Investigate WSL launch failures    named
```

The status field is `Ready`, `Starting`, `Thinking`, `Working`, or `Waiting`.
`Waiting` means a background terminal is still running, not a request for
user input. The spinner item enables a distinct `[ ! ] Action Required`
(or its blinking `[ . ]` variant) prefix for approval and input waits.
Thread-title generation can append its own braille spinner independently
of whether a turn is running, so that suffix alone is not activity evidence.

The separator is ` | `, except next to the spinner item, which uses a space.
Status comes first so an old title such as `codex | Working` still means a
conversation named Working. Cleanup removes status and spinner decorations
before checking for a UUID and before display or semantic deduplication.
The app field still provides readiness and identifies the thread-title
format. Verified against codex-cli 0.155.1 and its matching source:
[status surfaces](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/tui/src/chatwidget/status_surfaces.rs).

## Codex launches

The picker's own launches, start-new and resume alike, add one option in
`aiCliLaunchCommand`:

```
codex --no-alt-screen
```

It keeps the transcript in scrollback for AgentTerm's selection, search and
comments (docs/dev/cli-rendering.md). The default title already carries the
thread's name, so nothing else is needed for names.

Until 2026-11-06 the line also carried
`--no-daemon -c 'tui.terminal_title=["status","app-name","thread","spinner"]'`.
Any `-c` makes Codex run its app server inside the TUI instead of the shared
background daemon, and an in-process server reads the account and its
workspace routing afresh at every launch. Behind a corporate gateway that
answers chatgpt.com with a time-bound policy page (Zscaler, on the machine
where this was found), that read gets the page instead of JSON, and Codex
refuses every submit with `account/read failed during TUI bootstrap: …
workspace routing discovery failed`. A hand-typed `codex` kept working, because the
daemon already had its routing. Tested with one prompt each while the
gateway redirected: both lines with `-c` failed, with or without
`--no-daemon`; `--no-alt-screen` alone and bare `codex` replied.

Dropping the override has two costs. A picker-launched Codex now gives the
activity detector no explicit status (below), as a hand-typed one never
did. And a Codex resume still goes through Codex's own `/resume` dialog.
Run by the shared daemon, a Codex thread leaves nothing in the TUI's process
that names it: the daemon holds every live thread's rollout, the TUI's log
rows carry no thread id, and Codex has no option that sets or prints one
(the id appears only in the line it prints on exit). So AgentTerm cannot
hand Codex a thread id as it does Cursor's and Claude's
(src/cli-conversation.js). The resume band's filter chip carries the
captured name, which is the row Codex's picker lists.

A user who wants the status items can set `tui.terminal_title` in their own
`~/.codex/config.toml`; the predicate and the status reader below take that
shape too. Whether a config-file setting leaves Codex on the shared daemon,
as the default does, has not been checked.

A start-new pick runs the line. Taken with Shift+Enter it is typed into
the shell and left at the prompt instead, so the option is in view and
the user's own options follow it; their Enter runs it (`picker-start-new`
in `main.js`, the launch band in `resume-hint.js`). Either way the line
goes through prompt-capture as typed keystrokes, so the Enter reports the
whole command and the CLI is recorded the way a hand-typed launch is.

A `codex` the user types in the shell is not ours to rewrite, so it keeps
Codex's screen setting; `codex --no-alt-screen` gives it scrollback. Its
default title names the thread the same way. Once the picker hands a
window to the shell (Esc, or a shell command such as `cd` from its Run
row), the launcher strip (`launcher-band.js`) keeps the CLIs on offer, and
a chip starts Codex through the same launch; the picker itself is one step
away too (Sessions in the chrome bar, Cmd/Ctrl+Shift+S).

## The predicate

`isConversationTitle` in `ai-title.js` decides whether a title is a name
for the conversation. For every CLI but Codex it is the existing "cleans
away to nothing" test: `cleanAiTitle` strips spinner prefixes, drops
brand labels for that CLI, and de-duplicates repeated segments, so a
banner cleans to the empty string and fails. `Cursor Agent` is in that
brand vocabulary; without it the banner survives cleaning and becomes an
identity.

Codex is the exception, because its rejects are not brand labels — a
project name looks like ordinary text. There the predicate demands a thread
field: the name in front of the last ` | ` in the default shape, or after
`codex | ` in the configured one. A project label alone has none, and a
thread field that is still a UUID is rejected.

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

`cleanAiTitle` strips the trailing ` | <project>` field of Codex's default
title, or the leading `codex | ` app field of the configured one, so the
picker line, the resume hint, and the macOS window title read the
conversation's name alone. It strips only that one field: a name may itself
contain `|`.

The macOS window title, also used by the Dock's window list, applies
`isConversationTitle` before displaying a subject. Until a conversation
name arrives it shows only the CLI name, so Codex's unnamed thread UUID
and default project label cannot leak into the Dock menu.
The resume hint also applies the predicate, falling back to the prompt
when its title is not a conversation name. Saved UUID spinner titles are
repaired by the log fold, so the picker and hint use the first real name
already recorded after them.

The fold keeps two titles per session. `title` is the identity — the
first name that arrived after the first prompt — and `lastTitle` is
last-wins, what the window most recently ran. They differ when a resume
picked a different conversation in the CLI's own dialog, which is
possible precisely because AgentTerm does not pass a thread id; the
picker shows that as a drift line.

## Activity as additional evidence

`cli-title-status.js` adds an explicit-idle veto to `computeIsWorking`.
A recognized ready/input-wait title suppresses the raw-output signal even
while an idle prompt animation keeps emitting bytes. Busy and unknown
states retain the existing five-second output-recency and typing rules.
The title does not latch "working" after a process falls silent. This is
still a heuristic: a completely silent long-running turn can become idle
under the existing timeout.

The main process observes OSC 0/2 directly through `osc-title-watch.js`,
including split sequences and BEL/ST endings, so pausing the renderer for
comments cannot pause status. Unrecognized titles and title restoration
withdraw the veto; new launches and resumes reset the evidence. This uses
the same PTY stream on macOS and Windows/WSL, without reading vendor
session files or adding a network connection. The hub payload is unchanged.
Activity transitions send an immediate heartbeat, even without changed screen
text or an active viewer; they do not wait for the working-state 30-second
heartbeat. The viewer retains its existing eight-second idle debounce.
The main log records title-state transitions (`working`, `idle`, `unknown`)
with CLI and session id, without recording the title or prompt contents.

Vendor adapters are conservative:

- **Codex:** only the configured title's status and approval fields count.
  The default title's spinner is not read as status, so AgentTerm's
  launches, like hand-typed ones, keep the fallback unless the user
  configured those fields.
- **Claude Code:** require an observed half-circle or braille busy marker
  before trusting an idle asterisk. Older star-only spinners retain the
  fallback. Multiplexer launches also keep the fallback because Claude
  can deliberately use a static idle-looking title there.
- **Cursor:** recognize its emoji-marked suffixes, including ready and
  user/confirmation waits. Enable them with `/status-indicators`, or
  `display.showStatusIndicators: true` in Cursor’s global CLI config.
  Disabled or emoji-free titles retain the fallback; a conversation name
  ending in ` - Ready` is not sufficient evidence. Verified in the installed
  2026.08.11-e8db854 bundle and [Cursor’s configuration reference](https://cursor.com/docs/cli/reference/configuration).
- **Copilot:** 1.0.83 emits a session name and/or arbitrary current intent
  ending in ` - GitHub Copilot`. Those fields cannot reliably distinguish
  activity, so they retain the fallback. Even the bare `GitHub Copilot`
  title can appear at turn start before the intent arrives. No keywords
  from intent text are interpreted as status.

## Tests

`test/ai-title.test.js` covers the predicate and the launch rewrite,
`test/cli-detect.test.js` which commands count as a launch,
`test/sessions-log.test.js` the read-time repair, and
`test/sessions-picker.test.js` the rendered title line. The launch paths
are covered end to end in `test/e2e/attach-identity-title.mjs`, where the
fake `codex` refuses to emit a topic unless the override actually reached
it — so the test fails if the wiring regresses, not merely the helper;
that includes the launcher strip after a shell command, its Codex chip
Shift-clicked so the line is typed, and an option added onto it by hand.
On macOS it also reads the native window title before and after the
first prompt, including while Codex's thread is still unnamed and after
the name arrives.

`test/cli-title-status.test.js` covers vendor formats, fallback timing, and
identity cleanup. `test/osc-title-watch.test.js` covers split and unrelated
control sequences. `test/e2e/activity-title.mjs` replays the vendor formats
through a real PTY and records snapshots/heartbeats at a local fake hub,
including prompt delivery of a Codex status change while the renderer is
paused for comments and no viewer is active.
