# Set up AgentTerm

This page is for you and for the agent doing the setup. It says what is going on; the commands live in the [platform instructions](dev/development.md).

AgentTerm runs on macOS, and on Windows through WSL. There is no installer and no release to download: you keep a clone of this repo and run it from there, so the source you have is the terminal you get.

## The first start

You need Node.js and a clone of `https://github.com/albertwujj/agent-term`, with its dependencies installed once. On Windows the clone lives inside WSL, where the shell and your agents run, while the window itself is a native Windows process, so Node.js is needed on both sides. The [platform instructions](dev/development.md) have the prerequisites and the exact commands for each platform.

You then start it from the project you want to work in, pointing at the clone, because the window opens on the directory it was started from:

```bash
npm --prefix /path/to/agent-term run start
```

(`run start:wsl` instead, on Windows.)

That gives you sessions as windows with their taskbar buttons or Dock tiles, the picker, and commenting on anything the agent prints. In the window, start your usual CLI the way you always do; sessions from before this terminal resume normally. See [sessions](sessions.md).

From then on the command line is not how you open a window. Right-click the taskbar button or Dock tile, or press `Ctrl/Cmd+Shift+N`, and the new window takes the current source from your clone.

## Staying current

Pull the clone and reinstall its dependencies ([platform instructions](dev/development.md#update-an-existing-checkout)). AgentTerm says so itself when the two fall out of step: in the terminal when the lockfile has merely drifted, and in a window of its own when a package is missing outright.

## The optional loops

Each loop is a small repo of its own, and none of them is required. Add the ones you want.

| Loop | What it adds | What setting it up means |
|---|---|---|
| [agent-threads](https://github.com/albertwujj/agent-threads) | writing on [plans](plan.md) and [curated reviews](review.md) | a clone |
| [agent-lock](https://github.com/yunxin/agent-lock) | the [checkout lock](lock.md) agents share | a clone |
| [agent-jobs](https://github.com/yunxin/agent-jobs) | [long runs](jobs.md) that report their own completion | a clone |
| [agent-stream-hub](https://github.com/albertwujj/agent-stream-hub) | [your phone](phone.md) as the same terminal | a relay you host, and the page added to your home screen |
| [IntelliJ Navigator](https://github.com/albertwujj/intellij-navigator/releases) | [click a reference, the IDE jumps](ide.md) | a plugin installed in the IDE |

Where a clone sits decides what resolves. You command these loops by naming an instruction file (`@produce-r` for producing a review), and both your `@` completion and the terminal take the nearest copy up the directory tree. A clone in the repo's `ai/` folder serves that project; one in your home directory serves every project. [Placement](conventions.md) has the rule and which to choose.

Voice on the phone reads from a kit of its own, [voice-to-agent](https://github.com/albertwujj/voice-to-agent), placed by that same rule. The terminal resolves it and tells the agent when it cannot find it.
