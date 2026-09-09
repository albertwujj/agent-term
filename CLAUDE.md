# Agent Term

Electron terminal for coding agents, on macOS and Windows (on Windows the shell and the agents run in WSL). It runs from the rolling `main` branch of a source checkout; there is no release, installer or package.

## Read first

- [docs/dev/install.md](docs/dev/install.md): getting it running from source on each platform, and the start commands.
- [docs/dev/development.md](docs/dev/development.md): the edit loop, logs, and the build and test commands.
- [docs/setup.md](docs/setup.md) and the rest of [docs/](docs/): what users read.

## Rules for this repo

- Do not create GitHub releases or tags, and do not bump the version in `package.json`; it is kept as historical build metadata.
- The Windows installer pipeline (`npm run dist:win`) is frozen and untested; [docs/dev/maintainer/windows-installer.md](docs/dev/maintainer/windows-installer.md) is its record.
- JetBrains plugin builds and releases belong to [albertwujj/intellij-navigator](https://github.com/albertwujj/intellij-navigator).
- `src/stream/` is the client for [agent-stream-hub](https://github.com/albertwujj/agent-stream-hub), the phone viewer. The protocol (`stream.md`) and the hub setup (its README) live in that repo, which the comments reference as a sibling checkout; the terminal's side is `hubUrl` and `hubSecret` in `~/.agent-term/config.json`.
