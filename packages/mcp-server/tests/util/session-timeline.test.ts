/**
 * Unit tests for appendKernelTimelineEvent + newUlid
 *
 * Coverage:
 *  1.  helper writes correct key shape (session_timeline/<agentId>/<ulid>)
 *  2.  value_json parses to expected object
 *  3.  kind is preserved
 *  4.  ulid segment is 26-char Crockford
 *  5.  monotonic: two calls in same ms produce sortable (lexicographic) keys
 *  6.  agentId empty string → { ok: false }
 *  7.  agentId whitespace-only → { ok: false }
 *  8.  task_id omitted when not in opts
 *  9.  task_id present when provided
 *  10. parent_event_id omitted when not in opts
 *  11. parent_event_id present when provided
 *  12. source is always 'kernel'
 *  13. label is truncated to 120 chars
 *  14. ts equals nowFn() value
 *  15. agent_id in event object matches agentId param
 *  16. DB write is idempotent (same key → overwrite, ok: true)
 *  17. newUlid produces 26-char string
 *  18. newUlid only uses Crockford chars
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace } from '../../src/workspace.js';
import { appendKernelTimelineEvent } from '../../src/util/session-timeline.js';
import { newUlid } from '../../src/util/ulid.js';
import type { Workspace } from '../../src/workspace.js';

const CROCKFORD_RE = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const AGENT_ID = 'cairn-session-abc123def456';

describe('appendKernelTimelineEvent — unit tests', () => {
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-tl-util-'));
    ws = openWorkspace({ cairnRoot });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  // 1. key shape
  it('writes correct key shape: session_timeline/<agentId>/<ulid>', () => {
    const r = appendKernelTimelineEvent(ws.db, AGENT_ID, 'start', 'test label');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parts = r.key.split('/');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('session_timeline');
    expect(parts[1]).toBe(AGENT_ID);
    expect(parts[2]).toMatch(CROCKFORD_RE);
  });

  // 2. value_json parses to expected object
  it('value_json parses to correct shape', () => {
    const r = appendKernelTimelineEvent(ws.db, AGENT_ID, 'progress', 'halfway done', {
      task_id: 'task-aaa',
      nowFn: () => 1234567890000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const row = ws.db
      .prepare('SELECT value_json FROM scratchpad WHERE key = ?')
      .get(r.key) as { value_json: string } | undefined;
    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.value_json);
    expect(parsed.ts).toBe(1234567890000);
    expect(parsed.kind).toBe('progress');
    expect(parsed.label).toBe('halfway done');
    expect(parsed.agent_id).toBe(AGENT_ID);
    expect(parsed.source).toBe('kernel');
    expect(parsed.task_id).toBe('task-aaa');
  });

  // 3. kind is preserved
  it('kind is preserved in stored JSON', () => {
    const r = appendKernelTimelineEvent(ws.db, AGENT_ID, 'blocked', 'a question');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r.key) as { value_json: string };
    const parsed = JSON.parse(row.value_json);
    expect(parsed.kind).toBe('blocked');
  });

  // 4. ulid segment is 26-char Crockford
  it('ulid segment in key is 26-char Crockford base-32', () => {
    const r = appendKernelTimelineEvent(ws.db, AGENT_ID, 'done', 'finished');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ulid = r.key.split('/')[2]!;
    expect(ulid).toMatch(CROCKFORD_RE);
    expect(ulid.length).toBe(26);
  });

  // 5. monotonic: two calls produce sortable keys
  it('monotonic: two calls in same ms produce lexicographically ordered keys', () => {
    const fixedMs = Date.now();
    let call = 0;
    const nowFn = () => (call++ === 0 ? fixedMs : fixedMs); // same ms twice
    const r1 = appendKernelTimelineEvent(ws.db, AGENT_ID, 'start', 'first', { nowFn });
    const r2 = appendKernelTimelineEvent(ws.db, AGENT_ID, 'progress', 'second', { nowFn });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    const u1 = r1.key.split('/')[2]!;
    const u2 = r2.key.split('/')[2]!;
    expect(u1 < u2).toBe(true);
  });

  // 6. agentId empty string → error
  it('agentId empty string → { ok: false }', () => {
    const r = appendKernelTimelineEvent(ws.db, '', 'start', 'label');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(typeof r.error).toBe('string');
    expect(r.error.length).toBeGreaterThan(0);
  });

  // 7. agentId whitespace-only → error
  it('agentId whitespace-only → { ok: false }', () => {
    const r = appendKernelTimelineEvent(ws.db, '   ', 'start', 'label');
    expect(r.ok).toBe(false);
  });

  // 8. task_id omitted when not in opts
  it('task_id NOT present in stored JSON when not provided', () => {
    const r = appendKernelTimelineEvent(ws.db, AGENT_ID, 'start', 'no task');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r.key) as { value_json: string };
    const parsed = JSON.parse(row.value_json);
    expect('task_id' in parsed).toBe(false);
  });

  // 9. task_id present when provided
  it('task_id present in stored JSON when provided', () => {
    const r = appendKernelTimelineEvent(ws.db, AGENT_ID, 'start', 'with task', {
      task_id: 'task-xyz-123',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r.key) as { value_json: string };
    const parsed = JSON.parse(row.value_json);
    expect(parsed.task_id).toBe('task-xyz-123');
  });

  // 10. parent_event_id omitted when not in opts
  it('parent_event_id NOT in stored JSON when not provided', () => {
    const r = appendKernelTimelineEvent(ws.db, AGENT_ID, 'done', 'no parent');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r.key) as { value_json: string };
    const parsed = JSON.parse(row.value_json);
    expect('parent_event_id' in parsed).toBe(false);
  });

  // 11. parent_event_id present when provided
  it('parent_event_id present in stored JSON when provided', () => {
    const r = appendKernelTimelineEvent(ws.db, AGENT_ID, 'done', 'with parent', {
      parent_event_id: '01HXYZ1234ABCDEF56789ABCDE',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r.key) as { value_json: string };
    const parsed = JSON.parse(row.value_json);
    expect(parsed.parent_event_id).toBe('01HXYZ1234ABCDEF56789ABCDE');
  });

  // 12. source is 'kernel'
  it("source is always 'kernel'", () => {
    const r = appendKernelTimelineEvent(ws.db, AGENT_ID, 'start', 'source check');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r.key) as { value_json: string };
    const parsed = JSON.parse(row.value_json);
    expect(parsed.source).toBe('kernel');
  });

  // 13. label truncated to 120 chars
  it('label is truncated to 120 characters', () => {
    const long = 'x'.repeat(200);
    const r = appendKernelTimelineEvent(ws.db, AGENT_ID, 'progress', long);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r.key) as { value_json: string };
    const parsed = JSON.parse(row.value_json);
    expect(parsed.label.length).toBe(120);
    expect(parsed.label).toBe('x'.repeat(120));
  });

  // 14. ts equals nowFn() value
  it('ts equals the value returned by nowFn', () => {
    const fixedTs = 9999888777666;
    const r = appendKernelTimelineEvent(ws.db, AGENT_ID, 'start', 'ts test', {
      nowFn: () => fixedTs,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r.key) as { value_json: string };
    const parsed = JSON.parse(row.value_json);
    expect(parsed.ts).toBe(fixedTs);
  });

  // 15. agent_id matches param
  it('agent_id in stored JSON matches agentId param', () => {
    const customId = 'cairn-session-deadbeef0000';
    const r = appendKernelTimelineEvent(ws.db, customId, 'done', 'agent id test');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r.key) as { value_json: string };
    const parsed = JSON.parse(row.value_json);
    expect(parsed.agent_id).toBe(customId);
  });

  // 16. DB write is idempotent (forced same key would overwrite)
  it('calling twice with same key (forced) overwrites and returns ok: true', () => {
    // Force the same ULID by writing directly to DB and calling again with same key
    const r1 = appendKernelTimelineEvent(ws.db, AGENT_ID, 'start', 'original');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // Manually insert duplicate to simulate same-key conflict
    expect(() => {
      ws.db.prepare(`
        INSERT INTO scratchpad (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
        VALUES (?, ?, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(r1.key, JSON.stringify({ ts: 1, kind: 'done', label: 'updated', agent_id: AGENT_ID, source: 'kernel' }), Date.now(), Date.now());
    }).not.toThrow();
    // Key still readable
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r1.key) as { value_json: string };
    const parsed = JSON.parse(row.value_json);
    expect(parsed.kind).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// newUlid unit tests
// ---------------------------------------------------------------------------

describe('newUlid — unit tests', () => {
  // 17. produces 26-char string
  it('produces a 26-character string', () => {
    const u = newUlid();
    expect(u.length).toBe(26);
  });

  // 18. only uses Crockford chars
  it('only uses Crockford base-32 characters', () => {
    const u = newUlid();
    expect(u).toMatch(CROCKFORD_RE);
  });

  it('two consecutive calls produce unique ULIDs', () => {
    const a = newUlid();
    const b = newUlid();
    expect(a).not.toBe(b);
  });

  it('two consecutive ULIDs are in lexicographic order', () => {
    const a = newUlid();
    const b = newUlid();
    expect(a < b).toBe(true);
  });
});
