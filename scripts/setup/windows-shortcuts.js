#!/usr/bin/env node
// Windows only. Run it from inside WSL; it refuses to run anywhere else.
// There is no macOS equivalent.
//
// Installs this checkout as a Windows app: a Start menu shortcut, a Startup
// shortcut that launches it at logon, and an entry under Settings > Apps.
// The window opens in the directory given with --dir.
//
// The shortcut runs a small launcher under %LOCALAPPDATA%\Programs\AgentTerm
// that starts WSL hidden and runs this checkout's `npm run start` there, with
// the Node that runs this script pinned first on PATH. `wsl.exe` goes through
// `cmd.exe` because it does not start when launched hidden on its own.
// Uninstalling from Settings > Apps removes the shortcuts and that launcher,
// and leaves the checkout, the app's data, and the dev cache alone.
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAME = 'AgentTerm';
const repoRoot = path.resolve(__dirname, '..', '..');
const USAGE = `Usage: node ${path.relative(repoRoot, __filename)} --dir <path>

  --dir <path>   directory the window opens in`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function windowsPath(unixPath) {
  const converted = spawnSync('wslpath', ['-w', unixPath], { encoding: 'utf8' });
  if (converted.status !== 0) fail(`wslpath could not convert ${unixPath}: ${converted.stderr.trim()}`);
  return converted.stdout.trim();
}

// PowerShell runs on Windows, so the script reaches it base64-encoded: quoting
// a script full of paths across the WSL boundary is not reliable.
function powershell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8' });
  if (result.status !== 0) fail(result.stderr.trim() || `PowerShell exited ${result.status}.`);
  return result.stdout;
}

function escapePs(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseArgs(argv) {
  const args = { dir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') args.dir = argv[++i];
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
    else fail(`Unknown argument: ${arg}\n${USAGE}`);
  }
  if (!args.dir) fail(`No directory given.\n${USAGE}`);
  return args;
}

function install(dir) {
  const resolved = path.resolve(dir);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) fail(`Not a directory: ${resolved}`);
  // The Node the checkout was installed with, not the one running this script:
// an agent session can run the script under its own bundled Node, which
// disappears with the session. nvm is initialized in .bashrc, and bash skips
// .bashrc for the non-interactive shell the shortcut starts, so load nvm
// explicitly and ask it for the default version.
const nodeOnPath = spawnSync('env', ['-i', 'HOME=' + os.homedir(), 'USER=' + os.userInfo().username,
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'bash', '-c', [
  'export NVM_DIR="$HOME/.nvm"',
  '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
  'command -v node',
].join('\n')], { encoding: 'utf8' });
if (nodeOnPath.status !== 0 || !nodeOnPath.stdout.trim()) {
  fail('No node found. Install Node, then run this again.');
}
const nodeBin = path.dirname(nodeOnPath.stdout.trim());
  const envDir = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("LocalApplicationData")'],
    { encoding: 'utf8' });
  if (envDir.status !== 0) fail('Could not ask Windows for LOCALAPPDATA. Is powershell.exe reachable from WSL?');
  const programDir = path.win32.join(envDir.stdout.trim(), 'Programs', NAME);
  const programDirUnix = spawnSync('wslpath', ['-u', programDir], { encoding: 'utf8' }).stdout.trim();

  const launcher = [
    '#!/usr/bin/env bash',
    '# Created by scripts/setup/windows-shortcuts.js. Re-run that script to update it.',
    '# A non-interactive shell does not load nvm, so the Node that installed the',
    '# shortcuts goes first on PATH. The inherited PATH stays: it carries the',
    '# Windows directories the launcher needs, powershell.exe among them.',
    `export PATH=${nodeBin}:$PATH`,
    `cd ${resolved} || exit 1`,
    `exec npm --prefix ${repoRoot} run start`,
    '',
  ].join('\n');
  const launcherUnix = path.join(os.homedir(), '.local', 'bin', 'agentterm-start.sh');
  fs.mkdirSync(path.dirname(launcherUnix), { recursive: true });
  fs.writeFileSync(launcherUnix, launcher, { mode: 0o755 });

  const rendered = renderIcon();
  fs.mkdirSync(programDirUnix, { recursive: true });
  fs.copyFileSync(rendered, path.join(programDirUnix, `${NAME}.ico`));

  const vbs = [
    "' Created by scripts/setup/windows-shortcuts.js. Starts AgentTerm with no",
    "' console window. wsl.exe needs its output redirected to run hidden, so it",
    "' goes through cmd.exe.",
    `CreateObject("WScript.Shell").Run "cmd.exe /c wsl.exe -d ${process.env.WSL_DISTRO_NAME} -- ${launcherUnix} >nul 2>&1", 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(programDirUnix, `${NAME}.vbs`), vbs);

  const uninstallPs1 = [
    '# Removes the AgentTerm shortcuts and Apps entry. It does not touch the',
    '# checkout, the app\'s data, or the dev cache.',
    '$dir = Split-Path -Parent $MyInvocation.MyCommand.Path',
    `Remove-Item -LiteralPath "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\${NAME}.lnk" -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\${NAME}.lnk" -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NAME}Shortcuts' -Recurse -Force -ErrorAction SilentlyContinue`,
    `& wsl.exe -d ${process.env.WSL_DISTRO_NAME} -- rm -f ${launcherUnix} 2>$null`,
    'Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList \'/c\', "timeout /t 3 /nobreak >nul & rmdir /s /q `"$dir`""',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(programDirUnix, 'Uninstall.ps1'), uninstallPs1);

  const ps = `
$ErrorActionPreference = 'Stop'
$dir = ${escapePs(programDir)}
$ws = New-Object -ComObject WScript.Shell
foreach ($lnk in @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\${NAME}.lnk",
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\${NAME}.lnk")) {
  $s = $ws.CreateShortcut($lnk)
  $s.TargetPath = "$env:WINDIR\\System32\\wscript.exe"
  $s.Arguments = "//B //Nologo \`"$dir\\${NAME}.vbs\`""
  $s.WorkingDirectory = $dir
  $s.IconLocation = "$dir\\${NAME}.ico,0"
  $s.Description = 'Terminal workspace for coding agents'
  $s.WindowStyle = 7
  $s.Save()
}
$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NAME}Shortcuts'
New-Item -Path $k -Force | Out-Null
Set-ItemProperty $k DisplayName '${NAME}'
Set-ItemProperty $k DisplayIcon "$dir\\${NAME}.ico"
Set-ItemProperty $k InstallLocation $dir
Set-ItemProperty $k Publisher 'AgentTerm'
Set-ItemProperty $k UninstallString "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$dir\\Uninstall.ps1\`""
Set-ItemProperty $k NoModify 1 -Type DWord
Set-ItemProperty $k NoRepair 1 -Type DWord
Write-Output 'installed'
`;
  powershell(ps);
  console.log(`Installed ${NAME}.`);
  console.log(`  Start menu and Startup shortcuts, plus an entry in Settings > Apps.`);
  console.log(`  The window opens in ${resolved}.`);
}

// Pillow rasterizes the SVG's geometry at 8x and scales down, which keeps the
// strokes smooth at the small sizes Windows asks an .ico for. The geometry
// mirrors scripts/setup/icon.svg: the phone app's glyph at 80%, centered, on
// white. The comment there says where it comes from.
function renderIcon() {
  const out = path.join(os.tmpdir(), `${NAME}-${process.pid}.ico`);
  // The path rides as an argument, not inside the program text.
  const rendered = spawnSync('python3', ['-c', `
import sys
try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit(2)
S = 1440
im = Image.new('RGBA', (S, S), '#ffffff')
tile = Image.new('RGBA', (S, S), '#0c0c0c')
d = ImageDraw.Draw(tile)
k = S / 180
pts = [(54*k, 62*k), (88*k, 90*k), (54*k, 118*k)]
w = 11*k
d.line(pts, fill='#61d6d6', width=round(w), joint='curve')
for x, y in pts:
    r = w/2
    d.ellipse((x-r, y-r, x+r, y+r), fill='#61d6d6')
d.rounded_rectangle((100*k, 106*k, 138*k, 118*k), radius=2*k, fill='#a3d977')
tile = tile.resize((round(S*0.8), round(S*0.8)), Image.LANCZOS)
im.paste(tile, (round(S*0.1), round(S*0.1)))
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
im.save(sys.argv[1], format='ICO', sizes=[(s, s) for s in sizes])
`, out]);
  if (rendered.status === 2 || (rendered.status !== 0 && /No module named ['"]PIL['"]/.test(`${rendered.stderr}`))) {
    fail('Rendering the icon needs Pillow. Install it with: pip install pillow');
  }
  if (rendered.status !== 0) fail(`Could not render the icon:\n${rendered.stderr.trim()}`);
  return out;
}

function main() {
  if (process.platform === 'win32') fail('Run this from WSL, in the distro AgentTerm should use.');
  if (!process.env.WSL_DISTRO_NAME) fail('This script must run inside WSL (WSL_DISTRO_NAME is not set).');
  const args = parseArgs(process.argv.slice(2));
  install(args.dir);
}

main();
