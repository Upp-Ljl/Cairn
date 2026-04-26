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
