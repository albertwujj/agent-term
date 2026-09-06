// A start that cannot proceed shows a window saying why. The alternative is
// what this replaces: a log line and a process that exits without painting,
// which is the one failure in the app that sends you to the logs to find out
// anything at all. It is also the failure you hit most often, since it fires
// whenever an edit of your own does not compile.
//
// The page carries no script and loads no generated bundle, because the case
// it exists for is the bundles being absent: the build removes every artifact
// before compiling, so after a failure there is nothing to fall back to.
const BACKGROUND = '#0c0c0c';

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// `detail` is prose and `output` is verbatim tool text; a page may carry
// either. Running a compiler's message through prose styling loses the column
// alignment that makes it readable, and prose in a monospace box reads as a
// machine talking.
function startupErrorHtml({ heading, detail, output, command }) {
  const body = [
    detail ? `<p>${escapeHtml(detail)}</p>` : '',
    output ? `<pre>${escapeHtml(output)}</pre>` : '',
  ].filter(Boolean).join('\n  ');
  return `<!DOCTYPE html>
<meta charset="utf-8">
<title>AgentTerm cannot start</title>
<style>
  html, body { margin: 0; height: 100%; background: ${BACKGROUND}; }
  body { color: #d6d6d6; font: 13px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif; }
  .bar { background: #b3261e; color: #fff; font-weight: 600; padding: 10px 22px; }
  main { padding: 20px 22px; }
  p { margin: 0 0 14px; max-width: 62ch; }
  pre { margin: 0 0 16px; padding: 12px 14px; max-width: 62ch; overflow-x: auto;
        background: #161616; border-left: 3px solid #b3261e; border-radius: 3px;
        color: #e6b0aa; font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace;
        white-space: pre-wrap; }
  code { background: #161616; border-radius: 3px; padding: 2px 6px;
         color: #eaeaea; font: 12px ui-monospace, Menlo, Consolas, monospace; }
</style>
<div class="bar">${escapeHtml(heading)}</div>
<main>
  ${body}
  <p>Close this window, then run <code>${escapeHtml(command)}</code> in the checkout.</p>
</main>
`;
}

// Opens the page and quits once it is closed. `deps` takes the Electron pieces
// so the html builder above stays testable without an Electron process.
function showStartupError({ app, BrowserWindow }, { heading, detail, output, command }) {
  const html = startupErrorHtml({ heading, detail, output, command });
  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 760,
      height: 340,
      backgroundColor: BACKGROUND,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.setMenu?.(null);
    win.on('closed', () => app.quit());
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

module.exports = { startupErrorHtml, showStartupError };
