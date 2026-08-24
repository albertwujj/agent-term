param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [Parameter(Mandatory = $true)][string]$WslSourceRoot,
  [Parameter(Mandatory = $true)][string]$Distro
)

$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Get-RunnerKey([string]$Identity) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Identity)
    $hash = $sha.ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hash) -replace '-', '').Substring(0, 16).ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

$sourcePackage = Join-Path $SourceRoot 'package.json'
$sourceLock = Join-Path $SourceRoot 'package-lock.json'
$sourceBootstrap = Join-Path $SourceRoot 'scripts\windows-dev-bootstrap.js'
$sourcePostinstall = Join-Path $SourceRoot 'scripts\fix-pty-perms.js'
foreach ($required in @($sourcePackage, $sourceLock, $sourceBootstrap, $sourcePostinstall)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Required development file is missing: $required"
  }
}

$runnerKey = Get-RunnerKey "$Distro`n$SourceRoot"
$runnerRoot = Join-Path $env:LOCALAPPDATA "AgentTermWslDev\$runnerKey"
$runnerScripts = Join-Path $runnerRoot 'scripts'
$runnerPackage = Join-Path $runnerRoot 'package.json'
$runnerLock = Join-Path $runnerRoot 'package-lock.json'
$runnerBootstrap = Join-Path $runnerRoot 'bootstrap.js'
$installStamp = Join-Path $runnerRoot '.dependency-stamp'
New-Item -ItemType Directory -Force -Path $runnerScripts | Out-Null

# Keep the source dependency graph and version, but make the cache-resident
# bootstrap the Electron entry point. Its per-process source snapshot has this
# runner's Windows node_modules as an ancestor, so Linux and Windows native
# modules never share a directory.
$manifest = Get-Content -Raw -LiteralPath $sourcePackage | ConvertFrom-Json
$manifest.main = 'bootstrap.js'
Write-Utf8NoBom $runnerPackage ($manifest | ConvertTo-Json -Depth 100)
Copy-Item -Force -LiteralPath $sourceLock -Destination $runnerLock
Copy-Item -Force -LiteralPath $sourceBootstrap -Destination $runnerBootstrap
Copy-Item -Force -LiteralPath $sourcePostinstall -Destination (Join-Path $runnerScripts 'fix-pty-perms.js')

$packageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePackage).Hash
$lockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceLock).Hash
$wantedStamp = "$packageHash`n$lockHash"
$electronExe = Join-Path $runnerRoot 'node_modules\electron\dist\electron.exe'
$currentStamp = if (Test-Path -LiteralPath $installStamp) {
  Get-Content -Raw -LiteralPath $installStamp
} else {
  ''
}

if ($currentStamp -ne $wantedStamp -or -not (Test-Path -LiteralPath $electronExe)) {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  $npmPath = if ($npmCommand) { $npmCommand.Source } else { '' }
  if (-not $npmPath) {
    # A WSL session opened before Node was installed can carry an old Windows
    # PATH. The MSI's standard location still makes the first launch work
    # immediately, without asking the contributor to restart WSL.
    $standardNpm = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
    if (Test-Path -LiteralPath $standardNpm) {
      $npmPath = $standardNpm
    }
  }
  if (-not $npmPath) {
    throw 'Windows Node.js/npm is required. Install Windows Node.js, then run this WSL command again.'
  }

  Write-Host "Preparing isolated Windows Electron dependencies in $runnerRoot"
  Push-Location $runnerRoot
  try {
    & $npmPath ci
    if ($LASTEXITCODE -ne 0) { throw "Windows npm ci failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  Write-Utf8NoBom $installStamp $wantedStamp
}

if (-not (Test-Path -LiteralPath $electronExe)) {
  throw "Electron executable was not installed: $electronExe"
}

$env:AGENT_TERM_DEV_SOURCE_WIN = $SourceRoot
$env:AGENT_TERM_WSL_CWD = $WslSourceRoot
$env:AGENT_TERM_WSL_DISTRO = $Distro
# Existing file-URL paths use this standard name when choosing the UNC share.
$env:WSL_DISTRO_NAME = $Distro

Push-Location $runnerRoot
try {
  & $electronExe $runnerRoot
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
