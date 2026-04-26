import type { Migration } from './runner.js';

export const migration003Checkpoints: Migration = {
  version: 3,
  name: 'checkpoints',
  up: (db) => {
    db.exec(`
      CREATE TABLE checkpoints (
        id              TEXT    PRIMARY KEY,
        task_id         TEXT,
        label           TEXT,
        git_head        TEXT,
        snapshot_dir    TEXT    NOT NULL,
        snapshot_status TEXT    NOT NULL CHECK (snapshot_status IN (
                          'PENDING','READY','CORRUPTED'
                        )),
        size_bytes      INTEGER,
        created_at      INTEGER NOT NULL,
        ready_at        INTEGER
      );
      CREATE INDEX idx_checkpoints_task_id ON checkpoints(task_id);
      CREATE INDEX idx_checkpoints_status  ON checkpoints(snapshot_status);
    `);
  },
};
