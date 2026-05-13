'use strict';

/**
 * Cockpit state aggregator — Phase 1 of panel-cockpit-redesign.
 *
 * Single-project cockpit payload. Consumes the same `agent_id_hints`
 * attribution model that `project-queries.cjs` uses. Returns the
 * shape rendered by panel.js's 5 cockpit modules:
 *
 *   Module 1 — STATE STRIP    → autopilot_status + current_task + latest_mentor_nudge
 *   Module 2 — STEER          → leader + agents (target candidates)
 *   Module 3 — ACTIVITY FEED  → merged time-ordered events (8 sources)
 *   Module 4 — SAFETY/REWIND  → checkpoints
 *   Module 5 — NEEDS YOU      → escalations (status='PENDING')
 *
 * Strict read-only. Never INSERT/UPDATE/DELETE here.
 *
 * Activity event sources (Phase 1 plan §10 Q1 decision: reuse existing
 * tables + scratchpad keys; NO new migration):
 *   - processes / tasks / dispatch_requests / conflicts / blockers /
 *     outcomes / checkpoints (existing tables; row timestamps drive
 *     "kind" events)
 *   - scratchpad keys matching `mentor/<project_id>/nudge/<ulid>`
 *     (written by Phase 5 supervisor; cockpit reads here)
 *   - scratchpad keys matching `escalation/<project_id>/<ulid>`
 *     (Phase 5 escalation surface)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of activity events returned per call. */
const ACTIVITY_LIMIT_DEFAULT = 60;
/** Default number of checkpoints surfaced for Module 4. */
const CHECKPOINT_LIMIT_DEFAULT = 10;
/** Default number of escalations surfaced for Module 5 (PENDING only). */
const ESCALATION_LIMIT_DEFAULT = 25;

/** Autopilot status enum — drives Module 1's color + copy. */
const AUTOPILOT_STATUS = {
  NO_GOAL: 'NO_GOAL',                         // grey: project has no goal → Mentor can't run
  AGENT_IDLE: 'AGENT_IDLE',                   // grey: no agent process active
  AGENT_WORKING: 'AGENT_WORKING',             // green: agent ACTIVE + no pending escalation
  MENTOR_BLOCKED_NEED_USER: 'MENTOR_BLOCKED_NEED_USER', // red: ≥1 PENDING escalation
};

const SUPPORTED_TABLES = [
  'processes', 'tasks', 'blockers', 'outcomes',
  'conflicts', 'dispatch_requests', 'checkpoints', 'scratchpad',
];

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

// Schema-v2 CAIRN.md profile reader — mtime-gated cache via loadProfile,
// surfaces ## Whole sentence into cockpit state for Module 1 rendering.
const profileMod = require('./mentor-project-profile.cjs');

function sqlInList(arr) {
  if (!arr || arr.length === 0) return '(NULL)';
  return '(' + arr.map(() => '?').join(',') + ')';
}

// ---------------------------------------------------------------------------
// Empty payload for projects with no attribution / no DB
// ---------------------------------------------------------------------------

function emptyCockpitState(project, dbPath, reason) {
  return {
    project: project ? {
      id: project.id, label: project.label,
      project_root: project.project_root, db_path: dbPath || null,
    } : null,
    goal: null,
    leader: (project && project.leader) || null,
    autopilot_status: AUTOPILOT_STATUS.AGENT_IDLE,
    autopilot_reason: reason || 'no_data',
    agents: [],
    progress: {
      tasks_total: 0, tasks_done: 0, tasks_running: 0,
      tasks_blocked: 0, tasks_waiting_review: 0, percent: 0,
    },
    current_task: null,
    latest_mentor_nudge: null,
    activity: [],
    checkpoints: [],
    escalations: [],
    ts: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Sub-queries (each scoped to project's agent_id_hints)
// ---------------------------------------------------------------------------

function queryProgress(db, tables, hints) {
  if (!tables.has('tasks') || hints.length === 0) {
    return {
      tasks_total: 0, tasks_done: 0, tasks_running: 0,
      tasks_blocked: 0, tasks_waiting_review: 0, percent: 0,
    };
  }
  const placeholders = sqlInList(hints);
  const row = db.prepare(`
    SELECT
      COUNT(*)                                             AS total,
      SUM(CASE WHEN state='DONE'           THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN state='RUNNING'        THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN state='BLOCKED'        THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN state='WAITING_REVIEW' THEN 1 ELSE 0 END) AS waiting_review
    FROM tasks
    WHERE created_by_agent_id IN ${placeholders}
  `).get(...hints);
  const total = row.total || 0;
  const done = row.done || 0;
  const percent = total > 0 ? Math.round((done / total) * 100) / 100 : 0;
  return {
    tasks_total: total,
    tasks_done: done,
    tasks_running: row.running || 0,
    tasks_blocked: row.blocked || 0,
    tasks_waiting_review: row.waiting_review || 0,
    percent,
  };
}

function queryCurrentTask(db, tables, hints) {
  if (!tables.has('tasks') || hints.length === 0) return null;
  const placeholders = sqlInList(hints);
  const row = db.prepare(`
    SELECT task_id, intent, state, created_by_agent_id, created_at, updated_at
    FROM tasks
    WHERE state='RUNNING' AND created_by_agent_id IN ${placeholders}
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(...hints);
  if (!row) return null;
  return {
    task_id: row.task_id,
    intent: row.intent,
    state: row.state,
    agent_id: row.created_by_agent_id,
    started_at: row.created_at,
    updated_at: row.updated_at,
    elapsed_ms: Date.now() - row.created_at,
  };
}

function queryAgents(db, tables, hints, now) {
  if (!tables.has('processes') || hints.length === 0) return [];
  const placeholders = sqlInList(hints);
  const rows = db.prepare(`
    SELECT agent_id, agent_type, status, last_heartbeat, heartbeat_ttl, registered_at
    FROM processes
    WHERE agent_id IN ${placeholders}
    ORDER BY last_heartbeat DESC
  `).all(...hints);
  // Cockpit Module 1 ⚡ count = LIVE only. Stale rows (effective DEAD)
  // are accumulated DB junk from past sessions — surfacing them all in
  // the panel made the count look "broken" (42 dead rows under one
  // project from months of dev work). The DB row is preserved; we just
  // hide it from the cockpit's "who's working right now" view.
  return rows
    .map(r => {
      const isStale = (r.last_heartbeat + r.heartbeat_ttl) < now;
      const effective = isStale ? 'DEAD' : r.status;
      return {
        agent_id: r.agent_id,
        agent_type: r.agent_type,
        status: effective,
        since: r.registered_at,
        last_heartbeat: r.last_heartbeat,
      };
    })
    .filter(a => a.status === 'ACTIVE' || a.status === 'IDLE');
}

function queryLatestMentorNudge(db, tables, projectId) {
  if (!tables.has('scratchpad') || !projectId) return null;
  const row = db.prepare(`
    SELECT key, value_json, updated_at
    FROM scratchpad
    WHERE key LIKE 'mentor/' || ? || '/nudge/%'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(projectId);
  if (!row) return null;
  let body = null;
  try { body = row.value_json ? JSON.parse(row.value_json) : null; } catch (_e) {}
  return {
    key: row.key,
    timestamp: row.updated_at,
    message: body && body.message ? body.message : (body && body.body ? body.body : null),
    to_agent_id: body && body.to_agent_id ? body.to_agent_id : null,
  };
}

function queryEscalations(db, tables, projectId, opts) {
  if (!tables.has('scratchpad') || !projectId) return [];
  const limit = (opts && opts.limit) || ESCALATION_LIMIT_DEFAULT;
  const rows = db.prepare(`
    SELECT key, value_json, created_at, updated_at
    FROM scratchpad
    WHERE key LIKE 'escalation/' || ? || '/%'
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(projectId, limit);
  const out = [];
  for (const r of rows) {
    let body = null;
    try { body = r.value_json ? JSON.parse(r.value_json) : null; } catch (_e) {}
    if (!body) continue;
    out.push({
      id: r.key.split('/').pop(),
      key: r.key,
      reason: body.reason || 'UNKNOWN',
      task_id: body.task_id || null,
      body: body.body || body.message || '',
      status: body.status || 'PENDING',
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  }
  return out;
}

function queryCheckpoints(db, tables, hints, opts) {
  if (!tables.has('checkpoints') || hints.length === 0) return [];
  const limit = (opts && opts.limit) || CHECKPOINT_LIMIT_DEFAULT;
  // checkpoints attribution: join via task_id → tasks.created_by_agent_id ∈ hints
  // OR task_id IS NULL with project-level capture (Phase 1 keeps strict join).
  const placeholders = sqlInList(hints);
  const rows = db.prepare(`
    SELECT c.id, c.task_id, c.git_head, c.created_at, c.snapshot_status, c.label
    FROM checkpoints c
    LEFT JOIN tasks t ON t.task_id = c.task_id
    WHERE c.task_id IS NOT NULL
      AND t.created_by_agent_id IN ${placeholders}
      AND c.snapshot_status = 'READY'
    ORDER BY c.created_at DESC
    LIMIT ?
  `).all(...hints, limit);
  return rows.map(r => ({
    id: r.id,
    task_id: r.task_id,
    git_head: r.git_head,
    created_at: r.created_at,
    label: r.label || null,
  }));
}

// ---------------------------------------------------------------------------
// Activity feed — merge 9 sources, time-order DESC, limit
// ---------------------------------------------------------------------------

function queryActivityFeed(db, tables, hints, projectId, opts) {
  const limit = (opts && opts.limit) || ACTIVITY_LIMIT_DEFAULT;
  const now = Date.now();
  // Pull a generous window per source then merge-sort + cap.
  const perSource = Math.min(40, limit * 2);
  const events = [];

  if (tables.has('tasks') && hints.length > 0) {
    const ph = sqlInList(hints);
    const rows = db.prepare(`
      SELECT task_id, intent, state, created_by_agent_id, created_at, updated_at
      FROM tasks
      WHERE created_by_agent_id IN ${ph}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...hints, perSource);
    for (const r of rows) {
      events.push({
        ts: r.updated_at,
        kind: 'task_' + String(r.state || '').toLowerCase(),
        agent_id: r.created_by_agent_id,
        task_id: r.task_id,
        body: `${r.state}: ${r.intent}`,
      });
    }
  }

  if (tables.has('conflicts') && hints.length > 0) {
    const ph = sqlInList(hints);
    const rows = db.prepare(`
      SELECT id, detected_at, conflict_type, agent_a, agent_b, paths_json,
             summary, status, resolved_at
      FROM conflicts
      WHERE agent_a IN ${ph} OR agent_b IN ${ph}
      ORDER BY detected_at DESC
      LIMIT ?
    `).all(...hints, ...hints, perSource);
    for (const r of rows) {
      events.push({
        ts: r.detected_at,
        kind: 'conflict_detected',
        agent_id: r.agent_a,
        task_id: null,
        body: r.summary || `${r.conflict_type}: ${r.agent_a} ↔ ${r.agent_b || '?'}`,
      });
      if (r.resolved_at) {
        events.push({
          ts: r.resolved_at,
          kind: 'conflict_resolved',
          agent_id: r.agent_a,
          task_id: null,
          body: `Resolved: ${r.summary || r.conflict_type}`,
        });
      }
    }
  }

  if (tables.has('blockers') && hints.has && tables.has('tasks')) {
    // we got a hints array; rebuild
  }
  if (tables.has('blockers') && hints.length > 0 && tables.has('tasks')) {
    const ph = sqlInList(hints);
    const rows = db.prepare(`
      SELECT b.blocker_id, b.task_id, b.question, b.status, b.raised_at, b.answered_at,
             b.answer
      FROM blockers b
      JOIN tasks t ON t.task_id = b.task_id
      WHERE t.created_by_agent_id IN ${ph}
      ORDER BY b.raised_at DESC
      LIMIT ?
    `).all(...hints, perSource);
    for (const r of rows) {
      events.push({
        ts: r.raised_at,
        kind: 'blocker_raised',
        agent_id: null,
        task_id: r.task_id,
        body: `BLOCKED: ${r.question}`,
      });
      if (r.answered_at) {
        events.push({
          ts: r.answered_at,
          kind: 'blocker_answered',
          agent_id: null,
          task_id: r.task_id,
          body: `Answered: ${r.answer || ''}`,
        });
      }
    }
  }

  if (tables.has('outcomes') && hints.length > 0 && tables.has('tasks')) {
    const ph = sqlInList(hints);
    // Real outcomes columns: outcome_id / task_id / status / criteria_json /
    // evaluated_at / created_at / updated_at / metadata_json. Use created_at
    // as the "submitted at" proxy (when the outcome row first appeared).
    const rows = db.prepare(`
      SELECT o.task_id, o.status, o.evaluated_at, o.created_at, o.updated_at
      FROM outcomes o
      JOIN tasks t ON t.task_id = o.task_id
      WHERE t.created_by_agent_id IN ${ph}
      ORDER BY COALESCE(o.evaluated_at, o.updated_at, o.created_at, 0) DESC
      LIMIT ?
    `).all(...hints, perSource);
    for (const r of rows) {
      const ts = r.evaluated_at || r.updated_at || r.created_at;
      if (!ts) continue;
      events.push({
        ts,
        kind: r.evaluated_at ? 'outcomes_evaluated' : 'outcomes_submitted',
        agent_id: null,
        task_id: r.task_id,
        body: `Outcome ${r.status}`,
      });
    }
  }

  if (tables.has('dispatch_requests') && hints.length > 0) {
    const ph = sqlInList(hints);
    // dispatch_requests may have target_agent or initiator_agent; existing
    // schema uses target_agent. Filter by either column being in hints.
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT id, status, target_agent, created_at, decided_at
        FROM dispatch_requests
        WHERE target_agent IN ${ph}
        ORDER BY created_at DESC
        LIMIT ?
      `).all(...hints, perSource);
    } catch (_e) {
      rows = [];
    }
    for (const r of rows) {
      events.push({
        ts: r.created_at,
        kind: 'dispatch_submitted',
        agent_id: r.target_agent,
        task_id: null,
        body: `Dispatch ${r.id} → ${r.target_agent} (status=${r.status})`,
      });
      if (r.decided_at) {
        events.push({
          ts: r.decided_at,
          kind: 'dispatch_' + String(r.status || '').toLowerCase(),
          agent_id: r.target_agent,
          task_id: null,
          body: `Dispatch ${r.id} decided: ${r.status}`,
        });
      }
    }
  }

  if (tables.has('checkpoints') && hints.length > 0 && tables.has('tasks')) {
    const ph = sqlInList(hints);
    const rows = db.prepare(`
      SELECT c.id, c.task_id, c.git_head, c.created_at, c.label
      FROM checkpoints c
      JOIN tasks t ON t.task_id = c.task_id
      WHERE t.created_by_agent_id IN ${ph}
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(...hints, Math.min(20, perSource));
    for (const r of rows) {
      events.push({
        ts: r.created_at,
        kind: 'checkpoint_created',
        agent_id: null,
        task_id: r.task_id,
        body: r.label || `checkpoint ${r.git_head ? r.git_head.slice(0, 8) : r.id}`,
      });
    }
  }

  if (tables.has('scratchpad') && projectId) {
    const mentorRows = db.prepare(`
      SELECT key, value_json, updated_at
      FROM scratchpad
      WHERE key LIKE 'mentor/' || ? || '/nudge/%'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(projectId, perSource);
    for (const r of mentorRows) {
      let body = null;
      try { body = r.value_json ? JSON.parse(r.value_json) : null; } catch (_e) {}
      events.push({
        ts: r.updated_at,
        kind: 'mentor_nudge',
        agent_id: body && body.to_agent_id ? body.to_agent_id : null,
        task_id: body && body.task_id ? body.task_id : null,
        body: `Mentor → ${(body && body.to_agent_id) || 'agent'}: ${(body && (body.message || body.body)) || ''}`,
      });
    }

    // User-supervisor steer messages (Phase 3 inbox queue). We surface
    // them as 'user_steer' events so the user sees what they sent in
    // Module 3 right after clicking Send. Filter by project_id inside
    // the value_json (key is keyed by agent, not project, so we need
    // a JSON LIKE to scope to this project).
    const steerRows = db.prepare(`
      SELECT key, value_json, created_at
      FROM scratchpad
      WHERE key LIKE 'agent_inbox/%'
        AND value_json LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(`%"project_id":"${projectId}"%`, Math.min(20, perSource));
    for (const r of steerRows) {
      let body = null;
      try { body = r.value_json ? JSON.parse(r.value_json) : null; } catch (_e) {}
      if (!body) continue;
      events.push({
        ts: r.created_at,
        kind: 'user_steer',
        agent_id: r.key.split('/')[1] || null,
        task_id: null,
        body: `You → ${(r.key.split('/')[1] || 'agent').slice(0, 14)}…: ${body.message || ''}`,
      });
    }

    const escalationRows = db.prepare(`
      SELECT key, value_json, created_at, updated_at
      FROM scratchpad
      WHERE key LIKE 'escalation/' || ? || '/%'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(projectId, Math.min(20, perSource));
    for (const r of escalationRows) {
      let body = null;
      try { body = r.value_json ? JSON.parse(r.value_json) : null; } catch (_e) {}
      events.push({
        ts: r.created_at,
        kind: 'escalation_raised',
        agent_id: null,
        task_id: body && body.task_id ? body.task_id : null,
        body: body ? (body.body || body.message || body.reason || 'escalation') : 'escalation',
      });
    }
  }

  if (tables.has('processes') && hints.length > 0) {
    const ph = sqlInList(hints);
    const rows = db.prepare(`
      SELECT agent_id, registered_at, last_heartbeat, status, heartbeat_ttl
      FROM processes
      WHERE agent_id IN ${ph}
      ORDER BY registered_at DESC
      LIMIT ?
    `).all(...hints, Math.min(20, perSource));
    for (const r of rows) {
      events.push({
        ts: r.registered_at,
        kind: 'agent_register',
        agent_id: r.agent_id,
        task_id: null,
        body: `${r.agent_id} registered`,
      });
      const isStale = (r.last_heartbeat + r.heartbeat_ttl) < now;
      if (isStale) {
        events.push({
          ts: r.last_heartbeat + r.heartbeat_ttl,
          kind: 'agent_dead',
          agent_id: r.agent_id,
          task_id: null,
          body: `${r.agent_id} heartbeat stale`,
        });
      }
    }
  }

  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return events.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Autopilot status — derived
// ---------------------------------------------------------------------------

function deriveAutopilotStatus({ goal, agents, escalationsPending }) {
  if (!goal) return AUTOPILOT_STATUS.NO_GOAL;
  if (escalationsPending > 0) return AUTOPILOT_STATUS.MENTOR_BLOCKED_NEED_USER;
  const liveAgents = agents.filter(a => a.status === 'ACTIVE' || a.status === 'IDLE');
  if (liveAgents.length === 0) return AUTOPILOT_STATUS.AGENT_IDLE;
  return AUTOPILOT_STATUS.AGENT_WORKING;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a cockpit state payload for ONE project.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Set<string>} tables               present table names
 * @param {{id:string,label:string,project_root:string,db_path:string,leader?:string,agent_id_hints?:string[]}} project
 * @param {string|null} goal                  caller-resolved goal text (or null)
 * @param {Set<string>|string[]} agentIds     attribution hints (resolved via project-queries)
 * @param {object} [opts]
 * @param {number} [opts.activityLimit]
 * @param {number} [opts.checkpointLimit]
 * @param {number} [opts.escalationLimit]
 *
 * @returns {object} cockpit state payload
 */
function buildCockpitState(db, tables, project, goal, agentIds, opts) {
  const o = opts || {};
  if (!project) return emptyCockpitState(null, null, 'no_project');
  if (!db || !tables) return emptyCockpitState(project, project.db_path, 'no_db');

  const hints = Array.isArray(agentIds) ? agentIds : Array.from(agentIds || []);
  const now = Date.now();

  const agents = queryAgents(db, tables, hints, now);
  const progress = queryProgress(db, tables, hints);
  const currentTask = queryCurrentTask(db, tables, hints);
  const latestMentor = queryLatestMentorNudge(db, tables, project.id);
  const allEscalations = queryEscalations(db, tables, project.id, {
    limit: o.escalationLimit || ESCALATION_LIMIT_DEFAULT,
  });
  const escalationsPending = allEscalations.filter(e => e.status === 'PENDING');
  const checkpoints = queryCheckpoints(db, tables, hints, {
    limit: o.checkpointLimit || CHECKPOINT_LIMIT_DEFAULT,
  });
  const activity = queryActivityFeed(db, tables, hints, project.id, {
    limit: o.activityLimit || ACTIVITY_LIMIT_DEFAULT,
  });

  const autopilot = deriveAutopilotStatus({
    goal,
    agents,
    escalationsPending: escalationsPending.length,
  });

  // Schema v2 CAIRN.md: panel surfaces the `## Whole` sentence as
  // Mentor's stable north-star line above the state strip. loadProfile
  // is mtime-gated so this is free on unchanged CAIRN.md.
  let whole_sentence = null;
  let cairn_md_present = false;
  try {
    const profile = profileMod.loadProfile(db, project);
    if (profile && profile.exists) {
      cairn_md_present = true;
      whole_sentence = profile.whole_sentence || null;
    }
  } catch (_e) { /* leave both null */ }

  // "In flight" line — per schema v2, computed from live state, not
  // stored in CAIRN.md. Counts active tasks + active processes that
  // attribute to this project.
  const in_flight = (progress && typeof progress.total_active === 'number')
    ? progress.total_active
    : (agents.filter(a => a.state === 'running' || a.state === 'active').length);

  // Phase 5 (2026-05-14): "Mentor saved you N" productivity-feedback
  // counter. Counts kernel-side sync mentor decisions for this
  // project's attributed agents:
  //   mentor/<agent_id>/auto_resolve/<ulid>  ← Phase 2 known_answers
  //   mentor/<agent_id>/auto_decide/<ulid>   ← Phase 3 ✅
  //   mentor/<agent_id>/announce/<ulid>      ← Phase 3 ⚠️
  //   mentor/<agent_id>/escalate/<ulid>      ← Phase 3 🛑 (recommendation only)
  //
  // Plus the existing async tick decisions (mentor/<pid>/nudge/<ulid>)
  // for completeness — but tick nudges are per-project not per-agent
  // so we count them separately.
  //
  // The dogfood-perceived value: when a user opens the panel, they see
  // a literal number for "blockers Mentor handled so you didn't have
  // to." This is the productivity-feedback signal the bootstrap +
  // sync-mentor work was building toward.
  let mentor_decisions = { auto_resolve: 0, auto_decide: 0, announce: 0, escalate: 0, total: 0 };
  if (tables.has('scratchpad') && hints.length > 0) {
    try {
      const hintsLike = hints.map(h => `mentor/${h}/%`);
      const placeholders = hintsLike.map(() => 'key LIKE ?').join(' OR ');
      const rows = db.prepare(`
        SELECT key FROM scratchpad
        WHERE ${placeholders}
      `).all(...hintsLike);
      for (const r of rows) {
        if (r.key.includes('/auto_resolve/'))    mentor_decisions.auto_resolve++;
        else if (r.key.includes('/auto_decide/')) mentor_decisions.auto_decide++;
        else if (r.key.includes('/announce/'))    mentor_decisions.announce++;
        else if (r.key.includes('/escalate/'))    mentor_decisions.escalate++;
      }
      mentor_decisions.total =
        mentor_decisions.auto_resolve +
        mentor_decisions.auto_decide +
        mentor_decisions.announce +
        mentor_decisions.escalate;
    } catch (_e) { /* leave zeros */ }
  }

  // Phase 6 (2026-05-14): stale-agent detection + orphan task surface.
  //
  // An agent is "stale" when:
  //   - its processes row has status='active' (CC believed it was running)
  //   - but last_heartbeat is older than max(STALE_GRACE_FACTOR ×
  //     heartbeat_ttl, 5 min absolute floor)
  //
  // For each stale agent we also list its orphaned tasks — tasks where
  //   created_by_agent_id == agent_id AND state ∈ RUNNING / BLOCKED /
  //   READY_TO_RESUME. These are the in-flight items that nobody is
  //   pushing forward because the owning process went silent.
  //
  // Surface ONLY in cockpit state (read field). Panel renders. No
  // kernel state mutation here — per D9 + the AUTOMATION.md autonomy
  // contract, recovery primitives are agent-callable MCP tools
  // (cairn.task.cancel / cairn.task.start_attempt by another agent).
  // The user's action is "see + decide" not "see + auto-clean."
  const STALE_GRACE_FACTOR = 5;
  const STALE_ABSOLUTE_FLOOR_MS = 5 * 60_000;
  let stale_agents = [];
  if (tables.has('processes') && tables.has('tasks') && hints.length > 0) {
    try {
      const placeholders = hints.map(() => '?').join(',');
      const procRows = db.prepare(`
        SELECT agent_id, status, last_heartbeat, heartbeat_ttl
        FROM processes
        WHERE agent_id IN (${placeholders}) AND status = 'active'
      `).all(...hints);
      for (const p of procRows) {
        const ttl = Number(p.heartbeat_ttl) > 0 ? Number(p.heartbeat_ttl) : 30_000;
        const threshold = Math.max(ttl * STALE_GRACE_FACTOR, STALE_ABSOLUTE_FLOOR_MS);
        const lastSeenAgo = now - Number(p.last_heartbeat || 0);
        if (lastSeenAgo < threshold) continue;
        // Orphaned tasks
        let orphans = [];
        try {
          orphans = db.prepare(`
            SELECT task_id, intent, state, updated_at
            FROM tasks
            WHERE created_by_agent_id = ?
              AND state IN ('RUNNING', 'BLOCKED', 'READY_TO_RESUME')
            ORDER BY updated_at DESC
            LIMIT 20
          `).all(p.agent_id);
        } catch (_e) { orphans = []; }
        stale_agents.push({
          agent_id: p.agent_id,
          last_seen_ago_ms: lastSeenAgo,
          last_heartbeat: Number(p.last_heartbeat || 0),
          orphan_count: orphans.length,
          orphans, // first 20
        });
      }
    } catch (_e) { /* leave empty */ }
  }

  return {
    project: {
      id: project.id,
      label: project.label,
      project_root: project.project_root,
      db_path: project.db_path,
    },
    goal: goal || null,
    leader: project.leader || null,
    // schema-v2 surface (2026-05-14): Mentor north-star + computed in-flight
    whole_sentence,
    cairn_md_present,
    in_flight,
    // Phase 5 (2026-05-14): "Mentor saved you N" productivity-feedback counter
    mentor_decisions,
    // Phase 6 (2026-05-14): stale-agent + orphan task surface
    stale_agents,
    autopilot_status: autopilot,
    autopilot_reason: autopilot === AUTOPILOT_STATUS.NO_GOAL
      ? 'project has no goal — set one to enable Mentor'
      : autopilot === AUTOPILOT_STATUS.AGENT_IDLE
        ? 'no agent currently running for this project'
        : autopilot === AUTOPILOT_STATUS.MENTOR_BLOCKED_NEED_USER
          ? `${escalationsPending.length} escalation(s) need your attention`
          : 'agent working — Mentor handling on track',
    agents,
    progress,
    current_task: currentTask,
    latest_mentor_nudge: latestMentor,
    activity,
    checkpoints,
    escalations: allEscalations,
    ts: now,
  };
}

module.exports = {
  AUTOPILOT_STATUS,
  ACTIVITY_LIMIT_DEFAULT,
  CHECKPOINT_LIMIT_DEFAULT,
  ESCALATION_LIMIT_DEFAULT,
  SUPPORTED_TABLES,
  buildCockpitState,
  emptyCockpitState,
  // Exported for tests / debug.
  queryProgress,
  queryCurrentTask,
  queryAgents,
  queryLatestMentorNudge,
  queryEscalations,
  queryCheckpoints,
  queryActivityFeed,
  deriveAutopilotStatus,
};
