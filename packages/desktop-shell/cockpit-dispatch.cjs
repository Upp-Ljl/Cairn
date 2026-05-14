'use strict';

/**
 * cockpit-dispatch.cjs — A2.2 Dispatch Wire.
 *
 * Wires Mentor todolist items to Cairn's dispatch_requests primitive so
 * "派给 ▾" button presses create a real, auditable dispatch request in
 * the kernel — not a prompt generator.
 *
 * D9.1 tier-A first-class mutation (PRODUCT.md §12 D9.1):
 *   Writing to dispatch_requests is Cairn's own dispatch primitive.
 *   Panel writing it is equivalent to an agent calling cairn.dispatch.request
 *   via MCP — fully within Cairn's design surface.
 *
 * Kernel dispatch tick (R1–R6 fallback rules) runs on its own schedule
 * inside mcp-server — this module only INSERTs the row and updates the
 * scratchpad todo entry. The kernel picks it up on its own cadence.
 */

const crypto = require('node:crypto');
const cairnLog = require('./cairn-log.cjs');

// ---------------------------------------------------------------------------
// Inline ULID generator (Crockford base-32, no external deps)
// Identical to the implementation in cockpit-steer.cjs for consistency.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Check all required fields are non-empty strings.
 * @param {object} input
 * @returns {string|null} error code, or null if valid
 */
function validateInput(input) {
  if (!input || typeof input !== 'object') return 'input_required';
  if (!input.project_id || typeof input.project_id !== 'string' || !input.project_id.trim()) {
    return 'project_id_required';
  }
  if (!input.todo_id || typeof input.todo_id !== 'string' || !input.todo_id.trim()) {
    return 'todo_id_required';
  }
  const validSources = ['agent_proposal', 'mentor_todo', 'user_todo'];
  if (!input.source || !validSources.includes(input.source)) {
    return 'source_must_be_agent_proposal_or_mentor_todo_or_user_todo';
  }
  if (!input.target_agent_id || typeof input.target_agent_id !== 'string' || !input.target_agent_id.trim()) {
    return 'target_agent_id_required';
  }
  if (!input.label || typeof input.label !== 'string' || !input.label.trim()) {
    return 'label_required';
  }
  return null;
}

/**
 * Verify target_agent_id exists in the processes table (any status,
 * including DEAD — the dispatch kernel handles liveness policy).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Set<string>} tables
 * @param {string} targetAgentId
 * @returns {string|null} error code or null if OK
 */
function checkAgentExists(db, tables, targetAgentId) {
  if (!tables.has('processes')) return 'processes_table_missing';
  try {
    const row = db.prepare('SELECT agent_id FROM processes WHERE agent_id = ?').get(targetAgentId);
    if (!row) return 'target_agent_not_found';
    return null;
  } catch (e) {
    return 'processes_query_failed: ' + (e && e.message ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Core: dispatchTodo
// ---------------------------------------------------------------------------

/**
 * Write a dispatch_requests row for the todo item and mark the scratchpad
 * todo entry as 'dispatched'.
 *
 * Steps:
 *  1. Validate input fields (non-empty, valid source)
 *  2. Confirm target_agent_id exists in processes table
 *  3. INSERT into dispatch_requests (PENDING)
 *  4. Update scratchpad todo entry: add dispatched_to / dispatched_at /
 *     dispatch_id fields, plus a 'dispatched' status marker
 *  5. Return { ok, dispatch_id }
 *
 * @param {import('better-sqlite3').Database} db  — writable DB handle
 * @param {Set<string>} tables
 * @param {object} input
 * @param {string} input.project_id
 * @param {string} input.todo_id       — scratchpad key of the todo
 * @param {'agent_proposal'|'mentor_todo'|'user_todo'} input.source
 * @param {string} input.target_agent_id
 * @param {string} input.label         — ≤ 200 char display label
 * @param {string} [input.why]         — optional rationale
 * @returns {{ ok: boolean, dispatch_id?: string, error?: string }}
 */
function dispatchTodo(db, tables, input) {
  if (!db || !tables) return { ok: false, error: 'db_unavailable' };

  // 1. Validate
  const validErr = validateInput(input);
  if (validErr) return { ok: false, error: validErr };

  // 2. Confirm agent exists
  const agentErr = checkAgentExists(db, tables, input.target_agent_id);
  if (agentErr) return { ok: false, error: agentErr };

  if (!tables.has('dispatch_requests')) {
    return { ok: false, error: 'dispatch_requests_table_missing' };
  }

  const dispatchId = newUlid();
  const now = Date.now();

  // 3. Build nl_intent from label + source context
  const nlIntent = `[cockpit-dispatch/${input.source}] ${input.label.trim()}${input.why ? ' — ' + input.why.trim() : ''}`;

  // 4. INSERT dispatch row. The dispatch_requests schema (migration 005 / 008):
  //    id, nl_intent, parsed_intent, context_keys, generated_prompt,
  //    target_agent, status, created_at, confirmed_at, task_id
  try {
    db.prepare(`
      INSERT INTO dispatch_requests
        (id, nl_intent, parsed_intent, context_keys, generated_prompt,
         target_agent, status, created_at, confirmed_at, task_id)
      VALUES
        (@id, @nl_intent, NULL, @context_keys, NULL,
         @target_agent, 'PENDING', @created_at, NULL, NULL)
    `).run({
      id: dispatchId,
      nl_intent: nlIntent,
      context_keys: JSON.stringify([input.todo_id]),
      target_agent: input.target_agent_id,
      created_at: now,
    });
  } catch (e) {
    cairnLog.error('dispatch', 'dispatch_insert_failed', {
      project_id: input.project_id,
      target_agent_id: input.target_agent_id,
      message: (e && e.message) || String(e),
    });
    return { ok: false, error: 'dispatch_insert_failed: ' + (e && e.message ? e.message : String(e)) };
  }
  cairnLog.info('dispatch', 'dispatch_created', {
    project_id: input.project_id,
    dispatch_id: dispatchId,
    todo_id: input.todo_id,
    target_agent_id: input.target_agent_id,
    source: input.source,
  });

  // 5. Mark the scratchpad todo entry as dispatched.
  //    The todo is stored at key = todo_id (e.g. "agent_proposal/<aid>/<ulid>").
  //    We read the existing value_json, merge dispatched_* fields, and update.
  if (tables.has('scratchpad')) {
    try {
      const row = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(input.todo_id);
      if (row) {
        let value = {};
        try { value = JSON.parse(row.value_json || '{}'); } catch (_) { value = {}; }
        value.dispatched_to = input.target_agent_id;
        value.dispatched_at = now;
        value.dispatch_id = dispatchId;
        value.status = 'dispatched';
        db.prepare(`
          UPDATE scratchpad SET value_json = @value_json, updated_at = @now
          WHERE key = @key
        `).run({
          value_json: JSON.stringify(value),
          now,
          key: input.todo_id,
        });
      }
      // If the todo doesn't exist in scratchpad yet (race or user_todo with
      // no prior scratchpad entry), we write a minimal record so the panel
      // can confirm the dispatch.
      else {
        const value = {
          label: input.label.trim(),
          source: input.source,
          project_id: input.project_id,
          dispatched_to: input.target_agent_id,
          dispatched_at: now,
          dispatch_id: dispatchId,
          status: 'dispatched',
          ts: now,
        };
        db.prepare(`
          INSERT INTO scratchpad
            (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
          VALUES
            (@key, @value_json, NULL, NULL, NULL, @now, @now)
        `).run({
          key: input.todo_id,
          value_json: JSON.stringify(value),
          now,
        });
      }
    } catch (e) {
      // Non-fatal: dispatch row is already written; scratchpad update failure
      // is a best-effort annotation. Return ok with a warning.
      return {
        ok: true,
        dispatch_id: dispatchId,
        scratchpad_warning: 'scratchpad_mark_failed: ' + (e && e.message ? e.message : String(e)),
      };
    }
  }

  return { ok: true, dispatch_id: dispatchId };
}

module.exports = {
  dispatchTodo,
  // Exported for testing
  validateInput,
  checkAgentExists,
  newUlid,
};
