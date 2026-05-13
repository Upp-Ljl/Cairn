/**
 * Unit tests for cairn.session.name (A3 session-naming)
 *
 * Cases:
 *  1. write name → read back via getScratch
 *  2. agent_id defaults to CAIRN_SESSION_AGENT_ID env
 *  3. overwrite: second write replaces the first name
 *  4. explicit agent_id overrides env
 *  5. empty name → throws
 *  6. key format: session_name/<agent_id>
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace, type Workspace } from '../../src/workspace.js';
import { toolSetSessionName, sessionNameKey, SESSION_NAME_KEY_PREFIX } from '../../src/tools/session-name.js';
import { getScratch } from '../../../daemon/dist/storage/repositories/scratchpad.js';

describe('cairn.session.name', () => {
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-session-name-'));
    ws = openWorkspace({ cairnRoot });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // 1. write name → read back via getScratch
  // ---------------------------------------------------------------------------
  it('writes name to scratchpad and returns ok', () => {
    const r = toolSetSessionName(ws, { name: 'ship Phase 8 §8 Rule C' });
    expect(r.ok).toBe(true);
    expect(r.name).toBe('ship Phase 8 §8 Rule C');
    expect(r.key).toBe(SESSION_NAME_KEY_PREFIX + r.agent_id);

    const raw = getScratch(ws.db, r.key);
    expect(raw).not.toBeNull();
    const val = raw as Record<string, unknown>;
    expect(val['name']).toBe('ship Phase 8 §8 Rule C');
    expect(val['set_by']).toBe('agent');
    expect(typeof val['set_at']).toBe('number');
  });

  // ---------------------------------------------------------------------------
  // 2. agent_id defaults to CAIRN_SESSION_AGENT_ID env
  // ---------------------------------------------------------------------------
  it('defaults agent_id to CAIRN_SESSION_AGENT_ID env var', () => {
    // openWorkspace sets CAIRN_SESSION_AGENT_ID automatically
    const envId = process.env['CAIRN_SESSION_AGENT_ID'];
    expect(envId).toBeTruthy();

    const r = toolSetSessionName(ws, { name: 'env-default test' });
    expect(r.agent_id).toBe(envId);
  });

  // ---------------------------------------------------------------------------
  // 3. overwrite: second write replaces the first name
  // ---------------------------------------------------------------------------
  it('overwrites existing name on second call', () => {
    toolSetSessionName(ws, { name: 'first name' });
    const r2 = toolSetSessionName(ws, { name: 'updated name' });
    expect(r2.ok).toBe(true);
    expect(r2.name).toBe('updated name');

    const raw = getScratch(ws.db, r2.key) as Record<string, unknown>;
    expect(raw['name']).toBe('updated name');
  });

  // ---------------------------------------------------------------------------
  // 4. explicit agent_id overrides env
  // ---------------------------------------------------------------------------
  it('explicit agent_id is used when provided', () => {
    const customId = 'cairn-session-custom001';
    const r = toolSetSessionName(ws, { name: 'custom agent', agent_id: customId });
    expect(r.agent_id).toBe(customId);
    expect(r.key).toBe(SESSION_NAME_KEY_PREFIX + customId);

    const raw = getScratch(ws.db, r.key) as Record<string, unknown>;
    expect(raw['name']).toBe('custom agent');
  });

  // ---------------------------------------------------------------------------
  // 5. empty name → throws
  // ---------------------------------------------------------------------------
  it('throws when name is empty', () => {
    expect(() => toolSetSessionName(ws, { name: '' })).toThrow(
      'cairn.session.name: name must be a non-empty string'
    );
  });

  // ---------------------------------------------------------------------------
  // 6. key format: session_name/<agent_id>
  // ---------------------------------------------------------------------------
  it('sessionNameKey helper returns correct key format', () => {
    expect(sessionNameKey('cairn-session-abc123456789')).toBe(
      'session_name/cairn-session-abc123456789'
    );
    expect(SESSION_NAME_KEY_PREFIX).toBe('session_name/');
  });
});
