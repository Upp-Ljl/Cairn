import { getCheckpointById } from '../../../daemon/dist/storage/repositories/checkpoints.js';
import {
  gitStashRestore,
  gitStashAffectedFiles,
  gitHeadCleanRestore,
  gitHeadCleanAffectedFiles,
} from '../../../daemon/dist/storage/snapshots/git-stash.js';
import type { Workspace } from '../workspace.js';

export interface RewindArgs { checkpoint_id: string }

const NO_HEAD_ERROR =
  'This checkpoint has no git_head recorded (likely created outside a git repo). ' +
  'Cannot restore: there is no reference state to roll back to.';

function extractStashSha(label: string | null): string | null {
  if (!label) return null;
  const m = label.match(/::stash:([0-9a-f]{40})/);
  return m ? m[1]! : null;
}

export function toolRewindPreview(ws: Workspace, args: RewindArgs) {
  const c = getCheckpointById(ws.db, args.checkpoint_id);
  if (!c) return { error: 'checkpoint not found' };

  // Path 1: stash backend (working tree was dirty at checkpoint time)
  const sha = extractStashSha(c.label);
  if (sha) {
    return {
      checkpoint_id: c.id,
      mode: 'stash',
      files: gitStashAffectedFiles(ws.cwd, sha),
      git_head_at_checkpoint: c.git_head,
    };
  }

  // Path 2: clean-tree fallback (no stash, restore via git_head)
  if (c.git_head) {
    try {
      return {
        checkpoint_id: c.id,
        mode: 'git_head_clean',
        files: gitHeadCleanAffectedFiles(ws.cwd, c.git_head),
        git_head_at_checkpoint: c.git_head,
      };
    } catch (e) {
      return { error: (e as Error).message, files: [] };
    }
  }

  return { error: NO_HEAD_ERROR, files: [] };
}

export function toolRewindTo(ws: Workspace, args: RewindArgs) {
  const c = getCheckpointById(ws.db, args.checkpoint_id);
  if (!c) return { ok: false, error: 'checkpoint not found' };

  // Path 1: stash backend
  const sha = extractStashSha(c.label);
  if (sha) {
    gitStashRestore(ws.cwd, sha);
    return {
      ok: true,
      mode: 'stash',
      restored_files: gitStashAffectedFiles(ws.cwd, sha),
    };
  }

  // Path 2: clean-tree fallback via git_head
  if (c.git_head) {
    try {
      const restored = gitHeadCleanRestore(ws.cwd, c.git_head);
      return { ok: true, mode: 'git_head_clean', restored_files: restored };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  return { ok: false, error: NO_HEAD_ERROR };
}
