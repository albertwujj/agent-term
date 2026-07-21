// Renderer-side connection status indicator.
//
// Two pieces:
//   · A small fixed dot at the bottom-right corner of the window, color
//     reflecting the stream state. Hidden when idle.
//   · Transient toasts on transitions into `disconnected` and on recovery.
//
// Receives state updates from main via window.pty.onStreamStatus({ state,
// lastError, lastSuccessAt }). Separated from chrome-bar.js to keep
// concerns decoupled and to work on macOS (where chrome-bar's titlebar
// overlay path differs from Windows).

const COLORS = {
  idle: null,                                   // hidden
  connecting: '#c19c00',                         // yellow — handshake in flight
  connected: '#a3d977',                          // green — recent success
  retrying: '#c19c00',                           // yellow — transient
  disconnected: '#e74856',                       // red — sustained failure
  disabled: 'outline',                           // hollow grey — not configured
};

const CSS = `
.at-stream-dot {
  position: fixed;
  bottom: 8px;
  right: 8px;
  width: 8px; height: 8px;
  border-radius: 50%;
  z-index: 10000;
  pointer-events: auto;
  cursor: default;
  opacity: 0.7;
  transition: background-color 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
}
.at-stream-dot.disconnected {
  box-shadow: 0 0 6px rgba(231, 72, 86, 0.7);
  opacity: 1;
}
.at-stream-dot.disabled {
  background: transparent !important;
  border: 1px solid #6a6a6a;
  width: 8px; height: 8px;
  box-sizing: border-box;
  opacity: 0.55;
}
.at-stream-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 10001;
  background: #1c1c1c;
  color: #e6e6e6;
  font: 13px/1.4 -apple-system, system-ui, sans-serif;
  padding: 8px 12px;
  border-radius: 4px;
  border: 1px solid #3c3c3c;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  max-width: 360px;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.2s ease, transform 0.2s ease;
  pointer-events: none;
}
.at-stream-toast.show {
  opacity: 1;
  transform: translateY(0);
}
.at-stream-toast .at-stream-toast-title {
  font-weight: 600;
  margin-bottom: 2px;
}
.at-stream-toast.error .at-stream-toast-title { color: #e74856; }
.at-stream-toast.ok    .at-stream-toast-title { color: #a3d977; }
`;

let mounted = null;
let lastState = 'idle';
let lastPayload = { state: 'idle', lastError: null, lastSuccessAt: null };
let toastTimer = null;

function injectStyles() {
  if (document.getElementById('at-stream-style')) return;
  const style = document.createElement('style');
  style.id = 'at-stream-style';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function tooltipText() {
  if (lastPayload.state === 'disabled') {
    return 'Streaming disabled.\nTo enable, set hubUrl in ~/.agent-term/config.json.';
  }
  const parts = [`stream: ${lastPayload.state}`];
  if (lastPayload.lastError) parts.push(`last error: ${lastPayload.lastError}`);
  if (lastPayload.lastSuccessAt) {
    const ago = Math.round((Date.now() - lastPayload.lastSuccessAt) / 1000);
    parts.push(`last success: ${ago}s ago`);
  }
  return parts.join('\n');
}

function ensureMounted() {
  if (mounted) return;
  injectStyles();
  mounted = document.createElement('div');
  mounted.className = 'at-stream-dot';
  mounted.style.display = 'none';
  document.body.appendChild(mounted);
}

function showToast({ title, message, kind, durationMs }) {
  injectStyles();
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  const old = document.querySelector('.at-stream-toast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = `at-stream-toast ${kind || ''}`;
  el.innerHTML = `<div class="at-stream-toast-title"></div><div class="at-stream-toast-body"></div>`;
  el.querySelector('.at-stream-toast-title').textContent = title || '';
  el.querySelector('.at-stream-toast-body').textContent = message || '';
  document.body.appendChild(el);
  // Two-step to trigger CSS transition.
  requestAnimationFrame(() => el.classList.add('show'));
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, durationMs || 4000);
}

function update(payload) {
  lastPayload = payload || lastPayload;
  const state = lastPayload.state || 'idle';
  ensureMounted();
  const color = COLORS[state];
  if (!color) {
    mounted.style.display = 'none';
  } else {
    mounted.style.display = '';
    // 'outline' is a sentinel for the disabled state — CSS .disabled
    // class handles the styling; background-color is cleared.
    if (color === 'outline') {
      mounted.style.background = '';
    } else {
      mounted.style.background = color;
    }
    mounted.classList.toggle('disconnected', state === 'disconnected');
    mounted.classList.toggle('disabled', state === 'disabled');
  }
  mounted.title = tooltipText();

  // Toast only on transitions into/out of disconnected.
  if (state === 'disconnected' && lastState !== 'disconnected') {
    showToast({
      title: 'Stream disconnected',
      message: lastPayload.lastError || 'unable to reach agent-stream-hub',
      kind: 'error',
      durationMs: 5000,
    });
  } else if (state === 'connected' && lastState === 'disconnected') {
    showToast({
      title: 'Stream reconnected',
      message: 'agent-stream-hub reachable again',
      kind: 'ok',
      durationMs: 3500,
    });
  }
  lastState = state;
}

function init() {
  ensureMounted();
  if (window.pty && typeof window.pty.onStreamStatus === 'function') {
    window.pty.onStreamStatus(update);
  }
}

module.exports = { init, update };
