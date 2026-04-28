import { toolCreateCheckpoint } from './checkpoint.js';
import type { Workspace } from '../workspace.js';

/**
 * Internal helper used by write-effecting tools to drop an automatic
 * timeline node BEFORE a state change happens.
 *
 * Why: PRODUCT.md §4.4 US-4 envisions a timeline of recoverable nodes
 * that the agent produces automatically as work happens. The wedge
 * cannot observe arbitrary agent behavior, but it CAN observe its own
 * write-effecting tool calls (`scratchpad.write`, `rewind.to`) and
 * record one timeline node before each — partially closing the gap
 * between "user must call cairn.checkpoint.create explicitly" and
 * "the timeline appears for free".
 *
 * `task_id` propagates from the caller (e.g. scratchpad.write({task_id}))
 * to the auto-checkpoint, so multi-task isolation (AC for US-2) is
 * preserved automatically — the agent doesn't have to remember to tag
 * every implicit timeline node it produces.
 *
 * Failure semantics: never throw. If the auto-checkpoint cannot be
 * created (e.g. workspace is not a git repo, or the label is malformed),
 * return `null` and let the caller proceed with its primary work.
 * The user explicitly invoked write/rewind; failing to log a backstop
 * shouldn't block the operation they actually asked for.
 *
 * Returns the checkpoint id on success, null on failure.
 */
export function tryAutoCheckpoint(
  ws: Workspace,
  label: string,
  task_id?: string,
): string | null {
  try {
    const args = task_id !== undefined ? { label, task_id } : { label };
    const r = toolCreateCheckpoint(ws, args);
    return r.id;
  } catch {
    return null;
  }
}
