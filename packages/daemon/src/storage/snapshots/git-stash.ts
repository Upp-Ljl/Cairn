import { execSync, type ExecSyncOptions } from 'node:child_process';

function git(
  cwd: string,
  args: string,
  opts: Pick<ExecSyncOptions, 'encoding'> = { encoding: 'utf8' },
): string {
  return execSync(`git ${args}`, {
    cwd,
    ...opts,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

/**
 * Capture the working tree's current state as a stash object.
 *
 * Includes both tracked modifications and untracked files. Does NOT push onto the stash stack
 * and does NOT modify the working tree (other than transient index churn that is undone before
 * return).
 *
 * Returns the stash commit SHA, or null if the working tree is clean (nothing to capture).
 */
export function gitStashSnapshot(cwd: string): string | null {
  // Snapshot index state so we can restore it after we forcibly add untracked files.
  const indexBefore = git(cwd, 'diff --cached --name-only').split('\n').filter(Boolean);

  // Force untracked files into the index so `stash create` sees them.
  git(cwd, 'add -A');

  // `stash create` writes a commit object and prints its SHA on stdout (empty if nothing).
  const sha = git(cwd, 'stash create');

  // Mixed reset: drop everything from the index back to working tree,
  // then re-stage what was previously staged (best-effort restore of pre-call index).
  git(cwd, 'reset');
  if (indexBefore.length > 0) {
    // Quote each path to handle spaces. `git add` is idempotent.
    const quoted = indexBefore.map((f) => `"${f}"`).join(' ');
    git(cwd, `add ${quoted}`);
  }

  return sha === '' ? null : sha;
}

/**
 * Restore working-tree files to the state captured in the given stash commit.
 *
 * Uses `git restore --source=<stashSha> --worktree` per affected file, which copies blobs
 * from the stash tree directly into the working directory without touching the index.
 * Does NOT modify HEAD, the index, or the stash stack.
 *
 * Per PRODUCT.md §17 楔期 rewind 约定: only files revert, commit history stays intact.
 */
export function gitStashRestore(cwd: string, stashSha: string): void {
  const files = gitStashAffectedFiles(cwd, stashSha);
  if (files.length === 0) return;
  // `git restore --source=<sha> --worktree` writes blobs directly to working tree only;
  // the index is untouched, so no post-reset is needed.
  const quoted = files.map((f) => `"${f}"`).join(' ');
  git(cwd, `restore --source=${stashSha} --worktree -- ${quoted}`);
}

/**
 * Return the list of file paths affected by a stash commit (relative to the repo root).
 * Used by rewind.preview to show "these files would be overwritten" before commit.
 */
export function gitStashAffectedFiles(cwd: string, stashSha: string): string[] {
  // diff-tree against the stash's explicit first parent (HEAD-at-snapshot-time).
  // We must name the parent explicitly because the stash commit is a merge commit
  // (it has parent 2 = index snapshot), so `--no-commit-id` would do a combined diff
  // and return nothing. Using `<sha>~1 <sha>` forces a two-tree diff.
  // Note: we use `~1` not `^1` because `^` is the escape character in Windows cmd.exe
  // and would be silently consumed when execSync spawns via the Windows shell.
  const out = git(cwd, `diff-tree --name-only -r ${stashSha}~1 ${stashSha}`);
  return out.split('\n').filter(Boolean);
}

// =============================================================================
// Clean-tree (git_head only) snapshot path
// =============================================================================
//
// When a checkpoint is created on a clean working tree, gitStashSnapshot returns
// null because there is nothing for `stash create` to capture. The checkpoint
// still records `git_head` (the commit SHA at checkpoint time). The pair of
// helpers below let `rewind` use that git_head as the restore target — making
// the natural workflow `commit → checkpoint → edit → rewind` actually work.
//
// Semantics: "restore working tree to the exact state at git_head". Concretely:
//   - revert tracked-file modifications via `git checkout <git_head> -- .`
//   - delete untracked files created since the checkpoint via `git clean -fd`
//   - leave gitignored files alone (consistent with stash backend, which never
//     captures gitignored files either — documented limitation)
//   - leave HEAD and commit history untouched (PRODUCT.md §8.3)
//
// Hard precondition: current HEAD must equal the supplied git_head. If HEAD has
// moved (user committed since the checkpoint), the semantics get ambiguous and
// could destroy committed work, so we throw rather than guess.

/**
 * Return the list of file paths whose state diverges from the given git_head.
 *
 * Includes both tracked-but-modified files and currently-untracked files
 * (which by definition did not exist at git_head). Respects .gitignore (ignored
 * files are NOT listed). Used by rewind.preview on clean-tree checkpoints.
 */
export function gitHeadCleanAffectedFiles(cwd: string, gitHead: string): string[] {
  // Validate current HEAD matches the supplied git_head BEFORE inspecting the
  // tree. If HEAD has moved (user committed since the checkpoint), the
  // semantics get ambiguous and could destroy committed work, so we surface
  // that as an explicit error rather than silently restoring against the
  // wrong baseline.
  const currentHead = git(cwd, 'rev-parse HEAD');
  if (currentHead !== gitHead) {
    throw new Error(
      `HEAD has moved since checkpoint (now ${currentHead.slice(0, 7)}, ` +
        `checkpoint git_head was ${gitHead.slice(0, 7)}). ` +
        'Clean-tree rewind requires HEAD to match the checkpoint. ' +
        'Either reset HEAD with `git reset` or pick a different checkpoint.',
    );
  }
  // Two machine-readable name lists, more reliable across platforms than
  // parsing `status --porcelain` (which has whitespace quirks on Windows).
  //   - `diff --name-only HEAD` → tracked files differing from HEAD
  //   - `ls-files --others --exclude-standard` → untracked, gitignore-respecting
  const tracked = git(cwd, 'diff --name-only HEAD').split('\n').filter(Boolean);
  const untracked = git(cwd, 'ls-files --others --exclude-standard')
    .split('\n')
    .filter(Boolean);
  // Dedupe in case of overlap (shouldn't happen, but cheap insurance).
  return Array.from(new Set([...tracked, ...untracked]));
}

/**
 * Restore the working tree to its state at the given git_head.
 *
 * Behavior:
 *   - reverts every tracked-but-modified file to its git_head blob
 *   - deletes every untracked-non-ignored file created since git_head
 *   - leaves gitignored files alone (e.g. local DBs, .env, node_modules)
 *   - leaves HEAD, the index baseline, and commit history untouched
 *
 * Throws if current HEAD has diverged from the supplied git_head — see
 * gitHeadCleanAffectedFiles for rationale.
 *
 * Returns the list of paths that were touched (reverted or deleted).
 */
export function gitHeadCleanRestore(cwd: string, gitHead: string): string[] {
  const affected = gitHeadCleanAffectedFiles(cwd, gitHead);
  if (affected.length === 0) return [];
  // 1. Revert all tracked changes back to git_head's blobs.
  //    `checkout <commit> -- .` writes blobs from <commit> over the working tree
  //    for every path that exists in the index; it does not touch HEAD or stage
  //    anything. New untracked files are not touched here.
  git(cwd, `checkout ${gitHead} -- .`);
  // 2. Remove untracked-non-ignored files created since git_head.
  //    `-f` required to actually delete; `-d` recurses into untracked dirs.
  //    No `-x` flag → gitignored files survive (matches stash backend behavior).
  git(cwd, 'clean -fd');
  return affected;
}
