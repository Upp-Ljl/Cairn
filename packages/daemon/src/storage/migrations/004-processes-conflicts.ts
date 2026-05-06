import type { Migration } from './runner.js';

export const migration004ProcessesConflicts: Migration = {
  version: 4,
  name: 'processes-conflicts',
  up: (db) => {
    db.exec(`
      CREATE TABLE processes (
        agent_id       TEXT    PRIMARY KEY,
        agent_type     TEXT    NOT NULL,
        capabilities   TEXT,
        status         TEXT    NOT NULL CHECK (status IN ('ACTIVE', 'IDLE', 'DEAD')),
        registered_at  INTEGER NOT NULL,
        last_heartbeat INTEGER NOT NULL,
        heartbeat_ttl  INTEGER NOT NULL DEFAULT 60000
      );
      CREATE INDEX idx_processes_status ON processes(status);

      CREATE TABLE conflicts (
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
        status        TEXT    NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'IGNORED')),
        resolved_at   INTEGER,
        resolution    TEXT
      );
      CREATE INDEX idx_conflicts_detected_at ON conflicts(detected_at);
      CREATE INDEX idx_conflicts_status      ON conflicts(status);
    `);
  },
};
