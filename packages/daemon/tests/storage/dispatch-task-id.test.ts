import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import {
  createDispatchRequest,
  getDispatchRequest,
} from '../../src/storage/repositories/dispatch-requests.js';
import { createTask } from '../../src/storage/repositories/tasks.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
beforeEach(() => {
  ({ db } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
});

describe('dispatch_requests.task_id (migration 008)', () => {
  it('createDispatchRequest without taskId → task_id is null (legacy compat)', () => {
    const { id } = createDispatchRequest(db, { nlIntent: 'legacy request' });
    const req = getDispatchRequest(db, id);
    expect(req).not.toBeNull();
    expect(req!.task_id).toBeNull();
  });

  it('createDispatchRequest with valid taskId → round-trips correctly', () => {
    const task = createTask(db, { intent: 'parent task for dispatch' });
    const { id } = createDispatchRequest(db, {
      nlIntent: 'task-scoped dispatch',
      taskId: task.task_id,
    });
    const req = getDispatchRequest(db, id);
    expect(req).not.toBeNull();
    expect(req!.task_id).toBe(task.task_id);
  });

  it('createDispatchRequest with nonexistent taskId → throws FOREIGN KEY constraint failed', () => {
    expect(() =>
      createDispatchRequest(db, {
        nlIntent: 'orphan dispatch',
        taskId: 'nonexistent-task-id',
      })
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});
