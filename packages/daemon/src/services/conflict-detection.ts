import type { Database as DB } from 'better-sqlite3';
import { listProcesses } from '../storage/repositories/processes.js';
import { recordConflict } from '../storage/repositories/conflicts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConflictDetectionInput {
  /** The agent initiating the checkpoint. */
  agentId: string;
  /** File paths this checkpoint covers (asserted by the caller). */
  paths: string[];
  /**
   * Look-back window in minutes: only checkpoints created within
   * now() - windowMinutes*60_000 are considered "in-flight".
   * Defaults to 5.
   */
  windowMinutes?: number;
}

export interface ConflictDetectionResult {
  /** Row ID written to the conflicts table, or null when no conflict. */
  conflictId: string | null;
  /** Agent IDs whose in-flight checkpoints overlapped with our paths. */
  conflictedWith: string[];
  /** The paths that triggered the conflict (= input.paths when conflict exists). */
  overlappingPaths: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect FILE_OVERLAP conflicts before a checkpoint is committed.
 *
 * Design notes (v1 — checkpoints table has no paths_json column):
 *
 *   The checkpoints table stores (id, task_id, label, git_head, snapshot_dir,
 *   snapshot_status, size_bytes, created_at, ready_at).  There is no paths_json
 *   column, so we cannot compute a precise file-path intersection from stored
 *   checkpoint rows.
 *
 *   V1 heuristic:
 *     A conflict is declared when ALL of the following hold:
 *       1. `input.paths` is non-empty (caller has something at stake).
 *       2. At least one ACTIVE or IDLE *peer* agent (agent_id ≠ input.agentId)
 *          is registered in the process bus.
 *       3. That peer agent has at least one checkpoint row within the time
 *          window (task_id = peer.agent_id, created_at >= cutoff).
 *          This uses task_id as a proxy for agent ownership (convention: agents
 *          should set task_id = their agent_id when creating checkpoints so that
 *          the process bus can correlate activity).
 *
 *   When a conflict is detected, `overlappingPaths` is set to `input.paths`
 *   (conservative: the caller asserts ownership of those paths).
 *
 *   Future migration: once a paths_json column is added to checkpoints, replace
 *   the heuristic with a precise set-intersection query.
 */
export function detectConflict(db: DB, input: ConflictDetectionInput): ConflictDetectionResult {
  const { agentId, paths, windowMinutes = 5 } = input;

  if (paths.length === 0) {
    return { conflictId: null, conflictedWith: [], overlappingPaths: [] };
  }

  const cutoff = Date.now() - windowMinutes * 60 * 1000;

  // Step 1: collect peer agents (ACTIVE or IDLE, not self).
  const peers = listProcesses(db, { statuses: ['ACTIVE', 'IDLE'] }).filter(
    (p) => p.agent_id !== agentId,
  );

  if (peers.length === 0) {
    return { conflictId: null, conflictedWith: [], overlappingPaths: [] };
  }

  // Step 2: find peers that have a recent checkpoint (task_id = peer.agent_id).
  const conflictingAgents: string[] = [];
  for (const peer of peers) {
    const row = db
      .prepare(
        `SELECT id FROM checkpoints
         WHERE task_id = ? AND created_at >= ?
         LIMIT 1`,
      )
      .get(peer.agent_id, cutoff) as { id: string } | undefined;
    if (row !== undefined) {
      conflictingAgents.push(peer.agent_id);
    }
  }

  if (conflictingAgents.length === 0) {
    return { conflictId: null, conflictedWith: [], overlappingPaths: [] };
  }

  // Step 3: record one conflict row per conflicting peer, return the first id.
  let firstConflictId: string | null = null;
  for (const peerAgentId of conflictingAgents) {
    const conflict = recordConflict(db, {
      conflictType: 'FILE_OVERLAP',
      agentA: agentId,
      agentB: peerAgentId,
      paths,
      summary: `Agent ${agentId} checkpoint overlaps in-flight activity of ${peerAgentId}`,
    });
    if (firstConflictId === null) {
      firstConflictId = conflict.id;
    }
  }

  return {
    conflictId: firstConflictId,
    conflictedWith: conflictingAgents,
    overlappingPaths: paths,
  };
}
