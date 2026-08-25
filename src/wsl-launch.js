function cleanSetting(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function configuredWslDistro(env = process.env) {
  return cleanSetting(env.AGENT_TERM_WSL_DISTRO);
}

// Prefix a non-interactive command with the distro selected by the WSL-side
// development launcher. Installed builds leave the setting empty and retain
// wsl.exe's normal default-distro behavior.
function wslCommandArgs(args, env = process.env) {
  const command = Array.isArray(args) ? args.slice() : [];
  const distro = configuredWslDistro(env);
  return distro
    ? ['--distribution', distro, '--exec', ...command]
    : command;
}

// Arguments for AgentTerm's interactive WSL shell. By default, development
// launches only pin the distro and inherit the Windows working directory,
// matching installed builds and letting shell startup files choose a workspace.
function wslShellArgs(env = process.env) {
  const args = [];
  const distro = configuredWslDistro(env);
  const cwd = cleanSetting(env.AGENT_TERM_WSL_CWD);
  if (distro) args.push('--distribution', distro);
  if (cwd) args.push('--cd', cwd);
  return args;
}

function bashLauncher(platform = process.platform, env = process.env) {
  return platform === 'win32'
    ? ['wsl', ...wslCommandArgs(['bash'], env)]
    : ['bash'];
}

module.exports = {
  bashLauncher,
  configuredWslDistro,
  wslCommandArgs,
  wslShellArgs,
};
