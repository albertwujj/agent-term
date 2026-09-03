// Windows taskbar: the button's Jump List offers "Start or resume session",
// the same as Ctrl+Shift+N. Windows starts a Jump List task's program with no
// environment of ours, while a from-source launch lives on the environment the
// WSL launcher set: source path, distro, start directory. So the running app
// writes that environment to a file next to the bootstrap, and the task hands
// the file to the bootstrap by argument. scripts/windows-dev-bootstrap.js reads
// it; the two files share the argument name by contract, checked by test.
const path = require('path');

const LAUNCH_ENV_ARG = '--agent-term-launch-env=';
const LAUNCH_ENV_FILE = 'launch-env.json';
const TASK_TITLE = 'Start or resume session (Ctrl+Shift+N)';

function launchEnvFile(appPath) {
  return path.join(appPath, LAUNCH_ENV_FILE);
}

// The variables a from-source Windows launch is made of.
function launchEnvSnapshot(env) {
  const out = {};
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENT_TERM_') || key === 'WSL_DISTRO_NAME') out[key] = env[key];
  }
  return out;
}

function writeLaunchEnv({ fs, file, env }) {
  fs.writeFileSync(file, JSON.stringify(launchEnvSnapshot(env), null, 2) + '\n');
}

function quote(arg) {
  return `"${arg}"`;
}

// The task for app.setUserTasks: the same executable and app path this
// instance runs, plus the environment file.
function taskbarTask({ execPath, appPath, file }) {
  return {
    program: execPath,
    arguments: `${quote(appPath)} ${LAUNCH_ENV_ARG}${quote(file)}`,
    title: TASK_TITLE,
    description: 'Open a new window on the session picker',
    iconPath: execPath,
    iconIndex: 0,
  };
}

module.exports = {
  LAUNCH_ENV_ARG,
  LAUNCH_ENV_FILE,
  TASK_TITLE,
  launchEnvFile,
  launchEnvSnapshot,
  writeLaunchEnv,
  taskbarTask,
};
