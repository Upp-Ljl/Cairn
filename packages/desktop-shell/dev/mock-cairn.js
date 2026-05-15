'use strict';

/**
 * Mock window.cairn bridge for web-based panel development.
 *
 * Provides realistic fake data so panel.html + panel.js render
 * without Electron. All methods return Promises (matching the
 * real ipcRenderer.invoke contract).
 *
 * Edit MOCK_DATA below to test different states.
 */

// ---------------------------------------------------------------------------
// Tunable mock data
// ---------------------------------------------------------------------------

const NOW = Date.now();
const SEC = 1000;
const MIN = 60 * SEC;

const MOCK_PROJECTS = [
  {
    id: 'proj-cairn',
    label: 'Cairn',
    project_root: 'D:\\lll\\cairn',
    db_path: 'C:\\Users\\jushi\\.cairn\\cairn.db',
    mode: 'A',
    mode_a_phase: 'running',
    leader: 'cairn-session-abc123def456',
    agent_id_hints: ['cairn-session-abc123def456'],
    pulse: {
      active_agents: 2,
      open_tasks: 3,
      pending_dispatches: 1,
      open_conflicts: 0,
      pending_escalations: 1,
      last_heartbeat: NOW - 12 * SEC,
    },
  },
  {
    id: 'proj-demo',
    label: 'demo-app',
    project_root: 'D:\\lll\\demo-app',
    db_path: 'C:\\Users\\jushi\\.cairn\\demo.db',
    mode: 'B',
    mode_a_phase: 'idle',
    leader: null,
    agent_id_hints: ['cairn-session-999000111222'],
    pulse: {
      active_agents: 0,
      open_tasks: 1,
      pending_dispatches: 0,
      open_conflicts: 0,
      pending_escalations: 0,
      last_heartbeat: NOW - 5 * MIN,
    },
  },
];

function makeCockpitState(projectId) {
  const proj = MOCK_PROJECTS.find(p => p.id === projectId) || MOCK_PROJECTS[0];
  return {
    project: {
      id: proj.id,
      label: proj.label,
      project_root: proj.project_root,
      db_path: proj.db_path,
    },
    goal: {
      title: 'Ship v0.1 kernel + desktop panel MVP',
      success_criteria: '29 MCP tools green; panel renders cockpit; Mode A loop stable',
      vision: 'The ambient project control surface for multi-agent programming',
    },
    leader: proj.leader,
    mode: proj.mode,
    mode_a_phase: proj.mode_a_phase,
    mode_a_plan: proj.mode === 'A' ? {
      plan_id: 'plan-20260515-001',
      steps: [
        { idx: 0, label: 'Scaffold dev web harness', status: 'done' },
        { idx: 1, label: 'Mock IPC bridge with realistic data', status: 'done' },
        { idx: 2, label: 'Iterate on panel CSS + animations', status: 'running' },
        { idx: 3, label: 'Port changes back to Electron', status: 'pending' },
      ],
      created_at: NOW - 30 * MIN,
    } : null,
    active_agents_count: proj.pulse.active_agents,
    autopilot_status: proj.pulse.active_agents > 0
      ? (proj.pulse.pending_escalations > 0 ? 'MENTOR_BLOCKED_NEED_USER' : 'AGENT_WORKING')
      : 'AGENT_IDLE',
    autopilot_reason: proj.pulse.active_agents > 0 ? 'agent_active' : 'no_active_process',
    agents: [
      {
        agent_id: 'cairn-session-abc123def456',
        status: 'ACTIVE',
        capabilities: ['client:mcp-server', 'cwd:D:\\lll\\cairn', 'pid:12345'],
        last_heartbeat: NOW - 12 * SEC,
        registered_at: NOW - 45 * MIN,
      },
      {
        agent_id: 'cairn-session-fedcba654321',
        status: 'ACTIVE',
        capabilities: ['client:mcp-server', 'cwd:D:\\lll\\cairn', 'pid:12399'],
        last_heartbeat: NOW - 3 * SEC,
        registered_at: NOW - 20 * MIN,
      },
    ],
    sessions: [
      {
        agent_id: 'cairn-session-abc123def456',
        display_name: 'cairn-session-abc123',
        state: 'working',
        status: 'ACTIVE',
        last_heartbeat_ts: NOW - 12 * SEC,
        last_heartbeat: NOW - 12 * SEC,
        task_count: 2,
        current_task: { intent: 'Iterate on panel CSS + animations', state: 'RUNNING' },
        latest_task: 'Iterate on panel CSS + animations',
      },
      {
        agent_id: 'cairn-session-fedcba654321',
        display_name: 'cairn-session-fedcba',
        state: 'working',
        status: 'ACTIVE',
        last_heartbeat_ts: NOW - 3 * SEC,
        last_heartbeat: NOW - 3 * SEC,
        task_count: 1,
        current_task: { intent: 'Smoke test Mode A loop', state: 'RUNNING' },
        latest_task: 'Smoke test Mode A loop',
      },
    ],
    lanes: [],
    progress: {
      tasks_total: 5,
      tasks_done: 2,
      tasks_running: 2,
      tasks_blocked: 1,
      tasks_waiting_review: 0,
      percent: 0.4,
    },
    current_task: {
      task_id: 'task-ui-redesign',
      title: 'Iterate on panel CSS + animations',
      status: 'RUNNING',
      agent_id: 'cairn-session-abc123def456',
      created_at: NOW - 15 * MIN,
      updated_at: NOW - 30 * SEC,
    },
    latest_mentor_nudge: {
      text: 'Panel animations looking good. Consider adding transition on tab switch.',
      ts: NOW - 2 * MIN,
    },
    activity: generateActivity(projectId),
    checkpoints: [
      {
        checkpoint_id: 'cp-003',
        agent_id: 'cairn-session-abc123def456',
        label: 'Before CSS animation overhaul',
        created_at: NOW - 10 * MIN,
        stash_ref: 'stash@{0}',
      },
      {
        checkpoint_id: 'cp-002',
        agent_id: 'cairn-session-abc123def456',
        label: 'After kernel tests green',
        created_at: NOW - 40 * MIN,
        stash_ref: 'stash@{1}',
      },
      {
        checkpoint_id: 'cp-001',
        agent_id: 'cairn-session-fedcba654321',
        label: 'Initial scaffold',
        created_at: NOW - 2 * 60 * MIN,
        stash_ref: 'stash@{2}',
      },
    ],
    escalations: [
      {
        id: 'esc-001',
        kind: 'blocker',
        title: 'TLS push failing — need user to run git push manually',
        status: 'PENDING',
        raised_at: NOW - 5 * MIN,
        task_id: 'task-push-fix',
        agent_id: 'cairn-session-abc123def456',
      },
    ],
    todolist: [
      { todo_id: 't1', source: 'mentor_todo', label: 'Auth token expiry edge case — add refresh logic', created_at: NOW - 18 * MIN },
      { todo_id: 't2', source: 'agent_proposal', agent_id: 'cairn-session-abc123def456', label: 'Add rate limiter to dispatch endpoint', task_id: 'task-rl-1', created_at: NOW - 14 * MIN },
      { todo_id: 't3', source: 'mentor_todo', label: 'Integration tests coverage < 60% — add happy-path tests', created_at: NOW - 10 * MIN },
      { todo_id: 't4', source: 'user_todo', label: 'Review PR #42 before EOD', created_at: NOW - 5 * MIN },
      { todo_id: 't5', source: 'agent_proposal', agent_id: 'cairn-session-fedcba654321', label: 'Refactor DB connection pooling', task_id: 'task-db-1', created_at: NOW - 3 * MIN },
    ],
    coordination: {
      scratchpad_count: 12,
      conflict_count: 0,
      dispatch_pending: 1,
    },
    ts: NOW,
  };
}

function generateActivity(projectId) {
  const events = [];
  const kinds = [
    { kind: 'task_created',    icon: '+', detail: 'Implement web dev harness' },
    { kind: 'task_running',    icon: '>', detail: 'Iterate on panel CSS + animations' },
    { kind: 'task_done',       icon: '\u2713', detail: 'Scaffold mock IPC bridge' },
    { kind: 'heartbeat',       icon: '\u2665', detail: 'cairn-session-abc123def456' },
    { kind: 'checkpoint',      icon: '\u25C6', detail: 'Before CSS animation overhaul' },
    { kind: 'dispatch',        icon: '\u2192', detail: 'dispatch to cairn-session-fedcba654321' },
    { kind: 'mentor_nudge',    icon: '\u272A', detail: 'Consider adding transition on tab switch' },
    { kind: 'conflict',        icon: '!', detail: 'panel.css — 2 agents touched same file' },
    { kind: 'blocker_raised',  icon: '\u26A0', detail: 'TLS push failing — need manual push' },
    { kind: 'process_register',icon: '\u25B6', detail: 'cairn-session-fedcba654321 joined' },
    { kind: 'outcome_review',  icon: '\u2691', detail: 'task-scaffold: PASS' },
    { kind: 'scratchpad_write',icon: '\u270E', detail: 'mode_a_plan/proj-cairn updated' },
  ];
  for (let i = 0; i < events.length || i < 20; i++) {
    const e = kinds[i % kinds.length];
    events.push({
      kind: e.kind,
      icon: e.icon,
      detail: e.detail,
      ts: NOW - (i + 1) * 2 * MIN,
      agent_id: i % 2 === 0 ? 'cairn-session-abc123def456' : 'cairn-session-fedcba654321',
    });
    if (events.length >= 20) break;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Mock bridge
// ---------------------------------------------------------------------------

function noop() { return Promise.resolve(null); }
function ok(data) { return Promise.resolve(data != null ? data : { ok: true }); }

window.cairn = {
  // Logging — no-op in dev
  log: () => {},

  // L1 project list
  getProjectsList: () => ok({
    projects: MOCK_PROJECTS.map(p => ({
      id: p.id,
      label: p.label,
      project_root: p.project_root,
      db_path: p.db_path,
      pulse: p.pulse,
      mode: p.mode,
      mode_a_phase: p.mode_a_phase,
    })),
    unassigned: [],
    selected_project_id: MOCK_PROJECTS[0].id,
  }),

  // L2 cockpit
  getCockpitState: (projectId, _opts) => ok(makeCockpitState(projectId)),

  // Session timeline
  getSessionTimeline: (_pid, _aid, _opts) => ok({ events: [] }),

  // Cockpit lanes (Mode B)
  cockpitLaneCreate:  () => ok({ ok: true, lane_id: 'lane-mock-1' }),
  cockpitLaneList:    () => ok([]),
  cockpitLaneAdvance: () => ok({ ok: true }),
  cockpitLanePause:   () => ok({ ok: true }),
  cockpitLaneResume:  () => ok({ ok: true }),

  // Steer / Todo / Rewind
  cockpitSteer:         (input) => { console.log('[mock] steer:', input); return ok({ ok: true }); },
  cockpitTodoAdd:       (input) => { console.log('[mock] todo-add:', input); return ok({ ok: true }); },
  cockpitTodoDispatch:  (input) => { console.log('[mock] todo-dispatch:', input); return ok({ ok: true }); },
  cockpitRewindPreview: () => ok({ checkpoints: [], stash_list: [] }),
  cockpitRewindTo:      () => ok({ ok: true }),
  cockpitAckEscalation: (input) => { console.log('[mock] ack-escalation:', input); return ok({ ok: true }); },

  // Cockpit settings
  getCockpitSettings: () => ok({ mode: 'A', leader: null }),
  setCockpitSettings: (_pid, input) => { console.log('[mock] set-settings:', input); return ok({ ok: true }); },
  cockpitSetMode:     (_pid, mode) => { console.log('[mock] set-mode:', mode); return ok({ ok: true }); },

  // Mode A controls
  modeAShipNow: () => ok({ ok: true, message: '[mock] ship triggered' }),
  modeAStart:   () => ok({ ok: true }),
  modeAStop:    () => ok({ ok: true }),
  modeAReplan:  () => ok({ ok: true }),

  // LLM helpers (return canned strings)
  cockpitSummarizeTail:   () => ok({ summary: '[mock] Last 20 events: 2 tasks done, 1 running, 1 blocker raised.' }),
  cockpitExplainConflict: () => ok({ explanation: '[mock] Two agents edited panel.css simultaneously.' }),
  cockpitSortInbox:       () => ok({ sorted: [] }),
  cockpitAssistGoal:      () => ok({ suggestion: '[mock] Consider breaking down the UI task into smaller pieces.' }),

  // Project CRUD
  selectProject:      () => ok({ ok: true }),
  getSelectedProject: () => ok(MOCK_PROJECTS[0].id),
  addProject:         () => ok({ ok: true, id: 'proj-new-' + Date.now() }),
  removeProject:      () => ok({ ok: true }),
  renameProject:      () => ok({ ok: true }),
  addHint:            () => ok({ ok: true }),
  registerProjectFromCwd: () => ok({ ok: true, project_id: 'proj-auto' }),

  // Goal
  getProjectGoal:   () => ok({
    title: 'Ship v0.1 kernel + desktop panel MVP',
    success_criteria: '29 MCP tools green; panel renders cockpit; Mode A loop stable',
    vision: 'The ambient project control surface for multi-agent programming',
  }),
  setProjectGoal:    (_pid, goal) => { console.log('[mock] set-goal:', goal); return ok({ ok: true }); },
  clearProjectGoal:  () => ok({ ok: true }),

  // Rules
  getProjectRules:          () => ok(null),
  getEffectiveProjectRules: () => ok(null),
  setProjectRules:          () => ok({ ok: true }),
  clearProjectRules:        () => ok({ ok: true }),

  // Goal interpretation
  getGoalInterpretation:     () => ok(null),
  refreshGoalInterpretation: () => ok({ interpretation: '[mock] Focus on panel UX polish.' }),
  getLlmProviderInfo:        () => ok({ provider: 'mock', model: 'mock-v1' }),

  // Summary / pulse (legacy views)
  getProjectSummary: () => ok({
    processes: { active: 2, total: 2 },
    tasks: { total: 5, running: 2, done: 2, blocked: 1 },
    conflicts: { open: 0, total: 1 },
    dispatches: { pending: 1, total: 4 },
    checkpoints: { total: 3 },
  }),
  getProjectPulse: () => ok({
    active_agents: 2,
    latest_heartbeat: NOW - 3 * SEC,
    tasks_running: 2,
    open_conflicts: 0,
  }),
  getProjectSessions: () => ok([]),

  // Tasks
  getTasksList:       () => ok([]),
  getTaskDetail:      () => ok(null),
  getTaskCheckpoints: () => ok([]),

  // Worker reports
  addWorkerReport:    () => ok({ ok: true }),
  listWorkerReports:  () => ok([]),
  clearWorkerReports: () => ok({ ok: true }),

  // Pre-PR gate
  getPrePrGate:    () => ok(null),
  refreshPrePrGate:() => ok({ gate: 'mock' }),

  // Prompt pack
  getPromptPack:      () => ok(null),
  generatePromptPack: () => ok({ prompt: '[mock] Here is your prompt pack...' }),

  // Managed loop
  listManagedProjects:         () => ok([]),
  registerManagedProject:      () => ok({ ok: true }),
  getManagedProjectProfile:    () => ok(null),
  startManagedIteration:       () => ok({ ok: true }),
  generateManagedWorkerPrompt: () => ok({ prompt: '[mock] worker prompt' }),
  attachManagedWorkerReport:   () => ok({ ok: true }),
  collectManagedEvidence:      () => ok({ ok: true }),
  reviewManagedIteration:      () => ok({ verdict: 'PASS' }),
  listManagedIterations:       () => ok([]),

  // Worker launch
  detectWorkerProviders:         () => ok([]),
  launchManagedWorker:           () => ok({ ok: true, run_id: 'run-mock' }),
  getWorkerRun:                  () => ok(null),
  listWorkerRuns:                () => ok([]),
  stopWorkerRun:                 () => ok({ ok: true }),
  tailWorkerRun:                 () => ok({ text: '[mock] worker output...' }),
  extractWorkerReport:           () => ok({ ok: true }),
  extractScoutCandidates:        () => ok({ candidates: [] }),
  pickCandidateAndLaunchWorker:  () => ok({ ok: true }),
  runReviewForCandidate:         () => ok({ ok: true }),
  extractReviewVerdict:          () => ok({ verdict: 'PASS' }),

  // Candidates
  listCandidates:         () => ok([]),
  listCandidatesByStatus: () => ok([]),
  getCandidate:           () => ok(null),
  verifyWorkerBoundary:   () => ok({ ok: true }),

  // Multi-Cairn
  getMultiCairnStatus:         () => ok({ instances: [] }),
  listTeamCandidates:          () => ok([]),
  listMyPublishedCandidateIds: () => ok([]),

  // Mode B continuous
  getContinuousRun:   () => ok(null),
  listContinuousRuns: () => ok([]),

  // Mode A mentor
  listMentorHistory: () => ok([]),
  getMentorEntry:    () => ok(null),
  continueManagedIterationReview: () => ok({ ok: true }),

  // Recovery
  getProjectRecovery: () => ok(null),
  getRecoveryPrompt:  () => ok({ prompt: '[mock] recovery prompt...' }),

  // Coordination
  getProjectScratchpad:   () => ok([]),
  getProjectConflicts:    () => ok([]),
  getCoordinationSignals: () => ok({ signals: [] }),
  getHandoffPrompt:       () => ok({ prompt: '[mock] handoff prompt' }),
  getConflictPrompt:      () => ok({ prompt: '[mock] conflict prompt' }),
  getReviewPrompt:        () => ok({ prompt: '[mock] review prompt' }),

  // Unassigned
  getUnassignedDetail: () => ok({ processes: [], tasks: [], conflicts: [] }),

  // Onboarding
  getOnboardedAt:      () => ok(NOW - 7 * 24 * 60 * MIN),
  markOnboarded:       () => ok({ ok: true }),
  chooseProjectFolder: () => ok(null),

  // Electron-only (no-op in web)
  hidePanel:           () => {},
  openLegacyInspector: () => { console.log('[mock] openLegacyInspector — not available in web'); },
};

console.log('[cairn-dev] mock bridge injected — window.cairn ready');
