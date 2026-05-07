/**
 * Acceptance tests for cairn.outcomes.evaluate + cairn.outcomes.terminal_fail
 * (W5 Phase 3 Day 4)
 *
 * evaluate (≥ 8):
 *  1.  happy PASS: file_exists fixture present → PASS + task DONE
 *  2.  FAIL path: file_exists fixture absent → FAIL + task RUNNING
 *  3.  retry roundtrip: FAIL → fix fixture → submit_for_review reset → evaluate → PASS → DONE
 *  4.  OUTCOME_NOT_FOUND
 *  5.  OUTCOME_NEEDS_RESUBMIT: FAIL state, call evaluate again without resetting
 *  6.  OUTCOME_ALREADY_PASSED: after PASS, call evaluate again
 *  7.  timeout: command_exits_0 never exits → TIMEOUT verdict + FAIL
 *  8.  LD-11: grader_agent_id is null after evaluate
 *
 * terminal_fail (≥ 4):
 *  9.  happy: PENDING outcome → terminal_fail → TERMINAL_FAIL + task FAILED
 * 10.  from FAIL state → OUTCOME_NOT_PENDING
 * 11.  from PASS state → OUTCOME_NOT_PENDING
 * 12.  OUTCOME_NOT_FOUND
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace, type Workspace } from '../../src/workspace.js';
import { toolEvaluateOutcome, toolTerminalFailOutcome } from '../../src/tools/outcomes.js';
import { toolCreateTask, toolStartAttempt, toolSubmitForReview } from '../../src/tools/task.js';
import {
  submitOutcomesForReview,
  recordEvaluationResult,
} from '../../../daemon/dist/storage/repositories/outcomes.js';

describe('cairn.outcomes.evaluate + cairn.outcomes.terminal_fail — Phase 3 acceptance', () => {
  let cairnRoot: string;
  let cwd: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-outcomes-cairn-'));
    cwd = mkdtempSync(join(tmpdir(), 'cairn-outcomes-cwd-'));
    ws = openWorkspace({ cairnRoot, cwd });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function makeRunningTask(intent = 'outcomes test task') {
    const r = toolCreateTask(ws, { intent });
    toolStartAttempt(ws, { task_id: r.task.task_id });
    return r.task.task_id;
  }

  function submitWithCriteria(task_id: string, criteria: unknown[]) {
    const r = toolSubmitForReview(ws, { task_id, criteria });
    if ('error' in r) throw new Error(`submit failed: ${JSON.stringify(r)}`);
    return r as { outcome: { outcome_id: string; status: string }; task: { state: string } };
  }

  // ---------------------------------------------------------------------------
  // evaluate: 1. happy PASS
  // ---------------------------------------------------------------------------

  it('1. happy PASS: file_exists fixture present → PASS + task DONE', async () => {
    // Write the file so file_exists passes
    writeFileSync(join(cwd, 'README.md'), 'content');

    const task_id = makeRunningTask();
    const submitted = submitWithCriteria(task_id, [{ primitive: 'file_exists', args: { path: 'README.md' } }]);
    const outcome_id = submitted.outcome.outcome_id;

    const r = await toolEvaluateOutcome(ws, { outcome_id });
    expect('evaluation' in r).toBe(true);
    const ok = r as {
      outcome: { status: string };
      task: { state: string };
      evaluation: { status: string; perPrimitive: Array<{ status: string }> };
    };
    expect(ok.evaluation.status).toBe('PASS');
    expect(ok.outcome.status).toBe('PASS');
    expect(ok.task.state).toBe('DONE');
    expect(ok.evaluation.perPrimitive[0]!.status).toBe('PASS');
  });

  // ---------------------------------------------------------------------------
  // evaluate: 2. FAIL path
  // ---------------------------------------------------------------------------

  it('2. FAIL path: file_exists on absent file → FAIL + task RUNNING', async () => {
    const task_id = makeRunningTask();
    const submitted = submitWithCriteria(task_id, [
      { primitive: 'file_exists', args: { path: 'NOPE.txt' } },
    ]);
    const outcome_id = submitted.outcome.outcome_id;

    const r = await toolEvaluateOutcome(ws, { outcome_id });
    expect('evaluation' in r).toBe(true);
    const ok = r as {
      outcome: { status: string };
      task: { state: string };
      evaluation: { status: string };
    };
    expect(ok.evaluation.status).toBe('FAIL');
    expect(ok.outcome.status).toBe('FAIL');
    expect(ok.task.state).toBe('RUNNING');
  });

  // ---------------------------------------------------------------------------
  // evaluate: 3. retry roundtrip (P1.1 full loop)
  // ---------------------------------------------------------------------------

  it('3. retry roundtrip: FAIL → fix fixture → submit_for_review reset → evaluate → PASS → DONE', async () => {
    const task_id = makeRunningTask();
    const submitted = submitWithCriteria(task_id, [
      { primitive: 'file_exists', args: { path: 'FIXME.txt' } },
    ]);
    const outcome_id = submitted.outcome.outcome_id;

    // Evaluate → FAIL
    const fail = await toolEvaluateOutcome(ws, { outcome_id });
    expect('evaluation' in fail).toBe(true);
    const failOk = fail as { evaluation: { status: string }; task: { state: string } };
    expect(failOk.evaluation.status).toBe('FAIL');
    expect(failOk.task.state).toBe('RUNNING');

    // Fix fixture
    writeFileSync(join(cwd, 'FIXME.txt'), 'fixed');

    // Upsert reset (no criteria)
    const reset = toolSubmitForReview(ws, { task_id });
    expect('outcome' in reset).toBe(true);
    const resetOk = reset as { outcome: { status: string; outcome_id: string }; task: { state: string } };
    expect(resetOk.outcome.status).toBe('PENDING');
    expect(resetOk.outcome.outcome_id).toBe(outcome_id); // same row
    expect(resetOk.task.state).toBe('WAITING_REVIEW');

    // Evaluate again → PASS
    const pass = await toolEvaluateOutcome(ws, { outcome_id });
    expect('evaluation' in pass).toBe(true);
    const passOk = pass as {
      outcome: { status: string };
      task: { state: string };
      evaluation: { status: string };
    };
    expect(passOk.evaluation.status).toBe('PASS');
    expect(passOk.outcome.status).toBe('PASS');
    expect(passOk.task.state).toBe('DONE');
  });

  // ---------------------------------------------------------------------------
  // evaluate: 4. OUTCOME_NOT_FOUND
  // ---------------------------------------------------------------------------

  it('4. OUTCOME_NOT_FOUND for bogus outcome_id', async () => {
    const r = await toolEvaluateOutcome(ws, { outcome_id: 'bogus-outcome-id' });
    expect('error' in r).toBe(true);
    const err = (r as { error: { code: string } }).error;
    expect(err.code).toBe('OUTCOME_NOT_FOUND');
  });

  // ---------------------------------------------------------------------------
  // evaluate: 5. OUTCOME_NEEDS_RESUBMIT (FAIL state, no reset)
  // ---------------------------------------------------------------------------

  it('5. OUTCOME_NEEDS_RESUBMIT: FAIL state without resetting → error with helpful message', async () => {
    const task_id = makeRunningTask();
    const submitted = submitWithCriteria(task_id, [
      { primitive: 'file_exists', args: { path: 'ABSENT.txt' } },
    ]);
    const outcome_id = submitted.outcome.outcome_id;

    // Evaluate → FAIL (task goes back to RUNNING, outcome.status=FAIL)
    await toolEvaluateOutcome(ws, { outcome_id });

    // Try to evaluate again without resetting
    const r = await toolEvaluateOutcome(ws, { outcome_id });
    expect('error' in r).toBe(true);
    const err = (r as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('OUTCOME_NEEDS_RESUBMIT');
    expect(err.message).toContain('submit_for_review');
  });

  // ---------------------------------------------------------------------------
  // evaluate: 6. OUTCOME_ALREADY_PASSED
  // ---------------------------------------------------------------------------

  it('6. OUTCOME_ALREADY_PASSED: after PASS, evaluate again → error', async () => {
    writeFileSync(join(cwd, 'PASS_FILE.md'), 'here');

    const task_id = makeRunningTask();
    const submitted = submitWithCriteria(task_id, [
      { primitive: 'file_exists', args: { path: 'PASS_FILE.md' } },
    ]);
    const outcome_id = submitted.outcome.outcome_id;

    // First evaluate → PASS
    await toolEvaluateOutcome(ws, { outcome_id });

    // Second evaluate
    const r = await toolEvaluateOutcome(ws, { outcome_id });
    expect('error' in r).toBe(true);
    const err = (r as { error: { code: string } }).error;
    expect(err.code).toBe('OUTCOME_ALREADY_PASSED');
  });

  // ---------------------------------------------------------------------------
  // evaluate: 7. timeout
  // ---------------------------------------------------------------------------

  it('7. timeout: long-running command → TIMEOUT in perPrimitive, overall FAIL, task RUNNING', async () => {
    const prevTimeout = process.env['CAIRN_DSL_PRIMITIVE_TIMEOUT_MS'];
    process.env['CAIRN_DSL_PRIMITIVE_TIMEOUT_MS'] = '1500';
    try {
      const task_id = makeRunningTask();
      // Use a command that never exits within 1.5s
      const submitted = submitWithCriteria(task_id, [
        { primitive: 'command_exits_0', args: { cmd: 'node -e "setInterval(()=>{},1000)"' } },
      ]);
      const outcome_id = submitted.outcome.outcome_id;

      const r = await toolEvaluateOutcome(ws, { outcome_id });
      expect('evaluation' in r).toBe(true);
      const ok = r as {
        outcome: { status: string };
        task: { state: string };
        evaluation: { status: string; perPrimitive: Array<{ status: string }> };
      };
      expect(ok.evaluation.perPrimitive[0]!.status).toBe('TIMEOUT');
      expect(ok.evaluation.status).toBe('FAIL'); // AND semantics → FAIL
      expect(ok.outcome.status).toBe('FAIL');
      expect(ok.task.state).toBe('RUNNING');
    } finally {
      if (prevTimeout === undefined) {
        delete process.env['CAIRN_DSL_PRIMITIVE_TIMEOUT_MS'];
      } else {
        process.env['CAIRN_DSL_PRIMITIVE_TIMEOUT_MS'] = prevTimeout;
      }
    }
  }, 15_000);

  // ---------------------------------------------------------------------------
  // evaluate: 8. LD-11 — grader_agent_id is null after evaluate
  // ---------------------------------------------------------------------------

  it('8. LD-11: grader_agent_id is null after evaluate (v1 does not write it)', async () => {
    writeFileSync(join(cwd, 'LD11.txt'), 'check');

    const task_id = makeRunningTask();
    const submitted = submitWithCriteria(task_id, [
      { primitive: 'file_exists', args: { path: 'LD11.txt' } },
    ]);
    const outcome_id = submitted.outcome.outcome_id;

    const r = await toolEvaluateOutcome(ws, { outcome_id });
    expect('evaluation' in r).toBe(true);
    const ok = r as { outcome: { grader_agent_id: unknown } };
    expect(ok.outcome.grader_agent_id).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // terminal_fail: 9. happy path
  // ---------------------------------------------------------------------------

  it('9. terminal_fail happy: PENDING outcome → TERMINAL_FAIL + task FAILED + reason in summary', () => {
    const task_id = makeRunningTask();
    const submitted = submitWithCriteria(task_id, [
      { primitive: 'file_exists', args: { path: 'SOME.txt' } },
    ]);
    const outcome_id = submitted.outcome.outcome_id;

    const r = toolTerminalFailOutcome(ws, { outcome_id, reason: 'demo terminal' });
    expect('outcome' in r).toBe(true);
    const ok = r as {
      outcome: { status: string; evaluation_summary: string | null };
      task: { state: string };
    };
    expect(ok.outcome.status).toBe('TERMINAL_FAIL');
    expect(ok.task.state).toBe('FAILED');
    expect(ok.outcome.evaluation_summary).toBe('demo terminal');
  });

  // ---------------------------------------------------------------------------
  // terminal_fail: 10. from FAIL state → OUTCOME_NOT_PENDING
  // ---------------------------------------------------------------------------

  it('10. terminal_fail from FAIL state → OUTCOME_NOT_PENDING with helpful message', async () => {
    const task_id = makeRunningTask();
    const submitted = submitWithCriteria(task_id, [
      { primitive: 'file_exists', args: { path: 'NOPE2.txt' } },
    ]);
    const outcome_id = submitted.outcome.outcome_id;

    // Evaluate → FAIL (task goes back to RUNNING)
    await toolEvaluateOutcome(ws, { outcome_id });

    const r = toolTerminalFailOutcome(ws, { outcome_id, reason: 'too late' });
    expect('error' in r).toBe(true);
    const err = (r as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('OUTCOME_NOT_PENDING');
    expect(err.message).toContain('cancel');
  });

  // ---------------------------------------------------------------------------
  // terminal_fail: 11. from PASS state → OUTCOME_NOT_PENDING
  // ---------------------------------------------------------------------------

  it('11. terminal_fail from PASS state → OUTCOME_NOT_PENDING', async () => {
    writeFileSync(join(cwd, 'PASS2.txt'), 'present');

    const task_id = makeRunningTask();
    const submitted = submitWithCriteria(task_id, [
      { primitive: 'file_exists', args: { path: 'PASS2.txt' } },
    ]);
    const outcome_id = submitted.outcome.outcome_id;

    // Evaluate → PASS (task → DONE)
    await toolEvaluateOutcome(ws, { outcome_id });

    const r = toolTerminalFailOutcome(ws, { outcome_id, reason: 'too late' });
    expect('error' in r).toBe(true);
    const err = (r as { error: { code: string } }).error;
    expect(err.code).toBe('OUTCOME_NOT_PENDING');
  });

  // ---------------------------------------------------------------------------
  // terminal_fail: 12. OUTCOME_NOT_FOUND
  // ---------------------------------------------------------------------------

  it('12. terminal_fail OUTCOME_NOT_FOUND for bogus outcome_id', () => {
    const r = toolTerminalFailOutcome(ws, { outcome_id: 'ghost-outcome', reason: 'test' });
    expect('error' in r).toBe(true);
    const err = (r as { error: { code: string } }).error;
    expect(err.code).toBe('OUTCOME_NOT_FOUND');
  });
});
