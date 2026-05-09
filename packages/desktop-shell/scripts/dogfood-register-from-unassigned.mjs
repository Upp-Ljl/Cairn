#!/usr/bin/env node
/**
 * Live dry-run dogfood for "Register project from Unassigned cwd".
 *
 * Strict read-only against on-disk state:
 *   - Reads the LIVE ~/.cairn/projects.json registry to know what's
 *     currently registered.
 *   - Reads the LIVE ~/.claude/sessions and ~/.codex/sessions data so
 *     we exercise the same adapters / paths the panel hits at runtime.
 *   - SIMULATES the register-from-cwd IPC handler entirely in memory:
 *     `registry.findProjectByRoot` for collision detection, manual
 *     in-memory append for "what would addProject persist?", and
 *     re-runs the scan-attribution to show the row moving from
 *     Unassigned into the new project bucket.
 *   - Never writes to ~/.cairn/projects.json. Never writes to
 *     ~/.claude or ~/.codex. Never touches Cairn SQLite.
 *
 * The point: prove with real session data that registering an
 * Unassigned cwd causes the row to attribute correctly, without
 * polluting the user's live registry. The Electron panel will perform
 * the actual write through the IPC handler when the user clicks the
 * link — that flow is covered by smoke-register-from-unassigned.mjs.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const registry = require(path.join(root, 'registry.cjs'));
const claude   = require(path.join(root, 'agent-adapters', 'claude-code-session-scan.cjs'));
const codex    = require(path.join(root, 'agent-adapters', 'codex-session-log-scan.cjs'));

// ---- read live state (read-only) ----
const liveReg = registry.loadRegistry();
const claudeRows = claude.scanClaudeSessions();
const codexRows  = codex.scanCodexSessions();

// Snapshot file mtimes so we can verify the dry-run touched nothing.
const projectsJsonPath = registry.REGISTRY_PATH;
const claudeDir = claude.defaultSessionsDir();
const codexDir  = codex.defaultSessionsDir();
const beforeRegMtime    = safeMtime(projectsJsonPath);
const beforeClaudeMtime = safeMtime(claudeDir);
const beforeCodexMtime  = safeMtime(codexDir);
function safeMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; }
}

console.log('==> live registry:');
for (const p of liveReg.projects) {
  console.log(`     - ${p.label} @ ${p.project_root}  hints=${p.agent_id_hints.length}`);
}
console.log(`==> live claude scan: ${claudeRows.length} session file(s)`);
console.log(`==> live codex scan:  ${codexRows.length} rollout file(s) in last ${codex.DEFAULT_DAYS_BACK} day(s)`);

// ---- pick a candidate cwd from Unassigned ----
const claudeUn = claude.unassignedClaudeSessions(claudeRows, liveReg.projects);
const codexUn  = codex.unassignedCodexSessions(codexRows,  liveReg.projects);
console.log(`\n==> Unassigned counts: claude=${claudeUn.length}  codex=${codexUn.length}`);

// Prefer Codex (we have multiple on this box); fall back to Claude;
// fall back to "no candidate, exit gracefully".
let candidate = null;
if (codexUn.length > 0) {
  // Prefer a row with a real cwd (drop unknowns whose cwd is null).
  candidate = codexUn.find(r => r.cwd) || null;
  if (candidate) {
    console.log(`==> candidate (codex):  cwd=${candidate.cwd}  status=${candidate.status}`);
  }
} else if (claudeUn.length > 0) {
  candidate = claudeUn.find(r => r.cwd) || null;
  if (candidate) {
    console.log(`==> candidate (claude): cwd=${candidate.cwd}  status=${candidate.status}`);
  }
}

if (!candidate) {
  console.log(
    '\n(no Unassigned Claude/Codex row with cwd on this box right now.\n' +
    ' That means everything attributes already; nothing to dogfood.)\n' +
    'PASS (read-only; no register simulation needed)'
  );
  process.exit(0);
}

// ---- simulate the IPC handler: canonicalize + collision + label ----
function canonicalizeToGitToplevel(dir) {
  if (!dir || typeof dir !== 'string') return dir;
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir, timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true, encoding: 'utf8',
    });
    const top = (out || '').trim();
    if (top) return path.normalize(top);
  } catch (_e) { /* not a git repo / git missing / timeout */ }
  return dir;
}

const canonical = canonicalizeToGitToplevel(candidate.cwd);
console.log(`\n==> canonicalize:`);
console.log(`     input:     ${candidate.cwd}`);
console.log(`     canonical: ${canonical}`);

const existing = registry.findProjectByRoot(liveReg, canonical);
if (existing) {
  console.log(`     collision: already registered as "${existing.label}"`);
  console.log(`     (handler would return { ok:false, error:"already_registered" })`);
  console.log('PASS (collision branch verified against live registry)');
  process.exit(0);
}

const baseLabel = registry.defaultLabelFor(canonical);
const label = registry.pickAvailableLabel(liveReg, baseLabel);
console.log(`     label:     ${label} (base="${baseLabel}")`);

// ---- in-memory simulation: what would addProject produce? ----
const simulated = {
  version: liveReg.version,
  projects: [
    ...liveReg.projects,
    {
      id: 'p_DRYRUN_SIMULATED',
      label,
      project_root: canonical,
      db_path: registry.DEFAULT_DB_PATH,
      agent_id_hints: [],
      added_at: Date.now(),
      last_opened_at: Date.now(),
    },
  ],
};
const simulatedNewEntry = simulated.projects[simulated.projects.length - 1];

// ---- re-run attribution against the simulated registry ----
const claudeUn2 = claude.unassignedClaudeSessions(claudeRows, simulated.projects);
const codexUn2  = codex.unassignedCodexSessions(codexRows,  simulated.projects);
console.log(`\n==> after simulated register: claude unassigned=${claudeUn2.length}  codex unassigned=${codexUn2.length}`);
const claudeMoved = claudeUn.length - claudeUn2.length;
const codexMoved  = codexUn.length  - codexUn2.length;
console.log(`     rows moved out of Unassigned: claude=${claudeMoved}  codex=${codexMoved}`);

// L1 card preview for the simulated new entry.
const { matched: claudeForNew } = claude.partitionByProject(claudeRows, simulatedNewEntry);
const { matched: codexForNew  } = codex.partitionByProject(codexRows,  simulatedNewEntry);
const cl = claude.summarizeClaudeRows(claudeForNew);
const cx = codex.summarizeCodexRows(codexForNew);
console.log(`\n==> simulated L1 card "${label}":`);
const claudeSeg = cl.total > 0
  ? ` · Claude ${cl.busy + cl.idle}${cl.dead ? ` (+${cl.dead} dead)` : ''}` : '';
const codexSeg = cx.total > 0
  ? ` · Codex ${cx.recent}${cx.inactive ? ` (+${cx.inactive} inactive)` : ''}` : '';
console.log(`     agents MCP 0${claudeSeg}${codexSeg}`);

// Sessions tab preview.
console.log(`\n==> simulated Sessions tab (${label}):`);
console.log(`     Claude: ${claudeForNew.length} row(s)`);
for (const r of claudeForNew.slice(0, 3)) {
  console.log(`        - ${r.status} sid=${(r.session_id || '?').slice(0, 8)}`);
}
console.log(`     Codex:  ${codexForNew.length} row(s)`);
for (const r of codexForNew.slice(0, 3)) {
  console.log(`        - ${r.status} sid=${(r.session_id || '?').slice(0, 8)} orig=${r.originator || '?'}`);
}

// Tray tooltip preview (Codex tray uses recent only; Claude uses busy+idle).
const trayMcp = 0;
const trayClaude = cl.busy + cl.idle;
const trayCodex  = cx.recent;
const cPart = trayClaude > 0 ? ` + ${trayClaude} Claude` : '';
const cxPart = trayCodex > 0 ? ` + ${trayCodex} Codex`  : '';
console.log(`\n==> simulated tray tooltip:  Cairn — ${trayMcp} MCP${cPart}${cxPart} · …`);

// ---- read-only invariants ----
const afterRegMtime    = safeMtime(projectsJsonPath);
const afterClaudeMtime = safeMtime(claudeDir);
const afterCodexMtime  = safeMtime(codexDir);
let invariantOK = true;
function check(label, before, after) {
  const same = before === after;
  console.log(`     ${same ? 'ok' : 'FAIL'}  ${label}: ${before} → ${after}`);
  if (!same) invariantOK = false;
}
console.log('\n==> read-only invariants:');
check('~/.cairn/projects.json mtime', beforeRegMtime,    afterRegMtime);
check('~/.claude mtime',              beforeClaudeMtime, afterClaudeMtime);
check('~/.codex mtime',               beforeCodexMtime,  afterCodexMtime);

console.log(invariantOK
  ? '\nPASS (dry-run; live registry unchanged; live ~/.claude / ~/.codex unchanged)'
  : '\nFAIL invariants tripped — STOP, do not commit until investigated');
process.exit(invariantOK ? 0 : 1);
