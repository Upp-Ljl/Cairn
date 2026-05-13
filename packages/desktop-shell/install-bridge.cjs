'use strict';

/**
 * install-bridge — daemon-side wrapper around the `cairn install` CLI.
 *
 * Cairn is a daemon-class desktop app; the user's first-touch is the
 * panel's `＋ Add project…` button, not a terminal command. This bridge
 * lets `main.cjs::ipcMain.handle('add-project', …)` perform the same
 * idempotent wire-up (.mcp.json + pre-commit hook + start-cairn-pet
 * launchers + CAIRN.md scaffold) that `cairn install` performs from a
 * terminal — without lifting any fs side effects into the Electron
 * main process.
 *
 * Implementation note (D-3 in 2026-05-14-bootstrap-grill plan):
 * spawn-child, NOT require(). Reasons:
 *   - keeps the CLI as the single source of truth for install behaviour
 *   - preserves idempotency guarantees the CLI was authored with
 *   - avoids putting node-fs / node-path / node-os side effects into
 *     Electron's main process
 *   - parses a single line of JSON; trivial protocol
 *
 * Caller contract:
 *   runInstallInProject({ projectRoot, mcpServerEntryDir? })
 *     → Promise<InstallResult & { targetDir: string } | { ok: false, error: string }>
 *
 * Failure modes:
 *   - CLI binary not found → returns { ok: false, error: 'cli_not_found' }
 *   - CLI exits non-zero with JSON → JSON is returned verbatim (ok: false)
 *   - CLI exits non-zero with no JSON → { ok: false, error: '<stderr>', exit: <code> }
 *   - CLI hangs > timeoutMs → child killed, returns { ok: false, error: 'timeout' }
 *
 * No environment-mutating side effects in this file. Pure spawn + parse.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Resolve the path to the cairn-install CLI binary inside this monorepo.
 *
 * When desktop-shell runs from `packages/desktop-shell/`, the sibling
 * CLI is at `packages/mcp-server/dist/cli/install.js`. Tests pass
 * `mcpServerDistCli` directly to bypass path math.
 *
 * @param {string} [override] absolute path; if provided, used as-is
 * @returns {string|null} absolute path to install.js or null when not built
 */
function resolveInstallCliPath(override) {
  if (override) {
    return fs.existsSync(override) ? override : null;
  }

  // 1. Packaged app: electron-builder copies mcp-server dist to
  //    <app>/resources/mcp-server/  (via extraResources in package.json).
  //    process.resourcesPath points to that resources/ dir at runtime.
  //    app.isPackaged is true only when running from the installed .exe/.app.
  try {
    const { app } = require('electron');
    if (app && app.isPackaged && process.resourcesPath) {
      const bundled = path.join(process.resourcesPath, 'mcp-server', 'dist', 'cli', 'install.js');
      if (fs.existsSync(bundled)) return bundled;
    }
  } catch (_e) { /* not in electron context (unit tests) — fall through */ }

  // 2. Dev / monorepo checkout: packages/desktop-shell/ → ../mcp-server/dist/…
  const candidate = path.resolve(__dirname, '..', 'mcp-server', 'dist', 'cli', 'install.js');
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Run `cairn install --json` against a target project directory.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot         absolute path the user picked in "Add project"
 * @param {string} [opts.mcpServerCliPath]  absolute path to install.js (test override)
 * @param {number} [opts.timeoutMs]         default 30s
 * @param {(line: string) => void} [opts.onStderr]  optional stderr line callback for debugging
 * @returns {Promise<object>} parsed result; always resolves (never rejects)
 */
function runInstallInProject(opts) {
  const o = opts || {};
  if (!o.projectRoot || typeof o.projectRoot !== 'string') {
    return Promise.resolve({ ok: false, error: 'projectRoot_required' });
  }
  const cliPath = resolveInstallCliPath(o.mcpServerCliPath);
  if (!cliPath) {
    return Promise.resolve({
      ok: false,
      error: 'cli_not_found',
      hint: 'run `cd packages/mcp-server && npm run build` to produce dist/cli/install.js',
    });
  }
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, '--json'], {
      cwd: o.projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch (_e) { /* ignore */ }
      settle({ ok: false, error: 'timeout', timeoutMs, stdout, stderr });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderr += s;
      if (typeof o.onStderr === 'function') {
        for (const line of s.split('\n')) {
          if (line.trim()) o.onStderr(line);
        }
      }
    });

    child.on('error', (err) => {
      settle({ ok: false, error: 'spawn_failed', detail: err && err.message ? err.message : String(err) });
    });

    child.on('close', (code) => {
      const trimmed = stdout.trim();
      // The CLI emits exactly one JSON line in --json mode (success OR failure).
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          // Stamp the exit code so callers can distinguish "CLI returned ok:false"
          // from "CLI returned ok:true with a non-fatal warning" etc.
          parsed._exit = code;
          settle(parsed);
          return;
        } catch (_e) {
          // fall through to stderr-based error path
        }
      }
      settle({
        ok: false,
        error: 'cli_no_json_output',
        exit: code,
        stderr: stderr.trim(),
        stdout: trimmed,
      });
    });
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  resolveInstallCliPath,
  runInstallInProject,
};
