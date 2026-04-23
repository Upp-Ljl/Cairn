import Database, { type Database as DB } from 'better-sqlite3';

export interface OpenOpts {
  readonly?: boolean;
}

export function openDatabase(path: string, opts: OpenOpts = {}): DB {
  const db = new Database(path, { readonly: opts.readonly ?? false });
  if (opts.readonly) {
    db.pragma('query_only = ON');
  } else {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
