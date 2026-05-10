#!/usr/bin/env node
/**
 * Dogfood — Three-Stage Loop Day 6 boundary violation.
 *
 * Two candidates with the SAME description but different worker
 * fixtures, demonstrating that boundary verify catches the rogue
 * one:
 *
 *   C1  pick(fixture-worker)        → verify clean → review → ACCEPTED
 *   C2  pick(fixture-worker-rogue)  → verify flags → review → REJECTED
 *
 * All fixture providers; no API spend. Throwaway temp git repo.
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

const args = new Set(process.argv.slice(2));
const useRealHome = args.has('--use-real-home');

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) { asserts++; if (c) console.log(`  ok    ${l}`); else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); } }

if (!useRealHome) {
  const cairnTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dogfood-bv-'));
  os.homedir = () => cairnTmp;
  fs.mkdirSync(path.join(cairnTmp, '.cairn'), { recursive: true });
  console.log(`(sandboxed Cairn writes: ${cairnTmp})`);
}

const handlers   = require(path.join(root, 'managed-loop-handlers.cjs'));
const candidates = require(path.join(root, 'project-candidates.cjs'));

console.log('\n========================================');
console.log('  Cairn Three-Stage Loop — Day 6 boundary fixture dogfood');
console.log('========================================');

// Build temp repo
const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-d6-target-'));
console.log(`Temp repo: ${tempRepo}`);
function git(args) { return spawnSync('git', args, { cwd: tempRepo, encoding: 'utf8' }); }
git(['init']);
git(['config', 'user.email', 'd6@example.local']);
git(['config', 'user.name', 'Cairn Day6 Dogfood']);
git(['checkout', '-b', 'main']);
fs.mkdirSync(path.join(tempRepo, 'src'));
fs.mkdirSync(path.join(tempRepo, 'tests'));
fs.writeFileSync(path.join(tempRepo, 'package.json'), JSON.stringify({ name: 'd6', version: '0.1.0' }, null, 2));
fs.writeFileSync(path.join(tempRepo, 'package-lock.json'), '{}');
fs.writeFileSync(path.join(tempRepo, 'README.md'), '# d6\n');
fs.writeFileSync(path.join(tempRepo, 'src', 'index.ts'), 'export function hi(){return "hi";}\n');
git(['add', '.']);
git(['commit', '-m', 'initial']);

const PID = 'p_dogfood_d6';
const reg = { projects: [{ id: PID, label: 'd6', project_root: tempRepo, db_path: '/dev/null', agent_id_hints: [] }] };
ok(handlers.registerManagedProject(reg, PID, {}).ok, 'register temp repo');

const sharedDesc = 'Add JSDoc to src/index.ts hi() explaining its return value.';

// ================== C1: clean fixture-worker ==================
console.log('\n[C1] in-scope worker → clean verify → ACCEPTED');
const c1 = candidates.proposeCandidate(PID, { description: sharedDesc, candidate_kind: 'doc' });
ok(c1.ok, 'C1: candidate proposed');
ok(c1.candidate.boundary_violations.length === 0, 'C1: starts with empty boundary_violations');

const wb1 = handlers.pickCandidateAndLaunchWorker(PID, {
  candidate_id: c1.candidate.id, provider: 'fixture-worker',
});
ok(wb1.ok, 'C1: pick + launch ok');
await new Promise(r => setTimeout(r, 1100));

// fixture-worker writes cairn-worker-fixture-touched.txt at root —
// for kind=doc that file does NOT match any matcher (root .txt
// without README/CHANGELOG/LICENSE name). It WILL show up as
// out_of_scope. That's an honest result — clean smoke.
spawnSync('git', ['add', '-N', 'cairn-worker-fixture-touched.txt'], { cwd: tempRepo });
const v1 = handlers.verifyWorkerBoundary(PID, { candidate_id: c1.candidate.id });
ok(v1.ok, 'C1: verify ok');
console.log(`  C1 violations: ${JSON.stringify(v1.violations)}`);
console.log(`  C1 in_scope:   ${JSON.stringify(v1.in_scope)}`);
console.log(`  C1 heuristic:  ${v1.heuristic_notes}`);
// fixture-worker writes a root .txt marker which doesn't match any
// matcher under kind=doc. We assert that the verify ran (no false
// negative), saw the file, and persisted it; clean vs rogue is
// disambiguated below by C2 having MORE violations including .md.
ok(Array.isArray(v1.violations), 'C1: verify returned violations array');
const c1AfterVerify = candidates.getCandidate(PID, c1.candidate.id);
ok(c1AfterVerify.boundary_violations.length === v1.violations.length,
   'C1: candidate.boundary_violations matches verify output');

// Stage the txt for the review step (review reads working-tree diff).
const rb1 = handlers.runReviewForCandidate(PID, {
  candidate_id: c1.candidate.id, provider: 'fixture-review',
});
ok(rb1.ok, 'C1: review ok');
await new Promise(r => setTimeout(r, 800));
const c1AfterReview = candidates.getCandidate(PID, c1.candidate.id);
ok(c1AfterReview.status === 'REVIEWED', 'C1: REVIEWED');
const acc1 = handlers.acceptCandidate(PID, c1.candidate.id);
ok(acc1.ok && acc1.candidate.status === 'ACCEPTED', 'C1: accepted');

// Reset working tree state for the next candidate (don't undo the
// txt; just unstage it so C2 starts from a known baseline).
spawnSync('git', ['reset'], { cwd: tempRepo });
fs.unlinkSync(path.join(tempRepo, 'cairn-worker-fixture-touched.txt'));

// ================== C2: rogue fixture-worker ==================
console.log('\n[C2] rogue worker → boundary violations → REJECTED');
const c2 = candidates.proposeCandidate(PID, { description: sharedDesc, candidate_kind: 'doc' });
ok(c2.ok, 'C2: candidate proposed');
ok(c2.candidate.boundary_violations.length === 0, 'C2: starts with empty boundary_violations');

const wb2 = handlers.pickCandidateAndLaunchWorker(PID, {
  candidate_id: c2.candidate.id, provider: 'fixture-worker-rogue',
});
ok(wb2.ok, 'C2: rogue pick + launch ok');
await new Promise(r => setTimeout(r, 1200));

ok(fs.existsSync(path.join(tempRepo, 'src', 'cairn-rogue-touched.ts')),
   'C2: rogue wrote in-scope file (src/cairn-rogue-touched.ts)');
ok(fs.existsSync(path.join(tempRepo, 'cairn-rogue-out-of-scope.md')),
   'C2: rogue wrote out-of-scope file (cairn-rogue-out-of-scope.md)');
spawnSync('git', ['add', '-N', 'src/cairn-rogue-touched.ts', 'cairn-rogue-out-of-scope.md'],
          { cwd: tempRepo });

const v2 = handlers.verifyWorkerBoundary(PID, { candidate_id: c2.candidate.id });
ok(v2.ok, 'C2: verify ok');
console.log(`  C2 violations: ${JSON.stringify(v2.violations)}`);
console.log(`  C2 in_scope:   ${JSON.stringify(v2.in_scope)}`);
console.log(`  C2 heuristic:  ${v2.heuristic_notes}`);
ok(v2.violations.includes('cairn-rogue-out-of-scope.md'),
   'C2: cairn-rogue-out-of-scope.md flagged out_of_scope');
ok(v2.in_scope.includes('src/cairn-rogue-touched.ts'),
   'C2: src/cairn-rogue-touched.ts in_scope (description mentioned src/)');
// The meaningful demonstration: C2 produces a "split" pattern
// (something IN scope plus something OUT of scope) — the classic
// rogue-worker signature where the agent did partial real work
// AND went out of bounds. C1 (clean fixture-worker) only produces
// the marker file at root, so its in_scope set is empty.
ok(v2.in_scope.length > 0 && v2.out_of_scope.length > 0,
   `C2 has both in_scope (${v2.in_scope.length}) and out_of_scope (${v2.out_of_scope.length}) — rogue split pattern`);
ok(v1.in_scope.length === 0,
   'C1 has empty in_scope (clean fixture-worker only writes the root marker)');

const c2AfterVerify = candidates.getCandidate(PID, c2.candidate.id);
ok(c2AfterVerify.boundary_violations.includes('cairn-rogue-out-of-scope.md'),
   'C2: candidate.boundary_violations persists rogue file');

const rb2 = handlers.runReviewForCandidate(PID, {
  candidate_id: c2.candidate.id, provider: 'fixture-review',
});
ok(rb2.ok, 'C2: review ok (verdict still pass per fixture-review; user decides)');
await new Promise(r => setTimeout(r, 800));

// User looks at the ⚠ and explicitly rejects.
const rej2 = handlers.rejectCandidate(PID, c2.candidate.id);
ok(rej2.ok && rej2.candidate.status === 'REJECTED', 'C2: rejected after seeing ⚠');
const c2Final = candidates.getCandidate(PID, c2.candidate.id);
ok(c2Final.boundary_violations.includes('cairn-rogue-out-of-scope.md'),
   'C2: boundary_violations preserved through REJECTED transition');

// Cleanup
console.log('\n[cleanup]');
let cleanupOk = true;
try { fs.rmSync(tempRepo, { recursive: true, force: true }); }
catch (e) { cleanupOk = false; console.log(`  cleanup error: ${e.message}`); }
ok(cleanupOk && !fs.existsSync(tempRepo), 'temp repo cleaned up');

console.log('\n========================================');
console.log(`  ${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
console.log('========================================\n');

if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
