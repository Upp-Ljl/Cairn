#!/usr/bin/env node
/**
 * Live UI dogfood for Claude-session fold-in (P1-2).
 *
 * Doesn't open Electron windows. Re-imports the same modules main.cjs
 * uses, runs the project-list / project-summary / project-sessions
 * IPC code paths against the LIVE registry + SQLite, and prints what
 * each surface would render — so we can confirm L1 cards + tray
 * tooltip + Sessions tab all see the real Claude sessions on this box.
 *
 * Strict read-only: no DB writes, no registry writes. The script only
 * prints; no assertions, no exit-1.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const adapter        = require(path.join(root, 'agent-adapters', 'claude-code-session-scan.cjs'));
const registry       = require(path.join(root, 'registry.cjs'));
const projectQueries = require(path.join(root, 'project-queries.cjs'));
const queries        = require(path.join(root, 'queries.cjs'));
const Database       = require(path.join(root, '..', 'daemon', 'node_modules', 'better-sqlite3'));

const reg = registry.loadRegistry();
const claudeAll = adapter.scanClaudeSessions();
const projects = reg.projects;

console.log(`==> registry: ${projects.length} project(s)`);
for (const p of projects) {
  console.log(`     - ${p.label} @ ${p.project_root}  hints=${p.agent_id_hints.length}`);
}
console.log(`==> claude scan: ${claudeAll.length} session file(s)`);
for (const r of claudeAll) {
  const cwdShort = r.cwd ? r.cwd.replace(/\\/g, '/').split('/').slice(-2).join('/') : '?';
  console.log(`     - pid=${r.pid} status=${r.status} cwd=…/${cwdShort}`);
}

// ---- L1 project card payload: re-run getProjectsList logic ----
console.log('\n==> L1 project card payload (what panel.js renders):');
let trayMcp = 0, trayClaude = 0;
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

for (const p of projects) {
  const entry = ensureRead(p.db_path);
  if (!entry) { console.log(`  ${p.label}: db unavailable`); continue; }
  const ids = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, p);
  const summary = projectQueries.queryProjectScopedSummary(entry.db, entry.tables, p.db_path, ids);
  const { matched } = adapter.partitionByProject(claudeAll, p);
  const c = adapter.summarizeClaudeRows(matched);
  trayMcp += summary.agents_active;
  trayClaude += c.busy + c.idle;
  const claudeSeg = c.total > 0
    ? ` · Claude ${c.busy + c.idle}${c.dead ? ` (+${c.dead} dead)` : ''}`
    : '';
  console.log(
    `  ${p.label}:  agents MCP ${summary.agents_active}` +
    `${summary.agents_stale ? ` (+${summary.agents_stale} stale)` : ''}` +
    `${claudeSeg}` +
    ` · tasks ${summary.tasks_running}/${summary.tasks_blocked}/${summary.tasks_waiting_review}` +
    ` · health=${summary.health}`,
  );
}

// ---- Unassigned bucket payload ----
const unassignedClaude = adapter.unassignedClaudeSessions(claudeAll, projects);
console.log(`\n==> Unassigned bucket (Claude only):  ${unassignedClaude.length} row(s)`);
for (const r of unassignedClaude) {
  const cwdShort = r.cwd ? r.cwd.replace(/\\/g, '/').split('/').slice(-2).join('/') : '?';
  console.log(`     - pid=${r.pid} status=${r.status} cwd=…/${cwdShort}`);
}

// ---- Tray tooltip simulation ----
const trayTip = `Cairn — ${trayMcp} MCP${trayClaude > 0 ? ` + ${trayClaude} Claude` : ''} · …`;
console.log(`\n==> tray tooltip would render:  ${trayTip}`);

// ---- Sessions tab payload (for the first project, if any) ----
if (projects.length > 0) {
  const p = projects[0];
  const entry = ensureRead(p.db_path);
  if (entry) {
    const ids = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, p);
    const sessPayload = projectQueries.queryProjectScopedSessions(entry.db, entry.tables, ids);
    const { matched: claudeForP } = adapter.partitionByProject(claudeAll, p);
    console.log(`\n==> Sessions tab (project: ${p.label}):`);
    console.log(`     Cairn MCP: ${sessPayload.sessions.length} row(s)`);
    for (const s of sessPayload.sessions) {
      console.log(`        - ${s.agent_id} ${s.computed_state}`);
    }
    console.log(`     Claude:    ${claudeForP.length} row(s)`);
    for (const r of claudeForP) {
      console.log(`        - pid=${r.pid} ${r.status} sid=${(r.session_id || '?').slice(0, 8)}`);
    }
  }
}

for (const e of dbHandles.values()) { try { e.db.close(); } catch {} }
console.log('\nPASS (no assertions; visual dogfood for the IPC payloads)');
