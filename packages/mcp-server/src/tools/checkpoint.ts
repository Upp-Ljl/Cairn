import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  createPendingCheckpoint,
  markCheckpointReady,
  listCheckpoints,
} from '../../../daemon/dist/storage/repositories/checkpoints.js';
import { gitStashSnapshot } from '../../../daemon/dist/storage/snapshots/git-stash.js';
import { detectConflict } from '../../../daemon/dist/services/conflict-detection.js';
import type { Workspace } from '../workspace.js';

export interface CreateCheckpointArgs {
  label?: string;
  /**
   * Optional task tag. When supplied, this checkpoint is associated with
   * the given task identifier and can be filtered out of `cairn.checkpoint.list`
   * via the `task_id` filter. Use this to isolate parallel work — agents
   * doing concurrent refactors should each pick a stable `task_id` so the
   * timeline can be sliced per task. Has no effect on rewind semantics
   * (file scoping is still controlled by the `paths` argument on rewind).
   */
  task_id?: string;
  /**
   * Optional agent identifier for conflict detection. When supplied, cairn
   * will query the process bus for other active agents that have recently
   * created checkpoints and flag any potential FILE_OVERLAP conflicts.
   * Omitting this parameter skips conflict detection entirely (backward-
   * compatible behavior for callers that have not opted into the process bus).
   */
  agent_id?: string;
  /**
   * File paths this checkpoint covers. Used together with `agent_id` to
   * surface conflict information in the response. Has no effect when
   * `agent_id` is not supplied.
   */
  paths?: string[];
}

export interface ListCheckpointsArgs {
  /**
   * If supplied, returns only checkpoints tagged with this task_id.
   * Omit (undefined) to return all checkpoints across all tasks.
   * Pass null explicitly to return only untagged checkpoints
   * (rows whose task_id IS NULL).
   */
  task_id?: string | null;
}

function collectGitPaths(cwd: string): string[] {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, { cwd, encoding: 'utf8' });
    } catch {
      return '';
    }
  };
  const unstaged = run('git diff --name-only HEAD');
  const staged = run('git diff --name-only --cached');
  const combined = new Set(
    [...unstaged.split('\n'), ...staged.split('\n')].filter((p) => p.trim() !== ''),
  );
  return [...combined];
}

export function toolCreateCheckpoint(ws: Workspace, args: CreateCheckpointArgs) {
  // Resolve agent_id: explicit value wins; fall back to session default.
  const effectiveAgentId =
    args.agent_id != null && args.agent_id !== '' ? args.agent_id : ws.agentId;

  // Resolve paths: explicit non-empty array wins; otherwise auto-collect from git.
  const effectivePaths =
    args.paths != null && args.paths.length > 0 ? args.paths : collectGitPaths(ws.cwd);

  // Phase 0: conflict detection — always run with the resolved agent_id.
  let conflictInfo: {
    id: string;
    conflictedWith: string[];
    overlappingPaths: string[];
  } | undefined;

  {
    const detection = detectConflict(ws.db, {
      agentId: effectiveAgentId,
      paths: effectivePaths,
      windowMinutes: 5,
    });
    if (detection.conflictId !== null) {
      conflictInfo = {
        id: detection.conflictId,
        conflictedWith: detection.conflictedWith,
        overlappingPaths: detection.overlappingPaths,
      };
    }
  }

  // Phase 1: insert PENDING row
  const ckpt = createPendingCheckpoint(ws.db, {
    label: args.label ?? null,
    task_id: args.task_id ?? null,
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

  const result: {
    id: string;
    task_id: string | null;
    git_head: string | null;
    stash_sha: string | null;
    warning?: string;
    conflict?: {
      id: string;
      conflictedWith: string[];
      overlappingPaths: string[];
    };
  } = {
    id: ckpt.id,
    task_id: ckpt.task_id,
    git_head: gitHead,
    stash_sha: stashSha,
  };

  if (conflictInfo !== undefined) {
    result.conflict = conflictInfo;
  }
  if (stashSha === null && gitHead === null) {
    // Genuinely unrecoverable: no stash AND no git HEAD (not a git repo).
    result.warning =
      'Not in a git repository — this checkpoint records nothing and cannot be rewound. ' +
      'Run cairn from inside a git working tree to capture state.';
  } else if (stashSha === null) {
    // Clean tree at checkpoint time: rewind will use the git_head fallback,
    // which reverts tracked edits and removes new untracked files (gitignored
    // files are never touched). Surface the scope so the user knows what
    // rewind will and won't restore.
    result.warning =
      'Working tree was clean at checkpoint time. Rewind will restore the tree to git_head ' +
      `(${gitHead!.slice(0, 7)}): tracked edits revert, new untracked files are removed, ` +
      'gitignored files (DBs, .env, node_modules) are left alone.';
  }
  return result;
}

export function toolListCheckpoints(ws: Workspace, args: ListCheckpointsArgs = {}) {
  // task_id is treated tri-state: undefined = no filter, string = exact match,
  // null = match rows with NULL task_id explicitly. The daemon listCheckpoints
  // helper already implements that exact tri-state.
  const rows =
    args.task_id !== undefined
      ? listCheckpoints(ws.db, { status: 'READY', task_id: args.task_id })
      : listCheckpoints(ws.db, 'READY');
  return {
    items: rows.map((c) => ({
      id: c.id,
      task_id: c.task_id,
      label: c.label,
      git_head: c.git_head,
      created_at: c.created_at,
    })),
  };
}
