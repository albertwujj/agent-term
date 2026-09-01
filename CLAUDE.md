# Agent Term

Electron terminal for coding agents, on macOS and Windows (on Windows the shell and the agents run in WSL).

## Distribution

AgentTerm has no release workflow. Users run the rolling `main` branch directly from source.

- Do not create GitHub releases or tags for normal AgentTerm distribution.
- Do not bump `package.json` merely to mark a release; its version is retained as historical/build metadata.
- JetBrains plugin builds and releases belong to [`albertwujj/intellij-navigator`](https://github.com/albertwujj/intellij-navigator).

The former Windows installer pipeline and its `v0.1.15` recovery baseline are frozen in `docs/maintainer/windows-installer.md`.

## Build

- `npm run start` — dev: build + launch locally, using npm's invocation directory as the terminal workspace
- `npm run start:wsl` — from WSL, launch the Windows Electron app against this source, using npm's invocation directory as the WSL workspace
- `npm run build` — rebuild generated runtime bundles without launching

From the AgentTerm checkout, run the commands normally to develop AgentTerm itself. To use the source checkout from another workspace, run `npm --prefix /path/to/agent-term run start` on macOS or `npm --prefix /path/to/agent-term run start:wsl` on WSL. Source launchers require npm's `INIT_CWD` and fail rather than guessing a workspace.

The historical `npm run dist:win` command is no longer tested or used for releases; see `docs/maintainer/windows-installer.md` before attempting it.

## Test

- `npm run test:all` — full WSL/macOS non-E2E suite
- `npm run test:e2e` — Electron UI suite (requires a graphical session such as WSLg on WSL)

## Streaming

`src/stream/` is the source-side client that streams sessions to a self-hosted
[agent-stream-hub](https://github.com/albertwujj/agent-stream-hub), the phone
viewer. The protocol (`stream.md`) and hub setup (`SETUP.md`) live in that repo;
the comments in `src/stream/` reference it as a sibling checkout.
