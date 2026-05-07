import type { Migration } from './runner.js';

// SQLite 3.53.0 (bundled with better-sqlite3@^12.9.0) accepts FK references in
// ALTER TABLE ADD COLUMN and enforces them when `foreign_keys = ON` (set in db.ts).
// Verified: INSERT with a nonexistent task_id throws FOREIGN KEY constraint failed.
export const migration008DispatchTaskId: Migration = {
  version: 8,
  name: 'dispatch-task-id',
  up: (db) => {
    db.exec(`
      ALTER TABLE dispatch_requests ADD COLUMN task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL;
      CREATE INDEX idx_dispatch_requests_task_id ON dispatch_requests(task_id);
    `);
  },
};
