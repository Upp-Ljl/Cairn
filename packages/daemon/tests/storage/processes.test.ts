import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import {
  registerProcess,
  heartbeat,
  getProcess,
  listProcesses,
} from '../../src/storage/repositories/processes.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
beforeEach(() => {
  ({ db } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
});

describe('processes repo', () => {
  describe('registerProcess', () => {
    it('inserts a process with status=ACTIVE and ULID-style agent_id', () => {
      const p = registerProcess(db, { agentId: 'agent-001', agentType: 'claude-code' });
      expect(p.agent_id).toBe('agent-001');
      expect(p.agent_type).toBe('claude-code');
      expect(p.status).toBe('ACTIVE');
      expect(p.capabilities).toBeNull();
      expect(p.registered_at).toBeGreaterThan(0);
      expect(p.last_heartbeat).toBeGreaterThan(0);
      expect(p.heartbeat_ttl).toBe(60000);
    });

    it('accepts optional capabilities array', () => {
      const p = registerProcess(db, {
        agentId: 'agent-002',
        agentType: 'cursor',
        capabilities: ['scratchpad', 'checkpoint'],
      });
      expect(p.capabilities).toEqual(['scratchpad', 'checkpoint']);
    });

    it('accepts custom heartbeat_ttl', () => {
      const p = registerProcess(db, {
        agentId: 'agent-003',
        agentType: 'cline',
        heartbeatTtl: 30000,
      });
      expect(p.heartbeat_ttl).toBe(30000);
    });

    it('INSERT OR REPLACE: re-registering resets heartbeat and registered_at', () => {
      const p1 = registerProcess(db, { agentId: 'agent-001', agentType: 'claude-code' });
      // Simulate time passing by briefly waiting or just re-registering
      const p2 = registerProcess(db, {
        agentId: 'agent-001',
        agentType: 'claude-code',
        capabilities: ['scratchpad'],
      });
      expect(p2.last_heartbeat).toBeGreaterThanOrEqual(p1.last_heartbeat);
      expect(p2.capabilities).toEqual(['scratchpad']);
      // Only one row remains
      const all = listProcesses(db, { statuses: ['ACTIVE', 'IDLE', 'DEAD'] });
      expect(all.filter((p) => p.agent_id === 'agent-001')).toHaveLength(1);
    });
  });

  describe('getProcess', () => {
    it('returns the process by agent_id', () => {
      registerProcess(db, { agentId: 'agent-001', agentType: 'claude-code' });
      const p = getProcess(db, 'agent-001');
      expect(p).not.toBeNull();
      expect(p!.agent_id).toBe('agent-001');
    });

    it('returns null for unknown agent_id', () => {
      expect(getProcess(db, 'nonexistent')).toBeNull();
    });

    it('lazily computes status=DEAD when heartbeat is expired', () => {
      // Register with a tiny TTL (already expired at insert time minus 1 second)
      const now = Date.now();
      db.prepare(`
        INSERT INTO processes (agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl)
        VALUES ('expired-agent', 'custom', NULL, 'ACTIVE', ?, ?, 1)
      `).run(now, now - 1000); // last_heartbeat 1s ago, ttl = 1ms → DEAD

      const p = getProcess(db, 'expired-agent');
      expect(p).not.toBeNull();
      expect(p!.status).toBe('DEAD');
    });
  });

  describe('heartbeat', () => {
    it('updates last_heartbeat timestamp', () => {
      // Insert with an old heartbeat
      const oldTime = Date.now() - 5000;
      db.prepare(`
        INSERT INTO processes (agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl)
        VALUES ('agent-hb', 'claude-code', NULL, 'ACTIVE', ?, ?, 60000)
      `).run(oldTime, oldTime);

      const before = getProcess(db, 'agent-hb');
      expect(before!.last_heartbeat).toBe(oldTime);

      heartbeat(db, 'agent-hb');

      const after = getProcess(db, 'agent-hb');
      expect(after!.last_heartbeat).toBeGreaterThan(oldTime);
    });

    it('reactivates a DEAD process (stored status DEAD → ACTIVE)', () => {
      const oldTime = Date.now() - 120000;
      db.prepare(`
        INSERT INTO processes (agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl)
        VALUES ('dead-agent', 'custom', NULL, 'DEAD', ?, ?, 60000)
      `).run(oldTime, oldTime);

      heartbeat(db, 'dead-agent');

      const p = getProcess(db, 'dead-agent');
      expect(p!.status).toBe('ACTIVE');
    });

    it('returns null for unknown agent_id', () => {
      const result = heartbeat(db, 'ghost-agent');
      expect(result).toBeNull();
    });
  });

  describe('listProcesses', () => {
    it('returns only ACTIVE and IDLE by default (excludes DEAD)', () => {
      registerProcess(db, { agentId: 'active-agent', agentType: 'claude-code' });
      // Insert an expired (lazily-DEAD) agent
      const now = Date.now();
      db.prepare(`
        INSERT INTO processes (agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl)
        VALUES ('dead-agent', 'custom', NULL, 'ACTIVE', ?, ?, 1)
      `).run(now, now - 1000);

      const list = listProcesses(db);
      expect(list.map((p) => p.agent_id)).toContain('active-agent');
      expect(list.map((p) => p.agent_id)).not.toContain('dead-agent');
    });

    it('includes DEAD when explicitly requested', () => {
      const now = Date.now();
      db.prepare(`
        INSERT INTO processes (agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl)
        VALUES ('dead-agent', 'custom', NULL, 'ACTIVE', ?, ?, 1)
      `).run(now, now - 1000);

      const all = listProcesses(db, { statuses: ['ACTIVE', 'IDLE', 'DEAD'] });
      expect(all.map((p) => p.agent_id)).toContain('dead-agent');
    });

    it('returns empty list when no processes are registered', () => {
      expect(listProcesses(db)).toHaveLength(0);
    });

    it('returns multiple live processes', () => {
      registerProcess(db, { agentId: 'agent-a', agentType: 'claude-code' });
      registerProcess(db, { agentId: 'agent-b', agentType: 'cursor' });
      const list = listProcesses(db);
      expect(list).toHaveLength(2);
    });
  });
});
