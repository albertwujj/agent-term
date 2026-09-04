const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pty', {
  platform: process.platform,
  start: (cols, rows) => ipcRenderer.send('pty-start', { cols, rows }),
  write: (data) => ipcRenderer.send('pty-input', data),
  // opts.toPrompt: paste the message into the CLI input and leave it there
  // (no Enter) for the user to finish typing; main then emits 'to-prompt'.
  submitInlineComment: (body, opts) => ipcRenderer.invoke('submit-inline-comment', body, opts),
  // One md comment batch → sidecar threads + pointer paste (md viewer; see
  // ~/agent-threads/md/user-intent.md).
  mdAddThreads: (payload) => ipcRenderer.invoke('md-add-threads', payload),
  // Preflight the send: resolve the runbook, or ask to send anyway if missing.
  mdRunbookPreflight: (payload) => ipcRenderer.invoke('md-runbook-preflight', payload),
  // Thread layer: read the sidecar store; follow-up reply (reopens + points).
  // No resolve on this surface — collapse is derived from the turn clock.
  mdReadThreads: (payload) => ipcRenderer.invoke('md-read-threads', payload),
  mdAddMessage: (payload) => ipcRenderer.invoke('md-add-message', payload),
  // Handoff write: the edited document, atomically (editing core).
  mdWriteFile: (payload) => ipcRenderer.invoke('md-write-file', payload),
  resize: (cols, rows) => ipcRenderer.send('pty-resize', { cols, rows }),
  onData: (callback) => ipcRenderer.on('pty-output', (event, data) => callback(data)),
  // A comment batch was handed to the prompt unsubmitted (any surface): roll
  // the viewers up and focus the terminal, the user types there next.
  onToPrompt: (callback) => ipcRenderer.on('to-prompt', () => callback()),
  onExit: (callback) => ipcRenderer.on('pty-exit', (event, code) => callback(code)),
  onResize: (callback) => ipcRenderer.on('resize', (event, size) => callback(size)),
  // Navigate to file:line in PyCharm via the navigator plugin
  navigateToFile: (filePath, line, column, matchText) => ipcRenderer.invoke('navigate-to-file', { filePath, line, column, matchText }),
  // Navigate to symbol in PyCharm via the navigator plugin
  navigateToSymbol: (symbolName, fileHint) => ipcRenderer.invoke('navigate-to-symbol', { symbolName, fileHint }),
  // Save clipboard image to temp file, return path (null if no image)
  saveClipboardImage: () => ipcRenderer.invoke('save-clipboard-image'),
  // Get current visible IDE caret position (file + line) from the frontend plugin
  getCaretPosition: () => ipcRenderer.invoke('get-caret-position'),
  // Get detailed frontend caret diagnostics from the IDE client plugin
  getCaretDiagnostics: () => ipcRenderer.invoke('get-caret-diagnostics'),
  // Listen for caret insertion trigger from main process (Ctrl+K/Cmd+K)
  onInsertCaretPosition: (callback) => ipcRenderer.on('insert-caret-position', () => callback()),
  onShowCaretDiagnostics: (callback) => ipcRenderer.on('show-caret-diagnostics', () => callback()),
  // Open the most recent viewer candidate from the terminal scrollback. No chord
  // sends this any more; the e2e harness drives it to put a viewer on screen.
  onOpenRecentViewerUrl: (callback) => ipcRenderer.on('open-recent-viewer-url', () => callback()),
  // Viewer chords: selector (Cmd/Ctrl+Shift+U) / shrink (...+I) / expand (...+O).
  onViewerShortcut: (callback) => ipcRenderer.on('viewer-shortcut', (_event, action) => callback(action)),
  // Cmd/Ctrl+Shift+N: the fresh instance is a separate process that takes
  // seconds to show a window, so main announces the launch and any failure.
  onNewInstanceLaunching: (callback) => ipcRenderer.on('new-instance-launching', (_event, cwd) => callback(cwd)),
  onNewInstanceLaunchFailed: (callback) => ipcRenderer.on('new-instance-launch-failed', (_event, message) => callback(message)),
  // Open a URL in the default browser
  openURL: (url) => ipcRenderer.invoke('open-url', url),
  // Open a resource file with the OS default handler
  openResource: (path) => ipcRenderer.invoke('open-resource', path),
  // Alt-click: resolve a path across cwd + home, returning all candidates
  resolvePathChoices: (path) => ipcRenderer.invoke('resolve-path-choices', path),
  // Read a markdown file for the rendered inline viewer
  readMarkdownFile: (path) => ipcRenderer.invoke('read-markdown-file', path),
  statMarkdownFile: (path, imagePaths) => ipcRenderer.invoke('stat-markdown-file', path, imagePaths),
  // Same-named markdown files under cwd → { path } | { choices } | null, so a
  // plain click on an ambiguous name (README.md) can offer a picker.
  resolveMarkdownChoices: (path) => ipcRenderer.invoke('resolve-markdown-choices', path),
  // Read a review page's comment store (file:// URL of the -comments.json)
  readReviewComments: (fileUrl) => ipcRenderer.invoke('read-review-comments', fileUrl),
  // Resolve a clicked file path (e.g. .html) to a file:// URL for the viewer
  resolveFileUrl: (path) => ipcRenderer.invoke('resolve-file-url', path),
  // Render an agent-authored review package (review:// launch) → { ok, htmlPath, issues }.
  renderReviewPackage: (packagePath) => ipcRenderer.invoke('render-review-package', packagePath),
  // Cheap existence check (no state change) for auto-open of a freshly-printed review:// link.
  reviewPackageExists: (packagePath) => ipcRenderer.invoke('review-package-exists', packagePath),
  // Same, for file:// viewer candidates (the recents list skips links whose file isn't on disk).
  viewerFileExists: (filePath) => ipcRenderer.invoke('viewer-file-exists', filePath),
  // Main re-rendered the open review (package or source changed) → reload the viewer.
  onReviewRerendered: (cb) => ipcRenderer.on('review-rerendered', (e, payload) => cb(payload)),
  onReviewCommentsChanged: (cb) => ipcRenderer.on('review-comments-changed', () => cb()),
  onStallReminder: (cb) => ipcRenderer.on('stall-reminder', (_event, payload) => cb(payload)),
  // Viewer closed → main stops the review auto-refresh poll/watch.
  reviewViewerClosed: () => ipcRenderer.send('review-viewer-closed'),
  // A review:// was captured → record the reviewed repo's branch in the
  // session log (picker search). Returns { ok, repo, branch }.
  captureReviewBranch: (reviewUrl) => ipcRenderer.invoke('capture-review-branch', reviewUrl),
  // file:// URLs for the minimal generic-page and full AgentTerm-review
  // preloads. The web viewer selects one before creating its guest.
  getWebviewPreloadUrls: () => ipcRenderer.invoke('get-webview-preload-urls'),
  // Set the window title (from terminal OSC sequences)
  setTitle: (title) => ipcRenderer.send('set-title', title),
  // Listen for logs from main process
  onMainLog: (callback) => ipcRenderer.on('main-log', (event, msg) => callback(msg)),
  // Low-volume renderer diagnostics are persisted by main, whose log survives
  // a renderer hang/reload. Callers send only state/timing metadata, never
  // terminal contents or typed keys.
  reportDiagnostic: (message) => ipcRenderer.send('renderer-diagnostic', message),
  // Asks main to force a repaint. Only the paint watchdog calls this, and only
  // after frames have measurably stopped arriving for a visible window.
  requestRepaint: () => ipcRenderer.send('renderer-request-repaint'),
  // Get real filesystem path from a dropped File object (Electron 33+ removed file.path)
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // ---- Sessions picker ----
  // Main fires this once on startup with the current sessions snapshot.
  onShowPicker: (callback) => ipcRenderer.on('show-picker', (event, payload) => callback(payload)),
  // User picked a past session from the picker → main kicks the resume runner.
  pickerPick: (id) => ipcRenderer.send('picker-pick', id),
  // User chose to start a new session with the named CLI (or null/empty for shell).
  pickerStartNew: (cli) => ipcRenderer.send('picker-start-new', cli),
  // User dismissed the picker without acting (Esc / clicked outside / chose "fresh shell").
  pickerClose: () => ipcRenderer.send('picker-close'),
  // User clicked a hidden active session row in the picker → bring it back
  // to the taskbar (un-skip + focus). The originating window picks up the
  // show signal via cap-control file watcher.
  pickerBringForward: (id) => ipcRenderer.send('picker-bring-forward', id),
  // Async saved-prompt deep search used by the picker. Searches user prompts
  // only, not terminal output.
  startHiddenPromptSearch: (payload) => ipcRenderer.send('hidden-search-start', payload),
  cancelHiddenPromptSearch: (requestId) => ipcRenderer.send('hidden-search-cancel', { requestId }),
  onHiddenPromptSearchProgress: (callback) => ipcRenderer.on('hidden-search-progress', (event, payload) => callback(payload)),
  // Viewer selector's on-disk search: same start/cancel/progress shape.
  startViewerDiskSearch: (payload) => ipcRenderer.send('viewer-disk-search-start', payload),
  cancelViewerDiskSearch: (requestId) => ipcRenderer.send('viewer-disk-search-cancel', { requestId }),
  onViewerDiskSearchProgress: (callback) => ipcRenderer.on('viewer-disk-search-progress', (event, payload) => callback(payload)),
  // Custom chrome bar (replaces session banner + app menu). main pushes
  // {hue, cli, prompt, isWorking} whenever any of those change.
  onChromeState: (callback) => ipcRenderer.on('chrome-state', (event, payload) => callback(payload)),
  // Right-click on the chrome bar -> copy the full captured prompt.
  chromeBarContextMenu: () => ipcRenderer.send('chrome-bar-contextmenu'),
  // User dismissed the resume hint (clicked ✕). Main clears the
  // pendingResumeIntercept flag so the next Enter goes through to the CLI
  // as a normal keystroke instead of being replaced with /resume.
  cancelResumeIntercept: () => ipcRenderer.send('cancel-resume-intercept'),
  // Main observed a real submit sent to the AI CLI after picker resume.
  // Renderer uses this to age out the resume hint; picker navigation itself
  // never sends this event.
  onResumeHintSubmit: (callback) => ipcRenderer.on('resume-hint-submit', () => callback()),
  // Main cancelled the resume intercept on non-Enter input (a startup
  // dialog answered, or the user typing their own command). The next Enter
  // is plain; the hint switches to its manual /resume wording.
  onResumeHintInterceptOff: (callback) => ipcRenderer.on('resume-hint-intercept-off', () => callback()),
  // ---- Streaming (see src/stream/, ../agent-stream-hub/stream.md) ----
  // Renderer-side buffer watcher pushes periodic snapshots of the active
  // xterm buffer to main, which forwards them to the hub as block updates.
  streamBufferUpdate: (payload) => ipcRenderer.send('stream:buffer-update', payload),
  // Renderer detected an alt-screen entry/exit. Payload includes encoded
  // rows for BOTH the previous and new buffers so main can seal the
  // current block and open a new one in one IPC round-trip.
  streamBufferFlip: (payload) => ipcRenderer.send('stream:buffer-flip', payload),
  // Main pushes connection-state changes; renderer renders the status dot
  // and any toasts. Payload: { state, lastError, lastSuccessAt }.
  onStreamStatus: (callback) => ipcRenderer.on('stream:status', (event, payload) => callback(payload)),
});
