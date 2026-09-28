# Security

## What AgentTerm touches

AgentTerm needs no account, sends no telemetry, and runs no server. These features can make network connections:

- A web link you open goes to your browser or opens in the window. Pages opened in the window can load their own resources.
- An IDE jump connects to the optional navigator plugin on `127.0.0.1`.
- Once you set `hubUrl` in `~/.agent-term/config.json` for the optional phone view, AgentTerm sends your first prompt, machine name, and live terminal screen to your hub, and accepts input back. The address must be `https`, so that traffic is encrypted; AgentTerm refuses plain `http` except to `localhost`.

Your shell and coding agents can make their own network requests, as they do in any terminal.

**Project files.** AgentTerm sees what you type and what programs print. It reads files you open and saves edits you make in its viewers. Pasting an image writes a copy to your system's temporary folder.

**App data.** It saves prompts, agent titles, and working directories for the session picker, plus diagnostic logs, in `~/Library/Application Support/agent-term` on macOS or `%APPDATA%\agent-term` on Windows. Logs older than a week are removed at startup. Pages opened in the window can also leave cookies and cache there.

**Install.** Setup clones this repository and runs `npm ci`, which installs dependencies from the committed lockfile and downloads Electron's binary. On Windows, the launcher installs Windows dependencies in a separate cache when needed and runs each window from a source snapshot in `%LOCALAPPDATA%\AgentTermWslDev`.

**Updates.** AgentTerm does not update itself. New windows run the source in your checkout, which changes when you pull or edit it.

If you want to inspect the source first, ask your agent to clone the repo and review its install scripts and network, file, and shell access before running `npm ci`.

## Reporting a vulnerability

Report vulnerabilities through [GitHub's private form](https://github.com/albertwujj/agent-term/security/advisories/new); keep details out of public issues. Fixes land on `main`, the only supported version; new windows pick them up after you pull.
