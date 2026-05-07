import type { Migration } from './runner.js';

// ON DELETE CASCADE: a blocker has no meaning without its task.
// When a task is deleted, all its blockers are removed automatically.
// This differs from dispatch_requests which uses SET NULL to preserve historical records.
//
// SUPERSEDED is included in the CHECK constraint for schema-completeness (Phase 3+).
// Phase 2 v1 only writes OPEN and ANSWERED; SUPERSEDED is reserved to avoid a future migration.
export const migration009Blockers: Migration = {
  version: 9,
  name: 'blockers',
  up: (db) => {
    db.exec(`
      CREATE TABLE blockers (
        blocker_id     TEXT    PRIMARY KEY,
        task_id        TEXT    NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        question       TEXT    NOT NULL,
        context_keys   TEXT,
        status         TEXT    NOT NULL CHECK (status IN ('OPEN','ANSWERED','SUPERSEDED')),
        raised_by      TEXT,
        raised_at      INTEGER NOT NULL,
        answer         TEXT,
        answered_by    TEXT,
        answered_at    INTEGER,
        metadata_json  TEXT
      );
      CREATE INDEX idx_blockers_task   ON blockers(task_id);
      CREATE INDEX idx_blockers_status ON blockers(status);
    `);
  },
};
