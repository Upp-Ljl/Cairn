/**
 * cairn.task.* — 5 semantic verb tools for Task Capsule lifecycle (W5 Phase 1)
 *
 * Tools exposed:
 *   cairn.task.create       — create a PENDING task
 *   cairn.task.get          — fetch a task by id
 *   cairn.task.list         — list tasks with optional filters
 *   cairn.task.start_attempt — PENDING/READY_TO_RESUME → RUNNING
 *   cairn.task.cancel        — → CANCELLED (atomically writes reason to metadata)
 *
 * NOT exposed: any free-state-write API (cairn.task.update_state is forbidden).
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
import type { TaskState } from '../../../daemon/dist/storage/tasks-state.js';
import type { Workspace } from '../workspace.js';

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
