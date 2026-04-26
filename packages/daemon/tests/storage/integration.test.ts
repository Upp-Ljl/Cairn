import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import {
  createLane, acquireLaneLock, transitionLaneState, getLaneById,
} from '../../src/storage/repositories/lanes.js';
import { appendOp } from '../../src/storage/repositories/ops.js';
import {
  createCompensation,
  markCompensationInProgress,
  markCompensationResult,
  listPendingCompensationsByLane,
} from '../../src/storage/repositories/compensations.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
let dir: string;
beforeEach(() => {
  ({ db, dir } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
});

describe('happy-path revert flow', () => {
  it('records 2 ops then reverts lane to REVERTED', () => {
    // 1. record
    const lane = createLane(db, { endpoint: 'github.issue.patch', scenario: '01-github-issue' });
    const op1 = appendOp(db, dir, lane.id, {
      method: 'PATCH', url: 'http://x/1',
      classification: 'SAFE_REVERT',
      before_image: { title: 'old' },
    });
    const op2 = appendOp(db, dir, lane.id, {
      method: 'PATCH', url: 'http://x/2',
      classification: 'SAFE_REVERT',
      before_image: { title: 'older' },
    });
    const c1 = createCompensation(db, dir, op1.id, { strategy: 'reverse_http' });
    const c2 = createCompensation(db, dir, op2.id, { strategy: 'reverse_http' });

    // 2. start revert: acquire lock + transition state
    expect(acquireLaneLock(db, lane.id, 'daemon@1', 60_000)).toBe(true);
    expect(transitionLaneState(db, lane.id, 'RECORDED', 'REVERTING')).toBe(true);

    // 3. execute each compensation (simulated outside tx)
    for (const c of listPendingCompensationsByLane(db, lane.id)) {
      markCompensationInProgress(db, c.id);
      // [real HTTP call would happen here]
      markCompensationResult(db, c.id, true);
    }

    // 4. finalize
    expect(listPendingCompensationsByLane(db, lane.id)).toHaveLength(0);
    expect(transitionLaneState(db, lane.id, 'REVERTING', 'REVERTED')).toBe(true);
    expect(getLaneById(db, lane.id)!.state).toBe('REVERTED');
  });
});
