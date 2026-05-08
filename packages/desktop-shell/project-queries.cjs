'use strict';

/**
 * Hint-filtered queries for the per-project view.
 *
 * Reads the same 6 host-level state object tables as queries.cjs, but
 * applies `agent_id_hints` (from the project registry) as the
 * attribution filter. Strict read-only.
 *
 * Attribution rules (heuristic; must stay aligned with plan §3.1):
 *   processes        → row.agent_id ∈ hints
 *   tasks            → row.created_by_agent_id ∈ hints
 *   blockers         → JOIN tasks; tasks.created_by_agent_id ∈ hints
 *   outcomes         → JOIN tasks; tasks.created_by_agent_id ∈ hints
 *   checkpoints      → JOIN tasks; tasks.created_by_agent_id ∈ hints
 *                      (untagged checkpoints — task_id IS NULL — go to
 *                      Unassigned because they cannot be attributed)
 *   conflicts        → row.agent_a ∈ hints OR row.agent_b ∈ hints
 *   dispatch_requests→ row.target_agent ∈ hints OR (task_id JOIN matches)
 *
 * Unassigned = rows in the same db_path that match no project's hints
 * (computed from the union across all registered projects' hints).
 *
 * Caller passes in a `tables` Set so we don't re-query sqlite_master
 * on every poll, and a `hints` array (or Set) per project. Empty hints
 * yield empty results (= "this project has no attribution claim yet,
 * so its filtered view is empty"). That's intentional: legacy default
 * entries with project_root='(unknown)' will show all-zero summaries
 * until the user adds at least one hint.
 */

/**
 * @typedef {Object} ProjectScopedSummary
 * @property {boolean} available
 * @property {string|null} db_path
 * @property {number} ts                   unix sec
 * @property {number} agents_active
 * @property {number} agents_stale         ACTIVE rows with stale heartbeat (heuristic; client-side)
 * @property {number} tasks_running
 * @property {number} tasks_blocked
 * @property {number} tasks_waiting_review
 * @property {number} tasks_failed
 * @property {number} blockers_open
 * @property {number} outcomes_failed
 * @property {number} outcomes_pending
 * @property {number} conflicts_open
 * @property {number} dispatches_recent_1h
 * @property {number} last_activity_at     unix ms (max ts across sources, hint-filtered); 0 if none
 * @property {'idle'|'warn'|'alert'} health
 */

/**
 * @typedef {Object} UnassignedSummary
 * @property {boolean} available
 * @property {string} db_path
 * @property {number} ts
 * @property {number} agents             processes rows whose agent_id is in NO project's hints
 * @property {number} tasks              tasks rows whose created_by_agent_id is unattributed (or NULL)
 * @property {number} blockers           blockers whose joined task is unattributed (incl. task_id IS NULL)
 * @property {number} outcomes           same
 * @property {number} checkpoints        same (incl. task_id IS NULL)
 * @property {number} conflicts          conflicts where neither agent_a nor agent_b is in any hint
 * @property {number} dispatches         dispatch_requests whose target_agent is unattributed
 * @property {number} total_rows
 * @property {number} last_activity_at
 */

const STALE_GRACE_FACTOR = 1.5; // STALE = ACTIVE row whose heartbeat is older than ttl × this

// Static lists used by both project-scoped and unassigned queries.
const SUPPORTED_TABLES = ['processes', 'tasks', 'blockers', 'outcomes', 'conflicts', 'dispatch_requests', 'checkpoints'];

// ---------------------------------------------------------------------------
// SQL placeholder helpers (better-sqlite3 needs explicit `?` lists)
// ---------------------------------------------------------------------------

function sqlInList(arr) {
  // For an array of length N, returns `(?, ?, ..., ?)` with N placeholders.
  // Caller spreads `arr` into bind params. If arr is empty, returns an
  // expression that matches no rows: `(NULL)` — which makes `x IN (NULL)`
  // always false in SQLite (NULL is incomparable with =).
  if (arr.length === 0) return '(NULL)';
  return '(' + arr.map(() => '?').join(',') + ')';
}

function emptyProjectSummary(dbPath) {
  return {
    available: false,
    db_path: dbPath || null,
    ts: Math.floor(Date.now() / 1000),
    agents_active: 0,
    agents_stale: 0,
    tasks_running: 0,
    tasks_blocked: 0,
    tasks_waiting_review: 0,
    tasks_failed: 0,
    blockers_open: 0,
    outcomes_failed: 0,
    outcomes_pending: 0,
    conflicts_open: 0,
    dispatches_recent_1h: 0,
    last_activity_at: 0,
    health: 'idle',
  };
}

function emptyUnassignedSummary(dbPath) {
  return {
    available: false,
    db_path: dbPath,
    ts: Math.floor(Date.now() / 1000),
    agents: 0,
    tasks: 0,
    blockers: 0,
    outcomes: 0,
    checkpoints: 0,
    conflicts: 0,
    dispatches: 0,
    total_rows: 0,
    last_activity_at: 0,
  };
}

// ---------------------------------------------------------------------------
// Per-project summary
// ---------------------------------------------------------------------------

/**
 * Compute the per-project summary card data.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {string} dbPath
 * @param {string[]} hints
 * @returns {ProjectScopedSummary}
 */
function queryProjectScopedSummary(db, tables, dbPath, hints) {
  const out = emptyProjectSummary(dbPath);
  if (!db) return out;
  out.available = true;

  const hintArr = Array.isArray(hints) ? hints : [];
  // With no hints, this project claims nothing → return zeros.
  if (hintArr.length === 0) {
    return computeHealth(out);
  }

  const inList = sqlInList(hintArr);
  const lastActivity = { value: 0 };
  const updateLastActivity = (ts) => {
    if (ts && ts > lastActivity.value) lastActivity.value = ts;
  };

  // processes — direct agent_id match
  if (tables.has('processes')) {
    try {
      const rows = db.prepare(
        `SELECT status, last_heartbeat, heartbeat_ttl FROM processes
          WHERE agent_id IN ${inList}`
      ).all(...hintArr);
      const now = Date.now();
      for (const r of rows) {
        const heartbeatExpired = (now - (r.last_heartbeat || 0))
                                  > (r.heartbeat_ttl || 60000) * STALE_GRACE_FACTOR;
        if (r.status === 'ACTIVE' && !heartbeatExpired) out.agents_active++;
        else if (r.status === 'ACTIVE' && heartbeatExpired) out.agents_stale++;
        // DEAD / IDLE rows are not counted in either bucket
        updateLastActivity(r.last_heartbeat);
      }
    } catch (_e) { /* graceful empty */ }
  }

  // tasks — created_by_agent_id ∈ hints; split state buckets
  /** @type {Set<string>} */
  let attributedTaskIds = new Set();
  if (tables.has('tasks')) {
    try {
      const rows = db.prepare(`
        SELECT task_id, state, updated_at FROM tasks
         WHERE created_by_agent_id IN ${inList}
      `).all(...hintArr);
      for (const r of rows) {
        attributedTaskIds.add(r.task_id);
        if (r.state === 'RUNNING') out.tasks_running++;
        else if (r.state === 'BLOCKED') out.tasks_blocked++;
        else if (r.state === 'WAITING_REVIEW') out.tasks_waiting_review++;
        else if (r.state === 'FAILED') out.tasks_failed++;
        updateLastActivity(r.updated_at);
      }
    } catch (_e) { /* graceful empty */ }
  }

  // blockers — JOIN tasks; OPEN count + last activity (raised_at / answered_at)
  if (tables.has('blockers') && attributedTaskIds.size > 0) {
    try {
      const taskInList = sqlInList([...attributedTaskIds]);
      const rows = db.prepare(`
        SELECT status, raised_at, answered_at FROM blockers
         WHERE task_id IN ${taskInList}
      `).all(...attributedTaskIds);
      for (const r of rows) {
        if (r.status === 'OPEN') out.blockers_open++;
        const ts = r.answered_at || r.raised_at;
        updateLastActivity(ts);
      }
    } catch (_e) { /* graceful empty */ }
  }

  // outcomes — JOIN tasks; FAIL/TERMINAL_FAIL + PENDING counts
  if (tables.has('outcomes') && attributedTaskIds.size > 0) {
    try {
      const taskInList = sqlInList([...attributedTaskIds]);
      const rows = db.prepare(`
        SELECT status, evaluated_at, updated_at FROM outcomes
         WHERE task_id IN ${taskInList}
      `).all(...attributedTaskIds);
      for (const r of rows) {
        if (r.status === 'FAIL' || r.status === 'TERMINAL_FAIL') out.outcomes_failed++;
        else if (r.status === 'PENDING') out.outcomes_pending++;
        updateLastActivity(r.evaluated_at || r.updated_at);
      }
    } catch (_e) { /* graceful empty */ }
  }

  // conflicts — agent_a ∈ hints OR agent_b ∈ hints
  if (tables.has('conflicts')) {
    try {
      const rows = db.prepare(`
        SELECT status, detected_at, resolved_at FROM conflicts
         WHERE agent_a IN ${inList} OR agent_b IN ${inList}
      `).all(...hintArr, ...hintArr);
      for (const r of rows) {
        if (r.status === 'OPEN' || r.status === 'PENDING_REVIEW') out.conflicts_open++;
        updateLastActivity(r.resolved_at || r.detected_at);
      }
    } catch (_e) { /* graceful empty */ }
  }

  // dispatch_requests — target_agent ∈ hints OR task_id ∈ attributed
  if (tables.has('dispatch_requests')) {
    try {
      const cutoff = Date.now() - 3600 * 1000;
      const taskInList = attributedTaskIds.size > 0
        ? sqlInList([...attributedTaskIds])
        : '(NULL)';
      const params = attributedTaskIds.size > 0
        ? [...hintArr, ...attributedTaskIds]
        : [...hintArr];
      const rows = db.prepare(`
        SELECT created_at, confirmed_at FROM dispatch_requests
         WHERE (target_agent IN ${inList}
                ${attributedTaskIds.size > 0 ? `OR task_id IN ${taskInList}` : ''})
      `).all(...params);
      for (const r of rows) {
        if (r.created_at >= cutoff) out.dispatches_recent_1h++;
        updateLastActivity(r.confirmed_at || r.created_at);
      }
    } catch (_e) { /* graceful empty */ }
  }

  out.last_activity_at = lastActivity.value;
  return computeHealth(out);
}

function computeHealth(s) {
  if ((s.conflicts_open || 0) > 0 || (s.outcomes_failed || 0) > 0 || (s.tasks_failed || 0) > 0) {
    s.health = 'alert';
  } else if (
    (s.blockers_open || 0) > 0
    || (s.tasks_waiting_review || 0) > 0
    || (s.agents_stale || 0) > 0
  ) {
    // Stale agents (ACTIVE rows with expired heartbeat past STALE_GRACE_FACTOR)
    // mean a runner that claimed presence but stopped heartbeating without a
    // clean shutdown. That is not "idle" — surface as warn so the project
    // card and tray reflect "something is off" instead of green.
    s.health = 'warn';
  } else {
    s.health = 'idle';
  }
  return s;
}

// ---------------------------------------------------------------------------
// Per-DB Unassigned summary
// ---------------------------------------------------------------------------

/**
 * Compute the Unassigned bucket for a single db_path. Counts rows that
 * are NOT attributed to any project's hints sharing this DB.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {string} dbPath
 * @param {Set<string>} allHints  Union of all hints across every project pointing at this dbPath
 * @returns {UnassignedSummary}
 */
function queryUnassignedSummary(db, tables, dbPath, allHints) {
  const out = emptyUnassignedSummary(dbPath);
  if (!db) return out;
  out.available = true;

  const hintArr = [...(allHints || new Set())];
  // If no hints at all, EVERY row is unassigned.
  const hasHints = hintArr.length > 0;
  const inList = hasHints ? sqlInList(hintArr) : '(NULL)';

  const lastActivity = { value: 0 };
  const updateLastActivity = (ts) => {
    if (ts && ts > lastActivity.value) lastActivity.value = ts;
  };

  // processes — agent_id NOT IN hints (or all if no hints)
  if (tables.has('processes')) {
    try {
      const sql = hasHints
        ? `SELECT agent_id, last_heartbeat FROM processes WHERE agent_id NOT IN ${inList}`
        : `SELECT agent_id, last_heartbeat FROM processes`;
      const rows = db.prepare(sql).all(...(hasHints ? hintArr : []));
      out.agents = rows.length;
      for (const r of rows) updateLastActivity(r.last_heartbeat);
    } catch (_e) { /* graceful empty */ }
  }

  // tasks — created_by_agent_id NOT IN hints (or NULL); track unassigned task_ids
  /** @type {Set<string>} */
  const unassignedTaskIds = new Set();
  if (tables.has('tasks')) {
    try {
      const sql = hasHints
        ? `SELECT task_id, updated_at FROM tasks
            WHERE created_by_agent_id IS NULL OR created_by_agent_id NOT IN ${inList}`
        : `SELECT task_id, updated_at FROM tasks`;
      const rows = db.prepare(sql).all(...(hasHints ? hintArr : []));
      out.tasks = rows.length;
      for (const r of rows) {
        unassignedTaskIds.add(r.task_id);
        updateLastActivity(r.updated_at);
      }
    } catch (_e) { /* graceful empty */ }
  }

  // blockers — task_id IN unassigned tasks OR no task at all
  if (tables.has('blockers')) {
    try {
      let rows;
      if (unassignedTaskIds.size > 0) {
        const taskInList = sqlInList([...unassignedTaskIds]);
        rows = db.prepare(`
          SELECT raised_at, answered_at FROM blockers
           WHERE task_id IN ${taskInList}
        `).all(...unassignedTaskIds);
      } else {
        rows = [];
      }
      out.blockers = rows.length;
      for (const r of rows) updateLastActivity(r.answered_at || r.raised_at);
    } catch (_e) { /* graceful empty */ }
  }

  // outcomes — task_id IN unassigned tasks
  if (tables.has('outcomes')) {
    try {
      let rows;
      if (unassignedTaskIds.size > 0) {
        const taskInList = sqlInList([...unassignedTaskIds]);
        rows = db.prepare(`
          SELECT evaluated_at, updated_at FROM outcomes
           WHERE task_id IN ${taskInList}
        `).all(...unassignedTaskIds);
      } else {
        rows = [];
      }
      out.outcomes = rows.length;
      for (const r of rows) updateLastActivity(r.evaluated_at || r.updated_at);
    } catch (_e) { /* graceful empty */ }
  }

  // checkpoints — task_id IS NULL OR task_id IN unassigned
  if (tables.has('checkpoints')) {
    try {
      const candidates = unassignedTaskIds.size > 0
        ? sqlInList([...unassignedTaskIds])
        : '(NULL)';
      const params = [...unassignedTaskIds];
      const rows = db.prepare(`
        SELECT created_at, ready_at FROM checkpoints
         WHERE task_id IS NULL OR task_id IN ${candidates}
      `).all(...params);
      out.checkpoints = rows.length;
      for (const r of rows) updateLastActivity(r.ready_at || r.created_at);
    } catch (_e) { /* graceful empty */ }
  }

  // conflicts — neither agent_a nor agent_b in hints
  if (tables.has('conflicts')) {
    try {
      const sql = hasHints
        ? `SELECT detected_at, resolved_at FROM conflicts
            WHERE agent_a NOT IN ${inList}
              AND (agent_b IS NULL OR agent_b NOT IN ${inList})`
        : `SELECT detected_at, resolved_at FROM conflicts`;
      const rows = db.prepare(sql).all(...(hasHints ? [...hintArr, ...hintArr] : []));
      out.conflicts = rows.length;
      for (const r of rows) updateLastActivity(r.resolved_at || r.detected_at);
    } catch (_e) { /* graceful empty */ }
  }

  // dispatch_requests — target_agent NOT IN hints AND task_id not attributed
  if (tables.has('dispatch_requests')) {
    try {
      const sql = hasHints
        ? `SELECT created_at, confirmed_at FROM dispatch_requests
            WHERE (target_agent IS NULL OR target_agent NOT IN ${inList})
              AND (task_id IS NULL OR task_id NOT IN (
                    SELECT task_id FROM tasks
                     WHERE created_by_agent_id IN ${inList}))`
        : `SELECT created_at, confirmed_at FROM dispatch_requests`;
      const rows = db.prepare(sql).all(...(hasHints ? [...hintArr, ...hintArr] : []));
      out.dispatches = rows.length;
      for (const r of rows) updateLastActivity(r.confirmed_at || r.created_at);
    } catch (_e) { /* graceful empty */ }
  }

  out.total_rows = out.agents + out.tasks + out.blockers + out.outcomes
                 + out.checkpoints + out.conflicts + out.dispatches;
  out.last_activity_at = lastActivity.value;
  return out;
}

// ---------------------------------------------------------------------------
// Sessions (per-project) + Unassigned detail (Day 3)
// ---------------------------------------------------------------------------

/**
 * Compute owns_tasks bucket for a set of agents in one query, keyed by
 * agent_id. Returns Map<agent_id, {RUNNING, BLOCKED, WAITING_REVIEW, DONE, FAILED}>.
 * agents not seen by this query simply absent from the map; callers
 * should default missing buckets to all-zeros.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Set<string>} tables
 * @param {string[]} agentIds
 * @returns {Map<string, {RUNNING:number,BLOCKED:number,WAITING_REVIEW:number,DONE:number,FAILED:number}>}
 */
function computeOwnsTasksByAgent(db, tables, agentIds) {
  const out = new Map();
  if (!db || !tables.has('tasks') || !agentIds.length) return out;
  try {
    const inList = sqlInList(agentIds);
    const rows = db.prepare(`
      SELECT created_by_agent_id AS agent_id, state, COUNT(*) AS n
        FROM tasks
       WHERE created_by_agent_id IN ${inList}
       GROUP BY created_by_agent_id, state
    `).all(...agentIds);
    for (const r of rows) {
      if (!out.has(r.agent_id)) {
        out.set(r.agent_id, { RUNNING: 0, BLOCKED: 0, WAITING_REVIEW: 0, DONE: 0, FAILED: 0 });
      }
      const bucket = out.get(r.agent_id);
      // Other states (PENDING / READY_TO_RESUME / CANCELLED) collapse to none
      // of the displayed buckets — sessions tab shows the 5 most useful.
      if (r.state in bucket) bucket[r.state] = r.n;
    }
  } catch (_e) { /* graceful empty */ }
  return out;
}

function deriveSessionState(row, now) {
  if (row.status === 'DEAD') return 'DEAD';
  const ttl = row.heartbeat_ttl || 60000;
  const expired = (now - (row.last_heartbeat || 0)) > ttl * STALE_GRACE_FACTOR;
  if (row.status === 'ACTIVE' && expired) return 'STALE';
  if (row.status === 'ACTIVE') return 'ACTIVE';
  return 'OTHER'; // IDLE or anything else
}

function parseCapabilities(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch (_e) { return []; }
}

function emptySessionPayload() {
  return { available: false, sessions: [], ts: Math.floor(Date.now() / 1000) };
}

/**
 * Sessions (presence rows) belonging to a project, attributed by
 * agent_id_hints. Used by the L2 Sessions tab.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {string[]} hints
 * @returns {{available:boolean, sessions:Array, ts:number}}
 */
function queryProjectScopedSessions(db, tables, hints) {
  const out = emptySessionPayload();
  if (!db || !tables.has('processes')) return out;
  out.available = true;
  const hintArr = Array.isArray(hints) ? hints : [];
  if (hintArr.length === 0) return out;

  let rows = [];
  try {
    const inList = sqlInList(hintArr);
    rows = db.prepare(`
      SELECT agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl
        FROM processes
       WHERE agent_id IN ${inList}
       ORDER BY last_heartbeat DESC
    `).all(...hintArr);
  } catch (_e) { return out; }

  const ownsMap = computeOwnsTasksByAgent(db, tables, rows.map(r => r.agent_id));
  const now = Date.now();
  out.sessions = rows.map(r => ({
    agent_id: r.agent_id,
    agent_type: r.agent_type || '?',
    status: r.status,
    computed_state: deriveSessionState(r, now),
    registered_at: r.registered_at,
    last_heartbeat: r.last_heartbeat,
    heartbeat_ttl: r.heartbeat_ttl || 60000,
    capabilities: parseCapabilities(r.capabilities),
    owns_tasks: ownsMap.get(r.agent_id) || { RUNNING: 0, BLOCKED: 0, WAITING_REVIEW: 0, DONE: 0, FAILED: 0 },
  }));
  return out;
}

/**
 * Detail view for an Unassigned bucket. Includes the same scalar counts
 * as queryUnassignedSummary plus a list of unassigned agents (process
 * rows whose agent_id is in NO project's hints) — that list is the
 * primary signal users want when looking at Unassigned (which agent
 * should I add to which project?).
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {string} dbPath
 * @param {Set<string>} allHints   union of hints across every project on this db_path
 * @returns {object}
 */
function queryUnassignedDetail(db, tables, dbPath, allHints) {
  const summary = queryUnassignedSummary(db, tables, dbPath, allHints);
  const out = {
    ...summary,
    agents: [],
  };
  if (!db || !tables.has('processes')) return out;

  const hintArr = [...(allHints || new Set())];
  const hasHints = hintArr.length > 0;

  let rows = [];
  try {
    const sql = hasHints
      ? `SELECT agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl
           FROM processes
          WHERE agent_id NOT IN ${sqlInList(hintArr)}
          ORDER BY last_heartbeat DESC`
      : `SELECT agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl
           FROM processes
          ORDER BY last_heartbeat DESC`;
    rows = db.prepare(sql).all(...(hasHints ? hintArr : []));
  } catch (_e) { return out; }

  const ownsMap = computeOwnsTasksByAgent(db, tables, rows.map(r => r.agent_id));
  const now = Date.now();
  out.agents = rows.map(r => ({
    agent_id: r.agent_id,
    agent_type: r.agent_type || '?',
    status: r.status,
    computed_state: deriveSessionState(r, now),
    registered_at: r.registered_at,
    last_heartbeat: r.last_heartbeat,
    heartbeat_ttl: r.heartbeat_ttl || 60000,
    capabilities: parseCapabilities(r.capabilities),
    owns_tasks: ownsMap.get(r.agent_id) || { RUNNING: 0, BLOCKED: 0, WAITING_REVIEW: 0, DONE: 0, FAILED: 0 },
  }));
  return out;
}

module.exports = {
  queryProjectScopedSummary,
  queryUnassignedSummary,
  queryProjectScopedSessions,
  queryUnassignedDetail,
  deriveSessionState,
  parseCapabilities,
  computeOwnsTasksByAgent,
  computeHealth,
  STALE_GRACE_FACTOR,
  SUPPORTED_TABLES,
};
