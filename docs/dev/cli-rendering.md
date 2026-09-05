# How a CLI draws, and what it costs this terminal

A command-line program has two ways to put text in front of you. It can
print, so the words join everything else the terminal has shown and
scroll up out of the way; or it can take the screen and draw on it,
repainting as it likes and leaving nothing behind when it exits. `vim`,
`less` and `htop` take the screen. Most AI CLIs can do either, and some
now do the second by default.

Taking the screen costs this terminal most of what it offers, because
the features are built on the record of what has been printed:

- selecting output to comment on it
- `Ctrl/Cmd+F` across the session
- the marks a comment leaves on the scrollbar

None of them can reach a drawing. Nothing on screen says so — commenting
simply stops working — which is what makes it worth writing down.

## What we ask for, and why that lever

A shell this terminal spawns carries `CLAUDE_CODE_NO_FLICKER=0`, listed
in `WSLENV` so it crosses into WSL on Windows. `src/cli-renderer-env.js`
holds it.

The trade Claude Code's fullscreen renderer offers is flicker-free
output and flat memory in exchange for the screen. It is a good trade
where redraw throughput is the bottleneck — Anthropic name the VS Code
terminal, tmux and iTerm2 — and a poor one here, because this terminal
draws through xterm's WebGL renderer and does not flicker. So the trade
is all cost, and we decline it on the shell's behalf.

`NO_FLICKER=0` rather than `DISABLE_ALTERNATE_SCREEN=1`, deliberately.
Both outrank a saved `tui` setting, but `/tui` clears `NO_FLICKER` from
the session it relaunches, so `/tui fullscreen` still works and the last
word stays the user's. The other variable survives the relaunch and
would leave that command looking broken.

On the shell rather than the launch line, also deliberately: a `claude`
typed by hand and one started from the picker then behave the same. A
split between those two is the kind of difference that costs an
afternoon to find.

A `CLAUDE_CODE_*` variable already in the environment is left alone.
There is nothing to add over someone who has spoken to the CLI directly,
and overwriting a variable its owner set is a bug on its own. It doubles
as the way out: `export CLAUDE_CODE_NO_FLICKER=1`.

## When the request does not arrive

An environment only reaches so far. It does not reach a session the user
switched with `/tui fullscreen`, and it does not reach one running over
SSH, inside a container, or under a shell that reset it. In those the
CLI draws, and the window says so once — `src/alt-screen-notice.js`.

Three things about that notice are load-bearing:

- **It watches the state, not the command.** `/tui fullscreen` is one
  way in among several, and reading what the user typed is not something
  this terminal does. xterm's `buffer.onBufferChange` gives the
  transition directly.
- **It waits.** `vim` and `less` take the screen too, and briefly. A
  dwell tells a pager from a renderer without having to guess at what is
  running.
- **It asks at the end of the dwell, not at the transition.** A CLI
  reaches the screen before main has said which CLI it is; by the end of
  the dwell it has. Asking late absorbs that race, so the delay is not
  only about pagers.

Only Claude Code is noticed, because only it has somewhere to send the
user. The others lose the same reach and have no equivalent setting, and
a notice you cannot act on is a nag.

## The wheel, when a drawing CLI ignores the mouse

Worth knowing because the symptom points nowhere near the cause. A CLI
that takes the screen *and* declines to read the mouse leaves the wheel
with nothing to scroll — a drawing has no scrollback — so xterm falls
back to the convention `vim` established:

```js
if (!this.buffer.hasScrollback) {
  // Convert wheel events into up/down events when the buffer does not
  // have scrollback, this enables scrolling in apps hosted in the alt
  // buffer such as vim or tmux.
  const sequence = C0.ESC + (applicationCursorKeys ? 'O' : '[')
    + (ev.deltaY < 0 ? 'A' : 'B');
  for (let i = 0; i < Math.abs(amount); i++) data += sequence;
}
```

One wheel notch becomes several arrow keys. In `vim` that scrolls. In a
CLI drawing its own input box, it walks the cursor through the text you
are typing, and the wheel appears to edit your prompt. Claude Code with
`CLAUDE_CODE_DISABLE_MOUSE=1` is exactly this shape.

## Measured, not read

Against `claude` 2.1.261, launched in a pty and watched for the
alternate-screen sequence (`ESC[?1049h`), no prompt ever sent:

| Invocation | Draws |
|---|---|
| saved `tui: "default"` | prints |
| `--settings '{"tui":"fullscreen"}'` | takes the screen |
| `CLAUDE_CODE_NO_FLICKER=1` | takes the screen |
| `--settings '{"tui":"fullscreen"}'` + `CLAUDE_CODE_NO_FLICKER=0` | prints |
| `--settings '{"tui":"fullscreen"}'` + `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` | prints |
| `--settings '{"tui":"default"}'` + `CLAUDE_CODE_NO_FLICKER=1` | takes the screen |

The last two rows are the precedence: an environment variable outranks
the saved setting, in both directions. There is no command-line flag for
the renderer; `--settings` carries the same key the file does.
