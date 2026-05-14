#!/usr/bin/env node
/**
 * Live integrated dogfood for Goal Mode Lite (Phase 1-4).
 *
 * Exercises the full pipeline against the LIVE registry:
 *
 *   1. Set / refresh a goal on the D:\lll\cairn project (write through
 *      registry.setProjectGoal — the only sanctioned write surface).
 *   2. Add one worker report describing this round's work — mirrors
 *      what a Claude Code session would paste in.
 *   3. Run interpretGoal (uses MiniMax if .cairn-poc3-keys is wired,
 *      else deterministic fallback).
 *   4. Run evaluatePrePrGate (advisory).
 *   5. Print redacted output: provider info, mode, summary, risks,
 *      pre-PR status, checklist length. NEVER prints API key or full
 *      LLM response body.
 *
 * Read-only-ish: writes ~/.cairn/projects.json (goal) and
 * ~/.cairn/project-reports/<id>.jsonl (one report). cairn.db /
 * ~/.claude / ~/.codex untouched. Mtimes asserted at end.
 *
 * Run after Phase 4 lands. Safe to re-run; idempotent on goal (set
 * overwrites; created_at preserved); appends one new report each
 * invocation, so check `wc -l ~/.cairn/project-reports/<id>.jsonl`
 * if you don't want them to pile up.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// SAFETY GATE (2026-05-14 incident): this dogfood writes to the user's
// REAL ~/.cairn/projects.json via registry.setProjectGoal. Accidental
// runs (e.g., from a regression sweep that forgot to filter dogfoods)
// would overwrite the live registry. Require explicit --live flag.
if (!process.argv.includes('--live')) {
  console.error('\n✋ dogfood-goal-mode-lite mutates LIVE ~/.cairn/projects.json.');
  console.error('   Pass --live to confirm:');
  console.error('       node packages/desktop-shell/scripts/dogfood-goal-mode-lite.mjs --live');
  console.error('   Without --live, this script aborts to prevent registry damage.\n');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const registry         = require(path.join(root, 'registry.cjs'));
const projectQueries   = require(path.join(root, 'project-queries.cjs'));
const queries          = require(path.join(root, 'queries.cjs'));
const claudeAdapter    = require(path.join(root, 'agent-adapters', 'claude-code-session-scan.cjs'));
const codexAdapter     = require(path.join(root, 'agent-adapters', 'codex-session-log-scan.cjs'));
const agentActivity    = require(path.join(root, 'agent-activity.cjs'));
const goalSignals      = require(path.join(root, 'goal-signals.cjs'));
const goalInterpretation = require(path.join(root, 'goal-interpretation.cjs'));
const llmClient        = require(path.join(root, 'llm-client.cjs'));
const workerReports    = require(path.join(root, 'worker-reports.cjs'));
const prePrGate        = require(path.join(root, 'pre-pr-gate.cjs'));
const Database = require(path.join(root, '..', 'daemon', 'node_modules', 'better-sqlite3'));

const realCairnDb  = path.join(os.homedir(), '.cairn', 'cairn.db');
const realClaude   = path.join(os.homedir(), '.claude');
const realCodex    = path.join(os.homedir(), '.codex');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn  = safeMtime(realCairnDb);
const beforeClaude = safeMtime(realClaude);
const beforeCodex  = safeMtime(realCodex);

let reg = registry.loadRegistry();
console.log(`==> live registry: ${reg.projects.length} project(s)`);

// Find the D:\lll\cairn project. Match by project_root case-insensitive
// (matches what the panel does).
const cairnProject = reg.projects.find(p =>
  /(^|[\/\\])cairn$/i.test((p.project_root || '').replace(/[\/\\]+$/, '')) ||
  (p.label || '').toLowerCase() === 'cairn'
);
if (!cairnProject) {
  console.error('FAIL: no project found at D:\\lll\\cairn — register one first via the panel');
  process.exit(1);
}
console.log(`     using: ${cairnProject.label} @ ${cairnProject.project_root}`);

// ---- 1. set goal ----
const goalInput = {
  title: 'Make Cairn a local project control surface',
  desired_outcome:
    'Cairn shows real agent activity, goal progress, and advisory governance signals — without becoming an executor.',
  success_criteria: [
    'L1 / L2 / Tray / Sessions / Unassigned all consume one AgentActivity feed',
    'Project Pulse surfaces blockers / failed outcomes / stale activity from real data',
    'Goal Card persists user-authored goals in ~/.cairn/projects.json',
    'LLM Interpretation is advisory only and falls back gracefully when keys absent',
    'Worker Report Protocol stores reports locally; LLM only sees counts',
    'Pre-PR Gate is advisory (status from deterministic rules; LLM only rephrases)',
  ],
  non_goals: [
    'Cairn does not write code or auto-dispatch agents',
    'Cairn does not block git operations or run CI',
    'Cairn does not infer goals from agent transcripts',
  ],
};
const setRes = registry.setProjectGoal(reg, cairnProject.id, goalInput);
if (setRes.error) {
  console.error('FAIL: setProjectGoal:', setRes.error);
  process.exit(1);
}
reg = setRes.reg;
console.log(`==> goal set:  "${setRes.goal.title}"  (id=${setRes.goal.id})`);

// ---- 2. add worker report ----
const reportText = `# Goal Mode Lite landed (Phases 1-4)

source: claude-code
agent: cairn-session-dogfood

## Completed
- Phase 1: registry-only goal storage (active_goal field on project entry)
- Phase 2: advisory LLM interpretation with MiniMax provider; deterministic fallback
- Phase 3: Worker Report protocol — JSONL per project; counts-only flow into LLM
- Phase 4: Pre-PR Gate — deterministic status + optional LLM rewrite
- Smoke: 5 new files + 13 total green

## Remaining
- Wire registry-pulse banner on L1 (cross-project unassigned)
- Live-document the dogfood (this commit)

## Blockers
(none right now)

## Next steps
- Push if user authorizes
- Open follow-up plan for Goal Mode v2 (decisions log? rules registry?)

needs_human: no
`;
// Mirror the main.cjs IPC merge (we're bypassing it here): parse the
// markdown ourselves so the report's title is extracted from the H1.
const parsedReport = workerReports.parseReportText(reportText);
const reportRes = workerReports.addWorkerReport(cairnProject.id, {
  ...parsedReport,
  source_app: parsedReport.source_app || 'claude-code',
});
if (!reportRes.ok) {
  console.error('FAIL: addWorkerReport:', reportRes.error);
  process.exit(1);
}
console.log(`==> worker report added: id=${reportRes.report.id}  title="${reportRes.report.title}"`);

// ---- 3. interpret goal ----
console.log('\n==> goal interpretation:');
const provider = llmClient.loadProvider();
const desc = llmClient.describeProvider(provider);
console.log(`     provider:  ${desc.enabled ? `enabled (${desc.provider}, model=${desc.model}, host=${desc.base_url_host || '?'})` : `disabled (${desc.reason})`}`);

// Build interp input by hand (mirror main.cjs::buildInterpretationInput).
function ensureRead(p) {
  try {
    const db = new Database(p, { readonly: true, fileMustExist: true });
    return { db, tables: queries.getTables(db) };
  } catch { return null; }
}
const entry = ensureRead(cairnProject.db_path);
const interpInput = (() => {
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, cairnProject);
  const summary = projectQueries.queryProjectScopedSummary(entry.db, entry.tables, cairnProject.db_path, agentIds);
  const claudeAll = claudeAdapter.scanClaudeSessions();
  const codexAll  = codexAdapter.scanCodexSessions();
  const sess = projectQueries.queryProjectScopedSessions(entry.db, entry.tables, agentIds);
  for (const r of sess.sessions) {
    r._attribution = agentActivity.decideMcpAttribution(
      r.capabilities, cairnProject.project_root, cairnProject.agent_id_hints || [], r.agent_id,
    );
  }
  const built = agentActivity.buildProjectActivities(
    cairnProject, sess.sessions, claudeAll, codexAll,
    { claude: claudeAdapter, codex: codexAdapter },
  );
  summary.agent_activity = built.summary;
  const pulse = goalSignals.deriveProjectPulse(summary, built.activities, {});
  return {
    goal: registry.getProjectGoal(reg, cairnProject.id),
    pulse,
    activity_summary: built.summary,
    top_activities: built.activities.slice(0, 6),
    tasks_summary: {
      running: summary.tasks_running, blocked: summary.tasks_blocked,
      waiting_review: summary.tasks_waiting_review, failed: summary.tasks_failed, done: 0,
    },
    blockers_summary: { open: summary.blockers_open },
    outcomes_summary: { failed: summary.outcomes_failed, pending: summary.outcomes_pending },
    summary,
    recent_reports: workerReports.listWorkerReports(cairnProject.id, 5),
  };
})();

const interp = await goalInterpretation.interpretGoal(interpInput, {});
console.log(`     mode:      ${interp.mode}${interp.model ? `  (model=${interp.model})` : ''}`);
if (interp.error_code) console.log(`     fallback:  ${interp.error_code}`);
console.log(`     summary:   ${interp.summary}`);
if (interp.risks && interp.risks.length) {
  console.log(`     risks (${interp.risks.length}):`);
  for (const r of interp.risks.slice(0, 5)) {
    console.log(`        [${r.severity}] ${r.title}`);
  }
}
if (interp.next_attention && interp.next_attention.length) {
  console.log(`     next_attention (${interp.next_attention.length}):`);
  for (const s of interp.next_attention.slice(0, 5)) {
    console.log(`        - ${s}`);
  }
}

// ---- 4. pre-pr gate ----
console.log('\n==> pre-PR gate:');
const gateInput = Object.assign({}, interpInput);
const gate = await prePrGate.evaluatePrePrGate(gateInput, {});
console.log(`     status:    ${gate.status}`);
console.log(`     mode:      ${gate.mode}${gate.model ? `  (model=${gate.model})` : ''}`);
if (gate.error_code) console.log(`     fallback:  ${gate.error_code}`);
if (gate.summary) console.log(`     summary:   ${gate.summary}`);
console.log(`     checklist (${(gate.checklist || []).length}):`);
for (const c of (gate.checklist || []).slice(0, 6)) {
  console.log(`        - ${c}`);
}
console.log(`     risks (${(gate.risks || []).length}):`);
for (const r of (gate.risks || []).slice(0, 6)) {
  console.log(`        [${r.severity}] ${r.title}`);
}
console.log(`     evidence (${(gate.evidence || []).length}):`);
for (const e of (gate.evidence || []).slice(0, 6)) {
  console.log(`        + ${e}`);
}

// ---- 5. read-only invariants on cairn.db / ~/.claude / ~/.codex ----
const afterCairn  = safeMtime(realCairnDb);
const afterClaude = safeMtime(realClaude);
const afterCodex  = safeMtime(realCodex);
console.log('\n==> read-only invariants (live):');
function check(label, before, after) {
  const same = before === after;
  console.log(`     ${same ? 'ok' : 'note'}  ${label}: ${same ? 'unchanged' : 'changed (live source — external writer)'}`);
  return same;
}
const cairnSame = check('~/.cairn/cairn.db mtime', beforeCairn, afterCairn);
check('~/.claude mtime', beforeClaude, afterClaude);
check('~/.codex mtime',  beforeCodex,  afterCodex);

// Only cairn.db is the load-bearing assertion (we own it). ~/.claude /
// ~/.codex may shift due to external Claude / Codex Desktop activity.
if (entry) try { entry.db.close(); } catch {}
process.exit(cairnSame ? 0 : 1);
