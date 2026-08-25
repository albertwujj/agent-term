# Agent Term

Electron terminal app that spawns a WSL shell on Windows.

## Releases

GitHub Releases distribute only the two JetBrains IDE plugin ZIPs. AgentTerm itself runs from source; do not publish an application installer or package.

- `./scripts/release.sh --check` — verify the current release inputs and run the non-GUI test suite without changing anything
- `./scripts/release.sh` — repeat those checks, bump the patch version, commit/tag/push, carry forward the two latest plugin ZIPs, and publish a release named `AgentTerm IDE Plugins v<version>`
- `./scripts/release.sh --patch-plugin <zip> [tag]` — replace one plugin ZIP on a release, removing the superseded ZIP for the same host/client role

The former Windows installer pipeline is frozen in `WINDOWS_INSTALLER.md`. `--refresh` is retired and intentionally fails.

## Build

- `npm run start` — dev: build + launch locally
- `npm run start:wsl` — from a native-WSL checkout, launch the Windows Electron app against that source without packaging
- `npm run build` — rebuild generated runtime bundles without launching

The historical `npm run dist:win` command is no longer tested or used for releases; see `WINDOWS_INSTALLER.md` before attempting it.

## Test

- `npm run test:all` — full WSL/macOS non-E2E suite
- `npm run test:e2e` — Electron UI suite (requires a graphical session such as WSLg on WSL)

## Streaming (planned)

Source-side client that streams sessions to a hub on Mac mini for remote
viewing. Spec, schema, and roadmap: `../agent-stream-hub/stream.md`.
