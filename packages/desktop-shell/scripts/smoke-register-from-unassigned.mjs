#!/usr/bin/env node
/**
 * Smoke for the "Register project from Unassigned cwd" flow
 * (Real Agent Presence step 4).
 *
 * What this exercises:
 *   1. registry.findProjectByRoot — case-insensitive on Windows,
 *      separator-normalized, trailing-slash tolerant; (unknown) never
 *      matches.
 *   2. registry.pickAvailableLabel — no collision returns the bare base;
 *      a single existing label produces "<base> (2)"; multi-collision
 *      walks 2..N.
 *   3. End-to-end registration shape:
 *      - Build a fixture cwd, plant fake Claude session + Codex rollout
 *        rows whose cwd lives there.
 *      - With an empty registry, both rows are Unassigned (claude
 *        adapter + codex adapter both report no project match).
 *      - Call registry.addProject({ project_root, db_path, hints=[] }).
 *      - Re-run the adapter attribution: both rows now match the new
 *        project entry purely via cwd.
 *   4. Read-only invariants:
 *      - The shimmed ~/.cairn/projects.json IS modified (this is the
 *        sanctioned write surface).
 *      - The real ~/.cairn/cairn.db mtime is unchanged.
 *      - The real ~/.claude / ~/.codex sessions/state files are NOT
 *        touched (we never read past line 1, and we never write).
 *
 * The IPC handler in main.cjs is not directly required (it lives in an
 * Electron-only module); instead this smoke covers the helpers it
 * composes, plus a manual replay of the same flow. Live wiring is
 * covered by dogfood-register-from-unassigned.mjs.
 *
 * No external deps. No commits.
 *
 * Run:
 *   node packages/desktop-shell/scripts/smoke-register-from-unassigned.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let asserts = 0;
let fails = 0;
const failures = [];
function ok(cond, label) {
  asserts++;
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    fails++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ---------------------------------------------------------------------------
// HOME shim
// ---------------------------------------------------------------------------
//
// registry.cjs captures REGISTRY_PATH = ~/.cairn/projects.json at
// module-load time. Shim os.homedir BEFORE requiring it. We also
// remember the *real* ~/.claude and ~/.codex directories so Part C can
// assert they're untouched while the smoke runs.

const realHome = os.homedir();
const realClaude = path.join(realHome, '.claude');
const realCodex  = path.join(realHome, '.codex');
const realCairnDb = path.join(realHome, '.cairn', 'cairn.db');

let realClaudeBefore = null;
try { realClaudeBefore = fs.statSync(realClaude).mtimeMs; } catch (_e) {}
let realCodexBefore = null;
try { realCodexBefore = fs.statSync(realCodex).mtimeMs; } catch (_e) {}
let realCairnDbBefore = null;
try { realCairnDbBefore = fs.statSync(realCairnDb).mtimeMs; } catch (_e) {}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-register-smoke-'));
const fakeHome = tmpDir;
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
os.homedir = () => fakeHome;
fs.mkdirSync(path.join(fakeHome, '.cairn'), { recursive: true });

const registry = require(path.join(__dirname, '..', 'registry.cjs'));
const claude   = require(path.join(__dirname, '..', 'agent-adapters', 'claude-code-session-scan.cjs'));
const codex    = require(path.join(__dirname, '..', 'agent-adapters', 'codex-session-log-scan.cjs'));

// ---------------------------------------------------------------------------
// Part A — registry helpers (pure)
// ---------------------------------------------------------------------------

console.log('==> Part A: registry.findProjectByRoot + pickAvailableLabel');

const isWin = process.platform === 'win32';
const fakeRootA = isWin ? 'C:\\fake\\projects\\alpha' : '/fake/projects/alpha';
const fakeRootB = isWin ? 'C:\\fake\\projects\\beta'  : '/fake/projects/beta';
const fakeRootBUpper = fakeRootB.toUpperCase();
const fakeRootBSlash = fakeRootB + (isWin ? '\\' : '/');

let reg = { version: registry.REGISTRY_VERSION, projects: [] };

// Empty registry: nothing matches.
ok(registry.findProjectByRoot(reg, fakeRootA) === null,
   'empty registry → findProjectByRoot null');

// Add one project.
const addRes1 = registry.addProject(reg, {
  project_root: fakeRootA, db_path: '/tmp/db.sqlite', label: 'alpha',
});
reg = addRes1.reg;

// findProjectByRoot — case-insensitive on Windows, separator-tolerant.
ok(!!registry.findProjectByRoot(reg, fakeRootA),
   'findProjectByRoot: exact match returns the entry');
ok(registry.findProjectByRoot(reg, fakeRootB) === null,
   'findProjectByRoot: different root → null');
if (isWin) {
  ok(!!registry.findProjectByRoot(reg, fakeRootA.toUpperCase()),
     'Windows: uppercase variant of project_root matches existing entry');
  ok(!!registry.findProjectByRoot(reg, fakeRootA.replace(/\\/g, '/')),
     'Windows: forward-slash variant matches existing entry');
}
ok(!!registry.findProjectByRoot(reg, fakeRootA + (isWin ? '\\' : '/')),
   'trailing separator matches existing entry');
ok(registry.findProjectByRoot(reg, '(unknown)') === null,
   '"(unknown)" never matches any registered entry');

// pickAvailableLabel — no collision yet for "beta".
eq(registry.pickAvailableLabel(reg, 'beta'), 'beta',
   'pickAvailableLabel: no collision returns base');

// Add a project with label "beta", then verify "(2)" is picked next.
const addRes2 = registry.addProject(reg, {
  project_root: fakeRootB, db_path: '/tmp/db.sqlite', label: 'beta',
});
reg = addRes2.reg;
eq(registry.pickAvailableLabel(reg, 'beta'), 'beta (2)',
   'pickAvailableLabel: one collision → "(2)"');

// And case-insensitive collision: asking for "BETA" should also yield (2).
eq(registry.pickAvailableLabel(reg, 'BETA'), 'BETA (2)',
   'pickAvailableLabel: case-insensitive collision still suffixes');

// Multi-collision: add "beta (2)", expect "beta (3)" next.
const addRes3 = registry.addProject(reg, {
  project_root: '/fake/projects/beta-mirror', db_path: '/tmp/db.sqlite', label: 'beta (2)',
});
reg = addRes3.reg;
eq(registry.pickAvailableLabel(reg, 'beta'), 'beta (3)',
   'pickAvailableLabel: walks the suffix until unused');

// pickAvailableLabel default for missing/empty input.
eq(registry.pickAvailableLabel(reg, '   '), '(project)',
   'pickAvailableLabel: blank base falls back to "(project)"');

// ---------------------------------------------------------------------------
// Part B — registration end-to-end (fixture Claude + Codex rows)
// ---------------------------------------------------------------------------

console.log('\n==> Part B: register-from-cwd shifts attribution');

// Reset the registry to an empty state for the e2e portion.
reg = { version: registry.REGISTRY_VERSION, projects: [] };
registry.saveRegistry(reg);

const newRoot = path.join(tmpDir, 'myproj');
fs.mkdirSync(newRoot, { recursive: true });
const newRootSubdir = path.join(newRoot, 'packages', 'core');
fs.mkdirSync(newRootSubdir, { recursive: true });

// Plant a fake Claude session whose cwd lives inside `newRoot`.
const claudeSessDir = path.join(fakeHome, '.claude', 'sessions');
fs.mkdirSync(claudeSessDir, { recursive: true });
const NOW = Date.now();
fs.writeFileSync(
  path.join(claudeSessDir, '11111.json'),
  JSON.stringify({
    pid: process.pid,
    sessionId: 'fake-claude-uuid-aaaa',
    cwd: newRoot,
    startedAt: NOW - 60_000,
    version: '2.1.133',
    kind: 'interactive',
    entrypoint: 'cli',
    status: 'busy',
    updatedAt: NOW - 5_000,
  }),
  'utf8',
);

// Plant a fake Codex rollout whose cwd lives in a SUBDIR of newRoot,
// to also exercise the cwd-⊆-project_root path of the adapter.
const codexBase = path.join(fakeHome, '.codex', 'sessions');
const t = new Date(NOW);
const y = String(t.getUTCFullYear());
const m = String(t.getUTCMonth() + 1).padStart(2, '0');
const d = String(t.getUTCDate()).padStart(2, '0');
const codexDir = path.join(codexBase, y, m, d);
fs.mkdirSync(codexDir, { recursive: true });
const codexFile = path.join(codexDir, 'rollout-zzz-uuid-fake.jsonl');
fs.writeFileSync(
  codexFile,
  JSON.stringify({
    timestamp: new Date(NOW - 30_000).toISOString(),
    type: 'session_meta',
    payload: {
      id: 'fake-codex-uuid-zzzz',
      timestamp: new Date(NOW - 30_000).toISOString(),
      cwd: newRootSubdir,
      originator: 'Codex Desktop',
      cli_version: '0.129.0-alpha.15',
      source: 'vscode',
    },
  }) + '\n',
  'utf8',
);
const FRESH_S = (NOW - 5_000) / 1000;
fs.utimesSync(codexFile, FRESH_S, FRESH_S);

const claudeRows = claude.scanClaudeSessions({ sessionsDir: claudeSessDir });
const codexRows  = codex.scanCodexSessions({
  sessionsDir: codexBase,
  now: NOW,
  recentMs: 60_000,
});
eq(claudeRows.length, 1, 'fixture: 1 Claude row scanned');
eq(codexRows.length,  1, 'fixture: 1 Codex row scanned');
eq(claudeRows[0].cwd, newRoot, 'Claude row cwd = newRoot');
eq(codexRows[0].cwd,  newRootSubdir, 'Codex row cwd = newRoot/packages/core');

// With empty registry, both rows are Unassigned.
const claudeUnassigned1 = claude.unassignedClaudeSessions(claudeRows, reg.projects);
const codexUnassigned1  = codex.unassignedCodexSessions(codexRows, reg.projects);
eq(claudeUnassigned1.length, 1, 'before register: Claude row is Unassigned');
eq(codexUnassigned1.length,  1, 'before register: Codex row is Unassigned');

// Mirror the IPC handler's flow: collision check, label, addProject.
const existing = registry.findProjectByRoot(reg, newRoot);
ok(existing === null, 'collision check: no existing project at this root');
const baseLabel = registry.defaultLabelFor(newRoot);
eq(baseLabel, 'myproj', 'defaultLabelFor returns basename');
const label = registry.pickAvailableLabel(reg, baseLabel);
eq(label, 'myproj', 'pickAvailableLabel: empty registry → bare base');

const dbPathForNewProj = registry.DEFAULT_DB_PATH;
const addRes = registry.addProject(reg, {
  project_root: newRoot,
  db_path: dbPathForNewProj,
  label,
  agent_id_hints: [],
});
reg = addRes.reg;

// Newly created entry: hints empty (Real Agent Presence v2 attribution
// is via cwd / capability tags, not legacy deterministic hint).
eq(addRes.entry.agent_id_hints.length, 0,
   'register-from-cwd: hints empty by design (cwd ⊆ project_root attribution)');
eq(addRes.entry.label, 'myproj', 'entry label persisted');
eq(addRes.entry.project_root, newRoot, 'entry project_root persisted');
eq(addRes.entry.db_path, dbPathForNewProj, 'entry db_path persisted');

// After register: both rows attribute to the new project, so they're
// no longer in Unassigned.
const proj = reg.projects[0];
ok(claude.attributeClaudeSessionToProject(claudeRows[0], proj),
   'after register: Claude row matches new project (cwd === project_root)');
ok(codex.attributeCodexSessionToProject(codexRows[0], proj),
   'after register: Codex row matches new project (cwd ⊆ project_root)');

const claudeUnassigned2 = claude.unassignedClaudeSessions(claudeRows, reg.projects);
const codexUnassigned2  = codex.unassignedCodexSessions(codexRows, reg.projects);
eq(claudeUnassigned2.length, 0, 'after register: Claude row left Unassigned');
eq(codexUnassigned2.length,  0, 'after register: Codex row left Unassigned');

// Try to register the same root again → already_registered (we replicate
// the IPC handler's collision branch in-line).
const dup = registry.findProjectByRoot(reg, newRoot);
ok(dup && dup.id === proj.id, 'duplicate register: collision check returns existing entry');

// And: a different cwd that's INSIDE the registered project should also
// resolve to the existing project — we don't want the user to register
// a sub-tree as a separate project. canonicalizeToGitToplevel handles
// this in the real IPC path (if the subdir is in the same git repo as
// the registered root, both produce the same canonical). The smoke
// can't run git, so we assert the helpers' behavior on the canonical
// path that canonicalize would produce.
const canonicalSubdir = newRoot; // Pretend canonicalize produced newRoot.
const dup2 = registry.findProjectByRoot(reg, canonicalSubdir);
ok(dup2 && dup2.id === proj.id,
   'collision check: canonical subdir resolves to existing project');

// ---------------------------------------------------------------------------
// Part C — read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part C: read-only invariants');

// Real ~/.cairn/cairn.db mtime unchanged.
if (realCairnDbBefore != null) {
  let after = null;
  try { after = fs.statSync(realCairnDb).mtimeMs; } catch (_e) {}
  eq(after, realCairnDbBefore, 'real ~/.cairn/cairn.db mtime unchanged');
} else {
  console.log('  (real cairn.db not present — skipping mtime check)');
}

// Real ~/.claude / ~/.codex directories unchanged.
if (realClaudeBefore != null) {
  let after = null;
  try { after = fs.statSync(realClaude).mtimeMs; } catch (_e) {}
  eq(after, realClaudeBefore, 'real ~/.claude mtime unchanged');
}
if (realCodexBefore != null) {
  let after = null;
  try { after = fs.statSync(realCodex).mtimeMs; } catch (_e) {}
  eq(after, realCodexBefore, 'real ~/.codex mtime unchanged');
}

// The shimmed registry SHOULD have been written.
const regOnDisk = JSON.parse(
  fs.readFileSync(path.join(fakeHome, '.cairn', 'projects.json'), 'utf8'),
);
ok(Array.isArray(regOnDisk.projects) && regOnDisk.projects.length === 1,
   'shimmed registry was written (1 entry)');
eq(regOnDisk.projects[0].project_root, newRoot,
   'shimmed registry entry project_root matches');
eq(regOnDisk.projects[0].agent_id_hints.length, 0,
   'shimmed registry entry has no hints');

// Adapter source-level invariants: the new helpers in registry.cjs
// must NOT reach for the DB or shell out. Their only writes are via
// the existing atomicWriteJson path.
const registrySrc = fs.readFileSync(path.join(__dirname, '..', 'registry.cjs'), 'utf8');
ok(!/\.run\s*\(/.test(registrySrc),     'registry.cjs has no .run(');
ok(!/\.exec\s*\(/.test(registrySrc),    'registry.cjs has no .exec(');
ok(!/\.prepare\s*\(/.test(registrySrc), 'registry.cjs has no .prepare(');
// `child_process` would mean we shelled out somewhere — we shouldn't.
ok(!/require\(['"]child_process['"]\)/.test(registrySrc),
   'registry.cjs does not require child_process');

// main.cjs IPC handler grep: the new register-project-from-cwd channel
// should not perform any SQLite writes, only registry.addProject + DB
// read-handle open. Grep for the obvious mutation footprints near it.
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
const handlerStart = mainSrc.indexOf("ipcMain.handle('register-project-from-cwd'");
ok(handlerStart >= 0, 'register-project-from-cwd handler is registered');
// The handler body ends at the next closing `});` followed by another
// ipcMain.handle / blank line. Grab a generous slice and scan it.
const handlerSlice = mainSrc.slice(handlerStart, handlerStart + 2000);
ok(!/openWriteDb\b/.test(handlerSlice),
   'handler does not open a write DB handle');
ok(!/wdb\.prepare|writeFileSync\b/.test(handlerSlice),
   'handler does not write to disk except via registry.addProject');

// Cleanup the temp tree.
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}
os.homedir = () => realHome;

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
