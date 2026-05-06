import type { Database as DB } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const PROCESS_STATUSES = ['ACTIVE', 'IDLE', 'DEAD'] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];

/** Raw row as stored in SQLite (status column holds the registered value). */
interface ProcessRowRaw {
  agent_id: string;
  agent_type: string;
  capabilities: string | null;
  status: string;
  registered_at: number;
  last_heartbeat: number;
  heartbeat_ttl: number;
}

/** Public-facing type with computed status and parsed capabilities. */
export interface Process {
  agent_id: string;
  agent_type: string;
  /** Parsed capabilities list, or null if not provided. */
  capabilities: string[] | null;
  /** Lazily-computed status: if last_heartbeat + heartbeat_ttl < now(), returns 'DEAD'. */
  status: ProcessStatus;
  registered_at: number;
  last_heartbeat: number;
  heartbeat_ttl: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeStatus(row: ProcessRowRaw): ProcessStatus {
  if (row.last_heartbeat + row.heartbeat_ttl < Date.now()) {
    return 'DEAD';
  }
  return row.status as ProcessStatus;
}

function toProcess(row: ProcessRowRaw): Process {
  return {
    agent_id: row.agent_id,
    agent_type: row.agent_type,
    capabilities: row.capabilities ? (JSON.parse(row.capabilities) as string[]) : null,
    status: computeStatus(row),
    registered_at: row.registered_at,
    last_heartbeat: row.last_heartbeat,
    heartbeat_ttl: row.heartbeat_ttl,
  };
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface RegisterProcessInput {
  agentId: string;
  agentType: string;
  capabilities?: string[] | null;
  /** Override heartbeat_ttl (ms). Defaults to 60000. */
  heartbeatTtl?: number;
}

export interface ListProcessesOptions {
  /**
   * Status values to include. Defaults to ['ACTIVE', 'IDLE'] (excludes DEAD).
   * Pass ['ACTIVE', 'IDLE', 'DEAD'] to include all.
   */
  statuses?: ProcessStatus[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register (or replace) a process in the process bus.
 * Uses INSERT OR REPLACE so that a re-registering agent resets its heartbeat.
 */
export function registerProcess(db: DB, input: RegisterProcessInput): Process {
  const now = Date.now();
  const row: ProcessRowRaw = {
    agent_id: input.agentId,
    agent_type: input.agentType,
    capabilities: input.capabilities != null ? JSON.stringify(input.capabilities) : null,
    status: 'ACTIVE',
    registered_at: now,
    last_heartbeat: now,
    heartbeat_ttl: input.heartbeatTtl ?? 60000,
  };
  db.prepare(`
    INSERT OR REPLACE INTO processes
      (agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl)
    VALUES
      (@agent_id, @agent_type, @capabilities, @status, @registered_at, @last_heartbeat, @heartbeat_ttl)
  `).run(row);
  return toProcess(row);
}

/**
 * Update last_heartbeat to now, and reactivate a DEAD process to ACTIVE.
 * Returns the updated Process, or null if the agent_id is not found.
 */
export function heartbeat(db: DB, agentId: string): Process | null {
  const now = Date.now();
  db.prepare(`
    UPDATE processes
       SET last_heartbeat = ?,
           status = CASE WHEN status = 'DEAD' THEN 'ACTIVE' ELSE status END
     WHERE agent_id = ?
  `).run(now, agentId);
  return getProcess(db, agentId);
}

/**
 * Get a single process by agent_id. Lazily computes DEAD status.
 * Returns null if not found.
 */
export function getProcess(db: DB, agentId: string): Process | null {
  const row = db
    .prepare('SELECT * FROM processes WHERE agent_id = ?')
    .get(agentId) as ProcessRowRaw | undefined;
  return row ? toProcess(row) : null;
}

/**
 * List processes. By default returns only ACTIVE and IDLE (excludes DEAD).
 * DEAD status is computed lazily: rows whose last_heartbeat + heartbeat_ttl < now()
 * are treated as DEAD regardless of the stored status column.
 */
export function listProcesses(db: DB, opts?: ListProcessesOptions): Process[] {
  const allowedStatuses: ProcessStatus[] = opts?.statuses ?? ['ACTIVE', 'IDLE'];
  const rows = db
    .prepare('SELECT * FROM processes ORDER BY registered_at DESC')
    .all() as ProcessRowRaw[];
  return rows
    .map(toProcess)
    .filter((p) => allowedStatuses.includes(p.status));
}
