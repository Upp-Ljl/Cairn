/**
 * Tests for assembleResumePacket + validateResumePacket (W5 Phase 2 Day 3)
 *
 * 13 cases:
 *  1.  assembleResumePacket returns null for nonexistent task_id
 *  2.  Empty task: correct fields, all arrays empty, last_checkpoint_sha null, audit non-empty
 *  3.  Multiple OPEN blockers → all appear in open_blockers raised_at ASC
 *  4.  ANSWERED blockers count > 10 → truncate to 10, ORDER BY answered_at DESC
 *  5.  READY checkpoint → last_checkpoint_sha = its git_head
 *  6.  PENDING/CORRUPTED checkpoints NOT selected; READY one is selected
 *  7.  No checkpoints → last_checkpoint_sha is null
 *  8.  scratchpad keys filtered by task_id (2 matching, 1 different, 1 NULL → only 2 matching appear)
 *  9.  outcomes_criteria is always []
 * 10.  validateResumePacket happy path: assembleResumePacket result passes validator
 * 11.  validateResumePacket rejects missing required field (task_id missing → ok=false)
 * 12.  validateResumePacket rejects wrong type (open_blockers as string → ok=false)
 * 13.  LD-9 read-only: spy on db.prepare — every SQL begins with SELECT (no INSERT/UPDATE/DELETE)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace, type Workspace } from '../../src/workspace.js';
import { assembleResumePacket, validateResumePacket } from '../../src/resume-packet.js';

describe('assembleResumePacket + validateResumePacket', () => {
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-resume-'));
    ws = openWorkspace({ cairnRoot });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function insertTask(intent = 'test task'): string {
    const task_id = `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    ws.db
      .prepare(
        `INSERT INTO tasks (task_id, intent, state, parent_task_id, created_at, updated_at, created_by_agent_id, metadata_json)
         VALUES (?, ?, 'PENDING', NULL, ?, ?, NULL, NULL)`,
      )
      .run(task_id, intent, now, now);
    return task_id;
  }

  function setTaskState(task_id: string, state: string) {
    ws.db.prepare(`UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?`).run(state, Date.now(), task_id);
  }

  function insertBlocker(task_id: string, opts: {
    question?: string;
    status?: string;
    raised_at?: number;
    answer?: string;
    answered_by?: string;
    answered_at?: number;
    context_keys?: string[];
  } = {}): string {
    const id = `blk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ws.db
      .prepare(
        `INSERT INTO blockers (blocker_id, task_id, question, context_keys, status, raised_by, raised_at, answer, answered_by, answered_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        task_id,
        opts.question ?? 'test question',
        opts.context_keys != null ? JSON.stringify(opts.context_keys) : null,
        opts.status ?? 'OPEN',
        opts.raised_at ?? Date.now(),
        opts.answer ?? null,
        opts.answered_by ?? null,
        opts.answered_at ?? null,
      );
    return id;
  }

  function insertCheckpoint(task_id: string, opts: {
    git_head?: string;
    snapshot_status?: string;
    created_at?: number;
  } = {}): string {
    const id = `chk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ws.db
      .prepare(
        `INSERT INTO checkpoints (id, task_id, git_head, snapshot_dir, label, snapshot_status, created_at)
         VALUES (?, ?, ?, 'test-snapshots', NULL, ?, ?)`,
      )
      .run(
        id,
        task_id,
        opts.git_head ?? null,
        opts.snapshot_status ?? 'READY',
        opts.created_at ?? Date.now(),
      );
    return id;
  }

  function insertScratchpad(task_id: string | null, key: string): void {
    ws.db
      .prepare(
        `INSERT INTO scratchpad (key, value_json, created_at, updated_at, task_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(key, JSON.stringify({ data: key }), Date.now(), Date.now(), task_id);
  }

  // ---------------------------------------------------------------------------
  // Case 1: null for nonexistent task_id
  // ---------------------------------------------------------------------------

  it('1. returns null for nonexistent task_id', () => {
    const result = assembleResumePacket(ws.db, 'no-such-task');
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Case 2: empty task
  // ---------------------------------------------------------------------------

  it('2. empty task has correct fields, empty arrays, null checkpoint sha, non-empty audit', () => {
    const task_id = insertTask('empty intent');
    const packet = assembleResumePacket(ws.db, task_id);
    expect(packet).not.toBeNull();
    expect(packet!.task_id).toBe(task_id);
    expect(packet!.intent).toBe('empty intent');
    expect(typeof packet!.current_state).toBe('string');
    expect(packet!.last_checkpoint_sha).toBeNull();
    expect(packet!.open_blockers).toEqual([]);
    expect(packet!.answered_blockers).toEqual([]);
    expect(packet!.scratchpad_keys).toEqual([]);
    expect(packet!.outcomes_criteria).toEqual([]);
    expect(typeof packet!.audit_trail_summary).toBe('string');
    expect(packet!.audit_trail_summary.length).toBeGreaterThan(0);
    // Must contain the task header
    expect(packet!.audit_trail_summary).toContain(task_id);
  });

  // ---------------------------------------------------------------------------
  // Case 3: multiple OPEN blockers in raised_at ASC order
  // ---------------------------------------------------------------------------

  it('3. multiple OPEN blockers appear in raised_at ASC order', () => {
    const task_id = insertTask('task with blockers');
    setTaskState(task_id, 'BLOCKED');

    const now = Date.now();
    insertBlocker(task_id, { question: 'Q1', raised_at: now + 10 });
    insertBlocker(task_id, { question: 'Q2', raised_at: now + 20 });
    insertBlocker(task_id, { question: 'Q3', raised_at: now + 30 });

    const packet = assembleResumePacket(ws.db, task_id);
    expect(packet!.open_blockers).toHaveLength(3);
    expect(packet!.open_blockers[0]!.question).toBe('Q1');
    expect(packet!.open_blockers[1]!.question).toBe('Q2');
    expect(packet!.open_blockers[2]!.question).toBe('Q3');
    // Verify raised_at ASC
    expect(packet!.open_blockers[0]!.raised_at).toBeLessThan(packet!.open_blockers[1]!.raised_at);
    expect(packet!.open_blockers[1]!.raised_at).toBeLessThan(packet!.open_blockers[2]!.raised_at);
  });

  // ---------------------------------------------------------------------------
  // Case 4: ANSWERED blockers > 10 → truncate to 10, newest first
  // ---------------------------------------------------------------------------

  it('4. answered blockers > 10 are truncated to 10 and ordered by answered_at DESC', () => {
    const task_id = insertTask('many answered blockers');
    setTaskState(task_id, 'BLOCKED');

    const now = Date.now();
    for (let i = 1; i <= 12; i++) {
      insertBlocker(task_id, {
        status: 'ANSWERED',
        question: `Q${i}`,
        raised_at: now + i,
        answer: `A${i}`,
        answered_by: 'agent',
        answered_at: now + i * 100,
      });
    }

    const packet = assembleResumePacket(ws.db, task_id);
    expect(packet!.answered_blockers).toHaveLength(10);
    // Must be ordered by answered_at DESC (newest = Q12, then Q11, ...)
    expect(packet!.answered_blockers[0]!.question).toBe('Q12');
    expect(packet!.answered_blockers[1]!.question).toBe('Q11');
    // Verify answered_at is descending
    expect(packet!.answered_blockers[0]!.answered_at).toBeGreaterThan(
      packet!.answered_blockers[1]!.answered_at,
    );
  });

  // ---------------------------------------------------------------------------
  // Case 5: READY checkpoint → last_checkpoint_sha = its git_head
  // ---------------------------------------------------------------------------

  it('5. READY checkpoint → last_checkpoint_sha equals its git_head', () => {
    const task_id = insertTask('checkpointed task');
    insertCheckpoint(task_id, { git_head: 'abc123def456', snapshot_status: 'READY' });

    const packet = assembleResumePacket(ws.db, task_id);
    expect(packet!.last_checkpoint_sha).toBe('abc123def456');
  });

  // ---------------------------------------------------------------------------
  // Case 6: PENDING/CORRUPTED checkpoints NOT selected; READY one is
  // ---------------------------------------------------------------------------

  it('6. PENDING and CORRUPTED checkpoints are never selected; only READY is used', () => {
    const task_id = insertTask('mixed checkpoint task');
    const now = Date.now();

    insertCheckpoint(task_id, { git_head: 'pending-sha', snapshot_status: 'PENDING', created_at: now + 100 });
    insertCheckpoint(task_id, { git_head: 'corrupted-sha', snapshot_status: 'CORRUPTED', created_at: now + 200 });
    insertCheckpoint(task_id, { git_head: 'ready-sha', snapshot_status: 'READY', created_at: now + 50 });

    const packet = assembleResumePacket(ws.db, task_id);
    // Must pick only the READY one, even though PENDING/CORRUPTED have later created_at
    expect(packet!.last_checkpoint_sha).toBe('ready-sha');
    expect(packet!.last_checkpoint_sha).not.toBe('pending-sha');
    expect(packet!.last_checkpoint_sha).not.toBe('corrupted-sha');
  });

  // ---------------------------------------------------------------------------
  // Case 7: no checkpoints → last_checkpoint_sha is null
  // ---------------------------------------------------------------------------

  it('7. no checkpoints → last_checkpoint_sha is null', () => {
    const task_id = insertTask('task without checkpoint');
    const packet = assembleResumePacket(ws.db, task_id);
    expect(packet!.last_checkpoint_sha).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Case 8: scratchpad keys filtered by task_id
  // ---------------------------------------------------------------------------

  it('8. scratchpad_keys includes only entries with matching task_id', () => {
    const task_id = insertTask('scratchpad task');

    // 2 matching entries
    insertScratchpad(task_id, 'key/matching-1');
    insertScratchpad(task_id, 'key/matching-2');
    // 1 different task_id
    const other_task_id = insertTask('other task');
    insertScratchpad(other_task_id, 'key/other-task');
    // 1 NULL task_id
    insertScratchpad(null, 'key/no-task');

    const packet = assembleResumePacket(ws.db, task_id);
    expect(packet!.scratchpad_keys).toHaveLength(2);
    expect(packet!.scratchpad_keys).toContain('key/matching-1');
    expect(packet!.scratchpad_keys).toContain('key/matching-2');
    expect(packet!.scratchpad_keys).not.toContain('key/other-task');
    expect(packet!.scratchpad_keys).not.toContain('key/no-task');
  });

  // ---------------------------------------------------------------------------
  // Case 9: outcomes_criteria is always []
  // ---------------------------------------------------------------------------

  it('9. outcomes_criteria is always [] in Phase 2', () => {
    const task_id = insertTask('outcomes task');
    const packet = assembleResumePacket(ws.db, task_id);
    expect(packet!.outcomes_criteria).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Case 10: validateResumePacket happy path
  // ---------------------------------------------------------------------------

  it('10. validateResumePacket: assembleResumePacket result passes validator', () => {
    const task_id = insertTask('validated task');
    const packet = assembleResumePacket(ws.db, task_id);
    const result = validateResumePacket(packet);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.packet.task_id).toBe(task_id);
    }
  });

  // ---------------------------------------------------------------------------
  // Case 11: validateResumePacket rejects missing required field
  // ---------------------------------------------------------------------------

  it('11. validateResumePacket rejects a packet missing task_id', () => {
    const task_id = insertTask('missing field task');
    const packet = assembleResumePacket(ws.db, task_id) as Record<string, unknown>;

    // Remove task_id to trigger validation error
    const broken = { ...packet };
    delete broken['task_id'];

    const result = validateResumePacket(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('task_id'))).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Case 12: validateResumePacket rejects wrong type
  // ---------------------------------------------------------------------------

  it('12. validateResumePacket rejects open_blockers as string', () => {
    const task_id = insertTask('wrong type task');
    const packet = assembleResumePacket(ws.db, task_id) as Record<string, unknown>;

    const broken = { ...packet, open_blockers: 'not-an-array' };

    const result = validateResumePacket(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('open_blockers'))).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Case 13: LD-9 read-only — spy on db.prepare, all SQL begins with SELECT
  // ---------------------------------------------------------------------------

  it('13. LD-9 read-only: all SQL prepared during assembleResumePacket begins with SELECT', () => {
    const task_id = insertTask('read-only task');
    setTaskState(task_id, 'BLOCKED');
    insertBlocker(task_id, { question: 'Audit item?' });

    const preparedSqls: string[] = [];
    const originalPrepare = ws.db.prepare.bind(ws.db);
    const spy = vi.spyOn(ws.db, 'prepare').mockImplementation((sql: string) => {
      preparedSqls.push(sql);
      return originalPrepare(sql);
    });

    assembleResumePacket(ws.db, task_id);

    spy.mockRestore();

    // There must have been at least one prepared statement
    expect(preparedSqls.length).toBeGreaterThan(0);

    // Every statement must start with SELECT (case-insensitive, trimmed)
    const violators = preparedSqls.filter(
      (sql) => !sql.trim().match(/^SELECT/i),
    );

    if (violators.length > 0) {
      throw new Error(
        `LD-9 VIOLATED: assembleResumePacket issued non-SELECT SQL:\n${violators.join('\n')}`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Phase 3 new cases (append — zero regression to cases 1-13)
  // ---------------------------------------------------------------------------

  it('14. task with outcome: outcomes_criteria has length 2 and structures match input', () => {
    const task_id = insertTask('task with outcome');
    // Set to RUNNING then insert outcome directly
    setTaskState(task_id, 'RUNNING');
    const criteria = [
      { primitive: 'file_exists', args: { path: 'README.md' } },
      { primitive: 'no_open_conflicts', args: {} },
    ];
    const outcome_id = `oc-${Date.now()}`;
    const now = Date.now();
    ws.db
      .prepare(
        `INSERT INTO outcomes (outcome_id, task_id, criteria_json, status, evaluated_at,
         evaluation_summary, grader_agent_id, created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, 'PENDING', NULL, NULL, NULL, ?, ?, NULL)`,
      )
      .run(outcome_id, task_id, JSON.stringify(criteria), now, now);
    // Also transition task to WAITING_REVIEW so state is consistent
    setTaskState(task_id, 'WAITING_REVIEW');

    const packet = assembleResumePacket(ws.db, task_id);
    expect(packet!.outcomes_criteria).toHaveLength(2);
    expect(packet!.outcomes_criteria[0]!.primitive).toBe('file_exists');
    expect(packet!.outcomes_criteria[1]!.primitive).toBe('no_open_conflicts');
  });

  it('15. task with no outcome: outcomes_criteria is [] (Phase 2 behavior preserved)', () => {
    const task_id = insertTask('no-outcome task');
    const packet = assembleResumePacket(ws.db, task_id);
    expect(packet!.outcomes_criteria).toEqual([]);
  });

  it('16. LD-9 read-only spy with outcome present: only SELECT statements issued', () => {
    const task_id = insertTask('spy-with-outcome task');
    setTaskState(task_id, 'WAITING_REVIEW');
    const criteria = [{ primitive: 'file_exists', args: { path: 'X.txt' } }];
    const outcome_id = `oc2-${Date.now()}`;
    const now = Date.now();
    ws.db
      .prepare(
        `INSERT INTO outcomes (outcome_id, task_id, criteria_json, status, evaluated_at,
         evaluation_summary, grader_agent_id, created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, 'PENDING', NULL, NULL, NULL, ?, ?, NULL)`,
      )
      .run(outcome_id, task_id, JSON.stringify(criteria), now, now);

    const preparedSqls: string[] = [];
    const originalPrepare = ws.db.prepare.bind(ws.db);
    const spy = vi.spyOn(ws.db, 'prepare').mockImplementation((sql: string) => {
      preparedSqls.push(sql);
      return originalPrepare(sql);
    });

    assembleResumePacket(ws.db, task_id);

    spy.mockRestore();

    expect(preparedSqls.length).toBeGreaterThan(0);

    const violators = preparedSqls.filter(
      (sql) => !sql.trim().match(/^SELECT/i),
    );

    if (violators.length > 0) {
      throw new Error(
        `LD-9 VIOLATED (with outcome): assembleResumePacket issued non-SELECT SQL:\n${violators.join('\n')}`,
      );
    }
  });
});
