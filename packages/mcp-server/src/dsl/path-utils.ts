/**
 * path-utils.ts
 *
 * CWD-containment checker for DSL primitive evaluation.
 * Resolves symlinks, handles Windows case-insensitivity, and distinguishes
 * explicit traversal (".." in the input string) from symlink-based escapes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export type PathCheckResult =
  | { ok: true; resolved: string }
  | { ok: false; reason: 'TRAVERSAL' | 'OUTSIDE_CWD' | 'INVALID_PATH' };

// ────────────────────────────────────────────────────────────────
// Module-private helpers
// ────────────────────────────────────────────────────────────────

/**
 * On Windows, fold to lowercase so "D:/lll/CAIRN" and "D:/lll/cairn" compare
 * as equal.  On POSIX, filesystems are case-sensitive — leave as-is.
 */
function caseFold(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Return true when the input path string (before any realpath resolution)
 * literally contains ".." segments — a heuristic for intentional traversal.
 */
function hasTraversalSegments(p: string): boolean {
  // Split on both separators to handle mixed-style inputs (Windows allows both).
  const parts = p.split(/[\\/]/);
  return parts.includes('..');
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Check that `target` refers to a path inside `cwd`.
 *
 * Handles:
 * - Relative targets (resolved against `cwd` before checking).
 * - Non-existent targets (parent must exist; basename is appended after realpath).
 * - Windows case-insensitivity (via caseFold).
 * - Symlinks (via fs.realpathSync).
 * - Explicit traversal ("../foo") → reason: 'TRAVERSAL'.
 * - Legitimate but out-of-cwd paths → reason: 'OUTSIDE_CWD'.
 * - Broken paths (no existing ancestor) → reason: 'INVALID_PATH'.
 */
export function assertWithinCwd(target: string, cwd: string): PathCheckResult {
  // Heuristic: if the raw input string has ".." segments, call it TRAVERSAL.
  if (hasTraversalSegments(target)) {
    return { ok: false, reason: 'TRAVERSAL' };
  }

  try {
    // Resolve the real cwd (follows symlinks, normalises case on Windows).
    const realCwd = caseFold(fs.realpathSync(cwd));

    // Normalise relative targets to absolute before realpath.
    const absTarget = path.isAbsolute(target)
      ? target
      : path.resolve(cwd, target);

    let realTarget: string;

    if (fs.existsSync(absTarget)) {
      realTarget = caseFold(fs.realpathSync(absTarget));
    } else {
      // Target doesn't exist yet: resolve the parent directory and append basename.
      const parent = path.dirname(absTarget);
      if (!fs.existsSync(parent)) {
        // No existing ancestor — cannot safely determine containment.
        return { ok: false, reason: 'INVALID_PATH' };
      }
      realTarget = caseFold(
        path.join(fs.realpathSync(parent), path.basename(absTarget)),
      );
    }

    // Containment check: target must equal cwd or be directly inside it.
    const inside =
      realTarget === realCwd ||
      realTarget.startsWith(realCwd + path.sep);

    if (!inside) {
      return { ok: false, reason: 'OUTSIDE_CWD' };
    }

    return { ok: true, resolved: realTarget };
  } catch {
    return { ok: false, reason: 'INVALID_PATH' };
  }
}
