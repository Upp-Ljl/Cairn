import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../src/storage/db.js';

describe('openDatabase', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tmp() {
    const d = mkdtempSync(join(tmpdir(), 'cairn-db-'));
    dirs.push(d);
    return join(d, 'cairn.db');
  }

  it('applies WAL, foreign_keys, busy_timeout, synchronous=NORMAL', () => {
    const db = openDatabase(tmp());
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    db.close();
  });

  it('readonly mode sets query_only', () => {
    const path = tmp();
    openDatabase(path).close();
    const db = openDatabase(path, { readonly: true });
    expect(db.pragma('query_only', { simple: true })).toBe(1);
    db.close();
  });
});
