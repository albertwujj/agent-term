// Per-agent-term-process stream orchestrator.
//
// Owns the runId. Forwards each renderer buffer snapshot to client.
// pushSnapshot. Register-on-first-prompt; meta carries the session's
// identity (cli, host, title=firstPrompt, hue). No markers, no blocks —
// the viewer renders snapshots as a continuous stitched buffer with
// GAPs for unstitchable transitions. Prompts are local agent-term state
// (window title, icon letters) and aren't streamed.

const os = require('os');
const { genRunId, nowMs } = require('./protocol');

class StreamState {
  constructor({ client, getCli, getIsWorking, getHue } = {}) {
    this.client = client;
    this.getCli = getCli || (() => null);
    this.getIsWorking = getIsWorking || (() => false);
    this.getHue = getHue || (() => null);
    this.runId = genRunId();
    this.registered = false;
    this.host = os.hostname() || 'unknown';
    this.startedAt = nowMs();
    // Last RunMeta we sent. Exposed via getRegistration() so the client
    // can re-register transparently if the hub forgets us.
    this.lastMeta = null;
  }

  getRegistration() {
    return this.lastMeta;
  }

  // First captured prompt triggers registration. Subsequent prompts are
  // no-ops at this layer — local UI updates happen in main.js without
  // needing to involve the stream.
  onPrompt(prompt) {
    if (this.registered) return;
    const text = typeof prompt === 'string' ? prompt : (prompt && prompt.text) || '';
    if (!text) return;
    const cli = this.getCli() || 'unknown';
    const hue = this.getHue();
    this.registered = true;
    this.lastMeta = {
      runId: this.runId,
      cli,
      title: text,
      host: this.host,
      startedAt: this.startedAt,
      ...(typeof hue === 'number' ? { hue } : {}),
    };
    this.client.registerRun(this.lastMeta);
  }

  // Renderer reports a viewport update (periodic snapshot).
  onBufferUpdate(payload) {
    if (!this.registered) return;
    this.client.pushSnapshot({
      runId: this.runId,
      cols: payload.cols || 0,
      rows: payload.rows || [],
      isWorking: !!this.getIsWorking(),
    });
  }

  // Alt-screen enter/exit — just another snapshot. Stitcher handles the
  // visual discontinuity (REPLACEs on same-size, GAPs on size-mismatch).
  onBufferFlip(payload) {
    if (!this.registered) return;
    this.client.pushSnapshot({
      runId: this.runId,
      cols: payload.cols || 0,
      rows: payload.newRows || [],
      isWorking: !!this.getIsWorking(),
    });
  }
}

module.exports = { StreamState };
