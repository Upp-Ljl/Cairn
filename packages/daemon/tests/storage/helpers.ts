import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import type { Database as DB } from 'better-sqlite3';

const cleanup: { dir: string; db: DB }[] = [];

afterEach(() => {
  for (const { db, dir } of cleanup) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  cleanup.length = 0;
});

export function makeTmpDb(): { db: DB; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-'));
  const db = openDatabase(join(dir, 'cairn.db'));
  cleanup.push({ db, dir });
  return { db, dir };
}
