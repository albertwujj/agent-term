# Set up AgentTerm

AgentTerm runs on macOS, and on Windows through WSL. There is no installer and no release to download: you keep a clone of this repo and run it from there, so the source you have is the terminal you get, and a pull keeps it current.

## Recommended setup

Set up the terminal and its local components together: plans and reviews, the checkout lock, long jobs, and the voice interpretation guide. Phone access and IDE integration have [separate setup](#phone-and-ide-integration).

<a id="the-basic-setup"></a>

### Install the terminal

1. Install Node.js.
2. Clone `https://github.com/albertwujj/agent-term` to `~/agent-term`, beside your projects. One clone serves them all.
3. Run `npm ci` in it, once.

On Windows the clone lives in WSL, where the shell and your agents run; Node.js is needed on both sides. The [platform instructions](dev/install.md) have the prerequisites and the exact commands.

### Add the local components

From your project's root directory, clone these four repos into `ai/`:

```bash
git clone https://github.com/albertwujj/agent-threads ai/agent-threads
git clone https://github.com/yunxin/agent-lock ai/agent-lock
git clone https://github.com/yunxin/agent-jobs ai/agent-jobs
git clone https://github.com/albertwujj/voice-to-agent ai/voice-to-agent
```

One agent-threads clone covers both plans and reviews. Keep `ai/` out of `.gitignore` so your agent can find the instruction files. On Windows, these clones live in WSL with your project. For an existing setup, reuse the clones you already have; see [placement](conventions.md#placement) for alternatives.

The voice-to-agent clone provides instructions for interpreting dictated input. Recording and transcription are configured with [phone access](#phone-and-ide-integration).

### Launch and start using it

Open an AgentTerm window from the project you want to work in rather than from the clone, so the agent starts in that directory:

```bash
npm --prefix ~/agent-term run start
```

(`run start:wsl` instead, on Windows.) [Sessions](sessions.md) covers how to start an agent, or pick up one from before this terminal.

The [suite guides](suite.md#using-the-components) cover writing on plans, requesting a curated review, taking the checkout lock, and starting long jobs. Cloning makes these capabilities available; the guides tell your agent when and how to use them.

## Terminal only

For a smaller setup, follow [Install the terminal](#install-the-terminal) and [Launch and start using it](#launch-and-start-using-it). You can add any of the local components later.

<a id="optional-suite"></a>

## Phone and IDE integration

- [Phone access](phone.md#setup) needs an agent-stream-hub relay you host. To reply by voice, also follow the hub's [voice input setup](https://github.com/albertwujj/agent-stream-hub/blob/main/docs/setup.md#optional-voice-input) for recording and transcription; the voice interpretation guide is already included above.
- [IDE integration](ide.md) needs the IntelliJ Navigator plugin installed in your IDE.
