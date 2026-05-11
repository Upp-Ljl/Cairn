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
const reviewPrompt = require('./review-prompt.cjs');
const multiCairn   = require('./multi-cairn.cjs');
const scoutPrompt  = require('./scout-prompt.cjs');
const continuousRuns = require('./continuous-runs.cjs');

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

/**
 * Run a Review round on a WORKING candidate.
 *
 * State-machine contract (steps run IN ORDER; each step either
 * succeeds or short-circuits with a stable error code):
 *
 *   i.    candidate_not_found         — no row with that id
 *   ii.   project_id_mismatch         — candidate.project_id ≠ projectId
 *   iii.  candidate_not_working       — status ≠ 'WORKING'
 *                                       (current_status returned in detail)
 *   iv.   worker_iteration_missing    — candidate has no worker_iteration_id
 *                                       (defensive — should never happen
 *                                        post Day 3 bind, but smoked anyway)
 *   v.    managed_project_not_found   — no record on disk
 *   vi.   worker_iteration_not_found  — worker iteration row missing
 *                                       (defensive)
 *   vii.  fetch worker diff via collectWorkerDiff
 *   viii. fetch worker report via worker_iteration.worker_report_id
 *         (allowed to be null — review can run on diff alone)
 *   ix.   compose prompt (caller-provided OR generateReviewPrompt)
 *   x.    startManagedIteration — review gets its OWN iteration row
 *   xi.   launchManagedWorker on review provider
 *   xii.  if launch failed:
 *           candidate STAYS at WORKING (mirroring Day 3 launch_failed
 *           leaving candidate at PICKED). No auto-rollback, no
 *           auto-REJECT. The orphan review iteration row is left in
 *           place as a history trail, but candidate.review_iteration_id
 *           remains null — the user retries.
 *   xiii. if launch succeeded:
 *           bindReviewIteration: WORKING → REVIEWED + review_iteration_id
 *           in one append.
 *
 * IMPORTANT: this handler does NOT touch candidate's terminal state.
 * verdict extraction (extractReviewVerdict, below) is a separate
 * read-only call. Day 5 panel is where the user clicks ACCEPT /
 * REJECT / ROLLED_BACK after seeing the verdict — by design Cairn
 * does not advance the loop on its own (PRODUCT.md §1.3 #4).
 */
function runReviewForCandidate(projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const i = input || {};
  if (!i.candidate_id) return { ok: false, error: 'candidate_id_required' };
  if (!i.provider) return { ok: false, error: 'provider_required' };

  // i. + ii. + iii. + iv. — candidate sanity
  const cand = candidates.getCandidate(projectId, i.candidate_id, { home: o.home });
  if (!cand) return { ok: false, error: 'candidate_not_found' };
  if (cand.project_id && cand.project_id !== projectId) {
    return { ok: false, error: 'project_id_mismatch' };
  }
  if (cand.status !== 'WORKING') {
    return { ok: false, error: 'candidate_not_working', current_status: cand.status, candidate_id: cand.id };
  }
  if (!cand.worker_iteration_id) {
    return { ok: false, error: 'worker_iteration_missing', candidate_id: cand.id };
  }

  // v. — managed project record
  const record = mp.readManagedProject(projectId, o.home);
  if (!record) return { ok: false, error: 'managed_project_not_found' };
  if (!record.local_path) return { ok: false, error: 'local_path_missing' };

  // vi. — worker iteration row (defensive)
  const workerIter = iters.getIteration(projectId, cand.worker_iteration_id, { home: o.home });
  if (!workerIter) return { ok: false, error: 'worker_iteration_not_found' };

  // vii. — worker diff
  const diff = evidenceM.collectWorkerDiff(record.local_path, { home: o.home });
  if (!diff.ok) {
    return { ok: false, error: 'worker_diff_failed', detail: diff.error,
             candidate_status: 'WORKING', candidate_id: cand.id };
  }

  // viii. — worker report (optional)
  let workerReport = null;
  if (workerIter.worker_report_id) {
    const reports = wr.listWorkerReports(projectId, 50, { home: o.home });
    workerReport = reports.find(r => r.id === workerIter.worker_report_id) || null;
  }

  // ix. — prompt
  let prompt;
  if (typeof i.prompt === 'string' && i.prompt.trim()) {
    prompt = i.prompt;
  } else {
    try {
      const pack = reviewPrompt.generateReviewPrompt(i.prompt_input || {}, {
        candidate: cand,
        managed_record: record,
        worker_diff_text: diff.diff_text,
        worker_diff_truncated: diff.truncated,
        worker_report: workerReport,
        forceDeterministic: true,
      });
      prompt = pack.prompt;
    } catch (e) {
      return { ok: false, error: 'prompt_synthesis_failed', detail: String(e && e.message || e),
               candidate_status: 'WORKING', candidate_id: cand.id };
    }
  }

  // x. — review gets its OWN iteration row (separate from worker's).
  const startRes = iters.startIteration(projectId, { goal_id: cand.id }, { home: o.home });
  if (!startRes.ok) {
    return { ok: false, error: 'iteration_start_failed', detail: startRes.error,
             candidate_status: 'WORKING', candidate_id: cand.id };
  }
  const reviewIterationId = startRes.iteration.id;

  // xi. — launch
  const launchRes = launchManagedWorker(projectId, {
    provider: i.provider,
    prompt,
    iteration_id: reviewIterationId,
  }, { home: o.home });

  if (!launchRes.ok) {
    return {
      ok: false,
      error: 'launch_failed',
      launch_error: launchRes.error,
      candidate_status: 'WORKING',
      candidate_id: cand.id,
      review_iteration_id: reviewIterationId,
    };
  }

  // xiii. — bind WORKING → REVIEWED + review_iteration_id
  const bindRes = candidates.bindReviewIteration(projectId, cand.id, reviewIterationId, { home: o.home });
  if (!bindRes.ok) {
    return {
      ok: false,
      error: 'bind_failed',
      bind_error: bindRes.error,
      run_id: launchRes.run_id,
      iteration_id: reviewIterationId,
      candidate_id: cand.id,
      candidate_status: 'WORKING',
    };
  }

  return {
    ok: true,
    candidate: bindRes.candidate,
    run_id: launchRes.run_id,
    iteration_id: reviewIterationId,
    review_iteration_id: reviewIterationId,
    candidate_status: 'REVIEWED',
    worker_diff_truncated: diff.truncated,
  };
}

/**
 * Extract a Review Verdict from a finished review run's tail.log.
 * Two entry points:
 *   - { run_id }                       — direct
 *   - { candidate_id }                 — read candidate, walk to its
 *                                        review_iteration_id, look up
 *                                        the review iteration's run_id,
 *                                        then parse.
 *
 * IMPORTANT: this handler does NOT mutate candidate state. The
 * verdict is advisory data; Day 5 panel surfaces it and the user
 * decides ACCEPTED / REJECTED / ROLLED_BACK manually.
 */
function extractReviewVerdictHandler(projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const i = input || {};
  let runId = i.run_id || null;
  let candidate = null;
  let reviewIterationId = null;

  if (!runId && i.candidate_id) {
    candidate = candidates.getCandidate(projectId, i.candidate_id, { home: o.home });
    if (!candidate) return { ok: false, error: 'candidate_not_found' };
    if (candidate.project_id && candidate.project_id !== projectId) {
      return { ok: false, error: 'project_id_mismatch' };
    }
    if (candidate.status !== 'REVIEWED') {
      return { ok: false, error: 'candidate_not_reviewed', current_status: candidate.status };
    }
    if (!candidate.review_iteration_id) return { ok: false, error: 'review_iteration_missing' };
    reviewIterationId = candidate.review_iteration_id;
    const reviewIter = iters.getIteration(projectId, reviewIterationId, { home: o.home });
    if (!reviewIter) return { ok: false, error: 'review_iteration_not_found' };
    if (!reviewIter.worker_run_id) return { ok: false, error: 'review_run_id_missing' };
    runId = reviewIter.worker_run_id;
  }
  if (!runId) return { ok: false, error: 'run_id_or_candidate_id_required' };

  // Verify run.json's project_id matches.
  const runMeta = launcher.getWorkerRun(runId, { home: o.home });
  if (!runMeta) return { ok: false, error: 'run_not_found' };
  if (runMeta.project_id && runMeta.project_id !== projectId) {
    return { ok: false, error: 'project_id_mismatch' };
  }
  syncIterationFromRun(runMeta, { home: o.home });

  const ext = launcher.extractReviewVerdict(runId, { home: o.home });
  if (!ext.ok) return ext;

  return {
    ok: true,
    verdict: ext.verdict,
    reason: ext.reason,
    run_id: runId,
    candidate_id: candidate ? candidate.id : (i.candidate_id || runMeta.iteration_id ? null : null),
    review_iteration_id: reviewIterationId,
  };
}

// ---------------------------------------------------------------------------
// Day 6 — boundary verify (post-flight)
// ---------------------------------------------------------------------------
//
// Heuristic: extract path-like tokens from candidate.description, add
// kind-aware default scope (doc → *.md, missing_test → tests/, etc.),
// then check each changed file against this in-scope set.
//
// Conservative-failure mode: if no scope can be inferred (description
// is too abstract AND kind=other), return heuristic_notes='no_scope_inferred'
// and DO NOT write boundary_violations — better silent than false-positive.

// Default scope per kind. Deliberately narrow — `doc` does NOT
// blanket-include `*.md` (a rogue worker that drops some-marker.md at
// repo root would slip through). Use named-file + dir-prefix matchers
// only; an explicit description like "update prompts/x.md" still
// reaches scope via PATH_TOKEN_RX before the kind defaults are
// consulted.
const KIND_DEFAULT_SCOPE = {
  doc:          [/^README(?:\.md)?$/i, /^CHANGELOG(?:\.md)?$/i, /^LICENSE$/i, /^docs\//i],
  missing_test: [/^tests?\//i, /\.test\.[jt]sx?$/i, /\.spec\.[jt]sx?$/i],
  bug_fix:      [/^src\//i, /^lib\//i, /^packages\//i],
  refactor:     [/^src\//i, /^lib\//i, /^packages\//i],
  other:        [],
};
const PATH_TOKEN_RX = /([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|toml|yaml|yml|py|rs|go|rb|java|html|css|scss|sql))/g;
const DIR_PREFIX_RX = /\b(src|tests|test|docs|lib|prompts|packages|scripts)\/[\w./-]*/g;
const NAMED_FILE_RX = /\b(README(?:\.md)?|CHANGELOG(?:\.md)?|LICENSE|package\.json|tsconfig\.json|Cargo\.toml|go\.mod|Gemfile|pyproject\.toml)\b/gi;

function inferScopeFromCandidate(candidate) {
  const desc = (candidate && candidate.description) || '';
  const kind = (candidate && candidate.candidate_kind) || 'other';
  const explicitFiles = new Set();
  const explicitDirs = new Set();
  const matchers = [];

  // Extract explicit file paths via matchAll (same convention as
  // Worker Report / Scout extractors so audit greps stay clean).
  for (const m of desc.matchAll(PATH_TOKEN_RX)) {
    explicitFiles.add(m[1]);
    // Add the file's containing directory as a prefix too — "Add JSDoc
    // to src/foo.ts" should accept changes inside `src/` (e.g. helper
    // files the worker had to touch).
    const lastSlash = m[1].lastIndexOf('/');
    if (lastSlash > 0) explicitDirs.add(m[1].slice(0, lastSlash + 1));
  }
  for (const m of desc.matchAll(DIR_PREFIX_RX)) {
    explicitDirs.add(m[0].endsWith('/') ? m[0] : m[0] + '/');
  }
  for (const m of desc.matchAll(NAMED_FILE_RX)) {
    explicitFiles.add(m[1]);
  }

  for (const f of explicitFiles) matchers.push(new RegExp('^' + f.replace(/[.+^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
  for (const d of explicitDirs)  matchers.push(new RegExp('^' + d.replace(/[.+^${}()|[\]\\]/g, '\\$&'),       'i'));

  // missing_test special case: if a src/foo.ts is referenced, also
  // accept tests/foo.test.* and tests/foo/.
  if (kind === 'missing_test') {
    for (const f of explicitFiles) {
      const m2 = f.match(/^(?:src|lib|packages)\/(.+?)\.(?:ts|tsx|js|jsx|mjs|cjs)$/i);
      if (m2) {
        const stem = m2[1];
        matchers.push(new RegExp('^tests?/.*' + stem.replace(/[.+^${}()|[\]\\]/g, '\\$&') + '\\.(?:test|spec)\\.[jt]sx?$', 'i'));
        matchers.push(new RegExp('^tests?/' + stem.replace(/[.+^${}()|[\]\\]/g, '\\$&') + '/', 'i'));
      }
    }
  }

  // Add kind-default scope.
  const defaults = KIND_DEFAULT_SCOPE[kind] || [];
  for (const rx of defaults) matchers.push(rx);

  // If no matchers at all (kind=other and no explicit paths in desc),
  // signal "no scope inferred" — caller should NOT mark violations.
  const noScope = matchers.length === 0;

  return {
    matchers,
    explicitFiles: Array.from(explicitFiles),
    explicitDirs: Array.from(explicitDirs),
    kind,
    noScope,
  };
}

function classifyChangedFiles(scope, changedFiles) {
  const inScope = [];
  const outOfScope = [];
  for (const f of (changedFiles || [])) {
    const matched = scope.matchers.some(rx => rx.test(f));
    if (matched) inScope.push(f);
    else outOfScope.push(f);
  }
  return { inScope, outOfScope };
}

/**
 * Verify the worker stayed in the candidate's inferred scope.
 *
 * State requirement: candidate has actually had a worker run (status
 * ∈ WORKING / REVIEWED / ACCEPTED / REJECTED / ROLLED_BACK; for
 * PROPOSED / PICKED returns worker_not_run because there is no diff
 * to verify).
 *
 * Side effects (write only when scope was inferable):
 *   - patchCandidate: boundary_violations = out_of_scope (overwrite)
 *   - patchIteration: evidence_summary merged with
 *       { boundary_violations_count, boundary_in_scope_count }
 *
 * Idempotent — re-running with the same diff produces the same writes.
 */
function verifyWorkerBoundary(projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const i = input || {};
  if (!i.candidate_id) return { ok: false, error: 'candidate_id_required' };

  const cand = candidates.getCandidate(projectId, i.candidate_id, { home: o.home });
  if (!cand) return { ok: false, error: 'candidate_not_found' };
  if (cand.project_id && cand.project_id !== projectId) {
    return { ok: false, error: 'project_id_mismatch' };
  }
  // PROPOSED / PICKED → worker hasn't actually written anything yet.
  const VERIFIABLE = new Set(['WORKING', 'REVIEWED', 'ACCEPTED', 'REJECTED', 'ROLLED_BACK']);
  if (!VERIFIABLE.has(cand.status)) {
    return { ok: false, error: 'worker_not_run', current_status: cand.status, candidate_id: cand.id };
  }
  if (!cand.worker_iteration_id) {
    return { ok: false, error: 'worker_iteration_missing', candidate_id: cand.id };
  }

  const record = mp.readManagedProject(projectId, o.home);
  if (!record) return { ok: false, error: 'managed_project_not_found' };
  if (!record.local_path) return { ok: false, error: 'local_path_missing' };

  const workerIter = iters.getIteration(projectId, cand.worker_iteration_id, { home: o.home });
  if (!workerIter) return { ok: false, error: 'worker_iteration_not_found' };

  const ev = evidenceM.collectGitEvidence(record.local_path, { profile: record.profile });
  const changedFiles = ev && Array.isArray(ev.changed_files) ? ev.changed_files : [];

  const scope = inferScopeFromCandidate(cand);

  if (scope.noScope) {
    // Conservative: do NOT write boundary_violations. Leave the field
    // alone (might be [] from propose, or carry an earlier verify
    // result that this run can't second-guess).
    return {
      ok: true,
      violations: [],
      in_scope: [],
      out_of_scope: [],
      heuristic_notes: 'no_scope_inferred',
      changed_files: changedFiles,
      candidate_id: cand.id,
    };
  }

  const { inScope, outOfScope } = classifyChangedFiles(scope, changedFiles);

  // Persist boundary_violations on the candidate (overwrite).
  candidates.patchCandidate(projectId, cand.id, { boundary_violations: outOfScope }, { home: o.home });

  // Merge counts into the worker iteration's evidence_summary.
  const existingEv = workerIter.evidence_summary || {};
  const mergedEv = Object.assign({}, existingEv, {
    boundary_violations_count: outOfScope.length,
    boundary_in_scope_count:   inScope.length,
  });
  iters.patchIteration(projectId, cand.worker_iteration_id, { evidence_summary: mergedEv }, { home: o.home });

  const noteParts = [];
  if (scope.explicitFiles.length) noteParts.push('files: ' + scope.explicitFiles.join(', '));
  if (scope.explicitDirs.length)  noteParts.push('dirs: '  + scope.explicitDirs.join(', '));
  noteParts.push('kind=' + scope.kind);

  return {
    ok: true,
    violations: outOfScope,
    in_scope: inScope,
    out_of_scope: outOfScope,
    heuristic_notes: noteParts.join('; '),
    changed_files: changedFiles,
    candidate_id: cand.id,
  };
}

// ---------------------------------------------------------------------------
// Day 5 — terminal user actions on a candidate.
// ---------------------------------------------------------------------------
//
// These three handlers move a candidate to its terminal state based on
// an explicit user click in the Inspector (gated by
// CAIRN_DESKTOP_ENABLE_MUTATIONS=1; D9 boundary). They never run on
// their own and never react to a verdict — verdict=pass does NOT
// auto-promote to ACCEPTED. The user reads the verdict in the panel,
// then chooses Accept / Reject / Roll back.

const TERMINAL_STATES = new Set(['ACCEPTED', 'REJECTED', 'ROLLED_BACK']);

function _candidateBoundaryCheck(projectId, candidateId, opts) {
  const o = opts || {};
  if (!projectId) return { _err: { ok: false, error: 'project_id_required' } };
  if (!candidateId) return { _err: { ok: false, error: 'candidate_id_required' } };
  const cand = candidates.getCandidate(projectId, candidateId, { home: o.home });
  if (!cand) return { _err: { ok: false, error: 'candidate_not_found' } };
  if (cand.project_id && cand.project_id !== projectId) {
    return { _err: { ok: false, error: 'project_id_mismatch' } };
  }
  return { cand };
}

/**
 * Move a REVIEWED candidate to ACCEPTED. Any other origin status
 * rejects with `candidate_not_reviewed` (current_status returned in
 * detail). Verdict is not consulted — the user decides Accept after
 * seeing the verdict.
 */
function acceptCandidate(projectId, candidateId, opts) {
  const o = opts || {};
  const chk = _candidateBoundaryCheck(projectId, candidateId, opts);
  if (chk._err) return chk._err;
  if (chk.cand.status !== 'REVIEWED') {
    return { ok: false, error: 'candidate_not_reviewed', current_status: chk.cand.status, candidate_id: chk.cand.id };
  }
  const r = candidates.setCandidateStatus(projectId, candidateId, 'ACCEPTED', null, { home: o.home });
  if (!r.ok) return r;
  return { ok: true, candidate: r.candidate };
}

/**
 * Move ANY non-terminal candidate to REJECTED. The user can abandon
 * a candidate at any non-terminal stage — that's the "I don't want
 * this" exit. Already-terminal rejects with `candidate_terminal`.
 */
function rejectCandidate(projectId, candidateId, opts) {
  const o = opts || {};
  const chk = _candidateBoundaryCheck(projectId, candidateId, opts);
  if (chk._err) return chk._err;
  if (TERMINAL_STATES.has(chk.cand.status)) {
    return { ok: false, error: 'candidate_terminal', current_status: chk.cand.status, candidate_id: chk.cand.id };
  }
  const r = candidates.setCandidateStatus(projectId, candidateId, 'REJECTED', null, { home: o.home });
  if (!r.ok) return r;
  return { ok: true, candidate: r.candidate };
}

/**
 * Move a REVIEWED candidate to ROLLED_BACK. **State-only**: this
 * does NOT run any git command and does NOT touch the worker's
 * working-tree diff. The UI shows a confirmation dialog telling the
 * user to `git checkout -- <files>` manually if they want to discard
 * the diff. Per-Day-4-handoff option (a): record state only, defer
 * a real Cairn-driven revert to a future product call.
 */
function rollBackCandidate(projectId, candidateId, opts) {
  const o = opts || {};
  const chk = _candidateBoundaryCheck(projectId, candidateId, opts);
  if (chk._err) return chk._err;
  if (chk.cand.status !== 'REVIEWED') {
    return { ok: false, error: 'candidate_not_reviewed', current_status: chk.cand.status, candidate_id: chk.cand.id };
  }
  const r = candidates.setCandidateStatus(projectId, candidateId, 'ROLLED_BACK', null, { home: o.home });
  if (!r.ok) return r;
  return {
    ok: true,
    candidate: r.candidate,
    hint: 'working tree diff retained; use git checkout -- <files> to revert manually',
  };
}

// Read-only candidate accessors (Day 5 — needed by Inspector list
// rendering; missed by Day 1 IPC plan). These are pure pass-throughs
// to project-candidates.cjs and require no MUTATIONS gate.

function listCandidatesHandler(projectId, limit, opts) {
  if (!projectId) return [];
  return candidates.listCandidates(projectId, limit || 100, { home: (opts && opts.home) || undefined });
}
function listCandidatesByStatusHandler(projectId, status, opts) {
  if (!projectId || !status) return [];
  return candidates.listCandidatesByStatus(projectId, status, { home: (opts && opts.home) || undefined });
}
function getCandidateHandler(projectId, candidateId, opts) {
  if (!projectId || !candidateId) return null;
  return candidates.getCandidate(projectId, candidateId, { home: (opts && opts.home) || undefined });
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

// ---------------------------------------------------------------------------
// Mode B — Continuous Iteration
// ---------------------------------------------------------------------------
//
// Auto-chains a Scout run, then up to N (Worker → Review → Verify)
// rounds. Stops at REVIEWED for each candidate — NEVER auto-accepts,
// rejects, or rolls back. The user reviews verdicts in the Inspector
// (Day 5) and clicks terminal action buttons.
//
// All provider launches go through the existing Day 2-6 handlers
// (extractScoutCandidates / pickCandidateAndLaunchWorker /
// runReviewForCandidate / extractReviewVerdict / verifyWorkerBoundary)
// so every Day 1-6 invariant — launch-failed-keeps-candidate-at-PICKED,
// verdict-does-not-auto-promote, boundary-verify-is-advisory — stays
// intact.
//
// State tracker lives in `~/.cairn/continuous-runs/<projectId>.jsonl`.
// An in-process registry (`continuousRunRegistry`) tracks the
// stopRequested flag for cooperative stop — the poll loop checks it
// each tick.

/** @type {Map<string, { stopRequested: boolean, projectId: string }>} */
const continuousRunRegistry = new Map();

function _isTerminalRunStatus(s) {
  return s === 'exited' || s === 'failed' || s === 'stopped' || s === 'unknown';
}

/**
 * Poll launcher.getWorkerRun(runId) until the underlying child has
 * reached a terminal status, OR a stop has been requested on the
 * continuous run, OR the per-stage timeout elapses.
 *
 * Returns { run, stopped: bool, timedOut: bool }.
 */
async function _pollUntilTerminal(runId, continuousRunId, opts) {
  const o = opts || {};
  const pollMs = o.poll_ms || 1000;
  const stageBudgetMs = o.stage_timeout_ms || (4 * 60 * 1000);
  const startedAt = Date.now();
  let run = null;
  while (true) {
    run = launcher.getWorkerRun(runId, { home: o.home });
    if (run && _isTerminalRunStatus(run.status)) return { run, stopped: false, timedOut: false };
    if (continuousRunRegistry.get(continuousRunId)
        && continuousRunRegistry.get(continuousRunId).stopRequested) {
      // best-effort: ask the launcher to stop the child if still running
      if (run && (run.status === 'running' || run.status === 'queued')) {
        launcher.stopWorkerRun(runId, { home: o.home });
        await new Promise(r => setTimeout(r, 200));
        run = launcher.getWorkerRun(runId, { home: o.home });
      }
      return { run, stopped: true, timedOut: false };
    }
    if (Date.now() - startedAt > stageBudgetMs) {
      if (run && (run.status === 'running' || run.status === 'queued')) {
        launcher.stopWorkerRun(runId, { home: o.home });
        await new Promise(r => setTimeout(r, 200));
        run = launcher.getWorkerRun(runId, { home: o.home });
      }
      return { run, stopped: false, timedOut: true };
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

/**
 * Drive one full Scout → up-to-N (Worker → Review → Verify) chain.
 *
 * input:
 *   { goal, rules?, scout_provider, worker_provider, review_provider,
 *     max_candidates }
 * opts:
 *   { home, env, poll_ms (default 1000), stage_timeout_ms (default 4min),
 *     total_timeout_ms (default 15min) }
 *
 * Returns:
 *   { ok, run_id, scout_run_id, scout_iteration_id,
 *     candidate_runs: [{ candidate_id, worker_iteration_id,
 *       worker_run_id, review_iteration_id, review_run_id,
 *       verdict, reason, boundary_violations, status }],
 *     stopped_reason, status }
 *
 * NEVER calls acceptCandidate / rejectCandidate / rollBackCandidate.
 */
async function runContinuousIteration(projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const i = input || {};
  if (!i.goal || !i.goal.title) return { ok: false, error: 'goal_required' };
  if (!i.scout_provider)  return { ok: false, error: 'scout_provider_required' };
  if (!i.worker_provider) return { ok: false, error: 'worker_provider_required' };
  if (!i.review_provider) return { ok: false, error: 'review_provider_required' };
  const maxCandidates = Number.isFinite(i.max_candidates) ? i.max_candidates : 3;
  if (maxCandidates < 0 || maxCandidates > 20) return { ok: false, error: 'max_candidates_out_of_range' };

  const record = mp.readManagedProject(projectId, o.home);
  if (!record) return { ok: false, error: 'managed_project_not_found' };

  // Open the continuous-run tracker row.
  const startRes = continuousRuns.startContinuousRun(projectId, {
    max_candidates: maxCandidates,
    scout_provider:  i.scout_provider,
    worker_provider: i.worker_provider,
    review_provider: i.review_provider,
  }, { home: o.home });
  if (!startRes.ok) return { ok: false, error: 'continuous_run_start_failed', detail: startRes.error };
  const crRunId = startRes.run.id;
  continuousRunRegistry.set(crRunId, { stopRequested: false, projectId });

  const totalBudgetMs = o.total_timeout_ms || (15 * 60 * 1000);
  const startedAt = Date.now();
  const candidateRuns = [];
  const errors = [];
  let stoppedReason = null;
  let finalStatus = 'finished';
  let scoutRunId = null;
  let scoutIterationId = null;

  function _checkStopOrTimeout() {
    if (continuousRunRegistry.get(crRunId).stopRequested) return 'user_stopped';
    if (Date.now() - startedAt > totalBudgetMs) return 'timeout';
    return null;
  }

  try {
    // ---- Stage 1: Scout ------------------------------------------------
    continuousRuns.patchContinuousRun(projectId, crRunId, { current_stage: 'scout-launch' }, { home: o.home });

    if (maxCandidates === 0) {
      stoppedReason = 'no_candidates';
      continuousRuns.patchContinuousRun(projectId, crRunId,
        { status: 'finished', current_stage: 'done', stopped_reason: stoppedReason },
        { home: o.home });
      continuousRunRegistry.delete(crRunId);
      return { ok: true, run_id: crRunId, scout_run_id: null, scout_iteration_id: null,
               candidate_runs: [], errors, stopped_reason: stoppedReason, status: 'finished' };
    }

    const scoutIter = iters.startIteration(projectId, { goal_id: i.goal.id || null }, { home: o.home });
    if (!scoutIter.ok) {
      stoppedReason = 'inner_handler_failed';
      errors.push('scout_iteration_start: ' + (scoutIter.error || 'unknown'));
      finalStatus = 'failed';
      throw new Error('scout_iteration_start_failed');
    }
    scoutIterationId = scoutIter.iteration.id;

    const scoutPack = scoutPrompt.generateScoutPrompt({
      goal: i.goal,
      project_rules: i.rules || null,
      project_rules_is_default: !i.rules,
      pulse: null, activity_summary: null, tasks_summary: null,
      blockers_summary: null, outcomes_summary: null,
      recent_reports: [],
      pre_pr_gate: null,
    }, {
      managed_record: record,
      iteration_id: scoutIterationId,
      forceDeterministic: true,
    });

    const scoutLaunch = launchManagedWorker(projectId, {
      provider: i.scout_provider,
      prompt: scoutPack.prompt,
      iteration_id: scoutIterationId,
    }, { home: o.home });
    if (!scoutLaunch.ok) {
      stoppedReason = 'inner_handler_failed';
      errors.push('scout_launch: ' + (scoutLaunch.error || 'unknown'));
      finalStatus = 'failed';
      throw new Error('scout_launch_failed');
    }
    scoutRunId = scoutLaunch.run_id;
    continuousRuns.patchContinuousRun(projectId, crRunId,
      { current_stage: 'scout-poll', scout_run_id: scoutRunId, scout_iteration_id: scoutIterationId },
      { home: o.home });

    const scoutPoll = await _pollUntilTerminal(scoutRunId, crRunId, o);
    if (scoutPoll.stopped) { stoppedReason = 'user_stopped'; finalStatus = 'stopped'; throw new Error('stopped'); }
    if (scoutPoll.timedOut) { stoppedReason = 'timeout'; finalStatus = 'stopped'; throw new Error('timeout'); }
    if (!scoutPoll.run || scoutPoll.run.status !== 'exited') {
      stoppedReason = 'inner_handler_failed';
      errors.push('scout_nonzero_exit: ' + (scoutPoll.run && scoutPoll.run.status || 'unknown'));
      finalStatus = 'failed';
      throw new Error('scout_exit');
    }

    continuousRuns.patchContinuousRun(projectId, crRunId, { current_stage: 'scout-extract' }, { home: o.home });
    const scoutExt = extractScoutCandidates(projectId, { run_id: scoutRunId, iteration_id: scoutIterationId }, { home: o.home });
    if (!scoutExt.ok) {
      stoppedReason = scoutExt.error === 'no_scout_block' ? 'no_candidates' : 'inner_handler_failed';
      if (stoppedReason === 'inner_handler_failed') {
        errors.push('scout_extract: ' + scoutExt.error);
        finalStatus = 'failed';
      }
      throw new Error('scout_extract_done');
    }
    const candidateIds = scoutExt.candidate_ids || [];
    if (candidateIds.length === 0) {
      stoppedReason = 'no_candidates';
      throw new Error('no_candidates');
    }

    // ---- Stage 2..N: Worker → Review → Verify per candidate -----------
    const toProcess = candidateIds.slice(0, maxCandidates);
    for (let idx = 0; idx < toProcess.length; idx++) {
      const candidateId = toProcess[idx];
      const stageBase = `candidate-${idx + 1}`;

      const stopMid = _checkStopOrTimeout();
      if (stopMid) { stoppedReason = stopMid; finalStatus = 'stopped'; break; }

      // ---- Worker ----
      continuousRuns.patchContinuousRun(projectId, crRunId,
        { current_stage: stageBase + '-worker-launch' }, { home: o.home });
      const wbRes = pickCandidateAndLaunchWorker(projectId, {
        candidate_id: candidateId, provider: i.worker_provider,
      }, { home: o.home });
      if (!wbRes.ok) {
        const code = wbRes.error || 'unknown';
        errors.push(`worker_launch[${candidateId}]: ${code}`);
        if (code === 'launch_failed') {
          // Per Day 3 contract — candidate stays at PICKED, partial result.
          stoppedReason = 'worker_launch_failed';
          // Don't push a candidate_runs entry (no worker_run_id, no
          // review_run_id, status accurately reflected on candidate row).
          break;
        }
        // any other error is treated as a hard failure
        stoppedReason = 'inner_handler_failed';
        finalStatus = 'failed';
        break;
      }
      const workerRunId = wbRes.run_id;
      const workerIterationId = wbRes.worker_iteration_id;
      continuousRuns.patchContinuousRun(projectId, crRunId,
        { current_stage: stageBase + '-worker-poll' }, { home: o.home });
      const wbPoll = await _pollUntilTerminal(workerRunId, crRunId, o);
      if (wbPoll.stopped) { stoppedReason = 'user_stopped'; finalStatus = 'stopped'; break; }
      if (wbPoll.timedOut) { stoppedReason = 'timeout'; finalStatus = 'stopped'; break; }

      // ---- Review ----
      continuousRuns.patchContinuousRun(projectId, crRunId,
        { current_stage: stageBase + '-review-launch' }, { home: o.home });
      const rbRes = runReviewForCandidate(projectId, {
        candidate_id: candidateId, provider: i.review_provider,
      }, { home: o.home });
      if (!rbRes.ok) {
        const code = rbRes.error || 'unknown';
        errors.push(`review_launch[${candidateId}]: ${code}`);
        // Record the partial candidate run so the panel can see worker
        // landed but review didn't.
        candidateRuns.push({
          candidate_id: candidateId,
          worker_iteration_id: workerIterationId,
          worker_run_id: workerRunId,
          review_iteration_id: null,
          review_run_id: null,
          verdict: null, reason: null,
          boundary_violations: [],
          status: 'WORKING',
        });
        if (code === 'launch_failed') {
          stoppedReason = 'review_launch_failed';
          break;
        }
        stoppedReason = 'inner_handler_failed';
        finalStatus = 'failed';
        break;
      }
      const reviewRunId = rbRes.run_id;
      const reviewIterationId = rbRes.review_iteration_id;
      continuousRuns.patchContinuousRun(projectId, crRunId,
        { current_stage: stageBase + '-review-poll' }, { home: o.home });
      const rbPoll = await _pollUntilTerminal(reviewRunId, crRunId, o);
      if (rbPoll.stopped) {
        // record what we have so far
        candidateRuns.push({
          candidate_id: candidateId,
          worker_iteration_id: workerIterationId, worker_run_id: workerRunId,
          review_iteration_id: reviewIterationId, review_run_id: reviewRunId,
          verdict: null, reason: null, boundary_violations: [],
          status: 'REVIEWED',
        });
        stoppedReason = 'user_stopped'; finalStatus = 'stopped'; break;
      }
      if (rbPoll.timedOut) { stoppedReason = 'timeout'; finalStatus = 'stopped'; break; }

      // ---- Verdict + Verify ----
      continuousRuns.patchContinuousRun(projectId, crRunId,
        { current_stage: stageBase + '-verdict' }, { home: o.home });
      const verdictRes = extractReviewVerdictHandler(projectId, { run_id: reviewRunId }, { home: o.home });
      const verdict = verdictRes.ok ? verdictRes.verdict : null;
      const reason  = verdictRes.ok ? verdictRes.reason  : null;
      if (!verdictRes.ok) errors.push(`review_verdict[${candidateId}]: ${verdictRes.error}`);

      continuousRuns.patchContinuousRun(projectId, crRunId,
        { current_stage: stageBase + '-verify' }, { home: o.home });
      const verifyRes = verifyWorkerBoundary(projectId, { candidate_id: candidateId }, { home: o.home });
      const violations = verifyRes.ok ? (verifyRes.out_of_scope || []) : [];
      if (!verifyRes.ok) errors.push(`verify[${candidateId}]: ${verifyRes.error}`);

      const candRunEntry = {
        candidate_id: candidateId,
        worker_iteration_id: workerIterationId,
        worker_run_id: workerRunId,
        review_iteration_id: reviewIterationId,
        review_run_id: reviewRunId,
        verdict, reason,
        boundary_violations: violations,
        status: 'REVIEWED',
      };
      candidateRuns.push(candRunEntry);
      continuousRuns.appendCandidateRun(projectId, crRunId, candRunEntry, { home: o.home });

      // Check stop after each candidate.
      const stopAfter = _checkStopOrTimeout();
      if (stopAfter) { stoppedReason = stopAfter; finalStatus = 'stopped'; break; }
    }

    if (!stoppedReason) {
      // We exhausted the loop without breaking. Distinguish completed
      // (processed every candidate the scout proposed, up to budget)
      // vs max_reached (scout proposed more than we processed).
      stoppedReason = (candidateIds.length > toProcess.length) ? 'max_reached' : 'completed';
    }
  } catch (e) {
    // Inner handlers set stoppedReason/finalStatus before throwing.
    // Anything reaching here is the "throw to break out of nested
    // logic" idiom; if we somehow got here without a reason, treat as
    // unknown failure.
    if (!stoppedReason) {
      stoppedReason = 'inner_handler_failed';
      finalStatus = 'failed';
      errors.push('uncaught: ' + String(e && e.message || e).slice(0, 200));
    }
  }

  for (const err of errors) continuousRuns.appendError(projectId, crRunId, err, { home: o.home });
  continuousRuns.patchContinuousRun(projectId, crRunId, {
    status: finalStatus,
    current_stage: 'done',
    stopped_reason: stoppedReason,
  }, { home: o.home });
  continuousRunRegistry.delete(crRunId);

  return {
    ok: true,
    run_id: crRunId,
    scout_run_id: scoutRunId,
    scout_iteration_id: scoutIterationId,
    candidate_runs: candidateRuns,
    errors,
    stopped_reason: stoppedReason,
    status: finalStatus,
  };
}

/**
 * Set the stopRequested flag for an in-flight continuous run. The
 * cooperative stop is observed by `_pollUntilTerminal` and the
 * between-candidate stop check. Returns { ok: true } even when the
 * run has already finished (idempotent).
 */
function stopContinuousIteration(runId) {
  if (!runId) return { ok: false, error: 'run_id_required' };
  const entry = continuousRunRegistry.get(runId);
  if (!entry) return { ok: true, already_finished: true };
  entry.stopRequested = true;
  return { ok: true };
}

function getContinuousRunHandler(projectId, runId, opts) {
  if (!projectId || !runId) return null;
  return continuousRuns.getContinuousRun(projectId, runId, { home: (opts && opts.home) || undefined });
}

function listContinuousRunsHandler(projectId, limit, opts) {
  if (!projectId) return [];
  return continuousRuns.listContinuousRuns(projectId, limit || 50, { home: (opts && opts.home) || undefined });
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
  runReviewForCandidate,
  extractReviewVerdict: extractReviewVerdictHandler,
  // Day 5 terminal actions (Inspector-only behind CAIRN_DESKTOP_ENABLE_MUTATIONS)
  acceptCandidate,
  rejectCandidate,
  rollBackCandidate,
  // Day 5 read-only candidate accessors (always exposed)
  listCandidates: listCandidatesHandler,
  listCandidatesByStatus: listCandidatesByStatusHandler,
  getCandidate: getCandidateHandler,
  // Day 6 boundary verify
  verifyWorkerBoundary,
  inferScopeFromCandidate,
  classifyChangedFiles,
  // Multi-Cairn v0 (read-only sharing via CAIRN_SHARED_DIR outbox)
  getMultiCairnStatus: (opts) => multiCairn.getMultiCairnStatus(opts || {}),
  publishCandidateToTeam: (projectId, candidateId, opts) => {
    if (!projectId) return { ok: false, error: 'project_id_required' };
    if (!candidateId) return { ok: false, error: 'candidate_id_required' };
    // project_id_mismatch is enforced inside publishCandidate via
    // candidates.getCandidate(projectId, ...), which can't find a row
    // whose stored project_id differs from the JSONL filename — same
    // pattern as accept/reject/rollback.
    return multiCairn.publishCandidate(projectId, candidateId, opts || {});
  },
  unpublishCandidateFromTeam: (projectId, candidateId, opts) => {
    if (!projectId) return { ok: false, error: 'project_id_required' };
    if (!candidateId) return { ok: false, error: 'candidate_id_required' };
    return multiCairn.unpublishCandidate(projectId, candidateId, opts || {});
  },
  listTeamCandidates: (projectId, opts) => {
    if (!projectId) return [];
    return multiCairn.listPublishedCandidates(projectId, opts || {});
  },
  listMyPublishedCandidateIds: (projectId, opts) => {
    if (!projectId) return [];
    return Array.from(multiCairn.listMyPublishedCandidateIds(projectId, opts || {}));
  },
  // Mode B Continuous Iteration
  runContinuousIteration,
  stopContinuousIteration,
  getContinuousRun: getContinuousRunHandler,
  listContinuousRuns: listContinuousRunsHandler,
  continueManagedIterationReview,
};
