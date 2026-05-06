import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
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
  agentId: string;
}

function computeAgentId(cwd: string): string {
  // Canonicalize to git toplevel so subdirs of the same repo share an agentId.
  // Falls back to raw cwd if not inside a git repo (or git unavailable).
  let canonicalPath = cwd;
  try {
    const topLevel = execSync('git rev-parse --show-toplevel', {
      cwd,
      timeout: 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (topLevel.length > 0) {
      canonicalPath = topLevel;
    }
  } catch {
    // Not a git repo or git not available — use raw cwd
  }
  const raw = hostname() + ':' + canonicalPath;
  const hash = createHash('sha1').update(raw).digest('hex');
  return 'cairn-' + hash.slice(0, 12);
}

export function openWorkspace(opts: WorkspaceOpts = {}): Workspace {
  const cairnRoot =
    opts.cairnRoot ??
    process.env['CAIRN_HOME'] ??
    join(homedir(), '.cairn');
  mkdirSync(cairnRoot, { recursive: true });
  const db = openDatabase(join(cairnRoot, 'cairn.db'));
  runMigrations(db, ALL_MIGRATIONS);
  const cwd = opts.cwd ?? process.cwd();
  const agentId = computeAgentId(cwd);
  process.env['CAIRN_SESSION_AGENT_ID'] = agentId;
  return {
    db,
    cairnRoot,
    blobRoot: cairnRoot,
    cwd,
    agentId,
  };
}
