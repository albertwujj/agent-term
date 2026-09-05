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

// Arguments for AgentTerm's interactive WSL shell. Source launches carry npm's
// invocation directory explicitly so the app source and agent workspace remain
// independent.
function wslShellArgs(env = process.env) {
  const args = [];
  const distro = configuredWslDistro(env);
  const cwd = typeof env.AGENT_TERM_START_CWD === 'string'
    ? env.AGENT_TERM_START_CWD
    : '';
  if (distro) args.push('--distribution', distro);
  if (cwd) args.push('--cd', cwd);
  return args;
}

// Windows environment does not cross into WSL by default: WSLENV names the
// variables that do, colon-separated, each name optionally carrying
// path-translation flags after a slash. Off Windows there is no boundary and
// no key to set, so the result spreads into an env literal as nothing.
//
// `names` is derived from the variables actually being set, so the list cannot
// drift from them. Names already in the inherited value stay where they are
// rather than being appended again: a window launched from another window
// inherits a WSLENV that already lists ours, and a duplicate would be added on
// every nesting. An absent or empty inherited value contributes nothing, so
// the result never opens with a stray separator.
function wslenvForPty(platform, parentEnv = {}, names = []) {
  if (platform !== 'win32') return {};
  const entries = String((parentEnv && parentEnv.WSLENV) || '').split(':').filter(Boolean);
  const listed = new Set(entries.map(entry => entry.split('/')[0]));
  for (const name of names) {
    if (!name || listed.has(name)) continue;
    listed.add(name);
    entries.push(name);
  }
  return { WSLENV: entries.join(':') };
}

function bashLauncher(platform = process.platform, env = process.env) {
  return platform === 'win32'
    ? ['wsl', ...wslCommandArgs(['bash'], env)]
    : ['bash'];
}

module.exports = {
  bashLauncher,
  wslenvForPty,
  configuredWslDistro,
  wslCommandArgs,
  wslShellArgs,
};
