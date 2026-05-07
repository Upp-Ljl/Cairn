import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import {
  createTask,
  getTask,
  listTasks,
  updateTaskState,
  cancelTask,
  getTaskTree,
} from '../../src/storage/repositories/tasks.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
beforeEach(() => {
  ({ db } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
  // Enable FK enforcement (tasks table has self-referential FK)
  db.pragma('foreign_keys = ON');
});

// ---------------------------------------------------------------------------
// createTask + getTask round-trip
// ---------------------------------------------------------------------------

describe('createTask + getTask round-trip', () => {
  it('creates a task and returns full row with correct fields', () => {
    const before = Date.now();
    const row = createTask(db, { intent: 'refactor auth module' });
    const after = Date.now();

    expect(row.task_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(row.intent).toBe('refactor auth module');
    expect(row.state).toBe('PENDING');
    expect(row.parent_task_id).toBeNull();
    expect(row.created_by_agent_id).toBeNull();
    expect(row.metadata).toBeNull();
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    expect(row.created_at).toBeLessThanOrEqual(after);
    expect(row.updated_at).toBeGreaterThanOrEqual(before);
    expect(row.updated_at).toBeLessThanOrEqual(after);
    // created_at and updated_at are numbers (unix ms)
    expect(typeof row.created_at).toBe('number');
    expect(typeof row.updated_at).toBe('number');
  });

  it('metadata JSON serializes and deserializes correctly', () => {
    const metadata = { priority: 'high', tags: ['backend', 'auth'], nested: { key: 1 } };
    const row = createTask(db, { intent: 'build login', metadata });

    expect(row.metadata).toEqual(metadata);

    // Verify raw storage is a JSON string
    const raw = db
      .prepare('SELECT metadata_json FROM tasks WHERE task_id = ?')
      .get(row.task_id) as { metadata_json: string };
    expect(typeof raw.metadata_json).toBe('string');
    expect(JSON.parse(raw.metadata_json)).toEqual(metadata);
  });

  it('getTask returns null for unknown task_id', () => {
    expect(getTask(db, 'nonexistent-id')).toBeNull();
  });

  it('getTask round-trips all fields after createTask', () => {
    const input = {
      intent: 'deploy to production',
      created_by_agent_id: 'agent-abc',
      metadata: { environment: 'prod' },
    };
    const created = createTask(db, input);
    const fetched = getTask(db, created.task_id);

    expect(fetched).not.toBeNull();
    expect(fetched!.task_id).toBe(created.task_id);
    expect(fetched!.intent).toBe('deploy to production');
    expect(fetched!.state).toBe('PENDING');
    expect(fetched!.created_by_agent_id).toBe('agent-abc');
    expect(fetched!.metadata).toEqual({ environment: 'prod' });
  });
});

// ---------------------------------------------------------------------------
// createTask — initial state and parent_task_id behaviour
// ---------------------------------------------------------------------------

describe('createTask initial state', () => {
  it('initial state is always PENDING', () => {
    const row = createTask(db, { intent: 'some task' });
    expect(row.state).toBe('PENDING');
  });

  it('createTask with no parent_task_id → parent_task_id is null', () => {
    const row = createTask(db, { intent: 'root task' });
    expect(row.parent_task_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listTasks filters
// ---------------------------------------------------------------------------

describe('listTasks', () => {
  it('filter by single state', () => {
    const t1 = createTask(db, { intent: 'task 1' });
    const t2 = createTask(db, { intent: 'task 2' });
    updateTaskState(db, t2.task_id, 'RUNNING');

    const pending = listTasks(db, { state: 'PENDING' });
    expect(pending.map((t) => t.task_id)).toContain(t1.task_id);
    expect(pending.map((t) => t.task_id)).not.toContain(t2.task_id);

    const running = listTasks(db, { state: 'RUNNING' });
    expect(running.map((t) => t.task_id)).toContain(t2.task_id);
    expect(running.map((t) => t.task_id)).not.toContain(t1.task_id);
  });

  it('filter by array of states', () => {
    const t1 = createTask(db, { intent: 'task 1' });
    const t2 = createTask(db, { intent: 'task 2' });
    const t3 = createTask(db, { intent: 'task 3' });
    updateTaskState(db, t2.task_id, 'RUNNING');
    cancelTask(db, t3.task_id);

    const results = listTasks(db, { state: ['RUNNING', 'CANCELLED'] });
    const ids = results.map((t) => t.task_id);
    expect(ids).toContain(t2.task_id);
    expect(ids).toContain(t3.task_id);
    expect(ids).not.toContain(t1.task_id);
  });

  it('filter by parent_task_id: null returns root tasks only', () => {
    const root1 = createTask(db, { intent: 'root 1' });
    const root2 = createTask(db, { intent: 'root 2' });
    const child = createTask(db, { intent: 'child', parent_task_id: root1.task_id });

    const roots = listTasks(db, { parent_task_id: null });
    const ids = roots.map((t) => t.task_id);
    expect(ids).toContain(root1.task_id);
    expect(ids).toContain(root2.task_id);
    expect(ids).not.toContain(child.task_id);
  });

  it('limit parameter is respected', () => {
    createTask(db, { intent: 'task A' });
    createTask(db, { intent: 'task B' });
    createTask(db, { intent: 'task C' });

    const results = listTasks(db, { limit: 2 });
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// updateTaskState
// ---------------------------------------------------------------------------

describe('updateTaskState', () => {
  it('legal transition PENDING → RUNNING updates state and updated_at', () => {
    const row = createTask(db, { intent: 'work item' });
    const before = Date.now();
    const updated = updateTaskState(db, row.task_id, 'RUNNING');
    const after = Date.now();

    expect(updated.state).toBe('RUNNING');
    expect(updated.updated_at).toBeGreaterThanOrEqual(before);
    expect(updated.updated_at).toBeLessThanOrEqual(after);
    // updated_at should be >= created_at
    expect(updated.updated_at).toBeGreaterThanOrEqual(updated.created_at);
  });

  it('illegal transition PENDING → DONE throws via assertTransition', () => {
    const row = createTask(db, { intent: 'work item' });
    expect(() => updateTaskState(db, row.task_id, 'DONE')).toThrow(
      /Invalid task state transition: PENDING -> DONE/,
    );
  });

  it('updateTaskState does NOT touch metadata', () => {
    const meta = { note: 'original' };
    const row = createTask(db, { intent: 'task with meta', metadata: meta });
    updateTaskState(db, row.task_id, 'RUNNING');

    const fetched = getTask(db, row.task_id)!;
    expect(fetched.metadata).toEqual(meta);
  });

  it('throws for unknown task_id', () => {
    expect(() => updateTaskState(db, 'no-such-id', 'RUNNING')).toThrow(/task not found/);
  });
});

// ---------------------------------------------------------------------------
// cancelTask happy path
// ---------------------------------------------------------------------------

describe('cancelTask happy path', () => {
  it('cancels from PENDING: state → CANCELLED, metadata gets cancel_reason and cancelled_at', () => {
    const row = createTask(db, { intent: 'pending task' });
    expect(row.state).toBe('PENDING');

    const cancelled = cancelTask(db, row.task_id, 'user requested');
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.metadata).not.toBeNull();
    expect(cancelled.metadata!.cancel_reason).toBe('user requested');
    expect(typeof cancelled.metadata!.cancelled_at).toBe('number');
  });

  it('cancels from RUNNING: state → CANCELLED, metadata gets cancel_reason (null if no arg) and cancelled_at', () => {
    const row = createTask(db, { intent: 'running task' });
    updateTaskState(db, row.task_id, 'RUNNING');

    const cancelled = cancelTask(db, row.task_id);
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.metadata).not.toBeNull();
    expect(cancelled.metadata!.cancel_reason).toBeNull();
    expect(typeof cancelled.metadata!.cancelled_at).toBe('number');
  });

  it('cancelTask merges with existing metadata (does not overwrite unrelated keys)', () => {
    const row = createTask(db, { intent: 'task', metadata: { existing_key: 'preserved' } });
    const cancelled = cancelTask(db, row.task_id, 'reason');

    expect(cancelled.metadata!.existing_key).toBe('preserved');
    expect(cancelled.metadata!.cancel_reason).toBe('reason');
    expect(typeof cancelled.metadata!.cancelled_at).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// cancelTask from terminal state — must throw
// ---------------------------------------------------------------------------

describe('cancelTask from terminal state throws', () => {
  it('throws when cancelling an already CANCELLED task', () => {
    const row = createTask(db, { intent: 'task' });
    cancelTask(db, row.task_id);
    expect(() => cancelTask(db, row.task_id)).toThrow(/Invalid task state transition/);
  });

  it('throws when cancelling a DONE task', () => {
    // Force DONE via direct SQL (no MCP verb for it in Phase 1)
    const row = createTask(db, { intent: 'done task' });
    db.prepare("UPDATE tasks SET state = 'WAITING_REVIEW' WHERE task_id = ?").run(row.task_id);
    db.prepare("UPDATE tasks SET state = 'DONE' WHERE task_id = ?").run(row.task_id);
    expect(() => cancelTask(db, row.task_id)).toThrow(/Invalid task state transition/);
  });

  it('throws when cancelling a FAILED task', () => {
    const row = createTask(db, { intent: 'failed task' });
    db.prepare("UPDATE tasks SET state = 'RUNNING' WHERE task_id = ?").run(row.task_id);
    db.prepare("UPDATE tasks SET state = 'FAILED' WHERE task_id = ?").run(row.task_id);
    expect(() => cancelTask(db, row.task_id)).toThrow(/Invalid task state transition/);
  });
});

// ---------------------------------------------------------------------------
// cancelTask atomicity rollback
// ---------------------------------------------------------------------------

describe('cancelTask atomicity', () => {
  it('rolls back state if metadata write fails (invalid metadata_json causes JSON.parse to throw)', () => {
    // Black-box technique: corrupt metadata_json to invalid JSON so that
    // mergeMetadataInTx's JSON.parse throws inside the transaction. The whole
    // db.transaction() wrapping cancelTask must roll back — leaving state
    // unchanged (still PENDING, not CANCELLED).
    const row = createTask(db, { intent: 'atomic test task' });

    // Write invalid JSON into metadata_json so that mergeMetadataInTx's JSON.parse throws.
    // This SET is OUTSIDE any transaction, so it commits immediately.
    db.prepare("UPDATE tasks SET metadata_json = 'NOT_VALID_JSON' WHERE task_id = ?")
      .run(row.task_id);

    // cancelTask should throw because mergeMetadataInTx will JSON.parse the
    // corrupted metadata_json and fail. The db.transaction() rolls back the
    // state write too.
    expect(() => cancelTask(db, row.task_id)).toThrow();

    // Verify rollback: read state directly (raw SQL to avoid toTaskRow's JSON.parse)
    const rawAfter = db
      .prepare('SELECT state FROM tasks WHERE task_id = ?')
      .get(row.task_id) as { state: string };
    expect(rawAfter.state).toBe('PENDING');

    // Also verify metadata_json is still the corrupted value (not CANCELLED metadata)
    const rawMeta = db
      .prepare('SELECT metadata_json FROM tasks WHERE task_id = ?')
      .get(row.task_id) as { metadata_json: string };
    expect(rawMeta.metadata_json).toBe('NOT_VALID_JSON');
  });
});

// ---------------------------------------------------------------------------
// getTaskTree
// ---------------------------------------------------------------------------

describe('getTaskTree', () => {
  it('returns empty array if root task does not exist', () => {
    expect(getTaskTree(db, 'nonexistent')).toHaveLength(0);
  });

  it('returns just the root for a leaf task (no children)', () => {
    const root = createTask(db, { intent: 'lone root' });
    const tree = getTaskTree(db, root.task_id);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.task_id).toBe(root.task_id);
  });

  it('returns root + all descendants for a 3-level tree (5 nodes)', () => {
    // Level 0: root
    const root = createTask(db, { intent: 'root' });

    // Level 1: two children of root
    const child1 = createTask(db, { intent: 'child 1', parent_task_id: root.task_id });
    const child2 = createTask(db, { intent: 'child 2', parent_task_id: root.task_id });

    // Level 2: two grandchildren of child1
    const gc1 = createTask(db, { intent: 'grandchild 1', parent_task_id: child1.task_id });
    const gc2 = createTask(db, { intent: 'grandchild 2', parent_task_id: child1.task_id });

    const tree = getTaskTree(db, root.task_id);
    const ids = tree.map((t) => t.task_id);

    expect(tree).toHaveLength(5);
    expect(ids).toContain(root.task_id);
    expect(ids).toContain(child1.task_id);
    expect(ids).toContain(child2.task_id);
    expect(ids).toContain(gc1.task_id);
    expect(ids).toContain(gc2.task_id);
  });
});

// ---------------------------------------------------------------------------
// FK constraint: parent_task_id referencing nonexistent task
// ---------------------------------------------------------------------------

describe('FK constraint', () => {
  it('parent_task_id referencing a nonexistent task throws FK constraint error', () => {
    expect(() =>
      createTask(db, { intent: 'orphan', parent_task_id: 'does-not-exist' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase 2 BLOCKED-loop integration: updateTaskState through the repository
// ---------------------------------------------------------------------------

describe('updateTaskState — BLOCKED-loop transitions (Phase 2)', () => {
  it('RUNNING → BLOCKED: state is BLOCKED and updated_at increases monotonically', () => {
    const task = createTask(db, { intent: 'will be blocked' });

    const t0 = task.updated_at;
    const running = updateTaskState(db, task.task_id, 'RUNNING');
    expect(running.state).toBe('RUNNING');
    expect(running.updated_at).toBeGreaterThanOrEqual(t0);

    const t1 = running.updated_at;
    const blocked = updateTaskState(db, task.task_id, 'BLOCKED');
    expect(blocked.state).toBe('BLOCKED');
    // updated_at must not go backwards after each transition
    expect(blocked.updated_at).toBeGreaterThanOrEqual(t1);
  });

  it('BLOCKED → READY_TO_RESUME: state is READY_TO_RESUME', () => {
    const task = createTask(db, { intent: 'needs answer' });

    // Reach BLOCKED via proper transitions
    updateTaskState(db, task.task_id, 'RUNNING');
    updateTaskState(db, task.task_id, 'BLOCKED');

    const resumed = updateTaskState(db, task.task_id, 'READY_TO_RESUME');
    expect(resumed.state).toBe('READY_TO_RESUME');
  });

  it('READY_TO_RESUME → RUNNING: state is RUNNING (resume path)', () => {
    const task = createTask(db, { intent: 'resume this' });

    // Reach READY_TO_RESUME via transitions
    updateTaskState(db, task.task_id, 'RUNNING');
    updateTaskState(db, task.task_id, 'BLOCKED');
    updateTaskState(db, task.task_id, 'READY_TO_RESUME');

    const running = updateTaskState(db, task.task_id, 'RUNNING');
    expect(running.state).toBe('RUNNING');
  });

  it('BLOCKED → CANCELLED: state is CANCELLED (cancel from BLOCKED is legal)', () => {
    const task = createTask(db, { intent: 'cancel while blocked' });

    // Reach BLOCKED via proper transitions
    updateTaskState(db, task.task_id, 'RUNNING');
    updateTaskState(db, task.task_id, 'BLOCKED');

    const cancelled = updateTaskState(db, task.task_id, 'CANCELLED');
    expect(cancelled.state).toBe('CANCELLED');
  });

  it('RUNNING → READY_TO_RESUME throws (must go through BLOCKED first)', () => {
    const task = createTask(db, { intent: 'illegal shortcut' });

    updateTaskState(db, task.task_id, 'RUNNING');

    expect(() => updateTaskState(db, task.task_id, 'READY_TO_RESUME')).toThrow(
      /Invalid task state transition/,
    );

    // Confirm state did NOT change
    const after = getTask(db, task.task_id)!;
    expect(after.state).toBe('RUNNING');
  });

  it('BLOCKED → BLOCKED throws (self-loop on BLOCKED is not a valid transition)', () => {
    const task = createTask(db, { intent: 'double block attempt' });

    updateTaskState(db, task.task_id, 'RUNNING');
    updateTaskState(db, task.task_id, 'BLOCKED');

    expect(() => updateTaskState(db, task.task_id, 'BLOCKED')).toThrow(
      /Invalid task state transition/,
    );

    // Confirm state is still BLOCKED
    const after = getTask(db, task.task_id)!;
    expect(after.state).toBe('BLOCKED');
  });
});
