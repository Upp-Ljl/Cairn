import type { Database as DB } from 'better-sqlite3';
import { newId } from '../ids.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const DISPATCH_STATUSES = ['PENDING', 'CONFIRMED', 'REJECTED', 'FAILED'] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/** Raw row as stored in SQLite (parsed_intent and context_keys are JSON strings). */
interface DispatchRequestRowRaw {
  id: string;
  nl_intent: string;
  parsed_intent: string | null;
  context_keys: string | null;
  generated_prompt: string | null;
  target_agent: string | null;
  status: string;
  created_at: number;
  confirmed_at: number | null;
}

/** Public-facing type with deserialized JSON fields. */
export interface DispatchRequest {
  id: string;
  nl_intent: string;
  /** Deserialized from parsed_intent JSON, null if not yet parsed. */
  parsed_intent: Record<string, unknown> | null;
  /** Deserialized from context_keys JSON array, null if not set. */
  context_keys: string[] | null;
  generated_prompt: string | null;
  target_agent: string | null;
  status: DispatchStatus;
  created_at: number;
  confirmed_at: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDispatchRequest(row: DispatchRequestRowRaw): DispatchRequest {
  return {
    id: row.id,
    nl_intent: row.nl_intent,
    parsed_intent: row.parsed_intent
      ? (JSON.parse(row.parsed_intent) as Record<string, unknown>)
      : null,
    context_keys: row.context_keys
      ? (JSON.parse(row.context_keys) as string[])
      : null,
    generated_prompt: row.generated_prompt,
    target_agent: row.target_agent,
    status: row.status as DispatchStatus,
    created_at: row.created_at,
    confirmed_at: row.confirmed_at,
  };
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateDispatchRequestInput {
  nlIntent: string;
  parsedIntent?: Record<string, unknown> | null;
  contextKeys?: string[] | null;
  generatedPrompt?: string | null;
  targetAgent?: string | null;
}

export interface ListDispatchRequestsOptions {
  /** Only return requests with this status. */
  status?: DispatchStatus;
  /** Only return requests created at or after this timestamp (ms). */
  since?: number;
  /** Maximum number of results to return. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new dispatch request. Assigns a ULID id, sets created_at = Date.now(),
 * status = 'PENDING'.
 * Returns { id } of the created record.
 */
export function createDispatchRequest(
  db: DB,
  input: CreateDispatchRequestInput,
): { id: string } {
  const id = newId();
  const now = Date.now();
  const row: DispatchRequestRowRaw = {
    id,
    nl_intent: input.nlIntent,
    parsed_intent: input.parsedIntent != null ? JSON.stringify(input.parsedIntent) : null,
    context_keys: input.contextKeys != null ? JSON.stringify(input.contextKeys) : null,
    generated_prompt: input.generatedPrompt ?? null,
    target_agent: input.targetAgent ?? null,
    status: 'PENDING',
    created_at: now,
    confirmed_at: null,
  };
  db.prepare(`
    INSERT INTO dispatch_requests
      (id, nl_intent, parsed_intent, context_keys, generated_prompt,
       target_agent, status, created_at, confirmed_at)
    VALUES
      (@id, @nl_intent, @parsed_intent, @context_keys, @generated_prompt,
       @target_agent, @status, @created_at, @confirmed_at)
  `).run(row);
  return { id };
}

/**
 * Get a single dispatch request by id. Returns null if not found.
 */
export function getDispatchRequest(db: DB, id: string): DispatchRequest | null {
  const row = db
    .prepare('SELECT * FROM dispatch_requests WHERE id = ?')
    .get(id) as DispatchRequestRowRaw | undefined;
  return row ? toDispatchRequest(row) : null;
}

/**
 * List dispatch requests with optional status / since / limit filters.
 * Results are ordered by created_at DESC.
 */
export function listDispatchRequests(
  db: DB,
  opts?: ListDispatchRequestsOptions,
): DispatchRequest[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts?.status !== undefined) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts?.since !== undefined) {
    where.push('created_at >= ?');
    params.push(opts.since);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limitSql = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : '';
  const sql = `SELECT * FROM dispatch_requests ${whereSql} ORDER BY created_at DESC ${limitSql}`.trim();
  const rows = db.prepare(sql).all(...params) as DispatchRequestRowRaw[];
  return rows.map(toDispatchRequest);
}

/**
 * Confirm a dispatch request: PENDING → CONFIRMED, sets confirmed_at = now().
 * Throws if not in PENDING status.
 */
export function confirmDispatchRequest(db: DB, id: string): DispatchRequest {
  const existing = getDispatchRequest(db, id);
  if (!existing) {
    throw new Error(`dispatch request not found: ${id}`);
  }
  if (existing.status !== 'PENDING') {
    throw new Error(`cannot confirm: status is ${existing.status}`);
  }
  const now = Date.now();
  db.prepare(`
    UPDATE dispatch_requests
       SET status = 'CONFIRMED', confirmed_at = ?
     WHERE id = ?
  `).run(now, id);
  return getDispatchRequest(db, id)!;
}

/**
 * Reject a dispatch request: PENDING → REJECTED.
 * Throws if not in PENDING status.
 */
export function rejectDispatchRequest(
  db: DB,
  id: string,
  reason?: string | null,
): DispatchRequest {
  const existing = getDispatchRequest(db, id);
  if (!existing) {
    throw new Error(`dispatch request not found: ${id}`);
  }
  if (existing.status !== 'PENDING') {
    throw new Error(`cannot reject: status is ${existing.status}`);
  }
  db.prepare(`
    UPDATE dispatch_requests
       SET status = 'REJECTED'
     WHERE id = ?
  `).run(id);
  // reason is accepted for API symmetry but not persisted in v0.1 schema
  void reason;
  return getDispatchRequest(db, id)!;
}

/**
 * Mark a dispatch request as failed: PENDING → FAILED.
 * Throws if not in PENDING status.
 */
export function failDispatchRequest(
  db: DB,
  id: string,
  reason?: string | null,
): DispatchRequest {
  const existing = getDispatchRequest(db, id);
  if (!existing) {
    throw new Error(`dispatch request not found: ${id}`);
  }
  if (existing.status !== 'PENDING') {
    throw new Error(`cannot fail: status is ${existing.status}`);
  }
  db.prepare(`
    UPDATE dispatch_requests
       SET status = 'FAILED'
     WHERE id = ?
  `).run(id);
  void reason;
  return getDispatchRequest(db, id)!;
}
