import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace, type Workspace } from '../src/workspace.js';
import { startPresence } from '../src/presence.js';
import {
  getProcess,
  listProcesses,
} from '../../daemon/dist/storage/repositories/processes.js';

describe('presence — boot-time auto-register + heartbeat', () => {
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-presence-'));
    ws = openWorkspace({ cairnRoot });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  it('boot-time register inserts the SESSION_AGENT_ID with status ACTIVE', () => {
    expect(getProcess(ws.db, ws.agentId)).toBeNull();

    const handle = startPresence(ws, { installBeforeExitHandler: false });
    try {
      const row = getProcess(ws.db, ws.agentId);
      expect(row).not.toBeNull();
      expect(row!.agent_id).toBe(ws.agentId);
      expect(row!.agent_type).toBe('mcp-server');
      expect(row!.status).toBe('ACTIVE');
      expect(row!.capabilities).toEqual([]);
    } finally {
      handle.stop();
    }
  });

  it('register options override agent_type, capabilities, heartbeat_ttl', () => {
    const handle = startPresence(ws, {
      installBeforeExitHandler: false,
      agentType: 'custom-host',
      capabilities: ['scratch', 'rewind'],
      heartbeatTtlMs: 12_345,
    });
    try {
      const row = getProcess(ws.db, ws.agentId)!;
      expect(row.agent_type).toBe('custom-host');
      expect(row.capabilities).toEqual(['scratch', 'rewind']);
      expect(row.heartbeat_ttl).toBe(12_345);
    } finally {
      handle.stop();
    }
  });

  it('manual tick() advances last_heartbeat', () => {
    const handle = startPresence(ws, { installBeforeExitHandler: false });
    try {
      const before = getProcess(ws.db, ws.agentId)!.last_heartbeat;
      // sleep 5ms to ensure Date.now() advances on fast machines
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }
      handle.tick();
      const after = getProcess(ws.db, ws.agentId)!.last_heartbeat;
      expect(after).toBeGreaterThanOrEqual(before);
      // last_heartbeat must be at least 5ms newer
      expect(after - before).toBeGreaterThanOrEqual(5);
    } finally {
      handle.stop();
    }
  });

  it('setInterval fires heartbeat every intervalMs', () => {
    vi.useFakeTimers();
    try {
      const handle = startPresence(ws, {
        installBeforeExitHandler: false,
        intervalMs: 1000,
      });
      try {
        const t0 = getProcess(ws.db, ws.agentId)!.last_heartbeat;
        // Advance fake time + run pending timers
        vi.advanceTimersByTime(1000);
        const t1 = getProcess(ws.db, ws.agentId)!.last_heartbeat;
        expect(t1).toBeGreaterThan(t0);

        vi.advanceTimersByTime(1000);
        const t2 = getProcess(ws.db, ws.agentId)!.last_heartbeat;
        expect(t2).toBeGreaterThan(t1);
      } finally {
        handle.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() prevents further ticks', () => {
    vi.useFakeTimers();
    try {
      const handle = startPresence(ws, {
        installBeforeExitHandler: false,
        intervalMs: 500,
      });
      handle.stop();
      const t0 = getProcess(ws.db, ws.agentId)!.last_heartbeat;
      vi.advanceTimersByTime(2_000);
      const t1 = getProcess(ws.db, ws.agentId)!.last_heartbeat;
      expect(t1).toBe(t0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('boot-time register is idempotent across re-runs (same agent_id)', () => {
    const handle1 = startPresence(ws, { installBeforeExitHandler: false });
    handle1.stop();
    const handle2 = startPresence(ws, { installBeforeExitHandler: false });
    try {
      const all = listProcesses(ws.db, { statuses: ['ACTIVE', 'IDLE', 'DEAD'] });
      // Only one row for the same agent_id (INSERT OR REPLACE)
      const ours = all.filter(p => p.agent_id === ws.agentId);
      expect(ours).toHaveLength(1);
      expect(ours[0].status).toBe('ACTIVE');
    } finally {
      handle2.stop();
    }
  });

  it('does NOT install SIGINT/SIGTERM listeners (must not swallow Ctrl+C)', () => {
    const sigintBefore  = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    // Default options must not register signal handlers.
    const handle = startPresence(ws);
    try {
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    } finally {
      handle.stop();
    }

    // Even with installBeforeExitHandler: true, signal handlers must
    // remain untouched. presence relies on the unref'd interval +
    // Node's default signal handling for clean shutdown.
    const handle2 = startPresence(ws, { installBeforeExitHandler: true });
    try {
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    } finally {
      handle2.stop();
    }
  });

  it('beforeExit handler tears down without throwing and cancels ticks', () => {
    vi.useFakeTimers();
    try {
      const handle = startPresence(ws, {
        installBeforeExitHandler: true,
        intervalMs: 500,
      });
      // Manually emit beforeExit to invoke the handler we registered
      // with `process.once`.
      process.emit('beforeExit', 0);
      const t0 = getProcess(ws.db, ws.agentId)!.last_heartbeat;
      vi.advanceTimersByTime(2_000);
      const t1 = getProcess(ws.db, ws.agentId)!.last_heartbeat;
      expect(t1).toBe(t0); // stop() was called via beforeExit handler
      // Idempotent stop:
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('startPresence does not leak beforeExit listeners after stop()', () => {
    const before = process.listenerCount('beforeExit');
    const handle = startPresence(ws, { installBeforeExitHandler: true });
    expect(process.listenerCount('beforeExit')).toBe(before + 1);
    handle.stop();
    expect(process.listenerCount('beforeExit')).toBe(before);
  });
});
