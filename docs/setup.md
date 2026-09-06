# Set up AgentTerm

AgentTerm runs on macOS, and on Windows through WSL. There is no installer and no release to download: you keep a clone of this repo and run it from there, so the source you have is the terminal you get.

## The first start

Three things: Node.js, a clone of `https://github.com/albertwujj/agent-term`, and `npm ci` in it once to install its dependencies. On Windows the clone lives inside WSL, where the shell and your agents run, while the window itself is a native Windows process, so Node.js is needed on both sides. The [platform instructions](dev/development.md) have the prerequisites and the exact commands.

Start it from the project you want to work in rather than from the clone, because a window opens on the directory it was started from. [Sessions](sessions.md) has that command and where each window opens; after the first one, windows come from the app itself.

You get sessions as windows with their taskbar buttons or Dock tiles, the picker, and commenting on anything the agent prints. In the window, start your usual CLI the way you always do; sessions from before this terminal resume normally.

## Staying current

Pull the clone and reinstall its dependencies ([platform instructions](dev/development.md#update-an-existing-checkout)). AgentTerm says so itself when the two fall out of step: a drifted lockfile prints a line in the terminal it opens, and a missing package stops the launch with a window naming what to run. A window opened from the app has no console behind it, so whatever Node prints there goes to a log file, and the terminal points at that file when there is anything in it.

## Later, the loops

The terminal is complete without them; [add a loop](loops.md) covers them when you want one.
