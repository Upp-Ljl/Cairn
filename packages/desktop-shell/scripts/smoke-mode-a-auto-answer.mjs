#!/usr/bin/env node
/**
 * smoke-mode-a-auto-answer.mjs — MA-2d aggressive Rule D auto-answer.
 *
 * HOME sandboxed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ma2d-smoke-'));
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
const aa = require(path.join(dsRoot, 'mode-a-auto-answer.cjs'));
const Database = require(path.join(dsRoot, 'node_modules', 'better-sqlite3'));

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      created_by_agent_id TEXT,
      state TEXT,
      updated_at INTEGER
    );
    CREATE TABLE blockers (
      blocker_id TEXT PRIMARY KEY,
      task_id TEXT,
      question TEXT,
      context_keys TEXT,
      status TEXT,
      raised_by TEXT,
      raised_at INTEGER,
      answer TEXT,
      answered_by TEXT,
      answered_at INTEGER,
      metadata_json TEXT
    );
  `);
  return db;
}
function tableSet(db) {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
  return new Set(rows.map(r => r.name));
}

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-mode-a-auto-answer (MA-2d)');

// ---------------------------------------------------------------------------
section('1 detectYesNo: positive cases');
{
  const cases = [
    'Should I use TypeScript?',
    'Can I rename the file?',
    'Is the migration safe?',
    'Are these tests sufficient?',
  ];
  for (const q of cases) {
    const r = aa.detectYesNo(q);
    ok(r && r.answer === 'yes', `"${q}" → yes`);
  }
}

// ---------------------------------------------------------------------------
section('2 detectYesNo: negative cases');
{
  // No trailing ?
  ok(aa.detectYesNo('Should I use TypeScript') === null, 'no ? → null');
  // Doesn't start with yes/no prefix
  ok(aa.detectYesNo('Which library?') === null, 'wh-question → null');
  // Multi-sentence with nuance
  ok(aa.detectYesNo('Should I do A. Or maybe B?') === null, 'multi-sentence → null');
  // Non-string
  ok(aa.detectYesNo(null) === null, 'null → null');
  ok(aa.detectYesNo(undefined) === null, 'undefined → null');
}

// ---------------------------------------------------------------------------
section('3 detectChooseFrom: A-or-B prompts');
{
  const r = aa.detectChooseFrom('Should I use option A or option B?');
  ok(r && /option A/.test(r.answer), `A or B → defaults to A (got ${r && r.answer})`);
  ok(r && r.rule === 'choose-from', 'rule = choose-from');

  const r2 = aa.detectChooseFrom('use approach 1 or approach 2?');
  ok(r2 !== null, 'approach 1 or 2 detected');

  ok(aa.detectChooseFrom('Should I use TypeScript?') === null, 'simple yes/no not caught');
}

// ---------------------------------------------------------------------------
section('4 detectAny: explicit "any preference / either" prompts');
{
  ok(aa.detectAny('any preference for the test framework?').rule === 'any', 'any preference → any');
  ok(aa.detectAny('either is fine?').rule === 'any', 'either fine → any');
  ok(aa.detectAny('What should I do?') === null, 'no signal → null');
}

// ---------------------------------------------------------------------------
section('5 detectFromProfile: CAIRN.md authority match');
{
  const profile = {
    authority: {
      choices: [
        { keyword: 'database', decision: 'use SQLite', reason: 'team standard' },
        { keyword: 'testing framework', decision: 'vitest', reason: null },
      ],
    },
  };
  const r = aa.detectFromProfile('Which database should I use for sessions?', profile);
  ok(r && r.answer === 'use SQLite', `database keyword matched (got ${r && r.answer})`);
  ok(r && /team standard/.test(r.reasoning), 'reason carried');

  const miss = aa.detectFromProfile('Something unrelated?', profile);
  ok(miss === null, 'no keyword match → null');

  // Profile without choices
  ok(aa.detectFromProfile('q?', { authority: {} }) === null, 'no choices → null');
  ok(aa.detectFromProfile('q?', null) === null, 'no profile → null');
}

// ---------------------------------------------------------------------------
section('6 detectFallback: always returns an answer');
{
  const r1 = aa.detectFallback('totally cryptic question?', 'ship MVP');
  ok(r1 && /ship MVP/.test(r1.answer), 'goal title in answer');
  const r2 = aa.detectFallback('q?', null);
  ok(r2 && r2.answer.length > 0, 'still answers without goal');
}

// ---------------------------------------------------------------------------
section('7 decideAutoAnswer: precedence (profile > choose-from > any > yesno > fallback)');
{
  const profile = {
    authority: {
      choices: [{ keyword: 'auth', decision: 'use OAuth' }],
    },
  };
  // Profile keyword present → wins even though it's also a yes/no.
  const r1 = aa.decideAutoAnswer({ question: 'Should I use auth?' }, { profile });
  ok(r1.rule === 'profile', `profile wins (got ${r1.rule})`);

  // Fallback when nothing matches.
  const r2 = aa.decideAutoAnswer({ question: 'something weird' }, { profile });
  ok(r2.rule === 'fallback', `fallback (got ${r2.rule})`);
}

// ---------------------------------------------------------------------------
section('8 writeAnswer: mutates OPEN blocker → ANSWERED');
{
  const db = makeDb();
  db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_at) VALUES (?, ?, ?, ?, ?)`)
    .run('b1', 't1', 'Should I X?', 'OPEN', Date.now());
  const decision = { rule: 'yesno', answer: 'yes', reasoning: 'test' };
  const r = aa.writeAnswer(db, 'b1', decision, 5000);
  ok(r.ok === true, 'write ok');
  ok(/mode-a-auto:yesno/.test(r.answered_by), 'answered_by carries rule');

  const row = db.prepare(`SELECT * FROM blockers WHERE blocker_id = 'b1'`).get();
  ok(row.status === 'ANSWERED', `status flipped (got ${row.status})`);
  ok(row.answer === 'yes', 'answer text stored');
  ok(row.answered_at === 5000, 'answered_at stored');
  ok(row.answered_by === 'mode-a-auto:yesno', 'answered_by stored');
}

// ---------------------------------------------------------------------------
section('9 writeAnswer: idempotent on ANSWERED rows');
{
  const db = makeDb();
  db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_at, answer, answered_by, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('b2', 't1', 'q?', 'ANSWERED', 0, 'previous answer', 'human', 100);
  const r = aa.writeAnswer(db, 'b2', { rule: 'yesno', answer: 'yes' }, 5000);
  ok(r.ok === false, `won't overwrite (got ${r.ok})`);
  ok(r.reason === 'not_open', 'reason = not_open');

  const row = db.prepare(`SELECT * FROM blockers WHERE blocker_id = 'b2'`).get();
  ok(row.answer === 'previous answer', 'original answer preserved');
  ok(row.answered_by === 'human', 'original answerer preserved');
}

// ---------------------------------------------------------------------------
section('10 runOnceForProject end-to-end: OPEN blockers get answered');
{
  const db = makeDb();
  db.prepare(`INSERT INTO tasks (task_id, created_by_agent_id, state, updated_at) VALUES (?, ?, ?, ?)`)
    .run('t1', 'a_cc', 'BLOCKED', Date.now());
  db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_at) VALUES (?, ?, ?, ?, ?)`)
    .run('b_yes', 't1', 'Should I add a comment?', 'OPEN', Date.now());
  db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_at) VALUES (?, ?, ?, ?, ?)`)
    .run('b_any', 't1', 'any preference on naming?', 'OPEN', Date.now());
  // A task not owned by our agent — should NOT be touched.
  db.prepare(`INSERT INTO tasks (task_id, created_by_agent_id, state, updated_at) VALUES (?, ?, ?, ?)`)
    .run('t_other', 'a_other', 'BLOCKED', Date.now());
  db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_at) VALUES (?, ?, ?, ?, ?)`)
    .run('b_other', 't_other', 'Should I ?', 'OPEN', Date.now());

  const tables = tableSet(db);
  const r = aa.runOnceForProject({
    db, tables,
    project: { id: 'p_a' },
    agentIds: ['a_cc'],
    profile: null,
    goalTitle: 'ship MA-2d',
  });
  ok(r.action === 'ran', `ran (got ${r.action})`);
  ok(r.answered === 2, `2 own-agent blockers answered (got ${r.answered})`);

  // Verify the other-agent blocker untouched.
  const other = db.prepare(`SELECT status FROM blockers WHERE blocker_id = 'b_other'`).get();
  ok(other.status === 'OPEN', 'other-agent blocker NOT touched');

  // Re-run: idempotent (status now ANSWERED).
  const r2 = aa.runOnceForProject({
    db, tables, project: { id: 'p_a' }, agentIds: ['a_cc'],
    profile: null, goalTitle: null,
  });
  ok(r2.action === 'noop' && r2.reason === 'no_open_blockers', `2nd tick noop (got ${r2.action}/${r2.reason})`);
}

// ---------------------------------------------------------------------------
section('11 runOnceForProject: tables/agents missing → noop');
{
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (task_id TEXT, created_by_agent_id TEXT)`);
  const r = aa.runOnceForProject({
    db, tables: new Set(['tasks']),  // blockers table missing
    project: { id: 'p' }, agentIds: ['a'],
  });
  ok(r.action === 'noop', 'missing blockers table → noop');

  const r2 = aa.runOnceForProject({
    db, tables: new Set(['tasks', 'blockers']),
    project: { id: 'p' }, agentIds: [],
  });
  ok(r2.action === 'noop' && r2.reason === 'no_agent_hints', 'empty hints → noop');
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
