import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Database as DB } from 'better-sqlite3';
import { openWorkspace } from '../../src/workspace.js';
import type { EvalContext } from '../../src/dsl/primitives.js';
import { evaluateCriteria } from '../../src/dsl/evaluator.js';
import type { OutcomePrimitive } from '../../src/dsl/types.js';

// ────────────────────────────────────────────────────────────────
// Shared fixture helpers
// ────────────────────────────────────────────────────────────────

const cleanups: Array<{ dir?: string; db?: DB }> = [];

afterEach(() => {
  for (const c of cleanups) {
    try { c.db?.close(); } catch { /* ignore */ }
    if (c.dir) fs.rmSync(c.dir, { recursive: true, force: true });
  }
  cleanups.length = 0;
});

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-eval-test-'));
  cleanups.push({ dir });
  return dir;
}

function makeTmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-eval-db-'));
  const ws = openWorkspace({ cairnRoot: dir });
  cleanups.push({ db: ws.db, dir });
  return ws.db;
}

function makeCtx(db: DB, cwd: string, overrides?: Partial<EvalContext>): EvalContext {
  return { db, cwd, env: process.env, timeoutMs: 5000, ...overrides };
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('evaluateCriteria', () => {
  // Case 1: single primitive PASS → overall PASS, perPrimitive length 1
  it('single primitive PASS → overall PASS, perPrimitive.length = 1', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(path.join(cwd, 'hello.txt'), 'hi');
    const criteria: OutcomePrimitive[] = [
      { primitive: 'file_exists', args: { path: 'hello.txt' } },
    ];
    const result = await evaluateCriteria(criteria, makeCtx(db, cwd));
    expect(result.status).toBe('PASS');
    expect(result.perPrimitive).toHaveLength(1);
    expect(result.perPrimitive[0].status).toBe('PASS');
  });

  // Case 2: single primitive FAIL → overall FAIL
  it('single primitive FAIL → overall FAIL', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const criteria: OutcomePrimitive[] = [
      { primitive: 'file_exists', args: { path: 'missing.txt' } },
    ];
    const result = await evaluateCriteria(criteria, makeCtx(db, cwd));
    expect(result.status).toBe('FAIL');
    expect(result.perPrimitive[0].status).toBe('FAIL');
  });

  // Case 3: multiple primitives all PASS → overall PASS (AND)
  it('multiple primitives all PASS → overall PASS', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a');
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'b');
    const criteria: OutcomePrimitive[] = [
      { primitive: 'file_exists', args: { path: 'a.txt' } },
      { primitive: 'file_exists', args: { path: 'b.txt' } },
    ];
    const result = await evaluateCriteria(criteria, makeCtx(db, cwd));
    expect(result.status).toBe('PASS');
    expect(result.perPrimitive).toHaveLength(2);
    expect(result.perPrimitive.every(p => p.status === 'PASS')).toBe(true);
  });

  // Case 4: multiple primitives, one FAIL among PASS → overall FAIL (AND)
  it('multiple primitives, one FAIL among PASS → overall FAIL', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a');
    const criteria: OutcomePrimitive[] = [
      { primitive: 'file_exists', args: { path: 'a.txt' } },       // PASS
      { primitive: 'file_exists', args: { path: 'missing.txt' } }, // FAIL
    ];
    const result = await evaluateCriteria(criteria, makeCtx(db, cwd));
    expect(result.status).toBe('FAIL');
    expect(result.perPrimitive[0].status).toBe('PASS');
    expect(result.perPrimitive[1].status).toBe('FAIL');
  });

  // Case 5: multiple primitives, one TIMEOUT → overall FAIL
  it('multiple primitives, one TIMEOUT → overall FAIL', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a');
    // timeoutMs = 500ms; the hanging node command will TIMEOUT
    const ctx = makeCtx(db, cwd, { timeoutMs: 500 });
    const criteria: OutcomePrimitive[] = [
      { primitive: 'file_exists', args: { path: 'a.txt' } },
      { primitive: 'command_exits_0', args: { cmd: 'node -e "setInterval(()=>{},1000)"' } },
    ];
    const result = await evaluateCriteria(criteria, ctx);
    expect(result.status).toBe('FAIL');
    const timeoutPrim = result.perPrimitive.find(p => p.status === 'TIMEOUT');
    expect(timeoutPrim).toBeDefined();
  }, 10000);

  // Case 6: summary markdown format check — header + bullet shape, correct symbols
  it('summary markdown has correct header + bullets with ✓/✗/⏱ symbols', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    fs.writeFileSync(path.join(cwd, 'exists.txt'), 'hi');
    const ctx = makeCtx(db, cwd, { timeoutMs: 500 });
    const criteria: OutcomePrimitive[] = [
      { primitive: 'file_exists', args: { path: 'exists.txt' } },   // PASS → ✓
      { primitive: 'file_exists', args: { path: 'nope.txt' } },      // FAIL → ✗
      { primitive: 'command_exits_0', args: { cmd: 'node -e "setInterval(()=>{},1000)"' } }, // TIMEOUT → ⏱
    ];
    const result = await evaluateCriteria(criteria, ctx);
    expect(result.summary).toMatch(/^## Evaluation result: FAIL/);
    // blank line after header
    expect(result.summary).toMatch(/## Evaluation result: FAIL\n\n/);
    // PASS bullet uses ✓
    expect(result.summary).toContain('[✓]');
    // FAIL bullet uses ✗
    expect(result.summary).toContain('[✗]');
    // TIMEOUT bullet uses ⏱
    expect(result.summary).toContain('[⏱]');
    // each bullet line starts with "- ["
    const lines = result.summary.split('\n');
    const bulletLines = lines.filter(l => l.startsWith('- ['));
    expect(bulletLines).toHaveLength(3);
    // elapsed_ms appears in each bullet
    for (const line of bulletLines) {
      expect(line).toMatch(/\(\d+ms\)$/);
    }
  }, 10000);

  // Case 7: elapsed_ms is recorded per primitive (> 0 for spawned commands)
  it('elapsed_ms is recorded; command primitives have elapsed_ms > 0', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const criteria: OutcomePrimitive[] = [
      { primitive: 'command_exits_0', args: { cmd: 'node -e "process.exit(0)"' } },
    ];
    const result = await evaluateCriteria(criteria, makeCtx(db, cwd));
    expect(result.perPrimitive[0].elapsed_ms).toBeGreaterThan(0);
  });

  // Case 8: GraderHook passed but IGNORED — grader.evaluate never called
  it('GraderHook passed but IGNORED: output comes from deterministic primitives only', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    // criteria known to FAIL (file missing)
    const criteria: OutcomePrimitive[] = [
      { primitive: 'file_exists', args: { path: 'definitely-absent.txt' } },
    ];
    const mockEvaluate = vi.fn().mockResolvedValue({ status: 'PASS', perPrimitive: [], summary: 'bogus' });
    const grader = { evaluate: mockEvaluate };
    const result = await evaluateCriteria(criteria, makeCtx(db, cwd), { grader });
    // grader ignored → deterministic result is FAIL, not bogus PASS
    expect(result.status).toBe('FAIL');
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  // Bonus: empty criteria array → defensive FAIL
  it('empty criteria array → FAIL with (no criteria) summary', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const result = await evaluateCriteria([], makeCtx(db, cwd));
    expect(result.status).toBe('FAIL');
    expect(result.perPrimitive).toHaveLength(0);
    expect(result.summary).toContain('(no criteria)');
  });

  // Bonus: unknown primitive → defensive FAIL with 'unknown primitive' detail
  it('unknown primitive → FAIL with unknown primitive detail', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const criteria = [
      { primitive: 'totally_fake' as 'file_exists', args: { path: 'x' } },
    ] as OutcomePrimitive[];
    const result = await evaluateCriteria(criteria, makeCtx(db, cwd));
    expect(result.status).toBe('FAIL');
    expect(result.perPrimitive[0].detail).toBe('unknown primitive');
    expect(result.perPrimitive[0].elapsed_ms).toBe(0);
  });

  // AND correctness: all TIMEOUT → overall FAIL (no third status)
  it('all-TIMEOUT criteria → overall FAIL (no TIMEOUT overall status)', async () => {
    const cwd = makeTmpDir();
    const db = makeTmpDb();
    const ctx = makeCtx(db, cwd, { timeoutMs: 300 });
    const criteria: OutcomePrimitive[] = [
      { primitive: 'command_exits_0', args: { cmd: 'node -e "setInterval(()=>{},1000)"' } },
    ];
    const result = await evaluateCriteria(criteria, ctx);
    expect(result.status).toBe('FAIL'); // overall is always PASS|FAIL, never TIMEOUT
    expect(result.perPrimitive[0].status).toBe('TIMEOUT');
  }, 10000);
});
