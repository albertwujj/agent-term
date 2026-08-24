#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${WSL_DISTRO_NAME:-}" ]]; then
  echo 'This launcher must run inside WSL (WSL_DISTRO_NAME is not set).' >&2
  exit 1
fi
if ! command -v wslpath >/dev/null 2>&1; then
  echo 'wslpath is required to expose the checkout to Windows Electron.' >&2
  exit 1
fi
if ! command -v powershell.exe >/dev/null 2>&1; then
  echo 'Windows interop is unavailable: powershell.exe was not found from WSL.' >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
powershell_script="$(wslpath -w "$script_dir/start-windows-from-wsl.ps1" | tr -d '\r')"
windows_source="$(wslpath -w "$repo_root" | tr -d '\r')"

# Machine policy can require UNC-hosted .ps1 files to be signed even when the
# process requests ExecutionPolicy Bypass. Carry the arguments through WSLENV
# and compile the same source as an in-process script block instead.
export AGENT_TERM_LAUNCHER_PS_WIN="$powershell_script"
export AGENT_TERM_SOURCE_WIN="$windows_source"
export AGENT_TERM_SOURCE_WSL="$repo_root"
export AGENT_TERM_DISTRO="$WSL_DISTRO_NAME"
interop_vars='AGENT_TERM_LAUNCHER_PS_WIN:AGENT_TERM_SOURCE_WIN:AGENT_TERM_SOURCE_WSL:AGENT_TERM_DISTRO'
export WSLENV="${WSLENV:+$WSLENV:}$interop_vars"

exec powershell.exe \
  -NoLogo \
  -NoProfile \
  -NonInteractive \
  -ExecutionPolicy Bypass \
  -Command '
    $launcherSource = Get-Content -Raw -LiteralPath $env:AGENT_TERM_LAUNCHER_PS_WIN
    $launcher = [ScriptBlock]::Create($launcherSource)
    & $launcher `
      -SourceRoot $env:AGENT_TERM_SOURCE_WIN `
      -WslSourceRoot $env:AGENT_TERM_SOURCE_WSL `
      -Distro $env:AGENT_TERM_DISTRO
  '
