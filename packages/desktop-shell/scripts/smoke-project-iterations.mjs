#!/usr/bin/env node
/**
 * Smoke for project-iterations.cjs.
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

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn = safeMtime(realCairnDb);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-iter-smoke-'));
process.env.HOME = tmpDir;
process.env.USERPROFILE = tmpDir;
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const it = require(path.join(root, 'project-iterations.cjs'));

const PID = 'p_smoke_iter';
const r1 = it.startIteration(PID, { goal_id: 'g_aaa' });
ok(r1.ok && r1.iteration.status === 'planned', 'startIteration → planned');
const ID = r1.iteration.id;
ok(/^i_/.test(ID), 'iteration id has i_ prefix');

const r2 = it.attachWorkerPrompt(PID, ID, { id: 'p_xxx', title: 'Round 1 prompt' });
ok(r2.ok && r2.iteration.status === 'worker_prompted', 'attach prompt → worker_prompted');
ok(r2.iteration.worker_prompt_title === 'Round 1 prompt', 'prompt title persisted');

const r3 = it.attachWorkerReport(PID, ID, 'r_yyy');
ok(r3.ok && r3.iteration.status === 'reported' && r3.iteration.worker_report_id === 'r_yyy', 'attach report → reported');

const r4 = it.attachEvidence(PID, ID, { branch: 'main', dirty: true, changed_file_count: 3 });
ok(r4.ok && r4.iteration.status === 'evidence_collected', 'attach evidence → evidence_collected');
ok(r4.iteration.evidence_summary.changed_file_count === 3, 'evidence_summary persisted');

const r5 = it.completeIterationReview(PID, ID,
  { status: 'ready_with_risks' }, 'ready_for_review',
  'Looks good; review and decide.', ['Look at the new file X.'],
);
ok(r5.ok && r5.iteration.status === 'reviewed', 'complete review → reviewed');
ok(r5.iteration.review_status === 'ready_for_review', 'review_status persisted');
ok(r5.iteration.next_attention.length === 1, 'next_attention list persisted');

// Latest snapshot fold.
const list = it.listIterations(PID);
ok(list.length === 1, 'listIterations folds events into single record');
ok(list[0].id === ID && list[0].status === 'reviewed', 'latest fold is the reviewed snapshot');

// Unknown iteration / project gracefully.
ok(!it.patchIteration(PID, 'i_nope', { status: 'reported' }).ok, 'patch unknown id → error');
ok(!it.patchIteration(PID, ID, { status: 'no_such_status' }).ok, 'invalid status rejected');

// Malformed JSONL line is skipped.
const file = it.iterFile(PID);
fs.appendFileSync(file, '{this is not json\n', 'utf8');
const list2 = it.listIterations(PID);
ok(list2.length === 1, 'malformed JSONL line is skipped');

// Multiple iterations sort newest-first.
const r6 = it.startIteration(PID, { goal_id: 'g_bbb' });
ok(r6.ok, 'second iteration starts');
const list3 = it.listIterations(PID);
ok(list3.length === 2 && list3[0].id === r6.iteration.id, 'newest-first sort');

// Read-only invariants.
ok(safeMtime(realCairnDb) === beforeCairn, 'real cairn.db mtime unchanged');

// Source-level: no SQL / no .claude / .codex / no child_process.
const src = fs.readFileSync(path.join(root, 'project-iterations.cjs'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok(!/require\(['"]child_process/.test(code), 'no child_process');
ok(!/cairn\.db/.test(code), 'no cairn.db reference in code');
ok(!/['"]\.claude['"]|['"]\.codex['"]/.test(code), 'no .claude/.codex references in code');

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
