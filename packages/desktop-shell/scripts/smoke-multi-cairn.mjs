#!/usr/bin/env node
/**
 * Smoke for Multi-Cairn v0 — read-only sharing via a shared dir.
 *
 * Two simulated nodes (A, B):
 *   - each has its own sandboxed HOME (so their ~/.cairn/ JSONLs are
 *     independent)
 *   - both point at the SAME CAIRN_SHARED_DIR
 *   - each has a distinct CAIRN_NODE_ID, passed via the opts.env hook
 *     (the same hook handlers use; equivalent to two real processes
 *     with different env)
 *
 * Verifies: cross-node visibility, self-filter, fold-by-(node,
 * candidate), tombstone unpublish, multi-Cairn-disabled fallback,
 * and snapshot privacy (no secret tokens, no diff bytes).
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
const beforeDb = safeMtime(realCairnDb);

// Two sandboxed HOMEs + one shared dir.
const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mc-A-'));
const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mc-B-'));
const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mc-shared-'));
fs.mkdirSync(path.join(homeA, '.cairn', 'project-candidates'), { recursive: true });
fs.mkdirSync(path.join(homeB, '.cairn', 'project-candidates'), { recursive: true });

// candidate JSONL writer that respects per-node HOME — we bypass
// project-candidates.proposeCandidate's os.homedir() lookup by
// passing opts.home into it directly (Day 1 supports this).
const candidates = require(path.join(root, 'project-candidates.cjs'));
const multiCairn = require(path.join(root, 'multi-cairn.cjs'));
const handlers   = require(path.join(root, 'managed-loop-handlers.cjs'));

// Env builders so each node has a stable distinct node_id.
const envA = { CAIRN_SHARED_DIR: sharedDir, CAIRN_NODE_ID: 'node-A-id-aaaa' };
const envB = { CAIRN_SHARED_DIR: sharedDir, CAIRN_NODE_ID: 'node-B-id-bbbb' };
const envDisabled = { /* no CAIRN_SHARED_DIR */ };

const PID = 'p_team_smoke';

console.log('==> Part A: identity + enablement');

ok(multiCairn.isMultiCairnEnabled({ env: envA }) === true,  'isMultiCairnEnabled true when env points at existing dir');
ok(multiCairn.isMultiCairnEnabled({ env: envDisabled }) === false, 'isMultiCairnEnabled false without env');
ok(multiCairn.isMultiCairnEnabled({ env: { CAIRN_SHARED_DIR: '/nope/does/not/exist' } }) === false,
   'isMultiCairnEnabled false when dir does not exist');

ok(multiCairn.getNodeId({ env: envA, home: homeA }) === 'node-A-id-aaaa', 'getNodeId honors env override (A)');
ok(multiCairn.getNodeId({ env: envB, home: homeB }) === 'node-B-id-bbbb', 'getNodeId honors env override (B)');

// Fallback to ~/.cairn/node-id.txt
const homeC = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mc-C-'));
fs.mkdirSync(path.join(homeC, '.cairn'), { recursive: true });
const id1 = multiCairn.getNodeId({ env: {}, home: homeC });
ok(/^[a-f0-9]{12}$/.test(id1), 'fallback generates 12-hex node id');
ok(fs.existsSync(path.join(homeC, '.cairn', 'node-id.txt')),
   'fallback persists ~/.cairn/node-id.txt');
const id2 = multiCairn.getNodeId({ env: {}, home: homeC });
ok(id1 === id2, 'fallback returns the SAME id on a second call (persisted)');

const statusA = handlers.getMultiCairnStatus({ env: envA, home: homeA });
ok(statusA.enabled && statusA.node_id === 'node-A-id-aaaa' && statusA.shared_dir === sharedDir,
   'getMultiCairnStatus returns enabled shape for node A');
const statusDisabled = handlers.getMultiCairnStatus({ env: envDisabled, home: homeC });
ok(statusDisabled.enabled === false && statusDisabled.node_id === null,
   'getMultiCairnStatus returns disabled shape when env unset');

console.log('\n==> Part B: cross-node publish + visibility');

// Node A proposes a candidate locally (under homeA's HOME).
const c_a1 = candidates.proposeCandidate(PID, {
  description: 'A: add coverage for src/foo.ts',
  candidate_kind: 'missing_test',
  source_iteration_id: 'i_A_scout',
  source_run_id: 'wr_A_scout',
}, { home: homeA });
ok(c_a1.ok, 'node A proposes a candidate');

// Node A publishes it.
const pubA1 = handlers.publishCandidateToTeam(PID, c_a1.candidate.id, { env: envA, home: homeA });
ok(pubA1.ok, 'A publishes ok');
ok(pubA1.node_id === 'node-A-id-aaaa', 'publish returns A node_id');
ok(pubA1.snapshot.description.includes('add coverage for src/foo.ts'),
   'publish snapshot includes description');

// Node B sees it.
const teamFromB = handlers.listTeamCandidates(PID, { env: envB, home: homeB });
ok(teamFromB.length === 1, 'B sees 1 team candidate');
ok(teamFromB[0].node_id === 'node-A-id-aaaa', 'B sees A as the publisher');
ok(teamFromB[0].candidate_id === c_a1.candidate.id, 'B sees the right candidate_id');
ok(teamFromB[0].snapshot.description.includes('add coverage for src/foo.ts'),
   'B sees the right description');

// Self-filter: A does NOT see its own published candidate.
const teamFromA = handlers.listTeamCandidates(PID, { env: envA, home: homeA });
ok(teamFromA.length === 0, 'A does NOT see its own published candidate (self-filter)');

// Node B proposes + publishes its own candidate.
const c_b1 = candidates.proposeCandidate(PID, {
  description: 'B: doc README quickstart',
  candidate_kind: 'doc',
  source_iteration_id: 'i_B_scout',
  source_run_id: 'wr_B_scout',
}, { home: homeB });
ok(c_b1.ok, 'node B proposes a candidate');
const pubB1 = handlers.publishCandidateToTeam(PID, c_b1.candidate.id, { env: envB, home: homeB });
ok(pubB1.ok, 'B publishes ok');

// Now A sees B's, B still sees A's. Neither sees its own.
const teamFromANow = handlers.listTeamCandidates(PID, { env: envA, home: homeA });
const teamFromBNow = handlers.listTeamCandidates(PID, { env: envB, home: homeB });
ok(teamFromANow.length === 1 && teamFromANow[0].node_id === 'node-B-id-bbbb',
   'A sees only B-published rows (1)');
ok(teamFromBNow.length === 1 && teamFromBNow[0].node_id === 'node-A-id-aaaa',
   'B sees only A-published rows (1)');

console.log('\n==> Part C: fold-by-(node, candidate) on re-publish');

// Status of A's candidate progresses locally (PROPOSED → REJECTED).
candidates.setCandidateStatus(PID, c_a1.candidate.id, 'REJECTED', null, { home: homeA });
// Re-publish with updated snapshot.
const pubA1v2 = handlers.publishCandidateToTeam(PID, c_a1.candidate.id, { env: envA, home: homeA });
ok(pubA1v2.ok, 'A re-publishes (status now REJECTED)');
ok(pubA1v2.snapshot.status === 'REJECTED', 're-publish snapshot reflects new status');

// B sees the NEWER snapshot, not the original — fold-by-key wins.
const teamFromBAfter = handlers.listTeamCandidates(PID, { env: envB, home: homeB });
const rowA = teamFromBAfter.find(r => r.candidate_id === c_a1.candidate.id);
ok(rowA && rowA.snapshot.status === 'REJECTED',
   'B sees the LATEST snapshot (REJECTED, fold-by-(node,candidate))');
// No duplicate row from A — even though the JSONL now has 2 lines for
// this (node, candidate), fold collapses them to one.
const aRows = teamFromBAfter.filter(r => r.node_id === 'node-A-id-aaaa');
ok(aRows.length === 1, 'duplicate publish does NOT produce duplicate rows in list');

console.log('\n==> Part D: unpublish via tombstone');

const unpubA = handlers.unpublishCandidateFromTeam(PID, c_a1.candidate.id, { env: envA, home: homeA });
ok(unpubA.ok, 'A unpublishes ok');
const teamFromBAfterUnpub = handlers.listTeamCandidates(PID, { env: envB, home: homeB });
ok(!teamFromBAfterUnpub.find(r => r.candidate_id === c_a1.candidate.id),
   'B no longer sees A-published candidate after tombstone');
// B's own published rows still there.
ok(teamFromBAfterUnpub.length === 0, 'B sees nothing (A withdrew its only row)');

// listMyPublishedCandidateIds reflects only THIS node's live publishes.
const myAids = Array.from(multiCairn.listMyPublishedCandidateIds(PID, { env: envA, home: homeA }));
ok(myAids.length === 0, 'A: listMyPublishedCandidateIds is empty after unpublish');
const myBids = Array.from(multiCairn.listMyPublishedCandidateIds(PID, { env: envB, home: homeB }));
ok(myBids.length === 1 && myBids[0] === c_b1.candidate.id,
   'B: listMyPublishedCandidateIds includes its live publish');

console.log('\n==> Part E: disabled mode returns multi_cairn_not_enabled');

const e1 = handlers.publishCandidateToTeam(PID, c_a1.candidate.id, { env: envDisabled, home: homeA });
ok(!e1.ok && e1.error === 'multi_cairn_not_enabled', 'publish: multi_cairn_not_enabled');
const e2 = handlers.unpublishCandidateFromTeam(PID, c_a1.candidate.id, { env: envDisabled, home: homeA });
ok(!e2.ok && e2.error === 'multi_cairn_not_enabled', 'unpublish: multi_cairn_not_enabled');
const e3 = handlers.listTeamCandidates(PID, { env: envDisabled, home: homeA });
ok(Array.isArray(e3) && e3.length === 0, 'list: returns [] when disabled (not an error)');
const e4 = handlers.getMultiCairnStatus({ env: envDisabled, home: homeA });
ok(e4.enabled === false && e4.node_id === null, 'status: enabled=false when disabled');

console.log('\n==> Part F: error paths');

// candidate_not_found via publish
const eNF = handlers.publishCandidateToTeam(PID, 'c_no_such', { env: envA, home: homeA });
ok(!eNF.ok && eNF.error === 'candidate_not_found', 'publish: candidate_not_found');

// project_id_mismatch via forged row.
const candFileMis = candidates.candFile('p_mc_mismatch', homeA);
fs.mkdirSync(path.dirname(candFileMis), { recursive: true });
fs.writeFileSync(candFileMis, JSON.stringify({
  id: 'c_forged_mc', project_id: 'p_someone_else',
  source_iteration_id: null, source_run_id: null,
  description: 'forged', candidate_kind: 'doc', status: 'PROPOSED',
  worker_iteration_id: null, review_iteration_id: null,
  boundary_violations: [], created_at: Date.now(), updated_at: Date.now(),
}) + '\n');
const eMis = handlers.publishCandidateToTeam('p_mc_mismatch', 'c_forged_mc', { env: envA, home: homeA });
ok(!eMis.ok && eMis.error === 'project_id_mismatch', 'publish: project_id_mismatch');

// missing inputs
const eNP = handlers.publishCandidateToTeam(null, 'c_x', { env: envA, home: homeA });
ok(!eNP.ok && eNP.error === 'project_id_required', 'publish: project_id_required');
const eNC = handlers.publishCandidateToTeam(PID, null, { env: envA, home: homeA });
ok(!eNC.ok && eNC.error === 'candidate_id_required', 'publish: candidate_id_required');

console.log('\n==> Part G: snapshot privacy + safety');

// Re-publish A's candidate so we have a row to grep.
candidates.setCandidateStatus(PID, c_a1.candidate.id, 'REJECTED', null, { home: homeA }); // already there, ok
// Just inspect the JSONL bytes for anything that looks like a secret.
const outboxText = fs.readFileSync(path.join(sharedDir, 'published-candidates.jsonl'), 'utf8');
ok(!/sk-ant-[A-Za-z0-9_-]{20,}/.test(outboxText), 'outbox does not contain sk-ant-* tokens');
ok(!/\bsk-[A-Za-z0-9]{40,}\b/.test(outboxText),   'outbox does not contain sk-* tokens');
ok(!/\bghp_[A-Za-z0-9]{20,}\b/.test(outboxText),  'outbox does not contain ghp_ tokens');
ok(!/Bearer\s+[A-Za-z0-9_\-\.]{30,}/.test(outboxText), 'outbox has no Bearer headers');
// snapshot must NOT carry worker iteration ids / run ids — those leak
// internal state that's none of teammates' business.
for (const line of outboxText.split(/\r?\n/).filter(Boolean)) {
  const ev = JSON.parse(line);
  ok(!Object.prototype.hasOwnProperty.call(ev.snapshot || {}, 'worker_iteration_id'),
     'outbox snapshot omits worker_iteration_id');
  ok(!Object.prototype.hasOwnProperty.call(ev.snapshot || {}, 'review_iteration_id'),
     'outbox snapshot omits review_iteration_id');
  ok(!Object.prototype.hasOwnProperty.call(ev.snapshot || {}, 'boundary_violations'),
     'outbox snapshot omits boundary_violations');
}

console.log('\n==> Part H: read-only invariants');

ok(safeMtime(realCairnDb) === beforeDb, 'real ~/.cairn/cairn.db mtime unchanged');

const src = fs.readFileSync(path.join(root, 'multi-cairn.cjs'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok(!/require\(['"]better-sqlite3/.test(code), 'multi-cairn.cjs does not load better-sqlite3');
ok(!/require\(['"]electron/.test(code), 'multi-cairn.cjs does not load electron');
ok(!/require\(['"]child_process/.test(code), 'multi-cairn.cjs does not load child_process');

console.log('\n==> Part I: IPC + preload exposure');

const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
ok(main.includes("'get-multi-cairn-status'"), 'main.cjs registers get-multi-cairn-status IPC');
ok(main.includes("'list-team-candidates'"), 'main.cjs registers list-team-candidates IPC');
ok(main.includes("'publish-candidate-to-team'"), 'main.cjs registers publish-candidate-to-team IPC (under MUTATIONS_ENABLED)');
ok(main.includes("'unpublish-candidate-from-team'"), 'main.cjs registers unpublish-candidate-from-team IPC');
const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
ok(/getMultiCairnStatus:\s/.test(preload), 'preload exposes getMultiCairnStatus');
ok(/listTeamCandidates:\s/.test(preload), 'preload exposes listTeamCandidates');
ok(/api\.publishCandidateToTeam\s*=/.test(preload), 'preload gates publishCandidateToTeam under MUTATIONS_ENABLED');
ok(/api\.unpublishCandidateFromTeam\s*=/.test(preload), 'preload gates unpublishCandidateFromTeam under MUTATIONS_ENABLED');

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
