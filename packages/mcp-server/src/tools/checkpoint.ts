import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  createPendingCheckpoint,
  markCheckpointReady,
  listCheckpoints,
} from '../../../daemon/dist/storage/repositories/checkpoints.js';
import { gitStashSnapshot } from '../../../daemon/dist/storage/snapshots/git-stash.js';
import type { Workspace } from '../workspace.js';

export interface CreateCheckpointArgs { label?: string }

export function toolCreateCheckpoint(ws: Workspace, args: CreateCheckpointArgs) {
  // Phase 1: insert PENDING row
  const ckpt = createPendingCheckpoint(ws.db, {
    label: args.label ?? null,
    snapshot_dir: join(ws.cairnRoot, 'snapshots', '.git-stash'),
  });

  // Phase 2 (out of tx): capture git state
  let stashSha: string | null = null;
  let gitHead: string | null = null;
  try {
    stashSha = gitStashSnapshot(ws.cwd);
  } catch {
    stashSha = null; // not a git repo or git command failed
  }
  try {
    gitHead = execSync('git rev-parse HEAD', { cwd: ws.cwd, encoding: 'utf8' }).trim();
  } catch {
    gitHead = null;
  }

  // Pack stash SHA into label (W1 technical debt — P2 will add backend_data column)
  const enrichedLabel = `${args.label ?? ''}::stash:${stashSha ?? 'clean'}`;
  ws.db.prepare('UPDATE checkpoints SET label = ? WHERE id = ?').run(enrichedLabel, ckpt.id);

  // Phase 3: mark READY
  markCheckpointReady(ws.db, ckpt.id, { size_bytes: 0, git_head: gitHead });

  const result: { id: string; git_head: string | null; stash_sha: string | null; warning?: string } = {
    id: ckpt.id,
    git_head: gitHead,
    stash_sha: stashSha,
  };
  if (stashSha === null) {
    result.warning =
      'Working tree was clean — this checkpoint records HEAD only and cannot restore any future uncommitted edits. ' +
      'To capture future edits, make changes first then create the checkpoint.';
  }
  return result;
}

export function toolListCheckpoints(ws: Workspace) {
  return {
    items: listCheckpoints(ws.db, 'READY').map((c) => ({
      id: c.id,
      label: c.label,
      git_head: c.git_head,
      created_at: c.created_at,
    })),
  };
}
