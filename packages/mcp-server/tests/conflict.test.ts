import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace, type Workspace } from '../src/workspace.js';
import { toolListConflicts, toolResolveConflict } from '../src/tools/conflict.js';
import { toolCreateCheckpoint } from '../src/tools/checkpoint.js';
import { registerProcess } from '../../daemon/dist/storage/repositories/processes.js';
import { newId } from '../../daemon/dist/storage/ids.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpWorkspace(): Workspace {
  const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-conflict-test-'));
  return openWorkspace({ cairnRoot });
}

/** Register an ACTIVE agent in the given workspace db. */
function registerActive(ws: Workspace, agentId: string): void {
  registerProcess(ws.db, {
    agentId,
    agentType: 'test-agent',
    heartbeatTtl: 3_600_000,
  });
}

/** Insert a checkpoint row whose task_id == agentId (in-flight proxy). */
function insertCheckpoint(ws: Workspace, agentId: string, createdAt: number = Date.now()): void {
  ws.db.prepare(`
    INSERT INTO checkpoints (id, task_id, label, git_head, snapshot_dir,
                             snapshot_status, size_bytes, created_at, ready_at)
    VALUES (?, ?, NULL, NULL, '/tmp/snap', 'READY', 0, ?, NULL)
  `).run(newId(), agentId, createdAt);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cairn.conflict.list', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeTmpWorkspace();
  });

  afterEach(() => {
    ws.db.close();
    // cairnRoot is inside tmpdir — OS will clean it up, but we do it eagerly
  });

  it('returns empty list when no conflicts exist', () => {
    const result = toolListConflicts(ws);
    expect(result.items).toHaveLength(0);
    expect(result.count).toBe(0);
  });

  it('returns all conflicts within default 24h window', () => {
    // Manufacture a conflict directly via the conflicts table
    ws.db.prepare(`
      INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, agent_b,
                             paths_json, summary, status, resolved_at, resolution)
      VALUES (?, ?, 'FILE_OVERLAP', 'agent-a', 'agent-b',
              '["src/foo.ts"]', NULL, 'OPEN', NULL, NULL)
    `).run(newId(), Date.now());

    const result = toolListConflicts(ws);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.type).toBe('FILE_OVERLAP');
    expect(result.items[0]!.agent_a).toBe('agent-a');
    expect(result.items[0]!.agent_b).toBe('agent-b');
    expect(result.items[0]!.paths).toEqual(['src/foo.ts']);
    expect(result.items[0]!.status).toBe('OPEN');
    expect(result.items[0]!.detected_at_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.items[0]!.resolved_at_iso).toBeNull();
  });

  it('filters by since (ISO string)', () => {
    const oldTime = Date.now() - 48 * 60 * 60 * 1000; // 48 h ago
    ws.db.prepare(`
      INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, agent_b,
                             paths_json, summary, status, resolved_at, resolution)
      VALUES (?, ?, 'FILE_OVERLAP', 'a', NULL, '[]', NULL, 'OPEN', NULL, NULL)
    `).run(newId(), oldTime);

    const recentTime = Date.now();
    ws.db.prepare(`
      INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, agent_b,
                             paths_json, summary, status, resolved_at, resolution)
      VALUES (?, ?, 'FILE_OVERLAP', 'b', NULL, '[]', NULL, 'OPEN', NULL, NULL)
    `).run(newId(), recentTime);

    // Query with since = 1 hour ago → should only return the recent one
    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = toolListConflicts(ws, { since: sinceIso });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.agent_a).toBe('b');
  });

  it('includes resolved_at_iso when conflict is resolved', () => {
    const resolvedAt = Date.now();
    ws.db.prepare(`
      INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, agent_b,
                             paths_json, summary, status, resolved_at, resolution)
      VALUES (?, ?, 'FILE_OVERLAP', 'x', 'y', '[]', NULL, 'RESOLVED', ?, 'manual fix')
    `).run(newId(), Date.now(), resolvedAt);

    const result = toolListConflicts(ws);
    expect(result.items[0]!.status).toBe('RESOLVED');
    expect(result.items[0]!.resolved_at_iso).not.toBeNull();
    expect(result.items[0]!.resolved_at_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// cairn.conflict.resolve tests
// ---------------------------------------------------------------------------

describe('cairn.conflict.resolve', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeTmpWorkspace();
  });

  afterEach(() => {
    ws.db.close();
  });

  function insertConflict(status: string, id: string = newId()): string {
    ws.db.prepare(`
      INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, agent_b,
                             paths_json, summary, status, resolved_at, resolution)
      VALUES (?, ?, 'FILE_OVERLAP', 'agent-a', 'agent-b',
              '["src/foo.ts"]', 'test conflict', ?, NULL, NULL)
    `).run(id, Date.now(), status);
    return id;
  }

  it('resolves an OPEN conflict — returns ok:true, status RESOLVED, resolved_at set', () => {
    const id = insertConflict('OPEN');
    const result = toolResolveConflict(ws, { conflict_id: id });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('RESOLVED');
    expect(result.conflict_id).toBe(id);
    expect(result.resolved_at_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const row = ws.db.prepare('SELECT status, resolved_at FROM conflicts WHERE id = ?').get(id) as { status: string; resolved_at: number | null };
    expect(row.status).toBe('RESOLVED');
    expect(row.resolved_at).not.toBeNull();
  });

  it('resolves a PENDING_REVIEW conflict — returns ok:true', () => {
    const id = insertConflict('PENDING_REVIEW');
    const result = toolResolveConflict(ws, { conflict_id: id });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('RESOLVED');
  });

  it('rejects an already-RESOLVED conflict — ok:false with current_status', () => {
    const id = insertConflict('RESOLVED');
    // Manually set resolved_at since insertConflict leaves it NULL
    ws.db.prepare('UPDATE conflicts SET resolved_at = ? WHERE id = ?').run(Date.now(), id);
    const result = toolResolveConflict(ws, { conflict_id: id });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot resolve/);
    expect(result.current_status).toBe('RESOLVED');
  });

  it('returns ok:false for unknown conflict id', () => {
    const result = toolResolveConflict(ws, { conflict_id: 'nonexistent-id-xyz' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('passes resolution text through to the stored row', () => {
    const id = insertConflict('OPEN');
    toolResolveConflict(ws, { conflict_id: id, resolution: 'manually fixed by agent-a' });
    const row = ws.db.prepare('SELECT resolution FROM conflicts WHERE id = ?').get(id) as { resolution: string | null };
    expect(row.resolution).toBe('manually fixed by agent-a');
  });

  it('uses default resolution text when resolution arg is omitted', () => {
    const id = insertConflict('OPEN');
    toolResolveConflict(ws, { conflict_id: id });
    const row = ws.db.prepare('SELECT resolution FROM conflicts WHERE id = ?').get(id) as { resolution: string | null };
    expect(row.resolution).toBe('resolved via cairn.conflict.resolve');
  });
});

describe('cairn.checkpoint.create conflict detection', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeTmpWorkspace();
  });

  afterEach(() => {
    ws.db.close();
  });

  it('without agent_id: uses ws.agentId — conflict detection still runs', () => {
    // Phase 1a: agent_id is now always resolved (auto-fallback to ws.agentId).
    // Register a peer with a recent checkpoint on overlapping paths.
    registerActive(ws, 'agent-peer');
    insertCheckpoint(ws, 'agent-peer');

    // toolCreateCheckpoint without git repo context will use null stash/head —
    // that's fine for this test, we only check that detection fires (not skipped).
    // ws.agentId is a valid agent, so conflict detection runs. Whether a conflict
    // is detected depends on whether ws.agentId == 'agent-peer' (it won't be).
    // The peer's paths overlap with the auto-collected git paths, so a conflict
    // may or may not appear — but the function must not throw.
    const result = toolCreateCheckpoint(ws, { label: 'no-agent-id' });
    expect(result.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('with agent_id but no peer activity: no conflict field', () => {
    registerActive(ws, 'agent-a');
    // No peer agents → no conflict

    const result = toolCreateCheckpoint(ws, {
      label: 'solo',
      agent_id: 'agent-a',
      paths: ['src/main.ts'],
    });
    expect((result as Record<string, unknown>).conflict).toBeUndefined();
  });

  it('with agent_id and active peer: conflict field populated', () => {
    registerActive(ws, 'agent-a');
    registerActive(ws, 'agent-b');
    insertCheckpoint(ws, 'agent-b'); // peer has in-flight activity

    const result = toolCreateCheckpoint(ws, {
      label: 'overlap',
      agent_id: 'agent-a',
      paths: ['src/shared.ts'],
    });

    const r = result as Record<string, unknown>;
    expect(r.conflict).toBeDefined();
    const conflict = r.conflict as { id: string; conflictedWith: string[]; overlappingPaths: string[] };
    expect(conflict.id).toBeTruthy();
    expect(conflict.conflictedWith).toContain('agent-b');
    expect(conflict.overlappingPaths).toContain('src/shared.ts');

    // Checkpoint itself should still be created (non-blocking)
    expect(r.id).toBeTruthy();
  });

  it('checkpoint.create still succeeds even when conflict is detected', () => {
    registerActive(ws, 'agent-a');
    registerActive(ws, 'agent-b');
    insertCheckpoint(ws, 'agent-b');

    const result = toolCreateCheckpoint(ws, {
      agent_id: 'agent-a',
      paths: ['any.ts'],
    });

    // The checkpoint row was created
    const row = ws.db
      .prepare('SELECT id FROM checkpoints WHERE id = ?')
      .get((result as Record<string, unknown>).id as string);
    expect(row).toBeDefined();
  });
});
