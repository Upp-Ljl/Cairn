import { describe, it, expect } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations, type Migration } from '../../src/storage/migrations/runner.js';

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
