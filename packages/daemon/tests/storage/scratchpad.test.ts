import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import {
  putScratch, getScratch, listAllScratch, deleteScratch,
} from '../../src/storage/repositories/scratchpad.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
let dir: string;
beforeEach(() => {
  ({ db, dir } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
});

describe('scratchpad MVP', () => {
  it('put then get returns parsed value', () => {
    putScratch(db, dir, { key: 'note:1', value: { hello: 'world' } });
    expect(getScratch(db, 'note:1')).toEqual({ hello: 'world' });
  });

  it('put overwrites on duplicate key', () => {
    putScratch(db, dir, { key: 'k', value: 'a' });
    putScratch(db, dir, { key: 'k', value: 'b' });
    expect(getScratch(db, 'k')).toBe('b');
  });

  it('get returns null for missing key', () => {
    expect(getScratch(db, 'nope')).toBeNull();
  });

  it('listAllScratch returns rows ordered by updated_at DESC', () => {
    putScratch(db, dir, { key: 'a', value: 1 });
    putScratch(db, dir, { key: 'b', value: 2 });
    const items = listAllScratch(db);
    expect(items.map((i) => i.key)).toEqual(['b', 'a']);
  });

  it('deleteScratch removes the row', () => {
    putScratch(db, dir, { key: 'k', value: 1 });
    deleteScratch(db, 'k');
    expect(getScratch(db, 'k')).toBeNull();
  });

  it('large value (>128KB) spills to blob path', () => {
    const big = { data: 'x'.repeat(200_000) };
    putScratch(db, dir, { key: 'huge', value: big });
    expect(getScratch(db, 'huge')).toEqual(big);
    const row = db.prepare(
      'SELECT value_json, value_path FROM scratchpad WHERE key = ?'
    ).get('huge') as { value_json: string | null; value_path: string | null };
    expect(row.value_json).toBeNull();
    expect(row.value_path).toMatch(/blobs[\\/]/);
  });

  it('put accepts optional task_id and expires_at', () => {
    putScratch(db, dir, {
      key: 'k',
      value: 1,
      task_id: 'T1',
      expires_at: Date.now() + 3600_000,
    });
    const row = db.prepare('SELECT * FROM scratchpad WHERE key = ?').get('k') as any;
    expect(row.task_id).toBe('T1');
    expect(row.expires_at).toBeGreaterThan(Date.now());
  });
});
