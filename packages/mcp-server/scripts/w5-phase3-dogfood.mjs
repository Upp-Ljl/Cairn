#!/usr/bin/env node
/**
 * W5 Phase 3 — Live Dogfood: outcomes closed-loop (FAIL→fix→PASS + terminal_fail)
 *
 * Proves the outcomes closed-loop through real MCP stdio across multiple processes:
 *
 * Session A1:
 *   1. cairn.task.create                          → PENDING task (taskId1)
 *   2. cairn.task.start_attempt                   → RUNNING
 *   3. process exit — A1 is gone
 *
 * Session B (different OS PID):
 *   4. Boundary A: submit_for_review (no criteria) → EMPTY_CRITERIA error (LD-12)
 *   5. submit_for_review(criteria=[file_exists:WILL_NOT_EXIST.tmp])
 *                                                  → outcome PENDING + task WAITING_REVIEW
 *   6. Boundary B: submit_for_review (different criteria)
 *                                                  → CRITERIA_FROZEN error (LD-12)
 *   7. outcomes.evaluate                           → FAIL (file absent) + task RUNNING
 *   8. Boundary C: outcomes.evaluate again (FAIL state)
 *                                                  → OUTCOME_NEEDS_RESUBMIT
 *   9. [fix: write the file via fs.writeFileSync]
 *  10. submit_for_review (no criteria — upsert reset)
 *                                                  → PENDING + outcome_id stable + criteria_json stable
 *  11. outcomes.evaluate                           → PASS + task DONE
 *  12. Boundary D: outcomes.evaluate again (PASS)  → OUTCOME_ALREADY_PASSED
 *  13. Second task: create + start + submit (fail criteria) + terminal_fail
 *                                                  → outcome TERMINAL_FAIL + task FAILED
 *  14. B exits
 *
 * Session A2 (re-spawned, cross-process durability):
 *  15. task.get(taskId1) → DONE
 *  16. task.get(taskId2) → FAILED
 *
 * Plus invariants:
 *   - 3 new Phase 3 tools registered: submit_for_review / outcomes.evaluate / outcomes.terminal_fail
 *   - LD-8 wall: cairn.outcomes.list / cairn.outcomes.get NOT present
 *
 * Run from packages/mcp-server: `node scripts/w5-phase3-dogfood.mjs`
 * Requires `dist/index.js` to be built first: `npm run build`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = resolve(here, '..');
const serverEntry = resolve(mcpServerRoot, 'dist/index.js');

// Create a real tmp dir so file_exists primitive can flip FAIL → PASS
const tmpDir = mkdtempSync(join(tmpdir(), 'cairn-phase3-dogfood-'));
console.log(`tmp dir: ${tmpDir}`);

function parseToolResult(res) {
  if (!res || !Array.isArray(res.content) || res.content.length === 0) {
    return res;
  }
  const first = res.content[0];
  if (first.type !== 'text') return res;
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

async function spawnSession(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    // cwd determines ws.cwd for path-utils (file_exists primitive resolves relative to it)
    cwd: tmpDir,
  });
  const client = new Client({ name, version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

function logStep(n, label, payload) {
  console.log(`\n── STEP ${n}: ${label} ──`);
  console.log(JSON.stringify(payload, null, 2));
}

// Inline LD-5 packet validator (mirrors validateResumePacket in resume-packet.ts)
function isResumePacketShapeValid(p) {
  if (!p || typeof p !== 'object') return ['not an object'];
  const errors = [];
  if (typeof p.task_id !== 'string') errors.push('task_id not string');
  if (typeof p.intent !== 'string') errors.push('intent not string');
  if (typeof p.current_state !== 'string') errors.push('current_state not string');
  if (p.last_checkpoint_sha !== null && typeof p.last_checkpoint_sha !== 'string') errors.push('last_checkpoint_sha not string|null');
  if (!Array.isArray(p.open_blockers)) errors.push('open_blockers not array');
  if (!Array.isArray(p.answered_blockers)) errors.push('answered_blockers not array');
  if (!Array.isArray(p.scratchpad_keys)) errors.push('scratchpad_keys not array');
  if (!Array.isArray(p.outcomes_criteria)) errors.push('outcomes_criteria not array');
  if (typeof p.audit_trail_summary !== 'string') errors.push('audit_trail_summary not string');
  return errors;
}

async function main() {
  console.log(`server entry: ${serverEntry}`);

  const checks = [];

  // ── invariant checks via A1 ──
  const A1 = await spawnSession('w5-phase3-session-A1');

  let taskId1, taskId2, outcomeId1, outcomeId2, criteriaJson1;

  try {
    const tools = (await A1.client.listTools()).tools.map((t) => t.name);
    const taskTools = tools.filter((n) => n.startsWith('cairn.task.')).sort();
    const outcomesTools = tools.filter((n) => n.startsWith('cairn.outcomes.')).sort();
    console.log('registered cairn.task.* tools:', taskTools);
    console.log('registered cairn.outcomes.* tools:', outcomesTools);

    // Invariant: 3 new Phase 3 tools present
    checks.push({
      name: 'tools/list: cairn.task.submit_for_review registered',
      ok: tools.includes('cairn.task.submit_for_review'),
    });
    checks.push({
      name: 'tools/list: cairn.outcomes.evaluate registered',
      ok: tools.includes('cairn.outcomes.evaluate'),
    });
    checks.push({
      name: 'tools/list: cairn.outcomes.terminal_fail registered',
      ok: tools.includes('cairn.outcomes.terminal_fail'),
    });
    // LD-8 wall: list / get must NOT be present
    checks.push({
      name: 'LD-8 wall: cairn.outcomes.list and cairn.outcomes.get NOT registered',
      ok: !tools.includes('cairn.outcomes.list') && !tools.includes('cairn.outcomes.get'),
    });

    // ── Step 1: A1 creates task ──
    const r1 = parseToolResult(
      await A1.client.callTool({
        name: 'cairn.task.create',
        arguments: { intent: 'W5 Phase 3 dogfood — outcomes closed-loop' },
      }),
    );
    logStep(1, 'A1: cairn.task.create', r1);
    taskId1 = r1.task.task_id;
    checks.push({ name: 'step 1: task PENDING on create', ok: r1.task.state === 'PENDING' });

    // ── Step 2: A1 starts attempt ──
    const r2 = parseToolResult(
      await A1.client.callTool({
        name: 'cairn.task.start_attempt',
        arguments: { task_id: taskId1 },
      }),
    );
    logStep(2, 'A1: cairn.task.start_attempt → RUNNING', r2);
    checks.push({ name: 'step 2: task RUNNING after start_attempt', ok: r2.task.state === 'RUNNING' });

    // ── Step 3: close A1 (genuine session A leaves) ──
    await A1.client.close();
    console.log('\n── STEP 3: A1 closed (session A has exited) ──');

    // ── Session B opens ──
    const B = await spawnSession('w5-phase3-session-B');

    try {
      // ── Step 4: Boundary A — submit without criteria (first call) → EMPTY_CRITERIA ──
      const r4 = parseToolResult(
        await B.client.callTool({
          name: 'cairn.task.submit_for_review',
          arguments: { task_id: taskId1 },
        }),
      );
      logStep(4, 'B: submit_for_review (no criteria, first call) → boundary EMPTY_CRITERIA', r4);
      checks.push({
        name: 'step 4 (boundary A): EMPTY_CRITERIA error on first submit without criteria',
        ok: r4?.error?.code === 'EMPTY_CRITERIA',
      });

      // ── Step 5: submit with criteria → outcome PENDING + task WAITING_REVIEW ──
      const r5 = parseToolResult(
        await B.client.callTool({
          name: 'cairn.task.submit_for_review',
          arguments: {
            task_id: taskId1,
            criteria: [{ primitive: 'file_exists', args: { path: 'WILL_NOT_EXIST.tmp' } }],
          },
        }),
      );
      logStep(5, 'B: submit_for_review(criteria=[file_exists:WILL_NOT_EXIST.tmp]) → PENDING+WAITING_REVIEW', r5);
      outcomeId1 = r5.outcome?.outcome_id;
      // criteria is returned as a parsed array (OutcomeRow.criteria); stringify for stable comparison
      criteriaJson1 = JSON.stringify(r5.outcome?.criteria);
      checks.push({
        name: 'step 5: task.state WAITING_REVIEW after submit_for_review',
        ok: r5.task?.state === 'WAITING_REVIEW',
      });
      checks.push({
        name: 'step 5: outcome.status PENDING',
        ok: r5.outcome?.status === 'PENDING',
      });
      checks.push({
        name: 'step 5: outcome_id recorded (non-null)',
        ok: typeof outcomeId1 === 'string' && outcomeId1.length > 0,
      });

      // ── Step 6: Boundary B — repeat submit with DIFFERENT criteria → CRITERIA_FROZEN ──
      const r6 = parseToolResult(
        await B.client.callTool({
          name: 'cairn.task.submit_for_review',
          arguments: {
            task_id: taskId1,
            criteria: [{ primitive: 'file_exists', args: { path: 'DIFFERENT.tmp' } }],
          },
        }),
      );
      logStep(6, 'B: submit_for_review (different criteria) → boundary CRITERIA_FROZEN', r6);
      checks.push({
        name: 'step 6 (boundary B): CRITERIA_FROZEN error on conflicting criteria',
        ok: r6?.error?.code === 'CRITERIA_FROZEN',
      });

      // ── Step 7: evaluate → FAIL (file absent) + task back to RUNNING ──
      const r7 = parseToolResult(
        await B.client.callTool({
          name: 'cairn.outcomes.evaluate',
          arguments: { outcome_id: outcomeId1 },
        }),
      );
      logStep(7, 'B: cairn.outcomes.evaluate → FAIL (WILL_NOT_EXIST.tmp absent)', r7);
      checks.push({
        name: 'step 7: evaluation result.status FAIL',
        ok: r7?.evaluation?.status === 'FAIL',
      });
      checks.push({
        name: 'step 7: task.state back to RUNNING after FAIL evaluate',
        ok: r7?.task?.state === 'RUNNING',
      });
      checks.push({
        name: 'step 7: outcome.status FAIL',
        ok: r7?.outcome?.status === 'FAIL',
      });
      checks.push({
        name: 'step 7: outcome_id stable after evaluate',
        ok: r7?.outcome?.outcome_id === outcomeId1,
      });
      checks.push({
        name: 'step 7: criteria stable after evaluate (JSON.stringify equality)',
        ok: JSON.stringify(r7?.outcome?.criteria) === criteriaJson1,
      });
      checks.push({
        name: 'step 7: perPrimitive[0] is file_exists FAIL',
        ok: r7?.evaluation?.perPrimitive?.[0]?.primitive === 'file_exists' &&
            r7?.evaluation?.perPrimitive?.[0]?.status === 'FAIL',
      });

      // ── Step 8: Boundary C — evaluate again in FAIL state → OUTCOME_NEEDS_RESUBMIT ──
      const r8 = parseToolResult(
        await B.client.callTool({
          name: 'cairn.outcomes.evaluate',
          arguments: { outcome_id: outcomeId1 },
        }),
      );
      logStep(8, 'B: outcomes.evaluate (FAIL state, boundary C) → OUTCOME_NEEDS_RESUBMIT', r8);
      checks.push({
        name: 'step 8 (boundary C): OUTCOME_NEEDS_RESUBMIT error in FAIL state',
        ok: r8?.error?.code === 'OUTCOME_NEEDS_RESUBMIT',
      });

      // ── Step 9: P1.1 closed loop — create the file (simulate agent fixing the work) ──
      const fixedFilePath = join(tmpDir, 'WILL_NOT_EXIST.tmp');
      writeFileSync(fixedFilePath, 'fixed');
      console.log(`\n── STEP 9: created ${fixedFilePath} (simulating agent completing work) ──`);

      // ── Step 10: upsert reset — submit without criteria → PENDING + id/criteria stable ──
      const r10 = parseToolResult(
        await B.client.callTool({
          name: 'cairn.task.submit_for_review',
          arguments: { task_id: taskId1 },
        }),
      );
      logStep(10, 'B: submit_for_review (no criteria, upsert reset) → PENDING + stable outcome_id', r10);
      checks.push({
        name: 'step 10 (upsert reset): outcome.status back to PENDING',
        ok: r10?.outcome?.status === 'PENDING',
      });
      checks.push({
        name: 'step 10 (upsert reset): outcome_id identical to step 5 (stable)',
        ok: r10?.outcome?.outcome_id === outcomeId1,
      });
      checks.push({
        name: 'step 10 (upsert reset): criteria identical to step 5 (frozen, stable)',
        ok: JSON.stringify(r10?.outcome?.criteria) === criteriaJson1,
      });
      checks.push({
        name: 'step 10 (upsert reset): task.state WAITING_REVIEW',
        ok: r10?.task?.state === 'WAITING_REVIEW',
      });

      // ── Step 11: evaluate → PASS + task DONE ──
      const r11 = parseToolResult(
        await B.client.callTool({
          name: 'cairn.outcomes.evaluate',
          arguments: { outcome_id: outcomeId1 },
        }),
      );
      logStep(11, 'B: cairn.outcomes.evaluate → PASS (file now exists)', r11);
      checks.push({
        name: 'step 11: evaluation result.status PASS',
        ok: r11?.evaluation?.status === 'PASS',
      });
      checks.push({
        name: 'step 11: task.state DONE after PASS evaluate',
        ok: r11?.task?.state === 'DONE',
      });
      checks.push({
        name: 'step 11: outcome.status PASS',
        ok: r11?.outcome?.status === 'PASS',
      });

      // ── Step 12: Boundary D — evaluate again in PASS state → OUTCOME_ALREADY_PASSED ──
      const r12 = parseToolResult(
        await B.client.callTool({
          name: 'cairn.outcomes.evaluate',
          arguments: { outcome_id: outcomeId1 },
        }),
      );
      logStep(12, 'B: outcomes.evaluate (PASS state, boundary D) → OUTCOME_ALREADY_PASSED', r12);
      checks.push({
        name: 'step 12 (boundary D): OUTCOME_ALREADY_PASSED error in PASS state',
        ok: r12?.error?.code === 'OUTCOME_ALREADY_PASSED',
      });

      // ── Step 13: terminal_fail demo — second task ──
      console.log('\n── STEP 13: second task — terminal_fail path ──');

      // Create taskId2
      const r13a = parseToolResult(
        await B.client.callTool({
          name: 'cairn.task.create',
          arguments: { intent: 'second task — terminal_fail demo' },
        }),
      );
      logStep('13a', 'B: cairn.task.create (task 2)', r13a);
      taskId2 = r13a.task?.task_id;

      // Start attempt
      const r13b = parseToolResult(
        await B.client.callTool({
          name: 'cairn.task.start_attempt',
          arguments: { task_id: taskId2 },
        }),
      );
      logStep('13b', 'B: cairn.task.start_attempt (task 2) → RUNNING', r13b);

      // Submit for review with criteria that will fail
      const r13c = parseToolResult(
        await B.client.callTool({
          name: 'cairn.task.submit_for_review',
          arguments: {
            task_id: taskId2,
            criteria: [{ primitive: 'file_exists', args: { path: 'NOPE_TERMINAL.tmp' } }],
          },
        }),
      );
      logStep('13c', 'B: submit_for_review (task 2, fail criteria)', r13c);
      outcomeId2 = r13c.outcome?.outcome_id;
      checks.push({
        name: 'step 13c: task 2 WAITING_REVIEW after submit',
        ok: r13c?.task?.state === 'WAITING_REVIEW',
      });

      // terminal_fail
      const r13d = parseToolResult(
        await B.client.callTool({
          name: 'cairn.outcomes.terminal_fail',
          arguments: { outcome_id: outcomeId2, reason: 'demo terminal' },
        }),
      );
      logStep('13d', 'B: cairn.outcomes.terminal_fail → TERMINAL_FAIL + task FAILED', r13d);
      checks.push({
        name: 'step 13d: outcome.status TERMINAL_FAIL',
        ok: r13d?.outcome?.status === 'TERMINAL_FAIL',
      });
      checks.push({
        name: 'step 13d: task.state FAILED after terminal_fail',
        ok: r13d?.task?.state === 'FAILED',
      });
      checks.push({
        name: 'step 13d: evaluation_summary contains terminal reason',
        ok: typeof r13d?.outcome?.evaluation_summary === 'string' &&
            r13d.outcome.evaluation_summary.includes('demo terminal'),
      });

    } finally {
      await B.client.close();
      console.log('\n── B closed ──');
    }

    // ── Step 14: A2 — cross-process durability verification ──
    const A2 = await spawnSession('w5-phase3-session-A2');
    try {
      const r14a = parseToolResult(
        await A2.client.callTool({
          name: 'cairn.task.get',
          arguments: { task_id: taskId1 },
        }),
      );
      logStep('14a', 'A2 (re-spawned): cairn.task.get(taskId1) → DONE (cross-process durability)', r14a);
      checks.push({
        name: 'step 14 (cross-process): A2 sees taskId1 state DONE',
        ok: r14a?.task?.state === 'DONE',
      });

      const r14b = parseToolResult(
        await A2.client.callTool({
          name: 'cairn.task.get',
          arguments: { task_id: taskId2 },
        }),
      );
      logStep('14b', 'A2 (re-spawned): cairn.task.get(taskId2) → FAILED (cross-process durability)', r14b);
      checks.push({
        name: 'step 14 (cross-process): A2 sees taskId2 state FAILED',
        ok: r14b?.task?.state === 'FAILED',
      });
    } finally {
      await A2.client.close();
      console.log('\n── A2 closed ──');
    }

  } finally {
    // Safety net — if A1 wasn't closed by step 3 due to throw
    try { await A1.client.close(); } catch {}

    // Cleanup tmpDir (best-effort)
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      console.log(`\ncleaned up tmp dir: ${tmpDir}`);
    } catch {
      console.log(`\n(tmp dir cleanup failed — leaving ${tmpDir})`);
    }
  }

  console.log('\n── ASSERTIONS ──');
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}: ${c.name}`);
  }
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} assertions PASS`);
  if (passed !== checks.length) {
    throw new Error(`Phase 3 dogfood: ${checks.length - passed} assertion(s) failed`);
  }
  console.log('\nPhase 3 outcomes closed-loop verified through real MCP stdio.');
}

main().catch((err) => {
  console.error('PHASE 3 DOGFOOD FAILED:', err);
  process.exit(1);
});
