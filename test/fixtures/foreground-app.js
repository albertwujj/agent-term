// A plain app window for E2E tests to keep in front: the app a person works
// in while AgentTerm's windows hide and come back.
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 360, height: 240, title: 'Foreground app' });
  win.loadURL('data:text/html,<title>Foreground app</title><p>Another app in front</p>');
});
app.on('window-all-closed', () => app.quit());
