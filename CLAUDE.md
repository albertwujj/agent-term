# Agent Term

Electron terminal app that spawns a WSL shell on Windows.

## Releases

Run `./scripts/release.sh` to bump patch version, build, and publish a new release.
Run `./scripts/release.sh --refresh` to rebuild and replace assets on the current release without bumping the version.
`--refresh` preserves the existing release/tag association, so do not manually delete and recreate the tag when refreshing assets.

## Build

- `npm run start` — dev: build + launch locally
- `npm run dist:win -- --x64` — produce Windows x64 .exe in `release/`

## Streaming (planned)

Source-side client that streams sessions to a hub on Mac mini for remote
viewing. Spec, schema, and roadmap: `../agent-stream-hub/stream.md`.
