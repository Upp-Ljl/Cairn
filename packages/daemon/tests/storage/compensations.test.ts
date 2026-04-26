import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import { createLane } from '../../src/storage/repositories/lanes.js';
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

function seed() {
  const lane = createLane(db, { endpoint: 'e' });
  const op = appendOp(db, dir, lane.id, {
    method: 'PATCH', url: 'u', classification: 'SAFE_REVERT',
  });
  return { lane, op };
}

describe('compensations.createCompensation', () => {
  it('creates PENDING comp with attempt=0', () => {
    const { op } = seed();
    const c = createCompensation(db, dir, op.id, {
      strategy: 'reverse_http',
      payload: { method: 'PATCH', url: 'u', body: { title: 'Y' } },
    });
    expect(c.status).toBe('PENDING');
    expect(c.attempt).toBe(0);
    expect(c.max_attempts).toBe(3);
    expect(c.payload_json).toContain('reverse_http' === c.strategy ? 'title' : '');
  });
});

describe('compensations.markCompensationInProgress', () => {
  it('sets status and increments attempt', () => {
    const { op } = seed();
    const c = createCompensation(db, dir, op.id, { strategy: 'reverse_http' });
    markCompensationInProgress(db, c.id);
    const row = db.prepare('SELECT * FROM compensations WHERE id = ?').get(c.id) as any;
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.attempt).toBe(1);
    expect(row.last_attempt_at).toBeGreaterThan(0);
  });
});

describe('compensations.markCompensationResult', () => {
  it('ok=true sets SUCCESS', () => {
    const { op } = seed();
    const c = createCompensation(db, dir, op.id, { strategy: 'reverse_http' });
    markCompensationInProgress(db, c.id);
    markCompensationResult(db, c.id, true);
    const row = db.prepare('SELECT * FROM compensations WHERE id = ?').get(c.id) as any;
    expect(row.status).toBe('SUCCESS');
    expect(row.last_error).toBeNull();
  });

  it('ok=false sets FAILED and records error', () => {
    const { op } = seed();
    const c = createCompensation(db, dir, op.id, { strategy: 'reverse_http' });
    markCompensationInProgress(db, c.id);
    markCompensationResult(db, c.id, false, 'HTTP 500');
    const row = db.prepare('SELECT * FROM compensations WHERE id = ?').get(c.id) as any;
    expect(row.status).toBe('FAILED');
    expect(row.last_error).toBe('HTTP 500');
  });
});

describe('compensations.listPendingCompensationsByLane', () => {
  it('returns PENDING + FAILED comps joined via ops on lane', () => {
    const lane = createLane(db, { endpoint: 'e' });
    const op1 = appendOp(db, dir, lane.id, { method: 'A', url: 'u', classification: 'SAFE_REVERT' });
    const op2 = appendOp(db, dir, lane.id, { method: 'B', url: 'u', classification: 'SAFE_REVERT' });
    const c1 = createCompensation(db, dir, op1.id, { strategy: 's' });
    const c2 = createCompensation(db, dir, op2.id, { strategy: 's' });
    markCompensationInProgress(db, c2.id);
    markCompensationResult(db, c2.id, true);

    const pending = listPendingCompensationsByLane(db, lane.id);
    expect(pending.map((c) => c.id)).toEqual([c1.id]);
  });
});

describe('compensations.listPendingCompensationsByLane retry exhaustion', () => {
  it('excludes FAILED comp when attempt >= max_attempts', () => {
    const lane = createLane(db, { endpoint: 'e' });
    const op = appendOp(db, dir, lane.id, {
      method: 'PATCH', url: 'u', classification: 'SAFE_REVERT',
    });
    // Create comp with max_attempts=2 so we can exhaust it quickly
    const c = createCompensation(db, dir, op.id, {
      strategy: 'reverse_http',
      max_attempts: 2,
    });

    // Attempt 1: in-progress -> failed (attempt becomes 1)
    markCompensationInProgress(db, c.id);
    markCompensationResult(db, c.id, false, 'first failure');
    // Still retriable (attempt=1, max_attempts=2)
    expect(listPendingCompensationsByLane(db, lane.id)).toHaveLength(1);

    // Attempt 2: in-progress -> failed (attempt becomes 2, equal to max)
    markCompensationInProgress(db, c.id);
    markCompensationResult(db, c.id, false, 'second failure');
    // Now attempt == max_attempts: should NOT appear
    expect(listPendingCompensationsByLane(db, lane.id)).toHaveLength(0);
  });

  it('still includes PENDING comps regardless of attempt count', () => {
    const lane = createLane(db, { endpoint: 'e' });
    const op = appendOp(db, dir, lane.id, {
      method: 'PATCH', url: 'u', classification: 'SAFE_REVERT',
    });
    const c = createCompensation(db, dir, op.id, {
      strategy: 'reverse_http',
      max_attempts: 1,
    });
    // Brand-new PENDING with attempt=0, max=1 — clearly retriable
    expect(listPendingCompensationsByLane(db, lane.id).map((r) => r.id))
      .toEqual([c.id]);
  });
});
