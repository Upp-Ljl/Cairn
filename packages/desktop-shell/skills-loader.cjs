'use strict';

/**
 * skills-loader.cjs — Runtime loader for externalized Cairn skill files.
 *
 * Borrowed from the CC PM plugin's mentor pattern (analysis
 * `docs/superpowers/analyses/2026-05-15-mentor-pattern-from-plugin.md`):
 * the "what good output looks like" quality bar for each LLM call point
 * (Scout plan-shape, Mentor advisor output, Lead-CC handoff protocol) is
 * extracted from hardcoded prompt strings into editable markdown files
 * under `~/.cairn/skills/<name>.md`. The user can `vim` a skill file to
 * retune Cairn's behaviour without rebuilding code.
 *
 * Locked constraints (from analysis §6 + Phase 1 spec):
 *   - Pure fs read; NO code execution, NO hooks, NO I/O side effects in
 *     skill content. Skill = pure prompt-prefix text.
 *   - User override at `~/.cairn/skills/<name>.md` wins over embedded
 *     default at `<this-dir>/skills-defaults/<name>.md`.
 *   - Both paths fail → `{ ok: false, ... }` so caller can fall through
 *     to a 5-line graceful-degrade hardcoded fallback.
 *   - No new schema, no new MCP tool, no new host-level state.
 *
 * Cache: file content + mtime memoized on first call. Subsequent calls
 * re-stat (cheap) and reload only if mtime advanced. Stat is per-call
 * (no time-window throttle) — stat is ~µs on a local fs, fine for the
 * call rates we see (one per Scout / Mentor / spawner invocation).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULTS_DIR = path.resolve(__dirname, 'skills-defaults');

/** name → { source, path, text, mtimeMs } */
const _cache = new Map();

function _userSkillPath(name, home) {
  const h = home || os.homedir();
  return path.join(h, '.cairn', 'skills', name + '.md');
}

function _defaultSkillPath(name) {
  return path.join(DEFAULTS_DIR, name + '.md');
}

function _statMtime(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.mtimeMs : null;
  } catch (_e) {
    return null;
  }
}

function _readIfFresh(cacheKey, candidatePath, source) {
  const mtime = _statMtime(candidatePath);
  if (mtime == null) return null;
  const cached = _cache.get(cacheKey);
  if (cached && cached.source === source && cached.path === candidatePath && cached.mtimeMs === mtime) {
    return cached;
  }
  let text;
  try {
    text = fs.readFileSync(candidatePath, 'utf8');
  } catch (_e) {
    return null;
  }
  const entry = { source, path: candidatePath, text, mtimeMs: mtime };
  _cache.set(cacheKey, entry);
  return entry;
}

/**
 * Load a skill by name. User override at `~/.cairn/skills/<name>.md`
 * wins over embedded default at `skills-defaults/<name>.md`.
 *
 * @param {string} name — skill basename, e.g. "plan-shape"
 * @param {{ home?: string }} [opts]
 * @returns {{ ok: true, text: string, source: 'user'|'default', path: string } | { ok: false, error: string }}
 */
function loadSkill(name, opts) {
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'name_required' };
  }
  const o = opts || {};
  const cacheKey = name + '::' + (o.home || '');

  const userPath = _userSkillPath(name, o.home);
  const userEntry = _readIfFresh(cacheKey, userPath, 'user');
  if (userEntry) {
    return { ok: true, text: userEntry.text, source: userEntry.source, path: userEntry.path };
  }

  const defaultPath = _defaultSkillPath(name);
  const defaultEntry = _readIfFresh(cacheKey, defaultPath, 'default');
  if (defaultEntry) {
    return { ok: true, text: defaultEntry.text, source: defaultEntry.source, path: defaultEntry.path };
  }

  // Clear stale cache for this key — neither path is loadable.
  _cache.delete(cacheKey);
  return { ok: false, error: 'skill_not_found' };
}

/**
 * Copy all default skill files into `~/.cairn/skills/` if a user file
 * doesn't already exist. Never overwrites a user-edited file unless
 * `force: true` is passed. Idempotent — second call is a no-op.
 *
 * @param {{ home?: string, force?: boolean }} [opts]
 * @returns {{ copied: string[], skipped: string[], errors: Array<{ name: string, error: string }> }}
 */
function bootstrapSkillsDir(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const userDir = path.join(home, '.cairn', 'skills');
  const out = { copied: [], skipped: [], errors: [] };

  let defaults = [];
  try {
    defaults = fs.readdirSync(DEFAULTS_DIR).filter(n => n.endsWith('.md'));
  } catch (e) {
    out.errors.push({ name: '<dir>', error: 'defaults_dir_unreadable:' + ((e && e.message) || String(e)) });
    return out;
  }

  try {
    fs.mkdirSync(userDir, { recursive: true });
  } catch (e) {
    out.errors.push({ name: '<dir>', error: 'mkdir_failed:' + ((e && e.message) || String(e)) });
    return out;
  }

  for (const filename of defaults) {
    const src = path.join(DEFAULTS_DIR, filename);
    const dst = path.join(userDir, filename);
    try {
      if (fs.existsSync(dst) && !o.force) {
        out.skipped.push(filename);
        continue;
      }
      const text = fs.readFileSync(src, 'utf8');
      fs.writeFileSync(dst, text, 'utf8');
      out.copied.push(filename);
    } catch (e) {
      out.errors.push({ name: filename, error: (e && e.message) || String(e) });
    }
  }

  return out;
}

/** Test-only helper: list known skill basenames (no `.md` extension). */
function _listKnownSkills() {
  try {
    return fs.readdirSync(DEFAULTS_DIR)
      .filter(n => n.endsWith('.md'))
      .map(n => n.slice(0, -3))
      .sort();
  } catch (_e) {
    return [];
  }
}

/** Test-only helper: clear in-memory cache. */
function _clearCache() {
  _cache.clear();
}

module.exports = {
  loadSkill,
  bootstrapSkillsDir,
  DEFAULTS_DIR,
  _listKnownSkills,
  _clearCache,
};
