import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from '../storage/helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import { detectConflict } from '../../src/services/conflict-detection.js';
import { registerProcess } from '../../src/storage/repositories/processes.js';
import { listConflicts } from '../../src/storage/repositories/conflicts.js';
import { newId } from '../../src/storage/ids.js';
import type { Database as DB } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DB;

beforeEach(() => {
  ({ db } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
});

/** Register an ACTIVE agent by agent_id with a long TTL. */
function registerActive(agentId: string): void {
  registerProcess(db, { agentId, agentType: 'test-agent', heartbeatTtl: 3_600_000 });
}

/** Insert a checkpoint row with task_id = agentId, created_at = now. */
function insertCheckpoint(agentId: string, createdAt: number = Date.now()): void {
  db.prepare(`
    INSERT INTO checkpoints (id, task_id, label, git_head, snapshot_dir,
                             snapshot_status, size_bytes, created_at, ready_at)
    VALUES (?, ?, NULL, NULL, '/tmp/snap', 'READY', 0, ?, NULL)
  `).run(newId(), agentId, createdAt);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectConflict', () => {
  it('returns null when paths is empty', () => {
    registerActive('agent-a');
    registerActive('agent-b');
    insertCheckpoint('agent-b');

    const result = detectConflict(db, { agentId: 'agent-a', paths: [] });
    expect(result.conflictId).toBeNull();
    expect(result.conflictedWith).toHaveLength(0);
    expect(result.overlappingPaths).toHaveLength(0);
  });

  it('returns null when no other agents are registered', () => {
    // Only the calling agent is registered — no peers
    registerActive('agent-a');

    const result = detectConflict(db, {
      agentId: 'agent-a',
      paths: ['src/foo.ts'],
    });
    expect(result.conflictId).toBeNull();
  });

  it('returns null when peer has no recent checkpoints (no overlap)', () => {
    registerActive('agent-a');
    registerActive('agent-b');
    // agent-b has NO checkpoint row → no conflict

    const result = detectConflict(db, {
      agentId: 'agent-a',
      paths: ['src/foo.ts'],
    });
    expect(result.conflictId).toBeNull();
    expect(result.conflictedWith).toHaveLength(0);
  });

  it('detects conflict when peer has checkpoint in window', () => {
    registerActive('agent-a');
    registerActive('agent-b');
    insertCheckpoint('agent-b'); // within default 5-min window

    const before = Date.now();
    const result = detectConflict(db, {
      agentId: 'agent-a',
      paths: ['src/index.ts', 'src/utils.ts'],
    });
    const after = Date.now();

    expect(result.conflictId).not.toBeNull();
    expect(result.conflictedWith).toContain('agent-b');
    expect(result.overlappingPaths).toEqual(['src/index.ts', 'src/utils.ts']);

    // Conflict row should be written to DB
    const conflicts = listConflicts(db);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflict_type).toBe('FILE_OVERLAP');
    expect(conflicts[0]!.agent_a).toBe('agent-a');
    expect(conflicts[0]!.agent_b).toBe('agent-b');
    expect(conflicts[0]!.detected_at).toBeGreaterThanOrEqual(before);
    expect(conflicts[0]!.detected_at).toBeLessThanOrEqual(after);
  });

  it('does NOT trigger when the same agent creates both checkpoints (self)', () => {
    registerActive('agent-a');
    insertCheckpoint('agent-a'); // own checkpoint, not a peer

    const result = detectConflict(db, {
      agentId: 'agent-a',
      paths: ['src/foo.ts'],
    });
    expect(result.conflictId).toBeNull();
    expect(listConflicts(db)).toHaveLength(0);
  });

  it('does NOT trigger when peer checkpoint is outside the time window', () => {
    registerActive('agent-a');
    registerActive('agent-b');

    // Insert a checkpoint created 10 minutes ago (outside default 5-min window)
    const oldTime = Date.now() - 10 * 60 * 1000;
    insertCheckpoint('agent-b', oldTime);

    const result = detectConflict(db, {
      agentId: 'agent-a',
      paths: ['src/foo.ts'],
      windowMinutes: 5,
    });
    expect(result.conflictId).toBeNull();
  });

  it('respects custom windowMinutes', () => {
    registerActive('agent-a');
    registerActive('agent-b');

    // Checkpoint 8 minutes ago — outside 5-min window but inside 10-min window
    const eightMinsAgo = Date.now() - 8 * 60 * 1000;
    insertCheckpoint('agent-b', eightMinsAgo);

    const noConflict = detectConflict(db, {
      agentId: 'agent-a',
      paths: ['src/foo.ts'],
      windowMinutes: 5,
    });
    expect(noConflict.conflictId).toBeNull();

    const withConflict = detectConflict(db, {
      agentId: 'agent-a',
      paths: ['src/foo.ts'],
      windowMinutes: 10,
    });
    expect(withConflict.conflictId).not.toBeNull();
  });

  it('does NOT trigger for a DEAD agent (expired heartbeat)', () => {
    // Register agent-b then immediately expire its heartbeat
    const now = Date.now();
    db.prepare(`
      INSERT INTO processes (agent_id, agent_type, capabilities, status,
                             registered_at, last_heartbeat, heartbeat_ttl)
      VALUES ('dead-agent', 'test', NULL, 'ACTIVE', ?, ?, 1)
    `).run(now, now - 1000); // last_heartbeat 1 s ago, ttl = 1 ms → DEAD

    insertCheckpoint('dead-agent');
    registerActive('agent-a');

    const result = detectConflict(db, {
      agentId: 'agent-a',
      paths: ['src/foo.ts'],
    });
    expect(result.conflictId).toBeNull();
  });

  it('detects conflicts with multiple peers simultaneously', () => {
    registerActive('agent-a');
    registerActive('agent-b');
    registerActive('agent-c');
    insertCheckpoint('agent-b');
    insertCheckpoint('agent-c');

    const result = detectConflict(db, {
      agentId: 'agent-a',
      paths: ['shared/lib.ts'],
    });

    expect(result.conflictId).not.toBeNull();
    expect(result.conflictedWith).toContain('agent-b');
    expect(result.conflictedWith).toContain('agent-c');
    // One conflict row per peer
    expect(listConflicts(db)).toHaveLength(2);
  });

  it('recordConflict uses conflictType FILE_OVERLAP', () => {
    registerActive('agent-a');
    registerActive('agent-b');
    insertCheckpoint('agent-b');

    detectConflict(db, {
      agentId: 'agent-a',
      paths: ['main.ts'],
    });

    const conflicts = listConflicts(db);
    expect(conflicts[0]!.conflict_type).toBe('FILE_OVERLAP');
  });
});
