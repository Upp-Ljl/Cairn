import type { Migration } from './runner.js';

export const migration005DispatchRequests: Migration = {
  version: 5,
  name: 'dispatch-requests',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_requests (
        id               TEXT    PRIMARY KEY,
        nl_intent        TEXT    NOT NULL,
        parsed_intent    TEXT,
        context_keys     TEXT,
        generated_prompt TEXT,
        target_agent     TEXT,
        status           TEXT    NOT NULL CHECK (status IN (
                           'PENDING',
                           'CONFIRMED',
                           'REJECTED',
                           'FAILED'
                         )),
        created_at       INTEGER NOT NULL,
        confirmed_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_requests_status     ON dispatch_requests(status);
      CREATE INDEX IF NOT EXISTS idx_dispatch_requests_created_at ON dispatch_requests(created_at);
    `);
  },
};
