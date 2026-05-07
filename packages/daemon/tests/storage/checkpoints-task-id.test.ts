import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import {
  createPendingCheckpoint,
  getCheckpointById,
} from '../../src/storage/repositories/checkpoints.js';
import type { Database as DB } from 'better-sqlite3';

// Verify-only: checkpoints.ts must NOT be modified. These tests document existing
// behavior for the task_id column (migration 003, no FK — historical debt).

let db: DB;
beforeEach(() => {
  ({ db } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
});

describe('checkpoints task_id (verify existing behavior — no source change)', () => {
  it('createPendingCheckpoint with task_id → reads back and matches', () => {
    const row = createPendingCheckpoint(db, {
      task_id: 'task-xyz',
      snapshot_dir: '/tmp/snap/a',
    });
    expect(row.task_id).toBe('task-xyz');
    const fetched = getCheckpointById(db, row.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.task_id).toBe('task-xyz');
  });

  it('createPendingCheckpoint without task_id → task_id is null (legacy)', () => {
    const row = createPendingCheckpoint(db, { snapshot_dir: '/tmp/snap/b' });
    expect(row.task_id).toBeNull();
    const fetched = getCheckpointById(db, row.id);
    expect(fetched!.task_id).toBeNull();
  });

  it('createPendingCheckpoint with nonexistent task_id → succeeds (no FK on this column — historical debt)', () => {
    // checkpoints.task_id has no FK constraint (migration 003 omitted it).
    // This is documented historical debt: LD-3 says W5 does not add FK here.
    expect(() =>
      createPendingCheckpoint(db, {
        task_id: 'does-not-exist',
        snapshot_dir: '/tmp/snap/c',
      })
    ).not.toThrow();
    const row = createPendingCheckpoint(db, {
      task_id: 'also-nonexistent',
      snapshot_dir: '/tmp/snap/d',
    });
    expect(row.task_id).toBe('also-nonexistent');
  });
});
