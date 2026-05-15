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
/** Default number of todolist entries (M2 Todolist). */
const TODOLIST_LIMIT_DEFAULT = 30;

/** Autopilot status enum — drives Module 1's color + copy. */
const AUTOPILOT_STATUS = {
  NO_GOAL: 'NO_GOAL',                         // grey: project has no goal → Mentor can't run
  AGENT_IDLE: 'AGENT_IDLE',                   // grey: no agent process active
  AGENT_WORKING: 'AGENT_WORKING',             // green: agent ACTIVE + no pending escalation
  MENTOR_BLOCKED_NEED_USER: 'MENTOR_BLOCKED_NEED_USER', // red: ≥1 PENDING escalation
  // Mode A v2 transient states (CEO 2026-05-14 UX fix). Without these,
  // user clicks Start and panel says "agent 空闲 · 没人在跑" for the
  // 30-60s gap between spawn and CC's first cairn.task.create call.
  // Visually misleading. New states paper over the gap with progress.
  SCOUT_PLANNING: 'SCOUT_PLANNING',           // amber+pulse: Mode A scout drafting plan
  AGENT_STARTING: 'AGENT_STARTING',           // amber+pulse: spawn done, waiting for CC to call cairn.task.create
  PLAN_PENDING_REVIEW: 'PLAN_PENDING_REVIEW', // blue: plan drafted, awaiting user click Start
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
const modeALoop  = require('./mode-a-loop.cjs');
const cairnLog   = require('./cairn-log.cjs');
const mentorCollect = require('./mentor-collect.cjs');

function sqlInList(arr) {
  if (!arr || arr.length === 0) return '(NULL)';
  return '(' + arr.map(() => '?').join(',') + ')';
}

// ---------------------------------------------------------------------------
// Mentor signals summary — pure derivation (commit A of signal-cat-rest)
// ---------------------------------------------------------------------------
//
// Given a {signals, meta} result from mentor-collect.collectMentorSignals,
// returns a panel-friendly summary of which signal *categories* (user-facing
// ~~category placeholder names per mentor-collect.CATEGORY_ALIASES) are
// currently producing data versus missing.
//
// A signal counts as "available" when:
//   - it is NOT in meta.failed_signals
//   - AND the corresponding content body is non-empty:
//        docs       → at least one file read
//        git        → head sha present
//        candidates → array non-empty
//        iterations → array non-empty
//        reports    → array non-empty
//        kernel     → always available when not in failed (scaffold returns
//                     well-formed zeros; "no tasks yet" is healthy idle)
//
// All other signal keys (failed or empty) end up in `missing`.
//
// Returned shape:
//   { available: ['project-narrative', 'vcs-signal', ...],
//     missing:   ['issue-tracker', ...] }
//
// The values are the bare category names (no `~~` prefix) — the panel
// renders the prefix as a visual style choice, not a hard part of the name.
//
// @param  {{ signals?: object, meta?: { failed_signals?: Array<{source:string}> } } | null} result
// @returns {{ available: string[], missing: string[] }}
function deriveMentorSignalsSummary(result) {
  const empty = { available: [], missing: [] };
  if (!result || typeof result !== 'object') return empty;

  const signals = result.signals || {};
  const meta = result.meta || {};
  const failedList = Array.isArray(meta.failed_signals) ? meta.failed_signals : [];
  const failedSet = new Set(failedList.map(f => (f && f.source) || '').filter(Boolean));

  const available = [];
  const missing = [];

  for (const key of mentorCollect.KNOWN_SIGNAL_KEYS) {
    const cat = mentorCollect.CATEGORY_ALIASES[key];
    if (!cat) continue;
    if (failedSet.has(key)) { missing.push(cat); continue; }

    const body = signals[key];
    let isAvailable = false;
    switch (key) {
      case 'docs':
        isAvailable = !!(body && Array.isArray(body.files) && body.files.length > 0);
        break;
      case 'git':
        isAvailable = !!(body && typeof body.head === 'string' && body.head.length > 0);
        break;
      case 'candidates':
      case 'iterations':
      case 'reports':
        isAvailable = Array.isArray(body) && body.length > 0;
        break;
      case 'kernel':
        // Scaffold succeeds even when all counters are zero — treat as
        // available unless explicitly failed. "Zero tasks running" is a
        // healthy state, not a missing signal.
        isAvailable = !!body && typeof body === 'object';
        break;
      default:
        isAvailable = !!body;
    }
    if (isAvailable) available.push(cat); else missing.push(cat);
  }

  return { available, missing };
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
    mode: (project && project.mode) || 'B',
    mode_a_phase: (project && project.mode_a_phase) || 'idle',
    mode_a_plan: null,
    active_agents_count: 0,
    autopilot_status: AUTOPILOT_STATUS.AGENT_IDLE,
    autopilot_reason: reason || 'no_data',
    agents: [],
    sessions: [],
    lanes: [],
    progress: {
      tasks_total: 0, tasks_done: 0, tasks_running: 0,
      tasks_blocked: 0, tasks_waiting_review: 0, percent: 0,
    },
    current_task: null,
    latest_mentor_nudge: null,
    activity: [],
    checkpoints: [],
    escalations: [],
    mentor_signals: { available: [], missing: [] },
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

/**
 * Sessions for cockpit Module 4 (panel-cockpit-redesign 2026-05-14).
 *
 * A "session" is a row in `processes` attributed to this project. Unlike
 * queryAgents() (which drops STALE/DEAD), querySessions keeps idle and
 * stale-but-recent entries so Module 4 can show:
 *   - working: heartbeat fresh AND has a RUNNING task
 *   - blocked: has a BLOCKED task
 *   - idle:    heartbeat fresh AND no active task
 *   - stale:   heartbeat older than ttl × 2 but within last 24h
 *   (rows older than 24h are dropped — that's DB junk, not "a session
 *    that's still around")
 *
 * Per CEO grill 2026-05-14: "哪怕当前没在执行任务，只要这个 session
 * 已经在运行了" — idle is a first-class state, must show.
 *
 * display_name resolution order (forward-compat with A3-part1 session-naming):
 *   1. scratchpad `session_name/<agent_id>` if present (agent-self-named)
 *   2. fallback: short prefix of agent_id (e.g. `cairn-session-746e4cea`
 *      → "746e4cea")
 *
 * @returns Array<{
 *   agent_id, display_name, state: 'working'|'blocked'|'idle'|'stale',
 *   last_heartbeat_ts, last_seen_age_ms,
 *   current_task: { task_id, intent, state } | null,
 *   last_action: { kind, label, ts } | null
 * }>
 */
function querySessions(db, tables, hints, now, opts) {
  const o = opts || {};
  const stale24hMs = 24 * 60 * 60_000;
  if (!tables.has('processes') || !hints || hints.length === 0) return [];

  const placeholders = '(' + hints.map(() => '?').join(',') + ')';
  const procRows = db.prepare(`
    SELECT agent_id, agent_type, status, last_heartbeat, heartbeat_ttl, registered_at, capabilities
    FROM processes
    WHERE agent_id IN ${placeholders}
    ORDER BY last_heartbeat DESC
  `).all(...hints);

  // Pre-fetch session_name overrides in one query (forward-compat with A3-part1).
  const nameMap = new Map();
  if (tables.has('scratchpad')) {
    try {
      const nameLikes = hints.map(h => `session_name/${h}`);
      const np = '(' + nameLikes.map(() => '?').join(',') + ')';
      const nameRows = db.prepare(`
        SELECT key, value_json FROM scratchpad WHERE key IN ${np}
      `).all(...nameLikes);
      for (const r of nameRows) {
        const aid = r.key.slice('session_name/'.length);
        try {
          const body = JSON.parse(r.value_json || '{}');
          if (body && typeof body.name === 'string' && body.name.trim()) {
            nameMap.set(aid, body.name.trim());
          }
        } catch (_e) { cairnLog.warn('cockpit-state', 'session_name_parse_failed', { message: (_e && _e.message) || String(_e) }); }
      }
    } catch (_e) { cairnLog.warn('cockpit-state', 'session_name_query_failed', { message: (_e && _e.message) || String(_e) }); }
  }

  // Per-agent: most recent task (any state) for context line.
  const taskMap = new Map();
  if (tables.has('tasks')) {
    try {
      const tRows = db.prepare(`
        SELECT task_id, intent, state, created_by_agent_id, updated_at
        FROM tasks
        WHERE created_by_agent_id IN ${placeholders}
        ORDER BY updated_at DESC
      `).all(...hints);
      for (const t of tRows) {
        if (!taskMap.has(t.created_by_agent_id)) {
          taskMap.set(t.created_by_agent_id, t);
        }
      }
    } catch (_e) { cairnLog.warn('cockpit-state', 'task_map_query_failed', { message: (_e && _e.message) || String(_e) }); }
  }

  const out = [];
  for (const r of procRows) {
    const ttl = r.heartbeat_ttl || 60000;
    const ageMs = now - r.last_heartbeat;
    const liveCutoff = ttl;          // fresh
    const staleCutoff = ttl * 2;     // beyond ttl×2 = stale; we still show within 24h
    if (ageMs > stale24hMs) continue;  // very old — DB junk, drop

    const currentTask = taskMap.get(r.agent_id) || null;
    let state;
    if (ageMs <= liveCutoff) {
      if (currentTask && currentTask.state === 'BLOCKED') state = 'blocked';
      else if (currentTask && (currentTask.state === 'RUNNING' || currentTask.state === 'WAITING_REVIEW')) state = 'working';
      else state = 'idle';
    } else if (ageMs <= staleCutoff) {
      state = 'idle';
    } else {
      state = 'stale';
    }

    const display_name = nameMap.get(r.agent_id) || deriveSessionDisplayName(r.agent_id);

    out.push({
      agent_id: r.agent_id,
      display_name,
      state,
      agent_type: r.agent_type || null,
      last_heartbeat_ts: r.last_heartbeat,
      last_seen_age_ms: ageMs,
      registered_at: r.registered_at,
      current_task: currentTask
        ? { task_id: currentTask.task_id, intent: currentTask.intent, state: currentTask.state, updated_at: currentTask.updated_at }
        : null,
    });
  }
  // Sort: working > blocked > idle > stale; tie-break by recency.
  const stateOrder = { working: 0, blocked: 1, idle: 2, stale: 3 };
  out.sort((a, b) => {
    if (stateOrder[a.state] !== stateOrder[b.state]) return stateOrder[a.state] - stateOrder[b.state];
    return a.last_seen_age_ms - b.last_seen_age_ms;
  });
  // Cap to keep panel render bounded.
  return out.slice(0, o.limit || 20);
}

/**
 * A1.2 Session Timeline (panel-cockpit-redesign 2026-05-14).
 *
 * Read agent execution timeline events for a single session, from
 * scratchpad key namespace `session_timeline/<agent_id>/<ulid>`
 * (protocol owned by A1.1). Each row's value_json is:
 *   { ts, kind, label, agent_id, task_id?, parent_event_id?, source }
 *
 * Also joins kernel-side `checkpoints` tagged to this agent_id as
 * synthetic `kind: 'checkpoint'` events so the user sees safe-to-rewind
 * anchors inline (CEO grill约定 16).
 *
 * Events returned in chronological order (oldest first). Renderer may
 * reverse for newest-at-top display. parent_event_id forms the subagent
 * tree — renderer is responsible for visual indentation.
 *
 * @returns Array<{ event_id, ts, kind, label, agent_id, task_id?,
 *   parent_event_id?, source, checkpoint_id?, raw }>
 */
/**
 * Defensive JSON parse for scratchpad value_json. Handles:
 *   - normal: `{"k":"v"}` → { k: 'v' }
 *   - double-encoded (caller pre-stringified before passing to
 *     cairn.scratchpad.write): `"\"{\\\"k\\\":\\\"v\\\"}\""` → first
 *     parse yields the inner string, second parse yields the object.
 * Real-agent dogfood 2026-05-14 exposed this — fix once here vs at
 * every caller.
 *
 * Returns the parsed object, or null on any failure or non-object result.
 */
function parseScratchpadValue(raw) {
  if (!raw) return null;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_e) { return null; }
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (_e) { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}

function querySessionTimeline(db, tables, agentId, opts) {
  const o = opts || {};
  const limit = o.limit || 200;
  if (!agentId || !tables.has('scratchpad')) return [];

  const prefix = `session_timeline/${agentId}/`;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT key, value_json, updated_at
      FROM scratchpad
      WHERE key LIKE ? || '%'
      ORDER BY key ASC
    `).all(prefix);
  } catch (_e) { cairnLog.warn('cockpit-state', 'session_timeline_query_failed', { message: (_e && _e.message) || String(_e) }); return []; }

  const events = [];
  for (const r of rows) {
    const ulid = r.key.slice(prefix.length);
    let body = null;
    try { body = JSON.parse(r.value_json || '{}'); } catch (_e) { continue; }
    // A1.1 protocol allows agent to pass plain object OR pre-stringified JSON.
    // cairn.scratchpad.write stringifies whatever it receives, so a
    // pre-stringified payload comes back as a JSON string after one parse —
    // attempt a second parse to recover. Real-agent dogfood 2026-05-14
    // discovered this; defensive handling beats educating every caller.
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_e) { cairnLog.warn('cockpit-state', 'timeline_body_reparse_failed', { message: (_e && _e.message) || String(_e) }); }
    }
    if (!body || typeof body !== 'object') continue;
    events.push({
      event_id: ulid,
      ts: Number(body.ts) || Number(r.updated_at) || 0,
      kind: typeof body.kind === 'string' ? body.kind : 'progress',
      label: typeof body.label === 'string' ? body.label : '',
      agent_id: body.agent_id || agentId,
      task_id: body.task_id || null,
      parent_event_id: body.parent_event_id || null,
      source: body.source || 'agent',
      raw: body,
    });
  }

  // Append checkpoint rows as synthetic events (rewind anchors).
  if (tables.has('checkpoints') && tables.has('tasks')) {
    try {
      const ckpts = db.prepare(`
        SELECT id, task_id, git_head, snapshot_status, created_at, label
        FROM checkpoints
        WHERE task_id IN (
          SELECT DISTINCT task_id FROM tasks WHERE created_by_agent_id = ?
        )
        ORDER BY created_at DESC
        LIMIT 50
      `).all(agentId);
      for (const c of ckpts) {
        events.push({
          event_id: `ckpt:${c.id}`,
          ts: c.created_at,
          kind: 'checkpoint',
          label: c.label || `before commit ${(c.git_head || '').slice(0, 8)}`,
          agent_id: agentId,
          task_id: c.task_id || null,
          parent_event_id: null,
          source: 'kernel',
          checkpoint_id: c.id,
          raw: c,
        });
      }
    } catch (_e) { cairnLog.warn('cockpit-state', 'timeline_checkpoints_failed', { message: (_e && _e.message) || String(_e) }); }
  }

  events.sort((a, b) => a.ts - b.ts);
  return events.slice(-limit);
}

function deriveSessionDisplayName(agentId) {
  if (!agentId || typeof agentId !== 'string') return '(unknown)';
  // `cairn-session-746e4cea197e` → `746e4cea` (8-char short prefix)
  const sessionMatch = agentId.match(/^cairn-session-([0-9a-f]+)$/i);
  if (sessionMatch) return sessionMatch[1].slice(0, 8);
  // Generic fallback: last 8 chars
  return agentId.length > 12 ? agentId.slice(-8) : agentId;
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
  try { body = row.value_json ? JSON.parse(row.value_json) : null; } catch (_e) { cairnLog.warn('cockpit-state', 'mentor_nudge_parse_failed', { message: (_e && _e.message) || String(_e) }); }
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
    try { body = r.value_json ? JSON.parse(r.value_json) : null; } catch (_e) { cairnLog.warn('cockpit-state', 'escalation_parse_failed', { message: (_e && _e.message) || String(_e) }); }
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
      try { body = r.value_json ? JSON.parse(r.value_json) : null; } catch (_e) { cairnLog.warn('cockpit-state', 'activity_mentor_nudge_parse_failed', { message: (_e && _e.message) || String(_e) }); }
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
      try { body = r.value_json ? JSON.parse(r.value_json) : null; } catch (_e) { cairnLog.warn('cockpit-state', 'activity_steer_parse_failed', { message: (_e && _e.message) || String(_e) }); }
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
      try { body = r.value_json ? JSON.parse(r.value_json) : null; } catch (_e) { cairnLog.warn('cockpit-state', 'activity_escalation_parse_failed', { message: (_e && _e.message) || String(_e) }); }
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

function deriveAutopilotStatus({ goal, agents, escalationsPending, progress, modeAPhase }) {
  if (!goal) return AUTOPILOT_STATUS.NO_GOAL;
  if (escalationsPending > 0) return AUTOPILOT_STATUS.MENTOR_BLOCKED_NEED_USER;
  // Mode A v2 transient state surfacing (CEO 2026-05-14 UX fix). Phase
  // signal arrives BEFORE any tasks-table activity, so we use it to
  // paper over the spawn-to-CC-task-create gap that would otherwise
  // show "agent 空闲" for 30-60s after click. Order matters: escalation
  // still trumps these (red beats amber).
  if (modeAPhase === 'planning')     return AUTOPILOT_STATUS.SCOUT_PLANNING;
  if (modeAPhase === 'plan_pending') return AUTOPILOT_STATUS.PLAN_PENDING_REVIEW;
  // 2026-05-14 bug 鸭总 caught: "agent 在执行" was shown even when no
  // RUNNING task existed — just because a Claude Code window was open
  // (process registered ⇒ ACTIVE). Real "working" requires actual task
  // activity. ACTIVE process without RUNNING/BLOCKED/REVIEW task = IDLE.
  const activeTaskCount = progress
    ? (progress.tasks_running || 0) + (progress.tasks_blocked || 0) + (progress.tasks_waiting_review || 0)
    : 0;
  // Mode A v2 transient: phase=running but task not yet started =
  // AGENT_STARTING (amber+pulse) instead of AGENT_IDLE (grey). This is
  // the 30-60s window after user clicks Start where Cairn has spawned
  // CC but CC hasn't called cairn.task.create yet.
  if (modeAPhase === 'running' && activeTaskCount === 0) {
    return AUTOPILOT_STATUS.AGENT_STARTING;
  }
  if (activeTaskCount === 0) return AUTOPILOT_STATUS.AGENT_IDLE;
  const liveAgents = agents.filter(a => a.status === 'ACTIVE' || a.status === 'IDLE');
  if (liveAgents.length === 0) return AUTOPILOT_STATUS.AGENT_IDLE;
  return AUTOPILOT_STATUS.AGENT_WORKING;
}

// ---------------------------------------------------------------------------
// M2 Todolist — merge three scratchpad namespaces, sort ts DESC, limit cap
// ---------------------------------------------------------------------------

/**
 * Query M2 Todolist entries from three scratchpad namespaces:
 *
 *   agent_proposal/<agent_id>/<ulid>
 *     value: { ts, label, agent_id, task_id?, why? }
 *     source label: 🤖 + agent display_name (8-char prefix)
 *
 *   mentor_todo/<project_id>/<ulid>
 *     value: { ts, label, project_id, source: 'mentor' }
 *     source label: 🧑‍🏫 mentor
 *
 *   user_todo/<project_id>/<ulid>
 *     value: { ts, label, project_id, source: 'user' }
 *     source label: 🐤 you
 *
 * Returns merged array sorted by ts DESC (most recent first), capped at limit.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Set<string>} tables
 * @param {string|null} projectId
 * @param {string[]} agentHints  — attributed agent_ids for this project
 * @param {{ limit?: number }} [opts]
 * @returns {Array<{
 *   todo_id: string,
 *   source: 'agent_proposal'|'mentor_todo'|'user_todo',
 *   agent_id?: string,
 *   label: string,
 *   ts: number,
 *   project_id?: string,
 *   task_id?: string,
 *   why?: string,
 *   raw: object
 * }>}
 */
function queryTodoList(db, tables, projectId, agentHints, opts) {
  if (!db || !tables || !tables.has('scratchpad')) return [];
  const limit = (opts && opts.limit) || TODOLIST_LIMIT_DEFAULT;
  const hints = Array.isArray(agentHints) ? agentHints : [];
  const todos = [];

  // 1. agent_proposal — one per attributed agent_id
  if (hints.length > 0) {
    for (const agentId of hints) {
      try {
        const rows = db.prepare(`
          SELECT key, value_json, updated_at
          FROM scratchpad
          WHERE key LIKE 'agent_proposal/' || ? || '/%'
          ORDER BY key DESC
          LIMIT ?
        `).all(agentId, limit);
        for (const r of rows) {
          const ulid = r.key.split('/').pop();
          const body = parseScratchpadValue(r.value_json);
          if (!body) continue;
          const label = typeof body.label === 'string' ? body.label : '';
          if (!label) continue;
          todos.push({
            todo_id: ulid,
            source: 'agent_proposal',
            agent_id: body.agent_id || agentId,
            label,
            ts: Number(body.ts) || Number(r.updated_at) || 0,
            project_id: projectId || null,
            task_id: body.task_id || null,
            why: body.why || null,
            raw: body,
          });
        }
      } catch (_e) { cairnLog.warn('cockpit-state', 'todolist_agent_proposal_query_failed', { message: (_e && _e.message) || String(_e) }); }
    }
  }

  // 2. mentor_todo — keyed by project_id
  if (projectId) {
    try {
      const rows = db.prepare(`
        SELECT key, value_json, updated_at
        FROM scratchpad
        WHERE key LIKE 'mentor_todo/' || ? || '/%'
        ORDER BY key DESC
        LIMIT ?
      `).all(projectId, limit);
      for (const r of rows) {
        const ulid = r.key.split('/').pop();
        let body = null;
        try { body = r.value_json ? JSON.parse(r.value_json) : null; } catch (_e) { cairnLog.warn('cockpit-state', 'mentor_todo_parse_failed', { message: (_e && _e.message) || String(_e) }); }
        if (!body || typeof body !== 'object') continue;
        const label = typeof body.label === 'string' ? body.label : '';
        if (!label) continue;
        todos.push({
          todo_id: ulid,
          source: 'mentor_todo',
          agent_id: null,
          label,
          ts: Number(body.ts) || Number(r.updated_at) || 0,
          project_id: body.project_id || projectId,
          // MA-3 (2026-05-14): extract task_id / why / priority from
          // body so H2/H3 per-task targeting + rationale + ranking
          // actually reach the panel. Pre-MA-3 these were always null
          // because user-typed mentor_todo entries didn't carry them.
          task_id: typeof body.task_id === 'string' ? body.task_id : null,
          why: typeof body.why === 'string' ? body.why : null,
          priority: typeof body.priority === 'number' ? body.priority : null,
          raw: body,
        });
      }
    } catch (_e) { cairnLog.warn('cockpit-state', 'mentor_todo_query_failed', { message: (_e && _e.message) || String(_e) }); }
  }

  // 3. user_todo — keyed by project_id
  if (projectId) {
    try {
      const rows = db.prepare(`
        SELECT key, value_json, updated_at
        FROM scratchpad
        WHERE key LIKE 'user_todo/' || ? || '/%'
        ORDER BY key DESC
        LIMIT ?
      `).all(projectId, limit);
      for (const r of rows) {
        const ulid = r.key.split('/').pop();
        let body = null;
        try { body = r.value_json ? JSON.parse(r.value_json) : null; } catch (_e) { cairnLog.warn('cockpit-state', 'user_todo_parse_failed', { message: (_e && _e.message) || String(_e) }); }
        if (!body || typeof body !== 'object') continue;
        const label = typeof body.label === 'string' ? body.label : '';
        if (!label) continue;
        todos.push({
          todo_id: ulid,
          source: 'user_todo',
          agent_id: null,
          label,
          ts: Number(body.ts) || Number(r.updated_at) || 0,
          project_id: body.project_id || projectId,
          task_id: null,
          why: null,
          raw: body,
        });
      }
    } catch (_e) { cairnLog.warn('cockpit-state', 'user_todo_query_failed', { message: (_e && _e.message) || String(_e) }); }
  }

  // MA-3 (2026-05-14): sort priority DESC first, then ts DESC. Items
  // without an explicit priority (user_todo / agent_proposal pre-MA-3)
  // get priority=0 so they fall below ranked mentor_todo suggestions
  // when one exists. Tie-break by todo_id (ULIDs are time-sortable).
  todos.sort((a, b) => {
    const pa = typeof a.priority === 'number' ? a.priority : 0;
    const pb = typeof b.priority === 'number' ? b.priority : 0;
    if (pb !== pa) return pb - pa;
    if (b.ts !== a.ts) return b.ts - a.ts;
    return b.todo_id < a.todo_id ? -1 : 1;
  });

  return todos.slice(0, limit);
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
  const sessions = querySessions(db, tables, hints, now);
  // Mode B Continuous Iteration (slice 2): lanes for this project.
  const cockpitLane = require('./cockpit-lane.cjs');
  let lanes = [];
  try { lanes = cockpitLane.queryLanes(db, project.id, { limit: 10 }); } catch (_e) { cairnLog.warn('cockpit-state', 'lanes_query_failed', { message: (_e && _e.message) || String(_e) }); lanes = []; }
  // Mode A loop (MA-2b 2026-05-14): expose drafted plan so the panel
  // can render progress. mentor-tick is the writer; this is a pure
  // read with no side effect (D9 read-only).
  let mode_a_plan = null;
  try { mode_a_plan = modeALoop.getPlan(db, project.id); } catch (_e) { cairnLog.warn('cockpit-state', 'mode_a_plan_read_failed', { message: (_e && _e.message) || String(_e) }); mode_a_plan = null; }
  // 2026-05-14 subagent verdict B5: surface ACTIVE candidate count so
  // the panel can warn "Mode A 需要 ≥1 ACTIVE agent" when there's
  // nothing to dispatch to. Aligned with mode-a-loop.decideNextDispatch
  // gate (status='ACTIVE' filter at mode-a-loop.cjs:249).
  let active_agents_count = 0;
  try {
    if (tables.has('processes') && hints && hints.length > 0) {
      const phs = '(' + hints.map(() => '?').join(',') + ')';
      active_agents_count = db.prepare(
        `SELECT COUNT(*) AS n FROM processes WHERE agent_id IN ${phs} AND status='ACTIVE'`
      ).get(...hints).n;
    }
  } catch (_e) { cairnLog.warn('cockpit-state', 'active_agents_count_failed', { message: (_e && _e.message) || String(_e) }); active_agents_count = 0; }
  let progress = queryProgress(db, tables, hints);
  // CEO 2026-05-15 fix: when Mode A plan exists, progress should
  // reflect the CURRENT plan's step states (refresh per plan), not
  // cumulative historical tasks across all-time agent_id hints.
  // Old behaviour showed e.g. '16/22 done' even on a fresh 5-step
  // plan because tasks counted ALL ever-created. Also the cumulative
  // math didn't add up (FAILED/CANCELLED in total but not in any of
  // done/running/blocked/review buckets → visible gap).
  //
  // Plan step states (per mode-a-loop): PENDING / DISPATCHED / DONE.
  // Mapping to progress field semantics:
  //   tasks_done           = DONE steps
  //   tasks_running        = DISPATCHED steps (CC actively working)
  //   tasks_blocked        = 0 (Mode A plan steps have no BLOCKED state)
  //   tasks_waiting_review = 0 (review happens inside step, not as separate state)
  //   tasks_total          = steps.length
  // Source tag added so panel / tests can tell which kind of progress this is.
  if (mode_a_plan && Array.isArray(mode_a_plan.steps) && mode_a_plan.steps.length > 0) {
    const steps = mode_a_plan.steps;
    const total = steps.length;
    const done = steps.filter(s => s && s.state === 'DONE').length;
    const running = steps.filter(s => s && s.state === 'DISPATCHED').length;
    const percent = total > 0 ? Math.round((done / total) * 100) / 100 : 0;
    progress = {
      tasks_total: total,
      tasks_done: done,
      tasks_running: running,
      tasks_blocked: 0,
      tasks_waiting_review: 0,
      percent,
      source: 'mode_a_plan',
    };
  } else {
    progress.source = 'tasks';
  }
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
  const todolist = queryTodoList(db, tables, project.id, hints, {
    limit: o.todolistLimit || TODOLIST_LIMIT_DEFAULT,
  });

  const autopilot = deriveAutopilotStatus({
    goal,
    agents,
    escalationsPending: escalationsPending.length,
    progress,
    modeAPhase: project.mode_a_phase || null,
  });

  // Signal-cat refactor commit A (2026-05-15): surface a panel-friendly
  // summary of which signal categories (~~category placeholder names)
  // are producing data vs missing for the STATUS pill row. Caller may
  // pass a pre-collected result from mentor-collect.collectMentorSignals
  // via opts.mentor_signals_result; otherwise default to empty arrays
  // (panel hides the row entirely when both are empty).
  let mentor_signals = { available: [], missing: [] };
  if (o.mentor_signals_result) {
    try {
      mentor_signals = deriveMentorSignalsSummary(o.mentor_signals_result);
    } catch (_e) {
      cairnLog.warn('cockpit-state', 'mentor_signals_derive_failed', { message: (_e && _e.message) || String(_e) });
      mentor_signals = { available: [], missing: [] };
    }
  }

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
  } catch (_e) { cairnLog.warn('cockpit-state', 'profile_load_failed', { message: (_e && _e.message) || String(_e) }); }

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
    } catch (_e) { cairnLog.warn('cockpit-state', 'mentor_decisions_count_failed', { message: (_e && _e.message) || String(_e) }); }
  }

  // Phase 7 (2026-05-14): "while you were away" 24h summary.
  let last_24h = { tasks_done: 0, mentor_decisions: 0, conflicts_touched: 0, checkpoints_made: 0 };
  const ago24h = now - 24 * 60 * 60_000;
  if (hints.length > 0) {
    try {
      const placeholders24 = '(' + hints.map(() => '?').join(',') + ')';
      if (tables.has('tasks')) {
        const r = db.prepare(`
          SELECT COUNT(*) AS c FROM tasks
          WHERE created_by_agent_id IN ${placeholders24}
            AND state = 'DONE' AND updated_at >= ?
        `).get(...hints, ago24h);
        last_24h.tasks_done = (r && r.c) || 0;
      }
      if (tables.has('scratchpad')) {
        const hintsLike2 = hints.map(h => `mentor/${h}/%`);
        const phLike = hintsLike2.map(() => 'key LIKE ?').join(' OR ');
        const r = db.prepare(`
          SELECT COUNT(*) AS c FROM scratchpad
          WHERE (${phLike}) AND created_at >= ?
        `).get(...hintsLike2, ago24h);
        last_24h.mentor_decisions = (r && r.c) || 0;
      }
      if (tables.has('conflicts')) {
        const r = db.prepare(`
          SELECT COUNT(*) AS c FROM conflicts
          WHERE updated_at >= ?
        `).get(ago24h);
        last_24h.conflicts_touched = (r && r.c) || 0;
      }
      if (tables.has('checkpoints')) {
        const r = db.prepare(`
          SELECT COUNT(*) AS c FROM checkpoints
          WHERE agent_id IN ${placeholders24} AND created_at >= ?
        `).get(...hints, ago24h);
        last_24h.checkpoints_made = (r && r.c) || 0;
      }
    } catch (_e) { cairnLog.warn('cockpit-state', 'last_24h_stats_failed', { message: (_e && _e.message) || String(_e) }); }
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
        } catch (_e) { cairnLog.warn('cockpit-state', 'orphan_tasks_query_failed', { message: (_e && _e.message) || String(_e) }); orphans = []; }
        stale_agents.push({
          agent_id: p.agent_id,
          last_seen_ago_ms: lastSeenAgo,
          last_heartbeat: Number(p.last_heartbeat || 0),
          orphan_count: orphans.length,
          orphans, // first 20
        });
      }
    } catch (_e) { cairnLog.warn('cockpit-state', 'stale_agents_detection_failed', { message: (_e && _e.message) || String(_e) }); }
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
    mode: project.mode || 'B',
    // Mode A v2 phase (CEO 2026-05-14 reframe). idle | planning |
    // plan_pending | running | paused. Drives the Start/Stop/Re-plan
    // surface in the panel sidebar.
    mode_a_phase: project.mode_a_phase || 'idle',
    // MA-2b (2026-05-14): Mode A execution plan, when mode=A + goal set.
    // null otherwise. Steps array = ordered success_criteria.
    mode_a_plan,
    // 2026-05-14: active ACTIVE-status processes attributable to this
    // project. Mode A's decideNextDispatch requires ≥1 to fire.
    active_agents_count,
    // schema-v2 surface (2026-05-14): Mentor north-star + computed in-flight
    whole_sentence,
    cairn_md_present,
    in_flight,
    // Phase 5 (2026-05-14): "Mentor saved you N" productivity-feedback counter
    mentor_decisions,
    // Phase 6 (2026-05-14): stale-agent + orphan task surface
    stale_agents,
    // Phase 7 (2026-05-14): "since 24h ago" Project Glance summary
    last_24h,
    autopilot_status: autopilot,
    autopilot_reason: autopilot === AUTOPILOT_STATUS.NO_GOAL
      ? 'project has no goal — set one to enable Mentor'
      : autopilot === AUTOPILOT_STATUS.AGENT_IDLE
        ? 'no agent currently running for this project'
        : autopilot === AUTOPILOT_STATUS.MENTOR_BLOCKED_NEED_USER
          ? `${escalationsPending.length} escalation(s) need your attention`
          : 'agent working — Mentor handling on track',
    agents,
    // Module 4 Sessions (panel-cockpit-redesign 2026-05-14): richer than
    // `agents` — includes idle + stale entries (within 24h), per-session
    // display name, current task context.
    sessions,
    // Mode B (slice 2): authorized lane chains for this project.
    lanes,
    progress,
    current_task: currentTask,
    latest_mentor_nudge: latestMentor,
    activity,
    checkpoints,
    escalations: allEscalations,
    todolist,
    // Signal-cat refactor commit A (2026-05-15): {available, missing}
    // arrays of ~~category placeholder names (without `~~` prefix).
    // Panel STATUS pill row renders these. Empty arrays = row hidden.
    mentor_signals,
    ts: now,
  };
}

module.exports = {
  AUTOPILOT_STATUS,
  deriveAutopilotStatus,
  ACTIVITY_LIMIT_DEFAULT,
  CHECKPOINT_LIMIT_DEFAULT,
  ESCALATION_LIMIT_DEFAULT,
  TODOLIST_LIMIT_DEFAULT,
  SUPPORTED_TABLES,
  buildCockpitState,
  emptyCockpitState,
  // Exported for tests / debug.
  queryProgress,
  queryCurrentTask,
  queryAgents,
  querySessions,
  querySessionTimeline,
  deriveSessionDisplayName,
  queryLatestMentorNudge,
  queryEscalations,
  queryCheckpoints,
  queryActivityFeed,
  queryTodoList,
  deriveAutopilotStatus,
  // Signal-cat refactor commit A (2026-05-15): pure derivation helper +
  // {available, missing} category-placeholder summary surfaced as
  // state.mentor_signals.
  deriveMentorSignalsSummary,
};
