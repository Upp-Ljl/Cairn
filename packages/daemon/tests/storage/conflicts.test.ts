import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpDb } from './helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import {
  recordConflict,
  getConflict,
  listConflicts,
  resolveConflict,
} from '../../src/storage/repositories/conflicts.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
beforeEach(() => {
  ({ db } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
});

describe('conflicts repo', () => {
  describe('recordConflict', () => {
    it('inserts a conflict with auto ULID id, detected_at=now, status=OPEN', () => {
      const before = Date.now();
      const c = recordConflict(db, {
        conflictType: 'FILE_OVERLAP',
        agentA: 'agent-a',
        paths: ['src/foo.ts', 'src/bar.ts'],
      });
      const after = Date.now();

      expect(c.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(c.conflict_type).toBe('FILE_OVERLAP');
      expect(c.agent_a).toBe('agent-a');
      expect(c.agent_b).toBeNull();
      expect(c.paths).toEqual(['src/foo.ts', 'src/bar.ts']);
      expect(c.summary).toBeNull();
      expect(c.status).toBe('OPEN');
      expect(c.resolved_at).toBeNull();
      expect(c.resolution).toBeNull();
      expect(c.detected_at).toBeGreaterThanOrEqual(before);
      expect(c.detected_at).toBeLessThanOrEqual(after);
    });

    it('accepts optional agentB and summary', () => {
      const c = recordConflict(db, {
        conflictType: 'STATE_CONFLICT',
        agentA: 'agent-a',
        agentB: 'agent-b',
        paths: ['src/main.ts'],
        summary: 'Rewind conflict between A and B',
      });
      expect(c.agent_b).toBe('agent-b');
      expect(c.summary).toBe('Rewind conflict between A and B');
    });

    it('handles all three conflict_type values', () => {
      const types = ['FILE_OVERLAP', 'STATE_CONFLICT', 'INTENT_BOUNDARY'] as const;
      for (const conflictType of types) {
        const c = recordConflict(db, { conflictType, agentA: 'a', paths: [] });
        expect(c.conflict_type).toBe(conflictType);
      }
    });
  });

  describe('getConflict', () => {
    it('returns conflict by id (round-trip)', () => {
      const original = recordConflict(db, {
        conflictType: 'INTENT_BOUNDARY',
        agentA: 'agent-a',
        paths: ['lib/utils.ts'],
      });
      const fetched = getConflict(db, original.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(original.id);
      expect(fetched!.conflict_type).toBe('INTENT_BOUNDARY');
      expect(fetched!.paths).toEqual(['lib/utils.ts']);
    });

    it('returns null for unknown id', () => {
      expect(getConflict(db, 'nonexistent')).toBeNull();
    });

    it('paths_json serialization round-trip: string[] in → string[] out', () => {
      const paths = ['a/b/c.ts', 'x/y/z.ts', 'src/index.ts'];
      const c = recordConflict(db, {
        conflictType: 'FILE_OVERLAP',
        agentA: 'a',
        paths,
      });
      const fetched = getConflict(db, c.id);
      expect(fetched!.paths).toEqual(paths);
      // Verify raw storage is JSON string (not array)
      const raw = db
        .prepare('SELECT paths_json FROM conflicts WHERE id = ?')
        .get(c.id) as { paths_json: string };
      expect(typeof raw.paths_json).toBe('string');
      expect(JSON.parse(raw.paths_json)).toEqual(paths);
    });

    it('handles empty paths array', () => {
      const c = recordConflict(db, {
        conflictType: 'FILE_OVERLAP',
        agentA: 'a',
        paths: [],
      });
      expect(getConflict(db, c.id)!.paths).toEqual([]);
    });
  });

  describe('listConflicts', () => {
    it('returns all conflicts ordered by detected_at DESC', () => {
      const c1 = recordConflict(db, {
        conflictType: 'FILE_OVERLAP',
        agentA: 'a',
        paths: ['file1.ts'],
      });
      const c2 = recordConflict(db, {
        conflictType: 'STATE_CONFLICT',
        agentA: 'a',
        paths: ['file2.ts'],
      });
      const list = listConflicts(db);
      // Most recent first (c2 was inserted after c1)
      expect(list[0]!.id).toBe(c2.id);
      expect(list[1]!.id).toBe(c1.id);
    });

    it('filters by since (detected_at >= since)', () => {
      // Insert a conflict with a known old timestamp directly
      const oldTime = Date.now() - 10000;
      db.prepare(`
        INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, paths_json, status)
        VALUES ('old-conflict', ?, 'FILE_OVERLAP', 'a', '[]', 'OPEN')
      `).run(oldTime);

      const recentConflict = recordConflict(db, {
        conflictType: 'FILE_OVERLAP',
        agentA: 'a',
        paths: [],
      });

      const list = listConflicts(db, { since: oldTime + 1 });
      expect(list.map((c) => c.id)).toContain(recentConflict.id);
      expect(list.map((c) => c.id)).not.toContain('old-conflict');
    });

    it('filters by status', () => {
      const c1 = recordConflict(db, {
        conflictType: 'FILE_OVERLAP',
        agentA: 'a',
        paths: [],
      });
      const c2 = recordConflict(db, {
        conflictType: 'STATE_CONFLICT',
        agentA: 'b',
        paths: [],
      });
      resolveConflict(db, c2.id, 'manual');

      const openList = listConflicts(db, { status: 'OPEN' });
      expect(openList.map((c) => c.id)).toEqual([c1.id]);

      const resolvedList = listConflicts(db, { status: 'RESOLVED' });
      expect(resolvedList.map((c) => c.id)).toEqual([c2.id]);
    });

    it('returns empty list when no conflicts exist', () => {
      expect(listConflicts(db)).toHaveLength(0);
    });

    it('can combine since + status filters', () => {
      const oldTime = Date.now() - 10000;
      db.prepare(`
        INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, paths_json, status)
        VALUES ('old-open', ?, 'FILE_OVERLAP', 'a', '[]', 'OPEN')
      `).run(oldTime);

      const recent = recordConflict(db, {
        conflictType: 'FILE_OVERLAP',
        agentA: 'a',
        paths: [],
      });

      const list = listConflicts(db, { since: oldTime + 1, status: 'OPEN' });
      expect(list.map((c) => c.id)).toContain(recent.id);
      expect(list.map((c) => c.id)).not.toContain('old-open');
    });
  });

  describe('resolveConflict', () => {
    it('transitions status from OPEN to RESOLVED with resolution text and resolved_at', () => {
      const c = recordConflict(db, {
        conflictType: 'FILE_OVERLAP',
        agentA: 'a',
        paths: ['src/main.ts'],
      });
      expect(c.status).toBe('OPEN');

      const before = Date.now();
      const resolved = resolveConflict(db, c.id, 'agent-a takes priority');
      const after = Date.now();

      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe('RESOLVED');
      expect(resolved!.resolution).toBe('agent-a takes priority');
      expect(resolved!.resolved_at).toBeGreaterThanOrEqual(before);
      expect(resolved!.resolved_at).toBeLessThanOrEqual(after);
    });

    it('returns null for unknown conflict id', () => {
      expect(resolveConflict(db, 'nonexistent', 'something')).toBeNull();
    });

    it('resolved conflict persists across getConflict', () => {
      const c = recordConflict(db, {
        conflictType: 'STATE_CONFLICT',
        agentA: 'a',
        paths: [],
      });
      resolveConflict(db, c.id, 'resolved by user');
      const fetched = getConflict(db, c.id);
      expect(fetched!.status).toBe('RESOLVED');
      expect(fetched!.resolution).toBe('resolved by user');
    });
  });
});
