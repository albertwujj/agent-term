// Async HTTP client for agent-stream-hub.
//
// Producers (stream-state, heartbeat timer) call enqueue() synchronously and
// return immediately — no awaiting. A single worker loop drains the queue,
// POSTs with a hard timeout, and updates the state machine. A dead hub or
// rotated tunnel costs the user nothing in PTY responsiveness.
//
// Transport: Electron's session.defaultSession.fetch (Chromium net stack),
// not Node's undici fetch. Chromium honors the OS trust store and any
// configured system proxy, so corporate-MITM environments like Zscaler
// "just work" without NODE_EXTRA_CA_CERTS gymnastics. Plain Mac/Linux is
// unaffected.
//
// State machine: idle → connecting → connected ↔ retrying → disconnected.
// Callers subscribe via onStateChange to update UI indicators.
//
// Retry semantics: failed POSTs stay at the head of the queue and are
// retried with exponential backoff until they succeed. The queue is
// capped (RETRY_QUEUE_CAP) and drops oldest on overflow — viewer-visible
// gaps are accepted as the failure mode of a sustained outage.

const { session } = require('electron');
const {
  STREAM_HUB_URL,
  STREAM_HUB_SECRET,
  HEARTBEAT_IDLE_MS,
  HEARTBEAT_AWAITING_MS,
  VIEWER_ACTIVE_WINDOW_MS,
  POST_TIMEOUT_MS,
  RETRY_QUEUE_CAP,
  FAIL_THRESHOLD,
  RETRY_BACKOFF_MIN_MS,
  RETRY_BACKOFF_MAX_MS,
} = require('./config');

// Distill an Error from fetch into a short, actionable string. Handles
// both Chromium ("net::ERR_*") and undici (err.cause.code) shapes, and
// AbortController timeouts.
function describeFetchError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'AbortError') return 'request timed out';
  const top = err.message || String(err);
  // Chromium: errors come through with the net::ERR_ code embedded in
  // the message (sometimes prefixed by other text). Pull it out.
  const m = top.match(/net::ERR_[A-Z0-9_]+/);
  if (m) return m[0];
  // undici fallback (rare now that we're on session.fetch, but kept so
  // any odd codepath doesn't lose info).
  const c = err.cause;
  if (c) {
    const cmsg = c.code || c.message || String(c);
    if (cmsg) return `${top}: ${cmsg}`;
  }
  return top;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class StreamClient {
  constructor({ onStateChange, getRegistration, getIsWorking, onInputs, onVoiceInputs } = {}) {
    this.onStateChange = onStateChange || (() => {});
    // Returns the current RunMeta. Used to recover when the hub forgets
    // us (restart, eviction) and starts returning 404 — we re-register.
    this.getRegistration = getRegistration || (() => null);
    // Returns the source's "AI is working" bool. Stamped on heartbeats.
    this.getIsWorking = getIsWorking || (() => false);
    // Receives viewer-submitted prompts drained from heartbeat responses.
    this.onInputs = onInputs || (() => {});
    // Receives voice-origin transcripts (hub /voice, kept in a separate
    // queue so the consumer can prefix the guide reference — voice.md).
    this.onVoiceInputs = onVoiceInputs || (() => {});
    this.queue = [];
    this.state = 'idle';
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.lastSuccessAt = null;
    this.backoffMs = RETRY_BACKOFF_MIN_MS;
    this.workerRunning = false;
    this.heartbeatTimer = null;
    this.runId = null;
    this.seq = 0;
    this.stopped = false;
    // Local-clock time of the hub's last-seen detail-view poll (derived
    // from ack viewerAgeMs). 0 = never seen a viewer.
    this._lastViewerPollAt = 0;
    this.reregisterPending = false;
    // No hub URL configured → permanent "disabled" state. No requests, no
    // retries, no heartbeats. Indicator shows a hollow/grey dot with a
    // tooltip pointing the user at the config file.
    this.disabled = !STREAM_HUB_URL;
    if (this.disabled) this._setState('disabled');
  }

  // Current state snapshot for late subscribers. The renderer subscribes
  // to onStreamStatus only after did-finish-load, which is after the
  // constructor's _setState('disabled') fires — that event would
  // otherwise be lost. Main re-pushes via getStatus() so the hollow-grey
  // "disabled" dot is visible when hubUrl is missing or config parsing
  // fails (e.g., BOM in config.json).
  getStatus() {
    return {
      state: this.state,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  // Begin streaming. Called by stream-state when the first user prompt fires.
  // meta is a RunMeta. Schedules register + heartbeat; transitions
  // idle → connecting. No-op when no hub is configured.
  registerRun(meta) {
    if (this.stopped || this.disabled) return;
    this.runId = meta.runId;
    this._setState('connecting');
    this._enqueue({ method: 'POST', path: '/runs', body: meta });
    this._scheduleHeartbeat();
  }

  // Self-rearming heartbeat. Interval is picked per tick:
  //   · isWorking AND nobody watching → HEARTBEAT_IDLE_MS (30s). Agent
  //     is busy and no viewer is engaged; inputs are unlikely.
  //   · Viewer active (a detail-view poll within VIEWER_ACTIVE_WINDOW_MS,
  //     learned from heartbeat/snapshot acks) → top pace even while
  //     working: someone watching may interject any moment. Decay is
  //     the window expiring — refreshed every ~1.5s while a view is open.
  //   · Recently received a viewer input → fast polling (200ms→400ms→
  //     800ms→2s) for ~2s after the last input. Catches rapid follow-up
  //     inputs (picker navigation: ↓↓↓↵) without making the user wait
  //     a full baseline period between keypresses.
  //   · Otherwise → HEARTBEAT_AWAITING_MS (2s) baseline.
  // Sets _lastInputAt in _doRequest when a heartbeat response carries
  // inputs; the next schedule reads it to pick the fast bucket.
  _scheduleHeartbeat() {
    if (this.stopped) return;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    let ms;
    if (this.getIsWorking() && !this._viewerRecent()) {
      ms = HEARTBEAT_IDLE_MS;
    } else {
      const since = Date.now() - (this._lastInputAt || 0);
      if      (since <  300) ms = 200;
      else if (since <  800) ms = 400;
      else if (since < 2000) ms = 800;
      else                   ms = HEARTBEAT_AWAITING_MS;
    }
    this.heartbeatTimer = setTimeout(() => {
      this._heartbeat();
      this._scheduleHeartbeat();
    }, ms);
  }

  _viewerRecent() {
    return !!this._lastViewerPollAt &&
      (Date.now() - this._lastViewerPollAt) < VIEWER_ACTIVE_WINDOW_MS;
  }

  // Hub acks carry the age of the last detail-view poll. Age, not a
  // timestamp: hub/source clocks can't be compared, so map the age onto
  // the local clock. When this flips not-watched → watched while a slow
  // (30s) timer is pending, reschedule immediately so promotion doesn't
  // wait out the old timer. Only on the flip — rescheduling on every ack
  // would keep pushing the timer forward and it would never fire.
  _noteViewerAge(ageMs) {
    const wasRecent = this._viewerRecent();
    this._lastViewerPollAt = Date.now() - ageMs;
    if (!wasRecent && this._viewerRecent()) this._scheduleHeartbeat();
  }

  // Re-POST /runs with updated meta (e.g., new entry in the prompts list).
  // Hub upserts on POST /runs; no state-machine churn unlike registerRun.
  updateMeta(meta) {
    if (this.stopped || this.disabled || !this.runId) return;
    this._enqueue({ method: 'POST', path: '/runs', body: meta });
  }

  // Push a viewport snapshot. Hub compacts adjacent near-identical ones.
  pushSnapshot(payload) {
    if (this.stopped || this.disabled || !this.runId) return;
    this._enqueue({
      method: 'POST',
      path: `/runs/${this.runId}/snapshot`,
      body: { seq: ++this.seq, payload },
    });
  }

  // Stop heartbeating + halt the worker. We deliberately do NOT send
  // DELETE — runs persist in the hub and the viewer until the user (or
  // the 24h memory bound) clears them. Freshness is conveyed by the
  // heartbeat indicator, not by removing the run.
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _heartbeat() {
    if (this.stopped || !this.runId) return;
    if (this.state === 'idle') return;
    this._enqueue({
      method: 'POST',
      path: `/runs/${this.runId}/heartbeat`,
      body: { isWorking: !!this.getIsWorking() },
    });
  }

  _enqueue(item) {
    if (this.queue.length >= RETRY_QUEUE_CAP) {
      this.queue.shift();
    }
    this.queue.push(item);
    this._kickWorker();
  }

  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    try {
      this.onStateChange({
        state: newState,
        lastError: this.lastError,
        lastSuccessAt: this.lastSuccessAt,
      });
    } catch {}
  }

  async _kickWorker() {
    if (this.workerRunning) return;
    this.workerRunning = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        const ok = await this._doRequest(item);
        if (ok) {
          this.queue.shift();
          this.consecutiveFailures = 0;
          this.lastSuccessAt = Date.now();
          this.backoffMs = RETRY_BACKOFF_MIN_MS;
          if (this.state !== 'connected') this._setState('connected');
        } else {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= FAIL_THRESHOLD) {
            this._setState('disconnected');
          } else if (this.state !== 'disconnected') {
            this._setState('retrying');
          }
          await sleep(this.backoffMs);
          this.backoffMs = Math.min(this.backoffMs * 2, RETRY_BACKOFF_MAX_MS);
        }
      }
    } finally {
      this.workerRunning = false;
    }
  }

  async _doRequest(item) {
    const url = STREAM_HUB_URL + item.path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const opts = {
        method: item.method,
        signal: controller.signal,
        headers: {},
      };
      if (STREAM_HUB_SECRET) opts.headers['X-Hub-Secret'] = STREAM_HUB_SECRET;
      if (item.body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(item.body);
      }
      // Chromium's fetch via Electron's session — respects the OS trust
      // store (Zscaler-style MITM works) and system proxy settings.
      const res = await session.defaultSession.fetch(url, opts);
      if (res.ok) {
        if (item._isReregister) this.reregisterPending = false;
        // The next periodic snapshot from the renderer will populate
        // the hub's empty ring within a poll cycle; no explicit re-seed.
        // Heartbeat response drains any viewer-submitted inputs queued
        // on the hub. Body parse failures are non-fatal — we'd just miss
        // this batch and pick it up on the next heartbeat. Receiving
        // inputs also bumps the heartbeat into fast-poll mode (see
        // _scheduleHeartbeat) so any follow-up keys land quickly.
        if (/^\/runs\/[^/]+\/heartbeat$/.test(item.path)) {
          try {
            const body = await res.json();
            const inputs = body && Array.isArray(body.inputs) ? body.inputs : [];
            if (inputs.length) {
              this._lastInputAt = Date.now();
              this.onInputs(inputs);
            }
            const voiceInputs = body && Array.isArray(body.voiceInputs) ? body.voiceInputs : [];
            if (voiceInputs.length) {
              this._lastInputAt = Date.now();
              this.onVoiceInputs(voiceInputs);
            }
            if (body && typeof body.viewerAgeMs === 'number') this._noteViewerAge(body.viewerAgeMs);
          } catch {}
        }
        // Snapshot acks also carry viewer presence — this is how a WORKING
        // source (30s heartbeats, frequent snapshots) learns of a viewer
        // within a second or two of them opening the detail view.
        if (/^\/runs\/[^/]+\/snapshot$/.test(item.path)) {
          try {
            const body = await res.json();
            if (body && typeof body.viewerAgeMs === 'number') this._noteViewerAge(body.viewerAgeMs);
          } catch {}
        }
        return true;
      }
      // Hub forgot us (process restart, manual eviction). Front-load a
      // fresh register POST so the next request succeeds. Dedup: only
      // one pending re-register at a time even if many pushes 404.
      if (res.status === 404 &&
          !this.reregisterPending &&
          /^\/runs\/[^/]+\/(snapshot|heartbeat)$/.test(item.path)) {
        const meta = this.getRegistration();
        if (meta && meta.runId === this.runId) {
          this.reregisterPending = true;
          this.queue.unshift({
            method: 'POST',
            path: '/runs',
            body: meta,
            _isReregister: true,
          });
          this.lastError = '404 — hub forgot run, re-registering';
        } else {
          this.lastError = `HTTP 404 ${item.method} ${item.path}`;
        }
      } else {
        this.lastError = `HTTP ${res.status} ${item.method} ${item.path}`;
      }
      return false;
    } catch (err) {
      this.lastError = describeFetchError(err);
      try { console.warn('[stream] request failed:', item.method, item.path, this.lastError, err); } catch {}
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { StreamClient };
