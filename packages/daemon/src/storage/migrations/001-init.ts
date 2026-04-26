import type { Migration } from './runner.js';

export const migration001Init: Migration = {
  version: 1,
  name: 'init',
  up: (db) => {
    db.exec(`
      CREATE TABLE lanes (
        id              TEXT    PRIMARY KEY,
        task_id         TEXT,
        sub_agent_id    TEXT,
        checkpoint_id   TEXT,
        endpoint        TEXT    NOT NULL,
        scenario        TEXT,
        state           TEXT    NOT NULL CHECK (state IN (
                          'RECORDED','REVERTING','REVERTED',
                          'PARTIAL_REVERT','HELD_FOR_HUMAN','FAILED_RETRYABLE'
                        )),
        lock_holder     TEXT,
        lock_expires_at INTEGER,
        error           TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_lanes_task_id       ON lanes(task_id);
      CREATE INDEX idx_lanes_sub_agent_id  ON lanes(sub_agent_id);
      CREATE INDEX idx_lanes_state         ON lanes(state);
      CREATE INDEX idx_lanes_checkpoint_id ON lanes(checkpoint_id);
      CREATE INDEX idx_lanes_endpoint      ON lanes(endpoint);

      CREATE TABLE ops (
        id                 TEXT    PRIMARY KEY,
        lane_id            TEXT    NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
        seq                INTEGER NOT NULL,
        method             TEXT    NOT NULL,
        url                TEXT    NOT NULL,
        target             TEXT,
        request_body_json  TEXT,
        request_body_path  TEXT,
        response_status    INTEGER,
        response_body_json TEXT,
        response_body_path TEXT,
        before_image_json  TEXT,
        before_image_path  TEXT,
        classification     TEXT    NOT NULL CHECK (classification IN (
                             'SAFE_REVERT','SEMANTIC_REVERT','MARKED_REVERT','NO_REVERT'
                           )),
        created_at         INTEGER NOT NULL,
        UNIQUE(lane_id, seq)
      );
      CREATE INDEX idx_ops_lane_id        ON ops(lane_id);
      CREATE INDEX idx_ops_classification ON ops(classification);

      CREATE TABLE compensations (
        id              TEXT    PRIMARY KEY,
        op_id           TEXT    NOT NULL REFERENCES ops(id) ON DELETE CASCADE,
        strategy        TEXT    NOT NULL,
        payload_json    TEXT,
        payload_path    TEXT,
        status          TEXT    NOT NULL CHECK (status IN (
                          'PENDING','IN_PROGRESS','SUCCESS','FAILED','SKIPPED'
                        )),
        attempt         INTEGER NOT NULL DEFAULT 0,
        max_attempts    INTEGER NOT NULL DEFAULT 3,
        last_attempt_at INTEGER,
        last_error      TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_compensations_op_id  ON compensations(op_id);
      CREATE INDEX idx_compensations_status ON compensations(status);
    `);
  },
};
