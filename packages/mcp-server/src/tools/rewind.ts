import { getCheckpointById } from '../../../daemon/dist/storage/repositories/checkpoints.js';
import {
  gitStashRestore,
  gitStashRestoreFiltered,
  gitStashAffectedFiles,
  gitHeadCleanRestore,
  gitHeadCleanRestoreFiltered,
  gitHeadCleanAffectedFiles,
} from '../../../daemon/dist/storage/snapshots/git-stash.js';
import { tryAutoCheckpoint } from './_auto-checkpoint.js';
import type { Workspace } from '../workspace.js';

export interface RewindArgs {
  checkpoint_id: string;
  /**
   * Optional list of paths (repo-relative) to scope the rewind to.
   * If omitted, rewind affects every file captured by the checkpoint.
   * If supplied, only the listed paths are restored; others are left
   * exactly as they are now. Paths not actually captured by this
   * checkpoint are reported in `skipped`, not as errors.
   */
  paths?: string[];
  /**
   * Skip the implicit pre-rewind checkpoint. Default: false (auto-checkpoint
   * runs, capturing the current working-tree state so the user can undo
   * the rewind itself if it turns out to be a mistake — GitButler-style
   * RestoreFromSnapshot semantics).
   */
  skip_auto_checkpoint?: boolean;
  /**
   * Task tag propagated to the implicit auto-checkpoint (the pre-rewind
   * snapshot that lets the user undo the rewind). Lets the undo-undo
   * node show up under the same task slice as the original work.
   */
  task_id?: string;
}

const NO_HEAD_ERROR =
  'This checkpoint has no git_head recorded (likely created outside a git repo). ' +
  'Cannot restore: there is no reference state to roll back to.';

function extractStashSha(label: string | null): string | null {
  if (!label) return null;
  const m = label.match(/::stash:([0-9a-f]{40})/);
  return m ? m[1]! : null;
}

function validatePaths(paths: string[] | undefined): string[] | null {
  if (paths === undefined) return null;
  if (!Array.isArray(paths)) {
    throw new Error('paths must be an array of strings');
  }
  if (paths.length === 0) {
    throw new Error(
      'paths array is empty — omit the field entirely to rewind every captured file',
    );
  }
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error('every entry in paths must be a non-empty string');
    }
  }
  return paths;
}

export function toolRewindPreview(ws: Workspace, args: RewindArgs) {
  const c = getCheckpointById(ws.db, args.checkpoint_id);
  if (!c) return { error: 'checkpoint not found' };

  let pathsFilter: string[] | null;
  try {
    pathsFilter = validatePaths(args.paths);
  } catch (e) {
    return { error: (e as Error).message };
  }

  const sha = extractStashSha(c.label);

  // Path 1: stash backend (working tree was dirty at checkpoint time)
  if (sha) {
    const allFiles = gitStashAffectedFiles(ws.cwd, sha);
    if (pathsFilter === null) {
      return {
        checkpoint_id: c.id,
        mode: 'stash',
        files: allFiles,
        git_head_at_checkpoint: c.git_head,
      };
    }
    const captured = new Set(allFiles);
    const requested: string[] = [];
    const skipped: string[] = [];
    for (const p of pathsFilter) {
      (captured.has(p) ? requested : skipped).push(p);
    }
    return {
      checkpoint_id: c.id,
      mode: 'stash',
      files: requested,
      skipped,
      git_head_at_checkpoint: c.git_head,
    };
  }

  // Path 2: clean-tree fallback (no stash, restore via git_head)
  if (c.git_head) {
    try {
      const allAffected = gitHeadCleanAffectedFiles(ws.cwd, c.git_head);
      if (pathsFilter === null) {
        return {
          checkpoint_id: c.id,
          mode: 'git_head_clean',
          files: allAffected,
          git_head_at_checkpoint: c.git_head,
        };
      }
      const affected = new Set(allAffected);
      const requested: string[] = [];
      const skipped: string[] = [];
      for (const p of pathsFilter) {
        (affected.has(p) ? requested : skipped).push(p);
      }
      return {
        checkpoint_id: c.id,
        mode: 'git_head_clean',
        files: requested,
        skipped,
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

  let pathsFilter: string[] | null;
  try {
    pathsFilter = validatePaths(args.paths);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // Auto-checkpoint BEFORE rewinding so the user can undo a mistaken
  // rewind. Captures the current working-tree state under a label like
  // `auto:before-rewind-to:<target_short>`. Created only after input
  // validation passes — bad arguments shouldn't pollute the timeline.
  const auto_checkpoint_id = args.skip_auto_checkpoint
    ? null
    : tryAutoCheckpoint(
        ws,
        `auto:before-rewind-to:${args.checkpoint_id.slice(0, 8)}`,
        args.task_id,
      );

  const sha = extractStashSha(c.label);

  // Path 1: stash backend
  if (sha) {
    if (pathsFilter === null) {
      gitStashRestore(ws.cwd, sha);
      return {
        ok: true,
        mode: 'stash',
        restored_files: gitStashAffectedFiles(ws.cwd, sha),
        auto_checkpoint_id,
      };
    }
    const result = gitStashRestoreFiltered(ws.cwd, sha, pathsFilter);
    return {
      ok: true,
      mode: 'stash',
      restored_files: result.restored,
      skipped: result.skipped,
      auto_checkpoint_id,
    };
  }

  // Path 2: clean-tree fallback via git_head
  if (c.git_head) {
    try {
      if (pathsFilter === null) {
        const restored = gitHeadCleanRestore(ws.cwd, c.git_head);
        return {
          ok: true,
          mode: 'git_head_clean',
          restored_files: restored,
          auto_checkpoint_id,
        };
      }
      const result = gitHeadCleanRestoreFiltered(ws.cwd, c.git_head, pathsFilter);
      return {
        ok: true,
        mode: 'git_head_clean',
        restored_files: result.restored,
        skipped: result.skipped,
        auto_checkpoint_id,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message, auto_checkpoint_id };
    }
  }

  return { ok: false, error: NO_HEAD_ERROR, auto_checkpoint_id };
}
