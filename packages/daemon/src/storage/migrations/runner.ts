import { createHash } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (db: DB) => void;
}

function checksum(fn: Migration['up']): string {
  return createHash('sha256').update(fn.toString()).digest('hex');
}

export function runMigrations(db: DB, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      checksum   TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const appliedRows = db.prepare('SELECT version, checksum FROM schema_migrations').all() as
    { version: number; checksum: string }[];
  const applied = new Map(appliedRows.map((r) => [r.version, r.checksum]));

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)'
  );

  for (const m of sorted) {
    const cs = checksum(m.up);
    const prev = applied.get(m.version);
    if (prev != null) {
      if (prev !== cs) {
        throw new Error(
          `migration ${m.version} (${m.name}) checksum mismatch: DB=${prev} code=${cs}`
        );
      }
      continue;
    }
    db.transaction(() => {
      m.up(db);
      insert.run(m.version, m.name, cs, Date.now());
    })();
  }
}
