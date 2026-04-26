import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Database as DB } from 'better-sqlite3';
import { openDatabase } from '../../daemon/dist/storage/db.js';
import { runMigrations } from '../../daemon/dist/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../daemon/dist/storage/migrations/index.js';

export interface WorkspaceOpts {
  cwd?: string;
  cairnRoot?: string;
}

export interface Workspace {
  db: DB;
  cairnRoot: string;
  blobRoot: string;
  cwd: string;
}

export function openWorkspace(opts: WorkspaceOpts = {}): Workspace {
  const cairnRoot = opts.cairnRoot ?? join(homedir(), '.cairn');
  mkdirSync(cairnRoot, { recursive: true });
  const db = openDatabase(join(cairnRoot, 'cairn.db'));
  runMigrations(db, ALL_MIGRATIONS);
  return {
    db,
    cairnRoot,
    blobRoot: cairnRoot,
    cwd: opts.cwd ?? process.cwd(),
  };
}
