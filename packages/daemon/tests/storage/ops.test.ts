import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import { createLane } from '../../src/storage/repositories/lanes.js';
import { appendOp, listOpsByLane } from '../../src/storage/repositories/ops.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
let dir: string;
beforeEach(() => {
  ({ db, dir } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
});

describe('ops.appendOp', () => {
  it('auto-assigns sequential seq numbers starting at 0', () => {
    const lane = createLane(db, { endpoint: 'e' });
    const op1 = appendOp(db, dir, lane.id, {
      method: 'PATCH',
      url: 'http://x/1',
      classification: 'SAFE_REVERT',
    });
    const op2 = appendOp(db, dir, lane.id, {
      method: 'PATCH',
      url: 'http://x/2',
      classification: 'SEMANTIC_REVERT',
    });
    expect(op1.seq).toBe(0);
    expect(op2.seq).toBe(1);
  });

  it('inlines small before_image as JSON', () => {
    const lane = createLane(db, { endpoint: 'e' });
    const op = appendOp(db, dir, lane.id, {
      method: 'GET',
      url: 'http://x',
      classification: 'SAFE_REVERT',
      before_image: { title: 'X' },
    });
    expect(op.before_image_json).toBe('{"title":"X"}');
    expect(op.before_image_path).toBeNull();
  });

  it('spills large before_image to blob file', () => {
    const lane = createLane(db, { endpoint: 'e' });
    const op = appendOp(db, dir, lane.id, {
      method: 'GET',
      url: 'http://x',
      classification: 'SAFE_REVERT',
      before_image: { data: 'x'.repeat(200_000) },
    });
    expect(op.before_image_json).toBeNull();
    expect(op.before_image_path).toMatch(/blobs[\\/]/);
  });
});

describe('ops.listOpsByLane', () => {
  it('returns ops in seq ASC order', () => {
    const lane = createLane(db, { endpoint: 'e' });
    appendOp(db, dir, lane.id, { method: 'A', url: 'u', classification: 'SAFE_REVERT' });
    appendOp(db, dir, lane.id, { method: 'B', url: 'u', classification: 'SAFE_REVERT' });
    appendOp(db, dir, lane.id, { method: 'C', url: 'u', classification: 'SAFE_REVERT' });
    const ops = listOpsByLane(db, lane.id);
    expect(ops.map((o) => o.method)).toEqual(['A', 'B', 'C']);
  });
});
