import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import { importPocLane } from '../../src/scripts/import-poc.js';

describe('importPocLane', () => {
  it('converts a PoC JSON into lanes+ops+compensations', () => {
    const { db, dir } = makeTmpDb();
    runMigrations(db, ALL_MIGRATIONS);

    const poc = {
      laneId: 'lane-1776754921225-ijtcpy',
      endpoint: 'github.issue.patch',
      target: 'http://127.0.0.1:4101/repos/octo/demo/issues/1',
      createdAt: '2026-04-21T07:02:01.261Z',
      compensator: { method: 'PATCH', url: 'http://x', body: { title: 'X' } },
      forwardRequest: { method: 'PATCH', body: { title: 'X' } },
      forwardResponse: { status: 200, body: { number: 1, title: 'X' } },
      beforeImage: { number: 1, title: 'X' },
    };
    const file = join(dir, 'lane.json');
    writeFileSync(file, JSON.stringify(poc));

    importPocLane(db, dir, file, '01-github-issue');

    const lane = db.prepare('SELECT * FROM lanes WHERE id = ?').get(poc.laneId) as any;
    expect(lane.endpoint).toBe(poc.endpoint);
    expect(lane.scenario).toBe('01-github-issue');
    expect(lane.state).toBe('RECORDED');

    const ops = db.prepare('SELECT * FROM ops WHERE lane_id = ?').all(poc.laneId) as any[];
    expect(ops).toHaveLength(1);
    expect(ops[0].classification).toBe('SAFE_REVERT');

    const comps = db.prepare('SELECT * FROM compensations WHERE op_id = ?').all(ops[0].id) as any[];
    expect(comps).toHaveLength(1);
    expect(comps[0].strategy).toBe('reverse_http');
  });
});
