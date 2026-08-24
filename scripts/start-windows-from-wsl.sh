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

exec powershell.exe \
  -NoLogo \
  -NoProfile \
  -NonInteractive \
  -ExecutionPolicy Bypass \
  -File "$powershell_script" \
  -SourceRoot "$windows_source" \
  -WslSourceRoot "$repo_root" \
  -Distro "$WSL_DISTRO_NAME"
