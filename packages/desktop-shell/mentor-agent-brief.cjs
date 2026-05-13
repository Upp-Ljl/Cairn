'use strict';

/**
 * Mentor — agent_brief reader.
 *
 * L2 input for the 3-layer decision architecture. Cairn-aware coding
 * agents (Claude Code / Cursor / Codex / Aider) are instructed (via
 * the CAIRN.md "For Cairn-aware coding agents" section installed by
 * `cairn install`) to write a brief to scratchpad before raising a
 * blocker. Mentor reads it here.
 *
 * Brief schema (stored under scratchpad key `agent_brief/<agent_id>`):
 *
 *   {
 *     version: 1,
 *     agent_id: string,
 *     task_id: string | null,
 *     summary: string,         // what the agent is trying to do (<=150 words)
 *     stuck_on: string,        // what's blocking (<=80 words)
 *     options_considered: string[],
 *     lean: string,            // agent's current preference + why
 *     written_at: number,      // Date.now()
 *   }
 *
 * Stale-brief handling: a brief is "stale" when older than `staleAfterMs`
 * (default 30 min). Caller decides what to do with the staleness flag —
 * per plan §7 open-Q 2, lean toward "still trust it but flag in Activity".
 *
 * Pure read-only. Writes are the agent's job (via the MCP scratchpad
 * tool); this module never writes briefs.
 */

const BRIEF_VERSION = 1;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000; // 30 min

function briefKey(agentId) {
  return `agent_brief/${agentId}`;
}

/**
 * Read the latest agent_brief for an agent.
 *
 * @param {Database} db
 * @param {string} agentId
 * @param {object} [opts]
 * @param {number} [opts.staleAfterMs]  // override staleness threshold
 * @param {number} [opts.nowMs]         // injectable clock (for tests)
 * @returns {null | {
 *   brief: object,
 *   age_ms: number,
 *   is_stale: boolean,
 *   key: string,
 *   updated_at: number,
 * }}
 */
function readAgentBrief(db, agentId, opts) {
  if (!db || !agentId) return null;
  const o = opts || {};
  const stale = Number(o.staleAfterMs) > 0 ? Number(o.staleAfterMs) : DEFAULT_STALE_AFTER_MS;
  const now = Number(o.nowMs) > 0 ? Number(o.nowMs) : Date.now();

  let row;
  try {
    row = db.prepare('SELECT value_json, updated_at FROM scratchpad WHERE key = ?').get(briefKey(agentId));
  } catch (_e) {
    return null;
  }
  if (!row) return null;

  let brief;
  try { brief = JSON.parse(row.value_json); } catch (_e) { return null; }
  if (!brief || typeof brief !== 'object') return null;
  if (brief.version !== BRIEF_VERSION) return null;

  const writtenAt = Number(brief.written_at) || Number(row.updated_at) || 0;
  const age = Math.max(0, now - writtenAt);

  return {
    brief,
    age_ms: age,
    is_stale: age > stale,
    key: briefKey(agentId),
    updated_at: Number(row.updated_at) || 0,
  };
}

/**
 * Read briefs for *all* given agent IDs; returns array (omitting agents
 * with no brief). Used by mentor-tick when a task has multiple
 * candidate authors / collaborators.
 */
function readAgentBriefs(db, agentIds, opts) {
  if (!db || !Array.isArray(agentIds)) return [];
  const out = [];
  for (const id of agentIds) {
    const r = readAgentBrief(db, id, opts);
    if (r) out.push({ agent_id: id, ...r });
  }
  return out;
}

/**
 * Build a one-line summary of a brief for inclusion in nudges / Activity
 * feed entries. Returns null if the brief is empty.
 */
function briefSnippet(brief, maxLen) {
  if (!brief || typeof brief !== 'object') return null;
  const max = Number(maxLen) > 0 ? Number(maxLen) : 160;
  const parts = [];
  if (brief.lean) parts.push(`lean: ${brief.lean}`);
  if (brief.stuck_on) parts.push(`stuck: ${brief.stuck_on}`);
  if (parts.length === 0 && brief.summary) parts.push(brief.summary);
  if (parts.length === 0) return null;
  const s = parts.join(' | ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Test helper — write a brief to scratchpad. NOT meant for production
 * use (agents should write via MCP); only used by smokes / dogfoods to
 * stand up a fixture.
 */
function writeAgentBriefForTest(db, agentId, brief) {
  if (!db || !agentId || !brief) return false;
  const now = Date.now();
  const payload = { version: BRIEF_VERSION, ...brief };
  try {
    db.prepare(`
      INSERT INTO scratchpad (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(briefKey(agentId), JSON.stringify(payload), brief.task_id || null, now, now);
    return true;
  } catch (_e) {
    return false;
  }
}

module.exports = {
  BRIEF_VERSION,
  DEFAULT_STALE_AFTER_MS,
  briefKey,
  readAgentBrief,
  readAgentBriefs,
  briefSnippet,
  writeAgentBriefForTest,
};
