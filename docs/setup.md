# Set up AgentTerm

AgentTerm runs on macOS, and on Windows through WSL. There is no installer and no release to download: you keep a clone of this repo and run it from there, so the source you have is the terminal you get, and staying current is a pull and an install ([platform instructions](dev/install.md#update-an-existing-checkout)).

## The first start

Three things: Node.js, a clone of `https://github.com/albertwujj/agent-term`, and `npm ci` in it once to install its dependencies. On Windows the clone lives inside WSL, where the shell and your agents run, while the window itself is a native Windows process, so Node.js is needed on both sides. The [platform instructions](dev/install.md) have the prerequisites and the exact commands.

Start it from the project you want to work in rather than from the clone, because a window opens on the directory it was started from. [Sessions](sessions.md) has that command and where each window opens; after the first one, windows come from the app itself.

You get sessions as windows with their taskbar buttons or Dock tiles, the picker, and commenting on anything the agent prints. In the window, start your usual CLI the way you always do; sessions from before this terminal resume normally.

## Later, the loops

Plans and reviews, the checkout lock, long jobs, the phone view, the IDE jump: each is a repo of its own, and the terminal is complete without them. [Add a loop](loops.md) when you want one.
