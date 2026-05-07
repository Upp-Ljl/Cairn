import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Database as DB } from 'better-sqlite3';
import { openWorkspace } from '../../src/workspace.js';
import { PRIMITIVE_FNS, type EvalContext } from '../../src/dsl/primitives.js';

// ────────────────────────────────────────────────────────────────
// Shared fixture helpers
// ────────────────────────────────────────────────────────────────

const cleanups: Array<{ dir?: string; db?: DB }> = [];

afterEach(() => {
  for (const c of cleanups) {
    try { c.db?.close(); } catch { /* ignore */ }
    if (c.dir) fs.rmSync(c.dir, { recursive: true, force: true });
  }
  cleanups.length = 0;
});

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-prim-test-'));
  cleanups.push({ dir });
  return dir;
}

function makeTmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-prim-db-'));
  const ws = openWorkspace({ cairnRoot: dir });
  cleanups.push({ db: ws.db, dir });
  return ws.db;
}

function makeCtx(db: DB, cwd: string, overrides?: Partial<EvalContext>): EvalContext {
  return { db, cwd, env: process.env, timeoutMs: 5000, ...overrides };
}

// ────────────────────────────────────────────────────────────────
// tests_pass
// ────────────────────────────────────────────────────────────────

describe('tests_pass', () => {
  it('happy: package.json with exit(0) test → PASS', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    const r = await PRIMITIVE_FNS.tests_pass({ target: '.' }, makeCtx(db, cwd));
    expect(r.status).toBe('PASS');
    expect(r.detail).toMatch(/tests passed/);
    expect(r.primitive).toBe('tests_pass');
  });

  it('FAIL: package.json with exit(1) test → FAIL', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }),
    );
    const r = await PRIMITIVE_FNS.tests_pass({}, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/tests failed/);
  });

  it('edge: no package.json → FAIL mentioning package.json', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const r = await PRIMITIVE_FNS.tests_pass({}, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/package\.json/);
  });

  it('edge: package.json without scripts.test → FAIL mentioning package.json', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'x' }));
    const r = await PRIMITIVE_FNS.tests_pass({}, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/package\.json/);
  });

  it('edge: traversal target → FAIL with path check', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const r = await PRIMITIVE_FNS.tests_pass({ target: '../../etc' }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/path check failed/);
  });
});

// ────────────────────────────────────────────────────────────────
// command_exits_0
// ────────────────────────────────────────────────────────────────

describe('command_exits_0', () => {
  it('happy: exit(0) → PASS', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const r = await PRIMITIVE_FNS.command_exits_0({ cmd: 'node -e "process.exit(0)"' }, makeCtx(db, cwd));
    expect(r.status).toBe('PASS');
    expect(r.detail).toBe('cmd exited 0');
  });

  it('FAIL: exit(2) → FAIL with exit code 2', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const r = await PRIMITIVE_FNS.command_exits_0({ cmd: 'node -e "process.exit(2)"' }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('2');
  });

  it('edge: cwd outside ctx.cwd → FAIL with path check', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const r = await PRIMITIVE_FNS.command_exits_0({ cmd: 'echo hi', cwd: '../../outside' }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/path check failed/);
  });

  it('edge: valid sub-cwd runs command inside it', async () => {
    const cwd = makeTmpDir();
    const subDir = path.join(cwd, 'sub');
    fs.mkdirSync(subDir);
    const db = makeTmpDb();
    const r = await PRIMITIVE_FNS.command_exits_0({ cmd: 'node -e "process.exit(0)"', cwd: 'sub' }, makeCtx(db, cwd));
    expect(r.status).toBe('PASS');
  });
});

// ────────────────────────────────────────────────────────────────
// file_exists
// ────────────────────────────────────────────────────────────────

describe('file_exists', () => {
  it('happy: file present → PASS', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(path.join(cwd, 'foo.txt'), 'hello');
    const r = await PRIMITIVE_FNS.file_exists({ path: 'foo.txt' }, makeCtx(db, cwd));
    expect(r.status).toBe('PASS');
  });

  it('FAIL: file absent → FAIL with file not found', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const r = await PRIMITIVE_FNS.file_exists({ path: 'nope.txt' }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/file not found/);
  });

  it('edge: traversal path → FAIL with path check', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const r = await PRIMITIVE_FNS.file_exists({ path: '../../etc/passwd' }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/path check/);
  });
});

// ────────────────────────────────────────────────────────────────
// regex_matches
// ────────────────────────────────────────────────────────────────

describe('regex_matches', () => {
  it('happy: pattern matches file content → PASS', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello world');
    const r = await PRIMITIVE_FNS.regex_matches({ file: 'a.txt', pattern: '^hello' }, makeCtx(db, cwd));
    expect(r.status).toBe('PASS');
  });

  it('FAIL: pattern does not match → FAIL', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello world');
    const r = await PRIMITIVE_FNS.regex_matches({ file: 'a.txt', pattern: '^bye' }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/not matched/);
  });

  it('edge: invalid regex → FAIL with invalid regex', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'content');
    const r = await PRIMITIVE_FNS.regex_matches({ file: 'a.txt', pattern: '[unclosed' }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/invalid regex/);
  });

  it('edge: file not found → FAIL with file not found', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const r = await PRIMITIVE_FNS.regex_matches({ file: 'missing.txt', pattern: 'x' }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/file not found/);
  });

  it('edge: flags applied — case-insensitive match', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'Hello World');
    const r = await PRIMITIVE_FNS.regex_matches({ file: 'b.txt', pattern: '^hello', flags: 'i' }, makeCtx(db, cwd));
    expect(r.status).toBe('PASS');
  });
});

// ────────────────────────────────────────────────────────────────
// scratchpad_key_exists
// ────────────────────────────────────────────────────────────────

describe('scratchpad_key_exists', () => {
  function insertScratchRow(db: DB, key: string, taskId: string) {
    const now = Date.now();
    db.prepare(
      'INSERT INTO scratchpad (key, value_json, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(key, '"val"', taskId, now, now);
  }

  it('happy: key+task_id present → PASS', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    insertScratchRow(db, 'K1', 'T1');
    const r = await PRIMITIVE_FNS.scratchpad_key_exists({ key: 'K1', task_id: 'T1' }, makeCtx(db, cwd));
    expect(r.status).toBe('PASS');
    expect(r.detail).toBe('key found');
  });

  it('FAIL: key absent → FAIL with key not found', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    const r = await PRIMITIVE_FNS.scratchpad_key_exists({ key: 'NOPE' }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toBe('key not found');
  });

  it('edge: task_id filter narrows — wrong task_id → FAIL', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    insertScratchRow(db, 'K1', 'T1');
    const r = await PRIMITIVE_FNS.scratchpad_key_exists({ key: 'K1', task_id: 'T2' }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
  });

  it('edge: no task_id arg but ctx.task_id set — uses ctx task_id', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    insertScratchRow(db, 'K2', 'CTX-TASK');
    const r = await PRIMITIVE_FNS.scratchpad_key_exists({ key: 'K2' }, makeCtx(db, cwd, { task_id: 'CTX-TASK' }));
    expect(r.status).toBe('PASS');
  });

  it('edge: key present but no task_id anywhere — global search → PASS', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    insertScratchRow(db, 'K3', 'any-task');
    const r = await PRIMITIVE_FNS.scratchpad_key_exists({ key: 'K3' }, makeCtx(db, cwd));
    expect(r.status).toBe('PASS');
  });
});

// ────────────────────────────────────────────────────────────────
// no_open_conflicts
// ────────────────────────────────────────────────────────────────

describe('no_open_conflicts', () => {
  function insertConflict(db: DB, status: string, pathsJson: string) {
    db.prepare(`
      INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, paths_json, status)
      VALUES (?, ?, 'FILE_OVERLAP', 'agent-a', ?, ?)
    `).run(`conflict-${Math.random()}`, Date.now(), pathsJson, status);
  }

  it('happy: 0 OPEN conflicts → PASS', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    const r = await PRIMITIVE_FNS.no_open_conflicts({}, makeCtx(db, cwd));
    expect(r.status).toBe('PASS');
    expect(r.detail).toBe('no open conflicts');
  });

  it('FAIL: 1 OPEN conflict → FAIL with count', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    insertConflict(db, 'OPEN', '["src/foo.ts"]');
    const r = await PRIMITIVE_FNS.no_open_conflicts({}, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/1 open conflict/);
  });

  it('edge: scope_paths matches OPEN conflict → FAIL', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    insertConflict(db, 'OPEN', '["src/foo.ts"]');
    const r = await PRIMITIVE_FNS.no_open_conflicts({ scope_paths: ['src/'] }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
  });

  it('edge: scope_paths no match → PASS (conflict exists but outside scope)', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    insertConflict(db, 'OPEN', '["src/foo.ts"]');
    const r = await PRIMITIVE_FNS.no_open_conflicts({ scope_paths: ['lib/'] }, makeCtx(db, cwd));
    expect(r.status).toBe('PASS');
  });

  it('edge: RESOLVED conflict does not count → PASS', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    insertConflict(db, 'RESOLVED', '["src/bar.ts"]');
    const r = await PRIMITIVE_FNS.no_open_conflicts({}, makeCtx(db, cwd));
    expect(r.status).toBe('PASS');
  });
});

// ────────────────────────────────────────────────────────────────
// checkpoint_created_after
// ────────────────────────────────────────────────────────────────

describe('checkpoint_created_after', () => {
  function insertCheckpoint(db: DB, taskId: string, createdAt: number, status: string) {
    db.prepare(`
      INSERT INTO checkpoints (id, task_id, snapshot_dir, snapshot_status, created_at)
      VALUES (?, ?, '/tmp/snap', ?, ?)
    `).run(`cp-${Math.random()}`, taskId, status, createdAt);
  }

  it('happy: READY checkpoint after timestamp → PASS', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    const T = Date.now();
    insertCheckpoint(db, 'T1', T + 1000, 'READY');
    const r = await PRIMITIVE_FNS.checkpoint_created_after({ timestamp: T, task_id: 'T1' }, makeCtx(db, cwd));
    expect(r.status).toBe('PASS');
    expect(r.detail).toMatch(/READY checkpoint/);
  });

  it('FAIL: checkpoint before timestamp only → FAIL', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    const T = Date.now();
    insertCheckpoint(db, 'T1', T - 5000, 'READY');
    const r = await PRIMITIVE_FNS.checkpoint_created_after({ timestamp: T, task_id: 'T1' }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
  });

  it('edge: PENDING checkpoint does not count → FAIL', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    const T = Date.now();
    insertCheckpoint(db, 'T1', T + 1000, 'PENDING');
    const r = await PRIMITIVE_FNS.checkpoint_created_after({ timestamp: T, task_id: 'T1' }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
  });

  it('edge: no task_id in args or ctx → FAIL with task_id required', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    const r = await PRIMITIVE_FNS.checkpoint_created_after({ timestamp: Date.now() }, makeCtx(db, cwd));
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/task_id required/);
  });

  it('edge: ctx.task_id used when arg task_id absent', async () => {
    const db = makeTmpDb();
    const cwd = makeTmpDir();
    const T = Date.now();
    insertCheckpoint(db, 'CTX-T', T + 500, 'READY');
    const r = await PRIMITIVE_FNS.checkpoint_created_after({ timestamp: T }, makeCtx(db, cwd, { task_id: 'CTX-T' }));
    expect(r.status).toBe('PASS');
  });
});
