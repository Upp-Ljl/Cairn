/**
 * spawn-utils.ts
 *
 * The ONLY file in packages/mcp-server/src/dsl/ that imports node:child_process.
 * All subprocess execution + kill logic for DSL primitive evaluation lives here.
 *
 * Strategy (§7.1 v1 — Windows: taskkill /F /T /PID; POSIX: detached + SIGTERM/SIGKILL):
 * - Windows: child_process.exec(`taskkill /F /T /PID ${pid}`) kills the whole tree.
 * - POSIX: spawn with detached:true → process.kill(-pid, 'SIGTERM') → 5s grace → SIGKILL.
 */

import { spawn, exec } from 'node:child_process';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export interface SpawnResult {
  /** PASS = exit 0, FAIL = non-zero exit or spawn error, TIMEOUT = killed by timer */
  status: 'PASS' | 'FAIL' | 'TIMEOUT';
  exitCode: number | null;
  /** Captured stdout, capped to 64 KB and ANSI-escape-stripped. */
  stdout: string;
  /** Captured stderr, capped to 64 KB and ANSI-escape-stripped. */
  stderr: string;
  /** true if either stream was truncated at the 64 KB cap. */
  truncated: boolean;
  elapsed_ms: number;
  /** pid of the spawned process (useful for post-hoc zombie checks in tests). */
  pid: number | undefined;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Maximum bytes captured per stream (stdout or stderr). */
const MAX_STREAM_BYTES = 65_536; // 64 KB

/** Regex for stripping common ANSI SGR escape sequences. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// ────────────────────────────────────────────────────────────────
// Module-private helpers
// ────────────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Kill the child process and its entire tree.
 * - Windows: taskkill /F /T /PID (kills the full process tree atomically).
 * - POSIX: SIGTERM to negative PID (process group) → wait graceMs → SIGKILL.
 *
 * Always returns a Promise<void>; never throws.
 */
async function killChildTree(
  child: ReturnType<typeof spawn>,
  graceMs: number,
): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      exec(`taskkill /F /T /PID ${child.pid}`, () => resolve());
    });
  } else {
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      // Process may already be gone — ignore.
    }
    await new Promise<void>((r) => setTimeout(r, graceMs));
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already dead — ignore.
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Run `cmd` in a shell, capturing stdout + stderr, with a hard timeout.
 *
 * Output is capped at 64 KB per stream; excess bytes are discarded and
 * `truncated` is set to true.  ANSI escape sequences are stripped before
 * returning.
 *
 * The spawned environment always sets CI=1, NO_COLOR=1, FORCE_COLOR=0,
 * then merges opts.env on top (allowing callers to override or add vars).
 */
export async function runWithTimeout(
  cmd: string,
  opts: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<SpawnResult> {
  const start = Date.now();

  const child = spawn(cmd, [], {
    shell: true,
    cwd: opts.cwd,
    env: {
      ...process.env,
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  // Spawn failure (e.g. cwd does not exist): pid is undefined.
  if (child.pid === undefined) {
    // Wait briefly for the 'error' event to fire so we capture its message.
    const errMsg = await new Promise<string>((resolve) => {
      let msg = 'spawn failed';
      child.on('error', (err) => { msg = err.message; });
      // Give the event loop a tick to fire the error handler.
      setTimeout(() => resolve(msg), 100);
    });
    return {
      status: 'FAIL',
      exitCode: null,
      stdout: '',
      stderr: errMsg,
      truncated: false,
      elapsed_ms: Date.now() - start,
      pid: undefined,
    };
  }

  const spawnedPid = child.pid;

  let stdoutBuf = '';
  let stderrBuf = '';
  let truncated = false;

  // Accumulate stream data, stopping at the 64 KB cap.
  child.stdout.on('data', (chunk: Buffer) => {
    const chunkStr = chunk.toString('utf8');
    const remaining = MAX_STREAM_BYTES - Buffer.byteLength(stdoutBuf, 'utf8');
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    if (Buffer.byteLength(chunkStr, 'utf8') > remaining) {
      // Take only as many characters as fit within the byte budget.
      // Safe approximation: slice characters until we exceed the budget.
      let taken = '';
      for (const ch of chunkStr) {
        if (Buffer.byteLength(taken + ch, 'utf8') > remaining) break;
        taken += ch;
      }
      stdoutBuf += taken;
      truncated = true;
    } else {
      stdoutBuf += chunkStr;
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const chunkStr = chunk.toString('utf8');
    const remaining = MAX_STREAM_BYTES - Buffer.byteLength(stderrBuf, 'utf8');
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    if (Buffer.byteLength(chunkStr, 'utf8') > remaining) {
      let taken = '';
      for (const ch of chunkStr) {
        if (Buffer.byteLength(taken + ch, 'utf8') > remaining) break;
        taken += ch;
      }
      stderrBuf += taken;
      truncated = true;
    } else {
      stderrBuf += chunkStr;
    }
  });

  return new Promise<SpawnResult>((resolve) => {
    let settled = false;
    let timedOut = false;

    const settle = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      resolve({
        ...result,
        stdout: stripAnsi(result.stdout),
        stderr: stripAnsi(result.stderr),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the child tree, then wait for the 'close' event (capped at 1 s).
      void killChildTree(child, 5000).then(() => {
        // Wait for the process to close, but cap at 1 second to avoid hangs.
        const closeTimeout = setTimeout(() => {
          settle({
            status: 'TIMEOUT',
            exitCode: null,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            truncated,
            elapsed_ms: Date.now() - start,
            pid: spawnedPid,
          });
        }, 1000);

        // If close fires before the cap, prefer it.
        child.once('close', () => {
          clearTimeout(closeTimeout);
          if (!settled) {
            settle({
              status: 'TIMEOUT',
              exitCode: null,
              stdout: stdoutBuf,
              stderr: stderrBuf,
              truncated,
              elapsed_ms: Date.now() - start,
              pid: spawnedPid,
            });
          }
        });
      });
    }, opts.timeoutMs);

    child.on('close', (code) => {
      if (timedOut) return; // timeout handler takes precedence
      clearTimeout(timer);
      settle({
        status: code === 0 ? 'PASS' : 'FAIL',
        exitCode: code,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        truncated,
        elapsed_ms: Date.now() - start,
        pid: spawnedPid,
      });
    });

    child.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      settle({
        status: 'FAIL',
        exitCode: null,
        stdout: stdoutBuf,
        stderr: stderrBuf + (stderrBuf ? '\n' : '') + err.message,
        truncated,
        elapsed_ms: Date.now() - start,
        pid: spawnedPid,
      });
    });
  });
}
