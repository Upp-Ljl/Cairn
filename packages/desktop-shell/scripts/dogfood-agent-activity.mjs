#!/usr/bin/env node
/**
 * Live dry-run dogfood for Agent Activity Layer + Project Pulse.
 *
 * Mirrors what the panel sees on each L1 / L2 poll, but without
 * launching Electron. We call the same modules main.cjs uses against
 * the LIVE registry + LIVE Claude / Codex scans, build the unified
 * activity feed, derive the project pulse, and print:
 *
 *   - L1 project card: agent_activity headline (live · recent · …)
 *   - per-project Pulse: level + top signals
 *   - tray tooltip preview (product-language counts)
 *   - per-project Sessions tab activity row counts (by_app + by_family)
 *
 * Strict read-only — no DB writes, no registry writes, no ~/.claude,
 * no ~/.codex. SQLite/Claude/Codex mtimes are checked at end.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const registry = require(path.join(root, 'registry.cjs'));
const projectQueries = require(path.join(root, 'project-queries.cjs'));
const queries  = require(path.join(root, 'queries.cjs'));
const claudeAdapter = require(path.join(root, 'agent-adapters', 'claude-code-session-scan.cjs'));
const codexAdapter  = require(path.join(root, 'agent-adapters', 'codex-session-log-scan.cjs'));
const agentActivity = require(path.join(root, 'agent-activity.cjs'));
const goalSignals   = require(path.join(root, 'goal-signals.cjs'));
const Database = require(path.join(root, '..', 'daemon', 'node_modules', 'better-sqlite3'));

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
const realClaude  = path.join(os.homedir(), '.claude');
const realCodex   = path.join(os.homedir(), '.codex');
const realRegistry = registry.REGISTRY_PATH;
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn  = safeMtime(realCairnDb);
const beforeClaude = safeMtime(realClaude);
const beforeCodex  = safeMtime(realCodex);
const beforeReg    = safeMtime(realRegistry);

const reg = registry.loadRegistry();
const claudeAll = claudeAdapter.scanClaudeSessions();
const codexAll  = codexAdapter.scanCodexSessions();

console.log(`==> live registry: ${reg.projects.length} project(s)`);
for (const p of reg.projects) {
  console.log(`     - ${p.label} @ ${p.project_root}  hints=${p.agent_id_hints.length}`);
}
console.log(`==> live scans: claude=${claudeAll.length}  codex=${codexAll.length}`);

const dbHandles = new Map();
function ensureRead(p) {
  if (dbHandles.has(p)) return dbHandles.get(p);
  try {
    const db = new Database(p, { readonly: true, fileMustExist: true });
    const tables = queries.getTables(db);
    const e = { db, tables };
    dbHandles.set(p, e);
    return e;
  } catch { return null; }
}

const allActivities = [];

console.log('\n==> per-project activity + pulse:');
for (const p of reg.projects) {
  const entry = ensureRead(p.db_path);
  if (!entry) {
    console.log(`  ${p.label}:  db unavailable`);
    continue;
  }
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, p);
  const summary = projectQueries.queryProjectScopedSummary(entry.db, entry.tables, p.db_path, agentIds);

  const { matched: claudeForP } = claudeAdapter.partitionByProject(claudeAll, p);
  const { matched: codexForP }  = codexAdapter.partitionByProject(codexAll, p);
  // Mirror main.cjs's foldClaude/Codex (private helpers) by hand: just
  // populate the legacy claude_*/codex_* counts so summary is realistic.
  const cl = claudeAdapter.summarizeClaudeRows(claudeForP);
  summary.claude_busy = cl.busy; summary.claude_idle = cl.idle;
  summary.claude_dead = cl.dead; summary.claude_unknown = cl.unknown;
  summary.claude_total = cl.total;
  if (cl.last_activity_at && cl.last_activity_at > (summary.last_activity_at || 0)) {
    summary.last_activity_at = cl.last_activity_at;
  }
  const cx = codexAdapter.summarizeCodexRows(codexForP);
  summary.codex_recent = cx.recent; summary.codex_inactive = cx.inactive;
  summary.codex_unknown = cx.unknown; summary.codex_total = cx.total;
  if (cx.last_activity_at && cx.last_activity_at > (summary.last_activity_at || 0)) {
    summary.last_activity_at = cx.last_activity_at;
  }

  // Build agent activity rows (mirror main.cjs::buildMcpActivityRows).
  const sess = projectQueries.queryProjectScopedSessions(entry.db, entry.tables, agentIds);
  for (const row of sess.sessions) {
    row._attribution = agentActivity.decideMcpAttribution(
      row.capabilities, p.project_root, p.agent_id_hints || [], row.agent_id,
    );
  }
  const built = agentActivity.buildProjectActivities(
    p, sess.sessions, claudeAll, codexAll,
    { claude: claudeAdapter, codex: codexAdapter },
  );
  summary.agent_activity = built.summary;

  for (const a of built.activities) allActivities.push(a);

  const fam = built.summary.by_family;
  const headline =
    `agents ${fam.live} live · ${fam.recent} recent · ${fam.inactive} inactive` +
    (fam.dead ? ` · ${fam.dead} dead` : '') +
    (fam.unknown ? ` · ${fam.unknown} unknown` : '');
  const sourceParts = [`MCP ${built.summary.by_app.mcp}`];
  if (built.summary.by_app['claude-code'] > 0) sourceParts.push(`Claude ${built.summary.by_app['claude-code']}`);
  if (built.summary.by_app.codex > 0) sourceParts.push(`Codex ${built.summary.by_app.codex}`);

  console.log(`  ${p.label}:`);
  console.log(`    L1 headline:    ${headline}`);
  console.log(`    by source:      ${sourceParts.join(' · ')}`);
  console.log(`    summary health: ${summary.health}`);

  const pulse = goalSignals.deriveProjectPulse(summary, built.activities, {});
  console.log(`    pulse:          ${pulse.pulse_level.toUpperCase()}`);
  if (pulse.signals.length) {
    for (const s of pulse.signals) {
      console.log(`        [${s.severity}] ${s.title}`);
    }
  } else {
    console.log(`        (no signals — empty pulse strip)`);
  }
}

// Tray-language tooltip preview.
console.log('\n==> simulated tray tooltip:');
const sumAll = agentActivity.summarizeActivities(allActivities);
const live = sumAll.by_family.live;
const recent = sumAll.by_family.recent;
const parts = [`Cairn — ${live} live agent${live === 1 ? '' : 's'}`];
if (recent > 0) parts.push(`${recent} recent`);
console.log(`     ${parts.join(' · ')} · …`);

// Unassigned bucket: registry-pulse signal preview.
const claudeUnassigned = claudeAdapter.unassignedClaudeSessions(claudeAll, reg.projects);
const codexUnassigned  = codexAdapter.unassignedCodexSessions(codexAll, reg.projects);
const builtU = agentActivity.buildUnassignedActivities([], claudeUnassigned, codexUnassigned);
const regPulse = goalSignals.deriveRegistryPulse(builtU.activities);
console.log(`\n==> registry-wide pulse signals (${regPulse.signals.length}):`);
for (const s of regPulse.signals) {
  console.log(`     [${s.severity}] ${s.title}`);
}

// ---- read-only invariants ----
const afterCairn  = safeMtime(realCairnDb);
const afterClaude = safeMtime(realClaude);
const afterCodex  = safeMtime(realCodex);
const afterReg    = safeMtime(realRegistry);
let invariantOK = true;
function check(label, before, after) {
  const same = before === after;
  console.log(`     ${same ? 'ok' : 'FAIL'}  ${label}: ${before} → ${after}`);
  if (!same) invariantOK = false;
}
console.log('\n==> read-only invariants:');
check('~/.cairn/cairn.db mtime',     beforeCairn,  afterCairn);
check('~/.claude mtime',              beforeClaude, afterClaude);
check('~/.codex mtime',               beforeCodex,  afterCodex);
check('~/.cairn/projects.json mtime', beforeReg,    afterReg);

for (const e of dbHandles.values()) { try { e.db.close(); } catch {} }

console.log(invariantOK
  ? '\nPASS (live dry-run; no on-disk state mutated)'
  : '\nFAIL invariants tripped');
process.exit(invariantOK ? 0 : 1);
