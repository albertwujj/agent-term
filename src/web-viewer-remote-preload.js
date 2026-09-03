// Minimal preload for ordinary remote/local pages hosted by AgentTerm's web
// viewer. AgentTerm review pages use web-viewer-preload.js instead.

const { ipcRenderer } = require('electron');
const { installWebViewerPreloadCommon } = require('./web-viewer-preload-common');

installWebViewerPreloadCommon({ ipcRenderer, platform: process.platform });
