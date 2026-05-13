/**
 * cairn.outcomes.* — evaluate + terminal_fail tools (W5 Phase 3 Day 4)
 *
 * Tools exposed:
 *   cairn.outcomes.evaluate       — synchronous blocking DSL evaluation (LD-17)
 *   cairn.outcomes.terminal_fail  — user-driven terminal fail path
 *
 * NOT exposed: cairn.outcomes.list / cairn.outcomes.get (LD-8).
 */

import {
  recordEvaluationResult,
  markTerminalFail,
} from '../../../daemon/dist/storage/repositories/outcomes.js';
import type { OutcomeRow } from '../../../daemon/dist/storage/repositories/outcomes.js';
import type { TaskRow } from '../../../daemon/dist/storage/repositories/tasks.js';
import type { Workspace } from '../workspace.js';
import { parseCriteriaJSON } from '../dsl/parser.js';
import { evaluateCriteria } from '../dsl/evaluator.js';
import type { EvaluationResult } from '../dsl/types.js';
import { appendKernelTimelineEvent } from '../util/session-timeline.js';

// ---------------------------------------------------------------------------
// Internal raw row type for direct SELECT
// ---------------------------------------------------------------------------

interface OutcomeRowRaw {
  outcome_id: string;
  task_id: string;
  criteria_json: string;
  status: string;
  evaluated_at: number | null;
  evaluation_summary: string | null;
  grader_agent_id: string | null;
  created_at: number;
  updated_at: number;
  metadata_json: string | null;
}

// ---------------------------------------------------------------------------
// cairn.outcomes.evaluate
// ---------------------------------------------------------------------------

export async function toolEvaluateOutcome(
  ws: Workspace,
  args: { outcome_id: string },
): Promise<{ outcome: OutcomeRow; task: TaskRow; evaluation: EvaluationResult } | { error: { code: string; message: string } }> {
  // 1. Read outcome by id via raw SELECT (daemon does not expose getOutcomeById)
  const raw = ws.db
    .prepare('SELECT * FROM outcomes WHERE outcome_id = ?')
    .get(args.outcome_id) as OutcomeRowRaw | undefined;

  if (raw === undefined) {
    return { error: { code: 'OUTCOME_NOT_FOUND', message: `outcome not found: ${args.outcome_id}` } };
  }

  // 2. Status guard — only PENDING proceeds
  if (raw.status === 'PASS') {
    return { error: { code: 'OUTCOME_ALREADY_PASSED', message: 'outcome already passed; task is DONE' } };
  }
  if (raw.status === 'FAIL') {
    return { error: { code: 'OUTCOME_NEEDS_RESUBMIT', message: 'call cairn.task.submit_for_review first to reset to PENDING' } };
  }
  if (raw.status === 'TERMINAL_FAIL') {
    return { error: { code: 'OUTCOME_TERMINAL_FAIL', message: 'outcome is terminally failed; task is FAILED' } };
  }
  // raw.status === 'PENDING' — proceed

  // 3. Defensive re-parse criteria_json against DSL parser (guards DB corruption)
  let parsedCriteriaJson: unknown;
  try {
    parsedCriteriaJson = JSON.parse(raw.criteria_json);
  } catch {
    return { error: { code: 'CORRUPT_OUTCOME', message: 'criteria_json is not valid JSON' } };
  }
  const reParsed = parseCriteriaJSON(parsedCriteriaJson);
  if (!reParsed.ok) {
    return { error: { code: 'CORRUPT_OUTCOME', message: `criteria_json failed parser revalidation: ${reParsed.errors.join('; ')}` } };
  }
  const criteria = reParsed.criteria;

  // 4. Build EvalContext
  const timeoutMs = Number(process.env['CAIRN_DSL_PRIMITIVE_TIMEOUT_MS']) || 60_000;
  const evalCtx = {
    db: ws.db,
    cwd: ws.cwd,
    env: process.env,
    timeoutMs,
    task_id: raw.task_id,
  };

  // 5. Synchronous blocking evaluation (LD-17)
  const result = await evaluateCriteria(criteria, evalCtx);

  // 6. Record result — catch OUTCOME_NOT_PENDING race condition
  try {
    const { outcome, task } = recordEvaluationResult(ws.db, args.outcome_id, {
      status: result.status,
      summary: result.summary,
    });

    // Kernel auto-instrument: 'done' event only for PASS (FAIL → caller resubmits)
    if (result.status === 'PASS') {
      const agentId = ws.agentId;
      const label = `outcomes PASS — ${(result.summary ?? '').slice(0, 90)}`;
      const tlResult = appendKernelTimelineEvent(ws.db, agentId, 'done', label, {
        task_id: task.task_id,
      });
      if (!tlResult.ok) {
        process.stderr.write(`[cairn] kernel timeline append failed (outcomes.evaluate/PASS): ${tlResult.error}\n`);
      }
    }

    return { outcome, task, evaluation: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/OUTCOME_NOT_PENDING/.test(msg)) {
      return { error: { code: 'OUTCOME_NOT_PENDING', message: 'concurrent evaluation race: outcome no longer PENDING' } };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// cairn.outcomes.terminal_fail
// ---------------------------------------------------------------------------

export function toolTerminalFailOutcome(
  ws: Workspace,
  args: { outcome_id: string; reason: string },
): { outcome: OutcomeRow; task: TaskRow } | { error: { code: string; message: string } } {
  // 1. Read outcome by id
  const raw = ws.db
    .prepare('SELECT * FROM outcomes WHERE outcome_id = ?')
    .get(args.outcome_id) as OutcomeRowRaw | undefined;

  if (raw === undefined) {
    return { error: { code: 'OUTCOME_NOT_FOUND', message: `outcome not found: ${args.outcome_id}` } };
  }

  // 2. Call daemon markTerminalFail
  try {
    const tfResult = markTerminalFail(ws.db, args.outcome_id, args.reason);

    // Kernel auto-instrument: 'done' event with terminal-fail label
    const agentId = ws.agentId;
    const label = `TERMINAL_FAIL — ${args.reason.slice(0, 100)}`;
    const tlResult = appendKernelTimelineEvent(ws.db, agentId, 'done', label, {
      task_id: tfResult.task.task_id,
    });
    if (!tlResult.ok) {
      process.stderr.write(`[cairn] kernel timeline append failed (outcomes.terminal_fail): ${tlResult.error}\n`);
    }

    return tfResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/OUTCOME_NOT_PENDING/.test(msg)) {
      return {
        error: {
          code: 'OUTCOME_NOT_PENDING',
          message: `terminal_fail only valid for PENDING outcomes; for FAIL state cancel the task instead (current status: ${raw.status})`,
        },
      };
    }
    if (/Invalid task state transition/.test(msg)) {
      return { error: { code: 'INVALID_STATE_TRANSITION', message: msg } };
    }
    throw err;
  }
}
