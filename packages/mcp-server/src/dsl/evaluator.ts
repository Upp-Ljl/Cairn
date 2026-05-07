import type { OutcomePrimitive, EvaluationResult, GraderHook } from './types.js';
import type { EvalContext } from './primitives.js';
import { PRIMITIVE_FNS } from './primitives.js';

// LD-11: grader hook reserved for v0.2; v1 evaluator is deterministic only
export async function evaluateCriteria(
  criteria: OutcomePrimitive[],
  ctx: EvalContext,
  options?: { grader?: GraderHook },
): Promise<EvaluationResult> {
  void options; // LD-11: grader hook intentionally ignored in v1

  if (criteria.length === 0) {
    return {
      status: 'FAIL',
      perPrimitive: [],
      summary: '## Evaluation result: FAIL\n\n(no criteria)',
    };
  }

  const perPrimitive: EvaluationResult['perPrimitive'] = [];

  for (const criterion of criteria) {
    const fn = PRIMITIVE_FNS[criterion.primitive as keyof typeof PRIMITIVE_FNS];
    if (fn === undefined) {
      perPrimitive.push({
        primitive: criterion.primitive,
        args: criterion.args,
        status: 'FAIL',
        detail: 'unknown primitive',
        elapsed_ms: 0,
      });
      continue;
    }
    try {
      const result = await fn(criterion.args, ctx);
      perPrimitive.push(result);
    } catch (e) {
      perPrimitive.push({
        primitive: criterion.primitive,
        args: criterion.args,
        status: 'FAIL',
        detail: `evaluator caught unexpected throw: ${e instanceof Error ? e.message : String(e)}`,
        elapsed_ms: 0,
      });
    }
  }

  const overallStatus: 'PASS' | 'FAIL' = perPrimitive.every(p => p.status === 'PASS') ? 'PASS' : 'FAIL';

  const bullets = perPrimitive.map(p => {
    const symbol = p.status === 'PASS' ? '✓' : p.status === 'TIMEOUT' ? '⏱' : '✗';
    const rawArgs = JSON.stringify(p.args);
    const argsSummary = rawArgs.length > 60 ? rawArgs.slice(0, 60) + '...' : rawArgs;
    return `- [${symbol}] ${p.primitive}(${argsSummary}) — ${p.detail} (${p.elapsed_ms}ms)`;
  });

  const summary = `## Evaluation result: ${overallStatus}\n\n${bullets.join('\n')}`;

  return { status: overallStatus, perPrimitive, summary };
}
