# Set up AgentTerm

AgentTerm runs on macOS, and on Windows through WSL. There is no installer and no release to download: you keep a clone of this repo and run it from there, so the source you have is the terminal you get, and a pull keeps it current.

## The basic setup

1. Install Node.js.
2. Clone `https://github.com/albertwujj/agent-term` to `~/agent-term`, beside your projects. One clone serves them all.
3. Run `npm ci` in it, once.

On Windows the clone lives in WSL, where the shell and your agents run; Node.js is needed on both sides. The [platform instructions](dev/install.md) have the prerequisites and the exact commands.

Open an AgentTerm window from the project you want to work in rather than from the clone, so the agent starts in that directory:

```bash
npm --prefix ~/agent-term run start
```

(`run start:wsl` instead, on Windows.) [Sessions](sessions.md) covers how to start an agent, or pick up one from before this terminal.

## Optional loops

Each loop can be installed separately; see [the loops](loops.md).
