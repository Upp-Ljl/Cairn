import type { Database as DB } from 'better-sqlite3';
import { newId } from '../ids.js';
import { assertTransition, type TaskState } from '../tasks-state.js';
import { getTask, type TaskRow } from './tasks.js';
import type { StoredOutcomeCriterion } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutcomeStatus = 'PENDING' | 'PASS' | 'FAIL' | 'TERMINAL_FAIL';

/** Raw row as stored in SQLite (before JSON deserialization). */
interface OutcomeRowRaw {
  outcome_id: string;
  task_id: string;
  criteria_json: string;
  status: string;
  evaluated_at: number | null;
  evaluation_summary: string | null;
  grader_agent_id: string | null;
  created_at: number;
  updated_at: number;
  metadata_json: string | null;
}

/** Public-facing type with deserialized JSON fields. */
export interface OutcomeRow {
  outcome_id: string;
  task_id: string;
  criteria: StoredOutcomeCriterion[];    // deserialized from criteria_json
  status: OutcomeStatus;
  evaluated_at: number | null;
  evaluation_summary: string | null;
  grader_agent_id: string | null;
  created_at: number;
  updated_at: number;
  metadata: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function toOutcomeRow(raw: OutcomeRowRaw): OutcomeRow {
  return {
    outcome_id: raw.outcome_id,
    task_id: raw.task_id,
    criteria: JSON.parse(raw.criteria_json) as StoredOutcomeCriterion[],
    status: raw.status as OutcomeStatus,
    evaluated_at: raw.evaluated_at,
    evaluation_summary: raw.evaluation_summary,
    grader_agent_id: raw.grader_agent_id,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    metadata: raw.metadata_json != null
      ? (JSON.parse(raw.metadata_json) as Record<string, unknown>)
      : null,
  };
}

/**
 * Module-private: within an existing transaction context, read current task
 * state, assert the transition is legal, write new state + updated_at, and
 * return the updated TaskRow.
 */
function transitionTaskInTx(db: DB, taskId: string, to: TaskState): TaskRow {
  const raw = db
    .prepare('SELECT state FROM tasks WHERE task_id = ?')
    .get(taskId) as { state: string } | undefined;

  if (raw === undefined) {
    throw new Error(`TASK_NOT_FOUND: ${taskId}`);
  }

  const from = raw.state as TaskState;
  assertTransition(from, to);

  const now = Date.now();
  db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?')
    .run(to, now, taskId);

  return getTask(db, taskId)!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upsert outcome for a task and transition task to WAITING_REVIEW. In a single transaction:
 *
 * FIRST CALL (no existing outcome row):
 *   1. Assert input.criteria is a non-empty array; else throw 'EMPTY_CRITERIA'.
 *   2. INSERT outcomes(outcome_id=newId(), criteria_json, status='PENDING', created_at, updated_at).
 *   3. transitionTaskInTx(task_id, 'WAITING_REVIEW').
 *
 * REPEAT CALL (outcome row exists for task_id):
 *   1. If input.criteria given and !== existing criteria_json (literal equality) → throw 'CRITERIA_FROZEN'.
 *   2. UPDATE outcomes SET status='PENDING', evaluated_at=NULL, evaluation_summary=NULL, updated_at.
 *   3. transitionTaskInTx(task_id, 'WAITING_REVIEW').
 *
 * Errors: TASK_NOT_FOUND / EMPTY_CRITERIA / CRITERIA_FROZEN / Invalid task state transition.
 */
export function submitOutcomesForReview(
  db: DB,
  input: {
    task_id: string;
    criteria?: StoredOutcomeCriterion[];
  },
): { outcome: OutcomeRow; task: TaskRow } {
  const txn = db.transaction(() => {
    const existing = db
      .prepare('SELECT outcome_id, criteria_json FROM outcomes WHERE task_id = ?')
      .get(input.task_id) as { outcome_id: string; criteria_json: string } | undefined;

    if (existing !== undefined) {
      // REPEAT CALL: criteria frozen check
      if (input.criteria !== undefined) {
        const inputJson = JSON.stringify(input.criteria);
        if (inputJson !== existing.criteria_json) {
          throw new Error('CRITERIA_FROZEN');
        }
      }

      const now = Date.now();
      db.prepare(`
        UPDATE outcomes
        SET status = 'PENDING', evaluated_at = NULL, evaluation_summary = NULL, updated_at = ?
        WHERE task_id = ?
      `).run(now, input.task_id);

      const task = transitionTaskInTx(db, input.task_id, 'WAITING_REVIEW');
      const outcome = getOutcomeByTask(db, input.task_id)!;
      return { outcome, task };
    }

    // FIRST CALL
    if (!input.criteria || input.criteria.length === 0) {
      throw new Error('EMPTY_CRITERIA');
    }

    const outcome_id = newId();
    const now = Date.now();
    const criteria_json = JSON.stringify(input.criteria);

    db.prepare(`
      INSERT INTO outcomes
        (outcome_id, task_id, criteria_json, status, evaluated_at, evaluation_summary,
         grader_agent_id, created_at, updated_at, metadata_json)
      VALUES
        (?, ?, ?, 'PENDING', NULL, NULL, NULL, ?, ?, NULL)
    `).run(outcome_id, input.task_id, criteria_json, now, now);

    const task = transitionTaskInTx(db, input.task_id, 'WAITING_REVIEW');
    const outcome = getOutcomeByTask(db, input.task_id)!;
    return { outcome, task };
  });

  return txn();
}

/**
 * Record the result of a DSL evaluation. In a single transaction:
 *   1. Read outcome; assert status === 'PENDING'; else throw 'OUTCOME_NOT_PENDING'.
 *   2. UPDATE outcomes SET status, evaluated_at, evaluation_summary, updated_at.
 *   3. PASS → transitionTaskInTx(task_id, 'DONE'); FAIL → transitionTaskInTx(task_id, 'RUNNING').
 *
 * Errors: OUTCOME_NOT_PENDING / Invalid task state transition.
 */
export function recordEvaluationResult(
  db: DB,
  outcome_id: string,
  result: {
    status: 'PASS' | 'FAIL';
    summary: string;
    evaluated_at?: number;
  },
): { outcome: OutcomeRow; task: TaskRow } {
  const txn = db.transaction(() => {
    const raw = db
      .prepare('SELECT * FROM outcomes WHERE outcome_id = ?')
      .get(outcome_id) as OutcomeRowRaw | undefined;

    if (raw === undefined) {
      throw new Error(`OUTCOME_NOT_FOUND: ${outcome_id}`);
    }

    if (raw.status !== 'PENDING') {
      throw new Error('OUTCOME_NOT_PENDING');
    }

    const now = result.evaluated_at ?? Date.now();
    db.prepare(`
      UPDATE outcomes
      SET status = ?, evaluated_at = ?, evaluation_summary = ?, updated_at = ?
      WHERE outcome_id = ?
    `).run(result.status, now, result.summary, Date.now(), outcome_id);

    const taskTarget: TaskState = result.status === 'PASS' ? 'DONE' : 'RUNNING';
    const task = transitionTaskInTx(db, raw.task_id, taskTarget);
    const outcome = getOutcomeByTask(db, raw.task_id)!;
    return { outcome, task };
  });

  return txn();
}

/**
 * Mark an outcome as TERMINAL_FAIL and transition task to FAILED. In a single transaction:
 *   1. Read outcome; assert status === 'PENDING'; else throw 'OUTCOME_NOT_PENDING'.
 *   2. UPDATE outcomes SET status='TERMINAL_FAIL', evaluation_summary=reason, evaluated_at, updated_at.
 *   3. transitionTaskInTx(task_id, 'FAILED').
 *
 * Errors: OUTCOME_NOT_PENDING / Invalid task state transition.
 */
export function markTerminalFail(
  db: DB,
  outcome_id: string,
  reason: string,
): { outcome: OutcomeRow; task: TaskRow } {
  const txn = db.transaction(() => {
    const raw = db
      .prepare('SELECT * FROM outcomes WHERE outcome_id = ?')
      .get(outcome_id) as OutcomeRowRaw | undefined;

    if (raw === undefined) {
      throw new Error(`OUTCOME_NOT_FOUND: ${outcome_id}`);
    }

    if (raw.status !== 'PENDING') {
      throw new Error('OUTCOME_NOT_PENDING');
    }

    const now = Date.now();
    db.prepare(`
      UPDATE outcomes
      SET status = 'TERMINAL_FAIL', evaluation_summary = ?, evaluated_at = ?, updated_at = ?
      WHERE outcome_id = ?
    `).run(reason, now, now, outcome_id);

    const task = transitionTaskInTx(db, raw.task_id, 'FAILED');
    const outcome = getOutcomeByTask(db, raw.task_id)!;
    return { outcome, task };
  });

  return txn();
}

/**
 * Get the outcome row for a task. Returns null if no outcome exists.
 * UNIQUE(task_id) guarantees 0 or 1 row (LD-14 / P1.4 lock).
 */
export function getOutcomeByTask(db: DB, task_id: string): OutcomeRow | null {
  const raw = db
    .prepare('SELECT * FROM outcomes WHERE task_id = ?')
    .get(task_id) as OutcomeRowRaw | undefined;
  return raw != null ? toOutcomeRow(raw) : null;
}
