import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import { createTask, getTask, updateTaskState } from '../../src/storage/repositories/tasks.js';
import {
  recordBlocker,
  markAnswered,
  listBlockersByTask,
  getBlocker,
} from '../../src/storage/repositories/blockers.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
beforeEach(() => {
  ({ db } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
  db.pragma('foreign_keys = ON');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a task and advance it to RUNNING. */
function makeRunningTask(intent = 'test task') {
  const task = createTask(db, { intent });
  updateTaskState(db, task.task_id, 'RUNNING');
  return getTask(db, task.task_id)!;
}

// ---------------------------------------------------------------------------
// recordBlocker — happy path
// ---------------------------------------------------------------------------

describe('recordBlocker — happy path', () => {
  it('RUNNING → BLOCKED: returns blocker with OPEN status + task with BLOCKED state', () => {
    const task = makeRunningTask('will be blocked');
    const before = Date.now();

    const { blocker, task: updatedTask } = recordBlocker(db, {
      task_id: task.task_id,
      question: 'Should we keep the old API?',
      context_keys: ['scratchpad/T/survey'],
      raised_by: 'agent-1',
    });

    const after = Date.now();

    // Blocker assertions
    expect(blocker.blocker_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ulid
    expect(blocker.task_id).toBe(task.task_id);
    expect(blocker.question).toBe('Should we keep the old API?');
    expect(blocker.context_keys).toEqual(['scratchpad/T/survey']);
    expect(blocker.status).toBe('OPEN');
    expect(blocker.raised_by).toBe('agent-1');
    expect(blocker.raised_at).toBeGreaterThanOrEqual(before);
    expect(blocker.raised_at).toBeLessThanOrEqual(after);
    expect(typeof blocker.raised_at).toBe('number');
    expect(blocker.answer).toBeNull();
    expect(blocker.answered_by).toBeNull();
    expect(blocker.answered_at).toBeNull();
    expect(blocker.metadata).toBeNull();

    // Task assertions
    expect(updatedTask.state).toBe('BLOCKED');
    expect(updatedTask.task_id).toBe(task.task_id);
  });

  it('context_keys is null when not provided', () => {
    const task = makeRunningTask();

    const { blocker } = recordBlocker(db, {
      task_id: task.task_id,
      question: 'Minimal blocker',
    });

    expect(blocker.context_keys).toBeNull();
    expect(blocker.raised_by).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordBlocker — illegal source states
// ---------------------------------------------------------------------------

describe('recordBlocker — illegal source states throw', () => {
  it('throws for task in PENDING (not RUNNING)', () => {
    const task = createTask(db, { intent: 'still pending' });
    // task is PENDING

    expect(() =>
      recordBlocker(db, { task_id: task.task_id, question: 'Q?' }),
    ).toThrow(/Invalid task state transition: PENDING -> BLOCKED/);

    // Verify task is still PENDING
    expect(getTask(db, task.task_id)!.state).toBe('PENDING');
  });

  it('throws for task already in BLOCKED (BLOCKED → BLOCKED not valid)', () => {
    const task = makeRunningTask();
    recordBlocker(db, { task_id: task.task_id, question: 'First block' });
    // task is now BLOCKED

    expect(() =>
      recordBlocker(db, { task_id: task.task_id, question: 'Second attempt' }),
    ).toThrow(/Invalid task state transition: BLOCKED -> BLOCKED/);
  });

  it('throws for task in CANCELLED', () => {
    const task = createTask(db, { intent: 'cancelled task' });
    // Force CANCELLED via direct state write (bypass transition guard)
    db.prepare("UPDATE tasks SET state = 'CANCELLED' WHERE task_id = ?").run(task.task_id);

    expect(() =>
      recordBlocker(db, { task_id: task.task_id, question: 'Q?' }),
    ).toThrow(/Invalid task state transition: CANCELLED -> BLOCKED/);
  });

  it('throws for task not found', () => {
    expect(() =>
      recordBlocker(db, { task_id: 'does-not-exist', question: 'Q?' }),
    ).toThrow(/TASK_NOT_FOUND/);
  });
});

// ---------------------------------------------------------------------------
// recordBlocker — atomicity (LD-6 deterministic trigger: question NOT NULL)
// ---------------------------------------------------------------------------

describe('recordBlocker — atomicity', () => {
  it('rolls back state transition when INSERT fails due to question NOT NULL constraint', () => {
    // Setup: task in RUNNING
    const task = makeRunningTask('atomicity test');
    expect(task.state).toBe('RUNNING');

    // Trigger: pass null as question — bypasses TS type check, hits SQLite NOT NULL
    // The transaction: state→BLOCKED succeeds, then INSERT throws, outer tx rolls back both.
    let thrownError: Error | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recordBlocker(db, { task_id: task.task_id, question: null as any });
    } catch (e) {
      thrownError = e as Error;
    }

    // Must have thrown
    expect(thrownError).toBeDefined();
    // SQLite error message should mention NOT NULL constraint
    expect(thrownError!.message).toMatch(/NOT NULL|null value/i);

    // Rollback verified: task.state must still be RUNNING
    const rawState = db
      .prepare('SELECT state FROM tasks WHERE task_id = ?')
      .get(task.task_id) as { state: string };
    expect(rawState.state).toBe('RUNNING');

    // No blocker rows inserted
    const blockerCount = db
      .prepare('SELECT COUNT(*) as cnt FROM blockers WHERE task_id = ?')
      .get(task.task_id) as { cnt: number };
    expect(blockerCount.cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// markAnswered — single blocker happy path
// ---------------------------------------------------------------------------

describe('markAnswered — single blocker happy path', () => {
  it('OPEN → ANSWERED, task BLOCKED → READY_TO_RESUME when last blocker answered', () => {
    const task = makeRunningTask('to be answered');
    const { blocker } = recordBlocker(db, {
      task_id: task.task_id,
      question: 'What approach?',
      raised_by: 'agent-1',
    });

    expect(blocker.status).toBe('OPEN');
    expect(getTask(db, task.task_id)!.state).toBe('BLOCKED');

    const before = Date.now();
    const { blocker: answered, task: resumedTask } = markAnswered(db, blocker.blocker_id, {
      answer: 'Use approach A',
      answered_by: 'user',
    });
    const after = Date.now();

    // Blocker should now be ANSWERED
    expect(answered.status).toBe('ANSWERED');
    expect(answered.answer).toBe('Use approach A');
    expect(answered.answered_by).toBe('user');
    expect(answered.answered_at).toBeGreaterThanOrEqual(before);
    expect(answered.answered_at).toBeLessThanOrEqual(after);
    expect(typeof answered.answered_at).toBe('number');

    // Task should now be READY_TO_RESUME (0 open blockers remain)
    expect(resumedTask.state).toBe('READY_TO_RESUME');
  });
});

// ---------------------------------------------------------------------------
// markAnswered — multi-blocker counting (LD-7)
// ---------------------------------------------------------------------------

describe('markAnswered — multi-blocker counting (LD-7)', () => {
  it('answering 1st of 2 blockers: task stays BLOCKED (1 open remains)', () => {
    const task = makeRunningTask('two-blocker task');

    // Create first blocker via the repo verb (RUNNING → BLOCKED)
    const { blocker: b1 } = recordBlocker(db, {
      task_id: task.task_id,
      question: 'Question 1',
    });

    // Task is now BLOCKED. Insert second blocker directly via raw SQL —
    // there is no verb that allows BLOCKED → BLOCKED, and the test intentionally
    // bypasses the state machine to set up a multi-blocker scenario.
    const b2Id = 'B2MBTEST000000000000000000002';
    db.prepare(`
      INSERT INTO blockers (blocker_id, task_id, question, context_keys, status, raised_by, raised_at)
      VALUES (?, ?, 'Question 2', NULL, 'OPEN', NULL, ?)
    `).run(b2Id, task.task_id, Date.now() + 1);

    // Answer first blocker — 1 OPEN still remains, task must stay BLOCKED
    const { blocker: answered1, task: taskAfter1 } = markAnswered(db, b1.blocker_id, {
      answer: 'Answer 1',
      answered_by: 'user',
    });

    expect(answered1.status).toBe('ANSWERED');
    expect(taskAfter1.state).toBe('BLOCKED');

    // Answer second blocker — 0 OPEN remain, task must advance to READY_TO_RESUME
    const { blocker: answered2, task: taskAfter2 } = markAnswered(db, b2Id, {
      answer: 'Answer 2',
      answered_by: 'user',
    });

    expect(answered2.status).toBe('ANSWERED');
    expect(taskAfter2.state).toBe('READY_TO_RESUME');
  });
});

// ---------------------------------------------------------------------------
// markAnswered — error cases
// ---------------------------------------------------------------------------

describe('markAnswered — error cases', () => {
  it('throws BLOCKER_ALREADY_ANSWERED for an already-answered blocker', () => {
    const task = makeRunningTask();
    const { blocker } = recordBlocker(db, {
      task_id: task.task_id,
      question: 'Already answered Q',
    });

    markAnswered(db, blocker.blocker_id, { answer: 'First answer', answered_by: 'user' });

    // Attempt to answer again
    expect(() =>
      markAnswered(db, blocker.blocker_id, { answer: 'Second answer', answered_by: 'user' }),
    ).toThrow(/BLOCKER_ALREADY_ANSWERED/);
  });

  it('throws BLOCKER_NOT_FOUND for a nonexistent blocker_id', () => {
    expect(() =>
      markAnswered(db, 'does-not-exist', { answer: 'x', answered_by: 'user' }),
    ).toThrow(/BLOCKER_NOT_FOUND/);
  });
});

// ---------------------------------------------------------------------------
// markAnswered — atomicity (LD-6 deterministic trigger: raw SQL state flip)
// ---------------------------------------------------------------------------

describe('markAnswered — atomicity', () => {
  it('rolls back blocker UPDATE when assertTransition fails at end of transaction', () => {
    // Setup: task in BLOCKED with 1 OPEN blocker
    const task = makeRunningTask('atomicity markAnswered');
    const { blocker } = recordBlocker(db, {
      task_id: task.task_id,
      question: 'Will be partially answered',
    });

    expect(getTask(db, task.task_id)!.state).toBe('BLOCKED');
    expect(blocker.status).toBe('OPEN');

    // Corrupt the task state to RUNNING via raw SQL, OUTSIDE any transaction.
    // Inside markAnswered's tx: blocker UPDATE succeeds → count OPEN = 0 →
    // assertTransition('RUNNING' → 'READY_TO_RESUME') THROWS (not in VALID_TRANSITIONS).
    // Entire tx rolls back.
    db.prepare("UPDATE tasks SET state = 'RUNNING' WHERE task_id = ?").run(task.task_id);

    let thrownError: Error | undefined;
    try {
      markAnswered(db, blocker.blocker_id, { answer: 'x', answered_by: 'agent-1' });
    } catch (e) {
      thrownError = e as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).toMatch(/Invalid task state transition: RUNNING -> READY_TO_RESUME/);

    // Rollback verified: blocker must still be OPEN
    const rawBlocker = db
      .prepare('SELECT status, answer, answered_at FROM blockers WHERE blocker_id = ?')
      .get(blocker.blocker_id) as { status: string; answer: string | null; answered_at: number | null };

    expect(rawBlocker.status).toBe('OPEN');
    expect(rawBlocker.answer).toBeNull();
    expect(rawBlocker.answered_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listBlockersByTask
// ---------------------------------------------------------------------------

describe('listBlockersByTask', () => {
  it('returns blockers ordered by raised_at ASC', () => {
    const task = makeRunningTask('list ordering');

    // Insert 3 blockers with distinct raised_at values via raw SQL to control timestamps
    const ids = ['LIST001000000000000000000001', 'LIST001000000000000000000002', 'LIST001000000000000000000003'];
    const times = [1000, 2000, 3000];

    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO blockers (blocker_id, task_id, question, context_keys, status, raised_by, raised_at)
        VALUES (?, ?, ?, NULL, 'OPEN', NULL, ?)
      `).run(ids[i], task.task_id, `Question ${i + 1}`, times[i]);
    }

    // Need to fix task state — it's still RUNNING (we didn't call recordBlocker)
    // The list function doesn't care about task state, just reads blockers.
    const blockers = listBlockersByTask(db, task.task_id);

    expect(blockers).toHaveLength(3);
    expect(blockers[0]!.raised_at).toBe(1000);
    expect(blockers[1]!.raised_at).toBe(2000);
    expect(blockers[2]!.raised_at).toBe(3000);
    expect(blockers[0]!.blocker_id).toBe(ids[0]);
    expect(blockers[1]!.blocker_id).toBe(ids[1]);
    expect(blockers[2]!.blocker_id).toBe(ids[2]);
  });

  it('filter by single status returns only matching rows', () => {
    const task = makeRunningTask('filter single');

    const id1 = 'FILT001000000000000000000001';
    const id2 = 'FILT001000000000000000000002';
    const id3 = 'FILT001000000000000000000003';

    db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_at) VALUES (?, ?, 'Q1', 'OPEN', 100)`).run(id1, task.task_id);
    db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_at) VALUES (?, ?, 'Q2', 'ANSWERED', 200)`).run(id2, task.task_id);
    db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_at) VALUES (?, ?, 'Q3', 'OPEN', 300)`).run(id3, task.task_id);

    const open = listBlockersByTask(db, task.task_id, { status: 'OPEN' });
    expect(open).toHaveLength(2);
    expect(open.every(b => b.status === 'OPEN')).toBe(true);

    const answered = listBlockersByTask(db, task.task_id, { status: 'ANSWERED' });
    expect(answered).toHaveLength(1);
    expect(answered[0]!.blocker_id).toBe(id2);
  });

  it('filter by status array returns matching rows for all given statuses', () => {
    const task = makeRunningTask('filter array');

    const id1 = 'ARRF001000000000000000000001';
    const id2 = 'ARRF001000000000000000000002';
    const id3 = 'ARRF001000000000000000000003';

    db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_at) VALUES (?, ?, 'Q1', 'OPEN', 10)`).run(id1, task.task_id);
    db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_at) VALUES (?, ?, 'Q2', 'ANSWERED', 20)`).run(id2, task.task_id);
    db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_at) VALUES (?, ?, 'Q3', 'SUPERSEDED', 30)`).run(id3, task.task_id);

    const result = listBlockersByTask(db, task.task_id, { status: ['OPEN', 'ANSWERED'] });
    expect(result).toHaveLength(2);
    const resultIds = result.map(b => b.blocker_id);
    expect(resultIds).toContain(id1);
    expect(resultIds).toContain(id2);
    expect(resultIds).not.toContain(id3);
  });

  it('returns empty array for task with no blockers', () => {
    const task = makeRunningTask('no blockers');
    expect(listBlockersByTask(db, task.task_id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getBlocker
// ---------------------------------------------------------------------------

describe('getBlocker', () => {
  it('returns full BlockerRow for an existing blocker', () => {
    const task = makeRunningTask('get blocker');
    const { blocker } = recordBlocker(db, {
      task_id: task.task_id,
      question: 'Fetch me',
      context_keys: ['key-a', 'key-b'],
      raised_by: 'agent-x',
    });

    const fetched = getBlocker(db, blocker.blocker_id);

    expect(fetched).not.toBeNull();
    expect(fetched!.blocker_id).toBe(blocker.blocker_id);
    expect(fetched!.question).toBe('Fetch me');
    expect(fetched!.context_keys).toEqual(['key-a', 'key-b']);
    expect(fetched!.raised_by).toBe('agent-x');
    expect(fetched!.status).toBe('OPEN');
  });

  it('returns null for a nonexistent blocker_id', () => {
    expect(getBlocker(db, 'no-such-blocker')).toBeNull();
  });
});
