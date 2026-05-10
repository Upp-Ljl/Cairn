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
const launcher  = require('./worker-launcher.cjs');
const candidates = require('./project-candidates.cjs');
const workerPrompt = require('./worker-prompt.cjs');

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

// ---------------------------------------------------------------------------
// Worker Launch (user-authorized, single-shot)
// ---------------------------------------------------------------------------
//
// `detectWorkerProviders` is a pure detection probe — no I/O outside
// PATH stat. `launchManagedWorker` is the only handler that spawns a
// child process; it binds the new run to the latest open iteration
// so the panel can fold runs into the iteration timeline.
//
// `extractManagedWorkerReport` parses the run's tail.log
// deterministically (no LLM) for a `## Worker Report` block. If
// missing, the panel still shows the manual paste-report path —
// extraction is a convenience, not a requirement.

function detectWorkerProviders() {
  return launcher.detectWorkerProviders();
}

/**
 * If a run has reached a terminal status (exited/failed/stopped/unknown)
 * but its bound iteration row still says running/queued, patch the
 * iteration to match. Idempotent — safe to call from any read path.
 *
 * Called from: getWorkerRun, extractManagedWorkerReport,
 * continueManagedIterationReview. The launcher's `child.on('exit')`
 * updates run.json but cannot reach the iteration JSONL (different
 * module, no upward dep), so we converge state at the next handler-
 * level read instead. Polling UIs (panel) hit getWorkerRun every
 * second while a run is alive, so the worst-case staleness is one
 * poll tick after exit.
 */
function syncIterationFromRun(runMeta, opts) {
  if (!runMeta || !runMeta.iteration_id || !runMeta.project_id) return false;
  const terminal = (runMeta.status === 'exited' || runMeta.status === 'failed'
                 || runMeta.status === 'stopped' || runMeta.status === 'unknown');
  if (!terminal) return false;
  const o = opts || {};
  const iter = iters.getIteration(runMeta.project_id, runMeta.iteration_id, { home: o.home });
  if (!iter) return false;
  // Only patch when the iteration disagrees — keeps the JSONL from
  // growing on every poll once a run has terminated.
  if (iter.worker_status === runMeta.status && iter.worker_ended_at === runMeta.ended_at) return false;
  iters.markWorkerRunStatus(runMeta.project_id, runMeta.iteration_id, runMeta.status, {
    home: o.home,
    ended_at: runMeta.ended_at || Date.now(),
  });
  return true;
}

function launchManagedWorker(projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const i = input || {};
  if (!i.provider) return { ok: false, error: 'provider_required' };

  const record = mp.readManagedProject(projectId, o.home);
  if (!record) return { ok: false, error: 'managed_project_not_found' };
  if (!record.local_path) return { ok: false, error: 'local_path_missing' };

  // Bind to latest open iteration — caller can override.
  let iterationId = i.iteration_id || null;
  if (!iterationId) {
    const open = iters.getLatestOpenIteration(projectId, { home: o.home });
    if (open) iterationId = open.id;
  }
  if (!iterationId) return { ok: false, error: 'no_open_iteration' };

  // Prompt: caller MUST supply the prompt text (we don't auto-generate
  // here — keeping prompt composition + worker launch as two distinct
  // user clicks per PRODUCT.md §1.3).
  if (typeof i.prompt !== 'string' || !i.prompt.trim()) {
    return { ok: false, error: 'prompt_required' };
  }

  const launchRes = launcher.launchWorker({
    provider: i.provider,
    cwd: record.local_path,
    prompt: i.prompt,
    iteration_id: iterationId,
    project_id: projectId,
  }, { home: o.home });
  if (!launchRes.ok) return launchRes;

  // Stamp the iteration with the run binding.
  iters.attachWorkerRunToIteration(projectId, iterationId, {
    run_id: launchRes.run.run_id,
    provider: launchRes.run.provider,
    status: launchRes.run.status,
    started_at: launchRes.run.started_at,
    run_dir: launcher.runDir(launchRes.run.run_id, o.home),
  }, { home: o.home });

  return { ok: true, run_id: launchRes.run_id, run: launchRes.run, iteration_id: iterationId };
}

function getWorkerRun(runId, opts) {
  const o = opts || {};
  const meta = launcher.getWorkerRun(runId, { home: o.home });
  if (meta) syncIterationFromRun(meta, { home: o.home });
  return meta;
}

function listWorkerRuns(projectId, opts) {
  const o = opts || {};
  return launcher.listWorkerRuns(projectId, { home: o.home });
}

function stopWorkerRun(runId, opts) {
  const o = opts || {};
  const stopRes = launcher.stopWorkerRun(runId, { home: o.home });
  // If stop succeeded, mark iteration too — but we don't have
  // project_id/iteration_id here without re-reading the run.json.
  // The panel polls getWorkerRun anyway; iteration status updates on
  // the next review tick. Keep this handler narrow.
  return stopRes;
}

function tailWorkerRun(runId, limit, opts) {
  const o = opts || {};
  return {
    ok: true,
    text: launcher.tailRunLog(runId, limit || 16 * 1024, o.home),
  };
}

/**
 * Extract Scout candidates from a finished Scout run's tail.log and
 * persist each candidate to the project-candidates registry as
 * PROPOSED. Source-of-truth check: the run.json's project_id MUST
 * equal the projectId argument, otherwise we refuse — without this,
 * a caller could accidentally bind candidates to the wrong project.
 *
 * Returns { ok, candidate_ids, candidates } on success;
 *         { ok:false, error } on the standard error codes.
 */
/**
 * Pick a PROPOSED candidate and launch a Worker round on it.
 *
 * State-machine contract (steps run IN ORDER; each step either
 * succeeds or short-circuits with a stable error code):
 *
 *   i.    candidate_not_found       — no row with that id
 *   ii.   project_id_mismatch       — candidate belongs to another project
 *   iii.  candidate_not_proposed    — candidate is past PROPOSED
 *                                     (current_status returned in detail)
 *   iv.   managed_project_not_found — no managed-project record on disk
 *   v.    PROPOSED → PICKED         — user intent persisted before launch
 *   vi.   prompt synthesised        — caller's prompt OR generateWorkerPrompt
 *   vii.  startManagedIteration     — worker gets its OWN iteration row
 *                                     (NOT the scout's iteration)
 *   viii. launchManagedWorker
 *   ix.   if launch failed:
 *           candidate STAYS at PICKED (by design — no auto-rollback,
 *           no auto-REJECT). Day 1 forbids reverse transitions and
 *           the user is the one who decides whether to retry, abandon,
 *           or escalate. The handler returns
 *           { ok:false, error:'launch_failed', launch_error, candidate_status:'PICKED' }
 *   x.    if launch succeeded:
 *           bindWorkerIteration: PICKED → WORKING + worker_iteration_id
 *           in a single append.
 *
 * The user-decides-after-failure rule is explicitly *not* "graceful
 * recovery" — it is the intended boundary. PRODUCT.md §1.3 #4 forbids
 * Cairn from advancing the loop on its own; failed launches are a
 * loop-advancement decision.
 */
function pickCandidateAndLaunchWorker(projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const i = input || {};
  if (!i.candidate_id) return { ok: false, error: 'candidate_id_required' };
  if (!i.provider) return { ok: false, error: 'provider_required' };

  // i. + ii. + iii. — candidate sanity
  const cand = candidates.getCandidate(projectId, i.candidate_id, { home: o.home });
  if (!cand) return { ok: false, error: 'candidate_not_found' };
  if (cand.project_id && cand.project_id !== projectId) {
    return { ok: false, error: 'project_id_mismatch' };
  }
  if (cand.status !== 'PROPOSED') {
    return { ok: false, error: 'candidate_not_proposed', current_status: cand.status, candidate_id: cand.id };
  }

  // iv. — managed project record
  const record = mp.readManagedProject(projectId, o.home);
  if (!record) return { ok: false, error: 'managed_project_not_found' };
  if (!record.local_path) return { ok: false, error: 'local_path_missing' };

  // v. — persist user intent: PROPOSED → PICKED, before any launch attempt.
  const pickRes = candidates.setCandidateStatus(projectId, cand.id, 'PICKED', null, { home: o.home });
  if (!pickRes.ok) return { ok: false, error: 'pick_failed', detail: pickRes.error, candidate_id: cand.id };

  // vi. — prompt: caller may pre-build, otherwise we synthesise.
  let prompt;
  if (typeof i.prompt === 'string' && i.prompt.trim()) {
    prompt = i.prompt;
  } else {
    const promptInput = i.prompt_input || {};
    try {
      const pack = workerPrompt.generateWorkerPrompt(promptInput, {
        candidate: cand,
        managed_record: record,
        forceDeterministic: true,
      });
      prompt = pack.prompt;
    } catch (e) {
      // candidate stays at PICKED (per §ix contract); user can retry.
      return { ok: false, error: 'prompt_synthesis_failed', detail: String(e && e.message || e),
               candidate_status: 'PICKED', candidate_id: cand.id };
    }
  }

  // vii. — worker gets its OWN iteration row (separate from scout's).
  const startRes = iters.startIteration(projectId, { goal_id: cand.id }, { home: o.home });
  if (!startRes.ok) {
    return { ok: false, error: 'iteration_start_failed', detail: startRes.error,
             candidate_status: 'PICKED', candidate_id: cand.id };
  }
  const workerIterationId = startRes.iteration.id;

  // viii. — launch
  const launchRes = launchManagedWorker(projectId, {
    provider: i.provider,
    prompt,
    iteration_id: workerIterationId,
  }, { home: o.home });

  if (!launchRes.ok) {
    // ix. candidate stays at PICKED. We surface enough detail for the
    // panel to render "launch_failed; you can retry from PICKED".
    return {
      ok: false,
      error: 'launch_failed',
      launch_error: launchRes.error,
      candidate_status: 'PICKED',
      candidate_id: cand.id,
      worker_iteration_id: workerIterationId,
    };
  }

  // x. — bind PICKED → WORKING + worker_iteration_id in one append.
  const bindRes = candidates.bindWorkerIteration(projectId, cand.id, workerIterationId, { home: o.home });
  if (!bindRes.ok) {
    // The launch already happened — we report the half-state. The
    // run is real and bound to its iteration via run.json; only the
    // candidate->iteration link failed. User can investigate.
    return {
      ok: false,
      error: 'bind_failed',
      bind_error: bindRes.error,
      run_id: launchRes.run_id,
      iteration_id: workerIterationId,
      candidate_id: cand.id,
      candidate_status: 'PICKED',
    };
  }

  return {
    ok: true,
    candidate: bindRes.candidate,
    run_id: launchRes.run_id,
    iteration_id: workerIterationId,
    worker_iteration_id: workerIterationId,
    candidate_status: 'WORKING',
  };
}

function extractScoutCandidates(projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const i = input || {};
  const runId = i.run_id;
  if (!runId) return { ok: false, error: 'run_id_required' };

  const runMeta = launcher.getWorkerRun(runId, { home: o.home });
  if (!runMeta) return { ok: false, error: 'run_not_found' };
  if (runMeta.project_id && runMeta.project_id !== projectId) {
    return { ok: false, error: 'project_id_mismatch' };
  }
  // Sync iteration status (same hygiene as extractManagedWorkerReport).
  syncIterationFromRun(runMeta, { home: o.home });

  const ext = launcher.extractScoutCandidates(runId, { home: o.home });
  if (!ext.ok) return ext;

  const sourceIterationId = i.iteration_id || runMeta.iteration_id || null;
  const candidate_ids = [];
  const persisted = [];
  for (const c of ext.candidates) {
    const r = candidates.proposeCandidate(projectId, {
      description: c.description,
      candidate_kind: c.kind,
      source_iteration_id: sourceIterationId,
      source_run_id: runId,
    }, { home: o.home });
    if (r.ok) {
      candidate_ids.push(r.candidate.id);
      persisted.push({ id: r.candidate.id, kind: r.candidate.candidate_kind, description: r.candidate.description });
    }
  }
  return { ok: true, candidate_ids, candidates: persisted, run_id: runId, iteration_id: sourceIterationId };
}

function extractManagedWorkerReport(projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const i = input || {};
  const runId = i.run_id;
  if (!runId) return { ok: false, error: 'run_id_required' };
  // Sync iteration status before extracting — by the time the user
  // clicks "extract report" the run has almost always exited.
  const runMeta = launcher.getWorkerRun(runId, { home: o.home });
  if (runMeta) syncIterationFromRun(runMeta, { home: o.home });
  const ext = launcher.extractWorkerReport(runId, { home: o.home });
  if (!ext.ok) return ext;
  // Persist as a normal worker report so review uses it.
  return attachManagedWorkerReport(projectId, {
    title: ext.title,
    completed: ext.completed,
    remaining: ext.remaining,
    blockers: ext.blockers,
    next_steps: ext.next_steps,
    source_app: 'auto-extract',
    iteration_id: i.iteration_id || null,
  }, { home: o.home });
}

/**
 * One-stop "advance the iteration" call for the panel: collect
 * evidence + run review. Caller still must trigger this — Cairn
 * never advances the loop on its own.
 */
async function continueManagedIterationReview(projectId, ctx, opts) {
  const o = opts || {};
  // Before review: if the iteration has a bound worker_run_id, fold
  // the run's terminal state back into the iteration so the review
  // sees a coherent worker_status/ended_at, not stale 'running'.
  const c = ctx || {};
  const itLatest = (c.iteration_id)
    ? iters.getIteration(projectId, c.iteration_id, { home: o.home })
    : iters.getLatestOpenIteration(projectId, { home: o.home });
  if (itLatest && itLatest.worker_run_id) {
    const runMeta = launcher.getWorkerRun(itLatest.worker_run_id, { home: o.home });
    if (runMeta) syncIterationFromRun(runMeta, { home: o.home });
  }
  const ev = collectManagedEvidence(projectId, ctx || {}, o);
  if (!ev.ok) return ev;
  const verdict = await reviewManagedIteration(projectId, ctx || {}, o);
  if (!verdict.ok) return verdict;
  return { ok: true, evidence: ev.evidence, summary: ev.summary, verdict: verdict.verdict, iteration_id: verdict.iteration_id };
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
  // worker launch
  detectWorkerProviders,
  launchManagedWorker,
  getWorkerRun,
  listWorkerRuns,
  stopWorkerRun,
  tailWorkerRun,
  extractManagedWorkerReport,
  extractScoutCandidates,
  pickCandidateAndLaunchWorker,
  continueManagedIterationReview,
};
