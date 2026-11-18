const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { stampPath } = require('./dep-freshness');

if (app.isPackaged || process.platform !== 'darwin') {
  require('./main');
} else {
  const { loadSource } = require('./runtime-source');
  const sourceRoot = path.join(__dirname, '..');
  const stamp = stampPath(sourceRoot);
  const dependencyStamp = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '';
  loadSource({
    app,
    sourceRoot,
    runnerRoot: path.join(sourceRoot, 'dist', '.agent-term-runtime'),
    dependencyRoot: sourceRoot,
    dependencyStamp,
  }).catch((error) => {
    dialog.showErrorBox('AgentTerm source launch failed', error.stack || error.message);
    app.exit(1);
  });
}
