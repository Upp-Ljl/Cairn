import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import { createLane, getLaneById, listLanesByTask } from '../../src/storage/repositories/lanes.js';
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
