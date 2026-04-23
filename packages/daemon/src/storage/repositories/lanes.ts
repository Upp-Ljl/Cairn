import type { Database as DB } from 'better-sqlite3';
import { newId } from '../ids.js';
import type { LaneRow, LaneState } from '../types.js';

export interface NewLane {
  endpoint: string;
  scenario?: string | null;
  task_id?: string | null;
  sub_agent_id?: string | null;
  checkpoint_id?: string | null;
}

export function createLane(db: DB, input: NewLane): LaneRow {
  const now = Date.now();
  const row: LaneRow = {
    id: newId(),
    task_id: input.task_id ?? null,
    sub_agent_id: input.sub_agent_id ?? null,
    checkpoint_id: input.checkpoint_id ?? null,
    endpoint: input.endpoint,
    scenario: input.scenario ?? null,
    state: 'RECORDED',
    lock_holder: null,
    lock_expires_at: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO lanes
       (id, task_id, sub_agent_id, checkpoint_id, endpoint, scenario,
        state, lock_holder, lock_expires_at, error, created_at, updated_at)
     VALUES
       (@id, @task_id, @sub_agent_id, @checkpoint_id, @endpoint, @scenario,
        @state, @lock_holder, @lock_expires_at, @error, @created_at, @updated_at)`
  ).run(row);
  return row;
}

export function getLaneById(db: DB, id: string): LaneRow | null {
  const row = db.prepare('SELECT * FROM lanes WHERE id = ?').get(id) as LaneRow | undefined;
  return row ?? null;
}

export function listLanesByTask(db: DB, taskId: string | null, state?: LaneState): LaneRow[] {
  const params: unknown[] = [];
  let sql = 'SELECT * FROM lanes WHERE ';
  if (taskId === null) sql += 'task_id IS NULL';
  else {
    sql += 'task_id = ?';
    params.push(taskId);
  }
  if (state) {
    sql += ' AND state = ?';
    params.push(state);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params) as LaneRow[];
}
