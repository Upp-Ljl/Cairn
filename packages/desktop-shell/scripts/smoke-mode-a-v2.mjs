#!/usr/bin/env node
/**
 * smoke-mode-a-v2.mjs — Mode A v2 state machine + Scout helpers.
 *
 * Tests for the CEO 2026-05-14 reframe:
 *   - registry.setModeAPhase transitions (valid + invalid)
 *   - getCockpitSettings surfaces mode_a.phase
 *   - mode-a-scout: extractPlanGuidance / extractPlanJson / normalizePlan
 *   - mode-a-scout: buildScoutPrompt injects CAIRN.md sections
 *
 * HOME sandbox (registry-pollution lesson).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mode-a-v2-smk-'));
fs.mkdirSync(path.join(_tmpDir, '.cairn'), { recursive: true });
process.env.HOME = _tmpDir;
process.env.USERPROFILE = _tmpDir;
const _mtimeBefore = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
process.on('exit', () => {
  const _mtimeAfter = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
  if (_mtimeBefore !== _mtimeAfter) {
    console.error('FATAL: smoke wrote to REAL ~/.cairn/projects.json');
    process.exit(3);
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const registry = require(path.join(dsRoot, 'registry.cjs'));
const scout = require(path.join(dsRoot, 'mode-a-scout.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-mode-a-v2 (state machine + Scout helpers)');

// ---------------------------------------------------------------------------
section('1 registry: default phase is idle');
let reg = { version: 1, projects: [] };
reg = registry.addProject(reg, { label: 'p1', project_root: '/tmp/p1', leader: 'claude-code' }).reg;
const projectId = reg.projects[0].id;
{
  const cs = registry.getCockpitSettings(reg, projectId);
  ok(cs.mode_a != null && typeof cs.mode_a === 'object', 'cockpit_settings.mode_a is an object');
  ok(cs.mode_a.phase === 'idle', 'default phase = idle');
}

// ---------------------------------------------------------------------------
section('2 registry: setModeAPhase transitions — happy path');
{
  // idle → planning
  let r = registry.setModeAPhase(reg, projectId, 'planning');
  ok(!r.error, 'idle → planning ok');
  reg = r.reg;
  ok(registry.getCockpitSettings(reg, projectId).mode_a.phase === 'planning', 'phase persisted = planning');

  // planning → plan_pending
  r = registry.setModeAPhase(reg, projectId, 'plan_pending');
  ok(!r.error, 'planning → plan_pending ok');
  reg = r.reg;
  ok(registry.getCockpitSettings(reg, projectId).mode_a.phase === 'plan_pending', 'phase = plan_pending');

  // plan_pending → running
  r = registry.setModeAPhase(reg, projectId, 'running');
  ok(!r.error, 'plan_pending → running ok');
  reg = r.reg;
  ok(registry.getCockpitSettings(reg, projectId).mode_a.phase === 'running', 'phase = running');

  // running → paused
  r = registry.setModeAPhase(reg, projectId, 'paused');
  ok(!r.error, 'running → paused ok');
  reg = r.reg;

  // paused → running
  r = registry.setModeAPhase(reg, projectId, 'running');
  ok(!r.error, 'paused → running ok');
  reg = r.reg;

  // running → planning (re-plan from running)
  r = registry.setModeAPhase(reg, projectId, 'planning');
  ok(!r.error, 'running → planning (re-plan) ok');
  reg = r.reg;
}

// ---------------------------------------------------------------------------
section('3 registry: setModeAPhase rejects invalid transitions');
{
  // Force back to plan_pending
  reg = registry.setModeAPhase(reg, projectId, 'plan_pending').reg;
  // plan_pending → paused is NOT allowed (paused is exit-from-running)
  const r1 = registry.setModeAPhase(reg, projectId, 'paused');
  ok(r1.error && /invalid_phase_transition/.test(r1.error), 'plan_pending → paused rejected');
  // Unknown phase
  const r2 = registry.setModeAPhase(reg, projectId, 'banana');
  ok(r2.error && /unknown_mode_a_phase/.test(r2.error), 'unknown phase rejected');
  // No-op same phase
  const r3 = registry.setModeAPhase(reg, projectId, 'plan_pending');
  ok(!r3.error, 'same-phase no-op accepted');
}

// ---------------------------------------------------------------------------
section('4 registry: A→B flips phase to idle automatically');
{
  reg = registry.setModeAPhase(reg, projectId, 'running').reg;
  // setCockpitSettings({mode:'A'}) ... but cur already A; switch B first
  reg = registry.setCockpitSettings(reg, projectId, { mode: 'A' }).reg; // no-op
  const before = registry.getCockpitSettings(reg, projectId).mode_a.phase;
  ok(before === 'running', 'precondition: phase running');
  const r = registry.setCockpitSettings(reg, projectId, { mode: 'B' });
  ok(!r.error, 'A→B accepted');
  reg = r.reg;
  ok(registry.getCockpitSettings(reg, projectId).mode_a.phase === 'idle', 'A→B auto-resets phase to idle');
}

// ---------------------------------------------------------------------------
section('5 scout: extractPlanGuidance extracts 3 sections case-insensitively');
{
  const md = `
# Project
some text
## Plan Shape
Short steps, no UI changes.
## Plan Hard Constraints
- never push --force
## Plan Authority
- merging to main
extra
## Other
ignored
`;
  const g = scout._extractPlanGuidance(md);
  ok(g.shape.includes('Short steps'), 'extracted Plan Shape');
  ok(g.constraints.includes('--force'), 'extracted Plan Hard Constraints');
  ok(g.authority.includes('merging to main'), 'extracted Plan Authority');
  ok(g.found_any === true, 'found_any flag set');
}

section('6 scout: extractPlanGuidance handles missing sections');
{
  const g = scout._extractPlanGuidance('# nothing\nrandom text\n');
  ok(g.shape === '' && g.constraints === '' && g.authority === '', 'missing sections → empty strings');
  ok(g.found_any === false, 'found_any = false');
  // Non-string / empty input
  const g2 = scout._extractPlanGuidance('');
  ok(g2.found_any === false, 'empty string ok');
  const g3 = scout._extractPlanGuidance(null);
  ok(g3.found_any === false, 'null ok');
}

section('7 scout: extractPlanJson — fenced block');
{
  const text = 'prose before\n```json\n{"plan_id":"p1","steps":[{"label":"a"}]}\n```\nprose after';
  const obj = scout._extractPlanJson(text);
  ok(obj && obj.plan_id === 'p1', 'extracted fenced JSON');
  ok(Array.isArray(obj.steps) && obj.steps.length === 1, '1 step');
}

section('8 scout: extractPlanJson — bare object fallback');
{
  const text = 'no fence: {"plan_id":"x","steps":[{"label":"y"}]} done';
  const obj = scout._extractPlanJson(text);
  ok(obj && obj.plan_id === 'x', 'bare object extracted');
}

section('9 scout: extractPlanJson — refuses malformed / non-plan objects');
{
  ok(scout._extractPlanJson('') === null, 'empty text → null');
  ok(scout._extractPlanJson(null) === null, 'null → null');
  ok(scout._extractPlanJson('```json\n{not valid}\n```') === null, 'malformed JSON → null');
  ok(scout._extractPlanJson('```json\n{"foo": 1}\n```') === null, 'JSON without steps → null');
}

section('10 scout: normalizePlan — sanitizes + caps');
{
  const raw = {
    plan_id: 'p1',
    steps: [
      { label: '  step a  ' },
      { label: '' },         // skip
      { label: '  ' },       // skip
      { label: null },       // skip
      { not_a_step: true },  // skip
      { label: 'step b', rationale: 'why', needs_user_confirm: true },
    ],
  };
  const plan = scout._normalizePlan(raw, { goal: { id: 'g1', title: 'G' } });
  ok(plan != null, 'normalizePlan returned');
  ok(plan.steps.length === 2, '2 valid steps survived');
  ok(plan.steps[0].label === 'step a', 'step trimmed');
  ok(plan.steps[0].state === 'PENDING', 'starts PENDING');
  ok(plan.steps[1].needs_user_confirm === true, 'needs_user_confirm preserved');
  ok(plan.goal_id === 'g1', 'goal_id propagated');
  ok(plan.goal_title === 'G', 'goal_title propagated');
  ok(plan.drafted_by === 'scout', 'drafted_by = scout');
}

section('11 scout: normalizePlan returns null on empty steps');
{
  ok(scout._normalizePlan({}, {}) == null, 'no steps → null');
  ok(scout._normalizePlan({ steps: [{ label: '' }, { label: null }] }, {}) == null, 'all invalid → null');
}

section('12 scout: normalizePlan caps at SCOUT_MAX_STEPS');
{
  const many = { steps: Array.from({ length: 30 }, (_, i) => ({ label: 'step ' + i })) };
  const plan = scout._normalizePlan(many, {});
  ok(plan && plan.steps.length === 12, 'capped at 12 (got ' + (plan && plan.steps.length) + ')');
}

section('13 scout: buildScoutPrompt embeds goal + CAIRN.md guidance');
{
  const prompt = scout._buildScoutPrompt({
    goal: { title: 'Ship X', success_criteria: ['a', 'b'], non_goals: ['nope'] },
    projectRoot: '/tmp/p',
    projectId: 'p_abc',
    guidance: { shape: 'Be short', constraints: 'No --force', authority: 'releases', found_any: true },
  });
  ok(prompt.includes('Ship X'), 'goal title in prompt');
  ok(prompt.includes('- a'), 'criterion 1 in prompt');
  ok(prompt.includes('- nope'), 'non_goal in prompt');
  ok(prompt.includes('### Plan Shape'), 'Plan Shape section in prompt');
  ok(prompt.includes('Be short'), 'shape body in prompt');
  ok(prompt.includes('No --force'), 'constraints body in prompt');
  ok(prompt.includes('plan_id'), 'output schema in prompt');
  ok(prompt.includes('p_abc'), 'project_id in prompt');
  // MiniMax-era: prompt says "you are mentor, not execution agent"
  ok(/plan mentor/i.test(prompt), 'role = plan mentor (not execution)');
  ok(prompt.includes('milestone'), 'mentions milestone-level scope');
  ok(prompt.includes('CC'), 'mentions CC will pick up steps');
}

section('14 scout: buildScoutPrompt without CAIRN.md falls back to default note');
{
  const prompt = scout._buildScoutPrompt({
    goal: 'simple string goal',
    projectRoot: '/tmp/p',
    projectId: 'p_xyz',
    guidance: { shape: '', constraints: '', authority: '', found_any: false },
  });
  ok(prompt.includes('No `## Plan Shape`'), 'fallback note rendered');
  ok(prompt.includes('simple string goal'), 'string goal in prompt');
}

section('15 scout: runScout uses injected chatImpl (no real LLM call)');
{
  // Mock chatJson that returns a known plan
  const mockChat = async () => ({
    enabled: true,
    ok: true,
    model: 'mock-mentor',
    text: '```json\n{"plan_id":"mock_1","rationale":"mock","steps":[{"label":"step a"},{"label":"step b","needs_user_confirm":true}]}\n```',
  });
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-runscout-'));
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# Hi\nProject docs.', 'utf8');
  const res = await scout.runScout({
    projectId: 'p_mock',
    projectRoot: projectDir,
    goal: { id: 'g1', title: 'do stuff', success_criteria: ['a', 'b'] },
  }, { home: _tmpDir, chatImpl: mockChat });
  ok(res.ok === true, 'runScout with mock chat returned ok');
  ok(res.plan && res.plan.plan_id === 'mock_1', 'plan_id propagated');
  ok(res.plan.steps.length === 2, '2 steps from mock');
  ok(res.plan.steps[0].label === 'step a', 'first label');
  ok(res.plan.steps[1].needs_user_confirm === true, 'needs_user_confirm preserved');
  ok(res.plan.drafted_by === 'scout', 'tagged drafted_by=scout');
  // Audit dir + meta should exist
  const runJsonPath = path.join(_tmpDir, '.cairn', 'worker-runs', res.run_id, 'run.json');
  ok(fs.existsSync(runJsonPath), 'audit run.json written');
  const meta = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
  ok(meta.provider === 'minimax-mentor', 'meta provider = minimax-mentor (NOT a CC spawn)');
  ok(meta.status === 'exited', 'meta status = exited');
  ok(meta.plan_steps === 2, 'meta plan_steps = 2');
  ok(meta.readme_loaded === true, 'README excerpt was loaded into prompt');
}

section('16 scout: runScout handles llm-disabled gracefully');
{
  const mockDisabled = async () => ({ enabled: false, ok: false, error_code: 'keys_file_missing' });
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-disabled-'));
  const res = await scout.runScout({
    projectId: 'p_disabled',
    projectRoot: projectDir,
    goal: { title: 'x', success_criteria: ['y'] },
  }, { home: _tmpDir, chatImpl: mockDisabled });
  ok(res.ok === false, 'disabled provider → ok:false');
  ok(/llm_disabled/.test(res.error), 'error tagged as llm_disabled (got ' + res.error + ')');
}

section('17 scout: runScout handles non-JSON response gracefully');
{
  const mockGarbage = async () => ({ enabled: true, ok: true, model: 'm', text: 'sorry I cannot' });
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-garbage-'));
  const res = await scout.runScout({
    projectId: 'p_garbage',
    projectRoot: projectDir,
    goal: { title: 'x', success_criteria: ['y'] },
  }, { home: _tmpDir, chatImpl: mockGarbage });
  ok(res.ok === false, 'non-JSON response → ok:false');
  ok(res.error === 'plan_json_not_found', 'error = plan_json_not_found');
  ok(res.response_text === 'sorry I cannot', 'raw text preserved for debug');
}

section('18 scout: NO CC spawn — module does not require child_process');
{
  // Grep mode-a-scout.cjs source: should NOT import or use spawn/exec
  // since MiniMax HTTP replaces the old CC subprocess path.
  const src = fs.readFileSync(path.resolve(dsRoot, 'mode-a-scout.cjs'), 'utf8');
  ok(!/require\(['"]node:child_process['"]\)/.test(src), 'does not require child_process');
  ok(!/\bspawn\s*\(/.test(src), 'no spawn() call');
  ok(!/--output-format/.test(src), 'no claude CLI flags');
  ok(src.includes('llm-client'), 'uses llm-client.cjs (MiniMax)');
}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
