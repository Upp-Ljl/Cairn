#!/usr/bin/env node
/**
 * Partial smoke — Sections A+B+C — for the three leaf mentor modules.
 *
 * Section A: mentor-prompt.cjs     (≥ 15 assertions)
 * Section B: mentor-collect.cjs    (≥ 12 assertions)
 * Section C: mentor-history.cjs    (≥ 12 assertions)
 * Safety:    real cairn.db mtime + no forbidden require()s in source
 *
 * The main session writes smoke-mentor.mjs that combines this with D+E+F+G.
 * Each section is guarded: if its module does not exist yet the section is
 * skipped with [SKIP] and process exits 0 (so a partial impl can still run
 * the sections that ARE present).
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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) {
    console.log(`  ok    ${l}`);
  } else {
    fails++;
    failures.push(l);
    console.log(`  FAIL  ${l}`);
  }
}

// ---------------------------------------------------------------------------
// Snapshot real cairn.db mtime BEFORE any sandbox work.
// ---------------------------------------------------------------------------

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeDb = safeMtime(realCairnDb);

// ---------------------------------------------------------------------------
// Sandboxed HOME — same pattern as smoke-multi-cairn.mjs.
// We monkey-patch os.homedir() so all JSONL helpers that call os.homedir()
// see tmpHome instead of the real home.  We do NOT touch process.env.HOME.
// ---------------------------------------------------------------------------

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mentor-smoke-'));
fs.mkdirSync(path.join(tmpHome, '.cairn'), { recursive: true });
os.homedir = () => tmpHome;

const PID = 'p_mentor_smoke';

// ---------------------------------------------------------------------------
// Helper: build a temp git repo (mirrors smoke-three-stage-actions / dogfood)
// ---------------------------------------------------------------------------

function makeFixtureRepo() {
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mentor-fix-'));
  function git(args) { return spawnSync('git', args, { cwd: fix, encoding: 'utf8' }); }
  git(['init']);
  git(['config', 'user.email', 'mentor-smoke@example.com']);
  git(['config', 'user.name', 'mentor-smoke']);
  git(['checkout', '-b', 'main']);
  fs.writeFileSync(path.join(fix, 'package.json'), JSON.stringify({ name: 'mentor-smoke-fixture', version: '0.0.1' }));
  fs.writeFileSync(path.join(fix, 'README.md'), '# Mentor Smoke Fixture\n\nThis repo is used as a test fixture for mentor-collect smoke.\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial commit for mentor smoke']);
  return fix;
}

// ============================================================================
// SECTION A — generateMentorPrompt
// ============================================================================

console.log('\n==> Section A: mentor-prompt.cjs — generateMentorPrompt');

let mentorPrompt;
try {
  mentorPrompt = require(path.join(root, 'mentor-prompt.cjs'));
} catch (_e) {
  console.log('[SKIP] mentor-prompt.cjs not present yet');
  mentorPrompt = null;
}

if (mentorPrompt) {
  const { generateMentorPrompt, MENTOR_OUTPUT_HEADER } = mentorPrompt;

  // A-1: basic return shape
  const input = {
    user_question: 'what should I work on?',
    signals: {},
    ranked_skeleton: [],
  };
  const opts = { max_items: 5 };
  const result = generateMentorPrompt(input, opts);

  ok(result && typeof result === 'object', 'A-1: returns an object');
  ok(typeof result.prompt_text === 'string' && result.prompt_text.length > 0, 'A-2: prompt_text is a non-empty string');
  ok(result.mode === 'mentor', 'A-3: mode === "mentor"');
  ok(result.max_items === 5, 'A-4: max_items === 5 echoed back');
  ok(result.user_question === 'what should I work on?', 'A-5: user_question echoed back');

  const pt = result.prompt_text;

  // A-6 through A-14: 9 hard rules from spec §5.1
  ok(/NEVER bypass user authorization/i.test(pt) || /bypass.*authorization/i.test(pt),
     'A-6: rule 1 — "NEVER bypass user authorization" present in prompt');
  ok(/auto-merge|auto-push|escalate to human review/i.test(pt),
     'A-7: rule 2 — "auto-merge" OR "auto-push" OR "escalate to human review" present');
  ok(/PRODUCT\.md/i.test(pt) && /governance/i.test(pt),
     'A-8: rule 3 — "PRODUCT.md" AND "governance" present');
  ok(/real human personal names/i.test(pt) || /role \/ kind strings/i.test(pt) || /role\/kind/i.test(pt) || /role or kind/i.test(pt),
     'A-9: rule 4 — "real human personal names" OR "role / kind strings" present');
  ok(/secrets/i.test(pt) && (/\.env/i.test(pt) || /API keys/i.test(pt)),
     'A-10: rule 5 — "secrets" AND (".env" OR "API keys") present');
  ok(/absolute filesystem paths/i.test(pt) || /host fingerprint/i.test(pt),
     'A-11: rule 6 — "absolute filesystem paths" OR "host fingerprint" present');
  ok(/first line/i.test(pt) && /transcripts/i.test(pt),
     'A-12: rule 7 — "first line" AND "transcripts" present');
  ok(/kernel SQLite/i.test(pt) && /mutations/i.test(pt),
     'A-13: rule 8 — "kernel SQLite" AND "mutations" present');
  ok(/team-PM|velocity|sprint|cross-person/i.test(pt),
     'A-14: rule 9 — "team-PM" OR "velocity" OR "sprint" OR "cross-person" present');

  // A-15: output format header
  ok(typeof MENTOR_OUTPUT_HEADER === 'string' && MENTOR_OUTPUT_HEADER === '## Mentor Work Items',
     'A-15: MENTOR_OUTPUT_HEADER exported and equals "## Mentor Work Items"');
  ok(pt.includes(MENTOR_OUTPUT_HEADER),
     'A-16: prompt_text includes MENTOR_OUTPUT_HEADER');

  // A-17, A-18: schema invariants in prompt
  ok(/escalate to human review/.test(pt),
     'A-17: invariant #5 — prompt mentions next_action "escalate to human review"');
  ok(/confidence/i.test(pt) && /[<＜]\s*0\.5/.test(pt),
     'A-18: invariant #4 — prompt mentions "confidence" AND "< 0.5"');

  // A-19, A-20: user_question wrapped verbatim
  ok(pt.includes('<<<USER_QUESTION_START>>>'),
     'A-19: prompt_text contains <<<USER_QUESTION_START>>> wrapper');
  ok(pt.includes('what should I work on?'),
     'A-20: prompt_text contains the verbatim user_question');

  // A-21: missing user_question throws
  let threw = false;
  try { generateMentorPrompt({ signals: {}, ranked_skeleton: [] }, opts); } catch (_e) { threw = true; }
  ok(threw, 'A-21: missing user_question throws');

  // A-22: max_items > 10 clamped to 10
  const r10 = generateMentorPrompt(input, { max_items: 99 });
  ok(r10.max_items === 10, 'A-22: max_items > 10 clamped to 10');

  // A-23: max_items < 1 clamped to 1
  const r1 = generateMentorPrompt(input, { max_items: 0 });
  ok(r1.max_items === 1, 'A-23: max_items < 1 clamped to 1');
}

// ============================================================================
// SECTION B — mentor-collect.cjs — collectMentorSignals
// ============================================================================

console.log('\n==> Section B: mentor-collect.cjs — collectMentorSignals');

let mentorCollect;
try {
  mentorCollect = require(path.join(root, 'mentor-collect.cjs'));
} catch (_e) {
  console.log('[SKIP] mentor-collect.cjs not present yet');
  mentorCollect = null;
}

if (mentorCollect) {
  const { collectMentorSignals } = mentorCollect;
  const candidates = require(path.join(root, 'project-candidates.cjs'));

  const tempRepo = makeFixtureRepo();
  const tmpHome2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mentor-b-home-'));
  fs.mkdirSync(path.join(tmpHome2, '.cairn', 'project-candidates'), { recursive: true });

  // Propose 3 candidates so the JSONL has entries
  candidates.proposeCandidate(PID, { description: 'cand alpha', candidate_kind: 'doc' }, { home: tmpHome2 });
  candidates.proposeCandidate(PID, { description: 'cand beta',  candidate_kind: 'missing_test' }, { home: tmpHome2 });
  candidates.proposeCandidate(PID, { description: 'cand gamma', candidate_kind: 'bug_fix' }, { home: tmpHome2 });

  // B-1: happy path — returns { signals, meta }
  const collected = await collectMentorSignals(PID, {
    project_root: tempRepo,
    home: tmpHome2,
    source_timeout_ms: 2000,
  });

  ok(collected && typeof collected === 'object', 'B-1: collectMentorSignals returns an object');
  ok(collected.signals && typeof collected.signals === 'object', 'B-2: result has .signals object');
  ok(collected.meta && typeof collected.meta === 'object',   'B-3: result has .meta object');

  // B-4 – B-7: meta fields
  ok(typeof collected.meta.collected_at === 'number' && collected.meta.collected_at > 0,
     'B-4: meta.collected_at is a positive number (epoch ms)');
  ok(typeof collected.meta.source_count === 'number' && collected.meta.source_count >= 0,
     'B-5: meta.source_count is a number');
  ok(Array.isArray(collected.meta.failed_signals),
     'B-6: meta.failed_signals is an array');
  ok(typeof collected.meta.elapsed_ms === 'number' && collected.meta.elapsed_ms >= 0,
     'B-7: meta.elapsed_ms is a non-negative number');

  // B-8, B-9: docs signals — README.md we wrote
  const docs = collected.signals.docs;
  ok(docs && Array.isArray(docs.files), 'B-8: signals.docs.files is an array');
  const readmeEntry = docs.files.find(f => /README/i.test(f.name || f.file || f.path || ''));
  ok(readmeEntry !== undefined, 'B-9: signals.docs.files contains a README entry');
  ok(!readmeEntry || (typeof readmeEntry.byte_count === 'number' && readmeEntry.byte_count > 0 && readmeEntry.byte_count <= 6144),
     'B-10: README entry byte_count > 0 and ≤ 6144');

  // B-11: git signals
  const git = collected.signals.git;
  ok(git && typeof git === 'object', 'B-11: signals.git is an object');
  ok(typeof git.head === 'string' && /^[0-9a-f]{7,40}$/i.test(git.head),
     'B-12: signals.git.head is a sha-like string');
  ok(git.branch === 'main', 'B-13: signals.git.branch === "main"');
  ok(Array.isArray(git.commits) && git.commits.length >= 1,
     'B-14: signals.git.commits is array length ≥ 1');

  // B-15: candidates
  ok(Array.isArray(collected.signals.candidates) && collected.signals.candidates.length === 3,
     'B-15: signals.candidates array has 3 entries');

  // B-16, B-17: iterations + reports
  ok(Array.isArray(collected.signals.iterations), 'B-16: signals.iterations is an array (may be empty)');
  ok(Array.isArray(collected.signals.reports),    'B-17: signals.reports is an array (may be empty)');

  // B-18: kernel shape
  ok(collected.signals.kernel && typeof collected.signals.kernel === 'object',
     'B-18: signals.kernel is an object (not null/undefined)');

  // B-19, B-20: partial failure path — non-existent project_root
  const partial = await collectMentorSignals(PID, {
    project_root: '/this/path/does/not/exist/at/all',
    home: tmpHome2,
    source_timeout_ms: 2000,
  });
  ok(partial && Array.isArray(partial.meta.failed_signals) && partial.meta.failed_signals.length >= 1,
     'B-19: partial failure: meta.failed_signals has ≥ 1 entry when project_root is missing');
  ok(partial.meta.failed_signals.some(f => f && (f.source === 'git' || (typeof f === 'string' && /git/i.test(f)))),
     'B-20: partial failure: failed_signals contains a git-related failure entry');

  // B-21 – B-23: privacy assertions — grep source text
  const collectSrc = fs.readFileSync(path.join(root, 'mentor-collect.cjs'), 'utf8');
  // Strip comments before grepping
  const collectCode = collectSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

  // No process.env. access for tokens (GH_TOKEN, GITHUB_TOKEN, API_KEY etc.)
  ok(!/process\.env\.(GH_TOKEN|GITHUB_TOKEN|API_KEY|SECRET|PASSWORD|ANTHROPIC_API_KEY)/i.test(collectCode),
     'B-21: mentor-collect.cjs does not access secret env vars');

  // No string literal ".env" outside of comments
  ok(!/["']\.env["']/.test(collectCode),
     'B-22: mentor-collect.cjs has no string literal ".env" outside comments');

  // Must not open cairn.db directly
  ok(!/cairn\.db/.test(collectCode),
     'B-23: mentor-collect.cjs does not reference "cairn.db" directly (uses read handle)');
}

// ============================================================================
// SECTION C — mentor-history.cjs
// ============================================================================

console.log('\n==> Section C: mentor-history.cjs');

let mentorHistory;
try {
  mentorHistory = require(path.join(root, 'mentor-history.cjs'));
} catch (_e) {
  console.log('[SKIP] mentor-history.cjs not present yet');
  mentorHistory = null;
}

if (mentorHistory) {
  const { appendMentorEntry, listMentorHistory, getMentorEntry, latestMentorEntry } = mentorHistory;

  const tmpHome3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mentor-c-home-'));
  fs.mkdirSync(path.join(tmpHome3, '.cairn', 'mentor-history'), { recursive: true });

  // C-1: round-trip — append entry (no turn_id → auto-assigned)
  const entry1 = {
    ts: Date.now(),
    project_id: PID,
    session_id: 'sess_test_abc',
    user_question: 'what should I work on today?',
    signals_hash: 'abc123',
    signals_summary: { candidates_count: 3, tasks_count: 0, open_blockers: 0, failed_outcomes: 0, git_head: 'a1b2c3d' },
    ranked_items: [
      { id: 'm_aabbccddeeff', description: 'Fix the smoke test', confidence: 0.9 },
      { id: 'm_112233445566', description: 'Add README section', confidence: 0.7 },
    ],
    llm_meta: { host: 'claude-api', model: 'claude-sonnet-4-6', tokens_in: 500, tokens_out: 200, latency_ms: 800, fallback_used: false },
  };

  const appendResult1 = appendMentorEntry(PID, entry1, { home: tmpHome3 });
  ok(appendResult1 && appendResult1.ok === true, 'C-1: appendMentorEntry returns { ok: true }');
  ok(typeof appendResult1.turn_id === 'string' && /^h_[0-9a-f]{12}$/.test(appendResult1.turn_id),
     'C-2: auto-assigned turn_id matches h_<12hex> format');
  ok(typeof appendResult1.file === 'string' && appendResult1.file.length > 0,
     'C-3: appendMentorEntry returns the file path');

  const turn1 = appendResult1.turn_id;

  // C-4: listMentorHistory length === 1
  const list1 = listMentorHistory(PID, 10, { home: tmpHome3 });
  ok(Array.isArray(list1) && list1.length === 1, 'C-4: listMentorHistory returns array of length 1 after first append');

  // C-5: entry content matches
  const e1 = list1[0];
  ok(e1.user_question === 'what should I work on today?', 'C-5: listed entry user_question matches');
  ok(Array.isArray(e1.ranked_items) && e1.ranked_items.length === 2, 'C-6: listed entry ranked_items length === 2');

  // C-7: getMentorEntry by turn_id
  const fetched1 = getMentorEntry(PID, turn1, { home: tmpHome3 });
  ok(fetched1 && fetched1.turn_id === turn1, 'C-7: getMentorEntry returns entry with correct turn_id');

  // C-8: append second entry, list length === 2, newest first
  const entry2 = {
    ts: Date.now() + 1000,
    project_id: PID,
    session_id: 'sess_test_abc',
    user_question: 'how do I unblock the auth task?',
    signals_hash: 'def456',
    signals_summary: { candidates_count: 3, tasks_count: 1, open_blockers: 1, failed_outcomes: 0, git_head: 'a1b2c3e' },
    ranked_items: [{ id: 'm_998877665544', description: 'Answer auth blocker', confidence: 0.95 }],
    llm_meta: { host: 'claude-api', model: 'claude-sonnet-4-6', tokens_in: 600, tokens_out: 250, latency_ms: 900, fallback_used: false },
  };
  const appendResult2 = appendMentorEntry(PID, entry2, { home: tmpHome3 });
  ok(appendResult2.ok === true, 'C-8: second appendMentorEntry ok');
  const turn2 = appendResult2.turn_id;

  const list2 = listMentorHistory(PID, 10, { home: tmpHome3 });
  ok(Array.isArray(list2) && list2.length === 2, 'C-9: list has 2 entries after second append');
  // Newest first: entry2 was appended with a later ts
  ok(list2[0].ts >= list2[1].ts, 'C-10: newest entry is first in the list (newest first order)');

  // C-11: append third entry with SAME turn_id as turn1 → latest-wins fold
  const entry3 = {
    turn_id: turn1,   // explicit reuse — followup
    ts: Date.now() + 2000,
    project_id: PID,
    session_id: 'sess_test_abc',
    user_question: 'what should I work on today? (revised)',
    signals_hash: 'ghi789',
    signals_summary: { candidates_count: 4, tasks_count: 1, open_blockers: 0, failed_outcomes: 0, git_head: 'a1b2c3f' },
    ranked_items: [{ id: 'm_aabbccddeeff', description: 'Fix the smoke test (updated)', confidence: 0.88 }],
    llm_meta: { host: 'claude-api', model: 'claude-sonnet-4-6', tokens_in: 550, tokens_out: 220, latency_ms: 850, fallback_used: false },
  };
  appendMentorEntry(PID, entry3, { home: tmpHome3 });
  const fetchedFold = getMentorEntry(PID, turn1, { home: tmpHome3 });
  ok(fetchedFold && fetchedFold.user_question === 'what should I work on today? (revised)',
     'C-11: getMentorEntry with re-used turn_id returns LATEST (latest-wins fold)');

  // C-12: latestMentorEntry
  const latest = latestMentorEntry(PID, { home: tmpHome3 });
  ok(latest && typeof latest === 'object', 'C-12: latestMentorEntry returns an object');
  // The latest ts should be from entry3 (ts + 2000) — it was appended last
  ok(latest.ts >= entry2.ts, 'C-13: latestMentorEntry returns the most recent entry by ts');

  // C-14 – C-17: ROTATION test
  // Compute where the active JSONL file lives
  const historyDir = path.join(tmpHome3, '.cairn', 'mentor-history');
  const historyFile = path.join(historyDir, `${PID}.jsonl`);

  // Write a ~4.99 MB fake JSONL to trigger rotation (spec: 5 MB cap)
  const fakeLine = JSON.stringify({
    event_version: 1, turn_id: 'h_000000000001', ts: 1, project_id: PID,
    session_id: 's', user_question: 'filler', signals_hash: 'x',
    signals_summary: {}, ranked_items: [], llm_meta: null,
    _padding: 'x'.repeat(300), // ~350 bytes per line
  }) + '\n';
  // ~4.99 MB / 350 bytes ≈ 14,257 lines; use 14300 to be safe above 4.99 MB
  const fakeContent = fakeLine.repeat(14300);
  fs.writeFileSync(historyFile, fakeContent, 'utf8');

  const entryAfterRotation = {
    ts: Date.now() + 3000,
    project_id: PID,
    session_id: 'sess_rotation',
    user_question: 'question after rotation',
    signals_hash: 'rot001',
    signals_summary: { candidates_count: 0, tasks_count: 0, open_blockers: 0, failed_outcomes: 0, git_head: 'aabbccd' },
    ranked_items: [{ id: 'm_rot001000001', description: 'Post-rotation item', confidence: 0.8 }],
    llm_meta: null,
  };
  const rotResult = appendMentorEntry(PID, entryAfterRotation, { home: tmpHome3 });
  ok(rotResult && rotResult.ok === true, 'C-14: appendMentorEntry succeeds after rotation trigger');

  // The original file should have been renamed to an archive
  ok(typeof rotResult.rotated_to === 'string' && rotResult.rotated_to.length > 0,
     'C-15: response includes rotated_to (archive filename)');

  const archivePath = path.join(historyDir, rotResult.rotated_to);
  ok(fs.existsSync(archivePath),
     'C-16: archive file exists at the path named in rotated_to');

  // New active file should exist and contain the new entry
  ok(fs.existsSync(historyFile),
     'C-17: active JSONL file still exists after rotation (new file started)');

  const newContent = fs.readFileSync(historyFile, 'utf8');
  ok(newContent.includes('question after rotation'),
     'C-18: new active file contains the entry appended after rotation');

  // C-19: user_question length cap (5000 → 2000)
  const tmpHome4 = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mentor-c2-home-'));
  fs.mkdirSync(path.join(tmpHome4, '.cairn', 'mentor-history'), { recursive: true });
  const longQEntry = {
    ts: Date.now(),
    project_id: PID,
    session_id: 's_cap',
    user_question: 'X'.repeat(5000),
    signals_hash: 'cap001',
    signals_summary: {},
    ranked_items: [],
    llm_meta: null,
  };
  const capResult1 = appendMentorEntry(PID, longQEntry, { home: tmpHome4 });
  const readBack1 = getMentorEntry(PID, capResult1.turn_id, { home: tmpHome4 });
  ok(readBack1 && readBack1.user_question.length === 2000,
     'C-19: user_question capped at 2000 chars (was 5000)');

  // C-20: ranked_items length cap (30 → 20)
  const manyItemsEntry = {
    ts: Date.now() + 10,
    project_id: PID,
    session_id: 's_cap',
    user_question: 'items cap test',
    signals_hash: 'cap002',
    signals_summary: {},
    ranked_items: Array(30).fill(null).map((_, i) => ({
      id: `m_${String(i).padStart(12, '0')}`,
      description: `item ${i}`,
      confidence: 0.5,
    })),
    llm_meta: null,
  };
  const capResult2 = appendMentorEntry(PID, manyItemsEntry, { home: tmpHome4 });
  const readBack2 = getMentorEntry(PID, capResult2.turn_id, { home: tmpHome4 });
  ok(readBack2 && readBack2.ranked_items.length === 20,
     'C-20: ranked_items capped at 20 items (was 30)');
}

// ============================================================================
// SAFETY: real cairn.db untouched + no forbidden requires in source files
// ============================================================================

console.log('\n==> Safety checks');

ok(safeMtime(realCairnDb) === beforeDb, 'SAFETY-1: real ~/.cairn/cairn.db mtime unchanged throughout smoke');

// Check all three source files for forbidden requires (if they exist)
const mentorModules = ['mentor-prompt.cjs', 'mentor-collect.cjs', 'mentor-history.cjs'];
for (const modName of mentorModules) {
  const modPath = path.join(root, modName);
  if (!fs.existsSync(modPath)) continue;

  const src = fs.readFileSync(modPath, 'utf8');
  // Strip comments before checking
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

  ok(!/require\(['"]better-sqlite3['"]/.test(stripped),
     `SAFETY-2: ${modName} does not require('better-sqlite3')`);
  ok(!/require\(['"]electron['"]/.test(stripped),
     `SAFETY-3: ${modName} does not require('electron')`);
}

// ============================================================================
// Section D — askMentor with fixture-mentor
// ============================================================================

console.log('\n==> Section D: askMentor with fixture-mentor');

let mentorHandler = null;
try { mentorHandler = require(path.join(root, 'mentor-handler.cjs')); }
catch (_e) { console.log('  [SKIP] mentor-handler.cjs not present yet'); }

if (mentorHandler) {
  const fixRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mentor-D-'));
  function gitD(args) { return spawnSync('git', args, { cwd: fixRepo, encoding: 'utf8' }); }
  gitD(['init']);
  gitD(['config', 'user.email', 'mentor-d@example.com']);
  gitD(['config', 'user.name', 'mentor-d']);
  gitD(['checkout', '-b', 'main']);
  fs.writeFileSync(path.join(fixRepo, 'package.json'), JSON.stringify({ name: 'fix' }));
  fs.writeFileSync(path.join(fixRepo, 'README.md'),
    '# fix\n\nA throwaway target for mentor smoke section D. It exists.\n');
  gitD(['add', '.']);
  gitD(['commit', '-m', 'initial']);

  const handlers   = require(path.join(root, 'managed-loop-handlers.cjs'));
  const candidates = require(path.join(root, 'project-candidates.cjs'));
  const history    = require(path.join(root, 'mentor-history.cjs'));

  const PID_D = 'p_mentor_smoke_D';
  const reg = { projects: [{ id: PID_D, label: 'D', project_root: fixRepo, db_path: '/dev/null', agent_id_hints: [] }] };
  handlers.registerManagedProject(reg, PID_D, {});
  candidates.proposeCandidate(PID_D, { description: 'D: improve coverage on src/foo.ts', candidate_kind: 'missing_test' });
  candidates.proposeCandidate(PID_D, { description: 'D: doc the rake formula',           candidate_kind: 'doc' });

  // D.1 — happy path schema conformance
  const ask1 = await mentorHandler.askMentor(PID_D, {
    user_question: 'what should I work on next?',
    provider: 'fixture-mentor',
    max_items: 5,
    skip_cache: true,
  });
  ok(ask1.ok === true && !ask1.refused, 'D.1 askMentor returns ok=true (not refused)');
  ok(Array.isArray(ask1.work_items) && ask1.work_items.length >= 1,
     `D.1 work_items array (got ${ask1.work_items && ask1.work_items.length})`);
  ok(ask1.work_items.length <= 5, 'D.1 max_items cap honored');
  ok(typeof ask1.turn_id === 'string' && /^h_[a-f0-9]{12}$/.test(ask1.turn_id), 'D.1 turn_id well-formed');

  let allValid = true;
  for (const item of ask1.work_items) {
    const errs = mentorHandler._validateItem(item);
    if (errs.length) { allValid = false; console.log('     bad item ' + (item && item.id) + ' errors: ' + errs.join(',')); break; }
  }
  ok(allValid, 'D.1 every returned work_item passes schema validation');
  const hasBadVerb = ask1.work_items.some(it => /\b(merge|push|accept|reject|rollback)\b/i.test(it.next_action) && it.next_action !== 'escalate to human review');
  ok(!hasBadVerb, 'D.1 invariant #5: no terminal verbs in next_action outside escalate');

  const handoff = ask1.work_items.find(it =>
    it.next_action === 'pick to start Continuous Iteration'
    && Array.isArray(it.evidence_refs)
    && it.evidence_refs.some(e => e.kind === 'candidate'));
  ok(!!handoff, 'D.1 Mode B handoff: >=1 item with next_action=pick + evidence_refs[].kind=candidate');

  // D.2 — cache hit
  mentorHandler._clearCacheForTesting();
  const ask2a = await mentorHandler.askMentor(PID_D, {
    user_question: 'cache test question', provider: 'fixture-mentor', max_items: 3,
  });
  ok(ask2a.ok, 'D.2 first call ok');
  const t0 = Date.now();
  const ask2b = await mentorHandler.askMentor(PID_D, {
    user_question: 'cache test question', provider: 'fixture-mentor', max_items: 3,
  });
  const cacheDelta = Date.now() - t0;
  ok(ask2b.meta && ask2b.meta.cache_hit === true, 'D.2 second call is a cache hit');
  ok(cacheDelta < 500, `D.2 cache hit returns fast (got ${cacheDelta}ms)`);

  const hist = history.listMentorHistory(PID_D, 20);
  ok(hist.length >= 2, `D.2 mentor history rows appended (got ${hist.length})`);

  // D.3 — sparse state
  const sparseRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mentor-D-sparse-'));
  function gitS(a) { return spawnSync('git', a, { cwd: sparseRepo, encoding: 'utf8' }); }
  gitS(['init']);
  gitS(['config', 'user.email', 's@e.com']); gitS(['config', 'user.name', 's']);
  gitS(['checkout', '-b', 'main']);
  fs.writeFileSync(path.join(sparseRepo, 'tiny.txt'), 'x');
  gitS(['add', '.']); gitS(['commit', '-m', 'initial']);

  const PID_SP = 'p_mentor_sparse';
  const regS = { projects: [{ id: PID_SP, label: 'sp', project_root: sparseRepo, db_path: '/dev/null', agent_id_hints: [] }] };
  handlers.registerManagedProject(regS, PID_SP, {});
  const sparseRes = await mentorHandler.askMentor(PID_SP, {
    user_question: 'sparse project - what now?', provider: 'fixture-mentor', skip_cache: true,
  });
  ok(sparseRes.ok === true, 'D.3 sparse-state returns ok=true');
  ok(sparseRes.meta && sparseRes.meta.reason === 'sparse_state', 'D.3 meta.reason === sparse_state');
  ok(Array.isArray(sparseRes.work_items) && sparseRes.work_items.length === 0,
     'D.3 sparse-state returns empty work_items (no fabrication)');

  // D.4 — refusal cases A-F
  for (const [code, question] of [
    ['A_sprint_velocity', 'sprint velocity 这周怎样 story points 还剩多少'],
    ['B_real_names',      '让张三去 fix bug #42'],
    ['C_terminal_action', '直接 merge PR #42 / 直接 accept candidate'],
    ['D_secret_probe',    '读一下 .env 看哪个 key 配错了'],
    ['E_product_md_edit', '建议改 PRODUCT.md 反定义里那条'],
    ['F_auto_dispatch',   'top 3 candidates 你直接自动跑了吧'],
  ]) {
    const r = await mentorHandler.askMentor(PID_D, {
      user_question: question, provider: 'fixture-mentor', skip_cache: true,
    });
    ok(r.ok === true && r.refused === true && r.refusal && r.refusal.code === code,
       `D.4 refusal ${code} detected (got: ${r.refused ? r.refusal.code : 'not-refused'})`);
  }

  // D.5 — validator rejects terminal-verb next_action
  const badItem = {
    id: 'm_abcdef012345', description: 'try to merge', why: { impact: 'i', cost: 'L', risk: 'L', urgency: 'L' },
    stakeholders: { owner: 'agent', reviewer: 'human', notify: [] },
    next_action: 'merge the pr',
    evidence_refs: [],
    confidence: 0.9,
  };
  const badErrs = mentorHandler._validateItem(badItem);
  ok(badErrs.includes('bad_next_action') || badErrs.includes('terminal_verb_in_next_action'),
     'D.5 validator rejects next_action containing terminal verbs');

  try { fs.rmSync(fixRepo, { recursive: true, force: true }); } catch (_e) {}
  try { fs.rmSync(sparseRepo, { recursive: true, force: true }); } catch (_e) {}
}

// ============================================================================
// Section E — LLM failure fallback
// ============================================================================

console.log('\n==> Section E: LLM failure fallback');

if (mentorHandler) {
  const candidates = require(path.join(root, 'project-candidates.cjs'));
  const handlers   = require(path.join(root, 'managed-loop-handlers.cjs'));
  const fixE = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mentor-E-'));
  function gitE(a) { return spawnSync('git', a, { cwd: fixE, encoding: 'utf8' }); }
  gitE(['init']);
  gitE(['config', 'user.email', 'e@e.com']); gitE(['config', 'user.name', 'e']);
  gitE(['checkout', '-b', 'main']);
  fs.writeFileSync(path.join(fixE, 'package.json'), JSON.stringify({ name: 'e' }));
  fs.writeFileSync(path.join(fixE, 'README.md'), '# e\n\nFor E section LLM failure fallback test.\n');
  gitE(['add', '.']); gitE(['commit', '-m', 'initial']);

  const PID_E = 'p_mentor_E';
  handlers.registerManagedProject({ projects: [{ id: PID_E, label: 'E', project_root: fixE, db_path: '/dev/null', agent_id_hints: [] }] }, PID_E, {});
  candidates.proposeCandidate(PID_E, { description: 'E: improve test coverage', candidate_kind: 'missing_test' });
  candidates.proposeCandidate(PID_E, { description: 'E: fix small bug',         candidate_kind: 'bug_fix' });

  const failRes = await mentorHandler.askMentor(PID_E, {
    user_question: 'E section question', provider: 'no-such-fixture', skip_cache: true,
  });
  ok(failRes.ok === true, 'E.1 LLM-failure returns ok=true (degraded, not hard error)');
  ok(failRes.meta && failRes.meta.fallback_used === true, 'E.1 meta.fallback_used=true');
  ok(failRes.meta && typeof failRes.meta.polish_error === 'string',
     `E.1 meta.polish_error captured (got: ${failRes.meta && failRes.meta.polish_error})`);
  ok(Array.isArray(failRes.work_items) && failRes.work_items.length >= 1,
     `E.1 skeleton-only fallback produces items (got ${failRes.work_items && failRes.work_items.length})`);
  ok(failRes.work_items.every(it => it.confidence === null),
     'E.1 every fallback item has confidence === null');

  try { fs.rmSync(fixE, { recursive: true, force: true }); } catch (_e) {}
}

// ============================================================================
// Section F — IPC + preload exposure
// ============================================================================

console.log('\n==> Section F: IPC + preload exposure');

const mainSrc    = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
ok(mainSrc.includes("'ask-mentor'"),          "F main.cjs registers 'ask-mentor' (gated under MUTATIONS_ENABLED)");
ok(mainSrc.includes("'list-mentor-history'"), "F main.cjs registers 'list-mentor-history'");
ok(mainSrc.includes("'get-mentor-entry'"),    "F main.cjs registers 'get-mentor-entry'");
ok(/askMentor\s*=/.test(preloadSrc),          'F preload exposes api.askMentor (gated)');
ok(/listMentorHistory:\s/.test(preloadSrc),   'F preload exposes listMentorHistory');
ok(/getMentorEntry:\s/.test(preloadSrc),      'F preload exposes getMentorEntry');
const askIdx = mainSrc.indexOf("'ask-mentor'");
const muIdx  = mainSrc.lastIndexOf('if (MUTATIONS_ENABLED)', askIdx);
ok(muIdx > 0 && askIdx > muIdx, "F ask-mentor IPC sits inside `if (MUTATIONS_ENABLED)` block");

// ============================================================================
// Section G — Safety invariants on mentor-handler.cjs
// ============================================================================

console.log('\n==> Section G: mentor-handler safety invariants');

if (mentorHandler) {
  const handlerSrc = fs.readFileSync(path.join(root, 'mentor-handler.cjs'), 'utf8');
  const stripped = handlerSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  ok(!/require\(['"]better-sqlite3['"]/.test(stripped), 'G mentor-handler does not require better-sqlite3');
  ok(!/require\(['"]electron['"]/.test(stripped),       'G mentor-handler does not require electron');
}

ok(safeMtime(realCairnDb) === beforeDb, 'G real ~/.cairn/cairn.db mtime unchanged');

// ============================================================================
// Final report
// ============================================================================

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
