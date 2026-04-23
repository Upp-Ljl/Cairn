import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import { createLane, getLaneById, listLanesByTask, acquireLaneLock, releaseLaneLock, transitionLaneState } from '../../src/storage/repositories/lanes.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
beforeEach(() => {
  ({ db } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
});

describe('lanes.createLane + getLaneById', () => {
  it('persists and reads back a minimal lane', () => {
    const lane = createLane(db, {
      endpoint: 'github.issue.patch',
      scenario: '01-github-issue',
    });
    expect(lane.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(lane.state).toBe('RECORDED');
    expect(lane.endpoint).toBe('github.issue.patch');

    const found = getLaneById(db, lane.id);
    expect(found).toEqual(lane);
  });

  it('returns null for unknown id', () => {
    expect(getLaneById(db, 'does-not-exist')).toBeNull();
  });

  it('allows explicit task_id / sub_agent_id / checkpoint_id to be null', () => {
    const lane = createLane(db, { endpoint: 'e' });
    expect(lane.task_id).toBeNull();
    expect(lane.sub_agent_id).toBeNull();
    expect(lane.checkpoint_id).toBeNull();
  });
});

describe('lanes.listLanesByTask', () => {
  it('filters by task_id and state', () => {
    createLane(db, { endpoint: 'a', task_id: 'T1' });
    createLane(db, { endpoint: 'b', task_id: 'T1' });
    createLane(db, { endpoint: 'c', task_id: 'T2' });

    const t1 = listLanesByTask(db, 'T1');
    expect(t1).toHaveLength(2);
    expect(new Set(t1.map((l) => l.endpoint))).toEqual(new Set(['a', 'b']));

    const empty = listLanesByTask(db, 'T1', 'REVERTED');
    expect(empty).toHaveLength(0);
  });

  it('taskId=null selects lanes with NULL task_id', () => {
    createLane(db, { endpoint: 'x' });
    createLane(db, { endpoint: 'y', task_id: 'T1' });
    const nulls = listLanesByTask(db, null);
    expect(nulls).toHaveLength(1);
    expect(nulls[0]!.endpoint).toBe('x');
  });
});

describe('lanes lock', () => {
  it('acquireLaneLock succeeds on free lane, fails when held and unexpired', () => {
    const lane = createLane(db, { endpoint: 'e' });
    expect(acquireLaneLock(db, lane.id, 'daemon@1', 60_000)).toBe(true);
    expect(acquireLaneLock(db, lane.id, 'daemon@2', 60_000)).toBe(false);
  });

  it('acquireLaneLock succeeds when existing lock is expired', () => {
    const lane = createLane(db, { endpoint: 'e' });
    expect(acquireLaneLock(db, lane.id, 'daemon@1', -1)).toBe(true);
    // simulate time passing by writing expired lock directly
    db.prepare('UPDATE lanes SET lock_expires_at = 1 WHERE id = ?').run(lane.id);
    expect(acquireLaneLock(db, lane.id, 'daemon@2', 60_000)).toBe(true);
    expect(getLaneById(db, lane.id)!.lock_holder).toBe('daemon@2');
  });

  it('releaseLaneLock clears holder only when matching', () => {
    const lane = createLane(db, { endpoint: 'e' });
    acquireLaneLock(db, lane.id, 'daemon@1', 60_000);

    releaseLaneLock(db, lane.id, 'daemon@WRONG');
    expect(getLaneById(db, lane.id)!.lock_holder).toBe('daemon@1');

    releaseLaneLock(db, lane.id, 'daemon@1');
    expect(getLaneById(db, lane.id)!.lock_holder).toBeNull();
  });
});

describe('lanes.transitionLaneState', () => {
  it('returns true when from matches current', () => {
    const lane = createLane(db, { endpoint: 'e' });
    expect(transitionLaneState(db, lane.id, 'RECORDED', 'REVERTING')).toBe(true);
    expect(getLaneById(db, lane.id)!.state).toBe('REVERTING');
  });

  it('returns false when from does not match', () => {
    const lane = createLane(db, { endpoint: 'e' });
    expect(transitionLaneState(db, lane.id, 'REVERTING', 'REVERTED')).toBe(false);
    expect(getLaneById(db, lane.id)!.state).toBe('RECORDED');
  });

  it('only one of two concurrent transitions from same state wins', () => {
    const lane = createLane(db, { endpoint: 'e' });
    const a = transitionLaneState(db, lane.id, 'RECORDED', 'REVERTING');
    const b = transitionLaneState(db, lane.id, 'RECORDED', 'FAILED_RETRYABLE');
    expect([a, b].sort()).toEqual([false, true]);
    expect(getLaneById(db, lane.id)!.state).toBe('REVERTING');
  });
});
