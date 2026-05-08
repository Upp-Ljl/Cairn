import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { Database as DB } from 'better-sqlite3';
import { openDatabase } from '../../daemon/dist/storage/db.js';
import { runMigrations } from '../../daemon/dist/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../daemon/dist/storage/migrations/index.js';

export interface WorkspaceOpts {
  cwd?: string;
  cairnRoot?: string;
  /**
   * Override the random session id (e.g. for deterministic tests).
   * Production code MUST NOT pass this — every mcp-server boot needs
   * its own unique session.
   */
  sessionId?: string;
}

export interface Workspace {
  db: DB;
  cairnRoot: string;
  blobRoot: string;
  cwd: string;
  /**
   * Session-level identity, regenerated per mcp-server boot.
   * Format: `cairn-session-<12hex>` (24 chars).
   *
   * History: prior to Real Agent Presence v2 this was a deterministic
   * `cairn-<sha1(host:gitRoot).slice(0,12)>` (18 chars) — project-level
   * stable. That made multiple terminal sessions in the same project
   * collapse into a single processes row. Identity is now per-process.
   * Project attribution lives in capabilities tags + registry hints.
   */
  agentId: string;
  /** Canonical git toplevel of `cwd`, falling back to `cwd` itself. */
  gitRoot: string;
  /** Random 12-hex session suffix (= the trailing chars of agentId). */
  sessionId: string;
  /** Hostname (cached at boot) — also surfaced in capabilities tags. */
  host: string;
}

function resolveGitRoot(cwd: string): string {
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      cwd,
      timeout: 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top.length > 0) return top;
  } catch {
    // Not a git repo, git unavailable, or timeout — fall through.
  }
  return cwd;
}

function newSessionId(): string {
  return randomBytes(6).toString('hex'); // 12 hex chars
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
  const gitRoot = resolveGitRoot(cwd);
  const sessionId = opts.sessionId ?? newSessionId();
  const agentId = 'cairn-session-' + sessionId;
  process.env['CAIRN_SESSION_AGENT_ID'] = agentId;
  return {
    db,
    cairnRoot,
    blobRoot: cairnRoot,
    cwd,
    agentId,
    gitRoot,
    sessionId,
    host: hostname(),
  };
}
