'use strict';

/**
 * mode-a-auto-ship.cjs — auto git commit + push when a Mode A plan
 * step transitions to DONE.
 *
 * CEO 鸭总 2026-05-14 design: "CC 的 outcome summary 用作 commit
 * message，应该是刚开始的时候就需要配置好 git，或者用户的项目一般
 * 也有 .git，参考来进行推送".
 *
 * Subagent verdict (sonnet) 2026-05-14: GO.
 *
 * Flow:
 *   1. mentor-tick calls autoShip(projectRoot, message, opts) when
 *      advance.action === 'advanced' AND cockpit_settings.auto_ship
 *      .enabled === true for this project.
 *   2. autoShip checks if there are uncommitted changes in the work
 *      tree. If clean → no_changes (skip, not failure).
 *   3. git add -A + commit with `message` (= outcome.evaluation_summary
 *      from CC, or fallback "step N done: <label>" from caller).
 *   4. git push origin <branch> — try with system git config first
 *      (GCM / SSH key / etc), fall back to PAT URL if a `pat_path` was
 *      provisioned at add-project time. TLS-backend retry pattern per
 *      CLAUDE.md push section (openssl ↔ schannel).
 *
 * Never `--force`. Never auto-rebase. Push reject → log + escalation
 * nudge (caller's responsibility); we don't recurse the loop.
 *
 * @security PAT redaction: token is read inside this function, used
 * only as a `spawnSync` arg-array element (no shell interpolation),
 * and the URL containing the token is NEVER logged or returned in any
 * field that downstream code might log. Caller (mentor-tick) and the
 * result type both omit the URL.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cairnLog = require('./cairn-log.cjs');

const COMMIT_TIMEOUT_MS = 15000;
const PUSH_TIMEOUT_MS   = 30000;

/**
 * @param {string} projectRoot Absolute path; must be a git work tree.
 * @param {string} message     Commit message (caller pre-built; non-empty).
 * @param {{
 *   patPath?: string|null,
 *   branch?: string,
 *   remoteUrl?: string|null,
 *   nowFn?: () => number,
 *   logProjectId?: string,
 * }} [opts]
 * @returns {{ ok: true, commit_sha: string, push_backend?: string }
 *         | { ok: false, reason: string, error?: string }}
 */
function autoShip(projectRoot, message, opts) {
  const o = opts || {};
  if (!projectRoot || typeof projectRoot !== 'string') {
    return { ok: false, reason: 'project_root_required' };
  }
  if (!fs.existsSync(projectRoot)) {
    return { ok: false, reason: 'project_root_not_found' };
  }
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    return { ok: false, reason: 'not_a_git_repo' };
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return { ok: false, reason: 'message_required' };
  }
  // Cap message to avoid surprises (git refuses very long first lines).
  // Keep multi-line bodies intact; only truncate runaway pastes.
  const safeMessage = message.length > 8000 ? message.slice(0, 8000) + '\n\n[truncated]' : message;

  // ------------------------------------------------------------------
  // Phase 1: detect changes
  // ------------------------------------------------------------------
  const statusRes = _git(projectRoot, ['status', '--porcelain'], COMMIT_TIMEOUT_MS);
  if (statusRes.status !== 0) {
    return { ok: false, reason: 'git_status_failed', error: statusRes.stderr || statusRes.error };
  }
  if (!statusRes.stdout || !statusRes.stdout.trim()) {
    return { ok: false, reason: 'no_changes' };
  }

  // ------------------------------------------------------------------
  // Phase 2: stage + commit
  // ------------------------------------------------------------------
  const addRes = _git(projectRoot, ['add', '-A'], COMMIT_TIMEOUT_MS);
  if (addRes.status !== 0) {
    return { ok: false, reason: 'git_add_failed', error: addRes.stderr };
  }

  const commitRes = _git(
    projectRoot,
    ['commit', '-m', safeMessage],
    COMMIT_TIMEOUT_MS,
  );
  if (commitRes.status !== 0) {
    // Don't include the message body in the error log — it can be huge.
    return { ok: false, reason: 'git_commit_failed', error: (commitRes.stderr || '').slice(0, 500) };
  }
  const commitSha = _parseCommitSha(commitRes.stdout) || 'unknown';

  // ------------------------------------------------------------------
  // Phase 3: push
  // ------------------------------------------------------------------
  // Resolve remote URL: prefer opts.remoteUrl (registry-cached at add
  // time), else ask git.
  let remoteUrl = (o.remoteUrl && typeof o.remoteUrl === 'string') ? o.remoteUrl : null;
  if (!remoteUrl) {
    const remoteRes = _git(projectRoot, ['remote', 'get-url', 'origin'], COMMIT_TIMEOUT_MS);
    if (remoteRes.status !== 0 || !remoteRes.stdout || !remoteRes.stdout.trim()) {
      // Commit landed, just no remote configured. That's actually fine.
      return {
        ok: true,
        commit_sha: commitSha,
        push_backend: 'skipped:no_remote',
      };
    }
    remoteUrl = remoteRes.stdout.trim();
  }

  const branch = (o.branch && typeof o.branch === 'string') ? o.branch : 'main';
  const patPath = o.patPath || null;

  // Attempt 1: system-config push (GCM / SSH key / etc — no PAT needed).
  // openssl first per CLAUDE.md TLS retry pattern.
  let pushResult = _pushAttempt(projectRoot, 'origin', branch, 'openssl');
  let usedBackend = 'openssl';
  if (pushResult.status !== 0 && _isTlsError(pushResult.stderr)) {
    pushResult = _pushAttempt(projectRoot, 'origin', branch, 'schannel');
    usedBackend = 'schannel';
  }

  // Attempt 2: PAT URL fallback if system config failed (auth or TLS).
  if (pushResult.status !== 0 && patPath && fs.existsSync(patPath)) {
    let token = null;
    try { token = fs.readFileSync(patPath, 'utf8').trim(); }
    catch (_e) { token = null; }
    if (token) {
      const httpsUrl = _injectTokenIntoHttpsUrl(remoteUrl, token);
      if (httpsUrl) {
        // openssl first.
        let patPushResult = _pushAttempt(projectRoot, httpsUrl, branch, 'openssl');
        let patBackend = 'pat+openssl';
        if (patPushResult.status !== 0 && _isTlsError(patPushResult.stderr)) {
          patPushResult = _pushAttempt(projectRoot, httpsUrl, branch, 'schannel');
          patBackend = 'pat+schannel';
        }
        // Burn the token reference in this scope.
        token = null;
        if (patPushResult.status === 0) {
          pushResult = patPushResult;
          usedBackend = patBackend;
        }
      }
    }
  }

  if (pushResult.status !== 0) {
    // Redact any URL that might have appeared in stderr.
    const safeErr = _redactTokenUrls((pushResult.stderr || '').slice(0, 800));
    return {
      ok: false,
      reason: 'push_failed',
      error: safeErr,
      commit_sha: commitSha,  // commit DID land locally
    };
  }
  return {
    ok: true,
    commit_sha: commitSha,
    push_backend: usedBackend,
  };
}

// =====================================================================
// helpers (not exported, but isolated for unit testing if needed)
// =====================================================================

function _git(cwd, args, timeoutMs) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
}

function _pushAttempt(cwd, remote, branch, sslBackend) {
  const args = ['-c', 'http.sslBackend=' + sslBackend, 'push', remote, branch];
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: PUSH_TIMEOUT_MS,
    windowsHide: true,
  });
}

function _parseCommitSha(commitStdout) {
  if (!commitStdout) return null;
  // Match patterns like "[main abc1234]" or "[main (root-commit) abc1234]"
  const m = commitStdout.match(/\[[^\]]+?\s([0-9a-f]{7,40})\]/);
  return m ? m[1] : null;
}

function _isTlsError(stderr) {
  if (!stderr) return false;
  return /TLS|SSL|unexpected eof|connection reset/i.test(stderr);
}

/**
 * Build https://x-access-token:<token>@host/path from a https:// remote.
 * Returns null if remote is not https. The result MUST NOT be logged.
 */
function _injectTokenIntoHttpsUrl(remoteUrl, token) {
  if (!remoteUrl || !token) return null;
  const m = remoteUrl.match(/^https:\/\/([^@]+@)?([^/]+)(\/.+)$/i);
  if (!m) return null;
  return 'https://x-access-token:' + token + '@' + m[2] + m[3];
}

/**
 * Strip any embedded credentials from URLs in an error string so
 * stderr can be safely logged.
 */
function _redactTokenUrls(s) {
  return String(s).replace(/https:\/\/[^@\s]+@/g, 'https://<REDACTED>@');
}

module.exports = {
  autoShip,
  // exposed for tests; not part of public API
  _parseCommitSha,
  _isTlsError,
  _injectTokenIntoHttpsUrl,
  _redactTokenUrls,
};
