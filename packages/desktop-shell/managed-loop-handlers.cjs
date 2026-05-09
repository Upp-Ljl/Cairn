'use strict';

/**
 * Thin coordinator over the five managed-loop modules. The IPC layer
 * in main.cjs forwards each invoke channel here so the heavy logic
 * sits in plain Node where it can be smoked without spinning up
 * Electron. main.cjs only adds: registry lookup, db handle access
 * (when the panel needs a Pre-PR-Gate result for the prompt pack),
 * and the optional LLM client wiring.
 *
 * Hard product boundary (mirrors the underlying modules):
 *   - never auto-launches a worker
 *   - never pushes / merges / rebases
 *   - never writes cairn.db / ~/.claude / ~/.codex
 *   - profile re-detect is the only repeat write to the
 *     managed-projects JSON; iteration/report writes are append-only
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const mp        = require('./managed-project.cjs');
const iters     = require('./project-iterations.cjs');
const evidenceM = require('./project-evidence.cjs');
const reviewM   = require('./managed-loop-review.cjs');
const adapter   = require('./managed-loop-prompt.cjs');
const wr        = require('./worker-reports.cjs');

// ---------------------------------------------------------------------------
// 1. list — every managed project on disk, joined with the registry
//    label/project_root if available. Caller (panel) usually only
//    needs the records for the *active* project, but a list view is
//    useful for diagnostics.
// ---------------------------------------------------------------------------

function listManagedProjects(reg, opts) {
  const o = opts || {};
  const dir = mp.managedDir(o.home);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_e) { return []; }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const projectId = f.replace(/\.json$/, '');
    const record = mp.readManagedProject(projectId, o.home);
    if (!record) continue;
    const regEntry = (reg && reg.projects)
      ? reg.projects.find(p => p.id === projectId) || null
      : null;
    out.push({
      project_id: projectId,
      label: regEntry ? regEntry.label : null,
      project_root: regEntry ? regEntry.project_root : null,
      record,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. register — make a project Cairn-managed.
//    `local_path` defaults to the registry entry's project_root; the
//    caller can override (e.g. when registering a sibling repo on disk
//    that has a different layout than the project_root).
//    `clone:true` only meaningful when the local_path doesn't exist
//    AND a repo_url is provided. We never auto-clone over an existing
//    directory.
// ---------------------------------------------------------------------------

function registerManagedProject(reg, projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const proj = (reg && reg.projects) ? reg.projects.find(p => p.id === projectId) : null;
  const i = input || {};
  const localPath = i.local_path || (proj && proj.project_root) || null;
  if (!localPath || localPath === '(unknown)') {
    return { ok: false, error: 'local_path_required' };
  }
  return mp.registerManagedProject({
    project_id: projectId,
    repo_url: i.repo_url || null,
    local_path: localPath,
    clone: !!i.clone,
  }, { home: o.home, cloneDepth: i.clone_depth, cloneTimeoutMs: i.clone_timeout_ms });
}

// ---------------------------------------------------------------------------
// 3. profile read — return the persisted record (or null).
// ---------------------------------------------------------------------------

function getManagedProjectProfile(projectId, opts) {
  const o = opts || {};
  if (!projectId) return null;
  return mp.readManagedProject(projectId, o.home);
}

// ---------------------------------------------------------------------------
// 4. start iteration
// ---------------------------------------------------------------------------

function startManagedIteration(projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  return iters.startIteration(projectId, input || {}, { home: o.home });
}

// ---------------------------------------------------------------------------
// 5. generate worker prompt — compose deterministic input and call the
//    adapter. The panel passes optional gate/coord context the main
//    process pre-computed; if omitted we fall back to a minimal input
//    so the prompt is still useful.
// ---------------------------------------------------------------------------

function generateManagedWorkerPrompt(projectId, ctx, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const record = mp.readManagedProject(projectId, o.home);
  if (!record) return { ok: false, error: 'managed_project_not_found' };

  const c = ctx || {};
  // Read latest iteration (if caller didn't supply iteration_id, we
  // bind to the latest open one to keep the round coherent).
  let iterationId = c.iteration_id || null;
  if (!iterationId) {
    const latest = iters.latestIteration(projectId, { home: o.home });
    if (latest && latest.status !== 'reviewed' && latest.status !== 'archived') {
      iterationId = latest.id;
    }
  }

  // Recent reports (top 3) so the prompt's "worker_report_summary"
  // section reflects the latest agent feedback.
  const recent = wr.listWorkerReports(projectId, 3, { home: o.home });

  const input = Object.assign({
    goal: c.goal || null,
    project_rules: c.project_rules || null,
    project_rules_is_default: !!c.project_rules_is_default,
    pulse: c.pulse || { pulse_level: 'ok', signals: [] },
    activity_summary: c.activity_summary || { by_family: { live: 0, recent: 0, inactive: 0 }, total: 0 },
    tasks_summary: c.tasks_summary || { running: 0, blocked: 0, waiting_review: 0, failed: 0 },
    blockers_summary: c.blockers_summary || { open: 0 },
    outcomes_summary: c.outcomes_summary || { failed: 0, pending: 0 },
    recent_reports: recent,
    pre_pr_gate: c.pre_pr_gate || { status: 'unknown', checklist: [], rule_log: [] },
    coordination_summary: c.coordination_summary || null,
  });

  const result = adapter.generateManagedPrompt(input, {
    managed_record: record,
    iteration_id: iterationId,
    forceDeterministic: true,
  });

  if (iterationId) {
    iters.attachWorkerPrompt(projectId, iterationId, {
      id: 'p_' + Date.now().toString(36),
      title: result.title,
    }, { home: o.home });
  }

  return { ok: true, result, iteration_id: iterationId };
}

// ---------------------------------------------------------------------------
// 6. attach worker report — appends to the project-reports JSONL and
//    records the linkage on the latest open iteration. Caller can pass
//    a free-form `text` (parsed via worker-reports.parseReportText) or
//    a pre-built structured input.
// ---------------------------------------------------------------------------

function attachManagedWorkerReport(projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const i = input || {};
  let normalized;
  if (typeof i.text === 'string' && i.text.trim()) {
    const parsed = wr.parseReportText(i.text);
    normalized = wr.normalizeReport(projectId, Object.assign({}, parsed, i));
  } else {
    normalized = wr.normalizeReport(projectId, i);
  }
  const append = wr.addWorkerReport(projectId, normalized, { home: o.home });
  if (!append.ok) return { ok: false, error: append.error };

  // Bind to latest non-reviewed iteration if one exists.
  let iterationId = i.iteration_id || null;
  if (!iterationId) {
    const latest = iters.latestIteration(projectId, { home: o.home });
    if (latest && latest.status !== 'reviewed' && latest.status !== 'archived') {
      iterationId = latest.id;
    }
  }
  if (iterationId) {
    iters.attachWorkerReport(projectId, iterationId, append.report.id, { home: o.home });
  }
  return { ok: true, report: append.report, iteration_id: iterationId };
}

// ---------------------------------------------------------------------------
// 7. collect evidence — read-only git probe, attaches a compact
//    summary to the iteration so the review layer can fold it.
// ---------------------------------------------------------------------------

function collectManagedEvidence(projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const record = mp.readManagedProject(projectId, o.home);
  if (!record) return { ok: false, error: 'managed_project_not_found' };
  const i = input || {};
  const ev = evidenceM.collectGitEvidence(record.local_path, {
    profile: record.profile,
    allow_run_tests: !!i.allow_run_tests,
    run_tests_command: i.run_tests_command,
  });
  const summary = evidenceM.summarizeEvidence(ev);

  let iterationId = i.iteration_id || null;
  if (!iterationId) {
    const latest = iters.latestIteration(projectId, { home: o.home });
    if (latest && latest.status !== 'reviewed' && latest.status !== 'archived') {
      iterationId = latest.id;
    }
  }
  if (iterationId) {
    iters.attachEvidence(projectId, iterationId, summary, { home: o.home });
  }
  return { ok: true, evidence: ev, summary, iteration_id: iterationId };
}

// ---------------------------------------------------------------------------
// 8. review iteration — combine latest report + iteration + evidence
//    summary + (optional gate result + goal + rules) and decide
//    continue/ready_for_review/blocked/needs_evidence/unknown.
// ---------------------------------------------------------------------------

async function reviewManagedIteration(projectId, ctx, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const c = ctx || {};
  let iterationId = c.iteration_id || null;
  if (!iterationId) {
    const latest = iters.latestIteration(projectId, { home: o.home });
    if (!latest) return { ok: false, error: 'no_iteration' };
    iterationId = latest.id;
  }
  const iteration = iters.getIteration(projectId, iterationId, { home: o.home });
  if (!iteration) return { ok: false, error: 'iteration_not_found' };

  // Latest report (foreign): pick the report id off the iteration if
  // one was attached, else fall back to the freshest report on file.
  const reports = wr.listWorkerReports(projectId, 5, { home: o.home });
  let report = null;
  if (iteration.worker_report_id) {
    report = reports.find(r => r.id === iteration.worker_report_id) || null;
  }
  if (!report && reports.length > 0) report = reports[0];

  const verdict = await reviewM.reviewIteration({
    iteration,
    worker_report: report,
    evidence: iteration.evidence_summary || null,
    pre_pr_gate: c.pre_pr_gate || null,
    goal: c.goal || null,
    rules: c.rules || null,
  }, {
    forceDeterministic: !!o.forceDeterministic,
    chatJson: o.chatJson,
    provider: o.provider,
    fetchImpl: o.fetchImpl,
    timeoutMs: o.timeoutMs,
  });

  iters.completeIterationReview(
    projectId, iterationId,
    c.pre_pr_gate ? { status: c.pre_pr_gate.status, rule_log_count: (c.pre_pr_gate.rule_log || []).length } : null,
    verdict.status,
    verdict.summary,
    verdict.next_attention || [],
    { home: o.home },
  );

  return { ok: true, verdict, iteration_id: iterationId };
}

// ---------------------------------------------------------------------------
// 9. list iterations — newest-first; UI uses this to show "round 3 of N".
// ---------------------------------------------------------------------------

function listManagedIterations(projectId, limit, opts) {
  const o = opts || {};
  if (!projectId) return [];
  return iters.listIterations(projectId, limit || 20, { home: o.home });
}

module.exports = {
  listManagedProjects,
  registerManagedProject,
  getManagedProjectProfile,
  startManagedIteration,
  generateManagedWorkerPrompt,
  attachManagedWorkerReport,
  collectManagedEvidence,
  reviewManagedIteration,
  listManagedIterations,
};
