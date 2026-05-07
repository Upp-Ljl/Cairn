/**
 * path-utils.test.ts — production tests for assertWithinCwd.
 *
 * Tests run on Windows (this machine) so Windows-specific cases are not gated.
 * For symlink tests, we skip actual symlink creation (requires admin on Windows)
 * and instead exercise the OUTSIDE_CWD branch directly with an absolute path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { assertWithinCwd } from '../../src/dsl/path-utils.js';

/** Real repo root (exists, realpathSync will work). */
const REPO_ROOT = 'D:/lll/cairn';

/** Temporary directory used for isolation tests. */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-path-test-'));
  // Create a sub-file for "exists inside cwd" tests.
  fs.writeFileSync(path.join(tmpDir, 'existing.txt'), 'hello');
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

// ─── 1. Happy path: target inside cwd ───────────────────────────────────────

it('happy path: target file inside cwd returns ok=true', () => {
  const result = assertWithinCwd(
    path.join(tmpDir, 'existing.txt'),
    tmpDir,
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    // resolved should start with the cwd
    expect(result.resolved.toLowerCase()).toContain(tmpDir.toLowerCase());
  }
});

// ─── 2. Target equal to cwd ──────────────────────────────────────────────────

it('target equal to cwd itself returns ok=true', () => {
  const result = assertWithinCwd(REPO_ROOT, REPO_ROOT);
  expect(result.ok).toBe(true);
});

// ─── 3. Explicit traversal via ".." ──────────────────────────────────────────

it('traversal "../../etc/passwd" returns reason=TRAVERSAL', () => {
  const result = assertWithinCwd('../../etc/passwd', REPO_ROOT);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe('TRAVERSAL');
  }
});

// ─── 4. Another traversal variant ───────────────────────────────────────────

it('traversal "packages/../../../etc" returns reason=TRAVERSAL', () => {
  const result = assertWithinCwd('packages/../../../etc', REPO_ROOT);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe('TRAVERSAL');
  }
});

// ─── 5. Absolute path outside cwd (symlink-out-of-cwd equivalent) ───────────
// Simulates a symlink that would resolve outside cwd; on Windows admin-less
// environments we use a direct absolute outside path instead.

it('absolute path outside cwd (C:/Windows) returns reason=OUTSIDE_CWD', () => {
  if (process.platform !== 'win32') {
    // On POSIX, use /etc as an out-of-cwd absolute path.
    const result = assertWithinCwd('/etc', REPO_ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('OUTSIDE_CWD');
    }
    return;
  }
  const result = assertWithinCwd('C:/Windows', 'D:/lll/cairn');
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe('OUTSIDE_CWD');
  }
});

// ─── 6. Windows case-insensitivity ───────────────────────────────────────────

it('Windows case-fold: D:/lll/CAIRN/packages is inside D:/lll/cairn', () => {
  if (process.platform !== 'win32') {
    // Skip on POSIX — case-sensitive filesystems would give OUTSIDE_CWD here.
    return;
  }
  // packages/ exists in the repo root.
  const result = assertWithinCwd('D:/lll/CAIRN/packages', 'D:/lll/cairn');
  expect(result.ok).toBe(true);
});

// ─── 7. Relative target inside cwd ──────────────────────────────────────────

it('relative target "packages/daemon" resolved against REPO_ROOT returns ok=true', () => {
  const result = assertWithinCwd('packages/daemon', REPO_ROOT);
  expect(result.ok).toBe(true);
  if (result.ok) {
    // resolved is absolute and contains the cwd prefix.
    expect(path.isAbsolute(result.resolved)).toBe(true);
  }
});

// ─── 8. Non-existent target whose parent exists ──────────────────────────────

it('non-existent file with existing parent → ok=true, resolved is synthesised path', () => {
  // tmpDir exists; "newfile.txt" does not (yet).
  const result = assertWithinCwd(
    path.join(tmpDir, 'newfile.txt'),
    tmpDir,
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.resolved.toLowerCase()).toContain(
      path.basename(tmpDir).toLowerCase(),
    );
  }
});

// ─── 9. Completely orphan path (no existing parent) ─────────────────────────

it('orphan path D:/__totally_nonexistent_xyz__/file.txt returns reason=INVALID_PATH', () => {
  const result = assertWithinCwd(
    'D:/__totally_nonexistent_xyz__/file.txt',
    REPO_ROOT,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe('INVALID_PATH');
  }
});

// ─── 10. Relative target pointing into packages/ (additional coverage) ──────

it('relative "packages/mcp-server" inside REPO_ROOT returns ok=true', () => {
  const result = assertWithinCwd('packages/mcp-server', REPO_ROOT);
  expect(result.ok).toBe(true);
});
