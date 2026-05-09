'use strict';

/**
 * Agent Activity Layer v1 — unified projection over the three host-level
 * presence sources (MCP processes table, Claude session-file adapter,
 * Codex session-log adapter).
 *
 * What this layer is for:
 *   - The panel previously had to know about three different row shapes.
 *     "Project Pulse" / Goal-Mode pre-work needs project state, not raw
 *     adapter rows. This module produces one row shape — AgentActivity —
 *     that the panel and the goal-signals module can consume uniformly.
 *   - Source identity is preserved in `app` + `source` + `confidence`,
 *     so the UI keeps showing distinct chips per source.
 *
 * What this layer is NOT:
 *   - It does not own attribution rules. MCP attribution still comes
 *     from project-queries.cjs::resolveProjectAgentIds (capability tags
 *     ∪ legacy hints). Claude / Codex attribution comes from
 *     attributeClaudeSessionToProject / attributeCodexSessionToProject
 *     (cwd ⊆ project_root). This module just converts already-attributed
 *     rows into the unified shape.
 *   - It writes nothing. Pure converter.
 *
 * Public shape (one row per agent):
 *
 *   {
 *     id:                synthetic stable id ("mcp:<agent_id>", etc.)
 *     app:               "mcp" | "claude-code" | "codex"
 *     source:            original adapter source string
 *                        (e.g. "claude-code/session-file")
 *     confidence:        "high" | "medium-high" | "medium"
 *     project_id:        registry entry id, or null when Unassigned
 *     project_root:      registry entry project_root, or null
 *     attribution:       "capability" | "hint" | "cwd" | null
 *                        (how this row got attributed; null when Unassigned)
 *     cwd:               best-effort cwd (capability tag for mcp,
 *                        row.cwd for claude/codex)
 *     state:             "active" | "busy" | "idle" | "recent" |
 *                        "inactive" | "stale" | "dead" | "unknown"
 *     state_family:      "live" | "recent" | "inactive" | "dead" |
 *                        "unknown"
 *     display_name:      short human-readable label
 *     session_id:        Claude/Codex UUID, or MCP session-tag value
 *     agent_id:          MCP agent_id; null for non-MCP
 *     pid:               number, or null
 *     version:           runtime version string, or null
 *     last_seen_at:      unix ms — when we last had positive evidence
 *                        the agent existed (heartbeat / file mtime)
 *     last_activity_at:  unix ms — when the agent last did something
 *                        (alias of last_seen_at for these adapters; we
 *                        don't have a finer-grained activity signal)
 *     detail:            app-specific extras (agent_type, owns_tasks,
 *                        raw_status, originator, …)
 *   }
 */

const projectQueries = require('./project-queries.cjs');

// ---------------------------------------------------------------------------
// State / family mapping
// ---------------------------------------------------------------------------
//
// Family rules (locked here so the UI / Goal Pulse layer don't each
// invent their own):
//
//   live       — pid alive AND the source claims the agent is ready or
//                actively working:
//                  mcp ACTIVE (heartbeat fresh, status=ACTIVE)
//                  claude busy / idle (pid alive, claude self-report)
//   recent     — file-system evidence of recent work, but we lack pid
//                liveness:
//                  codex recent (rollout mtime within window)
//   inactive   — registered/known but no evidence of current work:
//                  mcp STALE (claimed ACTIVE but heartbeat expired)
//                  mcp IDLE / unrecognized status (status≠ACTIVE/DEAD)
//                  codex inactive
//                  claude stale (reserved; never produced today)
//   dead       — pid gone:
//                  mcp DEAD (status=DEAD in db)
//                  claude dead (process.kill ESRCH)
//   unknown    — can't tell:
//                  claude unknown (no pid, or unrecognized status)
//                  codex unknown (meta unparseable / missing)
//
// Why claude idle goes to `live` rather than `inactive`: the Claude
// session-file adapter writes "idle" only when pid is alive and
// Claude's CLI explicitly self-reports ready-for-input. That's a usable
// agent presence — distinct from "no signal" inactive states. The tray
// "live agents" count therefore matches the user's mental model of
// "how many open Claude sessions can I send a turn to right now".

function familyForState(state) {
  switch (state) {
    case 'active':
    case 'busy':
    case 'idle':    return 'live';
    case 'recent':  return 'recent';
    case 'stale':
    case 'inactive': return 'inactive';
    case 'dead':    return 'dead';
    default:        return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Capability-tag helpers (mirror project-queries.cjs::parseCapabilityTag)
// ---------------------------------------------------------------------------

/**
 * Pull the value of the first matching `<key>:<value>` capability tag.
 * Returns null when the tag is absent. Defensive against non-array
 * capability inputs.
 */
function pickCapTag(capabilities, key) {
  if (!Array.isArray(capabilities)) return null;
  for (const tag of capabilities) {
    if (typeof tag !== 'string') continue;
    const idx = tag.indexOf(':');
    if (idx <= 0) continue;
    if (tag.slice(0, idx) === key) return tag.slice(idx + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-source converters (pure)
// ---------------------------------------------------------------------------

/**
 * Convert one row from queryProjectScopedSessions / queryUnassignedDetail.agents
 * into an AgentActivity. The MCP "high" confidence reflects: this row
 * came from the SQLite table Cairn itself owns and writes, so we trust
 * its presence claims more than file-scan adapters.
 *
 * @param {object} row    Row shape from project-queries: agent_id,
 *                        agent_type, status, computed_state,
 *                        last_heartbeat, heartbeat_ttl, capabilities (already
 *                        parsed to string[]), owns_tasks.
 * @param {object|null} project  Registered project (or null for Unassigned).
 * @param {{attribution?:string}} [opts]
 *                        attribution = "capability" | "hint" — passed
 *                        through if known; null otherwise.
 * @returns {object} AgentActivity
 */
function activityFromMcpRow(row, project, opts) {
  const cs = row && row.computed_state;
  let state;
  switch (cs) {
    case 'ACTIVE': state = 'active'; break;
    case 'STALE':  state = 'stale';  break;
    case 'DEAD':   state = 'dead';   break;
    case 'OTHER':
    default:
      // status="IDLE" (or any unrecognized non-ACTIVE/DEAD) lands here.
      // We surface as "idle" to keep the state vocabulary stable, while
      // the family math drops it to inactive — see family rules above.
      state = (row && row.status && row.status.toLowerCase() === 'idle')
        ? 'idle' : 'inactive';
      break;
  }

  const caps = row && row.capabilities;
  const cwd = pickCapTag(caps, 'cwd');
  const sessionId = pickCapTag(caps, 'session');
  const pidStr = pickCapTag(caps, 'pid');
  const pid = pidStr && /^\d+$/.test(pidStr) ? parseInt(pidStr, 10) : null;

  const display = row && row.agent_id
    ? row.agent_id.length > 18 ? row.agent_id.slice(0, 18) : row.agent_id
    : '(unknown agent)';

  return {
    id: 'mcp:' + (row && row.agent_id),
    app: 'mcp',
    source: 'mcp/processes',
    confidence: 'high',
    project_id: project ? project.id : null,
    project_root: project ? project.project_root : null,
    attribution: (opts && opts.attribution) || null,
    cwd: cwd || null,
    state,
    state_family: familyForState(state),
    display_name: display,
    session_id: sessionId,
    agent_id: (row && row.agent_id) || null,
    pid,
    version: null,
    last_seen_at: row && row.last_heartbeat ? row.last_heartbeat : 0,
    last_activity_at: row && row.last_heartbeat ? row.last_heartbeat : 0,
    detail: {
      agent_type: (row && row.agent_type) || null,
      raw_status: (row && row.status) || null,
      computed_state: cs || null,
      heartbeat_ttl: (row && row.heartbeat_ttl) || null,
      registered_at: (row && row.registered_at) || null,
      capabilities: Array.isArray(caps) ? caps : [],
      owns_tasks: (row && row.owns_tasks) || null,
    },
  };
}

/**
 * Convert a Claude session-file row into an AgentActivity.
 * @param {object} row
 * @param {object|null} project
 */
function activityFromClaudeRow(row, project) {
  const lower = (row && row.status && row.status.toLowerCase()) || 'unknown';
  // Claude states verbatim from the adapter; reserve `stale` even
  // though it is never produced today (see adapter notes).
  const state =
    lower === 'busy'    ? 'busy' :
    lower === 'idle'    ? 'idle' :
    lower === 'stale'   ? 'stale' :
    lower === 'dead'    ? 'dead' :
                          'unknown';
  const sid = row && row.session_id;
  return {
    id: 'claude:' + (sid || ('pid' + (row && row.pid)) || Math.random().toString(36).slice(2)),
    app: 'claude-code',
    source: (row && row.source) || 'claude-code/session-file',
    confidence: (row && row.confidence) || 'medium-high',
    project_id: project ? project.id : null,
    project_root: project ? project.project_root : null,
    attribution: project ? 'cwd' : null,
    cwd: (row && row.cwd) || null,
    state,
    state_family: familyForState(state),
    display_name: 'claude:' + (sid ? sid.slice(0, 8) : '?'),
    session_id: sid || null,
    agent_id: null,
    pid: row && Number.isInteger(row.pid) ? row.pid : null,
    version: (row && row.version) || null,
    last_seen_at: (row && row.updated_at) || 0,
    last_activity_at: (row && row.updated_at) || 0,
    detail: {
      raw_status: (row && row.raw_status) || null,
      stale_reason: (row && row.stale_reason) || null,
      started_at: (row && row.started_at) || null,
      age_ms: (row && row.age_ms) != null ? row.age_ms : null,
    },
  };
}

/**
 * Convert a Codex session-log row into an AgentActivity. Codex carries
 * no pid; the adapter never produces busy/idle. Vocabulary stays
 * recent / inactive / unknown.
 * @param {object} row
 * @param {object|null} project
 */
function activityFromCodexRow(row, project) {
  const lower = (row && row.status && row.status.toLowerCase()) || 'unknown';
  const state =
    lower === 'recent'   ? 'recent' :
    lower === 'inactive' ? 'inactive' :
                           'unknown';
  const sid = row && row.session_id;
  return {
    id: 'codex:' + (sid || (row && row.file) || Math.random().toString(36).slice(2)),
    app: 'codex',
    source: (row && row.source) || 'codex/session-log',
    confidence: (row && row.confidence) || 'medium',
    project_id: project ? project.id : null,
    project_root: project ? project.project_root : null,
    attribution: project ? 'cwd' : null,
    cwd: (row && row.cwd) || null,
    state,
    state_family: familyForState(state),
    display_name: 'codex:' + (sid ? sid.slice(0, 8) : '?'),
    session_id: sid || null,
    agent_id: null,
    pid: null,
    version: (row && row.version) || null,
    last_seen_at: (row && row.updated_at) || 0,
    last_activity_at: (row && row.updated_at) || 0,
    detail: {
      originator: (row && row.originator) || null,
      source_app: (row && row.source_app) || null,
      stale_reason: (row && row.stale_reason) || null,
      started_at: (row && row.started_at) || null,
      age_ms: (row && row.age_ms) != null ? row.age_ms : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Aggregation: project + unassigned activities
// ---------------------------------------------------------------------------

/**
 * Build the AgentActivity payload for a single project.
 *
 * Inputs:
 *   - project: registry entry { id, project_root, agent_id_hints, db_path }.
 *   - mcpRows: pre-attributed MCP row list for this project (already
 *              filtered via resolveProjectAgentIds + attribution tags).
 *              Each row needs `attribution` = "capability" | "hint"
 *              when known.
 *   - claudeRowsAll: every Claude row scanned this poll (we partition).
 *   - codexRowsAll: every Codex row scanned this poll (we partition).
 *
 * Returns: { activities, summary } where summary buckets rows by
 * state_family for L1 cards / tray.
 *
 * @param {object} project
 * @param {Array<object>} mcpRows
 * @param {Array<object>} claudeRowsAll
 * @param {Array<object>} codexRowsAll
 * @param {object} adapters  { claude, codex } — modules with
 *                           partitionByProject. Injected so this file
 *                           doesn't have to require the adapters and
 *                           is therefore trivially mockable in smoke.
 * @returns {{ activities: object[], summary: object }}
 */
function buildProjectActivities(project, mcpRows, claudeRowsAll, codexRowsAll, adapters) {
  const activities = [];
  for (const row of mcpRows || []) {
    activities.push(activityFromMcpRow(row, project, { attribution: row && row._attribution }));
  }
  if (adapters && adapters.claude && project) {
    const { matched } = adapters.claude.partitionByProject(claudeRowsAll || [], project);
    for (const row of matched) activities.push(activityFromClaudeRow(row, project));
  }
  if (adapters && adapters.codex && project) {
    const { matched } = adapters.codex.partitionByProject(codexRowsAll || [], project);
    for (const row of matched) activities.push(activityFromCodexRow(row, project));
  }
  return { activities, summary: summarizeActivities(activities) };
}

/**
 * Build the Unassigned AgentActivity payload for a single db_path.
 * MCP rows here came from queryUnassignedDetail.agents (Cairn agents
 * not in any registered project's hints / capabilities). Claude / Codex
 * rows come from the global adapter scans, filtered to "no project
 * matches".
 */
function buildUnassignedActivities(mcpRows, claudeRowsUnassigned, codexRowsUnassigned) {
  const activities = [];
  for (const row of mcpRows || []) {
    activities.push(activityFromMcpRow(row, null, { attribution: null }));
  }
  for (const row of claudeRowsUnassigned || []) {
    activities.push(activityFromClaudeRow(row, null));
  }
  for (const row of codexRowsUnassigned || []) {
    activities.push(activityFromCodexRow(row, null));
  }
  return { activities, summary: summarizeActivities(activities) };
}

/**
 * Bucket an activity list by app + family. Output shape consumed by
 * L1 cards and the tray tooltip aggregator. All numeric fields are
 * present (zero by default) so callers don't need null-checks.
 *
 * @param {Array<object>} activities
 * @returns {object}
 */
function summarizeActivities(activities) {
  const out = {
    total: 0,
    by_family: { live: 0, recent: 0, inactive: 0, dead: 0, unknown: 0 },
    by_app:    { mcp: 0, 'claude-code': 0, codex: 0 },
    last_activity_at: 0,
  };
  if (!Array.isArray(activities)) return out;
  for (const a of activities) {
    if (!a) continue;
    out.total++;
    if (a.state_family in out.by_family) out.by_family[a.state_family]++;
    if (a.app in out.by_app) out.by_app[a.app]++;
    if (Number.isFinite(a.last_activity_at) && a.last_activity_at > out.last_activity_at) {
      out.last_activity_at = a.last_activity_at;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// MCP attribution tagger
// ---------------------------------------------------------------------------
//
// For MCP rows, we want each row to carry whether it was attributed via
// capability tag or via legacy hint — so the panel detail card can
// say "matched by git_root capability" vs "manual hint added 2026-04-30".
//
// project-queries.cjs::resolveProjectAgentIds returns a flat agent_id
// list (hints ∪ capability matches) without that distinction. Given a
// raw process row, we reconstruct the "why" cheaply: if any cap tag in
// `capabilities` matches the project_root, mark "capability"; else if
// agent_id ∈ hints, mark "hint"; else null (shouldn't happen for
// project-attributed rows but kept for safety).

function decideMcpAttribution(rowCapabilities, projectRoot, projectHints, agentId) {
  if (Array.isArray(rowCapabilities) && projectRoot && projectRoot !== '(unknown)') {
    if (projectQueries.capabilitiesMatchProject(rowCapabilities, projectRoot)) {
      return 'capability';
    }
  }
  if (Array.isArray(projectHints) && agentId && projectHints.includes(agentId)) {
    return 'hint';
  }
  return null;
}

module.exports = {
  // Pure converters (smoke tests these directly).
  activityFromMcpRow,
  activityFromClaudeRow,
  activityFromCodexRow,
  // Aggregators.
  buildProjectActivities,
  buildUnassignedActivities,
  summarizeActivities,
  // Helpers.
  familyForState,
  pickCapTag,
  decideMcpAttribution,
};
