'use strict';

/**
 * Project registry for the desktop-shell.
 *
 * Persists at `~/.cairn/projects.json`. Each entry describes a logical
 * project the user has registered with Cairn. Several distinct projects
 * may share the same db_path (mcp-server defaults to the global
 * `~/.cairn/cairn.db` for every cwd), so the canonical identity of a
 * project is `project_root`, not `db_path`. The `agent_id_hints` field
 * is the per-project filter used by project-queries.cjs to attribute
 * rows in the shared DB back to this project.
 *
 * Schema v2:
 *   {
 *     "version": 2,
 *     "projects": [
 *       {
 *         "id": "...",
 *         "label": "...",
 *         "project_root": "D:\\lll\\cairn",   // identity
 *         "db_path": "C:\\Users\\jushi\\.cairn\\cairn.db",  // data source
 *         "agent_id_hints": ["cairn-6eb0e3c955f4"],         // attribution
 *         "added_at": 1715140000000,
 *         "last_opened_at": 1715180000000
 *       }
 *     ]
 *   }
 *
 * Migration:
 *   v0 = no file. Bootstrap from legacy `~/.cairn/desktop-shell.json.dbPath`
 *        if present, into a single entry with `project_root='(unknown)'`
 *        and empty hints (the user adds hints via the panel).
 *   v1 (older Quick Slice draft, never shipped) = same fields minus
 *        project_root + agent_id_hints. Treated as v0 for migration.
 *
 * desktop-shell is the only writer to this file. The daemon never
 * reads or writes it. mcp-server never reads or writes it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cairnLog = require('./cairn-log.cjs');

const REGISTRY_PATH       = path.join(os.homedir(), '.cairn', 'projects.json');
const LEGACY_PREFS_PATH   = path.join(os.homedir(), '.cairn', 'desktop-shell.json');
const DEFAULT_DB_PATH     = path.join(os.homedir(), '.cairn', 'cairn.db');
const REGISTRY_VERSION    = 2;

/**
 * @typedef {Object} ProjectRegistryEntry
 * @property {string} id              Stable identifier (random; persists across renames)
 * @property {string} label           Display name (user-editable; default = basename of project_root)
 * @property {string} project_root    Absolute path to the project root directory (canonical identity)
 * @property {string} db_path         Absolute path to the SQLite file storing this project's data
 * @property {string[]} agent_id_hints  Agent IDs whose rows belong to this project
 * @property {number} added_at        unix ms
 * @property {number} last_opened_at  unix ms
 */

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/**
 * Compute the legacy project-level agent id `cairn-<sha1(host:path).slice(0,12)>`.
 *
 * **Legacy / backwards-compat only.** Pre-Real-Agent-Presence-v2 (before
 * 2026-05-08), mcp-server's SESSION_AGENT_ID used this exact formula,
 * so every session in a given project shared one deterministic id.
 * v2 switched to per-process random session ids
 * (`cairn-session-<12hex>`); the panel now attributes via capability
 * tags in `processes.capabilities` (see project-queries.cjs).
 *
 * Why this still exists:
 *   - `tasks.created_by_agent_id` rows from pre-v2 sessions still
 *     carry the project-level form; manually adding the legacy id as
 *     a hint via "Add to project…" attributes those historical rows.
 *   - mirrors mcp-server's pre-v2 formula 1:1 so user-typed hints
 *     resolve identically.
 *
 * @param {string} canonicalPath
 * @returns {string}
 */
function deriveAgentIdHint(canonicalPath) {
  const raw = os.hostname() + ':' + canonicalPath;
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  return 'cairn-' + hash.slice(0, 12);
}

function newProjectId() {
  // Short random id; not cryptographic. Stable across renames so callers
  // can pass it through IPC instead of relying on label/path.
  return 'p_' + crypto.randomBytes(6).toString('hex');
}

function defaultLabelFor(projectRoot) {
  if (!projectRoot || projectRoot === '(unknown)') return '(unknown)';
  const base = path.basename(projectRoot);
  return base || projectRoot;
}

/**
 * Normalize a project_root string for collision comparison: forward
 * slashes, trim trailing slash, lowercase on Windows. Kept private to
 * this module so the IPC layer doesn't accidentally use it for anything
 * other than uniqueness checks. Display strings should preserve
 * whatever the user / canonicalizer produced.
 *
 * The Real Agent Presence v2 Claude / Codex adapters use the same
 * normalization shape (project-queries.cjs::normalizePath); the helper
 * is duplicated here only because we don't want registry.cjs to acquire
 * a runtime dependency on the SQL-querying layer just for path math.
 *
 * @param {string} p
 * @returns {string}
 */
function _normalizeRootForCompare(p) {
  if (typeof p !== 'string' || !p) return '';
  let s = p.replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

/**
 * Find the registry entry whose project_root matches `projectRoot` under
 * the same path-comparison rules as Claude/Codex attribution. Returns
 * null when no entry matches; the caller decides whether to surface
 * "already registered" vs add a duplicate (we never auto-add on a
 * collision — the panel needs to tell the user what happened).
 *
 * @param {{ projects: ProjectRegistryEntry[] }} reg
 * @param {string} projectRoot
 * @returns {ProjectRegistryEntry|null}
 */
function findProjectByRoot(reg, projectRoot) {
  if (!reg || !Array.isArray(reg.projects)) return null;
  const target = _normalizeRootForCompare(projectRoot);
  if (!target || target === '(unknown)') return null;
  for (const p of reg.projects) {
    if (_normalizeRootForCompare(p.project_root) === target) return p;
  }
  return null;
}

/**
 * Pick an unused project label, suffixing `(2)`, `(3)`, … on collision.
 * Comparison is case-insensitive so two on-disk paths that only differ
 * in casing don't both try to claim "Foo" — the user typically wouldn't
 * want that even if the OS allows it.
 *
 * If `baseLabel` itself is unused, it's returned unchanged. We avoid
 * "(1)" because users expect the first occurrence to be the bare name.
 *
 * @param {{ projects: ProjectRegistryEntry[] }} reg
 * @param {string} baseLabel
 * @returns {string}
 */
function pickAvailableLabel(reg, baseLabel) {
  const base = (baseLabel && String(baseLabel).trim()) || '(project)';
  const taken = new Set();
  if (reg && Array.isArray(reg.projects)) {
    for (const p of reg.projects) {
      if (typeof p.label === 'string') taken.add(p.label.toLowerCase());
    }
  }
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Pathological fallback — registry has 1000+ entries with the same
  // base label, which should never happen in practice. Append a random
  // suffix so addProject still produces a unique entry.
  return `${base} (${crypto.randomBytes(2).toString('hex')})`;
}

// ---------------------------------------------------------------------------
// File IO
// ---------------------------------------------------------------------------

function ensureCairnDir() {
  try { fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true }); } catch (_e) {}
}

/**
 * Atomic write: write to temp + rename. Avoids torn writes if the panel
 * crashes mid-save.
 */
function atomicWriteJson(filePath, obj) {
  ensureCairnDir();
  const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Read the registry file, returning an empty v2 shape if it doesn't
 * exist or is malformed. Never throws into the caller.
 */
function readRegistryFile() {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return null;
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_e) {
    return null;
  }
}

function readLegacyPrefs() {
  try {
    if (!fs.existsSync(LEGACY_PREFS_PATH)) return null;
    const raw = fs.readFileSync(LEGACY_PREFS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap / migration
// ---------------------------------------------------------------------------

/**
 * Seed an initial registry from whatever signal we can find on disk.
 * Used when projects.json doesn't exist yet (first run, or upgrading
 * from Quick Slice).
 *
 * Sources (in priority order):
 *   1. Legacy `desktop-shell.json.dbPath` — create one entry pointing
 *      at that DB, with project_root='(unknown)' (user assigns hints
 *      via panel later).
 *   2. Otherwise — empty registry. Panel will show "no projects
 *      registered yet. Add project…".
 *
 * The legacy `desktop-shell.json` file is left in place so users
 * downgrading to a Quick Slice-era build don't break.
 *
 * @returns {{ version: number, projects: ProjectRegistryEntry[] }}
 */
function bootstrapInitialRegistry() {
  const now = Date.now();
  const legacy = readLegacyPrefs();
  const legacyDb = legacy && typeof legacy.dbPath === 'string' && legacy.dbPath.trim()
    ? legacy.dbPath
    : null;

  if (legacyDb) {
    return {
      version: REGISTRY_VERSION,
      projects: [{
        id: 'legacy-default',
        label: '(legacy default)',
        project_root: '(unknown)',
        db_path: legacyDb,
        agent_id_hints: [],
        added_at: now,
        last_opened_at: now,
      }],
    };
  }

  return { version: REGISTRY_VERSION, projects: [] };
}

/**
 * Load the registry, performing one-time migration if needed.
 * Persists the migrated result to disk so subsequent loads are cheap.
 *
 * @returns {{ version: number, projects: ProjectRegistryEntry[] }}
 */
function loadRegistry() {
  const existing = readRegistryFile();

  if (existing && existing.version === REGISTRY_VERSION && Array.isArray(existing.projects)) {
    return existing;
  }

  // No file or older shape → bootstrap and persist.
  const fresh = bootstrapInitialRegistry();
  saveRegistry(fresh);
  return fresh;
}

function saveRegistry(reg) {
  if (!reg || typeof reg !== 'object') return;
  const out = {
    version: REGISTRY_VERSION,
    projects: Array.isArray(reg.projects) ? reg.projects : [],
  };
  // Preserve optional meta block (e.g. onboarded_at from B4 wizard).
  if (reg.meta && typeof reg.meta === 'object') {
    out.meta = reg.meta;
  }
  atomicWriteJson(REGISTRY_PATH, out);
  // Logged after the write so caller's HOME / sandbox env is honored
  // (cairnLog resolves LOG_DIR from os.homedir() at first call).
  cairnLog.info('registry', 'registry_saved', {
    path: REGISTRY_PATH,
    projects_count: out.projects.length,
  });
}

// ---------------------------------------------------------------------------
// CRUD helpers (the panel calls these via IPC)
// ---------------------------------------------------------------------------

/**
 * Build a fresh registry entry.
 *
 * Real Agent Presence v2 (2026-05-08): hints default to **empty**.
 * Attribution of new sessions runs through capability tags
 * (`git_root:` / `cwd:`) emitted by mcp-server presence — see
 * project-queries.cjs::resolveProjectAgentIds. Pre-v2 we auto-bootstrapped
 * a legacy `cairn-<sha1(host:gitRoot).slice(0,12)>` hint here, which no
 * longer matches any v2 session. Users can still add hints manually
 * via "Add to project…" — that's the path for historical rows or for
 * non-MCP agents that registered with a custom agent_id.
 *
 * @param {{ project_root: string, db_path?: string, label?: string, agent_id_hints?: string[] }} input
 * @returns {ProjectRegistryEntry}
 */
function makeProjectEntry(input) {
  const now = Date.now();
  const project_root = input.project_root && input.project_root.trim()
    ? input.project_root
    : '(unknown)';
  const db_path = input.db_path && input.db_path.trim()
    ? input.db_path
    : DEFAULT_DB_PATH;
  const hints = Array.isArray(input.agent_id_hints) && input.agent_id_hints.length > 0
    ? input.agent_id_hints.slice()
    : [];
  return {
    id: newProjectId(),
    label: input.label && input.label.trim() ? input.label : defaultLabelFor(project_root),
    project_root,
    db_path,
    agent_id_hints: hints,
    added_at: now,
    last_opened_at: now,
  };
}

function addProject(reg, input) {
  const entry = makeProjectEntry(input);
  const next = { version: REGISTRY_VERSION, projects: [...reg.projects, entry] };
  saveRegistry(next);
  return { reg: next, entry };
}

function removeProject(reg, id) {
  const next = {
    version: REGISTRY_VERSION,
    projects: reg.projects.filter(p => p.id !== id),
  };
  saveRegistry(next);
  return next;
}

function renameProject(reg, id, label) {
  if (!label || !String(label).trim()) return reg;
  const next = {
    version: REGISTRY_VERSION,
    projects: reg.projects.map(p =>
      p.id === id ? { ...p, label: String(label) } : p),
  };
  saveRegistry(next);
  return next;
}

function addHint(reg, id, agentId) {
  if (!agentId) return reg;
  const next = {
    version: REGISTRY_VERSION,
    projects: reg.projects.map(p => {
      if (p.id !== id) return p;
      if (p.agent_id_hints.includes(agentId)) return p;
      return { ...p, agent_id_hints: [...p.agent_id_hints, agentId] };
    }),
  };
  saveRegistry(next);
  return next;
}

// ---------------------------------------------------------------------------
// Project goal (Goal Mode v1)
// ---------------------------------------------------------------------------
//
// Optional `active_goal` field on a project entry. Goal Mode is the
// product-layer reframe: Cairn explains agent activity / tasks / etc.
// in service of one stated goal per project. This is read-mostly —
// the goal is user-authored, never inferred. `~/.cairn/projects.json`
// stays the single source of truth (no cairn.db writes, no
// ~/.claude / ~/.codex writes).
//
// Goal shape:
//   {
//     id:               opaque local id (random)
//     title:            short headline (1 line, ≤120 chars suggested)
//     desired_outcome:  what success looks like in 1-3 sentences
//     success_criteria: string[]    (verifiable; user-authored)
//     non_goals:        string[]    (out-of-scope reminders)
//     created_at:       unix ms
//     updated_at:       unix ms
//   }
//
// Cairn never decides goals. setProjectGoal validates required fields,
// trims, and persists; nothing else. The criteria / non_goals lists
// are passed through verbatim — Cairn isn't the editor for them.

const GOAL_MAX_TITLE_LEN     = 200;
const GOAL_MAX_OUTCOME_LEN   = 2000;
const GOAL_MAX_CRITERIA      = 20;
const GOAL_MAX_CRITERION_LEN = 400;

/**
 * @typedef {Object} ProjectGoal
 * @property {string} id
 * @property {string} title
 * @property {string} desired_outcome
 * @property {string[]} success_criteria
 * @property {string[]} non_goals
 * @property {number} created_at
 * @property {number} updated_at
 */

function newGoalId() {
  return 'g_' + crypto.randomBytes(6).toString('hex');
}

function _trimStr(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function _trimList(xs, maxItems, maxLen) {
  if (!Array.isArray(xs)) return [];
  const out = [];
  for (const x of xs) {
    if (out.length >= maxItems) break;
    const t = _trimStr(x, maxLen);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Read the active goal for a project, or null when absent.
 * @param {{ projects: ProjectRegistryEntry[] }} reg
 * @param {string} projectId
 * @returns {ProjectGoal|null}
 */
function getProjectGoal(reg, projectId) {
  if (!reg || !Array.isArray(reg.projects)) return null;
  const p = reg.projects.find(x => x.id === projectId);
  if (!p) return null;
  return p.active_goal || null;
}

/**
 * Content fingerprint for goal-equality comparison. Returns a stable
 * JSON string covering every user-visible field. If the fingerprint
 * matches a prior goal, the edit was a no-op (e.g. panel re-saved the
 * same form) and we preserve the prior goal_id. If the fingerprint
 * differs, we rotate the goal_id so downstream consumers (notably
 * mode-a-loop.ensurePlan, which compares goal_id) know to supersede.
 *
 * 鸭总 2026-05-14: 改 success_criteria 之后 Mode A 没反应 — root cause
 * was that setProjectGoal was preserving prior.id unconditionally,
 * so ensurePlan saw `goal_id` unchanged and short-circuited to
 * 'unchanged'. The fingerprint check turns "edit means change" back
 * into the truth: any visible field change = new id = supersede.
 */
function _goalContentFingerprint(g) {
  if (!g) return null;
  return JSON.stringify({
    title:            g.title || '',
    desired_outcome:  g.desired_outcome || '',
    success_criteria: Array.isArray(g.success_criteria) ? g.success_criteria : [],
    non_goals:        Array.isArray(g.non_goals)        ? g.non_goals        : [],
  });
}

/**
 * Replace (or create) the active goal on a project. Returns the next
 * registry shape and the persisted goal. Required fields: title.
 * Other fields default to empty strings / arrays.
 *
 * Goal id is preserved ONLY when the edit is content-identical to the
 * prior goal (idempotent re-save). Any change to title /
 * desired_outcome / success_criteria / non_goals rotates the id —
 * this is the trigger ensurePlan watches to decide "supersede vs
 * unchanged". `created_at` is preserved across edits even when id
 * rotates (the entry is still "this project's goal", not a new
 * conceptual object).
 *
 * @param {{ projects: ProjectRegistryEntry[] }} reg
 * @param {string} projectId
 * @param {{ title:string, desired_outcome?:string, success_criteria?:string[], non_goals?:string[] }} input
 * @returns {{ reg: object, goal: ProjectGoal|null, error?: string }}
 */
function setProjectGoal(reg, projectId, input) {
  if (!reg || !Array.isArray(reg.projects)) {
    return { reg, goal: null, error: 'invalid_registry' };
  }
  const idx = reg.projects.findIndex(x => x.id === projectId);
  if (idx < 0) return { reg, goal: null, error: 'project_not_found' };
  const title = _trimStr(input && input.title, GOAL_MAX_TITLE_LEN);
  if (!title) return { reg, goal: null, error: 'title_required' };
  const now = Date.now();
  const prior = reg.projects[idx].active_goal || null;

  // Build a candidate goal shape (sans id) so we can fingerprint it
  // against the prior with identical trim/list-normalization.
  const candidate = {
    title,
    desired_outcome:  _trimStr(input && input.desired_outcome, GOAL_MAX_OUTCOME_LEN),
    success_criteria: _trimList(input && input.success_criteria, GOAL_MAX_CRITERIA, GOAL_MAX_CRITERION_LEN),
    non_goals:        _trimList(input && input.non_goals,        GOAL_MAX_CRITERIA, GOAL_MAX_CRITERION_LEN),
  };
  const sameContent = prior && _goalContentFingerprint(candidate) === _goalContentFingerprint(prior);

  const goal = Object.assign({}, candidate, {
    id:         sameContent ? prior.id         : newGoalId(),
    created_at: (prior && prior.created_at) || now,
    updated_at: now,
  });
  const nextProjects = reg.projects.slice();
  nextProjects[idx] = Object.assign({}, reg.projects[idx], { active_goal: goal });
  const next = { version: REGISTRY_VERSION, projects: nextProjects };
  saveRegistry(next);
  return { reg: next, goal };
}

/**
 * Clear the active goal on a project (no-op if absent).
 * @param {{ projects: ProjectRegistryEntry[] }} reg
 * @param {string} projectId
 * @returns {{ reg: object, cleared: boolean }}
 */
function clearProjectGoal(reg, projectId) {
  if (!reg || !Array.isArray(reg.projects)) return { reg, cleared: false };
  const idx = reg.projects.findIndex(x => x.id === projectId);
  if (idx < 0) return { reg, cleared: false };
  if (!reg.projects[idx].active_goal) return { reg, cleared: false };
  const nextEntry = Object.assign({}, reg.projects[idx]);
  delete nextEntry.active_goal;
  const nextProjects = reg.projects.slice();
  nextProjects[idx] = nextEntry;
  const next = { version: REGISTRY_VERSION, projects: nextProjects };
  saveRegistry(next);
  return { reg: next, cleared: true };
}

// ---------------------------------------------------------------------------
// Project Rules Registry (Goal Mode v2 governance layer)
// ---------------------------------------------------------------------------
//
// Optional `project_rules` field on a project entry. Project rules are
// the user's own engineering policy for one project — coding standards,
// testing policy, reporting policy, Pre-PR checklist, non-goals.
// Cairn does NOT enforce these; they are advisory and feed:
//
//   - the Pre-PR Gate's checklist (rules → suggested checks)
//   - the LLM Interpretation compact-state envelope (rules → context)
//   - the Goal Loop Prompt Pack (rules → "you are working under
//     these constraints")
//
// Rules live in registry, not SQLite. Per-project, locally authored,
// never inferred from agent transcripts. Length-capped so the
// registry stays small.
//
// Shape:
//   {
//     version:           1
//     coding_standards:  string[]
//     testing_policy:    string[]
//     reporting_policy:  string[]
//     pre_pr_checklist:  string[]
//     non_goals:         string[]
//     updated_at:        unix ms
//   }
//
// Backwards-compat: a project entry without `project_rules` still
// works; getEffectiveProjectRules returns a small default ruleset so
// the panel never shows a blank governance card.

const RULES_VERSION = 1;

const RULES_MAX_TOTAL_ITEMS  = 12;   // per section
const RULES_MAX_ITEM_LEN     = 400;  // per item
const RULES_DEFAULT = Object.freeze({
  version: RULES_VERSION,
  coding_standards: [
    'Follow existing patterns in this project; avoid unrelated refactors.',
    'Add comments only when the WHY is non-obvious.',
  ],
  testing_policy: [
    'Run the relevant project smoke before declaring a change done.',
    'Verify read-only invariants (cairn.db / ~/.claude / ~/.codex unchanged).',
  ],
  reporting_policy: [
    'Final report must include: changed files, commands run, results, residual risks.',
    'Note explicitly when a smoke / dogfood was NOT run, and why.',
  ],
  pre_pr_checklist: [
    'No new SQLite schema / migration / MCP tool / npm dep without authorization.',
    'No secret / API key in source, logs, or commit.',
    'No unrelated dirty files in the diff.',
  ],
  non_goals: [
    'Cairn does not write code or auto-dispatch agents.',
    'Cairn does not block git operations or run CI.',
    'No Cursor / Jira / Linear-style features in this product.',
  ],
});

/**
 * @typedef {Object} ProjectRules
 * @property {number} version
 * @property {string[]} coding_standards
 * @property {string[]} testing_policy
 * @property {string[]} reporting_policy
 * @property {string[]} pre_pr_checklist
 * @property {string[]} non_goals
 * @property {number} updated_at
 */

function _trimRulesList(xs, maxItems, maxLen) {
  if (!Array.isArray(xs)) return [];
  const out = [];
  for (const x of xs) {
    if (out.length >= maxItems) break;
    const t = (typeof x === 'string') ? x.trim() : '';
    if (!t) continue;
    out.push(t.length > maxLen ? t.slice(0, maxLen) : t);
  }
  return out;
}

/**
 * Read the active rules for a project, or null when absent.
 * @param {{ projects: ProjectRegistryEntry[] }} reg
 * @param {string} projectId
 * @returns {ProjectRules|null}
 */
function getProjectRules(reg, projectId) {
  if (!reg || !Array.isArray(reg.projects)) return null;
  const p = reg.projects.find(x => x.id === projectId);
  if (!p) return null;
  return p.project_rules || null;
}

/**
 * Get the effective rules: user-set rules if present, else the default
 * ruleset frozen above. Always returns a non-null object so the UI /
 * gate / interpretation never has to special-case "no rules". The
 * `is_default` flag tells the UI which template is rendered.
 *
 * @param {{ projects: ProjectRegistryEntry[] }} reg
 * @param {string} projectId
 * @returns {{ rules: ProjectRules, is_default: boolean }}
 */
function getEffectiveProjectRules(reg, projectId) {
  const stored = getProjectRules(reg, projectId);
  if (stored) return { rules: stored, is_default: false };
  return { rules: Object.assign({ updated_at: 0 }, RULES_DEFAULT), is_default: true };
}

/**
 * Replace (or create) the project's rules. Returns the next registry
 * + persisted rules. All fields are optional individually but at
 * least one section must contain a non-empty item, otherwise we
 * reject — empty rules ≠ "use defaults"; the user clears via
 * clearProjectRules instead.
 *
 * @param {{ projects: ProjectRegistryEntry[] }} reg
 * @param {string} projectId
 * @param {{ coding_standards?:string[], testing_policy?:string[], reporting_policy?:string[], pre_pr_checklist?:string[], non_goals?:string[] }} input
 * @returns {{ reg, rules: ProjectRules|null, error?: string }}
 */
function setProjectRules(reg, projectId, input) {
  if (!reg || !Array.isArray(reg.projects)) {
    return { reg, rules: null, error: 'invalid_registry' };
  }
  const idx = reg.projects.findIndex(x => x.id === projectId);
  if (idx < 0) return { reg, rules: null, error: 'project_not_found' };
  const o = input || {};
  const rules = {
    version: RULES_VERSION,
    coding_standards: _trimRulesList(o.coding_standards, RULES_MAX_TOTAL_ITEMS, RULES_MAX_ITEM_LEN),
    testing_policy:   _trimRulesList(o.testing_policy,   RULES_MAX_TOTAL_ITEMS, RULES_MAX_ITEM_LEN),
    reporting_policy: _trimRulesList(o.reporting_policy, RULES_MAX_TOTAL_ITEMS, RULES_MAX_ITEM_LEN),
    pre_pr_checklist: _trimRulesList(o.pre_pr_checklist, RULES_MAX_TOTAL_ITEMS, RULES_MAX_ITEM_LEN),
    non_goals:        _trimRulesList(o.non_goals,        RULES_MAX_TOTAL_ITEMS, RULES_MAX_ITEM_LEN),
    updated_at: Date.now(),
  };
  const totalItems =
    rules.coding_standards.length +
    rules.testing_policy.length +
    rules.reporting_policy.length +
    rules.pre_pr_checklist.length +
    rules.non_goals.length;
  if (totalItems === 0) return { reg, rules: null, error: 'rules_empty' };
  const nextProjects = reg.projects.slice();
  nextProjects[idx] = Object.assign({}, reg.projects[idx], { project_rules: rules });
  const next = { version: REGISTRY_VERSION, projects: nextProjects };
  saveRegistry(next);
  return { reg: next, rules };
}

/**
 * Clear the project's rules (no-op when absent). Re-fetching after
 * this returns null, and getEffectiveProjectRules drops back to the
 * default ruleset.
 */
function clearProjectRules(reg, projectId) {
  if (!reg || !Array.isArray(reg.projects)) return { reg, cleared: false };
  const idx = reg.projects.findIndex(x => x.id === projectId);
  if (idx < 0) return { reg, cleared: false };
  if (!reg.projects[idx].project_rules) return { reg, cleared: false };
  const nextEntry = Object.assign({}, reg.projects[idx]);
  delete nextEntry.project_rules;
  const nextProjects = reg.projects.slice();
  nextProjects[idx] = nextEntry;
  const next = { version: REGISTRY_VERSION, projects: nextProjects };
  saveRegistry(next);
  return { reg: next, cleared: true };
}

function touchProject(reg, id) {
  const now = Date.now();
  const next = {
    version: REGISTRY_VERSION,
    projects: reg.projects.map(p =>
      p.id === id ? { ...p, last_opened_at: now } : p),
  };
  saveRegistry(next);
  return next;
}

// ---------------------------------------------------------------------------
// Aggregation helpers (used by main.cjs to plan DB connections)
// ---------------------------------------------------------------------------

// Sentinel db_path values that mean "use the host-level default DB".
// Kept in sync with main.cjs::DB_PATH_SENTINELS. Defined here too so
// uniqueDbPaths can normalize before returning — otherwise gcDbHandles
// (which uses uniqueDbPaths to compute the keep-set) would evict the
// DEFAULT_DB_PATH handle while sentinel projects still need it through
// ensureDbHandle's own normalization. Subagent审查 2026-05-14 flagged.
const DB_PATH_SENTINELS_REG = new Set(['/dev/null', '(unknown)']);

function uniqueDbPaths(reg) {
  const set = new Set();
  for (const p of reg.projects) {
    let dbPath = p.db_path;
    // Normalize sentinels to DEFAULT_DB_PATH so the returned set matches
    // what ensureDbHandle actually opens. Empty / falsy db_path is
    // treated the same way (orphaned legacy entries).
    if (!dbPath || DB_PATH_SENTINELS_REG.has(dbPath)) {
      dbPath = DEFAULT_DB_PATH;
    }
    set.add(dbPath);
  }
  return [...set];
}

/**
 * Map of db_path → all hints across all registry projects sharing that
 * db_path. project-queries.cjs uses this to compute Unassigned per DB.
 *
 * @returns {Map<string, Set<string>>}
 */
function hintsByDbPath(reg) {
  const out = new Map();
  for (const p of reg.projects) {
    if (!out.has(p.db_path)) out.set(p.db_path, new Set());
    for (const h of p.agent_id_hints) out.get(p.db_path).add(h);
  }
  return out;
}

module.exports = {
  // paths
  REGISTRY_PATH,
  LEGACY_PREFS_PATH,
  DEFAULT_DB_PATH,
  REGISTRY_VERSION,
  // identity
  deriveAgentIdHint,
  defaultLabelFor,
  findProjectByRoot,
  pickAvailableLabel,
  // load / save
  loadRegistry,
  saveRegistry,
  // crud
  makeProjectEntry,
  addProject,
  removeProject,
  renameProject,
  addHint,
  touchProject,
  // goal mode
  getProjectGoal,
  setProjectGoal,
  clearProjectGoal,
  GOAL_MAX_TITLE_LEN,
  GOAL_MAX_OUTCOME_LEN,
  GOAL_MAX_CRITERIA,
  GOAL_MAX_CRITERION_LEN,
  // project rules
  getProjectRules,
  getEffectiveProjectRules,
  setProjectRules,
  clearProjectRules,
  RULES_VERSION,
  RULES_MAX_TOTAL_ITEMS,
  RULES_MAX_ITEM_LEN,
  RULES_DEFAULT,
  // aggregation
  uniqueDbPaths,
  hintsByDbPath,
};

// ---------------------------------------------------------------------------
// panel-cockpit-redesign Phase 6 — per-project cockpit settings
// (placed AFTER module.exports because CommonJS module.exports is a live
// binding for object members; we attach these at the bottom.)
// ---------------------------------------------------------------------------

/**
 * Defaults per plan decision #14 (leader-per-project) + decision #10 (LLM
 * helper cost posture: low-cost default-on, high-cost default-off).
 */
const COCKPIT_SETTINGS_DEFAULT = Object.freeze({
  leader: 'claude-code',
  // Mode A/B reframe (CEO 2026-05-14). 'B' = user-driven, ranked
  // suggestions + manual dispatch (the existing v0.2.0 behavior — this
  // is the safe default). 'A' = mentor-driven long-running loop. Per
  // PRODUCT.md/plan §2.4 Mode A is opt-in per project; default = 'B'.
  mode: 'B',
  llm_helpers: {
    tail_summary_enabled: true,         // low-cost, default ON
    conflict_explainer_enabled: true,    // low-cost, default ON
    inbox_smart_sort_enabled: false,     // high-cost, default OFF
    goal_input_assist_enabled: false,    // high-cost, default OFF
  },
  escalation_thresholds: {
    error_nudge_cap: 2,
    outcomes_retry_cap: 1,
    time_budget_fraction: 0.80,
  },
  // Mode A auto-ship (CEO 2026-05-14). When enabled, mentor-tick will
  // git commit + push each time a plan step advances to DONE. Defaults
  // off; add-project handler probes for a PAT path and remote URL to
  // populate pat_path / remote_url, but `enabled` requires explicit
  // user opt-in (since push is irreversible to the remote).
  auto_ship: {
    enabled: false,
    remote_url: null,
    default_branch: 'main',
    pat_path: null,
  },
});

const KNOWN_MODES = ['A', 'B'];

function getCockpitSettings(reg, projectId) {
  if (!reg || !Array.isArray(reg.projects)) return COCKPIT_SETTINGS_DEFAULT;
  const p = reg.projects.find(x => x.id === projectId);
  if (!p) return COCKPIT_SETTINGS_DEFAULT;
  const s = p.cockpit_settings || {};
  // Merge against defaults so newly added fields don't break.
  return {
    leader: typeof s.leader === 'string' ? s.leader : COCKPIT_SETTINGS_DEFAULT.leader,
    mode: KNOWN_MODES.includes(s.mode) ? s.mode : COCKPIT_SETTINGS_DEFAULT.mode,
    llm_helpers: Object.assign({}, COCKPIT_SETTINGS_DEFAULT.llm_helpers, s.llm_helpers || {}),
    escalation_thresholds: Object.assign({}, COCKPIT_SETTINGS_DEFAULT.escalation_thresholds, s.escalation_thresholds || {}),
    auto_ship: Object.assign({}, COCKPIT_SETTINGS_DEFAULT.auto_ship, s.auto_ship || {}),
  };
}

/**
 * Set partial cockpit settings (deep-merge for nested fields).
 * Validates input. Returns the next reg; caller must persist via
 * saveRegistry (the IPC layer in main.cjs does this).
 *
 * Returns { reg, settings } on success, { error } on validation fail.
 */
function setCockpitSettings(reg, projectId, input) {
  if (!reg || !Array.isArray(reg.projects)) return { error: 'registry_invalid' };
  const idx = reg.projects.findIndex(x => x.id === projectId);
  if (idx < 0) return { error: 'project_not_found' };
  const cur = getCockpitSettings(reg, projectId);
  const next = {
    leader: typeof input.leader === 'string' ? input.leader : cur.leader,
    mode: typeof input.mode === 'string' ? input.mode : cur.mode,
    llm_helpers: Object.assign({}, cur.llm_helpers, input.llm_helpers || {}),
    escalation_thresholds: Object.assign({}, cur.escalation_thresholds, input.escalation_thresholds || {}),
  };
  // Validate leader against known values (extensible).
  const KNOWN_LEADERS = ['claude-code', 'cursor', 'codex', 'aider', 'cline'];
  if (!KNOWN_LEADERS.includes(next.leader)) {
    return { error: `unknown_leader: ${next.leader}` };
  }
  if (!KNOWN_MODES.includes(next.mode)) {
    return { error: `unknown_mode: ${next.mode}` };
  }
  const newProjects = reg.projects.slice();
  newProjects[idx] = Object.assign({}, newProjects[idx], { cockpit_settings: next });
  const newReg = Object.assign({}, reg, { projects: newProjects });
  return { reg: newReg, settings: next };
}

// Attach Phase 6 exports to module.exports (after const declarations).
module.exports.getCockpitSettings = getCockpitSettings;
module.exports.setCockpitSettings = setCockpitSettings;
module.exports.COCKPIT_SETTINGS_DEFAULT = COCKPIT_SETTINGS_DEFAULT;
module.exports.KNOWN_MODES = KNOWN_MODES;

// ---------------------------------------------------------------------------
// B4 Onboarding wizard — first-launch flag
// ---------------------------------------------------------------------------
//
// `meta.onboarded_at` (unix ms) is written once, on first project add or
// explicit "Skip". The panel reads it at boot to decide whether to show the
// first-launch wizard overlay. It lives in the registry file (projects.json)
// under a top-level `meta` key so it doesn't pollute individual project
// entries and doesn't require a schema migration.
//
// Intentionally kept separate from individual project entries: "has the user
// done onboarding at all?" is a per-installation question, not per-project.

/**
 * Read the onboarded_at timestamp from the registry, or null when absent.
 * @param {{ meta?: { onboarded_at?: number } }} reg
 * @returns {number|null}
 */
function getOnboardedAt(reg) {
  if (!reg || !reg.meta || typeof reg.meta.onboarded_at !== 'number') return null;
  return reg.meta.onboarded_at;
}

/**
 * Stamp the registry with onboarded_at = now if not already set.
 * Returns the next registry shape (caller must persist via saveRegistry).
 * @param {{ meta?: object, version: number, projects: object[] }} reg
 * @returns {{ meta: { onboarded_at: number }, version: number, projects: object[] }}
 */
function markOnboarded(reg) {
  const already = getOnboardedAt(reg);
  if (already) return reg; // idempotent
  const meta = Object.assign({}, reg.meta || {}, { onboarded_at: Date.now() });
  return Object.assign({}, reg, { meta });
}

module.exports.getOnboardedAt = getOnboardedAt;
module.exports.markOnboarded  = markOnboarded;
