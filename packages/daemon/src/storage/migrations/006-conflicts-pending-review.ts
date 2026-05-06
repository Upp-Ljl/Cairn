import type { Migration } from './runner.js';

export const migration006ConflictsPendingReview: Migration = {
  version: 6,
  name: 'conflicts-pending-review',
  up: (db) => {
    db.exec(`
      CREATE TABLE conflicts_new (
        id            TEXT    PRIMARY KEY,
        detected_at   INTEGER NOT NULL,
        conflict_type TEXT    NOT NULL CHECK (conflict_type IN (
                        'FILE_OVERLAP',
                        'STATE_CONFLICT',
                        'INTENT_BOUNDARY'
                      )),
        agent_a       TEXT    NOT NULL,
        agent_b       TEXT,
        paths_json    TEXT    NOT NULL,
        summary       TEXT,
        status        TEXT    NOT NULL CHECK (status IN (
                        'OPEN',
                        'RESOLVED',
                        'IGNORED',
                        'PENDING_REVIEW'
                      )),
        resolved_at   INTEGER,
        resolution    TEXT
      );
      INSERT INTO conflicts_new SELECT * FROM conflicts;
      DROP TABLE conflicts;
      ALTER TABLE conflicts_new RENAME TO conflicts;
      CREATE INDEX idx_conflicts_detected_at ON conflicts(detected_at);
      CREATE INDEX idx_conflicts_status      ON conflicts(status);
    `);
  },
};
