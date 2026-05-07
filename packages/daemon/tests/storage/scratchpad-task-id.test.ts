import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import { putScratch } from '../../src/storage/repositories/scratchpad.js';
import type { Database as DB } from 'better-sqlite3';

// Verify-only: scratchpad.ts must NOT be modified. These tests document existing
// behavior for the task_id column (migrations 002/003, no FK — historical debt).

let db: DB;
let dir: string;
beforeEach(() => {
  ({ db, dir } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
});

describe('scratchpad task_id (verify existing behavior — no source change)', () => {
  it('putScratch with task_id → reads back via raw SQL and value matches', () => {
    putScratch(db, dir, { key: 'task-note:1', value: 'hello', task_id: 'task-abc' });
    const row = db
      .prepare('SELECT task_id FROM scratchpad WHERE key = ?')
      .get('task-note:1') as { task_id: string | null } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.task_id).toBe('task-abc');
  });

  it('putScratch without task_id → reads back as null (legacy)', () => {
    putScratch(db, dir, { key: 'legacy-note:1', value: 42 });
    const row = db
      .prepare('SELECT task_id FROM scratchpad WHERE key = ?')
      .get('legacy-note:1') as { task_id: string | null } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.task_id).toBeNull();
  });

  it('putScratch with nonexistent task_id → succeeds (no FK on this column — historical debt)', () => {
    // scratchpad.task_id has no FK constraint (migration 002 omitted it).
    // This is documented historical debt: LD-3 says W5 does not add FK here.
    expect(() =>
      putScratch(db, dir, { key: 'orphan-note:1', value: true, task_id: 'does-not-exist' })
    ).not.toThrow();
    const row = db
      .prepare('SELECT task_id FROM scratchpad WHERE key = ?')
      .get('orphan-note:1') as { task_id: string | null } | undefined;
    expect(row!.task_id).toBe('does-not-exist');
  });
});
