import type { Migration } from './runner.js';

export const migration011DispatchSource: Migration = {
  version: 11,
  name: 'dispatch-source',
  up: (db) => {
    db.exec(`ALTER TABLE dispatch_requests ADD COLUMN source TEXT`);
  },
};
