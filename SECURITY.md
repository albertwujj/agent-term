# Security

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting for this repository, rather than in a public issue. Fixes land on `main`, the only supported version; every window opened after you pull runs the fix.

## What AgentTerm touches

**Network.** AgentTerm runs no server, sends no telemetry, and needs no account. It connects out only for what you set up or ask for:

- a link you open goes to your browser or to the viewer in the window;
- a reference you click goes to the IDE navigator plugin on `127.0.0.1`, if you installed it;
- the phone view talks only to a hub you run yourself, once you set its address in `~/.agent-term/config.json`.

**Your terminal.** Like any terminal, it sees what you type and what programs print. It keeps a session history (your prompts and the agents' titles, for the session picker) and logs pruned after a week, both in its local user-data folder: `~/Library/Application Support/agent-term` on macOS, `%APPDATA%\agent-term` on Windows.

**Install.** Setup clones this repository and runs `npm install` against the committed lockfile: seven runtime packages (xterm.js and two of its addons, node-pty, markdown-it, uFuzzy, koffi) and Electron, whose installer downloads the Electron binary. It asks for no special OS permissions.

**Updates.** Nothing updates itself from the internet. A window runs the source in your checkout, which changes only when you pull or edit it.

## Read it before you run it

All of AgentTerm is source you can read, and your agent can review it before you run anything: ask it what the code does with the network, your files, and your shell.
