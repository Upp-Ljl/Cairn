/**
 * Acceptance tests for cairn.task.* — 5 semantic verb tools (W5 Phase 1 Day 3)
 *
 * Required cases (≥ 10):
 *  1. create → get round-trip
 *  2. create with parent_task_id → list({ parent_task_id }) returns child
 *  3. list({ state: 'PENDING' }) filters correctly (create 2, set 1 RUNNING)
 *  4. PENDING → start_attempt → RUNNING
 *  5. RUNNING → start_attempt → INVALID_STATE_TRANSITION error
 *  6. PENDING → cancel (no reason) → CANCELLED + metadata has cancel_reason: null
 *  7. RUNNING → cancel('user requested') → CANCELLED + reason in metadata
 *  8. CANCELLED → cancel again → INVALID_STATE_TRANSITION error
 *  9. cancel on nonexistent task_id → TASK_NOT_FOUND error
 * 10. SESSION_AGENT_ID auto-injection: omit created_by_agent_id → task has env var value
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace, type Workspace } from '../../src/workspace.js';
import {
  toolCreateTask,
  toolGetTask,
  toolListTasks,
  toolStartAttempt,
  toolCancelTask,
} from '../../src/tools/task.js';

describe('cairn.task.* — 5 semantic verb tools', () => {
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-task-'));
    ws = openWorkspace({ cairnRoot });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // cairn.task.create + cairn.task.get — round-trip
  // ---------------------------------------------------------------------------

  it('create → get round-trip: task fields are persisted correctly', () => {
    const r = toolCreateTask(ws, { intent: 'refactor utils module' });
    expect(r.task).toBeDefined();
    expect(r.task.intent).toBe('refactor utils module');
    expect(r.task.state).toBe('PENDING');
    expect(r.task.parent_task_id).toBeNull();
    expect(typeof r.task.created_at).toBe('number');
    expect(typeof r.task.updated_at).toBe('number');
    expect(r.task.task_id).toMatch(/^[0-9A-Z]{26}$/); // ULID format

    const g = toolGetTask(ws, { task_id: r.task.task_id });
    expect(g.task).not.toBeNull();
    expect(g.task!.task_id).toBe(r.task.task_id);
    expect(g.task!.intent).toBe('refactor utils module');
    expect(g.task!.state).toBe('PENDING');
  });

  it('get: returns { task: null } for nonexistent task_id', () => {
    const g = toolGetTask(ws, { task_id: 'nonexistent-task-id' });
    expect(g.task).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // cairn.task.create with parent_task_id + list with parent filter
  // ---------------------------------------------------------------------------

  it('create with parent_task_id → list({ parent_task_id }) returns the child', () => {
    const parent = toolCreateTask(ws, { intent: 'parent task' });
    const child = toolCreateTask(ws, {
      intent: 'child task',
      parent_task_id: parent.task.task_id,
    });

    const listResult = toolListTasks(ws, { parent_task_id: parent.task.task_id });
    expect(listResult.tasks.length).toBe(1);
    expect(listResult.tasks[0]!.task_id).toBe(child.task.task_id);
    expect(listResult.tasks[0]!.parent_task_id).toBe(parent.task.task_id);
  });

  it('list({ parent_task_id: null }) returns only root tasks', () => {
    const root = toolCreateTask(ws, { intent: 'root task' });
    toolCreateTask(ws, { intent: 'child task', parent_task_id: root.task.task_id });

    const listResult = toolListTasks(ws, { parent_task_id: null });
    expect(listResult.tasks.length).toBe(1);
    expect(listResult.tasks[0]!.task_id).toBe(root.task.task_id);
  });

  // ---------------------------------------------------------------------------
  // cairn.task.list — state filter
  // ---------------------------------------------------------------------------

  it('list({ state: "PENDING" }) returns only PENDING tasks after one is moved to RUNNING', () => {
    const t1 = toolCreateTask(ws, { intent: 'task-1' });
    const t2 = toolCreateTask(ws, { intent: 'task-2' });

    // Move t1 to RUNNING
    toolStartAttempt(ws, { task_id: t1.task.task_id });

    const pending = toolListTasks(ws, { state: 'PENDING' });
    const pendingIds = pending.tasks.map((t) => t.task_id);
    expect(pendingIds).not.toContain(t1.task.task_id);
    expect(pendingIds).toContain(t2.task.task_id);

    const running = toolListTasks(ws, { state: 'RUNNING' });
    expect(running.tasks.map((t) => t.task_id)).toContain(t1.task.task_id);
  });

  it('list with state array filters multiple states', () => {
    const t1 = toolCreateTask(ws, { intent: 'pending-task' });
    const t2 = toolCreateTask(ws, { intent: 'running-task' });
    toolStartAttempt(ws, { task_id: t2.task.task_id });
    toolCancelTask(ws, { task_id: t1.task.task_id });

    const result = toolListTasks(ws, { state: ['RUNNING', 'CANCELLED'] });
    const ids = result.tasks.map((t) => t.task_id);
    expect(ids).toContain(t2.task.task_id);
    expect(ids).toContain(t1.task.task_id);
  });

  it('list with limit caps the number of results', () => {
    toolCreateTask(ws, { intent: 'task-a' });
    toolCreateTask(ws, { intent: 'task-b' });
    toolCreateTask(ws, { intent: 'task-c' });

    const result = toolListTasks(ws, { limit: 2 });
    expect(result.tasks.length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // cairn.task.start_attempt — state transitions
  // ---------------------------------------------------------------------------

  it('PENDING → start_attempt → state is RUNNING', () => {
    const t = toolCreateTask(ws, { intent: 'demo task' });
    const r = toolStartAttempt(ws, { task_id: t.task.task_id });
    expect('task' in r).toBe(true);
    expect((r as { task: { state: string } }).task.state).toBe('RUNNING');
  });

  it('RUNNING → start_attempt → returns INVALID_STATE_TRANSITION error', () => {
    const t = toolCreateTask(ws, { intent: 'already running' });
    toolStartAttempt(ws, { task_id: t.task.task_id }); // PENDING → RUNNING

    const r2 = toolStartAttempt(ws, { task_id: t.task.task_id }); // RUNNING → RUNNING (illegal)
    expect('error' in r2).toBe(true);
    const err = (r2 as { error: { code: string; from: string; to: string } }).error;
    expect(err.code).toBe('INVALID_STATE_TRANSITION');
    expect(err.from).toBe('RUNNING');
    expect(err.to).toBe('RUNNING');
  });

  it('start_attempt on nonexistent task_id → TASK_NOT_FOUND error', () => {
    const r = toolStartAttempt(ws, { task_id: 'nonexistent-task' });
    expect('error' in r).toBe(true);
    const err = (r as { error: { code: string; task_id: string } }).error;
    expect(err.code).toBe('TASK_NOT_FOUND');
    expect(err.task_id).toBe('nonexistent-task');
  });

  // ---------------------------------------------------------------------------
  // cairn.task.cancel — semantic verb tests
  // ---------------------------------------------------------------------------

  it('PENDING → cancel (no reason) → CANCELLED with cancel_reason: null and cancelled_at set', () => {
    const t = toolCreateTask(ws, { intent: 'task to cancel' });
    const r = toolCancelTask(ws, { task_id: t.task.task_id });
    expect('task' in r).toBe(true);
    const task = (r as { task: { state: string; metadata: Record<string, unknown> | null } }).task;
    expect(task.state).toBe('CANCELLED');
    expect(task.metadata).not.toBeNull();
    expect(task.metadata!['cancel_reason']).toBeNull();
    expect(typeof task.metadata!['cancelled_at']).toBe('number');
  });

  it('RUNNING → cancel with reason → CANCELLED with cancel_reason written to metadata', () => {
    const t = toolCreateTask(ws, { intent: 'task being run' });
    toolStartAttempt(ws, { task_id: t.task.task_id }); // PENDING → RUNNING

    const r = toolCancelTask(ws, { task_id: t.task.task_id, reason: 'user requested' });
    expect('task' in r).toBe(true);
    const task = (r as { task: { state: string; metadata: Record<string, unknown> | null } }).task;
    expect(task.state).toBe('CANCELLED');
    expect(task.metadata!['cancel_reason']).toBe('user requested');
    expect(typeof task.metadata!['cancelled_at']).toBe('number');
  });

  it('CANCELLED → cancel again → INVALID_STATE_TRANSITION error (terminal state)', () => {
    const t = toolCreateTask(ws, { intent: 'already cancelled' });
    toolCancelTask(ws, { task_id: t.task.task_id }); // PENDING → CANCELLED

    const r2 = toolCancelTask(ws, { task_id: t.task.task_id }); // CANCELLED → CANCELLED (illegal)
    expect('error' in r2).toBe(true);
    const err = (r2 as { error: { code: string; from: string; to: string } }).error;
    expect(err.code).toBe('INVALID_STATE_TRANSITION');
    expect(err.from).toBe('CANCELLED');
    expect(err.to).toBe('CANCELLED');
  });

  it('cancel on nonexistent task_id → TASK_NOT_FOUND error', () => {
    const r = toolCancelTask(ws, { task_id: 'ghost-task-id' });
    expect('error' in r).toBe(true);
    const err = (r as { error: { code: string; task_id: string; message: string } }).error;
    expect(err.code).toBe('TASK_NOT_FOUND');
    expect(err.task_id).toBe('ghost-task-id');
    expect(err.message).toContain('ghost-task-id');
  });

  // ---------------------------------------------------------------------------
  // SESSION_AGENT_ID auto-injection
  // ---------------------------------------------------------------------------

  it('SESSION_AGENT_ID auto-injection: omit created_by_agent_id → task has env CAIRN_SESSION_AGENT_ID', () => {
    // openWorkspace sets process.env.CAIRN_SESSION_AGENT_ID = ws.agentId
    const envId = process.env['CAIRN_SESSION_AGENT_ID'];
    expect(envId).toBeDefined();

    const r = toolCreateTask(ws, { intent: 'session id test' }); // no created_by_agent_id
    expect(r.task.created_by_agent_id).toBe(envId);
  });

  it('SESSION_AGENT_ID: explicit created_by_agent_id overrides session id', () => {
    const r = toolCreateTask(ws, {
      intent: 'explicit agent',
      created_by_agent_id: 'explicit-agent-007',
    });
    expect(r.task.created_by_agent_id).toBe('explicit-agent-007');
  });

  // ---------------------------------------------------------------------------
  // create with metadata round-trip
  // ---------------------------------------------------------------------------

  it('create with metadata → get returns deserialized metadata', () => {
    const r = toolCreateTask(ws, {
      intent: 'metadata task',
      metadata: { foo: 'bar', num: 42 },
    });
    expect(r.task.metadata).toEqual({ foo: 'bar', num: 42 });

    const g = toolGetTask(ws, { task_id: r.task.task_id });
    expect(g.task!.metadata).toEqual({ foo: 'bar', num: 42 });
  });
});
