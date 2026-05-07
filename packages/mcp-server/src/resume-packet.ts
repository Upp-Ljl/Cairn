/**
 * resume-packet.ts — assembleResumePacket + validateResumePacket
 *
 * LD-9: assembleResumePacket is read-only. No INSERT/UPDATE/DELETE ever.
 * All timestamps are INTEGER unix ms (per LD-5 patch over Phase 1 plan §6 ISO spec).
 */

import type { Database as DB } from 'better-sqlite3';
import {
  getTask,
} from '../../daemon/dist/storage/repositories/tasks.js';
import {
  listBlockersByTask,
} from '../../daemon/dist/storage/repositories/blockers.js';
import type { TaskState } from '../../daemon/dist/storage/tasks-state.js';
import {
  getOutcomeByTask,
} from '../../daemon/dist/storage/repositories/outcomes.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface ResumePacket {
  task_id: string;
  intent: string;
  current_state: TaskState;
  last_checkpoint_sha: string | null;
  open_blockers: Array<{
    blocker_id: string;
    question: string;
    context_keys: string[];
    raised_at: number;
  }>;
  answered_blockers: Array<{
    blocker_id: string;
    question: string;
    answer: string;
    answered_by: string;
    answered_at: number;
  }>;
  scratchpad_keys: string[];
  outcomes_criteria: Array<{ primitive: string; args: unknown[] }>; // always [] in Phase 2
  audit_trail_summary: string; // deterministic markdown
}

// ---------------------------------------------------------------------------
// Internal DB row types (for direct SELECT prepared statements)
// ---------------------------------------------------------------------------

interface CheckpointRow {
  id: string;
  git_head: string | null;
  created_at: number;
  snapshot_status: string;
  label: string | null;
}

interface ScratchpadKeyRow {
  key: string;
}

interface DispatchRow {
  id: string;
  nl_intent: string;
  created_at: number;
  status: string;
}

interface BlockerAuditRow {
  blocker_id: string;
  question: string;
  status: string;
  raised_at: number;
  answered_at: number | null;
  answer: string | null;
}

// ---------------------------------------------------------------------------
// assembleResumePacket
// ---------------------------------------------------------------------------

/**
 * Build a structured resume packet for a task from DB.
 * Returns null if the task does not exist.
 *
 * LD-9: READ-ONLY. Only SELECT statements via getTask, listBlockersByTask,
 * and direct SELECT prepared statements. Never INSERT/UPDATE/DELETE.
 */
export function assembleResumePacket(db: DB, task_id: string): ResumePacket | null {
  // Step 1: load task
  const task = getTask(db, task_id);
  if (task === null) return null;

  // Step 2: last READY checkpoint sha — never PENDING/CORRUPTED (LD-5 patch)
  const cpRow = db
    .prepare(
      `SELECT git_head, created_at FROM checkpoints
       WHERE task_id = ? AND snapshot_status = 'READY'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(task_id) as Pick<CheckpointRow, 'git_head' | 'created_at'> | undefined;
  // Note: cpRow uses the actual checkpoints table columns (id, git_head, etc.)

  const last_checkpoint_sha: string | null = cpRow?.git_head ?? null;

  // Step 3: open blockers — raised_at ASC (listBlockersByTask default order)
  const openBlockersRaw = listBlockersByTask(db, task_id, { status: 'OPEN' });
  const open_blockers = openBlockersRaw.map((b) => ({
    blocker_id: b.blocker_id,
    question: b.question,
    context_keys: b.context_keys ?? [],
    raised_at: b.raised_at,
  }));

  // Step 4: answered blockers — answered_at DESC, cap at 10
  const answeredBlockersRaw = listBlockersByTask(db, task_id, { status: 'ANSWERED' });
  const answered_blockers = answeredBlockersRaw
    .sort((a, b) => (b.answered_at ?? 0) - (a.answered_at ?? 0))
    .slice(0, 10)
    .map((b) => ({
      blocker_id: b.blocker_id,
      question: b.question,
      answer: b.answer!,
      answered_by: b.answered_by!,
      answered_at: b.answered_at!,
    }));

  // Step 5: scratchpad keys for this task, ordered by created_at ASC
  const scratchpadRows = db
    .prepare(
      `SELECT key FROM scratchpad WHERE task_id = ? ORDER BY created_at ASC`,
    )
    .all(task_id) as ScratchpadKeyRow[];
  const scratchpad_keys = scratchpadRows.map((r) => r.key);

  // Step 6: outcomes_criteria — populated from outcomes table (Phase 3)
  const outcome = getOutcomeByTask(db, task_id);
  const outcomes_criteria = outcome ? (outcome.criteria as Array<{ primitive: string; args: unknown[] }>) : [];

  // Step 7: audit_trail_summary — deterministic markdown (no LLM)
  const audit_trail_summary = buildAuditTrail(db, task_id, task);

  return {
    task_id,
    intent: task.intent,
    current_state: task.state,
    last_checkpoint_sha,
    open_blockers,
    answered_blockers,
    scratchpad_keys,
    outcomes_criteria,
    audit_trail_summary,
  };
}

// ---------------------------------------------------------------------------
// Audit trail builder (deterministic markdown, no LLM)
// ---------------------------------------------------------------------------

function buildAuditTrail(
  db: DB,
  task_id: string,
  task: { intent: string; created_at: number; task_id: string },
): string {
  // Collect events from dispatch_requests, checkpoints, and blockers
  const events: Array<{ ts: number; line: string }> = [];

  // Task creation
  events.push({
    ts: task.created_at,
    line: `- ${new Date(task.created_at).toISOString()} TASK_CREATED intent="${task.intent}"`,
  });

  // Dispatch requests linked to this task (task_id column added in migration 008)
  const dispatchRows = db
    .prepare(
      `SELECT id, nl_intent, created_at, status
       FROM dispatch_requests WHERE task_id = ? ORDER BY created_at ASC`,
    )
    .all(task_id) as DispatchRow[];

  for (const d of dispatchRows) {
    events.push({
      ts: d.created_at,
      line: `- ${new Date(d.created_at).toISOString()} DISPATCH[${d.status}] id=${d.id.slice(0, 8)} intent="${d.nl_intent}"`,
    });
  }

  // Checkpoints linked to this task
  const cpRows = db
    .prepare(
      `SELECT id, git_head, created_at, snapshot_status, label
       FROM checkpoints WHERE task_id = ? ORDER BY created_at ASC`,
    )
    .all(task_id) as CheckpointRow[];

  for (const c of cpRows) {
    const sha = c.git_head ? c.git_head.slice(0, 8) : 'no-sha';
    const lbl = c.label ? ` label="${c.label}"` : '';
    events.push({
      ts: c.created_at,
      line: `- ${new Date(c.created_at).toISOString()} CHECKPOINT[${c.snapshot_status}] id=${c.id.slice(0, 8)} sha=${sha}${lbl}`,
    });
  }

  // Blockers — raised and answered events
  const blockerRows = db
    .prepare(
      `SELECT blocker_id, question, status, raised_at, answered_at, answer
       FROM blockers WHERE task_id = ? ORDER BY raised_at ASC`,
    )
    .all(task_id) as BlockerAuditRow[];

  for (const b of blockerRows) {
    events.push({
      ts: b.raised_at,
      line: `- ${new Date(b.raised_at).toISOString()} BLOCKER_RAISED[${b.blocker_id.slice(0, 8)}] "${b.question}"`,
    });
    if (b.status === 'ANSWERED' && b.answered_at !== null) {
      events.push({
        ts: b.answered_at,
        line: `- ${new Date(b.answered_at).toISOString()} BLOCKER_ANSWERED[${b.blocker_id.slice(0, 8)}] answer="${b.answer ?? ''}"`,
      });
    }
  }

  // Sort all events by ts DESC, cap at 50, then re-sort ASC for display
  events.sort((a, b) => b.ts - a.ts);
  const capped = events.slice(0, 50);
  capped.sort((a, b) => a.ts - b.ts);

  const lines = [
    `## Task ${task.task_id}`,
    `Intent: ${task.intent}`,
    `Created: ${new Date(task.created_at).toISOString()}`,
    '',
    '### Audit Trail',
    ...capped.map((e) => e.line),
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// validateResumePacket — hand-rolled validator (no zod/ajv)
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value against the ResumePacket schema.
 * Returns { ok: true, packet } on success or { ok: false, errors } with
 * human-readable error descriptions on failure.
 */
export function validateResumePacket(
  p: unknown,
): { ok: true; packet: ResumePacket } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (p === null || typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, errors: ['root value must be a non-null object'] };
  }

  const obj = p as Record<string, unknown>;

  // ---- Scalar required fields ----
  if (typeof obj['task_id'] !== 'string') {
    errors.push('task_id must be a string');
  }
  if (typeof obj['intent'] !== 'string') {
    errors.push('intent must be a string');
  }
  if (typeof obj['current_state'] !== 'string') {
    errors.push('current_state must be a string');
  }
  // last_checkpoint_sha may be string or null
  if (obj['last_checkpoint_sha'] !== null && typeof obj['last_checkpoint_sha'] !== 'string') {
    errors.push('last_checkpoint_sha must be a string or null');
  }
  // audit_trail_summary
  if (typeof obj['audit_trail_summary'] !== 'string') {
    errors.push('audit_trail_summary must be a string');
  }

  // ---- open_blockers ----
  if (!Array.isArray(obj['open_blockers'])) {
    errors.push('open_blockers must be an array');
  } else {
    (obj['open_blockers'] as unknown[]).forEach((item, i) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`open_blockers[${i}] must be an object`);
        return;
      }
      const b = item as Record<string, unknown>;
      if (typeof b['blocker_id'] !== 'string') errors.push(`open_blockers[${i}].blocker_id must be a string`);
      if (typeof b['question'] !== 'string') errors.push(`open_blockers[${i}].question must be a string`);
      if (!Array.isArray(b['context_keys'])) errors.push(`open_blockers[${i}].context_keys must be an array`);
      if (typeof b['raised_at'] !== 'number') errors.push(`open_blockers[${i}].raised_at must be a number`);
    });
  }

  // ---- answered_blockers ----
  if (!Array.isArray(obj['answered_blockers'])) {
    errors.push('answered_blockers must be an array');
  } else {
    (obj['answered_blockers'] as unknown[]).forEach((item, i) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`answered_blockers[${i}] must be an object`);
        return;
      }
      const b = item as Record<string, unknown>;
      if (typeof b['blocker_id'] !== 'string') errors.push(`answered_blockers[${i}].blocker_id must be a string`);
      if (typeof b['question'] !== 'string') errors.push(`answered_blockers[${i}].question must be a string`);
      if (typeof b['answer'] !== 'string') errors.push(`answered_blockers[${i}].answer must be a string`);
      if (typeof b['answered_by'] !== 'string') errors.push(`answered_blockers[${i}].answered_by must be a string`);
      if (typeof b['answered_at'] !== 'number') errors.push(`answered_blockers[${i}].answered_at must be a number`);
    });
  }

  // ---- scratchpad_keys ----
  if (!Array.isArray(obj['scratchpad_keys'])) {
    errors.push('scratchpad_keys must be an array');
  } else {
    (obj['scratchpad_keys'] as unknown[]).forEach((item, i) => {
      if (typeof item !== 'string') errors.push(`scratchpad_keys[${i}] must be a string`);
    });
  }

  // ---- outcomes_criteria ----
  if (!Array.isArray(obj['outcomes_criteria'])) {
    errors.push('outcomes_criteria must be an array');
  } else {
    (obj['outcomes_criteria'] as unknown[]).forEach((item, i) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`outcomes_criteria[${i}] must be an object`);
        return;
      }
      const c = item as Record<string, unknown>;
      if (typeof c['primitive'] !== 'string') errors.push(`outcomes_criteria[${i}].primitive must be a string`);
      if (!Array.isArray(c['args'])) errors.push(`outcomes_criteria[${i}].args must be an array`);
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, packet: p as ResumePacket };
}
