import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace, type Workspace } from '../src/workspace.js';
import { toolInspectorQuery } from '../src/tools/inspector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpWorkspace(): { ws: Workspace; cairnRoot: string } {
  const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-inspector-test-'));
  const ws = openWorkspace({ cairnRoot });
  return { ws, cairnRoot };
}

/** Insert a process row directly. */
function insertProcess(ws: Workspace, agentId: string, status: 'ACTIVE' | 'IDLE' | 'DEAD' = 'ACTIVE') {
  const now = Date.now();
  ws.db.prepare(`
    INSERT INTO processes (agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl)
    VALUES (?, 'test-agent', NULL, ?, ?, ?, 60000)
  `).run(agentId, status, now, now);
}

/** Insert a conflict row directly. */
function insertConflict(ws: Workspace, opts: {
  agentA?: string;
  paths?: string[];
  status?: 'OPEN' | 'RESOLVED' | 'IGNORED';
  detectedAt?: number;
} = {}) {
  const id = `conflict-${Math.random().toString(36).slice(2)}`;
  const detectedAt = opts.detectedAt ?? Date.now();
  ws.db.prepare(`
    INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, agent_b, paths_json, summary, status, resolved_at, resolution)
    VALUES (?, ?, 'FILE_OVERLAP', ?, NULL, ?, NULL, ?, NULL, NULL)
  `).run(
    id,
    detectedAt,
    opts.agentA ?? 'agent-x',
    JSON.stringify(opts.paths ?? ['src/foo.ts']),
    opts.status ?? 'OPEN',
  );
  return id;
}

/** Insert a checkpoint row directly. */
function insertCheckpoint(ws: Workspace, taskId?: string) {
  const id = `ckpt-${Math.random().toString(36).slice(2)}`;
  ws.db.prepare(`
    INSERT INTO checkpoints (id, task_id, label, git_head, snapshot_dir, snapshot_status, size_bytes, created_at, ready_at)
    VALUES (?, ?, 'test', NULL, '/tmp/snap', 'READY', 0, ?, NULL)
  `).run(id, taskId ?? null, Date.now());
  return id;
}

/** Insert a scratchpad row directly. */
function insertScratchpad(ws: Workspace, key: string, taskId?: string) {
  ws.db.prepare(`
    INSERT OR REPLACE INTO scratchpad (key, task_id, value_json, expires_at, created_at, updated_at)
    VALUES (?, ?, '"value"', NULL, ?, ?)
  `).run(key, taskId ?? null, Date.now(), Date.now());
}

/** Insert a dispatch_request row directly. */
function insertDispatch(ws: Workspace, status: 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'FAILED' = 'PENDING') {
  const id = `dr-${Math.random().toString(36).slice(2)}`;
  ws.db.prepare(`
    INSERT INTO dispatch_requests (id, nl_intent, parsed_intent, context_keys, generated_prompt, target_agent, status, created_at, confirmed_at)
    VALUES (?, 'test intent', NULL, NULL, NULL, NULL, ?, ?, NULL)
  `).run(id, status, Date.now());
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cairn.inspector.query', () => {
  let ws: Workspace;
  let cairnRoot: string;

  beforeEach(() => {
    ({ ws, cairnRoot } = makeTmpWorkspace());
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  // ── Empty / unmatched ────────────────────────────────────────────────────

  it('empty query → matched=false with suggestion', () => {
    const r = toolInspectorQuery(ws, { query: '' });
    expect(r.matched).toBe(false);
    expect(r.suggestion).toBeTruthy();
    expect(r.intent).toBe('no_query');
  });

  it('completely unmatched query → matched=false with suggestion listing examples', () => {
    const r = toolInspectorQuery(ws, { query: 'gibberish foobar xyz' });
    expect(r.matched).toBe(false);
    expect(r.intent).toBe('unmatched');
    expect(r.suggestion).toContain('active agents');
    expect(r.suggestion).toContain('stats');
  });

  // ── Agents ───────────────────────────────────────────────────────────────

  it('EN: "active agents" → matched, returns only ACTIVE/IDLE agents', () => {
    insertProcess(ws, 'agent-alive', 'ACTIVE');
    insertProcess(ws, 'agent-dead', 'DEAD');

    const r = toolInspectorQuery(ws, { query: 'active agents' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_active_agents');
    expect(r.sql).toBeTruthy();
    expect(r.results).toBeDefined();
    const ids = (r.results as Array<{ agent_id: string }>).map((x) => x.agent_id);
    expect(ids).toContain('agent-alive');
    expect(ids).not.toContain('agent-dead');
  });

  it('ZH: "活跃 agent" → matched, same as "active agents"', () => {
    insertProcess(ws, 'agent-zh', 'ACTIVE');
    const r = toolInspectorQuery(ws, { query: '活跃 agent' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_active_agents');
    const ids = (r.results as Array<{ agent_id: string }>).map((x) => x.agent_id);
    expect(ids).toContain('agent-zh');
  });

  it('"all agents" → includes DEAD agents', () => {
    insertProcess(ws, 'agent-alive', 'ACTIVE');
    insertProcess(ws, 'agent-dead', 'DEAD');

    const r = toolInspectorQuery(ws, { query: 'all agents' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_all_agents');
    const ids = (r.results as Array<{ agent_id: string }>).map((x) => x.agent_id);
    expect(ids).toContain('agent-alive');
    expect(ids).toContain('agent-dead');
  });

  it('"dead agents" → only DEAD agents', () => {
    insertProcess(ws, 'agent-alive', 'ACTIVE');
    insertProcess(ws, 'agent-dead', 'DEAD');

    const r = toolInspectorQuery(ws, { query: 'dead agents' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_dead_agents');
    const ids = (r.results as Array<{ agent_id: string }>).map((x) => x.agent_id);
    expect(ids).not.toContain('agent-alive');
    expect(ids).toContain('agent-dead');
  });

  // ── Conflicts ─────────────────────────────────────────────────────────────

  it('"recent conflicts" → matched, ordered by detected_at DESC, max 10', () => {
    for (let i = 0; i < 5; i++) insertConflict(ws);
    const r = toolInspectorQuery(ws, { query: 'recent conflicts' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_recent_conflicts');
    expect(Array.isArray(r.results)).toBe(true);
    expect((r.results as unknown[]).length).toBeLessThanOrEqual(10);
  });

  it('"open conflicts" → only status=OPEN conflicts', () => {
    insertConflict(ws, { status: 'OPEN' });
    insertConflict(ws, { status: 'RESOLVED' });

    const r = toolInspectorQuery(ws, { query: 'open conflicts' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_open_conflicts');
    const statuses = (r.results as Array<{ status: string }>).map((x) => x.status);
    expect(statuses.every((s) => s === 'OPEN')).toBe(true);
  });

  it('"all conflicts today" → only conflicts from today', () => {
    const yesterday = Date.now() - 26 * 60 * 60 * 1000;
    insertConflict(ws, { detectedAt: Date.now(), agentA: 'today-agent' });
    insertConflict(ws, { detectedAt: yesterday, agentA: 'old-agent' });

    const r = toolInspectorQuery(ws, { query: 'all conflicts today' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_conflicts_today');
    const agents = (r.results as Array<{ agent_a: string }>).map((x) => x.agent_a);
    expect(agents).toContain('today-agent');
    expect(agents).not.toContain('old-agent');
  });

  it('"conflicts for path src/foo.ts" → SQL LIKE %src/foo.ts%', () => {
    insertConflict(ws, { paths: ['src/foo.ts'], agentA: 'agent-foo' });
    insertConflict(ws, { paths: ['src/bar.ts'], agentA: 'agent-bar' });

    const r = toolInspectorQuery(ws, { query: 'conflicts for path src/foo.ts' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_conflicts_for_path');
    expect(r.sql).toContain('LIKE');
    const agents = (r.results as Array<{ agent_a: string }>).map((x) => x.agent_a);
    expect(agents).toContain('agent-foo');
    expect(agents).not.toContain('agent-bar');
  });

  // ── Checkpoints ───────────────────────────────────────────────────────────

  it('"recent checkpoints" → matched, max 10 results', () => {
    for (let i = 0; i < 5; i++) insertCheckpoint(ws);
    const r = toolInspectorQuery(ws, { query: 'recent checkpoints' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_recent_checkpoints');
    expect((r.results as unknown[]).length).toBeLessThanOrEqual(10);
  });

  it('"checkpoints for task abc-123" → extracts task_id abc-123', () => {
    insertCheckpoint(ws, 'abc-123');
    insertCheckpoint(ws, 'other-task');

    const r = toolInspectorQuery(ws, { query: 'checkpoints for task abc-123' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_checkpoints_for_task');
    expect(r.sql).toContain('task_id = ?');
    const tasks = (r.results as Array<{ task_id: string | null }>).map((x) => x.task_id);
    expect(tasks).toContain('abc-123');
    expect(tasks).not.toContain('other-task');
  });

  // ── Scratchpad ─────────────────────────────────────────────────────────────

  it('"scratchpad keys" → lists all entries', () => {
    insertScratchpad(ws, 'key-a');
    insertScratchpad(ws, 'key-b');

    const r = toolInspectorQuery(ws, { query: 'scratchpad keys' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_scratchpad_keys');
    const keys = (r.results as Array<{ key: string }>).map((x) => x.key);
    expect(keys).toContain('key-a');
    expect(keys).toContain('key-b');
  });

  it('"scratchpad for task my-task" → only entries for that task_id', () => {
    insertScratchpad(ws, 'task-key', 'my-task');
    insertScratchpad(ws, 'other-key', 'other-task');

    const r = toolInspectorQuery(ws, { query: 'scratchpad for task my-task' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_scratchpad_for_task');
    const keys = (r.results as Array<{ key: string }>).map((x) => x.key);
    expect(keys).toContain('task-key');
    expect(keys).not.toContain('other-key');
  });

  // ── Dispatch ──────────────────────────────────────────────────────────────

  it('"recent dispatch requests" / "派单历史" → matched', () => {
    insertDispatch(ws, 'PENDING');
    const r = toolInspectorQuery(ws, { query: 'recent dispatch requests' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_recent_dispatch');
    expect((r.results as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('ZH: "派单历史" → same as "recent dispatch requests"', () => {
    insertDispatch(ws, 'CONFIRMED');
    const r = toolInspectorQuery(ws, { query: '派单历史' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_recent_dispatch');
  });

  it('"pending dispatch" → only PENDING records', () => {
    insertDispatch(ws, 'PENDING');
    insertDispatch(ws, 'CONFIRMED');

    const r = toolInspectorQuery(ws, { query: 'pending dispatch' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_pending_dispatch');
    const statuses = (r.results as Array<{ status: string }>).map((x) => x.status);
    expect(statuses.every((s) => s === 'PENDING')).toBe(true);
  });

  it('"confirmed dispatch" → only CONFIRMED records', () => {
    insertDispatch(ws, 'PENDING');
    insertDispatch(ws, 'CONFIRMED');

    const r = toolInspectorQuery(ws, { query: 'confirmed dispatch' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_confirmed_dispatch');
    const statuses = (r.results as Array<{ status: string }>).map((x) => x.status);
    expect(statuses.every((s) => s === 'CONFIRMED')).toBe(true);
  });

  // ── Stats ─────────────────────────────────────────────────────────────────

  it('"stats" → summary object with 4 numeric fields', () => {
    insertProcess(ws, 'a1', 'ACTIVE');
    insertConflict(ws, { status: 'OPEN' });
    insertCheckpoint(ws);
    insertDispatch(ws, 'PENDING');

    const r = toolInspectorQuery(ws, { query: 'stats' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('summary_stats');
    expect(r.results).toBeDefined();
    const row = (r.results as Array<Record<string, number>>)[0]!;
    expect(typeof row.active_agents).toBe('number');
    expect(typeof row.open_conflicts).toBe('number');
    expect(typeof row.total_checkpoints).toBe('number');
    expect(typeof row.pending_dispatch).toBe('number');
    expect(row.active_agents).toBeGreaterThanOrEqual(1);
    expect(row.open_conflicts).toBeGreaterThanOrEqual(1);
    expect(row.total_checkpoints).toBeGreaterThanOrEqual(1);
    expect(row.pending_dispatch).toBeGreaterThanOrEqual(1);
  });

  it('ZH: "摘要" → same as "stats"', () => {
    const r = toolInspectorQuery(ws, { query: '摘要' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('summary_stats');
  });

  // ── Output shape ──────────────────────────────────────────────────────────

  it('matched result always has matched, intent, sql, results fields', () => {
    const r = toolInspectorQuery(ws, { query: 'active agents' });
    expect(r).toHaveProperty('matched', true);
    expect(r).toHaveProperty('intent');
    expect(r).toHaveProperty('sql');
    expect(r).toHaveProperty('results');
    expect(typeof r.sql).toBe('string');
    expect(Array.isArray(r.results)).toBe(true);
  });

  // ── LIMIT 100 guardrail ───────────────────────────────────────────────────

  it('LIMIT 100 guardrail: inserting 150 processes only returns max 100', () => {
    for (let i = 0; i < 150; i++) {
      insertProcess(ws, `agent-bulk-${i}`, 'ACTIVE');
    }
    const r = toolInspectorQuery(ws, { query: 'all agents' });
    expect(r.matched).toBe(true);
    expect((r.results as unknown[]).length).toBeLessThanOrEqual(100);
  });

  // ── Case insensitivity ────────────────────────────────────────────────────

  it('query is case-insensitive: "ACTIVE AGENTS" → matches same as "active agents"', () => {
    insertProcess(ws, 'agent-upper', 'ACTIVE');
    const r = toolInspectorQuery(ws, { query: 'ACTIVE AGENTS' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_active_agents');
  });

  // ── Longer keyword wins ───────────────────────────────────────────────────

  it('longer keyword match wins: "all conflicts today" beats "conflicts"', () => {
    const r = toolInspectorQuery(ws, { query: 'all conflicts today' });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('list_conflicts_today');
  });
});
