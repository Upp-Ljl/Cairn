import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import { createTask, getTask, updateTaskState } from '../../src/storage/repositories/tasks.js';
import {
  submitOutcomesForReview,
  recordEvaluationResult,
  markTerminalFail,
  getOutcomeByTask,
} from '../../src/storage/repositories/outcomes.js';
import type { Database as DB } from 'better-sqlite3';
import type { StoredOutcomeCriterion } from '../../src/storage/types.js';

let db: DB;
beforeEach(() => {
  ({ db } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
  db.pragma('foreign_keys = ON');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_CRITERIA: StoredOutcomeCriterion[] = [
  { primitive: 'file_exists', args: { path: 'packages/daemon/dist/index.js' } },
  { primitive: 'tests_pass', args: { target: 'packages/daemon' } },
];

/** Create a task and advance it to RUNNING. */
function makeRunningTask(intent = 'test task') {
  const task = createTask(db, { intent });
  updateTaskState(db, task.task_id, 'RUNNING');
  return getTask(db, task.task_id)!;
}

/** Create a RUNNING task and submit it for review (first call). Returns { outcome_id, task_id }. */
function makeWaitingTask(criteria = SAMPLE_CRITERIA) {
  const task = makeRunningTask();
  const { outcome, task: updatedTask } = submitOutcomesForReview(db, {
    task_id: task.task_id,
    criteria,
  });
  return { outcome, task: updatedTask };
}

// ---------------------------------------------------------------------------
// Case 1: submitOutcomesForReview first-call happy path
// ---------------------------------------------------------------------------

describe('submitOutcomesForReview — first-call happy path', () => {
  it('case 1: RUNNING + criteria → WAITING_REVIEW + outcome.status=PENDING + criteria deserialized', () => {
    const task = makeRunningTask('submit first call');
    const before = Date.now();

    const { outcome, task: updatedTask } = submitOutcomesForReview(db, {
      task_id: task.task_id,
      criteria: SAMPLE_CRITERIA,
    });

    const after = Date.now();

    expect(outcome.outcome_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(outcome.task_id).toBe(task.task_id);
    expect(outcome.status).toBe('PENDING');
    expect(outcome.criteria).toEqual(SAMPLE_CRITERIA);
    expect(outcome.evaluated_at).toBeNull();
    expect(outcome.evaluation_summary).toBeNull();
    expect(outcome.grader_agent_id).toBeNull();
    expect(outcome.metadata).toBeNull();
    expect(outcome.created_at).toBeGreaterThanOrEqual(before);
    expect(outcome.created_at).toBeLessThanOrEqual(after);

    expect(updatedTask.state).toBe('WAITING_REVIEW');
    expect(updatedTask.task_id).toBe(task.task_id);
  });
});

// ---------------------------------------------------------------------------
// Case 2: submitOutcomesForReview from PENDING — assertTransition throws
// ---------------------------------------------------------------------------

describe('submitOutcomesForReview — illegal source states', () => {
  it('case 2: throws for task in PENDING (assertTransition: PENDING -> WAITING_REVIEW)', () => {
    const task = createTask(db, { intent: 'still pending' });

    expect(() =>
      submitOutcomesForReview(db, { task_id: task.task_id, criteria: SAMPLE_CRITERIA }),
    ).toThrow(/Invalid task state transition: PENDING -> WAITING_REVIEW/);

    expect(getTask(db, task.task_id)!.state).toBe('PENDING');
    expect(getOutcomeByTask(db, task.task_id)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Case 3: submitOutcomesForReview from BLOCKED
  // ---------------------------------------------------------------------------

  it('case 3: throws for task in BLOCKED (assertTransition: BLOCKED -> WAITING_REVIEW)', () => {
    const task = makeRunningTask('will be blocked');
    // Force BLOCKED via raw SQL to avoid importing blockers
    db.prepare("UPDATE tasks SET state = 'BLOCKED' WHERE task_id = ?").run(task.task_id);

    expect(() =>
      submitOutcomesForReview(db, { task_id: task.task_id, criteria: SAMPLE_CRITERIA }),
    ).toThrow(/Invalid task state transition: BLOCKED -> WAITING_REVIEW/);

    expect(getTask(db, task.task_id)!.state).toBe('BLOCKED');
    expect(getOutcomeByTask(db, task.task_id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 4: empty criteria array → throws EMPTY_CRITERIA
// ---------------------------------------------------------------------------

describe('submitOutcomesForReview — empty criteria', () => {
  it('case 4: first-call with empty criteria array throws EMPTY_CRITERIA', () => {
    const task = makeRunningTask('empty criteria');

    expect(() =>
      submitOutcomesForReview(db, { task_id: task.task_id, criteria: [] }),
    ).toThrow(/EMPTY_CRITERIA/);

    // Task state and outcome table unaffected
    expect(getTask(db, task.task_id)!.state).toBe('RUNNING');
    expect(getOutcomeByTask(db, task.task_id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 5: atomicity — first-call rollback on state-machine throw
// ---------------------------------------------------------------------------

describe('submitOutcomesForReview — first-call atomicity', () => {
  it('case 5: rolls back outcome INSERT when assertTransition fails (task pre-corrupted to BLOCKED)', () => {
    const task = makeRunningTask('atomicity first call');
    // Pre-corrupt task state so transitionTaskInTx will throw after criteria check passes
    db.prepare("UPDATE tasks SET state = 'BLOCKED' WHERE task_id = ?").run(task.task_id);

    let thrown: Error | undefined;
    try {
      submitOutcomesForReview(db, { task_id: task.task_id, criteria: SAMPLE_CRITERIA });
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/Invalid task state transition: BLOCKED -> WAITING_REVIEW/);

    // Rollback: no outcome row, task state unchanged
    expect(getOutcomeByTask(db, task.task_id)).toBeNull();
    const rawState = db
      .prepare('SELECT state FROM tasks WHERE task_id = ?')
      .get(task.task_id) as { state: string };
    expect(rawState.state).toBe('BLOCKED');
  });
});

// ---------------------------------------------------------------------------
// Case 6: repeat path — FAIL → reset → PASS happy chain
// ---------------------------------------------------------------------------

describe('submitOutcomesForReview — repeat path upsert', () => {
  it('case 6: FAIL→reset→PASS: outcome_id preserved, criteria_json unchanged, status resets', () => {
    const { outcome: first } = makeWaitingTask();
    const originalOutcomeId = first.outcome_id;
    const originalCriteriaJson = JSON.stringify(first.criteria);

    // Evaluate as FAIL → task back to RUNNING
    const { outcome: afterFail } = recordEvaluationResult(db, first.outcome_id, {
      status: 'FAIL',
      summary: 'tests failed',
    });
    expect(afterFail.status).toBe('FAIL');
    expect(getTask(db, first.task_id)!.state).toBe('RUNNING');

    // Repeat submit (upsert reset path) — omit criteria
    const { outcome: reset, task: resetTask } = submitOutcomesForReview(db, {
      task_id: first.task_id,
    });

    expect(reset.outcome_id).toBe(originalOutcomeId);          // preserved
    expect(JSON.stringify(reset.criteria)).toBe(originalCriteriaJson); // criteria_json unchanged
    expect(reset.status).toBe('PENDING');                       // reset
    expect(reset.evaluated_at).toBeNull();
    expect(reset.evaluation_summary).toBeNull();
    expect(resetTask.state).toBe('WAITING_REVIEW');

    // Now evaluate as PASS → task DONE
    const { outcome: passed, task: done } = recordEvaluationResult(db, reset.outcome_id, {
      status: 'PASS',
      summary: 'all green',
    });
    expect(passed.status).toBe('PASS');
    expect(done.state).toBe('DONE');
  });
});

// ---------------------------------------------------------------------------
// Case 7: repeat with conflicting criteria → throws CRITERIA_FROZEN
// ---------------------------------------------------------------------------

describe('submitOutcomesForReview — criteria frozen', () => {
  it('case 7: repeat call with different criteria throws CRITERIA_FROZEN', () => {
    const { outcome, task } = makeWaitingTask();
    recordEvaluationResult(db, outcome.outcome_id, { status: 'FAIL', summary: 'fail' });
    // Task back to RUNNING now

    const different: StoredOutcomeCriterion[] = [{ primitive: 'command_exits_0', args: { cmd: 'exit 0' } }];

    expect(() =>
      submitOutcomesForReview(db, { task_id: task.task_id, criteria: different }),
    ).toThrow(/CRITERIA_FROZEN/);
  });

  // -------------------------------------------------------------------------
  // Case 8: repeat with same criteria (literal equal) → success
  // -------------------------------------------------------------------------

  it('case 8: repeat call with identical criteria (literal equal) succeeds', () => {
    const { outcome, task } = makeWaitingTask();
    recordEvaluationResult(db, outcome.outcome_id, { status: 'FAIL', summary: 'fail' });

    // Pass the exact same criteria object array
    const { outcome: reset } = submitOutcomesForReview(db, {
      task_id: task.task_id,
      criteria: SAMPLE_CRITERIA,
    });

    expect(reset.status).toBe('PENDING');
    expect(reset.outcome_id).toBe(outcome.outcome_id);
  });
});

// ---------------------------------------------------------------------------
// Case 9: recordEvaluationResult(PASS) happy
// ---------------------------------------------------------------------------

describe('recordEvaluationResult — PASS', () => {
  it('case 9: PENDING → PASS + task WAITING_REVIEW → DONE', () => {
    const { outcome } = makeWaitingTask();
    expect(outcome.status).toBe('PENDING');

    const before = Date.now();
    const { outcome: passed, task } = recordEvaluationResult(db, outcome.outcome_id, {
      status: 'PASS',
      summary: 'All primitives passed.',
    });
    const after = Date.now();

    expect(passed.status).toBe('PASS');
    expect(passed.evaluation_summary).toBe('All primitives passed.');
    expect(passed.evaluated_at).toBeGreaterThanOrEqual(before);
    expect(passed.evaluated_at).toBeLessThanOrEqual(after);
    expect(task.state).toBe('DONE');
  });
});

// ---------------------------------------------------------------------------
// Case 10: recordEvaluationResult(FAIL) happy
// ---------------------------------------------------------------------------

describe('recordEvaluationResult — FAIL', () => {
  it('case 10: PENDING → FAIL + task WAITING_REVIEW → RUNNING (retry path)', () => {
    const { outcome } = makeWaitingTask();

    const { outcome: failed, task } = recordEvaluationResult(db, outcome.outcome_id, {
      status: 'FAIL',
      summary: '2 tests red.',
    });

    expect(failed.status).toBe('FAIL');
    expect(failed.evaluation_summary).toBe('2 tests red.');
    expect(task.state).toBe('RUNNING');
  });
});

// ---------------------------------------------------------------------------
// Case 11: recordEvaluationResult on FAIL outcome → OUTCOME_NOT_PENDING
// ---------------------------------------------------------------------------

describe('recordEvaluationResult — non-PENDING rejection', () => {
  it('case 11: calling recordEvaluationResult on a FAIL outcome throws OUTCOME_NOT_PENDING', () => {
    const { outcome } = makeWaitingTask();
    recordEvaluationResult(db, outcome.outcome_id, { status: 'FAIL', summary: 'x' });
    // outcome.status is now FAIL

    expect(() =>
      recordEvaluationResult(db, outcome.outcome_id, { status: 'PASS', summary: 'retry' }),
    ).toThrow(/OUTCOME_NOT_PENDING/);
  });

  // -------------------------------------------------------------------------
  // Case 12: recordEvaluationResult on PASS outcome → OUTCOME_NOT_PENDING
  // -------------------------------------------------------------------------

  it('case 12: calling recordEvaluationResult on a PASS outcome throws OUTCOME_NOT_PENDING', () => {
    const { outcome } = makeWaitingTask();
    recordEvaluationResult(db, outcome.outcome_id, { status: 'PASS', summary: 'done' });
    // outcome.status is now PASS, task is DONE

    expect(() =>
      recordEvaluationResult(db, outcome.outcome_id, { status: 'FAIL', summary: 'again' }),
    ).toThrow(/OUTCOME_NOT_PENDING/);
  });
});

// ---------------------------------------------------------------------------
// Case 13: recordEvaluationResult atomicity — raw SQL state flip
// ---------------------------------------------------------------------------

describe('recordEvaluationResult — atomicity', () => {
  it('case 13: rolls back outcome UPDATE when assertTransition fails (task pre-corrupted to RUNNING)', () => {
    const { outcome } = makeWaitingTask();
    expect(outcome.status).toBe('PENDING');

    // Corrupt task state to RUNNING so assertTransition('RUNNING' → 'DONE') throws
    db.prepare("UPDATE tasks SET state = 'RUNNING' WHERE task_id = ?").run(outcome.task_id);

    let thrown: Error | undefined;
    try {
      recordEvaluationResult(db, outcome.outcome_id, { status: 'PASS', summary: 'x' });
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/Invalid task state transition: RUNNING -> DONE/);

    // Rollback: outcome.status still PENDING, evaluated_at still null
    const raw = db
      .prepare('SELECT status, evaluated_at FROM outcomes WHERE outcome_id = ?')
      .get(outcome.outcome_id) as { status: string; evaluated_at: number | null };
    expect(raw.status).toBe('PENDING');
    expect(raw.evaluated_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 14: markTerminalFail happy
// ---------------------------------------------------------------------------

describe('markTerminalFail — happy path', () => {
  it('case 14: PENDING → TERMINAL_FAIL + task WAITING_REVIEW → FAILED', () => {
    const { outcome } = makeWaitingTask();

    const before = Date.now();
    const { outcome: terminal, task } = markTerminalFail(
      db,
      outcome.outcome_id,
      'User decided not to pursue this task.',
    );
    const after = Date.now();

    expect(terminal.status).toBe('TERMINAL_FAIL');
    expect(terminal.evaluation_summary).toBe('User decided not to pursue this task.');
    expect(terminal.evaluated_at).toBeGreaterThanOrEqual(before);
    expect(terminal.evaluated_at).toBeLessThanOrEqual(after);
    expect(task.state).toBe('FAILED');
  });
});

// ---------------------------------------------------------------------------
// Case 15: markTerminalFail from FAIL → OUTCOME_NOT_PENDING
// ---------------------------------------------------------------------------

describe('markTerminalFail — non-PENDING rejection', () => {
  it('case 15: markTerminalFail on FAIL outcome throws OUTCOME_NOT_PENDING', () => {
    const { outcome } = makeWaitingTask();
    recordEvaluationResult(db, outcome.outcome_id, { status: 'FAIL', summary: 'fail' });
    // task is now RUNNING, outcome is FAIL

    expect(() =>
      markTerminalFail(db, outcome.outcome_id, 'give up'),
    ).toThrow(/OUTCOME_NOT_PENDING/);
  });
});

// ---------------------------------------------------------------------------
// Case 16: getOutcomeByTask — null when no outcome / single row when present
// ---------------------------------------------------------------------------

describe('getOutcomeByTask', () => {
  it('case 16a: returns null for a task with no outcome', () => {
    const task = makeRunningTask('no outcome yet');
    expect(getOutcomeByTask(db, task.task_id)).toBeNull();
  });

  it('case 16b: returns a single OutcomeRow for a task with an outcome', () => {
    const { outcome } = makeWaitingTask();
    const fetched = getOutcomeByTask(db, outcome.task_id);

    expect(fetched).not.toBeNull();
    expect(fetched!.outcome_id).toBe(outcome.outcome_id);
    expect(fetched!.status).toBe('PENDING');
    expect(fetched!.criteria).toEqual(SAMPLE_CRITERIA);
  });
});

// ---------------------------------------------------------------------------
// Case 17: CASCADE — delete task → outcome disappears
// ---------------------------------------------------------------------------

describe('CASCADE delete', () => {
  it('case 17: deleting a task removes its outcome row automatically', () => {
    const { outcome } = makeWaitingTask();
    expect(getOutcomeByTask(db, outcome.task_id)).not.toBeNull();

    db.prepare('DELETE FROM tasks WHERE task_id = ?').run(outcome.task_id);

    expect(getOutcomeByTask(db, outcome.task_id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 18: UNIQUE constraint smoke — raw SQL double-insert fails
// ---------------------------------------------------------------------------

describe('UNIQUE(task_id) constraint', () => {
  it('case 18: raw SQL inserting a second outcome for same task_id throws UNIQUE constraint failed', () => {
    const { outcome } = makeWaitingTask();

    expect(() =>
      db.prepare(`
        INSERT INTO outcomes
          (outcome_id, task_id, criteria_json, status, created_at, updated_at)
        VALUES
          ('DUPL000000000000000000000001', ?, '[]', 'PENDING', ?, ?)
      `).run(outcome.task_id, Date.now(), Date.now()),
    ).toThrow(/UNIQUE constraint failed/);
  });
});
