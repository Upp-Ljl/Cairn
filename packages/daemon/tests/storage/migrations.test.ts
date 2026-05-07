import { describe, it, expect } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations, type Migration } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';

const m1: Migration = {
  version: 1,
  name: 'create_foo',
  up: (db) => db.exec('CREATE TABLE foo (id TEXT PRIMARY KEY)'),
};
const m2: Migration = {
  version: 2,
  name: 'create_bar',
  up: (db) => db.exec('CREATE TABLE bar (id TEXT PRIMARY KEY)'),
};

describe('runMigrations', () => {
  it('applies migrations in version order and records them', () => {
    const { db } = makeTmpDb();
    runMigrations(db, [m2, m1]); // note order reversed on purpose
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows).toEqual([
      { version: 1, name: 'create_foo' },
      { version: 2, name: 'create_bar' },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo'").get())
      .toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bar'").get())
      .toBeTruthy();
  });

  it('is idempotent: second run is a no-op', () => {
    const { db } = makeTmpDb();
    runMigrations(db, [m1]);
    runMigrations(db, [m1]);
    const count = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('throws when a previously applied migration changed checksum', () => {
    const { db } = makeTmpDb();
    runMigrations(db, [m1]);
    const tampered: Migration = {
      version: 1,
      name: 'create_foo',
      up: (db) => db.exec('CREATE TABLE foo (id TEXT, extra INTEGER)'),
    };
    expect(() => runMigrations(db, [tampered])).toThrow(/checksum mismatch/);
  });
});

describe('001-init schema', () => {
  it('creates lanes, ops, compensations after runMigrations', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['compensations', 'lanes', 'ops', 'schema_migrations'])
    );
  });

  it('enforces lanes.state CHECK constraint', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO lanes (id, endpoint, state, created_at, updated_at)
         VALUES ('l1', 'github.issue.patch', 'NOT_A_STATE', 0, 0)`
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });

  it('enforces ops classification CHECK constraint', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    db.prepare(
      `INSERT INTO lanes (id, endpoint, state, created_at, updated_at)
       VALUES ('l1', 'github.issue.patch', 'RECORDED', 0, 0)`
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO ops (id, lane_id, seq, method, url, classification, created_at)
         VALUES ('o1', 'l1', 0, 'PATCH', 'http://x', 'BOGUS', 0)`
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });

  it('enforces UNIQUE(lane_id, seq) on ops', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    db.prepare(
      `INSERT INTO lanes (id, endpoint, state, created_at, updated_at)
       VALUES ('l1', 'e', 'RECORDED', 0, 0)`
    ).run();
    const stmt = db.prepare(
      `INSERT INTO ops (id, lane_id, seq, method, url, classification, created_at)
       VALUES (?, 'l1', 0, 'GET', 'http://x', 'SAFE_REVERT', 0)`
    );
    stmt.run('o1');
    expect(() => stmt.run('o2')).toThrow(/UNIQUE/);
  });

  it('CASCADE deletes ops and compensations when lane is removed', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    db.prepare(
      `INSERT INTO lanes (id, endpoint, state, created_at, updated_at)
       VALUES ('l1', 'e', 'RECORDED', 0, 0)`
    ).run();
    db.prepare(
      `INSERT INTO ops (id, lane_id, seq, method, url, classification, created_at)
       VALUES ('o1', 'l1', 0, 'GET', 'http://x', 'SAFE_REVERT', 0)`
    ).run();
    db.prepare(
      `INSERT INTO compensations
         (id, op_id, strategy, status, attempt, max_attempts, created_at, updated_at)
       VALUES ('c1', 'o1', 'reverse_http', 'PENDING', 0, 3, 0, 0)`
    ).run();

    db.prepare('DELETE FROM lanes WHERE id = ?').run('l1');

    const ops = db.prepare('SELECT COUNT(*) AS n FROM ops').get() as { n: number };
    const comps = db.prepare('SELECT COUNT(*) AS n FROM compensations').get() as { n: number };
    expect(ops.n).toBe(0);
    expect(comps.n).toBe(0);
  });
});

describe('002-scratchpad schema', () => {
  it('creates scratchpad table with PK key + 2 indexes + correct columns', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const cols = db.prepare("PRAGMA table_info(scratchpad)").all() as Array<{
      name: string; pk: number; notnull: number;
    }>;
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames).toEqual(new Set([
      'key', 'value_json', 'value_path', 'task_id',
      'expires_at', 'created_at', 'updated_at',
    ]));
    // key is PK
    const keyCol = cols.find((c) => c.name === 'key');
    expect(keyCol?.pk).toBe(1);
    // created_at + updated_at NOT NULL
    expect(cols.find((c) => c.name === 'created_at')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'updated_at')?.notnull).toBe(1);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='scratchpad'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining(['idx_scratchpad_task_id', 'idx_scratchpad_expires_at']),
    );
  });
});

describe('003-checkpoints schema', () => {
  it('creates checkpoints table with PK id + 2 indexes + CHECK on snapshot_status', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const cols = db.prepare("PRAGMA table_info(checkpoints)").all() as Array<{
      name: string; pk: number; notnull: number;
    }>;
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames).toEqual(new Set([
      'id', 'task_id', 'label', 'git_head', 'snapshot_dir',
      'snapshot_status', 'size_bytes', 'created_at', 'ready_at',
    ]));
    // id PK
    expect(cols.find((c) => c.name === 'id')?.pk).toBe(1);
    // snapshot_dir + snapshot_status + created_at NOT NULL
    expect(cols.find((c) => c.name === 'snapshot_dir')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'snapshot_status')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'created_at')?.notnull).toBe(1);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='checkpoints'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining(['idx_checkpoints_task_id', 'idx_checkpoints_status']),
    );
  });

  it('enforces snapshot_status CHECK constraint', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO checkpoints (id, snapshot_dir, snapshot_status, created_at)
         VALUES ('c1', '/tmp/x', 'NOT_A_STATUS', 0)`
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('004-processes-conflicts schema', () => {
  it('creates processes table with correct columns', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const cols = db.prepare('PRAGMA table_info(processes)').all() as Array<{
      name: string; pk: number; notnull: number;
    }>;
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames).toEqual(new Set([
      'agent_id', 'agent_type', 'capabilities', 'status',
      'registered_at', 'last_heartbeat', 'heartbeat_ttl',
    ]));
    // agent_id PK
    expect(cols.find((c) => c.name === 'agent_id')?.pk).toBe(1);
    // NOT NULL columns
    expect(cols.find((c) => c.name === 'agent_type')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'status')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'registered_at')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'last_heartbeat')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'heartbeat_ttl')?.notnull).toBe(1);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='processes'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('idx_processes_status');
  });

  it('creates conflicts table with correct columns', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const cols = db.prepare('PRAGMA table_info(conflicts)').all() as Array<{
      name: string; pk: number; notnull: number;
    }>;
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames).toEqual(new Set([
      'id', 'detected_at', 'conflict_type', 'agent_a', 'agent_b',
      'paths_json', 'summary', 'status', 'resolved_at', 'resolution',
    ]));
    // id PK
    expect(cols.find((c) => c.name === 'id')?.pk).toBe(1);
    // NOT NULL columns
    expect(cols.find((c) => c.name === 'detected_at')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'conflict_type')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'agent_a')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'paths_json')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'status')?.notnull).toBe(1);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='conflicts'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining(['idx_conflicts_detected_at', 'idx_conflicts_status']),
    );
  });

  it('migration 004 is idempotent (running twice is a no-op)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    runMigrations(db, ALL_MIGRATIONS);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 4")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('enforces processes.status CHECK constraint', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO processes (agent_id, agent_type, status, registered_at, last_heartbeat)
         VALUES ('a1', 'custom', 'ZOMBIE', 0, 0)`
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });

  it('enforces conflicts.conflict_type CHECK constraint', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, paths_json, status)
         VALUES ('01', 0, 'BOGUS_TYPE', 'a1', '[]', 'OPEN')`
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });

  it('enforces conflicts.status CHECK constraint', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, paths_json, status)
         VALUES ('02', 0, 'FILE_OVERLAP', 'a1', '[]', 'NOT_A_STATUS')`
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('005-dispatch-requests schema', () => {
  it('creates dispatch_requests table with correct columns and NOT NULL constraints', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const cols = db.prepare('PRAGMA table_info(dispatch_requests)').all() as Array<{
      name: string; pk: number; notnull: number;
    }>;
    const colNames = new Set(cols.map((c) => c.name));
    // task_id was added by migration 008
    expect(colNames).toEqual(new Set([
      'id', 'nl_intent', 'parsed_intent', 'context_keys',
      'generated_prompt', 'target_agent', 'status', 'created_at', 'confirmed_at',
      'task_id',
    ]));
    // id PK
    expect(cols.find((c) => c.name === 'id')?.pk).toBe(1);
    // NOT NULL columns
    expect(cols.find((c) => c.name === 'nl_intent')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'status')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'created_at')?.notnull).toBe(1);
    // nullable columns
    expect(cols.find((c) => c.name === 'parsed_intent')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'context_keys')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'generated_prompt')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'target_agent')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'confirmed_at')?.notnull).toBe(0);
  });

  it('creates idx_dispatch_requests_status and idx_dispatch_requests_created_at indexes', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dispatch_requests'")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_dispatch_requests_status');
    expect(names).toContain('idx_dispatch_requests_created_at');
  });

  it('migration 005 is idempotent (running twice is a no-op)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    runMigrations(db, ALL_MIGRATIONS);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 5")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('enforces dispatch_requests.status CHECK constraint (invalid status throws)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO dispatch_requests (id, nl_intent, status, created_at)
         VALUES ('dr1', 'do something', 'INVALID_STATUS', 0)`
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });

  it('allows all four valid status values', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    for (const [idx, status] of (['PENDING', 'CONFIRMED', 'REJECTED', 'FAILED'] as const).entries()) {
      expect(() =>
        db.prepare(
          `INSERT INTO dispatch_requests (id, nl_intent, status, created_at)
           VALUES (?, 'intent', ?, 0)`
        ).run(`dr${idx}`, status)
      ).not.toThrow();
    }
  });
});

describe('006-conflicts-pending-review schema', () => {
  it('allows PENDING_REVIEW as a valid conflicts.status', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, paths_json, status)
         VALUES ('pr1', 0, 'FILE_OVERLAP', 'agent-a', '[]', 'PENDING_REVIEW')`
      ).run()
    ).not.toThrow();
  });

  it('still rejects unknown status values after migration 006', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, paths_json, status)
         VALUES ('bad1', 0, 'FILE_OVERLAP', 'agent-a', '[]', 'NOT_A_STATUS')`
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });

  it('preserves existing conflict rows through the rebuild', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    // A row inserted after migration 006 with OPEN status should still be readable
    db.prepare(
      `INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, paths_json, status)
       VALUES ('keep1', 100, 'STATE_CONFLICT', 'a1', '["x.ts"]', 'OPEN')`
    ).run();
    const row = db.prepare('SELECT status FROM conflicts WHERE id = ?').get('keep1') as { status: string };
    expect(row.status).toBe('OPEN');
  });
});

describe('007-tasks schema', () => {
  it('creates tasks table with correct columns and NOT NULL constraints', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as Array<{
      name: string; pk: number; notnull: number; type: string;
    }>;
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames).toEqual(new Set([
      'task_id', 'intent', 'state', 'parent_task_id',
      'created_at', 'updated_at', 'created_by_agent_id', 'metadata_json',
    ]));
    // task_id is PK
    expect(cols.find((c) => c.name === 'task_id')?.pk).toBe(1);
    // NOT NULL columns
    expect(cols.find((c) => c.name === 'intent')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'state')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'created_at')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'updated_at')?.notnull).toBe(1);
    // nullable columns
    expect(cols.find((c) => c.name === 'parent_task_id')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'created_by_agent_id')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'metadata_json')?.notnull).toBe(0);
    // timestamp columns are INTEGER
    expect(cols.find((c) => c.name === 'created_at')?.type).toBe('INTEGER');
    expect(cols.find((c) => c.name === 'updated_at')?.type).toBe('INTEGER');
  });

  it('creates all three required indexes on tasks', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_tasks_state');
    expect(names).toContain('idx_tasks_parent');
    expect(names).toContain('idx_tasks_created_at');
  });

  it('accepts all 8 valid state values', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const states = [
      'PENDING', 'RUNNING', 'BLOCKED', 'READY_TO_RESUME',
      'WAITING_REVIEW', 'DONE', 'FAILED', 'CANCELLED',
    ] as const;
    for (const [idx, state] of states.entries()) {
      expect(() =>
        db.prepare(
          `INSERT INTO tasks (task_id, intent, state, created_at, updated_at)
           VALUES (?, 'test intent', ?, 0, 0)`
        ).run(`t${idx}`, state)
      ).not.toThrow();
    }
  });

  it('rejects invalid state values (CHECK constraint)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO tasks (task_id, intent, state, created_at, updated_at)
         VALUES ('tbad', 'test intent', 'NOT_A_STATE', 0, 0)`
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });

  it('supports self-referential parent_task_id (tree structure)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    db.prepare(
      `INSERT INTO tasks (task_id, intent, state, created_at, updated_at)
       VALUES ('root', 'root task', 'PENDING', 1000, 1000)`
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO tasks (task_id, intent, state, parent_task_id, created_at, updated_at)
         VALUES ('child', 'child task', 'PENDING', 'root', 2000, 2000)`
      ).run()
    ).not.toThrow();
    const child = db.prepare('SELECT parent_task_id FROM tasks WHERE task_id = ?').get('child') as { parent_task_id: string };
    expect(child.parent_task_id).toBe('root');
  });

  it('migration 007 is idempotent (running ALL_MIGRATIONS twice is a no-op)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    runMigrations(db, ALL_MIGRATIONS);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 7')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('008-dispatch-task-id schema', () => {
  it('dispatch_requests has task_id column: TEXT, nullable', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const cols = db.prepare('PRAGMA table_info(dispatch_requests)').all() as Array<{
      name: string; type: string; notnull: number;
    }>;
    const taskIdCol = cols.find((c) => c.name === 'task_id');
    expect(taskIdCol).toBeDefined();
    expect(taskIdCol?.type).toBe('TEXT');
    expect(taskIdCol?.notnull).toBe(0); // nullable
  });

  it('idx_dispatch_requests_task_id index exists', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dispatch_requests'")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_dispatch_requests_task_id');
  });

  it('inserting a row with task_id = NULL succeeds (legacy compat)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO dispatch_requests (id, nl_intent, status, created_at)
         VALUES ('dr-null', 'legacy intent', 'PENDING', 0)`
      ).run()
    ).not.toThrow();
    const row = db.prepare('SELECT task_id FROM dispatch_requests WHERE id = ?').get('dr-null') as { task_id: string | null };
    expect(row.task_id).toBeNull();
  });

  it('inserting a row with a valid task_id succeeds and round-trips', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    // Create the referenced task first
    db.prepare(
      `INSERT INTO tasks (task_id, intent, state, created_at, updated_at)
       VALUES ('task-001', 'test task', 'PENDING', 1000, 1000)`
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO dispatch_requests (id, nl_intent, status, created_at, task_id)
         VALUES ('dr-with-task', 'intent with task', 'PENDING', 0, 'task-001')`
      ).run()
    ).not.toThrow();
    const row = db.prepare('SELECT task_id FROM dispatch_requests WHERE id = ?').get('dr-with-task') as { task_id: string | null };
    expect(row.task_id).toBe('task-001');
  });

  // FK is enforced in SQLite 3.53.0 with better-sqlite3@^12.9.0 (foreign_keys = ON set in db.ts).
  // ALTER TABLE ADD COLUMN ... REFERENCES tasks(task_id) ON DELETE SET NULL is accepted and enforced.
  it('inserting with a nonexistent task_id throws (FK enforced in SQLite 3.53.0)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO dispatch_requests (id, nl_intent, status, created_at, task_id)
         VALUES ('dr-bad-task', 'intent', 'PENDING', 0, 'NONEXISTENT_TASK')`
      ).run()
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  // Zero-regression assertions: scratchpad and checkpoints task_id columns must still exist
  it('scratchpad.task_id column still exists after migration 008', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const cols = db.prepare('PRAGMA table_info(scratchpad)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('task_id');
  });

  it('checkpoints.task_id column still exists after migration 008', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const cols = db.prepare('PRAGMA table_info(checkpoints)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('task_id');
  });

  it('idx_scratchpad_task_id index still exists after migration 008', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='scratchpad'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('idx_scratchpad_task_id');
  });

  it('idx_checkpoints_task_id index still exists after migration 008', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='checkpoints'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('idx_checkpoints_task_id');
  });

  it('migration 008 is idempotent (running ALL_MIGRATIONS twice is a no-op)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    runMigrations(db, ALL_MIGRATIONS);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 8')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('009-blockers schema', () => {
  it('creates blockers table with correct columns and NOT NULL constraints', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const cols = db.prepare('PRAGMA table_info(blockers)').all() as Array<{
      name: string; pk: number; notnull: number; type: string;
    }>;
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames).toEqual(new Set([
      'blocker_id', 'task_id', 'question', 'context_keys',
      'status', 'raised_by', 'raised_at',
      'answer', 'answered_by', 'answered_at', 'metadata_json',
    ]));
    // blocker_id is PK
    expect(cols.find((c) => c.name === 'blocker_id')?.pk).toBe(1);
    // NOT NULL columns
    expect(cols.find((c) => c.name === 'task_id')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'question')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'status')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'raised_at')?.notnull).toBe(1);
    // nullable columns
    expect(cols.find((c) => c.name === 'context_keys')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'raised_by')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'answer')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'answered_by')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'answered_at')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'metadata_json')?.notnull).toBe(0);
    // raised_at is INTEGER
    expect(cols.find((c) => c.name === 'raised_at')?.type).toBe('INTEGER');
  });

  it('creates idx_blockers_task and idx_blockers_status indexes', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='blockers'")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_blockers_task');
    expect(names).toContain('idx_blockers_status');
  });

  it('CHECK constraint accepts all 3 valid status values (OPEN, ANSWERED, SUPERSEDED)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    db.prepare(
      `INSERT INTO tasks (task_id, intent, state, created_at, updated_at)
       VALUES ('t-check', 'test', 'PENDING', 0, 0)`
    ).run();
    for (const [idx, status] of (['OPEN', 'ANSWERED', 'SUPERSEDED'] as const).entries()) {
      expect(() =>
        db.prepare(
          `INSERT INTO blockers (blocker_id, task_id, question, status, raised_at)
           VALUES (?, 't-check', 'Is this ok?', ?, 0)`
        ).run(`b-check-${idx}`, status)
      ).not.toThrow();
    }
  });

  it('CHECK constraint rejects invalid status values', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    db.prepare(
      `INSERT INTO tasks (task_id, intent, state, created_at, updated_at)
       VALUES ('t-bad-status', 'test', 'PENDING', 0, 0)`
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO blockers (blocker_id, task_id, question, status, raised_at)
         VALUES ('b-bad', 't-bad-status', 'question?', 'INVALID_STATUS', 0)`
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });

  it('CASCADE: deleting a task auto-deletes its blockers', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    db.prepare(
      `INSERT INTO tasks (task_id, intent, state, created_at, updated_at)
       VALUES ('t-cascade', 'test', 'PENDING', 0, 0)`
    ).run();
    db.prepare(
      `INSERT INTO blockers (blocker_id, task_id, question, status, raised_at)
       VALUES ('b-cascade-1', 't-cascade', 'Question A?', 'OPEN', 1000)`
    ).run();
    db.prepare(
      `INSERT INTO blockers (blocker_id, task_id, question, status, raised_at)
       VALUES ('b-cascade-2', 't-cascade', 'Question B?', 'OPEN', 2000)`
    ).run();

    const before = db.prepare('SELECT COUNT(*) AS n FROM blockers WHERE task_id = ?').get('t-cascade') as { n: number };
    expect(before.n).toBe(2);

    db.prepare('DELETE FROM tasks WHERE task_id = ?').run('t-cascade');

    const after = db.prepare('SELECT COUNT(*) AS n FROM blockers WHERE task_id = ?').get('t-cascade') as { n: number };
    expect(after.n).toBe(0);
  });

  it('FK enforcement: inserting a blocker with a nonexistent task_id throws', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO blockers (blocker_id, task_id, question, status, raised_at)
         VALUES ('b-fk-fail', 'NONEXISTENT_TASK', 'Will this work?', 'OPEN', 0)`
      ).run()
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('migration 009 is idempotent (running ALL_MIGRATIONS twice is a no-op)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    runMigrations(db, ALL_MIGRATIONS);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 9')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('010-outcomes schema', () => {
  it('creates outcomes table with all 11 columns and correct NOT NULL / type constraints', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const cols = db.prepare('PRAGMA table_info(outcomes)').all() as Array<{
      name: string; pk: number; notnull: number; type: string;
    }>;
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames).toEqual(new Set([
      'outcome_id', 'task_id', 'criteria_json', 'status',
      'evaluated_at', 'evaluation_summary', 'grader_agent_id',
      'created_at', 'updated_at', 'metadata_json',
    ]));
    // outcome_id is PK
    expect(cols.find((c) => c.name === 'outcome_id')?.pk).toBe(1);
    // NOT NULL columns
    expect(cols.find((c) => c.name === 'task_id')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'criteria_json')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'status')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'created_at')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'updated_at')?.notnull).toBe(1);
    // nullable columns
    expect(cols.find((c) => c.name === 'evaluated_at')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'evaluation_summary')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'grader_agent_id')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'metadata_json')?.notnull).toBe(0);
    // timestamp columns are INTEGER
    expect(cols.find((c) => c.name === 'created_at')?.type).toBe('INTEGER');
    expect(cols.find((c) => c.name === 'updated_at')?.type).toBe('INTEGER');
  });

  it('idx_outcomes_status index exists', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='outcomes'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('idx_outcomes_status');
  });

  it('CHECK accepts all 4 valid status values (PENDING, PASS, FAIL, TERMINAL_FAIL)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    for (const [idx, status] of (['PENDING', 'PASS', 'FAIL', 'TERMINAL_FAIL'] as const).entries()) {
      db.prepare(
        `INSERT INTO tasks (task_id, intent, state, created_at, updated_at)
         VALUES (?, 'test intent', 'PENDING', 0, 0)`
      ).run(`t-check-${idx}`);
      expect(() =>
        db.prepare(
          `INSERT INTO outcomes (outcome_id, task_id, criteria_json, status, created_at, updated_at)
           VALUES (?, ?, '[]', ?, 0, 0)`
        ).run(`o-check-${idx}`, `t-check-${idx}`, status)
      ).not.toThrow();
    }
  });

  it('CHECK rejects an invalid status value', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    db.prepare(
      `INSERT INTO tasks (task_id, intent, state, created_at, updated_at)
       VALUES ('t-bad-status', 'test', 'PENDING', 0, 0)`
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO outcomes (outcome_id, task_id, criteria_json, status, created_at, updated_at)
         VALUES ('o-bad', 't-bad-status', '[]', 'INVALID', 0, 0)`
      ).run()
    ).toThrow(/CHECK constraint failed/);
  });

  it('UNIQUE(task_id): inserting a second outcome for the same task throws', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    db.prepare(
      `INSERT INTO tasks (task_id, intent, state, created_at, updated_at)
       VALUES ('t-unique', 'test', 'PENDING', 0, 0)`
    ).run();
    db.prepare(
      `INSERT INTO outcomes (outcome_id, task_id, criteria_json, status, created_at, updated_at)
       VALUES ('o-unique-1', 't-unique', '[]', 'PENDING', 0, 0)`
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO outcomes (outcome_id, task_id, criteria_json, status, created_at, updated_at)
         VALUES ('o-unique-2', 't-unique', '[]', 'PASS', 0, 0)`
      ).run()
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('CASCADE: deleting a task auto-deletes its outcome', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    db.prepare(
      `INSERT INTO tasks (task_id, intent, state, created_at, updated_at)
       VALUES ('t-cascade', 'test', 'PENDING', 0, 0)`
    ).run();
    db.prepare(
      `INSERT INTO outcomes (outcome_id, task_id, criteria_json, status, created_at, updated_at)
       VALUES ('o-cascade', 't-cascade', '[]', 'PENDING', 0, 0)`
    ).run();

    db.prepare('DELETE FROM tasks WHERE task_id = ?').run('t-cascade');

    const after = db.prepare('SELECT COUNT(*) AS n FROM outcomes WHERE task_id = ?').get('t-cascade') as { n: number };
    expect(after.n).toBe(0);
  });

  it('FK enforcement: inserting an outcome with a nonexistent task_id throws', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    expect(() =>
      db.prepare(
        `INSERT INTO outcomes (outcome_id, task_id, criteria_json, status, created_at, updated_at)
         VALUES ('o-fk-fail', 'NOT_A_TASK', '[]', 'PENDING', 0, 0)`
      ).run()
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('migration 010 is idempotent (running ALL_MIGRATIONS twice is a no-op)', () => {
    const { db } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);
    runMigrations(db, ALL_MIGRATIONS);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 10')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});
