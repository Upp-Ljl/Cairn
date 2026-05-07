/**
 * Task 5.4.1 — Inspector legacy_orphan annotation
 *
 * Verifies that rows with task_id IS NULL are annotated with
 * `_label: 'legacy_orphan'` at response-serialization time, and that rows
 * with a real task_id are returned unchanged (no _label).
 *
 * This is a READ-SIDE annotation only. The DB is never mutated with _label.
 * Inspector is read-only, so there is no write path to test (see skipped test).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace, type Workspace } from '../src/workspace.js';
import { toolInspectorQuery } from '../src/tools/inspector.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors patterns in inspector.test.ts)
// ---------------------------------------------------------------------------

function makeTmpWorkspace(): { ws: Workspace; cairnRoot: string } {
  const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-legacy-orphan-test-'));
  const ws = openWorkspace({ cairnRoot });
  return { ws, cairnRoot };
}

/** Insert a scratchpad row with optional task_id (NULL when omitted). */
function insertScratchpad(ws: Workspace, key: string, taskId?: string | null) {
  ws.db.prepare(`
    INSERT OR REPLACE INTO scratchpad (key, task_id, value_json, expires_at, created_at, updated_at)
    VALUES (?, ?, '"value"', NULL, ?, ?)
  `).run(key, taskId ?? null, Date.now(), Date.now());
}

/** Insert a checkpoint row with optional task_id (NULL when omitted). */
function insertCheckpoint(ws: Workspace, taskId?: string | null): string {
  const id = `ckpt-${Math.random().toString(36).slice(2)}`;
  ws.db.prepare(`
    INSERT INTO checkpoints (id, task_id, label, git_head, snapshot_dir, snapshot_status, size_bytes, created_at, ready_at)
    VALUES (?, ?, 'test', NULL, '/tmp/snap', 'READY', 0, ?, NULL)
  `).run(id, taskId ?? null, Date.now());
  return id;
}

/** Insert a dispatch_request row with optional task_id (NULL when omitted). */
function insertDispatch(
  ws: Workspace,
  status: 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'FAILED' = 'PENDING',
  taskId?: string | null,
): string {
  const id = `dr-${Math.random().toString(36).slice(2)}`;
  ws.db.prepare(`
    INSERT INTO dispatch_requests (id, nl_intent, parsed_intent, context_keys, generated_prompt, target_agent, status, created_at, confirmed_at)
    VALUES (?, 'test intent', NULL, NULL, NULL, NULL, ?, ?, NULL)
  `).run(id, status, Date.now());
  // task_id column may not exist yet (migration 008 is Phase 1), so we attempt
  // to set it only if the column is present.
  const cols = (
    ws.db.prepare("PRAGMA table_info(dispatch_requests)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (cols.includes('task_id') && taskId !== undefined) {
    ws.db.prepare('UPDATE dispatch_requests SET task_id = ? WHERE id = ?').run(taskId, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Inspector legacy_orphan annotation (Task 5.4.1)', () => {
  let ws: Workspace;
  let cairnRoot: string;

  beforeEach(() => {
    ({ ws, cairnRoot } = makeTmpWorkspace());
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  // ── Scratchpad ─────────────────────────────────────────────────────────────

  it('scratchpad row with task_id=NULL → _label: legacy_orphan', () => {
    insertScratchpad(ws, 'orphan-key', null);

    const r = toolInspectorQuery(ws, { query: 'scratchpad keys' });
    expect(r.matched).toBe(true);
    const rows = r.results as Array<Record<string, unknown>>;
    const orphan = rows.find((row) => row['key'] === 'orphan-key');
    expect(orphan).toBeDefined();
    expect(orphan!['_label']).toBe('legacy_orphan');
  });

  it('scratchpad row with real task_id → no _label field', () => {
    insertScratchpad(ws, 'task-key', 'real-task-001');

    const r = toolInspectorQuery(ws, { query: 'scratchpad keys' });
    expect(r.matched).toBe(true);
    const rows = r.results as Array<Record<string, unknown>>;
    const taskRow = rows.find((row) => row['key'] === 'task-key');
    expect(taskRow).toBeDefined();
    expect(taskRow!['_label']).toBeUndefined();
  });

  it('mixed scratchpad: orphan gets _label, task row does not', () => {
    insertScratchpad(ws, 'key-orphan', null);
    insertScratchpad(ws, 'key-with-task', 'task-abc');

    const r = toolInspectorQuery(ws, { query: 'scratchpad keys' });
    expect(r.matched).toBe(true);
    const rows = r.results as Array<Record<string, unknown>>;
    const orphan = rows.find((row) => row['key'] === 'key-orphan');
    const withTask = rows.find((row) => row['key'] === 'key-with-task');
    expect(orphan!['_label']).toBe('legacy_orphan');
    expect(withTask!['_label']).toBeUndefined();
  });

  // ── Checkpoints ────────────────────────────────────────────────────────────

  it('checkpoint row with task_id=NULL → _label: legacy_orphan', () => {
    insertCheckpoint(ws, null);

    const r = toolInspectorQuery(ws, { query: 'recent checkpoints' });
    expect(r.matched).toBe(true);
    const rows = r.results as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // All rows in a fresh DB have task_id=NULL
    for (const row of rows) {
      expect(row['_label']).toBe('legacy_orphan');
    }
  });

  it('checkpoint row with real task_id → no _label field', () => {
    insertCheckpoint(ws, 'real-task-ckpt');

    const r = toolInspectorQuery(ws, { query: 'recent checkpoints' });
    expect(r.matched).toBe(true);
    const rows = r.results as Array<Record<string, unknown>>;
    const ckptRow = rows[0];
    expect(ckptRow).toBeDefined();
    expect(ckptRow!['task_id']).toBe('real-task-ckpt');
    expect(ckptRow!['_label']).toBeUndefined();
  });

  // ── Dispatch requests ──────────────────────────────────────────────────────

  it('dispatch row with task_id=NULL → _label: legacy_orphan', () => {
    insertDispatch(ws, 'PENDING', null);

    const r = toolInspectorQuery(ws, { query: 'pending dispatch' });
    expect(r.matched).toBe(true);
    const rows = r.results as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // task_id column may not yet exist (migration 008 adds it in W5 Phase 1).
    // If present, verify the annotation; if absent, skip the _label check.
    const cols = (
      ws.db.prepare("PRAGMA table_info(dispatch_requests)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (cols.includes('task_id')) {
      for (const row of rows) {
        expect(row['_label']).toBe('legacy_orphan');
      }
    }
    // Either way the query matched and returned rows without error.
  });

  // ── Write-path guard ───────────────────────────────────────────────────────

  it.skip('inspector write path does not accept _label — inspector is read-only, no write path to test', () => {
    // toolInspectorQuery is a pure query function; there is no write endpoint.
    // The _label field is applied only in response serialization and is never
    // passed to any INSERT / UPDATE statement.
  });
});
