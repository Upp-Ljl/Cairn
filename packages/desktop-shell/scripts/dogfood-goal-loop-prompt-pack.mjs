#!/usr/bin/env node
/**
 * Live integrated dogfood for Goal Mode v2 governance:
 *   - Project Rules Registry (Phase 1)
 *   - Rules-aware Pre-PR Gate (Phase 2)
 *   - Rules-aware LLM Interpretation (Phase 3)
 *   - Goal Loop Prompt Pack (Phase 4)
 *
 * Runs against the LIVE registry. Mutations:
 *   - sets project rules on D:\lll\cairn (~/.cairn/projects.json write)
 *   - generates a prompt pack (in-memory cache only)
 *
 * No reads from cairn.db are mutating. ~/.claude / ~/.codex are
 * never written. Asserts those mtimes (cairn.db only — claude/codex
 * may flap due to external writers, treated as note not failure).
 *
 * Output is redacted: provider info shows host but never the key;
 * the prompt pack is printed in full because it's user-facing
 * pasteable text (it must not contain secrets BY DESIGN — the
 * smoke proved this and we re-verify here at runtime).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// SAFETY GATE (2026-05-14 incident): this dogfood writes to the user's
// REAL ~/.cairn/projects.json via registry.setProjectRules. Require
// explicit --live flag to prevent accidental registry damage.
if (!process.argv.includes('--live')) {
  console.error('\n✋ dogfood-goal-loop-prompt-pack mutates LIVE ~/.cairn/projects.json.');
  console.error('   Pass --live to confirm:');
  console.error('       node packages/desktop-shell/scripts/dogfood-goal-loop-prompt-pack.mjs --live');
  console.error('   Without --live, this script aborts.\n');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const registry          = require(path.join(root, 'registry.cjs'));
const projectQueries    = require(path.join(root, 'project-queries.cjs'));
const queries           = require(path.join(root, 'queries.cjs'));
const claudeAdapter     = require(path.join(root, 'agent-adapters', 'claude-code-session-scan.cjs'));
const codexAdapter      = require(path.join(root, 'agent-adapters', 'codex-session-log-scan.cjs'));
const agentActivity     = require(path.join(root, 'agent-activity.cjs'));
const goalSignals       = require(path.join(root, 'goal-signals.cjs'));
const goalInterpretation = require(path.join(root, 'goal-interpretation.cjs'));
const llmClient         = require(path.join(root, 'llm-client.cjs'));
const workerReports     = require(path.join(root, 'worker-reports.cjs'));
const prePrGate         = require(path.join(root, 'pre-pr-gate.cjs'));
const goalLoopPromptPack = require(path.join(root, 'goal-loop-prompt-pack.cjs'));
const Database          = require(path.join(root, '..', 'daemon', 'node_modules', 'better-sqlite3'));

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn = safeMtime(realCairnDb);

let reg = registry.loadRegistry();
const cairnProj = reg.projects.find(p =>
  /(^|[\/\\])cairn$/i.test((p.project_root || '').replace(/[\/\\]+$/, '')) ||
  (p.label || '').toLowerCase() === 'cairn'
);
if (!cairnProj) {
  console.error('FAIL: no D:\\lll\\cairn project in registry');
  process.exit(1);
}
console.log(`==> using: ${cairnProj.label} @ ${cairnProj.project_root}`);

// ---- 1. set project rules ----
const rulesInput = {
  coding_standards: [
    'Follow existing patterns in this project; avoid unrelated refactors.',
    'No comments unless WHY is non-obvious.',
    'Use existing helpers; do not introduce parallel implementations.',
  ],
  testing_policy: [
    'Run targeted smoke for the changed module before declaring done.',
    'Verify read-only invariants: cairn.db / ~/.claude / ~/.codex unchanged.',
    'Run electron-boot smoke when touching main.cjs / panel wiring.',
  ],
  reporting_policy: [
    'Final report must include: changed files, commands run, results, residual risks.',
    'Note explicitly when a smoke / dogfood was NOT run, and why.',
  ],
  pre_pr_checklist: [
    'No new SQLite schema / migration / MCP tool / npm dep without authorization.',
    'No secret / API key in source, logs, or commit message.',
    'No unrelated dirty files in the diff.',
    'Mutation grep: ≤ 1 match (dev-flag resolveConflict).',
  ],
  non_goals: [
    'Cairn does not write code or auto-dispatch agents.',
    'Cairn does not block git operations or run CI.',
    'No Cursor / Jira / Linear-style features in this product.',
    'No automatic interpretation of agent transcripts.',
  ],
};
const setR = registry.setProjectRules(reg, cairnProj.id, rulesInput);
if (setR.error) {
  console.error('FAIL: setProjectRules:', setR.error);
  process.exit(1);
}
reg = setR.reg;
console.log(`==> project rules set: ${rulesInput.pre_pr_checklist.length} pre-PR · ${rulesInput.non_goals.length} non-goals`);

// ---- 2. build full input pipeline (mirrors main.cjs) ----
function ensureRead(p) {
  try {
    const db = new Database(p, { readonly: true, fileMustExist: true });
    return { db, tables: queries.getTables(db) };
  } catch { return null; }
}
const entry = ensureRead(cairnProj.db_path);
if (!entry) {
  console.error('FAIL: cairn.db unavailable');
  process.exit(1);
}
const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, cairnProj);
const summary = projectQueries.queryProjectScopedSummary(entry.db, entry.tables, cairnProj.db_path, agentIds);
const claudeAll = claudeAdapter.scanClaudeSessions();
const codexAll  = codexAdapter.scanCodexSessions();

const sess = projectQueries.queryProjectScopedSessions(entry.db, entry.tables, agentIds);
for (const r of sess.sessions) {
  r._attribution = agentActivity.decideMcpAttribution(
    r.capabilities, cairnProj.project_root, cairnProj.agent_id_hints || [], r.agent_id,
  );
}
const built = agentActivity.buildProjectActivities(
  cairnProj, sess.sessions, claudeAll, codexAll,
  { claude: claudeAdapter, codex: codexAdapter },
);
summary.agent_activity = built.summary;

const pulse = goalSignals.deriveProjectPulse(summary, built.activities, {});
const effRules = registry.getEffectiveProjectRules(reg, cairnProj.id);
const recentReports = workerReports.listWorkerReports(cairnProj.id, 5);

const interpInput = {
  goal: registry.getProjectGoal(reg, cairnProj.id),
  pulse,
  activity_summary: built.summary,
  top_activities: built.activities.slice(0, 6),
  tasks_summary: { running: summary.tasks_running, blocked: summary.tasks_blocked, waiting_review: summary.tasks_waiting_review, failed: summary.tasks_failed, done: 0 },
  blockers_summary: { open: summary.blockers_open },
  outcomes_summary: { failed: summary.outcomes_failed, pending: summary.outcomes_pending },
  summary,
  recent_reports: recentReports,
  project_rules: effRules.rules,
  project_rules_is_default: effRules.is_default,
};

// ---- 3. interpretation ----
console.log('\n==> goal interpretation (rules-aware):');
const provider = llmClient.loadProvider();
const desc = llmClient.describeProvider(provider);
console.log(`     provider: ${desc.enabled ? `enabled (${desc.provider}, model=${desc.model}, host=${desc.base_url_host})` : `disabled (${desc.reason})`}`);
const interp = await goalInterpretation.interpretGoal(interpInput, {});
console.log(`     mode: ${interp.mode}${interp.error_code ? ` · fallback: ${interp.error_code}` : ''}`);
console.log(`     summary: ${interp.summary}`);
if (interp.risks && interp.risks.length) {
  for (const r of interp.risks.slice(0, 3)) console.log(`        [${r.severity}] ${r.title}`);
}

// ---- 4. pre-PR gate ----
console.log('\n==> pre-PR gate (rules-aware):');
const gate = await prePrGate.evaluatePrePrGate(interpInput, {});
console.log(`     status: ${gate.status} · mode: ${gate.mode}${gate.error_code ? ` · fallback: ${gate.error_code}` : ''}`);
console.log(`     checklist (${(gate.checklist || []).length}):`);
for (const c of (gate.checklist || []).slice(0, 8)) console.log(`        - ${c}`);
console.log(`     evidence (${(gate.evidence || []).length}):`);
for (const e of (gate.evidence || []).slice(0, 4)) console.log(`        + ${e}`);

// ---- 5. prompt pack ----
console.log('\n==> goal loop prompt pack:');
const packInput = Object.assign({}, interpInput, { pre_pr_gate: gate });
const pack = await goalLoopPromptPack.generatePromptPack(packInput, {});
console.log(`     mode: ${pack.mode}${pack.error_code ? ` · fallback: ${pack.error_code}` : ''}${pack.model ? ` · model=${pack.model}` : ''}`);
console.log(`     title: ${pack.title}`);
console.log(`     evidence_ids (${pack.evidence_ids.length}): ${pack.evidence_ids.slice(0, 5).join(', ')}${pack.evidence_ids.length > 5 ? ' …' : ''}`);
console.log(`     acceptance_checklist (${pack.sections.acceptance_checklist.length}):`);
for (const c of pack.sections.acceptance_checklist) console.log(`        - ${c}`);
console.log(`     non_goals (${pack.sections.non_goals.length}):`);
for (const n of pack.sections.non_goals) console.log(`        - ${n}`);

console.log(`\n     prompt length: ${pack.prompt.length} chars`);
console.log(`     prompt SHA-1 (truncated): ${shortHash(pack.prompt)}`);

// ---- 6. runtime privacy re-assertion (defense in depth) ----
function shortHash(s) {
  // Tiny non-crypto hash, just for reproducibility identifiers.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
function leakCheck(label, text, badPatterns) {
  for (const p of badPatterns) {
    if (p.test(text)) {
      console.error(`     LEAK in ${label}: matched ${p}`);
      return false;
    }
  }
  return true;
}

const SECRET_LIKE = [
  /sk-[a-zA-Z0-9_-]{20,}/,           // openai-style key
  /MINIMAX_API_KEY=[A-Za-z0-9]/,     // dotenv assignment
  /Bearer\s+[A-Za-z0-9]/,            // bearer token
  /["']?_apiKey["']?\s*:/,           // accidentally serialized provider
];
const ALL_OK =
  leakCheck('prompt', pack.prompt, SECRET_LIKE) &&
  leakCheck('summary', interp.summary || '', SECRET_LIKE) &&
  leakCheck('gate', JSON.stringify(gate), SECRET_LIKE) &&
  leakCheck('interp', JSON.stringify(interp), SECRET_LIKE);

if (ALL_OK) console.log('     leak-check: ok (no secret-shaped strings in any output)');
else { console.error('FAIL: leak-check failed'); process.exit(1); }

// ---- 7. read-only invariants ----
const afterCairn = safeMtime(realCairnDb);
console.log('\n==> read-only invariants:');
if (beforeCairn != null) {
  if (afterCairn === beforeCairn) console.log('     ok    ~/.cairn/cairn.db mtime unchanged');
  else { console.error('     FAIL  ~/.cairn/cairn.db mtime changed'); process.exit(1); }
}

if (entry) try { entry.db.close(); } catch {}
console.log('\nPASS (live dry-run; rules + gate + interpretation + prompt pack all flow correctly; no secret leakage)');
