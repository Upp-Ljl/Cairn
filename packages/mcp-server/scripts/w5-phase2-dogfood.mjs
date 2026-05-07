#!/usr/bin/env node
/**
 * W5 Phase 2 — Live Dogfood: cross-session BLOCKED-loop handoff
 *
 * Builds on the Phase 1 dogfood: not just cross-process state durability,
 * but a real "session A blocks → exits → session B resumes" handoff via
 * the new cairn.task.block / answer / resume_packet MCP tools.
 *
 *   1. A1: cairn.task.create                              → PENDING task
 *   2. A1: cairn.task.start_attempt                       → RUNNING
 *   3. A1: cairn.task.block(question, context_keys)       → BLOCKED + blocker.OPEN
 *   4. A1: process exit (genuine session-A-leaves)
 *   5. B:  cairn.task.resume_packet                       → 1 open_blocker, 0 answered, state BLOCKED
 *   6. B:  cairn.task.answer(blocker_id, answer)          → blocker.ANSWERED + task.READY_TO_RESUME
 *   7. B:  cairn.task.resume_packet                       → 0 open, 1 answered, state READY_TO_RESUME
 *   8. B:  cairn.task.start_attempt                       → RUNNING (resume!)
 *   9. B:  cairn.task.cancel(reason)                      → CANCELLED + cancel_reason in metadata
 *   10. B: process exit
 *   11. A2 (re-spawned): cairn.task.get                   → CANCELLED + cancel_reason (cross-process durability)
 *
 * Plus invariants:
 *   - tools/list contains exactly the 8 cairn.task.* tools (5 Phase 1 + 3 Phase 2)
 *   - tools/list does NOT contain cairn.task.list_blockers / get_blocker (LD-8)
 *   - tools/list does NOT contain cairn.task.submit_for_review / cairn.outcomes.evaluate (Phase 3)
 *   - resume packets at steps 5 and 7 pass the JSON validator (LD-5)
 *
 * Multi-blocker counting (LD-7) is covered by Day 2 unit tests
 * (blockers.test.ts) and Day 3 acceptance tests (task.test.ts) which
 * use raw SQL setup to bypass recordBlocker's RUNNING-only guard.
 * Reproducing it here would require either a new MCP tool (out of scope)
 * or direct DB writes (mixing MCP and non-MCP code paths). The unit
 * coverage is sufficient evidence for LD-7.
 *
 * Run from packages/mcp-server: `node scripts/w5-phase2-dogfood.mjs`
 * Requires `dist/index.js` to be built first: `npm run build`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = resolve(here, '..');
const repoRoot = resolve(mcpServerRoot, '../..');
const serverEntry = resolve(mcpServerRoot, 'dist/index.js');

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
    cwd: repoRoot,
  });
  const client = new Client({ name, version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

function logStep(n, label, payload) {
  console.log(`\n── STEP ${n}: ${label} ──`);
  console.log(JSON.stringify(payload, null, 2));
}

// Inline LD-5 packet validator (mirrors validateResumePacket in resume-packet.ts —
// keeping it minimal here so the dogfood doesn't depend on the daemon's own validator).
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

  const A1 = await spawnSession('w5-phase2-session-A1');
  const checks = [];

  let taskId, blockerId;

  try {
    // ── invariants ──
    const tools = (await A1.client.listTools()).tools.map((t) => t.name);
    const taskTools = tools.filter((n) => n.startsWith('cairn.task.')).sort();
    console.log('registered cairn.task.* tools:', taskTools);

    checks.push({
      name: 'tools/list exposes the 8 cairn.task.* verbs (5 Phase 1 + 3 Phase 2)',
      ok: JSON.stringify(taskTools) === JSON.stringify([
        'cairn.task.answer',
        'cairn.task.block',
        'cairn.task.cancel',
        'cairn.task.create',
        'cairn.task.get',
        'cairn.task.list',
        'cairn.task.resume_packet',
        'cairn.task.start_attempt',
      ]),
    });
    checks.push({
      name: 'LD-8: list_blockers / get_blocker NOT registered',
      ok: !tools.includes('cairn.task.list_blockers') && !tools.includes('cairn.task.get_blocker'),
    });
    checks.push({
      name: 'Phase 3 transitions still inactive: submit_for_review / outcomes.evaluate NOT registered',
      ok: !tools.includes('cairn.task.submit_for_review') && !tools.includes('cairn.outcomes.evaluate'),
    });

    // ── Step 1: A1 creates task ──
    const r1 = parseToolResult(
      await A1.client.callTool({
        name: 'cairn.task.create',
        arguments: { intent: 'W5 Phase 2 dogfood — BLOCKED-loop closed-loop handoff' },
      }),
    );
    logStep(1, 'A1: cairn.task.create', r1);
    taskId = r1.task.task_id;
    checks.push({ name: 'step 1: state PENDING on create', ok: r1.task.state === 'PENDING' });

    // ── Step 2: A1 starts attempt ──
    const r2 = parseToolResult(
      await A1.client.callTool({
        name: 'cairn.task.start_attempt',
        arguments: { task_id: taskId },
      }),
    );
    logStep(2, 'A1: cairn.task.start_attempt → RUNNING', r2);
    checks.push({ name: 'step 2: state RUNNING after start_attempt', ok: r2.task.state === 'RUNNING' });

    // ── Step 3: A1 blocks ──
    const r3 = parseToolResult(
      await A1.client.callTool({
        name: 'cairn.task.block',
        arguments: {
          task_id: taskId,
          question: '保留旧 sync API 吗？',
          context_keys: ['scratchpad/T-001/old-api-survey'],
        },
      }),
    );
    logStep(3, 'A1: cairn.task.block → BLOCKED + blocker.OPEN', r3);
    blockerId = r3.blocker.blocker_id;
    checks.push({ name: 'step 3: task.state BLOCKED', ok: r3.task.state === 'BLOCKED' });
    checks.push({ name: 'step 3: blocker.status OPEN', ok: r3.blocker.status === 'OPEN' });
    checks.push({ name: 'step 3: blocker.question matches', ok: r3.blocker.question === '保留旧 sync API 吗？' });
    checks.push({ name: 'step 3: blocker.raised_at is number', ok: typeof r3.blocker.raised_at === 'number' });
    checks.push({ name: 'step 3: blocker.raised_by is non-null (auto-injected)', ok: r3.blocker.raised_by != null });

    // ── Step 4: close A1 — genuine "session A leaves" ──
    await A1.client.close();
    console.log('\n── STEP 4: A1 closed (process A1 has exited) ──');

    // ── Step 5: B opens, reads resume packet ──
    const B = await spawnSession('w5-phase2-session-B');
    const r5 = parseToolResult(
      await B.client.callTool({
        name: 'cairn.task.resume_packet',
        arguments: { task_id: taskId },
      }),
    );
    logStep(5, 'B (different process): cairn.task.resume_packet → BLOCKED + 1 open_blocker', r5);
    const r5errors = isResumePacketShapeValid(r5.packet);
    checks.push({ name: 'step 5: resume_packet schema valid', ok: r5errors.length === 0 });
    if (r5errors.length > 0) console.log('  schema errors:', r5errors);
    checks.push({ name: 'step 5: packet.current_state BLOCKED', ok: r5.packet.current_state === 'BLOCKED' });
    checks.push({ name: 'step 5: open_blockers length 1', ok: r5.packet.open_blockers.length === 1 });
    checks.push({ name: 'step 5: open_blockers[0].question matches', ok: r5.packet.open_blockers[0].question === '保留旧 sync API 吗？' });
    checks.push({ name: 'step 5: answered_blockers empty', ok: r5.packet.answered_blockers.length === 0 });
    checks.push({ name: 'step 5: outcomes_criteria empty array (Phase 2)', ok: Array.isArray(r5.packet.outcomes_criteria) && r5.packet.outcomes_criteria.length === 0 });

    // ── Step 6: B answers ──
    const r6 = parseToolResult(
      await B.client.callTool({
        name: 'cairn.task.answer',
        arguments: { blocker_id: blockerId, answer: '保留，加 deprecation 注释' },
      }),
    );
    logStep(6, 'B: cairn.task.answer → blocker.ANSWERED + task.READY_TO_RESUME', r6);
    checks.push({ name: 'step 6: blocker.status ANSWERED', ok: r6.blocker.status === 'ANSWERED' });
    checks.push({ name: 'step 6: blocker.answer matches', ok: r6.blocker.answer === '保留，加 deprecation 注释' });
    checks.push({ name: 'step 6: blocker.answered_at is number', ok: typeof r6.blocker.answered_at === 'number' });
    checks.push({ name: 'step 6: task.state READY_TO_RESUME (LD-7: 0 OPEN remaining)', ok: r6.task.state === 'READY_TO_RESUME' });

    // ── Step 7: B re-reads packet ──
    const r7 = parseToolResult(
      await B.client.callTool({
        name: 'cairn.task.resume_packet',
        arguments: { task_id: taskId },
      }),
    );
    logStep(7, 'B: cairn.task.resume_packet → READY_TO_RESUME + 0 open / 1 answered', r7);
    const r7errors = isResumePacketShapeValid(r7.packet);
    checks.push({ name: 'step 7: resume_packet schema valid', ok: r7errors.length === 0 });
    checks.push({ name: 'step 7: packet.current_state READY_TO_RESUME', ok: r7.packet.current_state === 'READY_TO_RESUME' });
    checks.push({ name: 'step 7: open_blockers empty', ok: r7.packet.open_blockers.length === 0 });
    checks.push({ name: 'step 7: answered_blockers length 1', ok: r7.packet.answered_blockers.length === 1 });
    checks.push({ name: 'step 7: answered_blockers[0].answer matches', ok: r7.packet.answered_blockers[0].answer === '保留，加 deprecation 注释' });

    // ── Step 8: B resumes ──
    const r8 = parseToolResult(
      await B.client.callTool({
        name: 'cairn.task.start_attempt',
        arguments: { task_id: taskId },
      }),
    );
    logStep(8, 'B: cairn.task.start_attempt → RUNNING (genuine resume from READY_TO_RESUME)', r8);
    checks.push({ name: 'step 8: task.state RUNNING (resume succeeded)', ok: r8.task.state === 'RUNNING' });

    // ── Step 9: B cancels ──
    const r9 = parseToolResult(
      await B.client.callTool({
        name: 'cairn.task.cancel',
        arguments: { task_id: taskId, reason: 'demo: phase 2 closed loop verified' },
      }),
    );
    logStep(9, 'B: cairn.task.cancel → CANCELLED + cancel_reason atomically in metadata', r9);
    checks.push({ name: 'step 9: task.state CANCELLED', ok: r9.task.state === 'CANCELLED' });
    checks.push({
      name: 'step 9: cancel_reason in metadata (Phase 1 cancelTask atomic write still works)',
      ok: r9.task.metadata?.cancel_reason === 'demo: phase 2 closed loop verified',
    });

    // ── Step 10: close B ──
    await B.client.close();
    console.log('\n── STEP 10: B closed ──');

    // ── Step 11: re-spawn as A2, read across process boundary ──
    const A2 = await spawnSession('w5-phase2-session-A2');
    try {
      const r11 = parseToolResult(
        await A2.client.callTool({
          name: 'cairn.task.get',
          arguments: { task_id: taskId },
        }),
      );
      logStep(11, 'A2 (re-spawned, new PID): cairn.task.get → CANCELLED + cancel_reason (cross-process durability)', r11);
      checks.push({ name: 'step 11: A2 sees CANCELLED', ok: r11.task.state === 'CANCELLED' });
      checks.push({
        name: 'step 11: A2 sees cancel_reason from B (cross-process atomic write durability)',
        ok: r11.task.metadata?.cancel_reason === 'demo: phase 2 closed loop verified',
      });
    } finally {
      await A2.client.close();
    }
  } finally {
    // safety nets — if anything threw earlier
    try { await A1.client.close(); } catch {}
  }

  console.log('\n── ASSERTIONS ──');
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}: ${c.name}`);
  }
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} assertions PASS`);
  if (passed !== checks.length) {
    throw new Error(`Phase 2 dogfood: ${checks.length - passed} assertion(s) failed`);
  }
  console.log('\nPhase 2 BLOCKED-loop closed-loop handoff verified through real MCP stdio.');
}

main().catch((err) => {
  console.error('PHASE 2 DOGFOOD FAILED:', err);
  process.exit(1);
});
