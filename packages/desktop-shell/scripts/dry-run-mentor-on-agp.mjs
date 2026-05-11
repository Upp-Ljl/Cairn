#!/usr/bin/env node
/**
 * Demo dry-run — Mentor on agent-game-platform (real Claude).
 *
 * Headless equivalent of demo-recording-plan.md Segment 2 only.
 * Validates the NEW path: Mentor reading agent-game-platform signals
 * and emitting ranked work items via real LLM.
 *
 * Continuous / Accept / Multi-Cairn segments are already validated by
 * dogfood-real-claude-continuous-iteration / Day 6 / smoke-multi-cairn
 * — no need to re-burn tokens.
 *
 * Boundary:
 *   - agent-game-platform must be clean before AND after
 *   - registry write goes to real ~/.cairn (so future panel sessions
 *     see the registration too — this is intentional)
 *   - mentor-history JSONL gets a new turn (intentional artifact)
 *   - NO modifications to agent-game-platform source tree
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const handlers = require(path.join(root, 'managed-loop-handlers.cjs'));
const mentorHandler = require(path.join(root, 'mentor-handler.cjs'));

const AGP_PATH = 'D:\\lll\\managed-projects\\agent-game-platform';
const PROJECT_ID = 'p_agp_demo_001';
const REGISTRY_PATH = path.join(os.homedir(), '.cairn', 'projects.json');

function gitProbe(args) { return spawnSync('git', args, { cwd: AGP_PATH, encoding: 'utf8' }); }

// ---- Pre-flight ----
console.log('========================================');
console.log('  Demo dry-run — Mentor on agent-game-platform');
console.log('========================================\n');

const preHead   = gitProbe(['rev-parse', 'HEAD']).stdout.trim();
const preStatus = gitProbe(['status', '--short']).stdout;
const preBranch = gitProbe(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
console.log('[pre-flight]');
console.log(`  AGP HEAD:    ${preHead}`);
console.log(`  AGP branch:  ${preBranch}`);
console.log(`  AGP status:  ${preStatus.trim() || '(clean)'}`);
if (preStatus.trim()) {
  console.log('FAIL: agent-game-platform not clean — aborting.');
  process.exit(1);
}

// ---- Step 1: ensure registry entry ----
console.log('\n[1] registry');
let reg;
try { reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); }
catch (_e) { reg = { projects: [] }; }

let existed = reg.projects.find(p => p.id === PROJECT_ID);
if (!existed) {
  reg.projects.push({
    id: PROJECT_ID,
    label: 'agent-game-platform (demo dry-run)',
    project_root: AGP_PATH,
    db_path: '/dev/null',
    agent_id_hints: [],
  });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
  console.log(`  registered ${PROJECT_ID} -> ${AGP_PATH}`);
} else {
  console.log(`  already registered ${PROJECT_ID}`);
}

// Make sure managed-project profile exists too
const regResult = handlers.registerManagedProject(reg, PROJECT_ID, { local_path: AGP_PATH });
console.log(`  managed-project profile: ${regResult.ok ? 'ok' : 'fail:' + regResult.error}`);
if (regResult.ok && regResult.record && regResult.record.profile) {
  const prof = regResult.record.profile;
  console.log(`  detected: pm=${prof.package_manager} langs=${(prof.languages||[]).join(',')}`);
}

// ---- Step 2: provider detection ----
console.log('\n[2] providers');
const provs = handlers.detectWorkerProviders();
const claude = provs.find(p => p.id === 'claude-code');
console.log(`  claude-code available: ${!!(claude && claude.available)} (${claude && claude.resolved_path})`);
if (!claude || !claude.available) {
  console.log('FAIL: claude-code not on PATH.');
  process.exit(1);
}

// ---- Step 3: ask Mentor a real question ----
console.log('\n[3] askMentor (real claude-code, ~2-4 min)');
const t0 = Date.now();
const question = 'Looking at this Next.js + bun game platform, what are the top 2-3 issues to focus on next?';
console.log(`  question: ${question}`);

const askPromise = mentorHandler.askMentor(PROJECT_ID, {
  user_question: question,
  provider: 'claude-code',
  max_items: 3,
});

const result = await askPromise;
const elapsed = Math.round((Date.now() - t0) / 1000);
console.log(`\n[4] result (${elapsed}s)`);
console.log(`  ok: ${result.ok}`);
if (!result.ok) {
  console.log(`  error: ${result.error}`);
  if (result.detail) console.log(`  detail: ${result.detail}`);
  if (result.run_id) console.log(`  run_id: ${result.run_id}`);
} else if (result.refused) {
  console.log(`  refused: ${result.refusal && result.refusal.code} — ${result.refusal && result.refusal.message}`);
} else {
  console.log(`  turn_id: ${result.turn_id}`);
  console.log(`  work_items: ${(result.work_items||[]).length}`);
  console.log(`  meta: ${JSON.stringify(result.meta || {}, null, 2).slice(0, 400)}`);
  console.log('  ---');
  (result.work_items || []).forEach((it, i) => {
    console.log(`  item ${i+1}: [${it.candidate_kind || it.kind || '?'}] ${(it.description||'').slice(0, 120)}`);
    if (it.why)         console.log(`    why: ${(it.why.impact||'').slice(0,100)} (cost=${it.why.cost}/risk=${it.why.risk}/urgency=${it.why.urgency})`);
    if (it.stakeholders)console.log(`    sh:  owner=${it.stakeholders.owner} reviewer=${it.stakeholders.reviewer}`);
    if (it.next_action) console.log(`    next: ${it.next_action}`);
    if (Array.isArray(it.evidence_refs) && it.evidence_refs.length)
      console.log(`    evidence: ${it.evidence_refs.map(r => `[${r.kind}] ${r.ref}`).join(' | ')}`);
    if (it.confidence != null) console.log(`    confidence: ${it.confidence}`);
  });
}

// ---- Step 5: secret-leak sweep on tail.log ----
const runId = result.meta && result.meta.run_id;
if (runId) {
  const tailPath = path.join(os.homedir(), '.cairn', 'worker-runs', runId, 'tail.log');
  if (fs.existsSync(tailPath)) {
    const tail = fs.readFileSync(tailPath, 'utf8');
    const leaks = [
      ['ANTHROPIC_API_KEY', /sk-ant-[A-Za-z0-9_-]{20,}/],
      ['OpenAI sk-',         /\bsk-[A-Za-z0-9]{40,}\b/],
      ['GitHub PAT',         /\bghp_[A-Za-z0-9]{20,}\b/],
      ['Bearer header',      /Bearer\s+[A-Za-z0-9_\-\.]{30,}/],
    ];
    console.log('\n[5] secret-leak sweep on tail.log');
    for (const [name, rx] of leaks) console.log(`  ${rx.test(tail) ? 'LEAK' : 'ok  '} ${name}`);
  }
}

// ---- Step 6: post-flight ----
const postHead   = gitProbe(['rev-parse', 'HEAD']).stdout.trim();
const postStatus = gitProbe(['status', '--short']).stdout;
console.log('\n[6] post-flight');
console.log(`  AGP HEAD:    ${postHead}`);
console.log(`  AGP status:  ${postStatus.trim() || '(clean)'}`);
console.log(`  HEAD unchanged: ${preHead === postHead}`);
console.log(`  Working tree unchanged: ${preStatus === postStatus}`);

console.log('\n========================================');
const allOk = result.ok
  && !result.refused
  && (result.work_items || []).length > 0
  && preHead === postHead
  && preStatus === postStatus;
console.log(`  ${allOk ? 'PASS' : 'NEEDS REVIEW'} — elapsed ${elapsed}s`);
console.log('========================================');
process.exit(allOk ? 0 : 1);
