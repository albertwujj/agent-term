// Stream protocol types + helpers. Schema is the contract between
// agent-term (source) and the viewer (target). The hub does not parse
// payloads — see ../../../agent-stream-hub/stream.md.

const crypto = require('crypto');

/**
 * @typedef {Object} RunMeta
 * @property {string} runId
 * @property {string} cli       e.g. "claude" | "codex" | "copilot"
 * @property {string} title     first prompt text
 * @property {string} host      source hostname
 * @property {number} startedAt ms epoch
 */

/**
 * @typedef {Object} StyleRun
 * @property {number} start     inclusive char index in row.text
 * @property {number} end       exclusive char index
 * @property {string} [fg]      "p<n>" palette or "#rrggbb"
 * @property {string} [bg]
 * @property {true}   [bold]
 * @property {true}   [italic]
 * @property {true}   [underline]
 * @property {true}   [dim]
 * @property {true}   [inverse]
 * @property {true}   [strike]
 */

/**
 * @typedef {Object} Row
 * @property {string} text
 * @property {StyleRun[]} [styles]
 */

/**
 * @typedef {Object} Block
 * @property {number} id
 * @property {string} runId
 * @property {boolean} sealed
 * @property {number} startedAt
 * @property {?number} sealedAt
 * @property {?string} prompt
 * @property {number} cols
 * @property {Row[]} rows
 */

/**
 * @typedef {Object} Message
 * @property {number} seq       monotonic per run, set by source
 * @property {object} payload   typically a Block
 */

function genRunId() {
  return crypto.randomBytes(8).toString('hex');
}

function nowMs() {
  return Date.now();
}

module.exports = { genRunId, nowMs };
