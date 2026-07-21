// Stream client configuration.
//
// Three sources, highest precedence wins:
//   1. Env var (AGENT_STREAM_HUB_URL / STREAM_HUB_SECRET) — ad-hoc override,
//      survives only the current process.
//   2. User config file at ~/.agent-term/config.json — persistent across
//      binary upgrades (lives in $HOME, not in the app bundle). Schema:
//        { "hubUrl": "https://...", "hubSecret": "..." }
//      Either key is optional; missing keys fall through.
//   3. Hardcoded fallback — last resort. Updated when we cut a release
//      that knows the current tunnel URL.
//
// The cloudflared tunnel and hub setup live in ../agent-stream-hub/SETUP.md.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Default = empty (= streaming disabled). To enable, set hubUrl in
// ~/.agent-term/config.json or the AGENT_STREAM_HUB_URL env var. The
// PowerShell one-liner in the README writes the config file on Windows.
const HARDCODED_URL = '';
const USER_CONFIG_PATH = path.join(os.homedir(), '.agent-term', 'config.json');

function readUserConfig() {
  try {
    let raw = fs.readFileSync(USER_CONFIG_PATH, 'utf8');
    // Strip UTF-8 BOM — Notepad on Windows saves JSON with one by
    // default, and JSON.parse chokes on the leading ﻿.
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

const userConfig = readUserConfig();

const STREAM_HUB_URL = (
  process.env.AGENT_STREAM_HUB_URL ||
  (typeof userConfig.hubUrl === 'string' && userConfig.hubUrl) ||
  HARDCODED_URL
).replace(/\/+$/, '');

// Shared secret sent as X-Hub-Secret on every request. Hub gates
// tunneled /runs* requests on it; if unset here, requests omit the
// header (works only if the hub also runs without STREAM_HUB_SECRET set).
const STREAM_HUB_SECRET = (
  process.env.STREAM_HUB_SECRET ||
  (typeof userConfig.hubSecret === 'string' && userConfig.hubSecret) ||
  null
);

// All time values in ms.
// Heartbeats are reactive: HEARTBEAT_IDLE_MS while the agent is working
// (input not expected), HEARTBEAT_AWAITING_MS while idle (your_turn) so
// viewer-submitted inputs land with bounded latency.
const HEARTBEAT_IDLE_MS = 30 * 1000;
const HEARTBEAT_AWAITING_MS = 2 * 1000;
// A viewer poll within this window keeps the heartbeat at top pace even
// while isWorking — someone watching may interject any moment. Long
// enough that a brief phone-lock/app-switch doesn't demote; short enough
// that an abandoned tab doesn't pin fast heartbeats for hours.
const VIEWER_ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = HEARTBEAT_IDLE_MS;       // legacy alias; preserved for any external reader
const POST_TIMEOUT_MS = 5 * 1000;      // single-request timeout — bounded so a dead tunnel can't pile up
const RETRY_QUEUE_CAP = 50;            // pending POSTs held while disconnected
const FAIL_THRESHOLD = 3;              // consecutive failures before flipping to "disconnected"
const RETRY_BACKOFF_MIN_MS = 1000;     // first retry after this much idle
const RETRY_BACKOFF_MAX_MS = 30 * 1000;
const BUFFER_POLL_MS = 500;            // renderer-side buffer-state poll interval

module.exports = {
  STREAM_HUB_URL,
  STREAM_HUB_SECRET,
  HEARTBEAT_MS,
  HEARTBEAT_IDLE_MS,
  HEARTBEAT_AWAITING_MS,
  VIEWER_ACTIVE_WINDOW_MS,
  POST_TIMEOUT_MS,
  RETRY_QUEUE_CAP,
  FAIL_THRESHOLD,
  RETRY_BACKOFF_MIN_MS,
  RETRY_BACKOFF_MAX_MS,
  BUFFER_POLL_MS,
};
