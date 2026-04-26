import type { Migration } from './runner.js';

export const migration002Scratchpad: Migration = {
  version: 2,
  name: 'scratchpad',
  up: (db) => {
    db.exec(`
      CREATE TABLE scratchpad (
        key        TEXT    PRIMARY KEY,
        value_json TEXT,
        value_path TEXT,
        task_id    TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_scratchpad_task_id    ON scratchpad(task_id);
      CREATE INDEX idx_scratchpad_expires_at ON scratchpad(expires_at);
    `);
  },
};
