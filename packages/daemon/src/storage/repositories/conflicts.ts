import type { Database as DB } from 'better-sqlite3';
import { newId } from '../ids.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const CONFLICT_TYPES = ['FILE_OVERLAP', 'STATE_CONFLICT', 'INTENT_BOUNDARY'] as const;
export type ConflictType = (typeof CONFLICT_TYPES)[number];

export const CONFLICT_STATUSES = ['OPEN', 'RESOLVED', 'IGNORED'] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

/** Raw row as stored in SQLite (paths_json is a JSON string). */
interface ConflictRowRaw {
  id: string;
  detected_at: number;
  conflict_type: string;
  agent_a: string;
  agent_b: string | null;
  paths_json: string;
  summary: string | null;
  status: string;
  resolved_at: number | null;
  resolution: string | null;
}

/** Public-facing type with parsed paths array. */
export interface Conflict {
  id: string;
  detected_at: number;
  conflict_type: ConflictType;
  agent_a: string;
  agent_b: string | null;
  /** Deserialized from paths_json. */
  paths: string[];
  summary: string | null;
  status: ConflictStatus;
  resolved_at: number | null;
  resolution: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toConflict(row: ConflictRowRaw): Conflict {
  return {
    id: row.id,
    detected_at: row.detected_at,
    conflict_type: row.conflict_type as ConflictType,
    agent_a: row.agent_a,
    agent_b: row.agent_b,
    paths: JSON.parse(row.paths_json) as string[],
    summary: row.summary,
    status: row.status as ConflictStatus,
    resolved_at: row.resolved_at,
    resolution: row.resolution,
  };
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface RecordConflictInput {
  conflictType: ConflictType;
  agentA: string;
  agentB?: string | null;
  paths: string[];
  summary?: string | null;
}

export interface ListConflictsOptions {
  /** Only return conflicts detected at or after this timestamp (ms). */
  since?: number;
  /** Filter by status. */
  status?: ConflictStatus;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a new conflict. Assigns a ULID id, sets detected_at = now(), status = 'OPEN'.
 */
export function recordConflict(db: DB, input: RecordConflictInput): Conflict {
  const now = Date.now();
  const row: ConflictRowRaw = {
    id: newId(),
    detected_at: now,
    conflict_type: input.conflictType,
    agent_a: input.agentA,
    agent_b: input.agentB ?? null,
    paths_json: JSON.stringify(input.paths),
    summary: input.summary ?? null,
    status: 'OPEN',
    resolved_at: null,
    resolution: null,
  };
  db.prepare(`
    INSERT INTO conflicts
      (id, detected_at, conflict_type, agent_a, agent_b, paths_json,
       summary, status, resolved_at, resolution)
    VALUES
      (@id, @detected_at, @conflict_type, @agent_a, @agent_b, @paths_json,
       @summary, @status, @resolved_at, @resolution)
  `).run(row);
  return toConflict(row);
}

/**
 * Get a single conflict by id. Returns null if not found.
 */
export function getConflict(db: DB, id: string): Conflict | null {
  const row = db
    .prepare('SELECT * FROM conflicts WHERE id = ?')
    .get(id) as ConflictRowRaw | undefined;
  return row ? toConflict(row) : null;
}

/**
 * List conflicts with optional since / status filters.
 * Results are ordered by detected_at DESC.
 */
export function listConflicts(db: DB, opts?: ListConflictsOptions): Conflict[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts?.since !== undefined) {
    where.push('detected_at >= ?');
    params.push(opts.since);
  }
  if (opts?.status !== undefined) {
    where.push('status = ?');
    params.push(opts.status);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT * FROM conflicts ${whereSql} ORDER BY detected_at DESC`;
  const rows = db.prepare(sql).all(...params) as ConflictRowRaw[];
  return rows.map(toConflict);
}

/**
 * Resolve a conflict: set status = 'RESOLVED', record resolution text and resolved_at.
 * Returns the updated Conflict, or null if not found.
 */
export function resolveConflict(db: DB, id: string, resolution: string): Conflict | null {
  const now = Date.now();
  db.prepare(`
    UPDATE conflicts
       SET status = 'RESOLVED',
           resolution = ?,
           resolved_at = ?
     WHERE id = ?
  `).run(resolution, now, id);
  return getConflict(db, id);
}
