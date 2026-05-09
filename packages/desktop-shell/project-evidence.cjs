'use strict';

/**
 * Managed Project Evidence Collector v1 — read-only "what really
 * happened this round" snapshot.
 *
 * Cairn does NOT execute tests / builds / installs by default. The
 * evidence collector only runs whitelisted READ-ONLY git commands and
 * file probes. The whole point: the user (and the LLM-assisted review
 * layer) gets *concrete* evidence rather than only the agent's
 * self-report.
 *
 * Allowed commands (whitelisted in ALLOWED_GIT_ARGS):
 *   git rev-parse --abbrev-ref HEAD
 *   git rev-parse HEAD
 *   git status --short
 *   git diff --stat
 *   git diff --name-only
 *   git diff --name-only HEAD
 *   git log -1 --format=%h%x09%s
 *
 * Optional, only when caller passes `allow_run_tests: true`:
 *   the first detected test command from the managed-project profile.
 *   Output is captured + truncated. Caller is the gate; this module
 *   does not silently run them.
 *
 * Hard rules:
 *   - No `git push`, `git fetch`, `git checkout`, `git rebase`,
 *     `git reset`, `git clean`, `git stash` — none of those touch
 *     working state in a way the user did not authorize.
 *   - No `npm install`, `pip install`, `bundle`, etc.
 *   - No `git diff <ref>` against unknown refs (we limit to working
 *     tree / HEAD).
 *   - All command output is truncated to MAX_OUTPUT_BYTES.
 *
 * Returns a stable shape so the review layer + UI never have to
 * special-case missing data.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const MAX_OUTPUT_BYTES = 16 * 1024;
const TEST_TIMEOUT_MS = 4 * 60 * 1000;
const READONLY_TIMEOUT_MS = 15 * 1000;
const MAX_CHANGED_FILES = 100;

// Each entry is the EXACT argv passed to git. We deliberately list the
// full argv (not a flag whitelist) so an attacker can't smuggle in
// flags via parameter expansion.
const ALLOWED_GIT_ARGS = [
  ['rev-parse', '--abbrev-ref', 'HEAD'],
  ['rev-parse', 'HEAD'],
  ['status', '--short'],
  ['status', '--short', '--branch'],
  ['diff', '--stat'],
  ['diff', '--name-only'],
  ['diff', '--name-only', 'HEAD'],
  ['log', '-1', '--format=%h\t%s'],
];

function isAllowedGitArgs(args) {
  if (!Array.isArray(args)) return false;
  return ALLOWED_GIT_ARGS.some(allowed =>
    allowed.length === args.length && allowed.every((v, i) => v === args[i]));
}

function truncateBuf(s) {
  if (typeof s !== 'string') return '';
  if (s.length <= MAX_OUTPUT_BYTES) return s;
  return s.slice(0, MAX_OUTPUT_BYTES) + '\n…[truncated]';
}

function runGit(args, cwd, opts) {
  const o = opts || {};
  if (!isAllowedGitArgs(args)) {
    return { ok: false, error: 'argv_not_allowed' };
  }
  let res;
  try {
    res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: o.timeoutMs || READONLY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (_e) {
    return { ok: false, error: 'spawn_failed' };
  }
  if (res.status === null) return { ok: false, error: 'timeout' };
  if (res.status !== 0) {
    return { ok: false, error: 'git_nonzero', stderr: truncateBuf(res.stderr || '') };
  }
  return { ok: true, stdout: truncateBuf(res.stdout || '') };
}

function parseChangedFiles(out) {
  return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, MAX_CHANGED_FILES);
}

function parseStatusLines(out) {
  // git status --short:  XY path
  // We only need: dirty?, list of paths.
  const paths = [];
  let dirty = false;
  const lines = out.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('##')) continue;
    dirty = true;
    const m = line.match(/^.{2}\s+(.+)$/);
    if (m) paths.push(m[1]);
    if (paths.length >= MAX_CHANGED_FILES) break;
  }
  return { dirty, paths };
}

/**
 * Collect read-only evidence about the project's current git working
 * state. Returns the canonical shape regardless of which probes
 * succeeded; failed probes leave the corresponding field empty / null
 * and add a string error code to `errors`.
 *
 * @param {string} localPath
 * @param {{ profile?, allow_run_tests?:boolean, run_tests_command? }} options
 */
function collectGitEvidence(localPath, options) {
  const o = options || {};
  const profile = o.profile || null;
  const errors = [];
  const out = {
    local_path: localPath,
    git_head: null,
    git_short: null,
    branch: null,
    dirty: false,
    changed_files: [],
    diff_stat: '',
    last_commit: null,
    scripts_detected: [],
    tests_run: [],
    tests_suggested: [],
    collected_at: Date.now(),
    errors,
  };

  if (!localPath || !fs.existsSync(localPath)) {
    errors.push('local_path_missing');
    return out;
  }
  // Confirm there's a .git/.
  if (!fs.existsSync(path.join(localPath, '.git'))) {
    errors.push('not_a_git_repo');
    // Still return profile-derived suggestions below.
  } else {
    const head = runGit(['rev-parse', 'HEAD'], localPath);
    if (head.ok) out.git_head = head.stdout.trim();
    else errors.push('git_rev_parse_head:' + head.error);

    if (out.git_head) out.git_short = out.git_head.slice(0, 12);

    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], localPath);
    if (branch.ok) out.branch = branch.stdout.trim();
    else errors.push('git_branch:' + branch.error);

    const status = runGit(['status', '--short'], localPath);
    if (status.ok) {
      const { dirty, paths } = parseStatusLines(status.stdout);
      out.dirty = dirty;
      out.changed_files = paths;
    } else errors.push('git_status:' + status.error);

    const diffStat = runGit(['diff', '--stat'], localPath);
    if (diffStat.ok) out.diff_stat = diffStat.stdout.trim();
    else errors.push('git_diff_stat:' + diffStat.error);

    const log = runGit(['log', '-1', '--format=%h\t%s'], localPath);
    if (log.ok) {
      const trimmed = log.stdout.trim();
      const tabIdx = trimmed.indexOf('\t');
      out.last_commit = tabIdx > 0
        ? { hash: trimmed.slice(0, tabIdx), subject: trimmed.slice(tabIdx + 1).slice(0, 200) }
        : { hash: trimmed.slice(0, 12), subject: '' };
    } else errors.push('git_log:' + log.error);
  }

  // Profile-derived suggestions.
  if (profile) {
    if (Array.isArray(profile.scripts_detected)) {
      out.scripts_detected = profile.scripts_detected
        .slice(0, 12)
        .map(s => ({ name: s.name, value: (s.value || '').slice(0, 200) }));
    }
    if (Array.isArray(profile.test_commands) && profile.test_commands.length) {
      out.tests_suggested = profile.test_commands.slice(0, 3);
    }
  }

  // Optional: run tests. Only when explicitly allowed AND the command
  // came from the profile (or the caller). Default: do nothing.
  if (o.allow_run_tests) {
    const cmd = o.run_tests_command || (profile && profile.test_commands && profile.test_commands[0]);
    if (cmd && typeof cmd === 'string') {
      const result = runShellCommand(cmd, localPath, { timeoutMs: o.test_timeout_ms || TEST_TIMEOUT_MS });
      out.tests_run.push({
        command: cmd.slice(0, 200),
        exit: result.exit,
        stdout: result.stdout,
        stderr: result.stderr,
        timed_out: !!result.timed_out,
      });
    } else {
      errors.push('test_command_missing');
    }
  }

  return out;
}

/**
 * Run a single shell command, capturing + truncating output. Used
 * only when caller explicitly authorizes (allow_run_tests).
 *
 * Cross-platform note: managed projects have arbitrary script syntax
 * (e.g. `next dev -p 3000`). We invoke through the user's shell with
 * shell:true so the command works the same as if the user typed it.
 * This is acceptable here BECAUSE the command came from the
 * package.json scripts the user authored — we're not synthesizing
 * shell strings ourselves.
 */
function runShellCommand(command, cwd, opts) {
  const o = opts || {};
  let res;
  try {
    res = spawnSync(command, {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: o.timeoutMs || TEST_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (_e) {
    return { exit: -1, stdout: '', stderr: '', timed_out: false, error: 'spawn_failed' };
  }
  return {
    exit: res.status,
    stdout: truncateBuf(res.stdout || ''),
    stderr: truncateBuf(res.stderr || ''),
    timed_out: res.status === null,
  };
}

/**
 * Compact summary suitable for embedding in iteration records (no
 * stdout dumps; counts + flags only).
 */
function summarizeEvidence(evidence) {
  if (!evidence) return null;
  return {
    branch: evidence.branch || null,
    git_short: evidence.git_short || null,
    dirty: !!evidence.dirty,
    changed_file_count: (evidence.changed_files || []).length,
    last_commit_subject: evidence.last_commit ? evidence.last_commit.subject : null,
    tests_run_count: (evidence.tests_run || []).length,
    tests_run_pass: (evidence.tests_run || []).every(t => t.exit === 0) && (evidence.tests_run || []).length > 0,
    tests_suggested: (evidence.tests_suggested || []).slice(0, 3),
    error_codes: (evidence.errors || []).slice(0, 10),
    collected_at: evidence.collected_at,
  };
}

module.exports = {
  ALLOWED_GIT_ARGS,
  isAllowedGitArgs,
  collectGitEvidence,
  summarizeEvidence,
  runGit,
  // exposed for tests
  parseStatusLines,
  parseChangedFiles,
  MAX_OUTPUT_BYTES,
  MAX_CHANGED_FILES,
};
