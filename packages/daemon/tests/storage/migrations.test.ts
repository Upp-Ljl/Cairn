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
