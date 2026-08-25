# Windows installer (frozen)

> **Frozen historical documentation — no longer tested.** This records the Windows installer pipeline as it existed on 2026-08-24. AgentTerm now runs from the rolling `main` branch and has no application release workflow. The commands and implementation below remain as a reference, but they may gradually stop working as Electron, Node.js, native dependencies, NSIS, GitHub Releases, or Windows change.

For the supported workflow, use [DEVELOPMENT.md](DEVELOPMENT.md). Do not restore the installer to a release merely because these notes still exist; doing so first requires owning and re-establishing its build and Windows validation coverage.

## Recovery starting point

The last published installer baseline is the immutable `v0.1.15` tag. Start recovery work from that tag rather than assuming the installer files on a later `main` still compose correctly:

```bash
git clone https://github.com/albertwujj/agent-term
cd agent-term
git switch -c recover-windows-installer v0.1.15
npm ci
npm test
npm run dist:win -- --x64
```

That tag preserves the package lock, Electron Builder configuration, NSIS sources, relaunch code, tests, and the last installer-publishing implementation together. To inspect the former publisher without replacing the current plugin-only script:

```bash
git show v0.1.15:scripts/release.sh
```

Treat a successful build as only the beginning of recovery. The resulting unsigned artifacts must pass the Windows checklist below before the pipeline is considered supported or publishable again.

## What the pipeline produced

The package configuration requested two x64 Windows targets from Electron Builder:

- `release/AgentTerm-<version>-setup.exe` — the one-click NSIS installer formerly uploaded to GitHub Releases.
- `release/AgentTerm-<version>.exe` — Electron Builder's portable self-extracting executable. The old release script built this target but did not upload it.

Electron Builder also left an unpacked application under `release/win-unpacked/` during the build. The version in each artifact name came from `package.json`.

The executables were unsigned. Windows therefore showed an unknown-publisher SmartScreen warning on first launch.

## Last-known build procedure

The author last built the Windows x64 artifacts from macOS. `scripts/build-launcher.js` also selects NSIS binaries for Windows and Linux hosts, but those paths should not be read as a current support claim.

Prerequisites at the time of freezing:

- Node.js and npm capable of installing the checked-in `package-lock.json`.
- Network access for npm and Electron Builder's Electron/NSIS downloads.
- No signing certificate; the output was intentionally unsigned.
- The scripts did not invoke a separately installed Wine command directly; Electron Builder managed the cross-platform Windows tooling used by the recorded macOS flow.

From a clean source checkout at the version to package:

```bash
npm ci
npm test
npm run dist:win -- --x64
```

The last command expanded to:

```bash
npm run build
npm run build:launcher
electron-builder --win --x64
```

The stages were:

1. `scripts/build-runtime.js` bundled the renderer and web-viewer preload into `dist/`.
2. `scripts/build-launcher.js` used Electron Builder's downloaded NSIS toolchain to compile `build/launcher.nsi` into `build/launcher.exe`.
3. Electron Builder packaged `src/`, `dist/`, `tools/`, `node_modules/`, and `package.json`, unpacking `node-pty` and `tools` from the application archive.
4. The custom NSIS hooks in `build/installer.nsh` rearranged the installed files into the side-by-side layout described below.

`npmRebuild` was disabled. The package therefore relied on the Windows prebuilt binaries shipped by native dependencies such as `node-pty` and `koffi`, rather than rebuilding them during packaging. This is a likely point of failure as dependency and Electron versions drift.

## Installer and relaunch design

The installer did not replace a running application's files in place. Its custom NSIS hooks implemented a side-by-side layout:

```text
<install directory>/
├── AgentTerm.exe                         # small root launcher
├── .current                             # active app-* directory name
├── .agent-term-launcher-app-<version>.exe
├── app-<version>/                        # packaged Electron application
├── app-<older-version>/                  # retained while a process locks it
└── Uninstall AgentTerm.exe
```

The pieces worked together as follows:

- `build/launcher.nsi` compiled the small root launcher. It waited for any `.installing` transaction, read `.current`, and started the selected version's `AgentTerm.exe` with the original arguments.
- `build/installer.nsh` created `.installing`, chose a unique `app-<version>` directory (adding `-2`, `-3`, and so on for same-version refreshes), moved the newly installed application into it, and atomically replaced `.current`.
- Each installed version received an immutable `.agent-term-launcher-<app-directory>.exe`. A running app used that launcher when relaunching, so an install racing with a close/restart could not accidentally start half-published flat files.
- Old `app-*` directories and their immutable launchers were removed only when Windows no longer held them open.
- Uninstall removed every versioned application directory, launcher, pointer, and transaction file.
- Portable builds bypassed the installed `.current` mechanism. Relaunching spawned the outer portable wrapper so its temporary extraction directory could be cleaned safely.

The corresponding runtime selection logic lives in `src/relaunch.js`; its contract tests live in `test/relaunch.test.js`.

## Last-known Windows validation checklist

Packaging success alone was not sufficient. Before an installer could responsibly be published again, at minimum repeat this checklist on Windows x64:

1. Build both artifacts and confirm their names and version match `package.json`.
2. Install on a machine with WSL, accept the expected unsigned-app warning, and confirm AgentTerm opens a working WSL shell.
3. Start multiple windows with `Ctrl+Shift+N`; confirm each appears and relaunches normally.
4. While an old version is still running, install a newer version. Confirm the old window keeps working and a newly opened or relaunched window uses the new version.
5. Install the same version again while it is running. Confirm a unique `app-<version>-N` directory is published and relaunch selects it.
6. Interrupt or race an install with app relaunch and verify the `.installing`/`.current` transaction never starts a partial version.
7. Close old processes and verify a later install can clean their obsolete version directories and immutable launchers.
8. Exercise the portable executable, including closing/relaunching and opening another window.
9. Uninstall after all app processes close and verify the install directory is removed.

This checklist is retained as historical knowledge, not a claim that any item still passes.

## Former publishing workflow

The publishing script at the time was `scripts/release.sh`. It required `gh`, npm, Node.js, a clean releasable checkout, permission to push `main` and tags, and permission to create or modify releases in `albertwujj/agent-term`. AgentTerm no longer has a release script; the behavior below is a historical snapshot recoverable from the `v0.1.15` tag.

Its former modes were:

- `./scripts/release.sh` — increment `package.json`'s patch version, build the Windows x64 installer, commit the version files, tag and push the release, create the GitHub release, upload the setup executable, and carry forward the latest two IntelliJ plugin zips.
- `./scripts/release.sh --refresh` — rebuild the current version, replace its setup executable, and force-move the existing tag to `HEAD` without deleting the GitHub release.
- `./scripts/release.sh --patch-plugin <zip> [tag]` — replace only one IntelliJ plugin asset. This mode is independent of building the AgentTerm installer.

These modes are no longer implemented on `main`. Use `npm run dist:win -- --x64` only for a local archaeological attempt; publish an installer only after the pipeline has deliberately been brought back under test.

## Files that formed the pipeline

- `package.json` — Electron Builder targets, packaged files, NSIS hook, portable settings, and npm scripts.
- `scripts/build-runtime.js` — generated runtime bundles.
- `scripts/build-launcher.js` — downloaded/resolved NSIS and compiled the root launcher.
- `build/launcher.nsi` — root/stable launcher implementation.
- `build/installer.nsh` — side-by-side install, atomic pointer publication, cleanup, and uninstall hooks.
- `src/relaunch.js` — installed and portable successor selection at runtime.
- `scripts/release.sh` — removed from `main`; retrieve the former versioning and installer publisher with `git show v0.1.15:scripts/release.sh`.
- `test/relaunch.test.js` — pure contract coverage for relaunch selection and the installer/launcher handshake.

These files may remain in the repository after installer retirement so the design is recoverable. Their presence does not make the installer supported.
