'use strict';

/**
 * Preload bridge between the renderer (panel.html / inspector-legacy.html /
 * preview.html) and the Electron main process.
 *
 * Read-only by default. The mutation channel (resolveConflict) is exposed
 * here ONLY when the main process advertises it via process.env-derived
 * flag CAIRN_DESKTOP_ENABLE_MUTATIONS=1. Renderers detect mutation
 * availability by checking `typeof window.cairn.resolveConflict ===
 * 'function'` (see inspector-legacy.js).
 */

const { contextBridge, ipcRenderer } = require('electron');

// Mutation flag is forwarded into the preload via a synchronous IPC call
// at startup. Main is the source of truth; preload just mirrors.
const MUTATIONS_ENABLED = (() => {
  try {
    return ipcRenderer.sendSync('cairn:mutations-enabled?') === true;
  } catch (_e) {
    return false;
  }
})();

const api = {
  // ---- Project-Aware Live Panel: L1 + project registry ----
  getProjectsList:    () => ipcRenderer.invoke('get-projects-list'),
  selectProject:      (id) => ipcRenderer.invoke('select-project', id),
  getSelectedProject: () => ipcRenderer.invoke('get-selected-project'),
  addProject:         (input) => ipcRenderer.invoke('add-project', input || {}),
  registerProjectFromCwd: (cwd, dbPath) =>
    ipcRenderer.invoke('register-project-from-cwd', cwd, dbPath || null),
  // Goal Mode v1
  getProjectGoal:    (projectId) => ipcRenderer.invoke('get-project-goal', projectId),
  setProjectGoal:    (projectId, goal) => ipcRenderer.invoke('set-project-goal', projectId, goal),
  clearProjectGoal:  (projectId) => ipcRenderer.invoke('clear-project-goal', projectId),
  // Project Rules (governance v1)
  getProjectRules:          (projectId) => ipcRenderer.invoke('get-project-rules', projectId),
  getEffectiveProjectRules: (projectId) => ipcRenderer.invoke('get-effective-project-rules', projectId),
  setProjectRules:          (projectId, rules) => ipcRenderer.invoke('set-project-rules', projectId, rules),
  clearProjectRules:        (projectId) => ipcRenderer.invoke('clear-project-rules', projectId),
  // Goal Interpretation (advisory)
  getGoalInterpretation:     (projectId) => ipcRenderer.invoke('get-goal-interpretation', projectId),
  refreshGoalInterpretation: (projectId, opts) =>
    ipcRenderer.invoke('refresh-goal-interpretation', projectId, opts || null),
  getLlmProviderInfo:        () => ipcRenderer.invoke('get-llm-provider-info'),
  // Worker Reports (Phase 3)
  addWorkerReport:    (projectId, input) => ipcRenderer.invoke('add-worker-report', projectId, input),
  listWorkerReports:  (projectId, limit) => ipcRenderer.invoke('list-worker-reports', projectId, limit || 0),
  clearWorkerReports: (projectId) => ipcRenderer.invoke('clear-worker-reports', projectId),
  // Pre-PR Gate (advisory)
  getPrePrGate:       (projectId) => ipcRenderer.invoke('get-pre-pr-gate', projectId),
  refreshPrePrGate:   (projectId, opts) => ipcRenderer.invoke('refresh-pre-pr-gate', projectId, opts || null),
  // Goal Loop Prompt Pack (copy-pasteable; user-driven, no auto-send)
  getPromptPack:      (projectId) => ipcRenderer.invoke('get-prompt-pack', projectId),
  generatePromptPack: (projectId, opts) => ipcRenderer.invoke('generate-prompt-pack', projectId, opts || null),
  // Managed Loop (Cairn-managed external repo)
  listManagedProjects:        () => ipcRenderer.invoke('list-managed-projects'),
  registerManagedProject:     (projectId, input) => ipcRenderer.invoke('register-managed-project', projectId, input || {}),
  getManagedProjectProfile:   (projectId) => ipcRenderer.invoke('get-managed-project-profile', projectId),
  startManagedIteration:      (projectId, input) => ipcRenderer.invoke('start-managed-iteration', projectId, input || {}),
  generateManagedWorkerPrompt:(projectId, opts) => ipcRenderer.invoke('generate-managed-worker-prompt', projectId, opts || null),
  attachManagedWorkerReport:  (projectId, input) => ipcRenderer.invoke('attach-managed-worker-report', projectId, input || {}),
  collectManagedEvidence:     (projectId, input) => ipcRenderer.invoke('collect-managed-evidence', projectId, input || {}),
  reviewManagedIteration:     (projectId, opts) => ipcRenderer.invoke('review-managed-iteration', projectId, opts || null),
  listManagedIterations:      (projectId, limit) => ipcRenderer.invoke('list-managed-iterations', projectId, limit || 0),
  // Managed worker launch (user-authorized; never auto-invoked)
  detectWorkerProviders:      () => ipcRenderer.invoke('detect-worker-providers'),
  launchManagedWorker:        (projectId, input) => ipcRenderer.invoke('launch-managed-worker', projectId, input || {}),
  getWorkerRun:               (runId) => ipcRenderer.invoke('get-worker-run', runId),
  listWorkerRuns:             (projectId) => ipcRenderer.invoke('list-worker-runs', projectId),
  stopWorkerRun:              (runId) => ipcRenderer.invoke('stop-worker-run', runId),
  tailWorkerRun:              (runId, limit) => ipcRenderer.invoke('tail-worker-run', runId, limit || 16 * 1024),
  extractWorkerReport:        (projectId, input) => ipcRenderer.invoke('extract-worker-report', projectId, input || {}),
  extractScoutCandidates:     (projectId, input) => ipcRenderer.invoke('extract-scout-candidates', projectId, input || {}),
  pickCandidateAndLaunchWorker: (projectId, input) => ipcRenderer.invoke('pick-candidate-and-launch-worker', projectId, input || {}),
  runReviewForCandidate:        (projectId, input) => ipcRenderer.invoke('run-review-for-candidate', projectId, input || {}),
  extractReviewVerdict:         (projectId, input) => ipcRenderer.invoke('extract-review-verdict', projectId, input || {}),
  // Day 5 — read-only candidate accessors
  listCandidates:               (projectId, limit) => ipcRenderer.invoke('list-candidates', projectId, limit || 100),
  listCandidatesByStatus:       (projectId, status) => ipcRenderer.invoke('list-candidates-by-status', projectId, status),
  getCandidate:                 (projectId, candidateId) => ipcRenderer.invoke('get-candidate', projectId, candidateId),
  verifyWorkerBoundary:         (projectId, input) => ipcRenderer.invoke('verify-worker-boundary', projectId, input || {}),
  // Multi-Cairn v0 read accessors (always exposed)
  getMultiCairnStatus:          () => ipcRenderer.invoke('get-multi-cairn-status'),
  listTeamCandidates:           (projectId) => ipcRenderer.invoke('list-team-candidates', projectId),
  listMyPublishedCandidateIds:  (projectId) => ipcRenderer.invoke('list-my-published-candidate-ids', projectId),
  // Mode B Continuous Iteration — read accessors always exposed
  getContinuousRun:             (projectId, runId) => ipcRenderer.invoke('get-continuous-run', projectId, runId),
  listContinuousRuns:           (projectId, limit) => ipcRenderer.invoke('list-continuous-runs', projectId, limit || 50),
  continueManagedIterationReview: (projectId, opts) => ipcRenderer.invoke('continue-managed-iteration-review', projectId, opts || null),
  // Recovery surface (read-only; copy-pasteable advisory prompts only)
  getProjectRecovery: (projectId) => ipcRenderer.invoke('get-project-recovery', projectId),
  getRecoveryPrompt:  (projectId, opts) => ipcRenderer.invoke('get-recovery-prompt', projectId, opts || null),
  // Coordination surface
  getProjectScratchpad:    (projectId, limit) => ipcRenderer.invoke('get-project-scratchpad', projectId, limit || 30),
  getProjectConflicts:     (projectId, limit) => ipcRenderer.invoke('get-project-conflicts', projectId, limit || 30),
  getCoordinationSignals:  (projectId) => ipcRenderer.invoke('get-coordination-signals', projectId),
  getHandoffPrompt:        (projectId, opts) => ipcRenderer.invoke('get-handoff-prompt', projectId, opts || null),
  getConflictPrompt:       (projectId, conflictId) => ipcRenderer.invoke('get-conflict-prompt', projectId, conflictId || null),
  getReviewPrompt:         (projectId, taskId) => ipcRenderer.invoke('get-review-prompt', projectId, taskId || null),
  removeProject:      (id) => ipcRenderer.invoke('remove-project', id),
  renameProject:      (id, label) => ipcRenderer.invoke('rename-project', id, label),
  addHint:            (id, agentId) => ipcRenderer.invoke('add-hint', id, agentId),
  getProjectSessions: () => ipcRenderer.invoke('get-project-sessions'),
  getProjectPulse:    () => ipcRenderer.invoke('get-project-pulse'),
  getUnassignedDetail:(dbPath) => ipcRenderer.invoke('get-unassigned-detail', dbPath),

  // ---- panel views (active-project routed; deprecated set-db-path) ----
  getProjectSummary: () => ipcRenderer.invoke('get-project-summary'),
  getTasksList:      () => ipcRenderer.invoke('get-tasks-list'),
  getTaskDetail:     (taskId) => ipcRenderer.invoke('get-task-detail', taskId),
  getTaskCheckpoints:(taskId) => ipcRenderer.invoke('get-task-checkpoints', taskId),
  getRunLogEvents:   () => ipcRenderer.invoke('get-run-log-events'),
  getDbPath:         () => ipcRenderer.invoke('get-db-path'),
  setDbPath:         (path) => ipcRenderer.invoke('set-db-path', path),
  openLegacyInspector: () => ipcRenderer.send('open-legacy-inspector'),
  hidePanel:           () => ipcRenderer.send('cairn:hide-panel'),

  // ---- Legacy (inspector-legacy.html + preview.html pet) ----
  getState:           () => ipcRenderer.invoke('get-state'),
  getActiveAgents:    () => ipcRenderer.invoke('get-active-agents'),
  getOpenConflicts:   () => ipcRenderer.invoke('get-open-conflicts'),
  getRecentDispatches:() => ipcRenderer.invoke('get-recent-dispatches'),
  getActiveLanes:     () => ipcRenderer.invoke('get-active-lanes'),
  openInspector:      () => ipcRenderer.send('open-inspector'),
  startDrag:          (mouseX, mouseY) => ipcRenderer.send('start-drag', { mouseX, mouseY }),
  doDrag:             (mouseX, mouseY) => ipcRenderer.send('do-drag', { mouseX, mouseY }),
};

// Mutation channel — present only in dev-flag mode. Renderers detect via
// typeof check; legacy inspector hides its Resolve button when absent.
if (MUTATIONS_ENABLED) {
  api.resolveConflict = (id, reason) =>
    ipcRenderer.invoke('resolve-conflict', id, reason);
  // Day 5 — three terminal candidate actions, gated identically
  // to Resolve so PRODUCT.md §12 D9 is preserved (panel never sees
  // mutation buttons; Inspector exposes them only when the user
  // explicitly opted into CAIRN_DESKTOP_ENABLE_MUTATIONS=1).
  api.acceptCandidate    = (projectId, candidateId) => ipcRenderer.invoke('accept-candidate', projectId, candidateId);
  api.rejectCandidate    = (projectId, candidateId) => ipcRenderer.invoke('reject-candidate', projectId, candidateId);
  api.rollBackCandidate  = (projectId, candidateId) => ipcRenderer.invoke('roll-back-candidate', projectId, candidateId);
  // Multi-Cairn v0 mutations — gated identically to the candidate
  // terminal actions. CAIRN_SHARED_DIR must ALSO be set for these to
  // do anything useful; the handler returns multi_cairn_not_enabled
  // when the shared dir is missing.
  api.publishCandidateToTeam     = (projectId, candidateId) => ipcRenderer.invoke('publish-candidate-to-team', projectId, candidateId);
  api.unpublishCandidateFromTeam = (projectId, candidateId) => ipcRenderer.invoke('unpublish-candidate-from-team', projectId, candidateId);
  // Mode B Continuous Iteration mutations
  api.runContinuousIteration     = (projectId, input) => ipcRenderer.invoke('run-continuous-iteration', projectId, input || {});
  api.stopContinuousIteration    = (runId) => ipcRenderer.invoke('stop-continuous-iteration', runId);
}

contextBridge.exposeInMainWorld('cairn', api);
