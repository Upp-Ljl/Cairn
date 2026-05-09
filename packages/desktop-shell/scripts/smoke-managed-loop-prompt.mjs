#!/usr/bin/env node
/**
 * Smoke for managed-loop-prompt.cjs adapter — produces a worker
 * prompt that includes managed-project context (commands, repo,
 * branch) on top of the standard goal/rules/non-goals scaffolding.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) { asserts++; if (c) console.log(`  ok    ${l}`); else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); } }

const adapter = require(path.join(root, 'managed-loop-prompt.cjs'));

const managedRecord = {
  project_id: 'p_x',
  repo_url: 'https://github.com/anzy-renlab-ai/agent-game-platform.git',
  local_path: 'D:/lll/managed-projects/agent-game-platform',
  default_branch: 'main',
  profile: {
    package_manager: 'bun',
    languages: ['typescript', 'javascript'],
    test_commands: ['bun run test'],
    build_commands: ['bun run build'],
    lint_commands: ['bun run lint'],
    docs: ['README.md', 'CLAUDE.md'],
  },
};

const input = {
  goal: { title: 'Stabilize agent-game-platform tests', desired_outcome: 'All bun tests pass; no open blockers.' },
  project_rules: {
    coding_standards: ['Follow Next.js conventions.'],
    testing_policy: ['Run bun test before claiming done.'],
    reporting_policy: ['Report completed/remaining/blockers.'],
    pre_pr_checklist: ['No new deps without approval.'],
    non_goals: ['Do not refactor unrelated modules.'],
  },
  project_rules_is_default: false,
  pulse: { pulse_level: 'ok', signals: [] },
  activity_summary: { by_family: { live: 0, recent: 0, inactive: 0 }, total: 0 },
  tasks_summary: { running: 0, blocked: 0, waiting_review: 0, failed: 0 },
  blockers_summary: { open: 0 },
  outcomes_summary: { failed: 0, pending: 0 },
  recent_reports: [],
  pre_pr_gate: { status: 'unknown', checklist: [], rule_log: [] },
};

const out = adapter.generateManagedPrompt(input, {
  managed_record: managedRecord,
  iteration_id: 'i_smoke_001',
  forceDeterministic: true,
});

ok(out.is_managed === true, 'is_managed flag set');
ok(out.managed.project_id === 'p_x', 'managed.project_id propagated');
ok(out.managed.iteration_id === 'i_smoke_001', 'iteration_id propagated');
ok(out.prompt.includes('# Managed project'), 'prompt has Managed project section');
ok(out.prompt.includes('Repo: https://github.com/anzy-renlab-ai/agent-game-platform.git'), 'prompt names repo URL');
ok(out.prompt.includes('agent-game-platform'), 'prompt has local path basename');
ok(out.prompt.includes('Package manager: bun'), 'prompt names package manager');
ok(out.prompt.includes('bun run test'), 'prompt names detected test command');
ok(out.prompt.includes('bun run build'), 'prompt names detected build command');
ok(out.prompt.includes('Default branch: main'), 'default branch surfaced');

// Privacy: don't leak full Windows path with home dir.
ok(!/C:\\Users\\/i.test(out.prompt) && !/c:\\\\users/i.test(out.prompt),
   'prompt does not leak full home path');
ok(!/api[_-]?key|bearer|token/i.test(out.prompt), 'prompt does not include credentials terms');

// Hard floor still present from the underlying pack.
ok(out.prompt.includes('Do not push or merge unless the user explicitly authorizes.'),
   'no-push hard rule preserved');
ok(out.sections.non_goals.length > 0, 'non_goals are non-empty');
ok(out.sections.acceptance_checklist.length >= 3, 'acceptance_checklist has the bedrock');

// No-record fallback: still produces a runnable prompt.
const out2 = adapter.generateManagedPrompt(input, {
  managed_record: null,
  iteration_id: null,
});
ok(out2.prompt.length > 0, 'falls back when no managed record');

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
