# Set up AgentTerm

AgentTerm runs on macOS, and on Windows through WSL. There is no installer and no release to download: you keep a clone of this repo and run it from there, so the source you have is the terminal you get, and staying current is a pull and an install ([platform instructions](dev/install.md#update-an-existing-checkout)).

## The basic setup

Three things:

- Node.js.
- A clone of `https://github.com/albertwujj/agent-term` at `~/agent-term`, beside your projects. One clone serves them all.
- `npm ci` in it, once.

On Windows the clone lives in WSL, where the shell and your agents run, and Node.js is needed on both sides. The [platform instructions](dev/install.md) have the prerequisites and the exact commands.

Open an AgentTerm window from the project you want to work in rather than from the clone, because a window opens on the directory it was started from:

```bash
npm --prefix ~/agent-term run start
```

(`run start:wsl` instead, on Windows.) [Sessions](sessions.md) covers how to start an agent, or pick up one from before this terminal.

## Later, the loops

Each loop is a repo of its own, added when you want it: [the loops](loops.md) lists them.
