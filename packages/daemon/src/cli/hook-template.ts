/**
 * Generates the content of the git pre-commit hook script.
 *
 * The hook script is a POSIX sh script that:
 * 1. Locates the cairn-precommit-check.mjs script using the repository root
 *    supplied at install time.
 * 2. If node is available and the script exists, runs it with the list of
 *    staged file paths.
 * 3. Always exits 0 (fail-open). Hook errors must never block a commit.
 */

/**
 * @param repoRoot  Absolute path to the repository root (process.cwd() at
 *                  install time, normalized to forward-slashes for POSIX sh).
 */
export function buildHookContent(repoRoot: string): string {
  // Normalize backslashes → forward-slashes so the sh script works under
  // git-for-Windows bash / MSYS2 without extra quoting.
  const normalized = repoRoot.replace(/\\/g, '/');
  const scriptPath = `${normalized}/packages/daemon/scripts/cairn-precommit-check.mjs`;

  return `#!/bin/sh
# CAIRN-HOOK-V1 — auto-installed by \`cairn install\`
# Reads conflicts table from ~/.cairn/cairn.db; fail-open if DB or script missing.
# DO NOT EDIT this section manually; run \`cairn install --force\` to update.

CAIRN_HOOK_SCRIPT="${scriptPath}"
if [ -f "$CAIRN_HOOK_SCRIPT" ] && command -v node >/dev/null 2>&1; then
  STAGED=$(git diff --cached --name-only --diff-filter=ACM)
  if [ -n "$STAGED" ]; then
    node "$CAIRN_HOOK_SCRIPT" --staged-files "$STAGED" || true   # fail-open
  fi
fi

exit 0
`;
}

/** The marker line used to detect an already-installed cairn hook section. */
export const CAIRN_HOOK_MARKER = '# CAIRN-HOOK-V1';
