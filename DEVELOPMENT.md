# Develop AgentTerm from source

AgentTerm runs directly from its source checkout; no installer or application package is needed. The Electron UI must run on the host operating system. On Windows, the shell and the coding agents still run inside WSL.

The former Windows installer pipeline is frozen and no longer tested. Its last-known design and build procedure are preserved only as historical reference in [WINDOWS_INSTALLER.md](WINDOWS_INSTALLER.md).

## Platform differences

| | macOS | Windows |
|---|---|---|
| Electron UI | Native macOS process | Native Windows process launched from WSL |
| Terminal shell | Your native shell | The invoking WSL distro |
| Recommended checkout | Native macOS filesystem | Native WSL filesystem, such as `~/src/agent-term` |
| Dependencies | One macOS `node_modules` | Linux `node_modules` for builds/tests, plus an isolated Windows cache for the UI |
| Start command | `npm run start` | `npm run start:wsl` |
| UI end-to-end tests | Native desktop | WSLg |

Windows gets taskbar buttons and live DWM previews for active sessions. On macOS, each session works best in its own full-screen space, where Mission Control shows the initial prompt pinned at the top of each window.

## macOS

Install the current Node.js LTS release, then:

```bash
git clone https://github.com/albertwujj/agent-term
cd agent-term
npm ci
npm run start
```

That is the only command needed to launch from source. `Cmd+Shift+N` opens another AgentTerm window, and closing the last window starts a fresh one. Type `exit` in the shell to quit for good.

## Windows with WSL

### Prerequisites

You need Node.js in two places for two different jobs:

- **WSL Node.js** runs builds and tests. Install the current LTS release inside your distro using your preferred Linux Node version manager or package source.
- **Windows Node.js** installs and hosts the native Windows Electron process. It never installs dependencies into the WSL checkout.

If WSL itself is not installed, open Windows PowerShell and run `wsl --install` first. Then install Windows Node.js from the same PowerShell—not from a WSL prompt:

```powershell
winget install --id OpenJS.NodeJS.LTS --source winget
node.exe --version
npm.cmd --version
```

If WinGet is unavailable, use the LTS installer from [nodejs.org](https://nodejs.org/en/download).

### Get the source and start

Clone into WSL's native filesystem and run every project command from WSL:

```bash
git clone https://github.com/albertwujj/agent-term
cd agent-term
npm ci
npm run start:wsl
```

`start:wsl` invokes Windows PowerShell for the host-side seam. On its first run it creates an isolated Windows dependency cache under `%LOCALAPPDATA%\AgentTermWslDev`, takes a per-process snapshot of the current source, and launches Windows Electron from that snapshot. It neither reads nor modifies WSL's Linux `node_modules`. The terminal opens in the original checkout, and all later WSL probes stay pinned to the distro that launched it.

Do not use `npm run start` from WSL for the Windows app. That starts Linux Electron through WSLg, so AgentTerm sees Linux rather than Windows and cannot provide its Windows taskbar integration.

## Daily development

Edit in the source checkout, then press `Ctrl/Cmd+Shift+R` in AgentTerm to take a fresh source snapshot, rebuild, and relaunch. If `package.json` or `package-lock.json` changes, stop the app and run the platform's start command again so its dependency tree is refreshed.

Run builds and tests from the source checkout:

```bash
npm run build
npm run test:all
npm run test:e2e
```

On Windows these commands use WSL Node.js. The end-to-end suite launches Linux Electron and therefore requires WSLg; the non-E2E suite does not.

## Windows troubleshooting

- **“Windows Node.js/npm is required”**: run `node.exe --version` and `npm.cmd --version` in Windows PowerShell. Reinstall the LTS package if either command is missing.
- **“powershell.exe was not found from WSL”**: Windows interoperability is disabled or unavailable in that distro. Re-enable WSL interoperability before launching AgentTerm.
- **The wrong distro opens**: always run `npm run start:wsl` from the distro you want AgentTerm to use. The launcher carries that distro name into the Windows process.
