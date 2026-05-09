#!/usr/bin/env node
/**
 * Smoke for managed-loop-handlers.cjs — the surface that main.cjs IPC
 * forwards to. Validates every handler returns the shape the panel
 * relies on, and that read-only invariants hold.
 *
 * We test handlers, not Electron IPC, on the principle that IPC is a
 * thin pass-through. The dogfood (dogfood-managed-loop-panel.mjs)
 * then exercises the same handlers against the real cloned repo.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) { asserts++; if (c) console.log(`  ok    ${l}`); else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); } }

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
const realClaude = path.join(os.homedir(), '.claude');
const realCodex = path.join(os.homedir(), '.codex');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const before = { db: safeMtime(realCairnDb), claude: safeMtime(realClaude), codex: safeMtime(realCodex) };

// Sandboxed HOME
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-panel-smoke-'));
process.env.HOME = tmpDir;
process.env.USERPROFILE = tmpDir;
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const handlers = require(path.join(root, 'managed-loop-handlers.cjs'));

// -------- Build a fixture git repo --------

const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-panel-fixture-'));
function git(args) { return spawnSync('git', args, { cwd: fix, encoding: 'utf8' }); }
git(['init']);
git(['config', 'user.email', 'smoke@example.com']);
git(['config', 'user.name', 'Smoke']);
git(['checkout', '-b', 'main']);
fs.writeFileSync(path.join(fix, 'package.json'), JSON.stringify({
  name: 'smoke-fix', scripts: { test: 'jest', build: 'rollup' },
}));
fs.writeFileSync(path.join(fix, 'package-lock.json'), '{}');
fs.writeFileSync(path.join(fix, 'README.md'), '# fix\n');
git(['add', '.']);
git(['commit', '-m', 'initial']);

const PROJECT_ID = 'p_panel_aaa';
const reg = {
  projects: [{
    id: PROJECT_ID,
    label: 'Panel smoke',
    project_root: fix,
    db_path: '/dev/null',
    agent_id_hints: [],
  }],
};

// -------- 1. listManagedProjects on empty dir → []
ok(Array.isArray(handlers.listManagedProjects(reg)), 'listManagedProjects returns array');
ok(handlers.listManagedProjects(reg).length === 0, 'list is empty before register');

// -------- 2. registerManagedProject defaulting local_path from registry
const reg1 = handlers.registerManagedProject(reg, PROJECT_ID, {});
ok(reg1.ok, 'register without explicit local_path defaults to project_root');
ok(reg1.record.local_path === fix, 'default local_path == project_root');
ok(reg1.record.profile && reg1.record.profile.package_manager === 'npm', 'detected package manager');
ok(reg1.record.default_branch === 'main', 'default branch detected');

// -------- 3. getManagedProjectProfile
const rec = handlers.getManagedProjectProfile(PROJECT_ID);
ok(rec && rec.local_path === fix, 'getManagedProjectProfile round-trips');

// -------- 4. listManagedProjects after register
const list = handlers.listManagedProjects(reg);
ok(list.length === 1, 'listManagedProjects sees 1 project after register');
ok(list[0].project_id === PROJECT_ID, 'list entry carries project_id');
ok(list[0].label === 'Panel smoke', 'list entry joined with registry label');

// -------- 5. startManagedIteration
const iterRes = handlers.startManagedIteration(PROJECT_ID, { goal_id: 'g_x' });
ok(iterRes.ok && iterRes.iteration.status === 'planned', 'startManagedIteration ok');
const ITER_ID = iterRes.iteration.id;

// -------- 6. generateManagedWorkerPrompt
const goal = { id: 'g_x', title: 'Smoke goal', desired_outcome: 'pass tests' };
const promptRes = handlers.generateManagedWorkerPrompt(PROJECT_ID, {
  goal,
  project_rules: { non_goals: ['no scope creep'] },
});
ok(promptRes.ok, 'generateManagedWorkerPrompt ok');
ok(promptRes.iteration_id === ITER_ID, 'auto-bound to latest open iteration');
ok(promptRes.result.prompt.includes('# Managed project'), 'prompt has managed section');
ok(promptRes.result.prompt.includes('npm run test'), 'prompt names detected test command');
ok(promptRes.result.prompt.includes('Smoke goal'), 'prompt names goal title');

// -------- 7. attachManagedWorkerReport via free-form text
const attachRes = handlers.attachManagedWorkerReport(PROJECT_ID, {
  text: '# Round 1\nsource: claude-code\n## Completed\n- thing one\n## Remaining\n- thing two\n',
});
ok(attachRes.ok, 'attachManagedWorkerReport ok');
ok(attachRes.report.title === 'Round 1', 'parsed title from free-form text');
ok(attachRes.report.completed.length === 1 && attachRes.report.remaining.length === 1, 'parsed sections');
ok(attachRes.iteration_id === ITER_ID, 'report bound to latest iteration');

// -------- 8. collectManagedEvidence
const evRes = handlers.collectManagedEvidence(PROJECT_ID, {});
ok(evRes.ok, 'collectManagedEvidence ok');
ok(evRes.evidence.branch === 'main', 'evidence branch detected');
ok(evRes.iteration_id === ITER_ID, 'evidence bound to latest iteration');
ok(evRes.summary && evRes.summary.changed_file_count === 0, 'evidence summary clean');

// -------- 9. reviewManagedIteration
const reviewRes = await handlers.reviewManagedIteration(PROJECT_ID, {
  goal,
  pre_pr_gate: { status: 'ready_with_risks', rule_log: [] },
}, { forceDeterministic: true });
ok(reviewRes.ok, 'reviewManagedIteration ok');
ok(['continue', 'ready_for_review', 'blocked', 'needs_evidence', 'unknown'].includes(reviewRes.verdict.status), 'verdict status in closed set');
ok(reviewRes.verdict.status === 'continue', 'verdict.continue when remaining items > 0');
ok(reviewRes.verdict.next_prompt_seed && reviewRes.verdict.next_prompt_seed.length > 0, 'next_prompt_seed produced');

// -------- 10. listManagedIterations after full round
const itersList = handlers.listManagedIterations(PROJECT_ID, 5);
ok(itersList.length === 1, 'one iteration after full round');
ok(itersList[0].status === 'reviewed', 'iteration marked reviewed');
ok(itersList[0].review_status === reviewRes.verdict.status, 'review_status persisted');

// -------- 11. error paths

// register without project_id
ok(!handlers.registerManagedProject(reg, null, {}).ok, 'register rejects missing project_id');
// register on registry-empty project_root
const regEmpty = { projects: [{ id: 'p_unknown', project_root: '(unknown)', db_path: '', agent_id_hints: [] }] };
const e1 = handlers.registerManagedProject(regEmpty, 'p_unknown', {});
ok(!e1.ok && e1.error === 'local_path_required', 'rejects (unknown) project_root');
// review without iteration → no_iteration
const e2 = await handlers.reviewManagedIteration('p_no_such_x', {}, { forceDeterministic: true });
ok(!e2.ok && (e2.error === 'no_iteration' || e2.error === 'iteration_not_found'), 'review without iteration rejects');
// generate prompt for unknown project
const e3 = handlers.generateManagedWorkerPrompt('p_no_such_x', {});
ok(!e3.ok && e3.error === 'managed_project_not_found', 'prompt for unknown project rejected');

// -------- 12. read-only invariants

ok(safeMtime(realCairnDb) === before.db, 'real ~/.cairn/cairn.db mtime unchanged');
// ~/.claude / ~/.codex existence is what we guarantee; mtime can drift
// because Claude Code / Codex CLIs may be running in parallel writing
// their own session logs. The smoke is asserting that *this* code path
// does not create or remove those directories, which is the invariant
// the product cares about.
ok((before.claude === null) === (safeMtime(realClaude) === null), '~/.claude existence unchanged');
ok((before.codex  === null) === (safeMtime(realCodex)  === null), '~/.codex existence unchanged');

// -------- 13. handler module: no SQLite, no Electron, no destructive git

const src = fs.readFileSync(path.join(root, 'managed-loop-handlers.cjs'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok(!/require\(['"]better-sqlite3/.test(code), 'handlers does not load better-sqlite3');
ok(!/require\(['"]electron/.test(code), 'handlers does not load electron');
ok(!/['"]push['"]|['"]checkout['"]|['"]rebase['"]|['"]reset['"]/.test(code), 'no destructive git verbs');
ok(!/cairn\.db/.test(code), 'no cairn.db ref in code');

// -------- 14. preload.cjs exposes the new API names

const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
for (const name of [
  'listManagedProjects', 'registerManagedProject', 'getManagedProjectProfile',
  'startManagedIteration', 'generateManagedWorkerPrompt', 'attachManagedWorkerReport',
  'collectManagedEvidence', 'reviewManagedIteration', 'listManagedIterations',
]) {
  ok(preload.includes(name + ':'), `preload.cjs exposes ${name}`);
}

// -------- 15. main.cjs registers all 9 IPC channels

const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
for (const channel of [
  'list-managed-projects', 'register-managed-project', 'get-managed-project-profile',
  'start-managed-iteration', 'generate-managed-worker-prompt', 'attach-managed-worker-report',
  'collect-managed-evidence', 'review-managed-iteration', 'list-managed-iterations',
]) {
  ok(main.includes(`'${channel}'`), `main.cjs registers ipc '${channel}'`);
}

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
