import {
  putScratch, getScratch,
} from '../../../daemon/dist/storage/repositories/scratchpad.js';
import type { Workspace } from '../workspace.js';

export interface SetSessionNameArgs {
  /** Human-readable name for this session (≤ 50 chars recommended). */
  name: string;
  /**
   * Agent id to name. Defaults to SESSION_AGENT_ID env (i.e. the
   * current mcp-server process's session id). Override only when
   * naming a different session from the same process (rare).
   */
  agent_id?: string;
}

/**
 * Scratchpad key namespace for session names.
 * Value shape: { name: string, set_at: number, set_by: 'agent' | 'user' }
 */
export const SESSION_NAME_KEY_PREFIX = 'session_name/';

export function sessionNameKey(agentId: string): string {
  return SESSION_NAME_KEY_PREFIX + agentId;
}

/**
 * cairn.session.name — let an agent declare a human-readable label
 * for its current session. Written to scratchpad under
 * `session_name/<agent_id>` so the desktop-shell panel can surface it
 * as the session's display_name instead of a hex-truncated id.
 *
 * Call this once at session start with a ≤ 50-char title that
 * describes what this session is doing, e.g.:
 *   "ship Phase 8 §8 Rule C"
 *   "refactor scratchpad layer — W5 follow-up"
 */
export function toolSetSessionName(ws: Workspace, args: SetSessionNameArgs) {
  const agentId = args.agent_id ?? process.env['CAIRN_SESSION_AGENT_ID'] ?? ws.agentId;
  if (!agentId) {
    throw new Error('cairn.session.name: cannot determine agent_id — pass agent_id or set CAIRN_SESSION_AGENT_ID');
  }

  const name = (args.name ?? '').trim();
  if (!name) {
    throw new Error('cairn.session.name: name must be a non-empty string');
  }

  const key = sessionNameKey(agentId);
  const value = {
    name,
    set_at: Date.now(),
    set_by: 'agent' as const,
  };

  putScratch(ws.db, ws.blobRoot, { key, value });

  return {
    ok: true,
    agent_id: agentId,
    key,
    name,
  };
}

/**
 * Read back a session name from scratchpad. Returns null when not set.
 * Used by the desktop-shell's deriveDisplayName helper.
 */
export function toolGetSessionName(ws: Workspace, agentId: string): string | null {
  const key = sessionNameKey(agentId);
  const raw = getScratch(ws.db, key);
  if (!raw || typeof raw !== 'object') return null;
  const val = raw as Record<string, unknown>;
  return typeof val['name'] === 'string' ? val['name'] : null;
}
