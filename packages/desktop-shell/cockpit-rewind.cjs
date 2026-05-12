'use strict';

/**
 * Cockpit REWIND — Module 4 wiring (Phase 4 of panel-cockpit-redesign).
 *
 * D9.1 tier-B mutation: requires inline confirm dialog before firing.
 *
 * SCOPE NOTE: this module implements a CONSERVATIVE subset of the
 * mcp-server `cairn.rewind.to` tool. We only support the
 * `git_head` clean-tree reset path; stash-based filtered restores
 * (the richer path the mcp tool supports) stay in the kernel — users
 * who need them invoke `cairn.rewind.to` via their coding agent.
 *
 *   - previewRewind:  read-only; returns checkpoint info + safety
 *     check (working tree dirty? is git_head reachable?)
 *   - performRewind:  guarded; runs git stash push (-u, with label) +
 *     `git checkout <git_head> -- .` to restore tree content without
 *     moving HEAD. Records an auto-checkpoint row in the DB so the
 *     user can un-rewind.
 *
 * Errors are returned as { ok:false, error, hint } structs — UI
 * displays the hint to the user.
 *
 * Cross-process safety: this runs in the Electron main process, NOT
 * in the agent's session. It only touches the project_root via git
 * subprocess; it does NOT touch the Cairn repo or any other path.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newUlid() {
  const ts = Date.now();
  let timePart = '';
  let n = ts;
  for (let i = 9; i >= 0; i--) {
    timePart = ENC[n % 32] + timePart;
    n = Math.floor(n / 32);
  }
  const rand = crypto.randomBytes(10);
  let randPart = '';
  for (let i = 0; i < 16; i++) {
    randPart += ENC[rand[i % 10] % 32];
  }
  return timePart + randPart;
}

function git(cwd, args, opts) {
  const o = opts || {};
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: o.timeoutMs || 10000,
    windowsHide: true,
  });
}

function projectIsGitRepo(projectRoot) {
  if (!projectRoot) return false;
  return fs.existsSync(path.join(projectRoot, '.git'));
}

/**
 * Preview a rewind without performing it.
 *
 * Returns { ok, checkpoint, working_tree, git_head_reachable, head_matches }
 */
function previewRewind(db, tables, project, checkpointId) {
  if (!project || !project.project_root) {
    return { ok: false, error: 'project_root_missing' };
  }
  if (!db || !tables || !tables.has('checkpoints')) {
    return { ok: false, error: 'checkpoints_table_missing' };
  }
  const row = db.prepare(`
    SELECT id, task_id, git_head, snapshot_status, created_at, label
    FROM checkpoints WHERE id = ?
  `).get(checkpointId);
  if (!row) {
    return { ok: false, error: 'checkpoint_not_found', hint: `id ${checkpointId} not in DB` };
  }
  if (row.snapshot_status !== 'READY') {
    return { ok: false, error: 'checkpoint_not_ready', hint: `status=${row.snapshot_status}` };
  }
  if (!row.git_head) {
    return {
      ok: false, error: 'no_git_head',
      hint: 'this checkpoint has no git_head — use mcp tool cairn.rewind.to from your coding agent for the richer stash-restore path',
      checkpoint: row,
    };
  }

  if (!projectIsGitRepo(project.project_root)) {
    return {
      ok: false, error: 'not_a_git_repo',
      hint: `${project.project_root} does not contain a .git directory`,
      checkpoint: row,
    };
  }

  // Is git_head reachable?
  const verify = git(project.project_root, ['rev-parse', '--verify', '--quiet', row.git_head + '^{commit}']);
  const reachable = verify.status === 0;

  // What's the current HEAD?
  const headSha = git(project.project_root, ['rev-parse', 'HEAD']).stdout.trim();
  const headMatches = headSha === row.git_head;

  // Working tree dirty?
  const status = git(project.project_root, ['status', '--porcelain=v1']);
  const dirtyLines = (status.stdout || '').split(/\r?\n/).filter(Boolean);
  const isDirty = dirtyLines.length > 0;

  return {
    ok: true,
    checkpoint: row,
    project_root: project.project_root,
    head_sha: headSha,
    git_head_reachable: reachable,
    head_matches: headMatches,
    working_tree: {
      dirty: isDirty,
      changed_files: dirtyLines.slice(0, 20),
      total_changed: dirtyLines.length,
    },
  };
}

/**
 * Perform a rewind: stash current state (if any) + restore the
 * checkpoint's git_head tree content (without moving HEAD).
 *
 * On success returns:
 *   { ok, mode, restored_to, stash_ref, auto_checkpoint_id }
 *
 * On failure:
 *   { ok:false, error, hint, stderr? }
 */
function performRewind(db, tables, project, checkpointId, opts) {
  const o = opts || {};

  const preview = previewRewind(db, tables, project, checkpointId);
  if (!preview.ok) return preview;
  if (!preview.git_head_reachable) {
    return {
      ok: false, error: 'git_head_unreachable',
      hint: `commit ${preview.checkpoint.git_head} not found in this clone — may have been pruned`,
    };
  }
  if (preview.head_matches && !preview.working_tree.dirty) {
    return {
      ok: true, mode: 'no-op',
      hint: 'already at this checkpoint with a clean tree',
      restored_to: preview.checkpoint.git_head,
    };
  }

  const cwd = project.project_root;
  let stashRef = null;

  // Step 1 — safety stash (only if working tree dirty).
  if (preview.working_tree.dirty) {
    const stashLabel = `cairn-cockpit-rewind-${Date.now()}`;
    const r = git(cwd, ['stash', 'push', '-u', '-m', stashLabel]);
    if (r.status !== 0) {
      return {
        ok: false, error: 'safety_stash_failed',
        hint: 'could not push a safety stash — refusing to rewind',
        stderr: (r.stderr || '').slice(0, 400),
      };
    }
    const refList = git(cwd, ['stash', 'list']);
    const firstLine = (refList.stdout || '').split(/\r?\n/)[0] || '';
    const m = firstLine.match(/^(stash@\{[0-9]+\}):/);
    stashRef = m ? m[1] : 'stash@{0}';
  }

  // Step 2 — restore tree content to checkpoint's git_head.
  // `git checkout <sha> -- .` updates the working tree + index without
  // moving HEAD. Safer than `git reset --hard` because HEAD ref stays
  // where it was; user can manually move HEAD afterward via mcp tool.
  const co = git(cwd, ['checkout', preview.checkpoint.git_head, '--', '.']);
  if (co.status !== 0) {
    // Best-effort: restore stash if we made one.
    if (stashRef) {
      git(cwd, ['stash', 'pop', stashRef]);
    }
    return {
      ok: false, error: 'checkout_failed',
      hint: 'could not restore tree content — safety stash was rolled back',
      stderr: (co.stderr || '').slice(0, 400),
    };
  }

  // Step 3 — record an auto-checkpoint for un-rewind.
  let autoCkptId = null;
  if (!o.skipAutoCheckpoint && tables.has('checkpoints')) {
    autoCkptId = 'ck_auto_' + newUlid();
    try {
      const stashSha = stashRef
        ? (git(cwd, ['rev-parse', stashRef]).stdout || '').trim() || null
        : null;
      db.prepare(`
        INSERT INTO checkpoints
          (id, task_id, git_head, snapshot_status, created_at, label)
        VALUES (?, NULL, ?, 'READY', ?, ?)
      `).run(
        autoCkptId,
        preview.head_sha,  // record the PRE-rewind HEAD so we can un-rewind
        Date.now(),
        `auto:cockpit-pre-rewind-to:${preview.checkpoint.git_head.slice(0, 8)}` + (stashSha ? `:stash=${stashSha.slice(0, 8)}` : ''),
      );
    } catch (_e) {
      // Fail-open: rewind succeeded; missing audit row is a soft loss.
      autoCkptId = null;
    }
  }

  return {
    ok: true,
    mode: 'checkout',
    restored_to: preview.checkpoint.git_head,
    stash_ref: stashRef,
    auto_checkpoint_id: autoCkptId,
    hint: stashRef
      ? `tree restored. previous state stashed at ${stashRef}. run \`git stash pop ${stashRef}\` to un-rewind.`
      : 'tree restored. previous HEAD recorded in auto-checkpoint for un-rewind.',
  };
}

module.exports = {
  previewRewind,
  performRewind,
};
