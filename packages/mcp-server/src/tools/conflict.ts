import {
  listConflicts,
} from '../../../daemon/dist/storage/repositories/conflicts.js';
import type { Workspace } from '../workspace.js';

// ---------------------------------------------------------------------------
// Arg types
// ---------------------------------------------------------------------------

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
