import {
  listConflicts,
  getConflict,
  resolveConflict,
} from '../../../daemon/dist/storage/repositories/conflicts.js';
import type { Workspace } from '../workspace.js';

// ---------------------------------------------------------------------------
// Arg types
// ---------------------------------------------------------------------------

export interface ResolveConflictArgs {
  conflict_id: string;
  /** Optional human-written explanation. */
  resolution?: string;
}

export interface ListConflictsArgs {
  /**
   * ISO 8601 timestamp string. When supplied, only conflicts detected at or
   * after this time are returned. Defaults to 24 hours ago.
   */
  since?: string;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export function toolResolveConflict(ws: Workspace, args: ResolveConflictArgs) {
  if (!args.conflict_id) {
    return { ok: false, error: 'conflict_id is required' };
  }

  const existing = getConflict(ws.db, args.conflict_id);
  if (!existing) {
    return { ok: false, error: `conflict not found: ${args.conflict_id}` };
  }
  if (existing.status === 'RESOLVED' || existing.status === 'IGNORED') {
    return { ok: false, error: `cannot resolve: status is ${existing.status}`, current_status: existing.status };
  }

  const resolutionText = args.resolution ?? 'resolved via cairn.conflict.resolve';
  const updated = resolveConflict(ws.db, args.conflict_id, resolutionText);

  return {
    ok: true,
    conflict_id: args.conflict_id,
    status: 'RESOLVED',
    resolved_at_iso: updated?.resolved_at != null ? new Date(updated.resolved_at).toISOString() : new Date().toISOString(),
  };
}

export function toolListConflicts(ws: Workspace, args: ListConflictsArgs = {}) {
  // Default: last 24 hours
  const defaultSince = Date.now() - 24 * 60 * 60 * 1000;
  const sinceMs = args.since != null ? new Date(args.since).getTime() : defaultSince;

  const conflicts = listConflicts(ws.db, { since: sinceMs });

  return {
    items: conflicts.map((c) => ({
      id: c.id,
      type: c.conflict_type,
      agent_a: c.agent_a,
      agent_b: c.agent_b,
      paths: c.paths,
      summary: c.summary,
      status: c.status,
      detected_at: c.detected_at,
      detected_at_iso: new Date(c.detected_at).toISOString(),
      resolved_at: c.resolved_at,
      resolved_at_iso: c.resolved_at != null ? new Date(c.resolved_at).toISOString() : null,
    })),
    since_iso: new Date(sinceMs).toISOString(),
    count: conflicts.length,
  };
}
