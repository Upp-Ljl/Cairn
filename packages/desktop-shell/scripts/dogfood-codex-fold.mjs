#!/usr/bin/env node
/**
 * Live UI dogfood for Codex session-log fold-in (Real Agent Presence step 3).
 *
 * Doesn't open Electron windows. Re-imports the same modules main.cjs
 * uses, runs the project-list / project-summary / project-sessions
 * IPC code paths against the LIVE registry + SQLite, and prints what
 * each surface would render — so we can confirm L1 cards + tray
 * tooltip + Sessions tab + Unassigned bucket all see Codex sessions on
 * this box.
 *
 * Strict read-only: no DB writes, no registry writes, no ~/.codex
 * writes. The script only prints; no assertions, no exit-1.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const codex          = require(path.join(root, 'agent-adapters', 'codex-session-log-scan.cjs'));
const claude         = require(path.join(root, 'agent-adapters', 'claude-code-session-scan.cjs'));
const registry       = require(path.join(root, 'registry.cjs'));
const projectQueries = require(path.join(root, 'project-queries.cjs'));
const queries        = require(path.join(root, 'queries.cjs'));
const Database       = require(path.join(root, '..', 'daemon', 'node_modules', 'better-sqlite3'));

const reg = registry.loadRegistry();
const codexAll  = codex.scanCodexSessions();
const claudeAll = claude.scanClaudeSessions();
const projects = reg.projects;

console.log(`==> registry: ${projects.length} project(s)`);
for (const p of projects) {
  console.log(`     - ${p.label} @ ${p.project_root}  hints=${p.agent_id_hints.length}`);
}
console.log(`==> codex scan: ${codexAll.length} rollout file(s) in last ${codex.DEFAULT_DAYS_BACK} day(s)`);
const codexBucketCount = codex.summarizeCodexRows(codexAll);
console.log(`     summary: recent=${codexBucketCount.recent} inactive=${codexBucketCount.inactive} unknown=${codexBucketCount.unknown}`);
const codexSample = codexAll.slice(0, 3);
for (const r of codexSample) {
  const cwdShort = r.cwd ? r.cwd.replace(/\\/g, '/').split('/').slice(-2).join('/') : '?';
  const sid = r.session_id ? r.session_id.slice(0, 8) + '…' : '(none)';
  console.log(`     - ${String(r.status).padEnd(8)} sid=${sid} orig=${(r.originator || '?').padEnd(14)} cwd=…/${cwdShort}`);
}

// ---- L1 project card payload ----
console.log('\n==> L1 project card payload (what panel.js renders):');
let trayMcp = 0, trayClaude = 0, trayCodex = 0;
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
  const { matched: claudeMatched } = claude.partitionByProject(claudeAll, p);
  const cl = claude.summarizeClaudeRows(claudeMatched);
  const { matched: codexMatched } = codex.partitionByProject(codexAll, p);
  const cx = codex.summarizeCodexRows(codexMatched);
  trayMcp    += summary.agents_active;
  trayClaude += cl.busy + cl.idle;
  trayCodex  += cx.recent;

  const claudeSeg = cl.total > 0
    ? ` · Claude ${cl.busy + cl.idle}${cl.dead ? ` (+${cl.dead} dead)` : ''}`
    : '';
  const codexSeg = cx.total > 0
    ? ` · Codex ${cx.recent}${cx.inactive ? ` (+${cx.inactive} inactive)` : ''}`
    : '';
  console.log(
    `  ${p.label}:  agents MCP ${summary.agents_active}` +
    `${summary.agents_stale ? ` (+${summary.agents_stale} stale)` : ''}` +
    `${claudeSeg}` +
    `${codexSeg}` +
    ` · tasks ${summary.tasks_running}/${summary.tasks_blocked}/${summary.tasks_waiting_review}` +
    ` · health=${summary.health}`,
  );
}

// ---- Unassigned bucket payload ----
const codexUnassigned  = codex.unassignedCodexSessions(codexAll, projects);
const claudeUnassigned = claude.unassignedClaudeSessions(claudeAll, projects);
console.log(`\n==> Unassigned bucket: claude=${claudeUnassigned.length}  codex=${codexUnassigned.length}`);
for (const r of codexUnassigned.slice(0, 5)) {
  const cwdShort = r.cwd ? r.cwd.replace(/\\/g, '/').split('/').slice(-2).join('/') : '?';
  console.log(`     codex: ${String(r.status).padEnd(8)} cwd=…/${cwdShort} orig=${r.originator || '?'}`);
}

// ---- Tray tooltip simulation ----
const claudePart = trayClaude > 0 ? ` + ${trayClaude} Claude` : '';
const codexPart  = trayCodex  > 0 ? ` + ${trayCodex} Codex`  : '';
const trayTip = `Cairn — ${trayMcp} MCP${claudePart}${codexPart} · …`;
console.log(`\n==> tray tooltip would render:  ${trayTip}`);

// ---- Sessions tab payload (for the first project, if any) ----
if (projects.length > 0) {
  // Pick the first project that actually matches at least one Codex
  // session, falling back to projects[0]. Makes the dogfood meaningful
  // on any registry: if there's a project covering live Codex cwds
  // we'll show it, otherwise we still demonstrate the empty-Codex path.
  const preferred = projects.find(p =>
    codex.partitionByProject(codexAll, p).matched.length > 0
  ) || projects[0];
  const entry = ensureRead(preferred.db_path);
  if (entry) {
    const ids = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, preferred);
    const sessPayload = projectQueries.queryProjectScopedSessions(entry.db, entry.tables, ids);
    const { matched: codexForP } = codex.partitionByProject(codexAll, preferred);
    const { matched: claudeForP } = claude.partitionByProject(claudeAll, preferred);
    console.log(`\n==> Sessions tab (project: ${preferred.label}):`);
    console.log(`     Cairn MCP: ${sessPayload.sessions.length} row(s)`);
    for (const s of sessPayload.sessions.slice(0, 5)) {
      console.log(`        - ${s.agent_id} ${s.computed_state}`);
    }
    console.log(`     Claude:    ${claudeForP.length} row(s)`);
    for (const r of claudeForP.slice(0, 5)) {
      console.log(`        - pid=${r.pid} ${r.status} sid=${(r.session_id || '?').slice(0, 8)}`);
    }
    console.log(`     Codex:     ${codexForP.length} row(s)`);
    for (const r of codexForP.slice(0, 5)) {
      console.log(`        - ${String(r.status).padEnd(8)} sid=${(r.session_id || '?').slice(0, 8)} orig=${r.originator || '?'}`);
    }
  }
}

for (const e of dbHandles.values()) { try { e.db.close(); } catch {} }
console.log('\nPASS (no assertions; visual dogfood for the IPC payloads)');
