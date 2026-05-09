'use strict';

const path = require('path');

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

// ---------------------------------------------------------------------------
// Project-scoped tasks list with per-task aggregates (Day 5)
// ---------------------------------------------------------------------------

const PROJECT_TASKS_LIMIT = 200;

/**
 * Fetch tasks attributed to a project (`created_by_agent_id IN hints`),
 * enriched with the per-task counts the L2 task tree displays:
 *   - blockers_total, blockers_open
 *   - outcome (status only — full outcome row is fetched on detail expand)
 *   - checkpoints_total
 *
 * Returns a flat array; the renderer builds the tree from parent_task_id.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {string[]} hints
 * @param {number} [limit]
 * @returns {{available:boolean, hints_empty:boolean, tasks:Array}}
 */
function queryProjectScopedTasks(db, tables, hints, limit) {
  const hintArr = Array.isArray(hints) ? hints : [];
  const lim = Math.max(1, Math.min(limit || PROJECT_TASKS_LIMIT, 1000));
  const out = { available: false, hints_empty: hintArr.length === 0, tasks: [] };
  if (!db || !tables.has('tasks')) return out;
  out.available = true;
  if (out.hints_empty) return out;

  let rows = [];
  try {
    const inList = sqlInList(hintArr);
    rows = db.prepare(`
      SELECT task_id, parent_task_id, state, intent,
             created_at, updated_at, created_by_agent_id, metadata_json
        FROM tasks
       WHERE created_by_agent_id IN ${inList}
       ORDER BY
         CASE state
           WHEN 'FAILED'           THEN 1
           WHEN 'BLOCKED'          THEN 2
           WHEN 'WAITING_REVIEW'   THEN 3
           WHEN 'RUNNING'          THEN 4
           WHEN 'READY_TO_RESUME'  THEN 5
           WHEN 'PENDING'          THEN 6
           WHEN 'DONE'             THEN 7
           WHEN 'CANCELLED'        THEN 8
           ELSE 9
         END,
         updated_at DESC
       LIMIT ?
    `).all(...hintArr, lim);
  } catch (_e) { return out; }

  if (rows.length === 0) { out.tasks = []; return out; }

  const taskIds = rows.map(r => r.task_id);
  const taskInList = sqlInList(taskIds);

  // Batched aggregates — three small queries vs N+1.
  /** @type {Map<string,{open:number,total:number}>} */
  const blockerMap = new Map();
  if (tables.has('blockers')) {
    try {
      const brows = db.prepare(`
        SELECT task_id, status, COUNT(*) AS n
          FROM blockers
         WHERE task_id IN ${taskInList}
         GROUP BY task_id, status
      `).all(...taskIds);
      for (const b of brows) {
        if (!blockerMap.has(b.task_id)) blockerMap.set(b.task_id, { open: 0, total: 0 });
        const entry = blockerMap.get(b.task_id);
        entry.total += b.n;
        if (b.status === 'OPEN') entry.open += b.n;
      }
    } catch (_e) { /* leave empty */ }
  }

  /** @type {Map<string,string>} task_id → outcome status */
  const outcomeMap = new Map();
  if (tables.has('outcomes')) {
    try {
      const orows = db.prepare(`
        SELECT task_id, status FROM outcomes WHERE task_id IN ${taskInList}
      `).all(...taskIds);
      for (const o of orows) outcomeMap.set(o.task_id, o.status);
    } catch (_e) { /* leave empty */ }
  }

  /** @type {Map<string,number>} */
  const ckptMap = new Map();
  if (tables.has('checkpoints')) {
    try {
      const crows = db.prepare(`
        SELECT task_id, COUNT(*) AS n FROM checkpoints
         WHERE task_id IN ${taskInList}
         GROUP BY task_id
      `).all(...taskIds);
      for (const c of crows) ckptMap.set(c.task_id, c.n);
    } catch (_e) { /* leave empty */ }
  }

  out.tasks = rows.map(r => {
    const b = blockerMap.get(r.task_id) || { open: 0, total: 0 };
    return {
      task_id: r.task_id,
      parent_task_id: r.parent_task_id || null,
      state: r.state,
      intent: r.intent,
      created_at: r.created_at,
      updated_at: r.updated_at,
      created_by_agent_id: r.created_by_agent_id || null,
      blockers_total: b.total,
      blockers_open: b.open,
      outcome_status: outcomeMap.get(r.task_id) || null,
      checkpoints_total: ckptMap.get(r.task_id) || 0,
    };
  });
  return out;
}

// ---------------------------------------------------------------------------
// Real Agent Presence v2 — capability-tag-based project attribution
// ---------------------------------------------------------------------------
//
// Identity model (post Real Agent Presence v2, 2026-05-08):
//   - mcp-server's SESSION_AGENT_ID is a per-process random
//     `cairn-session-<12hex>` (session-level, not project-level).
//     Two terminal sessions in the same git repo therefore produce
//     two distinct rows in the `processes` table.
//   - Project attribution is no longer derivable from agent_id alone.
//     mcp-server emits descriptive capability tags on every register:
//         client:mcp-server
//         cwd:<process cwd>
//         git_root:<git toplevel of cwd, or cwd if not in a git repo>
//         pid:<process.pid>
//         host:<hostname>
//         session:<12hex>
//   - The desktop panel attributes a process row to a registered
//     project by matching `git_root:<...>` (preferred, exact) or
//     `cwd:<...>` (project_root ≤ cwd) tags against
//     project.project_root, with case/slash normalization on Windows.
//   - registry's `agent_id_hints` continues to work as a manual /
//     historical attribution mechanism (legacy project-level ids,
//     "Add to project…" entries, etc.). Final attribution = the
//     union of capability-matched and hint-matched agent_ids.
//
// All helpers here are pure / read-only.

/**
 * Normalize a filesystem path for cross-platform comparison.
 * - Replace backslashes with forward slashes.
 * - Lowercase on Windows (case-insensitive paths).
 * - Trim trailing slash (keep root).
 *
 * @param {string|null|undefined} p
 * @returns {string}
 */
function normalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  let n = p.replace(/\\/g, '/');
  if (process.platform === 'win32') n = n.toLowerCase();
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

/**
 * Returns true if `child` is the same path as `parent`, or a path
 * inside `parent`. Both inputs go through normalizePath first.
 */
function pathInsideOrEqual(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + '/');
}

/**
 * Parse a `key:value` capability tag string into {key, value}, or
 * return null for non-tag entries (free-form feature strings).
 */
function parseCapabilityTag(s) {
  if (typeof s !== 'string') return null;
  const idx = s.indexOf(':');
  if (idx <= 0) return null;
  return { key: s.slice(0, idx), value: s.slice(idx + 1) };
}

/**
 * Decide whether a process row's capability tags attribute it to a
 * project. Order:
 *   1. `git_root:<path>` exact match (preferred — git toplevels are
 *      canonical and stable across subdir cwds).
 *   2. `cwd:<path>` is inside or equal to project_root.
 * Returns false when capabilities is missing or no tag matches.
 *
 * @param {string[]|null|undefined} capabilities
 * @param {string} projectRoot
 * @returns {boolean}
 */
function capabilitiesMatchProject(capabilities, projectRoot) {
  if (!Array.isArray(capabilities) || !projectRoot) return false;
  if (projectRoot === '(unknown)') return false;
  const projN = normalizePath(projectRoot);
  if (!projN) return false;
  for (const tag of capabilities) {
    const kv = parseCapabilityTag(tag);
    if (!kv) continue;
    if (kv.key === 'git_root' && normalizePath(kv.value) === projN) return true;
    if (kv.key === 'cwd' && pathInsideOrEqual(kv.value, projectRoot)) return true;
  }
  return false;
}

/**
 * Read every process row in this DB (all statuses, including DEAD —
 * staleness is computed at render time). Used by the attribution
 * resolver. Returns an empty array on missing table / error so
 * the caller never has to special-case the unattributed path.
 */
function readAllProcessRowsForAttribution(db, tables) {
  if (!db || !tables.has('processes')) return [];
  try {
    return db.prepare(`
      SELECT agent_id, capabilities, status, last_heartbeat
        FROM processes
    `).all();
  } catch (_e) { return []; }
}

/**
 * Resolve the full set of agent_ids attributable to a project.
 *
 * Inputs:
 *   - project = { project_root, agent_id_hints }
 *
 * Output: an array of unique agent_ids = hints ∪ {process.agent_id
 * whose capabilities match project_root}. The order (hints first)
 * is deterministic but not semantically meaningful — callers treat
 * it as a set.
 *
 * Notes:
 *   - When project_root is "(unknown)" or empty, only hints count
 *     (capability matching requires a real path to compare against).
 *   - DEAD-status sessions still attribute (the panel decides
 *     whether to render them). This keeps the attribution surface
 *     stable across heartbeat windows.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {{project_root:string, agent_id_hints?:string[]}} project
 * @returns {string[]}
 */
function resolveProjectAgentIds(db, tables, project) {
  const set = new Set();
  const hints = (project && Array.isArray(project.agent_id_hints))
    ? project.agent_id_hints
    : [];
  for (const h of hints) if (h) set.add(h);

  const projectRoot = project && project.project_root ? project.project_root : '';
  if (!projectRoot || projectRoot === '(unknown)') {
    return [...set];
  }
  const rows = readAllProcessRowsForAttribution(db, tables);
  for (const r of rows) {
    let caps = null;
    if (r.capabilities) {
      try { caps = JSON.parse(r.capabilities); } catch (_e) { caps = null; }
    }
    if (capabilitiesMatchProject(caps, projectRoot)) set.add(r.agent_id);
  }
  return [...set];
}

/**
 * Resolve the attributed-id union across every registered project
 * pointing at `dbPath`. Used by the Unassigned bucket: anything in
 * this DB that is NOT in this union is unassigned.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {Array<{project_root:string, db_path:string, agent_id_hints?:string[]}>} projects
 * @param {string} dbPath
 * @returns {Set<string>}
 */
function resolveAttributedAgentIdsForDb(db, tables, projects, dbPath) {
  const out = new Set();
  if (!Array.isArray(projects)) return out;
  for (const p of projects) {
    if (!p || p.db_path !== dbPath) continue;
    for (const id of resolveProjectAgentIds(db, tables, p)) out.add(id);
  }
  return out;
}

/**
 * Project-scoped checkpoint list. Returns checkpoints anchored to
 * tasks attributed to this project, sorted by COALESCE(ready_at,
 * created_at) DESC. Strict read-only.
 *
 * Why this query exists separately from queryTaskCheckpoints:
 *   - For the project Recovery Card we need ALL of the project's
 *     checkpoints in one shot (cross-task), not per-task.
 *   - We also want a per-row view that includes the owning task's
 *     intent + state, so the Recovery Card can show
 *     "T-001 RUNNING — auth refactor" alongside the checkpoint.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {string[]} hints   project's effective agent_ids (resolveProjectAgentIds output)
 * @param {number} [limit]   default 50
 * @returns {Array<{id:string, label:string|null, snapshot_status:string,
 *                  git_head:string|null, size_bytes:number|null,
 *                  created_at:number, ready_at:number|null,
 *                  task_id:string|null, task_intent:string|null,
 *                  task_state:string|null}>}
 */
function queryProjectScopedCheckpoints(db, tables, hints, limit) {
  if (!db || !tables.has('checkpoints')) return [];
  const hintArr = Array.isArray(hints) ? hints : [];
  if (hintArr.length === 0) return [];
  const lim = Math.max(1, Math.min(limit || 50, 200));

  // Step 1: attributed task ids.
  let taskRows;
  try {
    const inList = sqlInList(hintArr);
    taskRows = db.prepare(`
      SELECT task_id, intent, state FROM tasks
       WHERE created_by_agent_id IN ${inList}
    `).all(...hintArr);
  } catch (_e) { return []; }
  if (taskRows.length === 0) return [];

  /** @type {Map<string, {intent:string|null, state:string|null}>} */
  const taskMap = new Map();
  const taskIds = [];
  for (const t of taskRows) {
    taskMap.set(t.task_id, { intent: t.intent || null, state: t.state || null });
    taskIds.push(t.task_id);
  }

  // Step 2: checkpoints for those tasks.
  let ckptRows;
  try {
    const taskInList = sqlInList(taskIds);
    ckptRows = db.prepare(`
      SELECT id, label, snapshot_status, git_head, size_bytes, created_at, ready_at, task_id
        FROM checkpoints
       WHERE task_id IN ${taskInList}
       ORDER BY COALESCE(ready_at, created_at) DESC
       LIMIT ?
    `).all(...taskIds, lim);
  } catch (_e) { return []; }

  return ckptRows.map(r => {
    const t = taskMap.get(r.task_id) || { intent: null, state: null };
    return {
      id: r.id,
      label: r.label,
      snapshot_status: r.snapshot_status,
      git_head: r.git_head,
      size_bytes: r.size_bytes,
      created_at: r.created_at,
      ready_at: r.ready_at,
      task_id: r.task_id,
      task_intent: t.intent,
      task_state: t.state,
    };
  });
}

/**
 * Project-scoped scratchpad list. Returns scratchpad rows whose
 * task_id is attributed to this project, sorted by updated_at DESC.
 * Strict read-only.
 *
 * Schema (migration 002): scratchpad(key, value_json, value_path,
 * task_id, expires_at, created_at, updated_at). Task_id is FK to
 * tasks(task_id) — we filter by task_id ∈ project tasks. Untagged
 * (task_id IS NULL) entries do NOT come back in project-scoped
 * results — they belong to the Unassigned bucket conceptually.
 *
 * The handoff surface only needs metadata + a short preview, not
 * the whole value. We emit `value_preview` (first 240 chars of the
 * JSON-stringified value) and `value_size` so the panel can show
 * what's there without rendering the full payload by default.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {string[]} hints
 * @param {number} [limit]
 * @returns {Array<{key:string, task_id:string|null, updated_at:number,
 *                  created_at:number, expires_at:number|null,
 *                  value_size:number, value_preview:string|null,
 *                  has_value_path:boolean,
 *                  task_intent:string|null, task_state:string|null}>}
 */
function queryProjectScopedScratchpad(db, tables, hints, limit) {
  if (!db || !tables.has('scratchpad')) return [];
  const hintArr = Array.isArray(hints) ? hints : [];
  if (hintArr.length === 0) return [];
  const lim = Math.max(1, Math.min(limit || 50, 200));

  // Step 1: attributed task ids (with intent + state for the panel).
  let taskRows;
  try {
    const inList = sqlInList(hintArr);
    taskRows = db.prepare(`
      SELECT task_id, intent, state FROM tasks
       WHERE created_by_agent_id IN ${inList}
    `).all(...hintArr);
  } catch (_e) { return []; }
  if (taskRows.length === 0) return [];

  /** @type {Map<string, {intent:string|null, state:string|null}>} */
  const taskMap = new Map();
  const taskIds = [];
  for (const t of taskRows) {
    taskMap.set(t.task_id, { intent: t.intent || null, state: t.state || null });
    taskIds.push(t.task_id);
  }

  // Step 2: scratchpad rows for those tasks.
  let rows;
  try {
    const taskInList = sqlInList(taskIds);
    rows = db.prepare(`
      SELECT key, value_json, value_path, task_id, expires_at, created_at, updated_at
        FROM scratchpad
       WHERE task_id IN ${taskInList}
       ORDER BY updated_at DESC
       LIMIT ?
    `).all(...taskIds, lim);
  } catch (_e) { return []; }

  return rows.map(r => {
    const t = taskMap.get(r.task_id) || { intent: null, state: null };
    const valueStr = typeof r.value_json === 'string' ? r.value_json : '';
    return {
      key:           r.key,
      task_id:       r.task_id,
      task_intent:   t.intent,
      task_state:    t.state,
      created_at:    r.created_at,
      updated_at:    r.updated_at,
      expires_at:    r.expires_at,
      value_size:    valueStr.length,
      value_preview: valueStr ? valueStr.slice(0, 240) : null,
      has_value_path: !!r.value_path,
    };
  });
}

/**
 * Project-scoped conflicts. Returns OPEN / PENDING_REVIEW / RESOLVED
 * conflicts whose either party (agent_a / agent_b) is in the project's
 * effective agent_ids. Sorted by detected_at DESC.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {string[]} hints
 * @param {number} [limit]
 * @returns {Array<{id:string, detected_at:number, conflict_type:string,
 *                  agent_a:string, agent_b:string|null, paths:string[],
 *                  summary:string|null, status:string,
 *                  resolved_at:number|null, resolution:string|null}>}
 */
function queryProjectScopedConflicts(db, tables, hints, limit) {
  if (!db || !tables.has('conflicts')) return [];
  const hintArr = Array.isArray(hints) ? hints : [];
  if (hintArr.length === 0) return [];
  const lim = Math.max(1, Math.min(limit || 50, 200));
  let rows;
  try {
    const inList = sqlInList(hintArr);
    rows = db.prepare(`
      SELECT id, detected_at, conflict_type, agent_a, agent_b,
             paths_json, summary, status, resolved_at, resolution
        FROM conflicts
       WHERE agent_a IN ${inList}
          OR (agent_b IS NOT NULL AND agent_b IN ${inList})
       ORDER BY detected_at DESC
       LIMIT ?
    `).all(...hintArr, ...hintArr, lim);
  } catch (_e) { return []; }
  return rows.map(r => {
    let paths = [];
    if (r.paths_json) {
      try { const v = JSON.parse(r.paths_json); if (Array.isArray(v)) paths = v.map(String); }
      catch (_e) { /* tolerate malformed */ }
    }
    return {
      id:           r.id,
      detected_at:  r.detected_at,
      conflict_type: r.conflict_type,
      agent_a:      r.agent_a,
      agent_b:      r.agent_b || null,
      paths,
      summary:      r.summary || null,
      status:       r.status,
      resolved_at:  r.resolved_at || null,
      resolution:   r.resolution || null,
    };
  });
}

/**
 * Project-scoped recent blockers (used by the coordination layer).
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {string[]} hints
 * @param {number} [limit]
 */
function queryProjectScopedBlockers(db, tables, hints, limit) {
  if (!db || !tables.has('blockers')) return [];
  const hintArr = Array.isArray(hints) ? hints : [];
  if (hintArr.length === 0) return [];
  const lim = Math.max(1, Math.min(limit || 50, 200));
  // Join via attributed tasks.
  let taskRows;
  try {
    const inList = sqlInList(hintArr);
    taskRows = db.prepare(`SELECT task_id FROM tasks WHERE created_by_agent_id IN ${inList}`).all(...hintArr);
  } catch (_e) { return []; }
  if (taskRows.length === 0) return [];
  const ids = taskRows.map(r => r.task_id);
  try {
    const taskInList = sqlInList(ids);
    return db.prepare(`
      SELECT id, task_id, status, raised_at, answered_at, question, answer,
             raised_by, answered_by
        FROM blockers
       WHERE task_id IN ${taskInList}
       ORDER BY COALESCE(answered_at, raised_at) DESC
       LIMIT ?
    `).all(...ids, lim);
  } catch (_e) { return []; }
}

/**
 * Project-scoped outcomes (used by the coordination layer).
 */
function queryProjectScopedOutcomes(db, tables, hints, limit) {
  if (!db || !tables.has('outcomes')) return [];
  const hintArr = Array.isArray(hints) ? hints : [];
  if (hintArr.length === 0) return [];
  const lim = Math.max(1, Math.min(limit || 50, 200));
  let taskRows;
  try {
    const inList = sqlInList(hintArr);
    taskRows = db.prepare(`SELECT task_id FROM tasks WHERE created_by_agent_id IN ${inList}`).all(...hintArr);
  } catch (_e) { return []; }
  if (taskRows.length === 0) return [];
  const ids = taskRows.map(r => r.task_id);
  try {
    const taskInList = sqlInList(ids);
    return db.prepare(`
      SELECT outcome_id, task_id, status, evaluated_at, evaluation_summary,
             grader_agent_id, created_at, updated_at
        FROM outcomes
       WHERE task_id IN ${taskInList}
       ORDER BY COALESCE(evaluated_at, updated_at) DESC
       LIMIT ?
    `).all(...ids, lim);
  } catch (_e) { return []; }
}

module.exports = {
  queryProjectScopedSummary,
  queryUnassignedSummary,
  queryProjectScopedSessions,
  queryUnassignedDetail,
  queryProjectScopedTasks,
  queryProjectScopedCheckpoints,
  queryProjectScopedScratchpad,
  queryProjectScopedConflicts,
  queryProjectScopedBlockers,
  queryProjectScopedOutcomes,
  deriveSessionState,
  parseCapabilities,
  computeOwnsTasksByAgent,
  computeHealth,
  STALE_GRACE_FACTOR,
  SUPPORTED_TABLES,
  PROJECT_TASKS_LIMIT,
  // Attribution v2:
  normalizePath,
  pathInsideOrEqual,
  parseCapabilityTag,
  capabilitiesMatchProject,
  resolveProjectAgentIds,
  resolveAttributedAgentIdsForDb,
};
