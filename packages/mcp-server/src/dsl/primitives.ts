import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database as DB } from 'better-sqlite3';
import { runWithTimeout } from './spawn-utils.js';
import { assertWithinCwd } from './path-utils.js';
import type { EvaluationResultPerPrimitive, PrimitiveName } from './types.js';

export interface EvalContext {
  db: DB;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  task_id?: string;
}

type PrimitiveFn = (args: unknown, ctx: EvalContext) => Promise<EvaluationResultPerPrimitive>;

// ── tests_pass ────────────────────────────────────────────────────────────────

async function tests_pass(rawArgs: unknown, ctx: EvalContext): Promise<EvaluationResultPerPrimitive> {
  const start = Date.now();
  const args = rawArgs as { target?: string };
  try {
    const target = args.target ?? '.';
    const check = assertWithinCwd(target, ctx.cwd);
    if (!check.ok) {
      return { primitive: 'tests_pass', args: rawArgs, status: 'FAIL', detail: `path check failed: ${check.reason}`, elapsed_ms: Date.now() - start };
    }
    const resolved = check.resolved;
    const pkgPath = path.join(resolved, 'package.json');
    let pkg: { scripts?: { test?: string } };
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: { test?: string } };
    } catch {
      return { primitive: 'tests_pass', args: rawArgs, status: 'FAIL', detail: `no scripts.test in package.json at ${resolved}`, elapsed_ms: Date.now() - start };
    }
    if (!pkg.scripts?.test) {
      return { primitive: 'tests_pass', args: rawArgs, status: 'FAIL', detail: `no scripts.test in package.json at ${resolved}`, elapsed_ms: Date.now() - start };
    }
    const cmd = pkg.scripts.test;
    const result = await runWithTimeout(cmd, { cwd: resolved, timeoutMs: ctx.timeoutMs, env: ctx.env });
    if (result.status === 'TIMEOUT') {
      return { primitive: 'tests_pass', args: rawArgs, status: 'TIMEOUT', detail: `tests timed out after ${result.elapsed_ms}ms`, elapsed_ms: Date.now() - start };
    }
    if (result.status === 'PASS') {
      return { primitive: 'tests_pass', args: rawArgs, status: 'PASS', detail: `tests passed in ${result.elapsed_ms}ms`, elapsed_ms: Date.now() - start };
    }
    const firstLine = result.stderr.split('\n')[0]?.slice(0, 120) ?? '';
    return { primitive: 'tests_pass', args: rawArgs, status: 'FAIL', detail: `tests failed (exit ${result.exitCode}): ${firstLine}`, elapsed_ms: Date.now() - start };
  } catch (e) {
    return { primitive: 'tests_pass', args: rawArgs, status: 'FAIL', detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}`, elapsed_ms: Date.now() - start };
  }
}

// ── command_exits_0 ───────────────────────────────────────────────────────────

async function command_exits_0(rawArgs: unknown, ctx: EvalContext): Promise<EvaluationResultPerPrimitive> {
  const start = Date.now();
  const args = rawArgs as { cmd: string; cwd?: string };
  try {
    let effectiveCwd = ctx.cwd;
    if (args.cwd !== undefined) {
      const check = assertWithinCwd(args.cwd, ctx.cwd);
      if (!check.ok) {
        return { primitive: 'command_exits_0', args: rawArgs, status: 'FAIL', detail: `path check failed: ${check.reason}`, elapsed_ms: Date.now() - start };
      }
      effectiveCwd = check.resolved;
    }
    const result = await runWithTimeout(args.cmd, { cwd: effectiveCwd, timeoutMs: ctx.timeoutMs, env: ctx.env });
    if (result.status === 'TIMEOUT') {
      return { primitive: 'command_exits_0', args: rawArgs, status: 'TIMEOUT', detail: `cmd timed out after ${result.elapsed_ms}ms`, elapsed_ms: Date.now() - start };
    }
    if (result.status === 'PASS') {
      return { primitive: 'command_exits_0', args: rawArgs, status: 'PASS', detail: 'cmd exited 0', elapsed_ms: Date.now() - start };
    }
    return { primitive: 'command_exits_0', args: rawArgs, status: 'FAIL', detail: `cmd exited ${result.exitCode}`, elapsed_ms: Date.now() - start };
  } catch (e) {
    return { primitive: 'command_exits_0', args: rawArgs, status: 'FAIL', detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}`, elapsed_ms: Date.now() - start };
  }
}

// ── file_exists ───────────────────────────────────────────────────────────────

async function file_exists(rawArgs: unknown, ctx: EvalContext): Promise<EvaluationResultPerPrimitive> {
  const start = Date.now();
  const args = rawArgs as { path: string };
  try {
    const check = assertWithinCwd(args.path, ctx.cwd);
    if (!check.ok) {
      return { primitive: 'file_exists', args: rawArgs, status: 'FAIL', detail: `path check failed: ${check.reason}`, elapsed_ms: Date.now() - start };
    }
    const exists = fs.existsSync(check.resolved);
    if (exists) {
      return { primitive: 'file_exists', args: rawArgs, status: 'PASS', detail: `file found: ${args.path}`, elapsed_ms: Date.now() - start };
    }
    return { primitive: 'file_exists', args: rawArgs, status: 'FAIL', detail: `file not found: ${args.path}`, elapsed_ms: Date.now() - start };
  } catch (e) {
    return { primitive: 'file_exists', args: rawArgs, status: 'FAIL', detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}`, elapsed_ms: Date.now() - start };
  }
}

// ── regex_matches ─────────────────────────────────────────────────────────────

async function regex_matches(rawArgs: unknown, ctx: EvalContext): Promise<EvaluationResultPerPrimitive> {
  const start = Date.now();
  const args = rawArgs as { file: string; pattern: string; flags?: string };
  try {
    const check = assertWithinCwd(args.file, ctx.cwd);
    if (!check.ok) {
      return { primitive: 'regex_matches', args: rawArgs, status: 'FAIL', detail: `path check failed: ${check.reason}`, elapsed_ms: Date.now() - start };
    }
    if (!fs.existsSync(check.resolved)) {
      return { primitive: 'regex_matches', args: rawArgs, status: 'FAIL', detail: 'file not found', elapsed_ms: Date.now() - start };
    }
    if (fs.statSync(check.resolved).size > 16 * 1024 * 1024) {
      return { primitive: 'regex_matches', args: rawArgs, status: 'FAIL', detail: 'file too large (>16MB)', elapsed_ms: Date.now() - start };
    }
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, args.flags ?? '');
    } catch (e) {
      return { primitive: 'regex_matches', args: rawArgs, status: 'FAIL', detail: `invalid regex: ${e instanceof Error ? e.message : String(e)}`, elapsed_ms: Date.now() - start };
    }
    const content = fs.readFileSync(check.resolved, 'utf8');
    const matched = regex.test(content);
    return { primitive: 'regex_matches', args: rawArgs, status: matched ? 'PASS' : 'FAIL', detail: matched ? 'pattern matched' : 'pattern not matched', elapsed_ms: Date.now() - start };
  } catch (e) {
    return { primitive: 'regex_matches', args: rawArgs, status: 'FAIL', detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}`, elapsed_ms: Date.now() - start };
  }
}

// ── scratchpad_key_exists ─────────────────────────────────────────────────────

async function scratchpad_key_exists(rawArgs: unknown, ctx: EvalContext): Promise<EvaluationResultPerPrimitive> {
  const start = Date.now();
  const args = rawArgs as { key: string; task_id?: string };
  try {
    const task_id = args.task_id ?? ctx.task_id;
    let row: unknown;
    if (task_id !== undefined) {
      row = ctx.db.prepare('SELECT 1 FROM scratchpad WHERE key = ? AND task_id = ? LIMIT 1').get(args.key, task_id);
    } else {
      row = ctx.db.prepare('SELECT 1 FROM scratchpad WHERE key = ? LIMIT 1').get(args.key);
    }
    if (row !== undefined) {
      return { primitive: 'scratchpad_key_exists', args: rawArgs, status: 'PASS', detail: 'key found', elapsed_ms: Date.now() - start };
    }
    return { primitive: 'scratchpad_key_exists', args: rawArgs, status: 'FAIL', detail: 'key not found', elapsed_ms: Date.now() - start };
  } catch (e) {
    return { primitive: 'scratchpad_key_exists', args: rawArgs, status: 'FAIL', detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}`, elapsed_ms: Date.now() - start };
  }
}

// ── no_open_conflicts ─────────────────────────────────────────────────────────

async function no_open_conflicts(rawArgs: unknown, ctx: EvalContext): Promise<EvaluationResultPerPrimitive> {
  const start = Date.now();
  const args = rawArgs as { scope_paths?: string[] };
  try {
    let count: number;
    if (!args.scope_paths || args.scope_paths.length === 0) {
      const row = ctx.db.prepare("SELECT COUNT(*) AS c FROM conflicts WHERE status = 'OPEN'").get() as { c: number };
      count = row.c;
    } else {
      const likes = args.scope_paths.map(() => "paths_json LIKE ?").join(' OR ');
      const params = args.scope_paths.map(p => `%${p}%`);
      const row = ctx.db.prepare(`SELECT COUNT(*) AS c FROM conflicts WHERE status = 'OPEN' AND (${likes})`).get(...params) as { c: number };
      count = row.c;
    }
    if (count === 0) {
      return { primitive: 'no_open_conflicts', args: rawArgs, status: 'PASS', detail: 'no open conflicts', elapsed_ms: Date.now() - start };
    }
    return { primitive: 'no_open_conflicts', args: rawArgs, status: 'FAIL', detail: `${count} open conflict(s)`, elapsed_ms: Date.now() - start };
  } catch (e) {
    return { primitive: 'no_open_conflicts', args: rawArgs, status: 'FAIL', detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}`, elapsed_ms: Date.now() - start };
  }
}

// ── checkpoint_created_after ──────────────────────────────────────────────────

async function checkpoint_created_after(rawArgs: unknown, ctx: EvalContext): Promise<EvaluationResultPerPrimitive> {
  const start = Date.now();
  const args = rawArgs as { timestamp: number; task_id?: string };
  try {
    const task_id = args.task_id ?? ctx.task_id;
    if (task_id === undefined) {
      return { primitive: 'checkpoint_created_after', args: rawArgs, status: 'FAIL', detail: 'task_id required (no ctx.task_id either)', elapsed_ms: Date.now() - start };
    }
    const row = ctx.db.prepare(
      "SELECT COUNT(*) AS c FROM checkpoints WHERE task_id = ? AND created_at > ? AND snapshot_status = 'READY'"
    ).get(task_id, args.timestamp) as { c: number };
    if (row.c > 0) {
      return { primitive: 'checkpoint_created_after', args: rawArgs, status: 'PASS', detail: `${row.c} READY checkpoint(s) after timestamp`, elapsed_ms: Date.now() - start };
    }
    return { primitive: 'checkpoint_created_after', args: rawArgs, status: 'FAIL', detail: 'no READY checkpoints after timestamp', elapsed_ms: Date.now() - start };
  } catch (e) {
    return { primitive: 'checkpoint_created_after', args: rawArgs, status: 'FAIL', detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}`, elapsed_ms: Date.now() - start };
  }
}

// ── Public map ────────────────────────────────────────────────────────────────

export const PRIMITIVE_FNS: Record<PrimitiveName, PrimitiveFn> = {
  tests_pass,
  command_exits_0,
  file_exists,
  regex_matches,
  scratchpad_key_exists,
  no_open_conflicts,
  checkpoint_created_after,
};
