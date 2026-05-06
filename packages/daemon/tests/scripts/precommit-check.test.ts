/**
 * Tests for cairn-precommit-check.mjs (v2 — PENDING_REVIEW write).
 *
 * Strategy: spawn the script as a subprocess against a temp DB that is
 * pre-seeded with known conflict data, then assert exit 0, stderr output,
 * and DB state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';

// Path to the script under test (absolute)
const SCRIPT_PATH = join(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
  '../../scripts/cairn-precommit-check.mjs',
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestCtx {
  tmpHome: string;
  cairnDir: string;
  dbPath: string;
  db: Database.Database;
}

function makeTestDb(): TestCtx {
  const tmpHome = mkdtempSync(join(tmpdir(), 'cairn-hook-test-'));
  const cairnDir = join(tmpHome, '.cairn');
  mkdirSync(cairnDir, { recursive: true });
  const dbPath = join(cairnDir, 'cairn.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  runMigrations(db, ALL_MIGRATIONS);
  return { tmpHome, cairnDir, dbPath, db };
}

function runScript(
  ctx: TestCtx,
  stagedFiles: string,
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--staged-files', stagedFiles],
    {
      env: {
        ...process.env,
        HOME: ctx.tmpHome,         // Unix home
        USERPROFILE: ctx.tmpHome,  // Windows home (os.homedir() reads this)
        ...env,
      },
      encoding: 'utf-8',
    },
  );
}

function seedOpenConflict(
  db: Database.Database,
  opts: { agentA?: string; agentB?: string | null; paths?: string[]; status?: string } = {},
): string {
  const id = '01JTEST000000000000000001A';
  db.prepare(`
    INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, agent_b, paths_json, summary, status)
    VALUES (?, ?, 'FILE_OVERLAP', ?, ?, ?, 'test conflict', ?)
  `).run(
    id,
    Date.now(),
    opts.agentA ?? 'agent-a',
    opts.agentB !== undefined ? opts.agentB : 'agent-b',
    JSON.stringify(opts.paths ?? ['src/foo.ts']),
    opts.status ?? 'OPEN',
  );
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cairn-precommit-check.mjs', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeTestDb();
  });

  afterEach(() => {
    ctx.db.close();
    rmSync(ctx.tmpHome, { recursive: true, force: true });
  });

  it('exits 0 with no staged files', () => {
    const result = runScript(ctx, '');
    expect(result.status).toBe(0);
  });

  it('exits 0 with no matching conflicts (clean slate)', () => {
    const result = runScript(ctx, 'src/foo.ts');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 0 and prints warning when OPEN conflict matches staged path', () => {
    seedOpenConflict(ctx.db, { paths: ['src/foo.ts'] });
    const result = runScript(ctx, 'src/foo.ts');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('src/foo.ts');
    expect(result.stderr).toContain('FILE_OVERLAP');
  });

  it('inserts PENDING_REVIEW row when cross-agent OPEN conflict matches staged path', () => {
    seedOpenConflict(ctx.db, {
      agentA: 'agent-a',
      agentB: 'agent-b',
      paths: ['src/foo.ts'],
    });
    ctx.db.close(); // close before script opens it

    const result = runScript(ctx, 'src/foo.ts', {
      CAIRN_SESSION_AGENT_ID: 'precommit-test-agent',
    });
    expect(result.status).toBe(0);

    // Re-open to inspect
    const db2 = new Database(ctx.dbPath, { readonly: true, fileMustExist: true });
    const rows = db2
      .prepare("SELECT * FROM conflicts WHERE status = 'PENDING_REVIEW'")
      .all() as Array<{ agent_a: string; paths_json: string; summary: string }>;
    db2.close();

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const pr = rows[0]!;
    expect(pr.agent_a).toBe('precommit-test-agent');
    expect(pr.summary).toContain('awaiting user review');

    // Reassign to prevent afterEach from closing already-closed db
    ctx.db = new Database(ctx.dbPath);
  });

  it('does NOT insert PENDING_REVIEW when conflict has agent_b = null (single-agent)', () => {
    seedOpenConflict(ctx.db, {
      agentA: 'agent-a',
      agentB: null,
      paths: ['src/foo.ts'],
    });
    ctx.db.close();

    const result = runScript(ctx, 'src/foo.ts');
    expect(result.status).toBe(0);

    const db2 = new Database(ctx.dbPath, { readonly: true, fileMustExist: true });
    const count = (
      db2.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE status = 'PENDING_REVIEW'").get() as { n: number }
    ).n;
    db2.close();

    expect(count).toBe(0);

    ctx.db = new Database(ctx.dbPath);
  });

  it('exits 0 when DB does not exist (fail-open)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'cairn-nodb-'));
    try {
      const result = spawnSync(
        process.execPath,
        [SCRIPT_PATH, '--staged-files', 'src/foo.ts'],
        {
          env: {
            ...process.env,
            HOME: fakeHome,
            USERPROFILE: fakeHome,
          },
          encoding: 'utf-8',
        },
      );
      expect(result.status).toBe(0);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
