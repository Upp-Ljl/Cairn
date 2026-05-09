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
  // Decorate before returning so every consumer (panel, tooltip,
  // prompt-pack) sees the same display labels.
  decorateActivities(activities);
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
  decorateActivities(activities);
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

// ---------------------------------------------------------------------------
// Display identity (UI hardening)
// ---------------------------------------------------------------------------
//
// The panel must speak human, not "claude-code/session-file medium-high
// busy". This layer derives display fields once, in one place, so every
// renderer (Sessions tab / Unassigned / Detail card) shows the same
// labels.
//
// Rules:
//   - app + numbering = primary identity ("Claude Code · 1")
//   - state = product language ("Working" / "Ready" / "Recent" / …)
//   - source = "Observed via …" sentence, never the raw source path
//   - attribution = "matched by project folder" / "reported by Cairn MCP"
//                   / "manually assigned"
//   - raw session_id / pid / agent_id stays in `detail` only

const APP_LABEL = {
  'mcp':         'Cairn MCP',
  'claude-code': 'Claude Code',
  'codex':       'Codex',
};

const APP_SOURCE_KIND = {
  'mcp':         'mcp',      // we own the source (Cairn SQLite)
  'claude-code': 'native',   // first-party adapter on a native app
  'codex':       'adapter',  // log-scan adapter only
};

const APP_SOURCE_SENTENCE = {
  'mcp':         'Cairn MCP heartbeat',
  'claude-code': 'Claude Code session file',
  'codex':       'Codex local session log',
};

// Human-friendly state names. Mapped from state (not state_family) so
// the user can still tell "Working" (busy) from "Ready" (idle) and
// "Stale" (expired heartbeat) from "Inactive" (no recent file write).
const HUMAN_STATE_LABEL = {
  active:   'Working',     // mcp ACTIVE — heartbeating + status=ACTIVE
  busy:     'Working',     // claude busy
  idle:     'Ready',       // claude idle = pid alive, ready for input
  recent:   'Recent',      // codex recent = file mtime within window
  inactive: 'Inactive',    // mcp IDLE / codex inactive
  stale:    'Stale',       // mcp ACTIVE w/ expired heartbeat
  dead:     'Dead',
  unknown:  'Unknown',
};

const STATE_EXPLANATION = {
  active:   'Cairn MCP saw a fresh heartbeat from this runner.',
  busy:     'Claude Code\'s session file reports it is in a turn right now.',
  idle:     'Claude Code\'s session file reports it is between turns; the process is alive and ready.',
  recent:   'Codex\'s local rollout log was written to in the last minute.',
  inactive: 'No recent activity; the source still reports the session exists.',
  stale:    'The runner claimed ACTIVE but its heartbeat is older than the TTL window.',
  dead:     'The process is gone; the agent is no longer running.',
  unknown:  'The source did not provide enough information to infer state.',
};

const ATTRIBUTION_LABEL = {
  capability: 'reported by Cairn MCP',
  hint:       'manually assigned',
  cwd:        'matched by project folder',
};

const CONFIDENCE_LABEL = {
  high:          'high',
  'medium-high': 'medium-high',
  medium:        'medium',
};

/**
 * Stable sort key for per-app numbering. Order:
 *   1. started_at (oldest first — first session you opened gets #1)
 *   2. last_seen_at (fallback — sessions without a started_at)
 *   3. session_id ASCII order (final tiebreaker so numbering is stable
 *      across re-scans even when timestamps tie)
 *
 * MCP rows have detail.registered_at, claude/codex have started_at
 * (in detail). Fall back to last_seen_at, then session_id, then id.
 */
function activityStableKey(a) {
  const started = (a && a.detail && a.detail.started_at)
    || (a && a.detail && a.detail.registered_at)
    || a.last_seen_at || 0;
  const sid = (a && (a.session_id || a.id)) || '';
  return [started, sid];
}

/**
 * Number activities of the same app within one project so the user
 * sees "Claude Code · 1" / "Claude Code · 2" instead of two opaque
 * UUIDs. Pure: takes an array, returns a Map<id, number>.
 *
 * @param {object[]} activities
 * @returns {Map<string, number>}
 */
function numberActivitiesByApp(activities) {
  const result = new Map();
  if (!Array.isArray(activities)) return result;
  /** @type {Map<string, object[]>} */
  const buckets = new Map();
  for (const a of activities) {
    if (!a || !a.app) continue;
    if (!buckets.has(a.app)) buckets.set(a.app, []);
    buckets.get(a.app).push(a);
  }
  for (const [, list] of buckets) {
    list.sort((x, y) => {
      const [xt, xs] = activityStableKey(x);
      const [yt, ys] = activityStableKey(y);
      if (xt !== yt) return xt - yt;
      if (xs < ys) return -1;
      if (xs > ys) return 1;
      return 0;
    });
    list.forEach((a, idx) => { result.set(a.id, idx + 1); });
  }
  return result;
}

/**
 * Mutate an AgentActivity in place to add the display identity
 * fields. Caller is responsible for passing the per-app number from
 * numberActivitiesByApp. The display fields never include raw
 * session id, pid, or agent_id (those stay in detail).
 *
 * @param {object} activity
 * @param {number} appNumber  1-based per-app sequence within the project
 * @returns {object}          same activity (mutated)
 */
function decorateActivity(activity, appNumber) {
  if (!activity) return activity;
  const appLabel = APP_LABEL[activity.app] || activity.app;
  const sourceKind = APP_SOURCE_KIND[activity.app] || 'adapter';
  const sourceSentence = APP_SOURCE_SENTENCE[activity.app] || activity.source;
  const stateLabel = HUMAN_STATE_LABEL[activity.state] || 'Unknown';
  const stateExplanation = STATE_EXPLANATION[activity.state]
    || 'State not recognized.';
  const attributionLabel = activity.attribution
    ? (ATTRIBUTION_LABEL[activity.attribution] || activity.attribution)
    : 'unassigned';

  // For MCP, the first session in a project (#1) reads cleanest as
  // "Cairn MCP · Runner"; subsequent ones become "Cairn MCP · Runner 2".
  // For Claude / Codex, "Terminal 1" / "Terminal 2" reads more natural
  // since users typically open them in terminals.
  const seat = (activity.app === 'mcp')
    ? (appNumber === 1 ? 'Runner' : `Runner ${appNumber}`)
    : `Terminal ${appNumber}`;

  activity.display_label   = `${appLabel} · ${seat}`;
  activity.short_label     = (activity.app === 'mcp')
    ? `MCP ${appNumber}`
    : (activity.app === 'claude-code' ? `Claude ${appNumber}` : `Codex ${appNumber}`);
  activity.app_label       = appLabel;
  activity.seat_label      = seat;
  activity.source_kind     = sourceKind;
  activity.source_label    = `Observed via ${sourceSentence}`;
  activity.confidence_label = CONFIDENCE_LABEL[activity.confidence] || activity.confidence || 'unknown';
  activity.human_state_label = stateLabel;
  activity.state_explanation = stateExplanation;
  activity.attribution_label = attributionLabel;
  return activity;
}

/**
 * Decorate every activity in the list with display identity. Mutates
 * input array entries. Returns the same array for chaining.
 */
function decorateActivities(activities) {
  const numbers = numberActivitiesByApp(activities);
  for (const a of (activities || [])) {
    decorateActivity(a, numbers.get(a && a.id) || 1);
  }
  return activities;
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
  // Display identity (UI hardening).
  decorateActivity,
  decorateActivities,
  numberActivitiesByApp,
  APP_LABEL,
  APP_SOURCE_KIND,
  APP_SOURCE_SENTENCE,
  HUMAN_STATE_LABEL,
  STATE_EXPLANATION,
  ATTRIBUTION_LABEL,
};
