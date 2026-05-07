import type { Migration } from './runner.js';

// ON DELETE CASCADE: an outcome has no meaning without its task.
// When a task is deleted, its outcome is removed automatically — same policy as blockers.
// UNIQUE(task_id) is a hard invariant: exactly one outcome per task, forever.
// All 4 statuses are included in the CHECK (PENDING/PASS/FAIL/TERMINAL_FAIL) so v1
// never needs a re-migration to add a status value.
export const migration010Outcomes: Migration = {
  version: 10,
  name: 'outcomes',
  up: (db) => {
    db.exec(`
      CREATE TABLE outcomes (
        outcome_id         TEXT    PRIMARY KEY,
        task_id            TEXT    NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE CASCADE,
        criteria_json      TEXT    NOT NULL,
        status             TEXT    NOT NULL CHECK (status IN ('PENDING','PASS','FAIL','TERMINAL_FAIL')),
        evaluated_at       INTEGER,
        evaluation_summary TEXT,
        grader_agent_id    TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        metadata_json      TEXT
      );
      CREATE INDEX idx_outcomes_status ON outcomes(status);
    `);
  },
};
