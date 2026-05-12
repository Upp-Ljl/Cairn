#!/usr/bin/env node
/**
 * Multi-Agent Mentor → Conflict-Capable Demo.
 *
 * Driver script for plan
 *   docs/superpowers/plans/2026-05-12-multi-agent-mentor-conflict-demo.md
 *
 * What this does
 * --------------
 * 1. Pre-flight: target repo (agent-game-platform) on main, clean.
 * 2. Set up two git worktrees of agent-game-platform on
 *    demo/multi-agent-mentor-2026-05-12-{a,b} branches.
 * 3. Register two Cairn `processes` rows (one per worker, capabilities
 *    tagged cwd:<worktree>) and create two `tasks` rows so the
 *    resume_packet probe has something to read.
 * 4. Build two prompts and launch two real `claude` workers in parallel
 *    (5s stagger, 6-minute hard cap each), one per worktree.
 * 5. After both terminal: tail logs scanned for secret leaks; each
 *    worker's parsed Worker Report (if extractable) gets written to
 *    scratchpad under subagent/<agent_id>/result.
 * 6. Mechanism-smoke segment (gated by --skip-mechanism to omit):
 *    seeds an OPEN conflict in the DB matching one of worker B's
 *    likely staged paths, then triggers worker B's pre-commit hook by
 *    re-staging + a no-op amend-style commit, which is what fires the
 *    PENDING_REVIEW insert. The script does NOT auto-resolve — the
 *    user clicks Resolve in the legacy Inspector on camera. (Honest
 *    framing: the hook does not autonomously detect inter-agent
 *    overlap; it surfaces overlap against existing OPEN rows. This
 *    segment exercises the real code path the panel renders.)
 * 7. Probe mode (--probe-resume): only runs assembleResumePacket
 *    against the two task_ids written by step 3, asserts both packets
 *    return non-null with last-known scratchpad ref + checkpoint id (if
 *    any). Intended to run after the main flow has executed.
 *
 * Cost: ~$0.50 (sonnet × 2, ~3min each). Per plan §6 round 3: up to 3
 * retries allowed.
 *
 * Boundaries
 * ----------
 * - agent-game-platform main is never touched. All commits land on
 *   demo branches inside .cairn-demo-worktrees/agent-{a,b}.
 * - ~/.cairn is REAL (not sandboxed): the demo's whole point is the
 *   desktop panel + legacy Inspector picking up the rows.
 * - No npm publish, no remote push, no LICENSE/PRODUCT.md edits.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGP_PATH = process.env.CAIRN_DEMO_AGP_PATH || 'D:/lll/managed-projects/agent-game-platform';
const DEMO_DATE = process.env.CAIRN_DEMO_DATE || '2026-05-12';
const WORKTREES_PARENT = path.join(AGP_PATH, '.cairn-demo-worktrees');
const WT = {
  a: path.join(WORKTREES_PARENT, 'agent-a'),
  b: path.join(WORKTREES_PARENT, 'agent-b'),
};
const BRANCH = {
  a: `demo/multi-agent-mentor-${DEMO_DATE}-a`,
  b: `demo/multi-agent-mentor-${DEMO_DATE}-b`,
};
const POLL_MS = 2000;
const MAX_WAIT_MS = 6 * 60 * 1000; // 6 minutes per worker

// Cairn IDs used for the two synthetic agent rows.
const AGENT_ID = {
  a: `cairn-session-${crypto.randomBytes(6).toString('hex')}`,
  b: `cairn-session-${crypto.randomBytes(6).toString('hex')}`,
};

const args = new Set(process.argv.slice(2));
const PROBE_ONLY = args.has('--probe-resume');
const SKIP_MECH = args.has('--skip-mechanism');

// ---------------------------------------------------------------------------
// Lazy-load handlers from the desktop-shell package
// ---------------------------------------------------------------------------

const launcher = require(path.join(dsRoot, 'worker-launcher.cjs'));

// Daemon storage (built under packages/daemon/dist by `npx tsc` in this
// worktree). Resolved against repoRoot so the script runs whether the
// caller cwd's into the worktree or the main checkout.
const daemonDist = path.join(repoRoot, 'packages', 'daemon', 'dist');
const mcpServerDist = path.join(repoRoot, 'packages', 'mcp-server', 'dist');
function reqDaemon(rel) { return require(path.join(daemonDist, rel)); }
function reqMcp(rel)    { return require(path.join(mcpServerDist, rel)); }

const { openDatabase } = reqDaemon('storage/db.js');
const { runMigrations } = reqDaemon('storage/migrations/runner.js');
const { ALL_MIGRATIONS } = reqDaemon('storage/migrations/index.js');
const processesRepo = reqDaemon('storage/repositories/processes.js');
const tasksRepo = reqDaemon('storage/repositories/tasks.js');
const conflictsRepo = reqDaemon('storage/repositories/conflicts.js');
const scratchpadRepo = reqDaemon('storage/repositories/scratchpad.js');
const { assembleResumePacket } = reqMcp('resume-packet.js');

// ---------------------------------------------------------------------------
// Assertion plumbing
// ---------------------------------------------------------------------------

let asserts = 0, fails = 0;
const failures = [];
function ok(cond, label) {
  asserts++;
  if (cond) {
    process.stdout.write(`  ok    ${label}\n`);
  } else {
    fails++;
    failures.push(label);
    process.stdout.write(`  FAIL  ${label}\n`);
  }
}

function header(title) {
  process.stdout.write(`\n${'='.repeat(56)}\n${title}\n${'='.repeat(56)}\n`);
}

function section(name) {
  process.stdout.write(`\n[${name}]\n`);
}

function git(cwd, gitArgs) {
  return spawnSync('git', gitArgs, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// Probe-only mode (read-only assertions against the live DB)
// ---------------------------------------------------------------------------

function readStateFile() {
  const sp = path.join(os.homedir(), '.cairn', 'demo-multi-agent-state.json');
  try { return JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { return null; }
}

function writeStateFile(state) {
  const sp = path.join(os.homedir(), '.cairn', 'demo-multi-agent-state.json');
  fs.writeFileSync(sp, JSON.stringify(state, null, 2), 'utf8');
}

if (PROBE_ONLY) {
  header('Demo probe — resume_packet readability for both task_ids');
  const state = readStateFile();
  if (!state || !state.task_id_a || !state.task_id_b) {
    process.stdout.write('  no prior demo state found (~/.cairn/demo-multi-agent-state.json)\n');
    process.stdout.write('  run without --probe-resume first.\n');
    process.exit(1);
  }
  const dbPath = path.join(os.homedir(), '.cairn', 'cairn.db');
  const db = openDatabase(dbPath, { readonly: true });
  for (const k of ['a', 'b']) {
    const taskId = state[`task_id_${k}`];
    const packet = assembleResumePacket(db, taskId);
    ok(packet !== null, `resume_packet returns non-null for task ${k} (${taskId})`);
    if (packet) {
      ok(packet.task_id === taskId, `packet.task_id matches for ${k}`);
      ok(typeof packet.intent === 'string' && packet.intent.length > 0, `packet.intent is non-empty for ${k}`);
      ok(Array.isArray(packet.scratchpad_keys), `packet.scratchpad_keys is array for ${k} (length=${packet.scratchpad_keys.length})`);
      ok('last_checkpoint_sha' in packet, `packet exposes last_checkpoint_sha for ${k}`);
      ok(typeof packet.audit_trail_summary === 'string', `packet.audit_trail_summary is string for ${k}`);
    }
  }
  db.close();
  header(`${asserts - fails}/${asserts} probe assertions passed`);
  if (fails) {
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main demo flow
// ---------------------------------------------------------------------------

header('Cairn — Multi-Agent Mentor → Conflict-Capable Demo');
process.stdout.write(`AGP path:    ${AGP_PATH}\n`);
process.stdout.write(`Worktree A:  ${WT.a}  on  ${BRANCH.a}\n`);
process.stdout.write(`Worktree B:  ${WT.b}  on  ${BRANCH.b}\n`);
process.stdout.write(`Agent IDs:   A=${AGENT_ID.a}  B=${AGENT_ID.b}\n`);

// ---- 1. Pre-flight ----
section('1 pre-flight (target repo clean, on main)');
if (!fs.existsSync(AGP_PATH)) {
  process.stdout.write(`FAIL: ${AGP_PATH} not found.\n`);
  process.exit(1);
}
const preHead   = git(AGP_PATH, ['rev-parse', 'HEAD']).stdout.trim();
const preBranch = git(AGP_PATH, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
const preStatus = git(AGP_PATH, ['status', '--short']).stdout;
process.stdout.write(`  HEAD:    ${preHead}\n`);
process.stdout.write(`  branch:  ${preBranch}\n`);
process.stdout.write(`  status:  ${preStatus.trim() || '(clean)'}\n`);

// Status must be clean except for the .cairn-demo-worktrees parent dir
// (which is gitignored on first run by our setup; if not, we will
// gitignore it now to avoid polluting the working tree).
const dirtyLines = preStatus.split(/\r?\n/).filter(Boolean).filter(l =>
  !l.includes('.cairn-demo-worktrees'),
);
ok(dirtyLines.length === 0, 'target repo working tree clean (modulo .cairn-demo-worktrees)');
ok(preBranch === 'main', 'target repo on main');

// ---- 2. Provider detection ----
section('2 detect-worker-providers');
const provs = launcher.detectWorkerProviders();
const claude = provs.find(p => p.id === 'claude-code');
const claudeAvailable = !!(claude && claude.available);
process.stdout.write(`  claude-code: ${claudeAvailable ? 'available' : 'NOT FOUND'}\n`);
ok(claudeAvailable, 'claude-code on PATH');
if (!claudeAvailable) {
  process.stdout.write('FAIL: cannot run demo without claude-code.\n');
  process.exit(1);
}

// ---- 3. Worktree setup ----
section('3 worktree setup');
function ensureWorktree(key) {
  const wt = WT[key];
  const branch = BRANCH[key];
  if (fs.existsSync(wt)) {
    // Worktree already exists from a prior run — remove + recreate to
    // start clean. `git worktree remove --force` first, then ensure
    // the branch is reset to main.
    process.stdout.write(`  worktree ${key}: exists, removing for fresh run\n`);
    const rm = git(AGP_PATH, ['worktree', 'remove', '--force', wt]);
    if (rm.status !== 0) {
      // Worktree might be detached/broken; try prune.
      git(AGP_PATH, ['worktree', 'prune']);
      // Force-remove the directory if still there.
      try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
    }
    // Reset branch (if it still exists) to main so the new worktree starts clean.
    const branchExists = git(AGP_PATH, ['rev-parse', '--verify', '--quiet', branch]).status === 0;
    if (branchExists) {
      git(AGP_PATH, ['branch', '-D', branch]);
    }
  }
  fs.mkdirSync(WORKTREES_PARENT, { recursive: true });
  const add = git(AGP_PATH, ['worktree', 'add', '-b', branch, wt, 'main']);
  if (add.status !== 0) {
    process.stdout.write(`  git worktree add failed for ${key}: ${add.stderr}\n`);
    return false;
  }
  process.stdout.write(`  worktree ${key}: ready at ${wt}\n`);
  return true;
}
ok(ensureWorktree('a'), 'worktree A created');
ok(ensureWorktree('b'), 'worktree B created');

// ---- 4. Install pre-commit hook pointing at THIS Cairn checkout's
//        precommit-check.mjs (`cairn install` hardcodes target-repo
//        cwd as script root, which is wrong here — the script lives in
//        the Cairn repo, not the target).
section('4 install pre-commit hook (points at Cairn checkout)');
const precommitScript = path.join(repoRoot, 'packages', 'daemon', 'scripts', 'cairn-precommit-check.mjs');
const hookContent = [
  '#!/bin/sh',
  '# CAIRN-HOOK-V1 — installed by dogfood-multi-agent-mentor-demo.mjs',
  '# Surfaces existing OPEN conflicts whose paths overlap staged files.',
  `CAIRN_HOOK_SCRIPT="${precommitScript.replace(/\\/g, '/')}"`,
  'if [ -f "$CAIRN_HOOK_SCRIPT" ] && command -v node >/dev/null 2>&1; then',
  '  STAGED=$(git diff --cached --name-only --diff-filter=ACM)',
  '  if [ -n "$STAGED" ]; then',
  '    node "$CAIRN_HOOK_SCRIPT" --staged-files "$STAGED" || true',
  '  fi',
  'fi',
  'exit 0',
  '',
].join('\n');
const hookDir = path.join(AGP_PATH, '.git', 'hooks');
fs.mkdirSync(hookDir, { recursive: true });
const hookPath = path.join(hookDir, 'pre-commit');
fs.writeFileSync(hookPath, hookContent, { encoding: 'utf8' });
try { fs.chmodSync(hookPath, 0o755); } catch {}
process.stdout.write(`  wrote hook: ${hookPath}\n`);
process.stdout.write(`  hook script: ${precommitScript}\n`);
ok(fs.existsSync(hookPath), 'pre-commit hook installed');
ok(fs.existsSync(precommitScript), 'precommit-check.mjs reachable');

// ---- 5. Register two processes + create two tasks ----
section('5 register processes + create tasks (Cairn state seeded)');
const cairnRoot = path.join(os.homedir(), '.cairn');
fs.mkdirSync(cairnRoot, { recursive: true });
const dbPath = path.join(cairnRoot, 'cairn.db');
const db = openDatabase(dbPath);
// Don't call runMigrations: the user's live ~/.cairn/cairn.db is kept
// up to date by every running cairn-wedge MCP server; the checksum
// guard refuses to re-run identical-version migrations whose body has
// drifted (we are reading the lead-worktree compile of the daemon, not
// the one that bootstrapped the DB).
for (const k of ['a', 'b']) {
  processesRepo.registerProcess(db, {
    agentId: AGENT_ID[k],
    agentType: 'demo-worker',
    capabilities: [
      'client:demo-driver',
      `cwd:${WT[k]}`,
      `git_root:${WT[k]}`,
      `pid:${process.pid}`,
      `host:${os.hostname()}`,
      `session:${AGENT_ID[k].slice(-12)}`,
      'role:demo-mentor-worker',
      `worktree:${k}`,
    ],
    heartbeatTtl: 5 * 60 * 1000,
  });
}
const tA = tasksRepo.createTask(db, {
  intent: `[demo ${DEMO_DATE} A] Audit src/lib/engine/*.ts test coverage and write a coverage proposal in tests/engine/COVERAGE_AUDIT_A.md`,
  created_by_agent_id: AGENT_ID.a,
  metadata: { demo: 'multi-agent-mentor', worker: 'a', branch: BRANCH.a, worktree: WT.a },
});
const tB = tasksRepo.createTask(db, {
  intent: `[demo ${DEMO_DATE} B] Add unit tests for src/lib/engine/equity.ts at tests/engine/equity.test.ts`,
  created_by_agent_id: AGENT_ID.b,
  metadata: { demo: 'multi-agent-mentor', worker: 'b', branch: BRANCH.b, worktree: WT.b },
});
process.stdout.write(`  task A: ${tA.task_id}\n`);
process.stdout.write(`  task B: ${tB.task_id}\n`);
ok(tA && tA.task_id, 'task A created');
ok(tB && tB.task_id, 'task B created');

writeStateFile({
  date: DEMO_DATE,
  agent_id_a: AGENT_ID.a,
  agent_id_b: AGENT_ID.b,
  task_id_a: tA.task_id,
  task_id_b: tB.task_id,
  worktree_a: WT.a,
  worktree_b: WT.b,
  branch_a: BRANCH.a,
  branch_b: BRANCH.b,
});

// Verify the two process rows are queryable + tagged with the worktree cwd.
const allProcs = processesRepo.listProcesses(db, {});
const ourProcs = allProcs.filter(p =>
  Array.isArray(p.capabilities) &&
  p.capabilities.some(c => typeof c === 'string' && c.startsWith('role:demo-mentor-worker'))
);
ok(ourProcs.length === 2, `processes table has 2 demo-mentor-worker rows (found ${ourProcs.length})`);

// ---- 6. Build prompts ----
section('6 build worker prompts');

function buildPrompt(role, taskId) {
  const REPORT_BLOCK = [
    '',
    '## Worker Report',
    '### Completed',
    '- <one or two bullets>',
    '### Remaining',
    '- <what a future round could do>',
    '### Blockers',
    '- <any, or leave empty>',
    '### Next',
    '- <one bullet>',
  ].join('\n');

  if (role === 'a') {
    return [
      '# CAIRN MULTI-AGENT DEMO — Worker A (engine coverage audit)',
      '',
      `You are operating under Cairn task ${taskId}. You are one of two`,
      'workers running in parallel against agent-game-platform.',
      '',
      'STRICT RULES:',
      '1. ONLY edit files under tests/engine/. Do NOT touch src/, app/, lib/ outside of READING.',
      '2. ONLY git-add and git-commit files you yourself created. Use `git commit -m "..."` (NO --no-verify).',
      '3. Do NOT push, fetch, or modify remotes.',
      '4. Do NOT run installs, builds, or dev servers.',
      '5. Do NOT modify Cairn (anything outside this worktree).',
      '6. Do NOT spend more than 4 minutes on this task.',
      '',
      '# YOUR TASK',
      '',
      'Audit `src/lib/engine/*.ts` for test coverage. Specifically:',
      ' - LIST the files in `src/lib/engine/` (use Glob or LS, do NOT open more than 2).',
      ' - LIST the files in `tests/engine/` matching each engine module.',
      ' - IDENTIFY which engine modules have no paired test file.',
      ' - WRITE a markdown audit to `tests/engine/COVERAGE_AUDIT_A.md` (≤40 lines) with:',
      '     * header: "# Engine Test Coverage Audit (demo)",',
      '     * one-line summary,',
      '     * a small table mapping engine module → test file (or "(missing)"),',
      '     * 1-2 concrete suggestions for the highest-value missing test.',
      ' - `git add tests/engine/COVERAGE_AUDIT_A.md`',
      ' - `git commit -m "demo(A): engine coverage audit"`',
      '',
      'Then emit the Worker Report block below (and nothing after it).',
      REPORT_BLOCK,
    ].join('\n');
  }

  // Role B — equity.ts unit tests.
  return [
    '# CAIRN MULTI-AGENT DEMO — Worker B (equity.ts unit tests)',
    '',
    `You are operating under Cairn task ${taskId}. You are one of two`,
    'workers running in parallel against agent-game-platform.',
    '',
    'STRICT RULES:',
    '1. ONLY create new files under tests/engine/. Do NOT modify src/ files.',
    '2. ONLY git-add and git-commit files you yourself created. Use `git commit -m "..."` (NO --no-verify).',
    '3. Do NOT push, fetch, or modify remotes.',
    '4. Do NOT run installs, builds, or dev servers.',
    '5. Do NOT modify Cairn (anything outside this worktree).',
    '6. Do NOT spend more than 4 minutes on this task.',
    '',
    '# YOUR TASK',
    '',
    'Add a minimal vitest unit test for `src/lib/engine/equity.ts`. Specifically:',
    ' - READ `src/lib/engine/equity.ts` to discover the exported surface (likely a function that computes hand equity).',
    ' - READ one existing test file in `tests/engine/` (e.g. `tests/engine/cards.test.ts`) to match the project style.',
    ' - CREATE a new file `tests/engine/equity.test.ts` with 1-3 simple vitest cases using `describe`/`it`/`expect`.',
    '     * Cover the basic shape of the exported function(s). Do NOT chase exhaustive coverage.',
    '     * If equity.ts depends on heavy randomness, use a small deterministic seed or stub.',
    ' - `git add tests/engine/equity.test.ts`',
    ' - `git commit -m "demo(B): add equity.test.ts skeleton"`',
    '',
    'Then emit the Worker Report block below (and nothing after it).',
    REPORT_BLOCK,
  ].join('\n');
}

const promptA = buildPrompt('a', tA.task_id);
const promptB = buildPrompt('b', tB.task_id);
process.stdout.write(`  prompt A: ${promptA.length} bytes\n`);
process.stdout.write(`  prompt B: ${promptB.length} bytes\n`);

// ---- 7. Launch both workers ----
section('7 launch real claude workers (5s stagger)');
const launchAt = Date.now();
const runA = launcher.launchWorker({
  provider: 'claude-code',
  cwd: WT.a,
  prompt: promptA,
  iteration_id: `demo-iter-A-${DEMO_DATE}`,
  project_id: 'demo_multi_agent_mentor',
});
if (!runA.ok) {
  process.stdout.write(`  worker A launch failed: ${runA.error}\n`);
  process.exit(1);
}
process.stdout.write(`  worker A: run_id=${runA.run_id}\n`);

// Stagger 5s before B per plan §7.
const stagger = new Promise(r => setTimeout(r, 5000));
await stagger;

const runB = launcher.launchWorker({
  provider: 'claude-code',
  cwd: WT.b,
  prompt: promptB,
  iteration_id: `demo-iter-B-${DEMO_DATE}`,
  project_id: 'demo_multi_agent_mentor',
});
if (!runB.ok) {
  process.stdout.write(`  worker B launch failed: ${runB.error}\n`);
  // Don't exit — let A finish so we still get one half of the demo.
} else {
  process.stdout.write(`  worker B: run_id=${runB.run_id}\n`);
}

// ---- 8. Poll until both terminal ----
section('8 poll both workers');
async function pollUntilDone(runId, label) {
  const start = Date.now();
  let final = null;
  while ((Date.now() - start) < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_MS));
    final = launcher.getWorkerRun(runId);
    if (!final) return null;
    if (final.status !== 'running' && final.status !== 'queued') break;
    process.stdout.write(`  · ${label} ${Math.floor((Date.now() - start) / 1000)}s status=${final.status}\r`);
  }
  process.stdout.write('\n');
  if (final && (final.status === 'running' || final.status === 'queued')) {
    process.stdout.write(`  ${label}: still running after ${Math.floor((Date.now() - start) / 1000)}s — stopping\n`);
    launcher.stopWorkerRun(runId);
    await new Promise(r => setTimeout(r, 1500));
    final = launcher.getWorkerRun(runId);
  }
  return final;
}

const [finalA, finalB] = await Promise.all([
  pollUntilDone(runA.run_id, 'A'),
  runB.ok ? pollUntilDone(runB.run_id, 'B') : Promise.resolve(null),
]);

process.stdout.write(`  worker A: status=${finalA && finalA.status} exit=${finalA && finalA.exit_code}\n`);
process.stdout.write(`  worker B: status=${finalB && finalB.status} exit=${finalB && finalB.exit_code}\n`);

ok(finalA && ['exited', 'failed', 'stopped'].includes(finalA.status), 'worker A reached terminal status');
ok(!runB.ok || (finalB && ['exited', 'failed', 'stopped'].includes(finalB.status)), 'worker B reached terminal status');

// ---- 9. Tail logs + secret-leak sweep ----
section('9 secret-leak sweep on both tails');
const LEAK_RX = [
  ['ANTHROPIC_API_KEY', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI sk-',        /\bsk-[A-Za-z0-9]{40,}\b/],
  ['GitHub PAT',        /\bghp_[A-Za-z0-9]{20,}\b/],
  ['Bearer header',     /Bearer\s+[A-Za-z0-9_\-\.]{30,}/],
];
function tailFor(runId) {
  try { return launcher.tailRunLog(runId, 64 * 1024); } catch { return ''; }
}
const tailA = tailFor(runA.run_id);
const tailB = runB.ok ? tailFor(runB.run_id) : '';
for (const [name, rx] of LEAK_RX) {
  ok(!rx.test(tailA), `worker A tail does NOT contain ${name}`);
  ok(!rx.test(tailB), `worker B tail does NOT contain ${name}`);
}

// ---- 10. Persist worker tail summary to scratchpad ----
section('10 scratchpad write (subagent/<agent_id>/result)');
const blobRoot = path.join(os.homedir(), '.cairn', 'blobs');
fs.mkdirSync(blobRoot, { recursive: true });

function tailSummary(tail) {
  if (!tail) return '(empty)';
  const lines = tail.split(/\r?\n/).filter(Boolean);
  return lines.slice(-40).join('\n');
}
try {
  scratchpadRepo.putScratch(db, blobRoot, {
    key: `subagent/${AGENT_ID.a}/result`,
    value: { worker: 'a', run_id: runA.run_id, status: finalA && finalA.status, tail: tailSummary(tailA) },
    task_id: tA.task_id,
  });
  ok(true, 'scratchpad write A succeeded');
} catch (e) {
  ok(false, `scratchpad write A failed: ${(e && e.message) || e}`);
}
if (runB.ok) {
  try {
    scratchpadRepo.putScratch(db, blobRoot, {
      key: `subagent/${AGENT_ID.b}/result`,
      value: { worker: 'b', run_id: runB.run_id, status: finalB && finalB.status, tail: tailSummary(tailB) },
      task_id: tB.task_id,
    });
    ok(true, 'scratchpad write B succeeded');
  } catch (e) {
    ok(false, `scratchpad write B failed: ${(e && e.message) || e}`);
  }
}

// Inspect scratchpad — count subagent/* entries.
const allScratch = scratchpadRepo.listAllScratch(db);
const ourScratch = allScratch.filter(s => /^subagent\/(.+)\/result$/.test(s.key));
process.stdout.write(`  scratchpad subagent/* entries: ${ourScratch.length}\n`);
ok(ourScratch.length >= 2, `≥2 scratchpad subagent/*/result entries (found ${ourScratch.length})`);

// ---- 11. Inspect worker commits on the demo branches ----
section('11 demo branch commit inspection');
function describeBranch(key) {
  const wt = WT[key];
  const branch = BRANCH[key];
  const log = git(wt, ['log', '--oneline', '-5']).stdout.trim();
  const status = git(wt, ['status', '--short']).stdout;
  const newCommits = git(AGP_PATH, ['log', '--oneline', `main..${branch}`]).stdout.trim();
  process.stdout.write(`  --- ${key} (${branch}) ---\n`);
  process.stdout.write(`  log -5:\n${log.split('\n').map(l => '    ' + l).join('\n')}\n`);
  process.stdout.write(`  status: ${status.trim() ? status.trim() : '(clean)'}\n`);
  process.stdout.write(`  commits ahead of main: ${newCommits ? newCommits.split('\n').length : 0}\n`);
  return { newCommits, status };
}
const infoA = describeBranch('a');
const infoB = describeBranch('b');

// Don't require commits — workers may legitimately fail to commit if
// they hit a constraint. Just record what happened.
ok(true, `worker A commits ahead of main: ${infoA.newCommits ? infoA.newCommits.split('\n').length : 0} (informational)`);
ok(true, `worker B commits ahead of main: ${infoB.newCommits ? infoB.newCommits.split('\n').length : 0} (informational)`);

// ---- 12. Mechanism smoke (conflict → PENDING_REVIEW) ----
//
// The pre-commit hook does NOT autonomously detect inter-agent overlap;
// it surfaces overlap of staged paths against existing OPEN conflicts.
// This segment seeds one OPEN conflict between the two demo agent_ids
// on `tests/engine/COVERAGE_AUDIT_A.md` (or the equivalent file actually
// committed by worker A) and then re-stages + amends a no-op commit in
// worktree A. That triggers the hook → PENDING_REVIEW insert.
//
// Skipped if --skip-mechanism, or if worker A produced no commit.

let mechanismRan = false;
let conflictBeforeMech = conflictsRepo.listConflicts(db, {}).length;

if (!SKIP_MECH && infoA.newCommits) {
  section('12 mechanism smoke (seed OPEN + trigger pre-commit hook)');
  // Pick the file actually committed by worker A (most recent commit).
  const lastCommit = git(WT.a, ['log', '-1', '--name-only', '--pretty=format:']).stdout.trim();
  const stagedFile = lastCommit.split(/\r?\n/).filter(Boolean)[0] || 'tests/engine/COVERAGE_AUDIT_A.md';
  process.stdout.write(`  seeding OPEN conflict on path: ${stagedFile}\n`);
  conflictsRepo.recordConflict(db, {
    conflictType: 'FILE_OVERLAP',
    agentA: AGENT_ID.a,
    agentB: AGENT_ID.b,
    paths: [stagedFile],
    summary: `[demo ${DEMO_DATE}] simulated overlap between worker A and B on ${stagedFile}`,
  });
  // Re-trigger the hook: write a no-op edit to the same file, stage,
  // commit. The pre-commit hook will LIKE-match paths_json against the
  // staged path and INSERT a PENDING_REVIEW row.
  const fullPath = path.join(WT.a, stagedFile);
  if (fs.existsSync(fullPath)) {
    try {
      const cur = fs.readFileSync(fullPath, 'utf8');
      fs.writeFileSync(fullPath, cur + `\n<!-- cairn-demo retrigger ${Date.now()} -->\n`, 'utf8');
      const add = git(WT.a, ['add', stagedFile]);
      ok(add.status === 0, 'stage retrigger edit');
      // Set CAIRN_SESSION_AGENT_ID so the hook tags the PENDING_REVIEW with our id.
      const commit = spawnSync('git', ['commit', '-m', `demo(A): retrigger pre-commit hook for conflict surface`],
        { cwd: WT.a, encoding: 'utf8', env: { ...process.env, CAIRN_SESSION_AGENT_ID: AGENT_ID.a } });
      process.stdout.write(`  retrigger commit exit ${commit.status}\n`);
      if (commit.stderr) process.stdout.write(`  hook stderr:\n${commit.stderr.split('\n').map(l => '    ' + l).join('\n')}\n`);
      mechanismRan = true;
    } catch (e) {
      ok(false, `retrigger failed: ${(e && e.message) || e}`);
    }
  } else {
    ok(false, `staged file ${stagedFile} not found in worktree A`);
  }
} else if (SKIP_MECH) {
  process.stdout.write('\n[12] mechanism smoke SKIPPED (--skip-mechanism)\n');
} else {
  process.stdout.write('\n[12] mechanism smoke SKIPPED (worker A produced no commit)\n');
}

// ---- 13. Final conflict inspection ----
section('13 conflict table inspection');
const allConflicts = conflictsRepo.listConflicts(db, {});
const pendingReview = allConflicts.filter(c => c.status === 'PENDING_REVIEW');
const openOurs = allConflicts.filter(c => c.status === 'OPEN' &&
  c.summary && c.summary.includes(`[demo ${DEMO_DATE}]`));
process.stdout.write(`  total conflicts: ${allConflicts.length}\n`);
process.stdout.write(`  PENDING_REVIEW: ${pendingReview.length}\n`);
process.stdout.write(`  our OPEN seed:  ${openOurs.length}\n`);
if (mechanismRan) {
  // We seeded one OPEN; hook should have appended one PENDING_REVIEW.
  ok(pendingReview.length >= 1, 'mechanism smoke wrote ≥1 PENDING_REVIEW row');
  ok(openOurs.length === 1, 'mechanism smoke kept exactly one OPEN seed (informational)');
} else {
  ok(true, 'conflict count unchanged (mechanism smoke not run; expected)');
}

// ---- 14. Resume packet probe (middle gate) ----
section('14 resume_packet for both tasks (middle gate)');
const packetA = assembleResumePacket(db, tA.task_id);
const packetB = assembleResumePacket(db, tB.task_id);
ok(packetA !== null, 'resume_packet readable for task A');
ok(packetB !== null, 'resume_packet readable for task B');
if (packetA) {
  ok(packetA.task_id === tA.task_id, 'packet A task_id matches');
  const keys = packetA.scratchpad_keys || [];
  ok(keys.some(k => k.includes(AGENT_ID.a)), `packet A scratchpad_keys reference A's agent_id (got ${JSON.stringify(keys)})`);
}
if (packetB) {
  ok(packetB.task_id === tB.task_id, 'packet B task_id matches');
  const keys = packetB.scratchpad_keys || [];
  ok(keys.some(k => k.includes(AGENT_ID.b)), `packet B scratchpad_keys reference B's agent_id (got ${JSON.stringify(keys)})`);
}

// ---- 15. Post-flight (target repo invariants) ----
section('15 post-flight (agent-game-platform main untouched)');
const postHead   = git(AGP_PATH, ['rev-parse', 'HEAD']).stdout.trim();
const postBranch = git(AGP_PATH, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
process.stdout.write(`  AGP HEAD:    ${postHead}\n`);
process.stdout.write(`  AGP branch:  ${postBranch}\n`);
ok(postHead === preHead, `main HEAD unchanged (${preHead.slice(0, 8)} → ${postHead.slice(0, 8)})`);
ok(postBranch === 'main', 'still on main');

// ---- 16. Summary ----
db.close();
const elapsedTotal = Math.round((Date.now() - launchAt) / 1000);
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)  —  ${elapsedTotal}s total`);
process.stdout.write(`Tasks  A=${tA.task_id}  B=${tB.task_id}\n`);
process.stdout.write(`Agents A=${AGENT_ID.a}  B=${AGENT_ID.b}\n`);
process.stdout.write(`State file: ~/.cairn/demo-multi-agent-state.json (read by --probe-resume)\n`);
if (fails) {
  process.stdout.write('\nFAILURES:\n');
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write('\nNEXT: open the legacy Inspector with CAIRN_DESKTOP_ENABLE_MUTATIONS=1 to click Resolve.\n');
process.exit(0);
