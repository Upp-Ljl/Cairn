import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import { createLane, getLaneById } from '../../src/storage/repositories/lanes.js';
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
