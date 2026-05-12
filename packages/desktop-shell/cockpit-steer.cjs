'use strict';

/**
 * Cockpit STEER — Module 2 wiring (Phase 3 of panel-cockpit-redesign).
 *
 * Tiered "talk to agent" delivery (decision #5 / #20):
 *
 *   Tier 1 (preferred) — INJECTION via scratchpad inbox queue:
 *     Write to scratchpad key  `agent_inbox/<agent_id>/<ulid>`
 *     value_json = { from: 'user-supervisor:<sup_id>', message, ts,
 *                    project_id, source: 'cockpit' }
 *     Cairn-aware agents (whose prompt template includes a "check
 *     pending steer messages" loop step) pick this up on next iteration.
 *
 *   Tier 2 (fallback) — CLIPBOARD:
 *     Always also copy a wrapped message ("[cockpit steer for <agent>]
 *     <message>") to the system clipboard so the user can paste into
 *     a non-Cairn-aware agent's chat manually.
 *
 * Returns: { ok, delivered: ['inject', 'clipboard'], scratchpad_key? }
 *
 * D9.1 tier-A first-class (PRODUCT.md §12 D9.1): no env flag gate.
 * The scratchpad write counts as a "user-visible user-revokable" mutation —
 * panel renders the message it sent in Module 3 (activity feed) so the
 * user can see what they asked, and the inbox entry can be deleted /
 * marked consumed by the agent.
 *
 * D9.2 supervisor identity: each entry tags `from: 'user-supervisor:<id>'`
 * so audit trail can distinguish user-triggered steer from agent writes.
 */

const crypto = require('node:crypto');

/** Maximum bytes of a steer message; clipped before write. */
const MAX_STEER_BYTES = 4096;

/** Inline ULID generator (no external deps). Crockford Base32. */
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newUlid() {
  const ts = Date.now();
  let timePart = '';
  let n = ts;
  for (let i = 9; i >= 0; i--) {
    timePart = ENC[n % 32] + timePart;
    n = Math.floor(n / 32);
  }
  const rand = crypto.randomBytes(10);
  let randPart = '';
  for (let i = 0; i < 16; i++) {
    randPart += ENC[rand[i % 10] % 32];
  }
  return timePart + randPart;
}

/**
 * Persistent supervisor identity for this Cairn desktop-shell instance.
 * Generated once per process startup. Used in D9.2 audit trail.
 */
let _supervisorId = null;
function supervisorId() {
  if (!_supervisorId) {
    _supervisorId = 'cairn-supervisor-' + crypto.randomBytes(6).toString('hex');
  }
  return _supervisorId;
}

/**
 * Build the agent inbox scratchpad key.
 *
 * Format: `agent_inbox/<agent_id>/<ulid>`
 *
 * Caller must already have validated agent_id; key collisions on the
 * same ms are vanishingly unlikely (ULID time prefix + 10-byte random).
 */
function inboxKey(agentId) {
  return `agent_inbox/${agentId}/${newUlid()}`;
}

/**
 * Inject a steer message into the agent's scratchpad inbox queue.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Set<string>} tables
 * @param {object} input
 * @param {string} input.project_id
 * @param {string} input.agent_id     target agent's CAIRN_SESSION_AGENT_ID
 * @param {string} input.message
 * @param {string} [input.supervisor_id]  override (tests)
 * @returns {{ok:boolean, key?:string, error?:string}}
 */
function injectSteer(db, tables, input) {
  if (!db || !tables) return { ok: false, error: 'db_unavailable' };
  if (!tables.has('scratchpad')) return { ok: false, error: 'scratchpad_missing' };
  if (!input || typeof input !== 'object') return { ok: false, error: 'input_required' };
  if (!input.agent_id || typeof input.agent_id !== 'string') {
    return { ok: false, error: 'agent_id_required' };
  }
  if (!input.project_id || typeof input.project_id !== 'string') {
    return { ok: false, error: 'project_id_required' };
  }
  const raw = (input.message || '').toString();
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'message_empty' };
  const clipped = trimmed.length > MAX_STEER_BYTES
    ? trimmed.slice(0, MAX_STEER_BYTES)
    : trimmed;

  const sup = input.supervisor_id || supervisorId();
  const now = Date.now();
  const key = inboxKey(input.agent_id);
  const value = {
    from: 'user-supervisor:' + sup,
    message: clipped,
    ts: now,
    project_id: input.project_id,
    source: 'cockpit',
    via: 'panel-action',
  };

  try {
    db.prepare(`
      INSERT INTO scratchpad
        (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
      VALUES
        (@key, @value_json, NULL, NULL, NULL, @now, @now)
    `).run({
      key,
      value_json: JSON.stringify(value),
      now,
    });
  } catch (e) {
    return { ok: false, error: 'scratchpad_write_failed: ' + (e && e.message ? e.message : String(e)) };
  }
  return { ok: true, key, supervisor_id: sup };
}

/**
 * Build the clipboard-fallback text. Single-line preamble + message.
 *
 * Plain-text only; consumed by users pasting into a chat session.
 */
function clipboardText(input) {
  const a = input.agent_id || 'agent';
  return `[cockpit steer → ${a}]\n${input.message || ''}`;
}

/**
 * Steer the agent — best-effort, tiered:
 *   - try injection (scratchpad write); success means Cairn-aware agents
 *     will see it on next loop
 *   - always also produce clipboard text so the user can paste manually
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Set<string>} tables
 * @param {object} input
 * @param {object} [opts]
 * @param {function} [opts.copyToClipboard]   (text) => void
 *
 * @returns {{ok, delivered: string[], scratchpad_key?, error?, clipboard_text?}}
 */
function steerAgent(db, tables, input, opts) {
  const o = opts || {};
  const delivered = [];
  const result = { ok: true, delivered };

  // Pre-validate so empty / malformed inputs short-circuit cleanly
  // without firing a useless clipboard copy.
  if (!input || typeof input !== 'object') {
    return { ok: false, delivered: [], error: 'input_required' };
  }
  if (!input.agent_id || typeof input.agent_id !== 'string') {
    return { ok: false, delivered: [], error: 'agent_id_required', inject_error: 'agent_id_required' };
  }
  if (!input.project_id || typeof input.project_id !== 'string') {
    return { ok: false, delivered: [], error: 'project_id_required', inject_error: 'project_id_required' };
  }
  if (!input.message || !input.message.toString().trim()) {
    return { ok: false, delivered: [], error: 'message_empty', inject_error: 'message_empty' };
  }

  const inj = injectSteer(db, tables, input);
  if (inj.ok) {
    delivered.push('inject');
    result.scratchpad_key = inj.key;
    result.supervisor_id = inj.supervisor_id;
  } else {
    result.inject_error = inj.error;
  }

  // Clipboard fallback always runs (idempotent), so even if injection
  // succeeded the user can also paste manually. Caller controls the
  // actual clipboard write via opts.copyToClipboard (so we can test
  // this module without electron).
  const text = clipboardText(input);
  result.clipboard_text = text;
  if (typeof o.copyToClipboard === 'function') {
    try {
      o.copyToClipboard(text);
      delivered.push('clipboard');
    } catch (e) {
      result.clipboard_error = e && e.message ? e.message : String(e);
    }
  } else {
    delivered.push('clipboard');
  }

  if (delivered.length === 0) result.ok = false;
  return result;
}

module.exports = {
  MAX_STEER_BYTES,
  supervisorId,
  inboxKey,
  injectSteer,
  clipboardText,
  steerAgent,
};
