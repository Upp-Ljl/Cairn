import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import {
  createDispatchRequest,
  getDispatchRequest,
  listDispatchRequests,
  confirmDispatchRequest,
  rejectDispatchRequest,
  failDispatchRequest,
} from '../../src/storage/repositories/dispatch-requests.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
beforeEach(() => {
  ({ db } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
});

describe('dispatch-requests repo', () => {
  describe('createDispatchRequest', () => {
    it('inserts with auto ULID, status=PENDING, created_at=now and returns { id }', () => {
      const before = Date.now();
      const result = createDispatchRequest(db, { nlIntent: 'add login feature' });
      const after = Date.now();

      expect(result.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

      const req = getDispatchRequest(db, result.id);
      expect(req).not.toBeNull();
      expect(req!.nl_intent).toBe('add login feature');
      expect(req!.status).toBe('PENDING');
      expect(req!.created_at).toBeGreaterThanOrEqual(before);
      expect(req!.created_at).toBeLessThanOrEqual(after);
      expect(req!.confirmed_at).toBeNull();
      expect(req!.parsed_intent).toBeNull();
      expect(req!.context_keys).toBeNull();
      expect(req!.generated_prompt).toBeNull();
      expect(req!.target_agent).toBeNull();
    });

    it('stores all optional fields when provided', () => {
      const parsedIntent = { action: 'add', feature: 'login', priority: 'high' };
      const contextKeys = ['session/abc/plan', 'subagent/x/result'];
      const { id } = createDispatchRequest(db, {
        nlIntent: 'add login',
        parsedIntent,
        contextKeys,
        generatedPrompt: 'Please implement login...',
        targetAgent: 'agent-b',
      });
      const req = getDispatchRequest(db, id);
      expect(req!.parsed_intent).toEqual(parsedIntent);
      expect(req!.context_keys).toEqual(contextKeys);
      expect(req!.generated_prompt).toBe('Please implement login...');
      expect(req!.target_agent).toBe('agent-b');
    });
  });

  describe('getDispatchRequest', () => {
    it('returns null for unknown id', () => {
      expect(getDispatchRequest(db, 'nonexistent')).toBeNull();
    });

    it('round-trips all fields correctly', () => {
      const { id } = createDispatchRequest(db, {
        nlIntent: 'refactor auth module',
        parsedIntent: { module: 'auth', action: 'refactor' },
        contextKeys: ['session/s1/notes'],
      });
      const req = getDispatchRequest(db, id);
      expect(req!.id).toBe(id);
      expect(req!.nl_intent).toBe('refactor auth module');
      expect(req!.parsed_intent).toEqual({ module: 'auth', action: 'refactor' });
      expect(req!.context_keys).toEqual(['session/s1/notes']);
    });
  });

  describe('listDispatchRequests', () => {
    it('returns all requests ordered by created_at DESC', () => {
      const { id: id1 } = createDispatchRequest(db, { nlIntent: 'first' });
      const { id: id2 } = createDispatchRequest(db, { nlIntent: 'second' });
      const list = listDispatchRequests(db);
      expect(list[0]!.id).toBe(id2);
      expect(list[1]!.id).toBe(id1);
    });

    it('returns empty list when no requests exist', () => {
      expect(listDispatchRequests(db)).toHaveLength(0);
    });

    it('filters by status', () => {
      const { id: pendingId } = createDispatchRequest(db, { nlIntent: 'pending task' });
      const { id: confirmedId } = createDispatchRequest(db, { nlIntent: 'confirmed task' });
      confirmDispatchRequest(db, confirmedId);

      const pending = listDispatchRequests(db, { status: 'PENDING' });
      expect(pending.map((r) => r.id)).toEqual([pendingId]);

      const confirmed = listDispatchRequests(db, { status: 'CONFIRMED' });
      expect(confirmed.map((r) => r.id)).toEqual([confirmedId]);
    });

    it('filters by since (created_at >= since)', () => {
      const oldTime = Date.now() - 10000;
      db.prepare(
        `INSERT INTO dispatch_requests (id, nl_intent, status, created_at)
         VALUES ('old-req', 'old intent', 'PENDING', ?)`
      ).run(oldTime);

      const { id: recentId } = createDispatchRequest(db, { nlIntent: 'recent task' });

      const list = listDispatchRequests(db, { since: oldTime + 1 });
      expect(list.map((r) => r.id)).toContain(recentId);
      expect(list.map((r) => r.id)).not.toContain('old-req');
    });

    it('respects limit', () => {
      createDispatchRequest(db, { nlIntent: 'task 1' });
      createDispatchRequest(db, { nlIntent: 'task 2' });
      createDispatchRequest(db, { nlIntent: 'task 3' });
      const list = listDispatchRequests(db, { limit: 2 });
      expect(list).toHaveLength(2);
    });

    it('can combine status + since + limit', () => {
      const oldTime = Date.now() - 10000;
      db.prepare(
        `INSERT INTO dispatch_requests (id, nl_intent, status, created_at)
         VALUES ('old-pending', 'old', 'PENDING', ?)`
      ).run(oldTime);
      const { id: recentId } = createDispatchRequest(db, { nlIntent: 'recent pending' });

      const list = listDispatchRequests(db, { status: 'PENDING', since: oldTime + 1, limit: 5 });
      expect(list.map((r) => r.id)).toContain(recentId);
      expect(list.map((r) => r.id)).not.toContain('old-pending');
    });
  });

  describe('confirmDispatchRequest', () => {
    it('transitions PENDING → CONFIRMED and sets confirmed_at', () => {
      const { id } = createDispatchRequest(db, { nlIntent: 'deploy to prod' });
      const before = Date.now();
      const confirmed = confirmDispatchRequest(db, id);
      const after = Date.now();

      expect(confirmed.status).toBe('CONFIRMED');
      expect(confirmed.confirmed_at).toBeGreaterThanOrEqual(before);
      expect(confirmed.confirmed_at).toBeLessThanOrEqual(after);
    });

    it('throws when trying to confirm an already CONFIRMED request', () => {
      const { id } = createDispatchRequest(db, { nlIntent: 'task' });
      confirmDispatchRequest(db, id);
      expect(() => confirmDispatchRequest(db, id)).toThrow(/cannot confirm: status is CONFIRMED/);
    });

    it('throws when trying to confirm a REJECTED request', () => {
      const { id } = createDispatchRequest(db, { nlIntent: 'task' });
      rejectDispatchRequest(db, id);
      expect(() => confirmDispatchRequest(db, id)).toThrow(/cannot confirm: status is REJECTED/);
    });

    it('throws when trying to confirm a FAILED request', () => {
      const { id } = createDispatchRequest(db, { nlIntent: 'task' });
      failDispatchRequest(db, id);
      expect(() => confirmDispatchRequest(db, id)).toThrow(/cannot confirm: status is FAILED/);
    });

    it('throws for unknown id', () => {
      expect(() => confirmDispatchRequest(db, 'no-such-id')).toThrow(/not found/);
    });
  });

  describe('rejectDispatchRequest', () => {
    it('transitions PENDING → REJECTED', () => {
      const { id } = createDispatchRequest(db, { nlIntent: 'risky task' });
      const rejected = rejectDispatchRequest(db, id);
      expect(rejected.status).toBe('REJECTED');
      expect(getDispatchRequest(db, id)!.status).toBe('REJECTED');
    });

    it('throws when rejecting an already CONFIRMED request', () => {
      const { id } = createDispatchRequest(db, { nlIntent: 'task' });
      confirmDispatchRequest(db, id);
      expect(() => rejectDispatchRequest(db, id)).toThrow(/cannot reject: status is CONFIRMED/);
    });

    it('throws when rejecting an already REJECTED request', () => {
      const { id } = createDispatchRequest(db, { nlIntent: 'task' });
      rejectDispatchRequest(db, id);
      expect(() => rejectDispatchRequest(db, id)).toThrow(/cannot reject: status is REJECTED/);
    });

    it('accepts optional reason parameter without error', () => {
      const { id } = createDispatchRequest(db, { nlIntent: 'task' });
      expect(() => rejectDispatchRequest(db, id, 'too risky')).not.toThrow();
    });
  });

  describe('failDispatchRequest', () => {
    it('transitions PENDING → FAILED', () => {
      const { id } = createDispatchRequest(db, { nlIntent: 'forward to agent' });
      const failed = failDispatchRequest(db, id);
      expect(failed.status).toBe('FAILED');
      expect(getDispatchRequest(db, id)!.status).toBe('FAILED');
    });

    it('throws when failing an already CONFIRMED request', () => {
      const { id } = createDispatchRequest(db, { nlIntent: 'task' });
      confirmDispatchRequest(db, id);
      expect(() => failDispatchRequest(db, id)).toThrow(/cannot fail: status is CONFIRMED/);
    });

    it('throws when failing an already FAILED request', () => {
      const { id } = createDispatchRequest(db, { nlIntent: 'task' });
      failDispatchRequest(db, id);
      expect(() => failDispatchRequest(db, id)).toThrow(/cannot fail: status is FAILED/);
    });
  });

  describe('JSON serialization', () => {
    it('parsedIntent: nested object round-trip', () => {
      const parsedIntent = {
        action: 'implement',
        feature: { name: 'auth', priority: 1 },
        tags: ['backend', 'security'],
      };
      const { id } = createDispatchRequest(db, { nlIntent: 'implement auth', parsedIntent });
      const req = getDispatchRequest(db, id);
      expect(req!.parsed_intent).toEqual(parsedIntent);
      // Verify raw storage is JSON string
      const raw = db
        .prepare('SELECT parsed_intent FROM dispatch_requests WHERE id = ?')
        .get(id) as { parsed_intent: string };
      expect(typeof raw.parsed_intent).toBe('string');
      expect(JSON.parse(raw.parsed_intent)).toEqual(parsedIntent);
    });

    it('contextKeys: string array round-trip', () => {
      const contextKeys = ['session/abc/plan', 'subagent/x/result', 'dispatch/req1/prompt'];
      const { id } = createDispatchRequest(db, { nlIntent: 'task', contextKeys });
      const req = getDispatchRequest(db, id);
      expect(req!.context_keys).toEqual(contextKeys);
      // Verify raw storage is JSON string
      const raw = db
        .prepare('SELECT context_keys FROM dispatch_requests WHERE id = ?')
        .get(id) as { context_keys: string };
      expect(typeof raw.context_keys).toBe('string');
      expect(JSON.parse(raw.context_keys)).toEqual(contextKeys);
    });

    it('handles empty contextKeys array', () => {
      const { id } = createDispatchRequest(db, { nlIntent: 'task', contextKeys: [] });
      expect(getDispatchRequest(db, id)!.context_keys).toEqual([]);
    });

    it('handles null parsedIntent and contextKeys', () => {
      const { id } = createDispatchRequest(db, {
        nlIntent: 'task',
        parsedIntent: null,
        contextKeys: null,
      });
      const req = getDispatchRequest(db, id);
      expect(req!.parsed_intent).toBeNull();
      expect(req!.context_keys).toBeNull();
    });
  });
});
