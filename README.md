# Grow your terminal for agents to fit your work

**Use this repo for a head start. What you grow for your situation serves others like you.**

![stills from the terminal: session tiles, the picker, commenting on output, writing on a plan, a curated review, and the phone view](docs/assets/hero-walk.gif)

## Quick start

For macOS and Windows with WSL. Ask your coding agent:

```text
Clone https://github.com/albertwujj/agent-term to ~/agent-term, then set it
up and launch it for my current project, following the basic setup in its
docs/setup.md.
```

Click [docs/setup.md](docs/setup.md) if you want to read it.

Once it opens, start your usual agent, select something in its output, and write a [comment](docs/comment.md).

## The terminal path

People run coding agents in an IDE, in the terminal, or in the vendor's desktop app. The terminal keeps pulling them in: Claude Code and Codex shipped as terminal programs, and Cursor and Copilot, born in the IDE, added CLIs of their own. A form from decades ago turned out to be a good fit for what an agent needs: text in, text out, and your shell, git, and every other tool you own one command away.

So why do people still run agents in the IDE, and why are the vendors adding their agents to desktop apps? Partly because the standard terminal interface (TUI), although great for text-centric iteration, cannot offer agents and users the essentials and the boosts a richer interface can. One answer is to move the agent out, into an app built around it. The other is to treat the terminal as the core and extend it. This repo is the second path: a full terminal wrapped in a modern extensible window (Electron), retaining everything you already have and raising the ceiling.

Extending it on demand is what keeps it a terminal. What you are working on comes in when you need it and goes when you are done, so the window is a terminal again the moment you finish. An IDE does not do that, as irrelevant things are already there before you type.

What about the vendor desktop apps, which also offer a richer interface? An app built around one vendor's agent trades away key benefits, including the other agents and the closeness to your shell environment. For coding it can also disorient, adding a workspace of its own between you and the code; many who try it drift back to the terminal, where the familiar, the continuity, the repo, the shell, and the tests already live. The grown terminal here keeps all of that and adds a lot more.

That move is now coming from the terminal side too: several terminals have grown an agent of their own, with ways to run many at once, including in the cloud. To get their environment you take their agent. Here nothing about working with your agent changes.

## Why it holds

This path can look hacky: the host parses text, and reacts to it. But established text patterns are a stable interface, and a helpful output style sticks around. An agent's intentions arrive in those patterns through every turn, so the parsers keep working. It holds from both sides: guide files instruct the agents to print what the host understands, and the parser tracks the natural output styles the agents use intuitively. Extending it is quick when something new shows up, and none of it is tied to a vendor SDK or API.

The host also lets a capable agent do more than its CLI can alone. A CLI does not own the window, so when Claude Code publishes a design mock it can only print the URL and go around the terminal, opening your browser on it. With a host that reacts, the printed line alone is enough: the viewer opens right in the window, with placement and sizing optimized for the situation. The loops work the same way: the agent puts a plan in front of you, hands you a review, starts a job that reports back to it, takes the checkout lock, and reaches you on your phone.

## Fit it to your work

It is yours, and the agents, made better by running in this grown terminal, grow it further. Growing runs as a continuum. At one end, something falls short in your situation: the symptom is right there, in front of you and your agents, who are in a good position to evaluate and build the fix. At the other, a feature that fits your work better, or one you are the first to need. Either way you know your needs best, and a situation is rarely yours alone, so what you grow for yours serves others like you. So start your own, use and build upon this repo.

## What's added so far

These are the main ones. Follow the links to see an overview of more features omitted here.

| In a standard terminal | In this grown terminal |
|---|---|
| Several agents running means identical tabs outside, walls of text inside. | Each session gets its own **[unique taskbar button or Dock tile](docs/sessions.md)** (with a preview on Windows, the session title on macOS), so you tell them apart at a glance, and the picker searches instantly, down to every prompt you typed and more. |
| Everything the agent prints (a diff, a plan, a claim, a link) is dead text you can read but not act on. | **[Select any of it and comment](docs/comment.md)**, precise feedback with the exact text quoted; the agent makes the change. A click opens whatever renders (docs, reviews, images, video, PDFs) inside the window; web links open in your browser ([the click rule](docs/clicks.md)). |
| Its plans and docs are raw markdown in an editor. | They render live; you **[write in the rendered page](docs/plan.md)** and the agent maintains the source. |
| Agents sharing a checkout have no awareness of each other: branches move, files change, test ports collide. | Type one `@` mention (`@proceed-b` completes to the guide doc's path) and the agent **[takes the checkout lock](docs/lock.md)** and cuts a branch before its first edit; a padlock at the top right of each window shows who holds it. |
| The agent finishes a change and you get a wall of diff. | It hands you a **[curated package, rendered for your review](docs/review.md)**; you comment inline, it fixes and replies in place. |
| A long CI run either blocks the session, or outlives the agent's turn and finishes unnoticed. | The agent starts the job and hands the terminal back; **[the job reports its own completion](docs/jobs.md)** through the terminal and the idle agent is prompted to pick it up, even across a session restart; a runner icon at the top right shows what is running. |
| It sits blocked on a question until you're back at your desk. | **[Your phone shows the same terminal](docs/phone.md)**; unblock it by voice. |
| The agent cites file:line and symbols; checking a claim means finding it by hand. | Click any reference and **[your IDE jumps to that exact line](docs/ide.md)** after a brief pause for selection; Ctrl/Cmd-click jumps immediately. The editor stays read-only so a stray key changes nothing. |

## Native to the OS

Why not tmux, or one manager app over every session? This terminal takes the opposite shape: each session is its own OS window and process, the way each agent stands on its own. The OS is the manager you already know, so the taskbar, the Dock, Mission Control, and alt-tab do the juggling, and each agent, through its terminal host, is instantly recognizable. The phone hub is the one aggregator, and it runs on the side, remotely, never interfering with the OS windows. An agent and its host grow into one whole, independent of the other wholes and cooperating with them through conventions such as the checkout lock. Subagents belong inside it, under the main agent.

## Make it yours

The first start gives you sessions as windows with their taskbar buttons or Dock tiles, the picker, and commenting on anything the agent prints. [Existing sessions](docs/sessions.md) from before this terminal work too.

The rest are [optional loops](docs/loops.md): [plans](docs/plan.md) and [reviews](docs/review.md) (one repo covers both), the [checkout lock](docs/lock.md), [long jobs](docs/jobs.md), the [phone view](docs/phone.md), the [IDE integration](docs/ide.md). Ask your agent for the ones you want. For example, this adds the checkout lock:

```text
Clone https://github.com/yunxin/agent-lock into ai/ in this project,
and leave ai/ out of .gitignore.
```

Then start a task with `@proceed-b`, which completes to the lock's [guide doc](https://github.com/yunxin/agent-lock/blob/main/proceed-by-lock-and-branch.md) in the [agent-lock](https://github.com/yunxin/agent-lock) clone, and the agent takes the [checkout lock](docs/lock.md) before it works.

**Grow it.** Fill what you need with your agents, using this terminal itself as a boost. Every new window starts from the latest source, so the loop stays short ([how a window opens](docs/sessions.md)).

Built on Electron with xterm.js (the terminal emulator) and node-pty (the shell's pty). MIT.
