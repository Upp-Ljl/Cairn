import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace, type Workspace } from '../src/workspace.js';
import {
  toolRegisterProcess,
  toolHeartbeat,
  toolListProcesses,
  toolGetProcess,
} from '../src/tools/process.js';

describe('process bus — 4 tools acceptance tests', () => {
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-proc-'));
    ws = openWorkspace({ cairnRoot });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  // --- cairn.process.register ---

  it('register: happy path — returns ok with agent_id and ACTIVE status', () => {
    const r = toolRegisterProcess(ws, {
      agent_id: 'agent-001',
      agent_type: 'orchestrator',
    });
    expect(r.ok).toBe(true);
    expect(r.agent_id).toBe('agent-001');
    expect(r.agent_type).toBe('orchestrator');
    expect(r.status).toBe('ACTIVE');
    expect(r.capabilities).toBeNull();
    expect(r.registered_at_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.last_heartbeat_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('register: with capabilities array', () => {
    const r = toolRegisterProcess(ws, {
      agent_id: 'agent-002',
      agent_type: 'coder',
      capabilities: ['typescript', 'python', 'bash'],
    });
    expect(r.ok).toBe(true);
    expect(r.capabilities).toEqual(['typescript', 'python', 'bash']);
  });

  it('register: re-registering same agent_id resets heartbeat (INSERT OR REPLACE)', async () => {
    toolRegisterProcess(ws, { agent_id: 'agent-dup', agent_type: 'worker' });
    // small delay to ensure clock advances
    await new Promise((r) => setTimeout(r, 5));
    const r2 = toolRegisterProcess(ws, { agent_id: 'agent-dup', agent_type: 'worker-v2' });
    expect(r2.ok).toBe(true);
    expect(r2.agent_type).toBe('worker-v2');
    // Only one row in DB
    const row = ws.db.prepare('SELECT COUNT(*) as cnt FROM processes WHERE agent_id = ?').get('agent-dup') as { cnt: number };
    expect(row.cnt).toBe(1);
  });

  it('register: custom heartbeat_ttl is stored', () => {
    const r = toolRegisterProcess(ws, {
      agent_id: 'agent-ttl',
      agent_type: 'monitor',
      heartbeat_ttl: 120000,
    });
    expect(r.ok).toBe(true);
    expect(r.heartbeat_ttl).toBe(120000);
  });

  // --- cairn.process.heartbeat ---

  it('heartbeat: happy path — returns ok with updated last_heartbeat_iso', async () => {
    toolRegisterProcess(ws, { agent_id: 'agent-hb', agent_type: 'worker' });
    await new Promise((r) => setTimeout(r, 5));
    const r = toolHeartbeat(ws, { agent_id: 'agent-hb' });
    expect(r.ok).toBe(true);
    expect((r as { agent_id: string }).agent_id).toBe('agent-hb');
    expect((r as { last_heartbeat_iso: string }).last_heartbeat_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((r as { status: string }).status).toBe('ACTIVE');
  });

  it('heartbeat: unknown agent_id returns ok=false with error message', () => {
    const r = toolHeartbeat(ws, { agent_id: 'ghost-agent' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/agent not registered/);
    expect((r as { error: string }).error).toContain('ghost-agent');
  });

  // --- cairn.process.list ---

  it('list: happy path — returns registered agents (ACTIVE)', () => {
    toolRegisterProcess(ws, { agent_id: 'a1', agent_type: 'typeA' });
    toolRegisterProcess(ws, { agent_id: 'a2', agent_type: 'typeB' });
    const r = toolListProcesses(ws, {});
    expect(r.items.length).toBe(2);
    const ids = r.items.map((p) => p.agent_id);
    expect(ids).toContain('a1');
    expect(ids).toContain('a2');
    r.items.forEach((p) => {
      expect(p.last_heartbeat_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it('list: default excludes DEAD agents (TTL expired)', () => {
    // Register with 1ms TTL so it immediately becomes DEAD
    toolRegisterProcess(ws, {
      agent_id: 'dying-agent',
      agent_type: 'ephemeral',
      heartbeat_ttl: 1,
    });
    // Manually backdate last_heartbeat so it's definitely expired
    ws.db.prepare('UPDATE processes SET last_heartbeat = ? WHERE agent_id = ?').run(
      Date.now() - 10000,
      'dying-agent',
    );

    toolRegisterProcess(ws, { agent_id: 'live-agent', agent_type: 'permanent' });

    const r = toolListProcesses(ws, {});
    const ids = r.items.map((p) => p.agent_id);
    expect(ids).not.toContain('dying-agent');
    expect(ids).toContain('live-agent');
  });

  it('list: include_dead=true includes DEAD agents', () => {
    toolRegisterProcess(ws, {
      agent_id: 'dead-agent',
      agent_type: 'ephemeral',
      heartbeat_ttl: 1,
    });
    ws.db.prepare('UPDATE processes SET last_heartbeat = ? WHERE agent_id = ?').run(
      Date.now() - 10000,
      'dead-agent',
    );

    const r = toolListProcesses(ws, { include_dead: true });
    const deadItems = r.items.filter((p) => p.agent_id === 'dead-agent');
    expect(deadItems.length).toBe(1);
    expect(deadItems[0]!.status).toBe('DEAD');
  });

  it('list: empty process bus returns empty items array', () => {
    const r = toolListProcesses(ws, {});
    expect(r.items).toEqual([]);
  });

  // --- cairn.process.status ---

  it('status: happy path — returns full agent details', () => {
    toolRegisterProcess(ws, {
      agent_id: 'status-agent',
      agent_type: 'tester',
      capabilities: ['read', 'write'],
    });
    const r = toolGetProcess(ws, { agent_id: 'status-agent' });
    expect(r.ok).toBe(true);
    expect((r as { agent_id: string }).agent_id).toBe('status-agent');
    expect((r as { agent_type: string }).agent_type).toBe('tester');
    expect((r as { status: string }).status).toBe('ACTIVE');
    expect((r as { capabilities: string[] }).capabilities).toEqual(['read', 'write']);
    expect((r as { registered_at_iso: string }).registered_at_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((r as { last_heartbeat_iso: string }).last_heartbeat_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('status: unknown agent_id returns ok=false with error', () => {
    const r = toolGetProcess(ws, { agent_id: 'nobody' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/agent not registered/);
    expect((r as { error: string }).error).toContain('nobody');
  });

  it('status: lazily-computed DEAD status is reflected correctly', () => {
    toolRegisterProcess(ws, {
      agent_id: 'lazy-dead',
      agent_type: 'ghost',
      heartbeat_ttl: 1,
    });
    ws.db.prepare('UPDATE processes SET last_heartbeat = ? WHERE agent_id = ?').run(
      Date.now() - 10000,
      'lazy-dead',
    );

    const r = toolGetProcess(ws, { agent_id: 'lazy-dead' });
    expect(r.ok).toBe(true);
    expect((r as { status: string }).status).toBe('DEAD');
  });

  // --- integration flow ---

  it('full flow: register → heartbeat → list → status', async () => {
    // Register
    const reg = toolRegisterProcess(ws, {
      agent_id: 'flow-agent',
      agent_type: 'integration',
      capabilities: ['tool-use'],
    });
    expect(reg.ok).toBe(true);

    // Heartbeat
    await new Promise((r) => setTimeout(r, 5));
    const hb = toolHeartbeat(ws, { agent_id: 'flow-agent' });
    expect(hb.ok).toBe(true);

    // List
    const list = toolListProcesses(ws, {});
    expect(list.items.some((p) => p.agent_id === 'flow-agent')).toBe(true);

    // Status
    const status = toolGetProcess(ws, { agent_id: 'flow-agent' });
    expect(status.ok).toBe(true);
    expect((status as { status: string }).status).toBe('ACTIVE');
    expect((status as { capabilities: string[] }).capabilities).toEqual(['tool-use']);
  });
});
