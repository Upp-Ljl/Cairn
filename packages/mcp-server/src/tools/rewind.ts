import { getCheckpointById } from '../../../daemon/dist/storage/repositories/checkpoints.js';
import {
  gitStashRestore, gitStashAffectedFiles,
} from '../../../daemon/dist/storage/snapshots/git-stash.js';
import type { Workspace } from '../workspace.js';

export interface RewindArgs { checkpoint_id: string }

function extractStashSha(label: string | null): string | null {
  if (!label) return null;
  const m = label.match(/::stash:([0-9a-f]{40})/);
  return m ? m[1]! : null;
}

export function toolRewindPreview(ws: Workspace, args: RewindArgs) {
  const c = getCheckpointById(ws.db, args.checkpoint_id);
  if (!c) return { error: 'checkpoint not found' };
  const sha = extractStashSha(c.label);
  if (!sha) return { error: 'no stash backend recorded (clean checkpoint?)', files: [] };
  const files = gitStashAffectedFiles(ws.cwd, sha);
  return {
    checkpoint_id: c.id,
    files,
    git_head_at_checkpoint: c.git_head,
  };
}

export function toolRewindTo(ws: Workspace, args: RewindArgs) {
  const c = getCheckpointById(ws.db, args.checkpoint_id);
  if (!c) return { ok: false, error: 'checkpoint not found' };
  const sha = extractStashSha(c.label);
  if (!sha) return { ok: false, error: 'no stash backend recorded' };
  gitStashRestore(ws.cwd, sha);
  return { ok: true, restored_files: gitStashAffectedFiles(ws.cwd, sha) };
}
