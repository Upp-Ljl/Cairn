import type { Migration } from './runner.js';

export const migration007Tasks: Migration = {
  version: 7,
  name: 'tasks',
  up: (db) => {
    db.exec(`
      CREATE TABLE tasks (
        task_id           TEXT    PRIMARY KEY,
        intent            TEXT    NOT NULL,
        state             TEXT    NOT NULL CHECK (state IN (
                            'PENDING',
                            'RUNNING',
                            'BLOCKED',
                            'READY_TO_RESUME',
                            'WAITING_REVIEW',
                            'DONE',
                            'FAILED',
                            'CANCELLED'
                          )),
        parent_task_id    TEXT    REFERENCES tasks(task_id) ON DELETE SET NULL,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        created_by_agent_id TEXT,
        metadata_json     TEXT
      );
      CREATE INDEX idx_tasks_state      ON tasks(state);
      CREATE INDEX idx_tasks_parent     ON tasks(parent_task_id);
      CREATE INDEX idx_tasks_created_at ON tasks(created_at);
    `);
  },
};
