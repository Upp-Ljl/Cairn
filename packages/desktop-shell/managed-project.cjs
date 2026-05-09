'use strict';

/**
 * Managed Project Profile v1 — Cairn-managed external repos.
 *
 * Lets the user point Cairn at a real git repo on disk (or one that
 * Cairn can clone for them) and produce a profile describing its
 * shape: package manager, languages, detected scripts, entry points,
 * docs. Profile feeds the Goal Loop Prompt Pack and the Pre-PR Gate
 * so worker prompts can quote real commands instead of generic
 * placeholders.
 *
 * Storage: one JSON file per managed project at
 *   ~/.cairn/managed-projects/<projectId>.json
 *
 * Why a separate file (not on the registry entry):
 *   - Profiles can be regenerated independently (re-detect after deps
 *     change) without rewriting the whole registry.
 *   - Keeps `~/.cairn/projects.json` lean (registry stays a fast
 *     poll-loop read).
 *   - Per-project file means one project's growth never affects
 *     another's read latency.
 *
 * Read/write boundary:
 *   - Writes: ~/.cairn/managed-projects/<projectId>.json only.
 *   - Reads: package.json / lockfiles / tsconfig / README at the
 *     managed-project's local_path. Bounded read sizes.
 *   - Does NOT write to cairn.db / ~/.claude / ~/.codex.
 *   - Does NOT install dependencies, NOR run scripts.
 *   - Cloning runs `git clone` via child_process (only when caller
 *     asks); failure is graceful and never throws.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MANAGED_DIRNAME = 'managed-projects';
const MAX_FILE_BYTES = 256 * 1024;   // bound any read of a project file
const MAX_README_BYTES = 32 * 1024;
const PROFILE_VERSION = 1;

// Files we look at, by purpose. Listed here so the smoke can assert
// nothing else is being slurped.
const FILE_PROBES = [
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'composer.json',
  'README.md',
  'README',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'PRODUCT.md',
  'CLAUDE.md',
  'DESIGN.md',
  'TODO.md',
  'AGENTS.md',
  '.tool-versions',
  '.nvmrc',
];

function managedDir(home) {
  return path.join((home || os.homedir()), '.cairn', MANAGED_DIRNAME);
}

function profilePath(projectId, home) {
  const safe = String(projectId || '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  return path.join(managedDir(home), safe + '.json');
}

function ensureManagedDir(home) {
  try { fs.mkdirSync(managedDir(home), { recursive: true }); } catch (_e) {}
}

function safeReadFile(p, maxBytes) {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return null;
    const fd = fs.openSync(p, 'r');
    try {
      const len = Math.min(stat.size, maxBytes || MAX_FILE_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_e) { return null; }
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch (_e) { return false; }
}

function safeJsonParse(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch (_e) { return null; }
}

function atomicWriteJson(filePath, obj) {
  const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect the package manager from lockfiles + package.json.
 * Prefer lockfile evidence over packageManager hint (lockfile is
 * what's actually in use; packageManager is a wish).
 */
function detectPackageManager(localPath, pkg) {
  if (fileExists(path.join(localPath, 'bun.lock')) || fileExists(path.join(localPath, 'bun.lockb'))) return 'bun';
  if (fileExists(path.join(localPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fileExists(path.join(localPath, 'yarn.lock'))) return 'yarn';
  if (fileExists(path.join(localPath, 'package-lock.json'))) return 'npm';
  if (pkg && typeof pkg.packageManager === 'string') {
    const m = pkg.packageManager.match(/^(npm|pnpm|yarn|bun)/);
    if (m) return m[1];
  }
  return null;
}

function detectLanguages(localPath, files) {
  const langs = new Set();
  if (files.has('package.json'))   langs.add('javascript');
  if (files.has('tsconfig.json'))  langs.add('typescript');
  if (files.has('pyproject.toml') || files.has('requirements.txt')) langs.add('python');
  if (files.has('Cargo.toml'))     langs.add('rust');
  if (files.has('go.mod'))         langs.add('go');
  if (files.has('Gemfile'))        langs.add('ruby');
  if (files.has('composer.json'))  langs.add('php');
  // Light directory hint: presence of `src` + `.ts`/`.tsx` files implies TS.
  // Keep cheap; do not recurse deep.
  try {
    const entries = fs.readdirSync(localPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (/\.tsx?$/.test(e.name)) langs.add('typescript');
      if (/\.jsx?$/.test(e.name)) langs.add('javascript');
      if (/\.py$/.test(e.name))   langs.add('python');
      if (/\.rs$/.test(e.name))   langs.add('rust');
      if (/\.go$/.test(e.name))   langs.add('go');
    }
  } catch (_e) {}
  return Array.from(langs);
}

/**
 * Map a script name + value to a category. We are intentionally
 * conservative — only label well-known patterns.
 */
function classifyScript(name, value) {
  const n = (name || '').toLowerCase();
  const v = (value || '').toLowerCase();
  if (/(^|:)(test|tests)(:|$)/.test(n) || /\btest\b/.test(n)) return 'test';
  if (/(^|:)(lint|fmt|format|typecheck|tsc)(:|$)/.test(n)) return 'lint';
  if (/(^|:)(build|compile)(:|$)/.test(n)) return 'build';
  if (/(^|:)(start|dev|serve)(:|$)/.test(n)) return 'run';
  if (/\btsc\b/.test(v) && !/--watch/.test(v)) return 'lint';
  return null;
}

/**
 * Detect entry points: bin entries from package.json, plus a few
 * conventional file names if they exist at the root.
 */
function detectEntryPoints(localPath, pkg) {
  const out = [];
  if (pkg && pkg.main && typeof pkg.main === 'string') out.push(pkg.main);
  if (pkg && pkg.bin) {
    if (typeof pkg.bin === 'string') out.push(pkg.bin);
    else if (typeof pkg.bin === 'object') {
      for (const k of Object.keys(pkg.bin)) {
        if (typeof pkg.bin[k] === 'string') out.push(`${k} → ${pkg.bin[k]}`);
        if (out.length >= 8) break;
      }
    }
  }
  for (const candidate of ['src/index.ts', 'src/index.js', 'src/main.ts', 'index.ts', 'index.js', 'cli.ts', 'main.py']) {
    if (fileExists(path.join(localPath, candidate))) out.push(candidate);
    if (out.length >= 12) break;
  }
  return Array.from(new Set(out)).slice(0, 12);
}

/**
 * Detect docs files (top-level only — we don't scan docs/).
 */
function detectDocs(files) {
  const out = [];
  for (const cand of ['README.md', 'README', 'CONTRIBUTING.md', 'ARCHITECTURE.md', 'CHANGELOG.md', 'PRODUCT.md', 'CLAUDE.md', 'DESIGN.md', 'TODO.md']) {
    if (files.has(cand)) out.push(cand);
  }
  return out.slice(0, 8);
}

/**
 * Build runner-prefix string for the package manager. Used to convert
 * `npm run build` ↔ `bun run build` etc. without making the prompt
 * lie about the project's tools.
 */
function commandWithRunner(pm, scriptName) {
  if (pm === 'bun')  return `bun run ${scriptName}`;
  if (pm === 'pnpm') return `pnpm ${scriptName}`;
  if (pm === 'yarn') return `yarn ${scriptName}`;
  if (pm === 'npm')  return `npm run ${scriptName}`;
  // Fallback: vanilla npm. Caller can still see scripts_detected.
  return `npm run ${scriptName}`;
}

/**
 * Read the project's package.json + a small set of probes and return
 * a profile shape. Pure: never spawns, never installs, never writes.
 *
 * Returns `{ ok: true, profile }` on success, `{ ok: false, error }`
 * on missing dir / unreadable. `error` is a stable string code, not a
 * leakable message.
 */
function detectProjectProfile(localPath) {
  if (!localPath || typeof localPath !== 'string') {
    return { ok: false, error: 'local_path_required' };
  }
  let stat;
  try { stat = fs.statSync(localPath); } catch (_e) { return { ok: false, error: 'local_path_not_found' }; }
  if (!stat.isDirectory()) return { ok: false, error: 'local_path_not_directory' };

  // Detect which probe files actually exist.
  const detected = new Set();
  for (const f of FILE_PROBES) {
    if (fileExists(path.join(localPath, f))) detected.add(f);
  }

  // Read package.json (the most informative source).
  let pkg = null;
  if (detected.has('package.json')) {
    pkg = safeJsonParse(safeReadFile(path.join(localPath, 'package.json'), MAX_FILE_BYTES));
  }

  const pm = detectPackageManager(localPath, pkg);

  // Classify scripts.
  const scripts_detected = [];
  const test_commands = [];
  const build_commands = [];
  const lint_commands = [];
  const run_commands = [];
  if (pkg && pkg.scripts && typeof pkg.scripts === 'object') {
    for (const name of Object.keys(pkg.scripts)) {
      const value = pkg.scripts[name];
      if (typeof value !== 'string') continue;
      scripts_detected.push({ name, value: value.slice(0, 200) });
      const klass = classifyScript(name, value);
      if (klass === 'test'  && pm) test_commands.push(commandWithRunner(pm, name));
      if (klass === 'build' && pm) build_commands.push(commandWithRunner(pm, name));
      if (klass === 'lint'  && pm) lint_commands.push(commandWithRunner(pm, name));
      if (klass === 'run'   && pm) run_commands.push(commandWithRunner(pm, name));
      if (scripts_detected.length >= 40) break;
    }
  }

  const languages = detectLanguages(localPath, detected);
  const entry_points = detectEntryPoints(localPath, pkg);
  const docs = detectDocs(detected);

  // README first paragraph (capped). Never echoed at full size — we
  // only give the worker prompt a hint.
  let readme_excerpt = '';
  if (detected.has('README.md') || detected.has('README')) {
    const readmeName = detected.has('README.md') ? 'README.md' : 'README';
    const text = safeReadFile(path.join(localPath, readmeName), MAX_README_BYTES) || '';
    // First non-empty paragraph, ≤500 chars.
    const paras = text.replace(/\r/g, '').split(/\n\n+/).map(s => s.trim()).filter(Boolean);
    const para = paras.find(p => !p.startsWith('#')) || paras[0] || '';
    readme_excerpt = para.slice(0, 500);
  }

  const profile = {
    profile_version: PROFILE_VERSION,
    local_path: localPath,
    package_manager: pm,
    languages,
    detected_files: Array.from(detected),
    scripts_detected,
    test_commands: Array.from(new Set(test_commands)).slice(0, 6),
    build_commands: Array.from(new Set(build_commands)).slice(0, 6),
    lint_commands: Array.from(new Set(lint_commands)).slice(0, 6),
    run_commands: Array.from(new Set(run_commands)).slice(0, 6),
    entry_points,
    docs,
    readme_excerpt,
    detected_at: Date.now(),
  };
  return { ok: true, profile };
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

/**
 * Attempt a `git clone` into `targetPath`. Never throws; returns a
 * structured outcome the caller can render.
 *
 * Caller is responsible for choosing safe targetPath. We refuse to
 * clone into an existing non-empty directory.
 */
function cloneRepo(repoUrl, targetPath, opts) {
  const o = opts || {};
  if (!repoUrl || typeof repoUrl !== 'string') return { ok: false, error: 'repo_url_required' };
  if (!targetPath || typeof targetPath !== 'string') return { ok: false, error: 'target_path_required' };
  if (!/^https?:\/\//.test(repoUrl) && !/^git@/.test(repoUrl)) {
    return { ok: false, error: 'unsupported_scheme' };
  }
  // Refuse to clone into existing non-empty dir.
  if (fileExists(targetPath)) {
    let entries = [];
    try { entries = fs.readdirSync(targetPath); } catch (_e) {}
    if (entries.length > 0) return { ok: false, error: 'target_not_empty', target_path: targetPath };
  } else {
    try { fs.mkdirSync(path.dirname(targetPath), { recursive: true }); } catch (_e) {}
  }
  const args = ['clone', '--depth', String(o.depth || 1), repoUrl, targetPath];
  let res;
  try {
    res = spawnSync('git', args, { encoding: 'utf8', timeout: o.timeoutMs || 90000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, error: 'spawn_failed' };
  }
  if (res.status === 0) return { ok: true, target_path: targetPath };
  const stderr = (res.stderr || '').slice(0, 500);
  // Surface stable error code; full stderr is included for the caller
  // but never logged by the smoke (we don't want CI noise leaking
  // private repo URLs).
  let code = 'clone_failed';
  if (/Authentication failed|could not read Username/i.test(stderr)) code = 'auth_failed';
  if (/Repository not found|not found/i.test(stderr))                code = 'not_found';
  if (/Permission denied|access denied/i.test(stderr))               code = 'permission_denied';
  if (res.status === null)                                            code = 'timeout';
  return { ok: false, error: code, stderr };
}

/**
 * Resolve the git root of a path, if any. Cheap — we read .git/HEAD
 * walking up one level since most managed repos are clones at root.
 */
function detectGitRoot(localPath) {
  if (!localPath) return null;
  let cur = localPath;
  for (let i = 0; i < 6; i++) {
    if (fileExists(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function detectDefaultBranch(localPath) {
  // Best-effort: read .git/HEAD or origin/HEAD ref. Avoid spawning
  // unless we have to.
  const headPath = path.join(localPath, '.git', 'HEAD');
  const headTxt = safeReadFile(headPath, 4096);
  if (headTxt) {
    const m = headTxt.match(/ref:\s+refs\/heads\/(\S+)/);
    if (m) return m[1];
  }
  const symref = path.join(localPath, '.git', 'refs', 'remotes', 'origin', 'HEAD');
  const sym = safeReadFile(symref, 4096);
  if (sym) {
    const m = sym.match(/ref:\s+refs\/remotes\/origin\/(\S+)/);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Profile persistence
// ---------------------------------------------------------------------------

/**
 * Build a complete managed-project record: profile data + identity.
 * `project_id` is REQUIRED — the registry already issued one when the
 * user added the project; managed-project shares it so the panel can
 * cross-reference cleanly.
 */
function buildManagedRecord(input) {
  const o = input || {};
  return {
    project_id: o.project_id,
    repo_url: o.repo_url || null,
    local_path: o.local_path,
    git_root: o.git_root || null,
    default_branch: o.default_branch || null,
    profile: o.profile || null,
    generated_at: Date.now(),
    updated_at: Date.now(),
  };
}

function readManagedProject(projectId, home) {
  const file = profilePath(projectId, home);
  const raw = safeReadFile(file, 1024 * 1024);
  return safeJsonParse(raw);
}

function writeManagedProject(record, home) {
  if (!record || !record.project_id) return { ok: false, error: 'project_id_required' };
  ensureManagedDir(home);
  const file = profilePath(record.project_id, home);
  try {
    atomicWriteJson(file, record);
  } catch (_e) {
    return { ok: false, error: 'write_failed' };
  }
  return { ok: true, file };
}

/**
 * High-level: register a managed project. Steps:
 *   1. If `local_path` doesn't exist AND `clone=true` AND `repo_url`
 *      is set, attempt clone.
 *   2. Detect profile (graceful: returns record with profile=null +
 *      error code if local_path can't be read).
 *   3. Persist to ~/.cairn/managed-projects/<projectId>.json.
 *
 * Never throws. The caller can inspect `clone_result` to see what
 * happened with the clone attempt.
 *
 * @param {{ project_id, repo_url?, local_path, clone?:boolean }} input
 * @param {{ home? }} [opts]
 */
function registerManagedProject(input, opts) {
  const o = opts || {};
  if (!input || !input.project_id) return { ok: false, error: 'project_id_required' };
  if (!input.local_path) return { ok: false, error: 'local_path_required' };

  let cloneResult = null;
  if (input.clone && input.repo_url) {
    if (!fileExists(input.local_path)) {
      cloneResult = cloneRepo(input.repo_url, input.local_path, { depth: o.cloneDepth, timeoutMs: o.cloneTimeoutMs });
    } else {
      cloneResult = { ok: true, target_path: input.local_path, skipped: 'already_exists' };
    }
  }

  const detect = detectProjectProfile(input.local_path);
  const profile = detect.ok ? detect.profile : null;
  const profileError = detect.ok ? null : detect.error;
  const gitRoot = detectGitRoot(input.local_path);
  const defaultBranch = gitRoot ? detectDefaultBranch(gitRoot) : null;

  const record = buildManagedRecord({
    project_id: input.project_id,
    repo_url: input.repo_url || null,
    local_path: input.local_path,
    git_root: gitRoot,
    default_branch: defaultBranch,
    profile,
  });
  const persist = writeManagedProject(record, o.home);
  return {
    ok: persist.ok,
    error: persist.ok ? profileError : persist.error,
    profile_error: profileError,
    record,
    clone_result: cloneResult,
  };
}

module.exports = {
  PROFILE_VERSION,
  FILE_PROBES,
  managedDir,
  profilePath,
  detectPackageManager,
  detectLanguages,
  classifyScript,
  detectEntryPoints,
  detectDocs,
  commandWithRunner,
  detectProjectProfile,
  cloneRepo,
  detectGitRoot,
  detectDefaultBranch,
  buildManagedRecord,
  readManagedProject,
  writeManagedProject,
  registerManagedProject,
};
