/**
 * spawn-utils.test.ts — production tests for runWithTimeout.
 *
 * These tests spawn real Node.js subprocesses; run serially (no parallel).
 * Expected total runtime: 10-20 s on a typical machine.
 *
 * NOTE: SpawnResult includes `pid` to enable post-hoc zombie checks.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { runWithTimeout } from '../../src/dsl/spawn-utils.js';

/** Repo root directory — used as a valid cwd for most tests. */
const REPO_ROOT = process.cwd();

// ─── 1. Quick PASS ───────────────────────────────────────────────────────────

it('quick PASS: node -e "process.exit(0)"', async () => {
  const r = await runWithTimeout('node -e "process.exit(0)"', {
    cwd: REPO_ROOT,
    timeoutMs: 10_000,
  });
  expect(r.status).toBe('PASS');
  expect(r.exitCode).toBe(0);
  expect(r.elapsed_ms).toBeGreaterThanOrEqual(0);
  expect(r.elapsed_ms).toBeLessThan(5_000);
});

// ─── 2. Quick FAIL ──────────────────────────────────────────────────────────

it('quick FAIL: node -e "process.exit(1)"', async () => {
  const r = await runWithTimeout('node -e "process.exit(1)"', {
    cwd: REPO_ROOT,
    timeoutMs: 10_000,
  });
  expect(r.status).toBe('FAIL');
  expect(r.exitCode).toBe(1);
});

// ─── 3. Timeout ─────────────────────────────────────────────────────────────

it(
  'timeout: infinite loop is killed within grace period',
  async () => {
    const r = await runWithTimeout('node -e "setInterval(()=>{}, 1000)"', {
      cwd: REPO_ROOT,
      timeoutMs: 2_000,
    });
    expect(r.status).toBe('TIMEOUT');
    expect(r.exitCode).toBeNull();
    // elapsed should be at least the timeout ms but not absurdly long
    expect(r.elapsed_ms).toBeGreaterThanOrEqual(1_900);
    expect(r.elapsed_ms).toBeLessThan(15_000);
  },
  { timeout: 20_000 },
);

// ─── 4. Post-timeout PID verification ───────────────────────────────────────
// SpawnResult includes `pid`. After a timeout, verify the PID is no longer
// listed by the OS process table.

it(
  'post-timeout zombie check: PID is gone after TIMEOUT',
  async () => {
    const r = await runWithTimeout('node -e "setInterval(()=>{}, 1000)"', {
      cwd: REPO_ROOT,
      timeoutMs: 2_000,
    });
    expect(r.status).toBe('TIMEOUT');

    const pid = r.pid;
    if (pid === undefined) return; // spawn failed outright — skip check

    // Brief settle to let taskkill fully clean up.
    await new Promise((res) => setTimeout(res, 300));

    if (process.platform === 'win32') {
      // tasklist exits 0 even when PID is absent; check the text output.
      let tasklistOut = '';
      try {
        tasklistOut = execSync(`tasklist /FI "PID eq ${pid}"`, {
          encoding: 'utf8',
          timeout: 5_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        // tasklist itself failed — treat as PID gone.
        tasklistOut = '';
      }
      // tasklist includes the literal PID in the row only when alive.
      expect(tasklistOut).not.toContain(String(pid));
    } else {
      // POSIX: `ps -p <pid>` exits 1 when PID is gone.
      let pidAlive = false;
      try {
        execSync(`ps -p ${pid}`, { stdio: ['ignore', 'ignore', 'ignore'] });
        pidAlive = true;
      } catch {
        pidAlive = false;
      }
      expect(pidAlive).toBe(false);
    }
  },
  { timeout: 20_000 },
);

// ─── 5. Quoted args ─────────────────────────────────────────────────────────

it('quoted args: stdout contains "hello world"', async () => {
  const r = await runWithTimeout(`node -e "console.log('hello world')"`, {
    cwd: REPO_ROOT,
    timeoutMs: 10_000,
  });
  expect(r.status).toBe('PASS');
  expect(r.stdout).toContain('hello world');
});

// ─── 6. Output truncation ────────────────────────────────────────────────────

it(
  'output truncation: >100 KB stdout is capped at 64 KB and truncated=true',
  async () => {
    // Each line is ~101 bytes; 5000 lines = ~505 KB.
    const r = await runWithTimeout(
      `node -e "for(let i=0;i<5000;i++){console.log('a'.repeat(100))}"`,
      { cwd: REPO_ROOT, timeoutMs: 30_000 },
    );
    // Exit 0 — PASS despite truncation.
    expect(r.status).toBe('PASS');
    expect(r.truncated).toBe(true);
    // After ANSI strip, stdout must be within the cap.
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(65_536);
  },
  { timeout: 35_000 },
);

// ─── 7. ANSI strip ──────────────────────────────────────────────────────────

it('ANSI strip: colour codes removed, plain text preserved', async () => {
  // The inner quotes must survive the shell; double-escape the escape char.
  const r = await runWithTimeout(
    String.raw`node -e "process.stdout.write('\x1b[31mred\x1b[0m\n')"`,
    { cwd: REPO_ROOT, timeoutMs: 10_000 },
  );
  expect(r.status).toBe('PASS');
  expect(r.stdout).toContain('red');
  expect(r.stdout).not.toContain('\x1b[');
});

// ─── 8. Custom env passthrough ──────────────────────────────────────────────

it('custom env: CAIRN_TEST_VAR is visible inside the child', async () => {
  const r = await runWithTimeout(
    'node -e "console.log(process.env.CAIRN_TEST_VAR)"',
    {
      cwd: REPO_ROOT,
      timeoutMs: 10_000,
      env: { CAIRN_TEST_VAR: 'foo' },
    },
  );
  expect(r.status).toBe('PASS');
  expect(r.stdout.trim()).toBe('foo');
});

// ─── 9. Spawn failure (non-existent cwd) ────────────────────────────────────

it('spawn failure: non-existent cwd returns FAIL, no throw', async () => {
  const r = await runWithTimeout('node -e "process.exit(0)"', {
    cwd: 'D:/__nonexistent_cairn_dir__',
    timeoutMs: 10_000,
  });
  // Must not throw; must return FAIL or handle gracefully.
  expect(['FAIL', 'TIMEOUT']).toContain(r.status);
  expect(r.elapsed_ms).toBeGreaterThanOrEqual(0);
});

// ─── 10. elapsed_ms sanity ──────────────────────────────────────────────────

it('elapsed_ms is >= 0 for instant exits', async () => {
  const r = await runWithTimeout('node -e "process.exit(0)"', {
    cwd: REPO_ROOT,
    timeoutMs: 10_000,
  });
  expect(r.elapsed_ms).toBeGreaterThanOrEqual(0);
});

// ─── 11. Stderr is captured ─────────────────────────────────────────────────

it('stderr is captured from child process', async () => {
  const r = await runWithTimeout(
    `node -e "process.stderr.write('err-output\\n'); process.exit(1)"`,
    { cwd: REPO_ROOT, timeoutMs: 10_000 },
  );
  expect(r.status).toBe('FAIL');
  expect(r.stderr).toContain('err-output');
});

// ─── 12. Non-zero exit code preserved ───────────────────────────────────────

it('non-zero exit code is preserved in exitCode field', async () => {
  const r = await runWithTimeout('node -e "process.exit(42)"', {
    cwd: REPO_ROOT,
    timeoutMs: 10_000,
  });
  expect(r.status).toBe('FAIL');
  expect(r.exitCode).toBe(42);
});
