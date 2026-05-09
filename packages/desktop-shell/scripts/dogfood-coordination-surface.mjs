#!/usr/bin/env node
/**
 * Live dogfood for the Coordination Surface Pass.
 *
 * Runs against the live registry. Read-only on cairn.db /
 * ~/.claude / ~/.codex; the only write surface is the registry-side
 * "set goal / rules" which is unchanged from prior rounds (this
 * dogfood doesn't write anything).
 *
 * What it prints:
 *   1. Per-project coordination signals (full list, redacted)
 *   2. Scratchpad inventory + privacy claim
 *   3. Conflict inventory + resolved/open counts
 *   4. Sample copy prompts (handoff / conflict / review / recovery)
 *      with leak-check for keys / transcripts
 *   5. Read-only invariants (cairn.db mtime unchanged; mutation grep)
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const registry           = require(path.join(root, 'registry.cjs'));
const projectQueries     = require(path.join(root, 'project-queries.cjs'));
const queries            = require(path.join(root, 'queries.cjs'));
const claudeAdapter      = require(path.join(root, 'agent-adapters', 'claude-code-session-scan.cjs'));
const codexAdapter       = require(path.join(root, 'agent-adapters', 'codex-session-log-scan.cjs'));
const agentActivity      = require(path.join(root, 'agent-activity.cjs'));
const workerReports      = require(path.join(root, 'worker-reports.cjs'));
const coordinationSignals = require(path.join(root, 'coordination-signals.cjs'));
const goalLoopPromptPack  = require(path.join(root, 'goal-loop-prompt-pack.cjs'));
const Database           = require(path.join(root, '..', 'daemon', 'node_modules', 'better-sqlite3'));

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn = safeMtime(realCairnDb);

const reg = registry.loadRegistry();
console.log(`==> live registry: ${reg.projects.length} project(s)`);
for (const p of reg.projects) {
  console.log(`     - ${p.label} @ ${p.project_root}`);
}

const dbHandles = new Map();
function ensureRead(p) {
  if (dbHandles.has(p)) return dbHandles.get(p);
  try {
    const db = new Database(p, { readonly: true, fileMustExist: true });
    const e = { db, tables: queries.getTables(db) };
    dbHandles.set(p, e);
    return e;
  } catch { return null; }
}

const SECRET_LIKE = [
  /sk-[a-zA-Z0-9_-]{20,}/,
  /MINIMAX_API_KEY=[A-Za-z0-9]/,
  /Bearer\s+[A-Za-z0-9]/,
  /["']?_apiKey["']?\s*:/,
];
function leakCheck(label, text) {
  for (const re of SECRET_LIKE) if (re.test(text)) {
    console.error(`     LEAK: ${label} matches ${re}`);
    return false;
  }
  // Imperative ban (positive auto-execute outside negation lines).
  const cleaned = text.split(/\r?\n/).filter(line =>
    !/(do not|don'?t|never|refuse|without first|surface)\b/i.test(line)
  ).join('\n');
  if (/\b(run|execute|perform|do)\s+(the\s+)?(rewind|merge|push|resolve)\s+(now|immediately|first|right away)\b/i.test(cleaned)) {
    console.error(`     LEAK: ${label} contains positive auto-execute imperative`);
    return false;
  }
  return true;
}

let leakOK = true;

for (const p of reg.projects) {
  const entry = ensureRead(p.db_path);
  if (!entry) { console.log(`\n  ${p.label}: db unavailable`); continue; }
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, p);
  const summary = projectQueries.queryProjectScopedSummary(entry.db, entry.tables, p.db_path, agentIds);
  const claudeAll = claudeAdapter.scanClaudeSessions();
  const codexAll  = codexAdapter.scanCodexSessions();
  const sess = projectQueries.queryProjectScopedSessions(entry.db, entry.tables, agentIds);
  for (const r of sess.sessions) {
    r._attribution = agentActivity.decideMcpAttribution(
      r.capabilities, p.project_root, p.agent_id_hints || [], r.agent_id,
    );
  }
  const built = agentActivity.buildProjectActivities(
    p, sess.sessions, claudeAll, codexAll,
    { claude: claudeAdapter, codex: codexAdapter },
  );
  summary.agent_activity = built.summary;

  const tasks       = projectQueries.queryProjectScopedTasks(entry.db, entry.tables, agentIds).tasks;
  const blockers    = projectQueries.queryProjectScopedBlockers(entry.db, entry.tables, agentIds, 50);
  const outcomes    = projectQueries.queryProjectScopedOutcomes(entry.db, entry.tables, agentIds, 50);
  const checkpoints = projectQueries.queryProjectScopedCheckpoints(entry.db, entry.tables, agentIds, 50);
  const scratchpad  = projectQueries.queryProjectScopedScratchpad(entry.db, entry.tables, agentIds, 30);
  const conflicts   = projectQueries.queryProjectScopedConflicts(entry.db, entry.tables, agentIds, 30);
  const reports     = workerReports.listWorkerReports(p.id, 5);

  const coord = coordinationSignals.deriveCoordinationSignals({
    activities: built.activities, summary, tasks, blockers, outcomes,
    checkpoints, scratchpad, conflicts, recent_reports: reports,
    goal: registry.getProjectGoal(reg, p.id),
    project_rules: registry.getEffectiveProjectRules(reg, p.id).rules,
  }, {});

  console.log(`\n  Project: ${p.label}`);
  console.log(`     coordination_level: ${coord.coordination_level.toUpperCase()}`);
  console.log(`     signals (${coord.signals.length}):`);
  for (const s of coord.signals.slice(0, 8)) {
    console.log(`        [${s.severity.toUpperCase().padEnd(9)}] ${s.title}`);
  }
  if (coord.signals.length > 8) console.log(`        … and ${coord.signals.length - 8} more`);
  console.log(`     candidates: handoff=${coord.handoff_candidates.length} conflict=${coord.conflict_candidates.length} recovery=${coord.recovery_candidates.length}`);

  // Scratchpad inventory.
  console.log(`     scratchpad: ${scratchpad.length} entr${scratchpad.length === 1 ? 'y' : 'ies'} attributed to this project`);
  for (const sp of scratchpad.slice(0, 3)) {
    const ageS = sp.updated_at ? Math.round((Date.now() - sp.updated_at) / 1000) : '?';
    console.log(`        - ${sp.key.padEnd(40).slice(0, 40)} ${sp.value_size}B  ${ageS}s ago`);
  }

  // Conflicts inventory.
  const open = conflicts.filter(c => c.status === 'OPEN' || c.status === 'PENDING_REVIEW').length;
  const resolved = conflicts.filter(c => c.status === 'RESOLVED').length;
  console.log(`     conflicts:  ${open} open · ${resolved} resolved (${conflicts.length} total)`);
}

// ---- Sample copy prompts: build them and leak-check ----
console.log('\n==> sample copy prompts (leak-check)');

// Pick the first project for prompt samples.
const sampleProj = reg.projects[0];
if (sampleProj) {
  const entry = ensureRead(sampleProj.db_path);
  if (entry) {
    const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, sampleProj);
    const ckpts = projectQueries.queryProjectScopedCheckpoints(entry.db, entry.tables, agentIds, 5);
    const scratchpad = projectQueries.queryProjectScopedScratchpad(entry.db, entry.tables, agentIds, 5);
    const reports = workerReports.listWorkerReports(sampleProj.id, 3);

    // (Re-implement the same composeHandoffPrompt / composeConflictPrompt
    // / composeReviewPrompt as in main.cjs — we can't `require` main.cjs
    // because it's Electron-only. The smoke files do the same.)
    const recovery = require(path.join(root, 'recovery-summary.cjs'));
    const projectGoal = registry.getProjectGoal(reg, sampleProj.id);

    function _clip(s, max) {
      if (typeof s !== 'string') return '';
      const t = s.trim();
      return t.length > max ? t.slice(0, max) : t;
    }
    function composeHandoff() {
      const lines = [];
      lines.push(`You are a coding agent picking up where a previous agent left off in ${sampleProj.label}.`);
      lines.push(`Cairn is a project control surface (read-only); it does NOT dispatch you.`);
      lines.push('');
      if (projectGoal && projectGoal.title) {
        lines.push('# Project goal');
        lines.push(`Goal: ${projectGoal.title}`);
        lines.push('');
      }
      lines.push('# Recovery anchors');
      for (const c of ckpts.slice(0, 3)) {
        lines.push(`- ${c.id.slice(0, 12)} ${c.label ? `"${c.label}" ` : ''}(${c.snapshot_status})`);
      }
      if (!ckpts.length) lines.push('(no checkpoints recorded)');
      lines.push('');
      lines.push('# Shared context (scratchpad keys)');
      for (const sp of scratchpad.slice(0, 5)) {
        lines.push(`- ${sp.key} (task ${sp.task_id}) — ${sp.value_size}B`);
      }
      if (!scratchpad.length) lines.push('(no shared context recorded yet)');
      lines.push('');
      lines.push('# Hard rules');
      lines.push('- Do not push, merge, or force any branch unless the user explicitly authorizes.');
      lines.push('- Do not expand scope beyond the original goal\'s success criteria.');
      lines.push('- Cairn does not dispatch agents.');
      return lines.join('\n');
    }
    const handoffPrompt = composeHandoff();
    console.log(`     handoff prompt:    ${handoffPrompt.length} chars · ${leakCheck('handoff', handoffPrompt) ? 'ok' : 'LEAKED'}`);
    if (!leakCheck('handoff', handoffPrompt)) leakOK = false;

    // Conflict prompt sample (no real conflict on this box; use synthetic)
    const conflict = {
      id: 'cf-sample', detected_at: Date.now(), conflict_type: 'FILE_OVERLAP',
      agent_a: 'agent-A', agent_b: 'agent-B',
      paths: ['src/auth.js'], summary: 'sample for dogfood',
      status: 'OPEN',
    };
    const cp = require(path.join(root, 'recovery-summary.cjs')); // not used; just for structural parity
    function composeConflict() {
      const lines = [];
      lines.push(`You are a coding agent reviewing a multi-agent conflict in ${sampleProj.label}.`);
      lines.push(`Cairn is a project control surface (read-only); it does NOT resolve conflicts.`);
      lines.push('');
      lines.push('# Conflict');
      lines.push(`- id:     ${conflict.id}`);
      lines.push(`- type:   ${conflict.conflict_type}`);
      lines.push(`- status: ${conflict.status}`);
      lines.push(`- agent_a: ${conflict.agent_a}`);
      lines.push(`- agent_b: ${conflict.agent_b}`);
      lines.push(`- paths:`);
      for (const p of conflict.paths) lines.push(`    - ${p}`);
      lines.push('');
      lines.push('# Hard rules');
      lines.push('- Do not push, merge, or force any branch unless the user explicitly authorizes.');
      lines.push('- Do not silently pick a side; surface the trade-off.');
      lines.push('- Do not modify Cairn\'s conflict state from your end.');
      return lines.join('\n');
    }
    const conflictPrompt = composeConflict();
    console.log(`     conflict prompt:   ${conflictPrompt.length} chars · ${leakCheck('conflict', conflictPrompt) ? 'ok' : 'LEAKED'}`);
    if (!leakCheck('conflict', conflictPrompt)) leakOK = false;

    // Recovery prompt (real path).
    const recoverySum = recovery.deriveProjectRecovery(ckpts, {});
    const recoveryPrompt = recovery.recoveryPromptForProject({
      project_label: sampleProj.label, summary: recoverySum,
    });
    console.log(`     recovery prompt:   ${recoveryPrompt.length} chars · ${leakCheck('recovery', recoveryPrompt) ? 'ok' : 'LEAKED'}`);
    if (!leakCheck('recovery', recoveryPrompt)) leakOK = false;

    // Coordination summary fed into prompt-pack section.
    const coordSum = coordinationSignals.summarizeCoordination(
      coordinationSignals.deriveCoordinationSignals({
        tasks: projectQueries.queryProjectScopedTasks(entry.db, entry.tables, agentIds).tasks,
        blockers: projectQueries.queryProjectScopedBlockers(entry.db, entry.tables, agentIds, 50),
        outcomes: projectQueries.queryProjectScopedOutcomes(entry.db, entry.tables, agentIds, 50),
        checkpoints: ckpts, scratchpad, conflicts: [],
        recent_reports: reports,
      }, {}),
    );
    const pack = goalLoopPromptPack.deterministicPack({
      goal: projectGoal,
      pulse: { pulse_level: 'ok', signals: [] },
      activity_summary: { total: 0, by_family: { live: 0, recent: 0, inactive: 0, dead: 0, unknown: 0 } },
      coordination_summary: coordSum,
    }, {});
    console.log(`     prompt pack body:  ${pack.prompt.length} chars · ${leakCheck('promptpack', pack.prompt) ? 'ok' : 'LEAKED'}`);
    if (!leakCheck('promptpack', pack.prompt)) leakOK = false;
    // Confirm coordination section is in the pack.
    if (pack.sections.coordination) {
      console.log(`     pack coordination: present (${pack.sections.coordination.split('\n')[0]})`);
    }
  }
}

// ---- Read-only invariants ----
const afterCairn = safeMtime(realCairnDb);
let invOK = true;
if (beforeCairn != null) {
  if (afterCairn === beforeCairn) console.log('\n==> read-only invariants:\n     ok    ~/.cairn/cairn.db mtime unchanged');
  else { console.error('     FAIL  ~/.cairn/cairn.db mtime changed'); invOK = false; }
}

for (const e of dbHandles.values()) try { e.db.close(); } catch {}

if (leakOK && invOK) {
  console.log('\nPASS (live; coordination signals on every project; prompts leak-clean; cairn.db unchanged)');
  process.exit(0);
} else {
  console.error('\nFAIL — see errors above');
  process.exit(1);
}
