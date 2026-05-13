/**
 * cairn.task.* — 8 semantic verb tools for Task Capsule lifecycle (W5 Phase 1+2)
 *
 * Tools exposed:
 *   cairn.task.create        — create a PENDING task
 *   cairn.task.get           — fetch a task by id
 *   cairn.task.list          — list tasks with optional filters
 *   cairn.task.start_attempt  — PENDING/READY_TO_RESUME → RUNNING
 *   cairn.task.cancel         — → CANCELLED (atomically writes reason to metadata)
 *   cairn.task.block          — RUNNING → BLOCKED (records a blocker)
 *   cairn.task.answer         — answers a blocker; advances task to READY_TO_RESUME iff all answered
 *   cairn.task.resume_packet  — read-only structured handoff artifact
 *
 * NOT exposed: any free-state-write API (cairn.task.update_state is forbidden).
 * NOT exposed: cairn.task.list_blockers / cairn.task.get_blocker (LD-8).
 * Cancel always calls the repo verb `cancelTask`, not `updateTaskState`.
 */

import {
  createTask,
  getTask,
  listTasks,
  updateTaskState,
  cancelTask,
} from '../../../daemon/dist/storage/repositories/tasks.js';
import type { TaskRow } from '../../../daemon/dist/storage/repositories/tasks.js';
import {
  recordBlocker,
  markAnswered,
} from '../../../daemon/dist/storage/repositories/blockers.js';
import type { BlockerRow } from '../../../daemon/dist/storage/repositories/blockers.js';
import type { TaskState } from '../../../daemon/dist/storage/tasks-state.js';
import type { Workspace } from '../workspace.js';
import { assembleResumePacket, type ResumePacket } from '../resume-packet.js';
// Phase 2 (sync mentor): CAIRN.md known-answer auto-resolve inside task.block.
// See docs/superpowers/plans/2026-05-14-phase2-sync-mentor.md.
import { loadProfile, matchKnownAnswer } from '../../../daemon/dist/cairn-md/index.js';
import { putScratch } from '../../../daemon/dist/storage/repositories/scratchpad.js';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Arg types
// ---------------------------------------------------------------------------

export interface CreateTaskArgs {
  intent: string;
  parent_task_id?: string;
  metadata?: Record<string, unknown>;
  created_by_agent_id?: string;
}

export interface GetTaskArgs {
  task_id: string;
}

export interface ListTasksArgs {
  state?: TaskState | TaskState[];
  /** Pass null explicitly to filter for root tasks (parent_task_id IS NULL). */
  parent_task_id?: string | null;
  limit?: number;
}

export interface StartAttemptArgs {
  task_id: string;
}

export interface CancelTaskArgs {
  task_id: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Error shapes
// ---------------------------------------------------------------------------

function invalidTransitionError(from: TaskState, to: TaskState, message: string) {
  return {
    error: {
      code: 'INVALID_STATE_TRANSITION' as const,
      from,
      to,
      message,
    },
  };
}

function taskNotFoundError(task_id: string) {
  return {
    error: {
      code: 'TASK_NOT_FOUND' as const,
      task_id,
      message: `task not found: ${task_id}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * cairn.task.create
 *
 * Creates a new PENDING task. When created_by_agent_id is omitted, falls back
 * to process.env.CAIRN_SESSION_AGENT_ID (set at mcp-server startup via
 * openWorkspace → workspace.agentId).
 */
export function toolCreateTask(ws: Workspace, args: CreateTaskArgs) {
  const effectiveAgentId =
    args.created_by_agent_id != null && args.created_by_agent_id !== ''
      ? args.created_by_agent_id
      : process.env['CAIRN_SESSION_AGENT_ID'] ?? ws.agentId;

  const createInput: Parameters<typeof createTask>[1] = {
    intent: args.intent,
    created_by_agent_id: effectiveAgentId,
  };
  if (args.parent_task_id !== undefined) {
    createInput.parent_task_id = args.parent_task_id;
  }
  if (args.metadata !== undefined) {
    createInput.metadata = args.metadata;
  }
  const task = createTask(ws.db, createInput);

  return { task };
}

/**
 * cairn.task.get
 *
 * Returns { task: TaskRow } or { task: null } when not found.
 */
export function toolGetTask(ws: Workspace, args: GetTaskArgs): { task: TaskRow | null } {
  const task = getTask(ws.db, args.task_id);
  return { task };
}

/**
 * cairn.task.list
 *
 * Returns { tasks: TaskRow[] }. Accepts optional state / parent_task_id / limit
 * filters. Passing parent_task_id: null filters for root tasks.
 */
export function toolListTasks(ws: Workspace, args: ListTasksArgs): { tasks: TaskRow[] } {
  const filter: Parameters<typeof listTasks>[1] = {};

  if (args.state !== undefined) {
    filter.state = args.state;
  }

  // Distinguish undefined (no filter) from null (root tasks only)
  if ('parent_task_id' in args) {
    filter.parent_task_id = args.parent_task_id ?? null;
  }

  if (args.limit !== undefined) {
    filter.limit = args.limit;
  }

  const tasks = listTasks(ws.db, filter);
  return { tasks };
}

/**
 * cairn.task.start_attempt
 *
 * Transitions task from PENDING (or READY_TO_RESUME) to RUNNING.
 * Returns { task: TaskRow } on success.
 * Returns { error: { code: 'INVALID_STATE_TRANSITION' | 'TASK_NOT_FOUND', ... } }
 * on guard rejection — does NOT throw to stdio.
 */
export function toolStartAttempt(ws: Workspace, args: StartAttemptArgs) {
  // Check task existence first for a clear TASK_NOT_FOUND response
  const existing = getTask(ws.db, args.task_id);
  if (existing === null) {
    return taskNotFoundError(args.task_id);
  }

  try {
    const task = updateTaskState(ws.db, args.task_id, 'RUNNING');
    return { task };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // assertTransition throws "Invalid task state transition: FROM -> TO"
    if (msg.startsWith('Invalid task state transition:')) {
      return invalidTransitionError(existing.state, 'RUNNING', msg);
    }
    throw err;
  }
}

/**
 * cairn.task.cancel
 *
 * Cancels a task by calling the repo verb `cancelTask` (NOT updateTaskState).
 * This ensures cancel_reason and cancelled_at are atomically written to metadata.
 *
 * Returns { task: TaskRow } on success.
 * Returns { error: { code, ... } } on guard rejection or not-found.
 */
export function toolCancelTask(ws: Workspace, args: CancelTaskArgs) {
  // Check task existence first for a clear TASK_NOT_FOUND response
  const existing = getTask(ws.db, args.task_id);
  if (existing === null) {
    return taskNotFoundError(args.task_id);
  }

  try {
    // CRITICAL: call cancelTask (repo verb), NOT updateTaskState.
    // cancelTask atomically writes state=CANCELLED + metadata.cancel_reason + metadata.cancelled_at.
    const task = cancelTask(ws.db, args.task_id, args.reason);
    return { task };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('Invalid task state transition:')) {
      return invalidTransitionError(existing.state, 'CANCELLED', msg);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Phase 2 arg types
// ---------------------------------------------------------------------------

export interface BlockTaskArgs {
  task_id: string;
  question: string;
  context_keys?: string[];
  raised_by?: string;
}

export interface AnswerBlockerArgs {
  blocker_id: string;
  answer: string;
  answered_by?: string;
}

export interface ResumePacketArgs {
  task_id: string;
}

// ---------------------------------------------------------------------------
// Phase 2 additional error helpers
// ---------------------------------------------------------------------------

function blockerNotFoundError(blocker_id: string) {
  return {
    error: {
      code: 'BLOCKER_NOT_FOUND' as const,
      blocker_id,
      message: `blocker not found: ${blocker_id}`,
    },
  };
}

function blockerAlreadyAnsweredError(blocker_id: string) {
  return {
    error: {
      code: 'BLOCKER_ALREADY_ANSWERED' as const,
      blocker_id,
      message: `blocker already answered: ${blocker_id}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 2 tool handlers (append only — do NOT modify Phase 1 handlers above)
// ---------------------------------------------------------------------------

/**
 * cairn.task.block
 *
 * Transitions a RUNNING task to BLOCKED and records a blocker in a single
 * atomic transaction. Returns { blocker: BlockerRow; task: TaskRow } on
 * success, or a structured error object on failure.
 *
 * **Phase 2 (sync mentor, 2026-05-14)**: before recording, this handler
 * scans `<ws.gitRoot>/CAIRN.md` for a `## Known answers` substring match
 * against `args.question`. On match the blocker is recorded AND
 * immediately answered AND a scratchpad event is written, all inside
 * one outer `db.transaction()`. The response gains `auto_resolved`,
 * `answer`, `matched_pattern`, `scratchpad_key` fields and the returned
 * `task.state` is `READY_TO_RESUME` instead of `BLOCKED`. No match (or
 * no CAIRN.md / no profile.known_answers) → identical behaviour as
 * pre-Phase-2 with `auto_resolved: false` appended.
 *
 * Plan: docs/superpowers/plans/2026-05-14-phase2-sync-mentor.md
 *
 * SESSION_AGENT_ID injection: raised_by defaults to ws.agentId when omitted.
 */
export interface BlockTaskResultBase { blocker: BlockerRow; task: TaskRow; auto_resolved: boolean }
export interface BlockTaskResultAutoResolved extends BlockTaskResultBase {
  auto_resolved: true;
  answer: string;
  matched_pattern: string;
  scratchpad_key: string;
}
export interface BlockTaskResultPassive extends BlockTaskResultBase {
  auto_resolved: false;
}
export type BlockTaskResult = BlockTaskResultAutoResolved | BlockTaskResultPassive;

const _ULID_ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function _newUlid(): string {
  const ts = Date.now();
  let t = '';
  let n = ts;
  for (let i = 9; i >= 0; i--) { t = _ULID_ENC[n % 32] + t; n = Math.floor(n / 32); }
  const rand = crypto.randomBytes(10);
  let r = '';
  for (let i = 0; i < 16; i++) r += _ULID_ENC[rand[i % 10]! % 32];
  return t + r;
}

export function toolBlockTask(
  ws: Workspace,
  args: BlockTaskArgs,
): BlockTaskResult | { error: { code: string; [k: string]: unknown } } {
  // Resolve raised_by — fallback to ws.agentId (SESSION_AGENT_ID)
  const raised_by =
    args.raised_by != null && args.raised_by !== ''
      ? args.raised_by
      : ws.agentId;

  // Phase 2: peek at the project's CAIRN.md for a known_answer match.
  // Loaded BEFORE the transaction so the scan + cache write don't bloat
  // the outer txn. matchKnownAnswer is pure; safe to call cold.
  let autoMatch: { pattern: string; answer: string } | null = null;
  try {
    const profile = loadProfile(ws.db, ws.blobRoot, ws.gitRoot);
    autoMatch = matchKnownAnswer(profile, args.question);
  } catch (_e) {
    // CAIRN.md absent / unreadable / parse error → fall through to normal block.
    autoMatch = null;
  }

  try {
    const recordInput: Parameters<typeof recordBlocker>[1] = {
      task_id: args.task_id,
      question: args.question,
      raised_by,
    };
    if (args.context_keys !== undefined) {
      recordInput.context_keys = args.context_keys;
    }

    if (autoMatch) {
      // Auto-resolve path: record + answer + scratchpad event in one outer txn.
      // better-sqlite3 flattens nested transactions to SAVEPOINTs, so the
      // recordBlocker/markAnswered inner transactions are safe inside this wrap.
      const ulid = _newUlid();
      const scratchKey = `mentor/${raised_by}/auto_resolve/${ulid}`;
      const autoResolvedAt = Date.now();
      const result = ws.db.transaction(() => {
        const blockResult = recordBlocker(ws.db, recordInput);
        const answerResult = markAnswered(ws.db, blockResult.blocker.blocker_id, {
          answer: autoMatch!.answer,
          answered_by: raised_by, // self-answered via Cairn known_answer mechanism
        });
        putScratch(ws.db, ws.blobRoot, {
          key: scratchKey,
          value: {
            task_id: args.task_id,
            blocker_id: blockResult.blocker.blocker_id,
            question: args.question,
            matched_pattern: autoMatch!.pattern,
            answer: autoMatch!.answer,
            source: 'kernel_sync',
            resolved_at: autoResolvedAt,
            raised_by,
          },
          task_id: args.task_id,
          expires_at: null,
        });
        return { blocker: answerResult.blocker, task: answerResult.task };
      })();

      return {
        blocker: result.blocker,
        task: result.task,
        auto_resolved: true,
        answer: autoMatch.answer,
        matched_pattern: autoMatch.pattern,
        scratchpad_key: scratchKey,
      };
    }

    // No match — fall through to the existing passive-block behaviour.
    const result = recordBlocker(ws.db, recordInput);
    return { ...result, auto_resolved: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.startsWith('TASK_NOT_FOUND:')) {
      return taskNotFoundError(args.task_id);
    }

    // "Invalid task state transition: FROM -> BLOCKED"
    const transMatch = /^Invalid task state transition: (\w+) -> (\w+)$/.exec(msg);
    if (transMatch) {
      const from = transMatch[1] as TaskState;
      const to = transMatch[2] as TaskState;
      return invalidTransitionError(from, to, msg);
    }

    throw err;
  }
}

/**
 * cairn.task.answer
 *
 * Marks a blocker as ANSWERED. If all blockers for the task are now answered,
 * advances task state to READY_TO_RESUME. Returns { blocker, task } on
 * success, or a structured error object.
 *
 * SESSION_AGENT_ID injection: answered_by defaults to ws.agentId when omitted.
 */
export function toolAnswerBlocker(
  ws: Workspace,
  args: AnswerBlockerArgs,
): { blocker: BlockerRow; task: TaskRow } | { error: { code: string; [k: string]: unknown } } {
  // Resolve answered_by — fallback to ws.agentId (SESSION_AGENT_ID)
  const answered_by =
    args.answered_by != null && args.answered_by !== ''
      ? args.answered_by
      : ws.agentId;

  try {
    const result = markAnswered(ws.db, args.blocker_id, {
      answer: args.answer,
      answered_by,
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.startsWith('BLOCKER_NOT_FOUND:')) {
      return blockerNotFoundError(args.blocker_id);
    }
    if (msg.startsWith('BLOCKER_ALREADY_ANSWERED:')) {
      return blockerAlreadyAnsweredError(args.blocker_id);
    }

    // "Invalid task state transition: FROM -> TO" (shouldn't surface normally
    // but translate defensively)
    const transMatch = /^Invalid task state transition: (\w+) -> (\w+)$/.exec(msg);
    if (transMatch) {
      const from = transMatch[1] as TaskState;
      const to = transMatch[2] as TaskState;
      return invalidTransitionError(from, to, msg);
    }

    throw err;
  }
}

/**
 * cairn.task.resume_packet
 *
 * Read-only structured handoff artifact. Assembles the packet from DB every
 * call; no state mutations (LD-9).
 *
 * Returns { packet: ResumePacket } or { error: { code: 'TASK_NOT_FOUND', ... } }.
 */
export function toolResumePacket(
  ws: Workspace,
  args: ResumePacketArgs,
): { packet: ResumePacket } | { error: { code: string; [k: string]: unknown } } {
  const packet = assembleResumePacket(ws.db, args.task_id);
  if (packet === null) {
    return taskNotFoundError(args.task_id);
  }
  return { packet };
}

// ---------------------------------------------------------------------------
// Phase 3 imports + tool handler (append only)
// ---------------------------------------------------------------------------

import {
  submitOutcomesForReview,
} from '../../../daemon/dist/storage/repositories/outcomes.js';
import type { OutcomeRow } from '../../../daemon/dist/storage/repositories/outcomes.js';
import { parseCriteriaJSON } from '../dsl/parser.js';
import type { OutcomePrimitive } from '../dsl/types.js';

export interface SubmitForReviewArgs {
  task_id: string;
  criteria?: unknown;
}

/**
 * cairn.task.submit_for_review
 *
 * Upsert outcome for a task and transition to WAITING_REVIEW (LD-12).
 * First call: criteria required; inserts new outcome row.
 * Repeat call: criteria frozen; omit or pass identical to reset outcome to PENDING.
 */
export function toolSubmitForReview(
  ws: Workspace,
  args: SubmitForReviewArgs,
): { outcome: OutcomeRow; task: TaskRow } | { error: { code: string; message: string; errors?: string[] } } {
  let parsedCriteria: OutcomePrimitive[] | undefined;

  if (args.criteria !== undefined) {
    const parsed = parseCriteriaJSON(args.criteria);
    if (!parsed.ok) {
      return { error: { code: 'INVALID_DSL', message: 'criteria failed parser validation', errors: parsed.errors } };
    }
    parsedCriteria = parsed.criteria;
  }

  // Pre-check: if task doesn't exist, surface TASK_NOT_FOUND before hitting FK constraint
  const taskExists = ws.db.prepare('SELECT 1 FROM tasks WHERE task_id = ?').get(args.task_id);
  if (taskExists === undefined) {
    return { error: { code: 'TASK_NOT_FOUND', message: `TASK_NOT_FOUND: ${args.task_id}` } };
  }

  try {
    const submitInput: Parameters<typeof submitOutcomesForReview>[1] = { task_id: args.task_id };
    if (parsedCriteria !== undefined) {
      submitInput.criteria = parsedCriteria;
    }
    return submitOutcomesForReview(ws.db, submitInput);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/TASK_NOT_FOUND/.test(msg)) {
      return { error: { code: 'TASK_NOT_FOUND', message: msg } };
    }
    if (/Invalid task state transition/.test(msg)) {
      return { error: { code: 'INVALID_STATE_TRANSITION', message: msg } };
    }
    if (/EMPTY_CRITERIA/.test(msg)) {
      return { error: { code: 'EMPTY_CRITERIA', message: 'first call requires criteria; criteria must be a non-empty array' } };
    }
    if (/CRITERIA_FROZEN/.test(msg)) {
      return { error: { code: 'CRITERIA_FROZEN', message: 'criteria cannot be changed after first submission; omit criteria or pass identical value' } };
    }
    throw err;
  }
}
