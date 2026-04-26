import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import {
  createPendingCheckpoint,
  markCheckpointReady,
  listCheckpoints,
  getCheckpointById,
} from '../../src/storage/repositories/checkpoints.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
beforeEach(() => {
  ({ db } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
});

describe('checkpoints repo (git-stash path)', () => {
  it('createPendingCheckpoint returns ULID id with status=PENDING', () => {
    const c = createPendingCheckpoint(db, {
      label: 'before-refactor',
      snapshot_dir: '/tmp/cairn-snap/abc',
    });
    expect(c.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(c.snapshot_status).toBe('PENDING');
    expect(c.label).toBe('before-refactor');
    expect(c.ready_at).toBeNull();
    expect(c.git_head).toBeNull();
    expect(c.size_bytes).toBeNull();
    expect(c.task_id).toBeNull();
  });

  it('createPendingCheckpoint accepts optional task_id', () => {
    const c = createPendingCheckpoint(db, {
      task_id: 'T1',
      snapshot_dir: '/tmp/x',
    });
    expect(c.task_id).toBe('T1');
  });

  it('markCheckpointReady flips PENDING -> READY with size_bytes + git_head + ready_at', () => {
    const c = createPendingCheckpoint(db, { snapshot_dir: '/tmp/x' });
    markCheckpointReady(db, c.id, { size_bytes: 1234, git_head: 'abcdef0' });
    const fetched = getCheckpointById(db, c.id)!;
    expect(fetched.snapshot_status).toBe('READY');
    expect(fetched.size_bytes).toBe(1234);
    expect(fetched.git_head).toBe('abcdef0');
    expect(fetched.ready_at).toBeGreaterThan(0);
  });

  it('markCheckpointReady is idempotent-but-CAS-protected: only flips PENDING', () => {
    const c = createPendingCheckpoint(db, { snapshot_dir: '/tmp/x' });
    markCheckpointReady(db, c.id, { size_bytes: 100, git_head: null });
    const after1 = getCheckpointById(db, c.id)!;

    // Second call should not corrupt the row (CAS guard on snapshot_status='PENDING')
    markCheckpointReady(db, c.id, { size_bytes: 999, git_head: 'changed' });
    const after2 = getCheckpointById(db, c.id)!;
    expect(after2.size_bytes).toBe(100); // unchanged
    expect(after2.git_head).toBe(after1.git_head);
    expect(after2.ready_at).toBe(after1.ready_at);
  });

  it('getCheckpointById returns null for unknown id', () => {
    expect(getCheckpointById(db, 'nope')).toBeNull();
  });

  it('listCheckpoints orders by created_at DESC', () => {
    const c1 = createPendingCheckpoint(db, { snapshot_dir: '/tmp/1', label: 'first' });
    const c2 = createPendingCheckpoint(db, { snapshot_dir: '/tmp/2', label: 'second' });
    const list = listCheckpoints(db);
    // Newest first
    expect(list[0]!.id).toBe(c2.id);
    expect(list[1]!.id).toBe(c1.id);
  });

  it('listCheckpoints filters by status', () => {
    const c1 = createPendingCheckpoint(db, { snapshot_dir: '/tmp/1' });
    const c2 = createPendingCheckpoint(db, { snapshot_dir: '/tmp/2' });
    markCheckpointReady(db, c2.id, { size_bytes: 0, git_head: null });

    const ready = listCheckpoints(db, 'READY');
    expect(ready.map((c) => c.id)).toEqual([c2.id]);

    const pending = listCheckpoints(db, 'PENDING');
    expect(pending.map((c) => c.id)).toEqual([c1.id]);

    const corrupted = listCheckpoints(db, 'CORRUPTED');
    expect(corrupted).toHaveLength(0);
  });
});
