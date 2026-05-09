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
  atomicWriteJson(REGISTRY_PATH, out);
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

function uniqueDbPaths(reg) {
  const set = new Set();
  for (const p of reg.projects) set.add(p.db_path);
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
  // aggregation
  uniqueDbPaths,
  hintsByDbPath,
};
