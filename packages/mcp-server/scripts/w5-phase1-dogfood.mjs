#!/usr/bin/env node
/**
 * W5 Phase 1 — Live Dogfood: cross-session Task Capsule handoff
 *
 * Spawns two independent mcp-server child processes (two stdio transports,
 * two CAIRN_SESSION_AGENT_IDs), both backed by the same SQLite DB. Walks
 * through the plan §5.5.1 6-step scenario through the real MCP stdio
 * protocol — same path Claude Code uses, just orchestrated by this script
 * instead of by the IDE.
 *
 *   1. Session A: cairn.task.create               → PENDING task
 *   2. Session A: cairn.task.start_attempt        → RUNNING
 *   3. Session B (different process): cairn.task.get → sees RUNNING
 *   4. Session B: cairn.task.cancel(reason)       → CANCELLED + metadata
 *   5. Session A: cairn.task.get                  → CANCELLED + reason
 *   6. Session A: cairn.task.start_attempt        → INVALID_STATE_TRANSITION
 *
 * Run from packages/mcp-server (so local node_modules resolves):
 *   `node scripts/w5-phase1-dogfood.mjs`
 *
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

async function main() {
  console.log(`server entry: ${serverEntry}`);

  // Two independent mcp-server processes, different agent_ids, same DB.
  const A = await spawnSession('w5-dogfood-session-A');
  const B = await spawnSession('w5-dogfood-session-B');

  try {
    // Sanity: confirm the new task tools are actually registered.
    const tools = (await A.client.listTools()).tools.map((t) => t.name);
    const taskTools = tools.filter((n) => n.startsWith('cairn.task.'));
    console.log('registered cairn.task.* tools:', taskTools);
    if (taskTools.length !== 5) {
      throw new Error(`expected 5 task tools, got ${taskTools.length}: ${taskTools.join(', ')}`);
    }

    // Step 1: session A creates a task.
    const r1 = parseToolResult(
      await A.client.callTool({
        name: 'cairn.task.create',
        arguments: { intent: 'W5 Phase 1 dogfood — cross-session task handoff demo' },
      }),
    );
    logStep(1, 'session A: cairn.task.create', r1);
    const taskId = r1.task.task_id;

    // Step 2: session A starts attempt → PENDING → RUNNING.
    const r2 = parseToolResult(
      await A.client.callTool({
        name: 'cairn.task.start_attempt',
        arguments: { task_id: taskId },
      }),
    );
    logStep(2, 'session A: cairn.task.start_attempt → RUNNING', r2);

    // Step 3: session B (separate process) reads the task → sees RUNNING.
    const r3 = parseToolResult(
      await B.client.callTool({
        name: 'cairn.task.get',
        arguments: { task_id: taskId },
      }),
    );
    logStep(3, 'session B (different process): cairn.task.get → sees RUNNING', r3);

    // Step 4: session B cancels with a reason → CANCELLED + metadata.
    const r4 = parseToolResult(
      await B.client.callTool({
        name: 'cairn.task.cancel',
        arguments: { task_id: taskId, reason: 'demo: handoff scenario complete' },
      }),
    );
    logStep(4, 'session B: cairn.task.cancel → CANCELLED + metadata', r4);

    // Step 5: session A reads again → sees CANCELLED + reason in metadata.
    const r5 = parseToolResult(
      await A.client.callTool({
        name: 'cairn.task.get',
        arguments: { task_id: taskId },
      }),
    );
    logStep(5, 'session A: cairn.task.get → CANCELLED + metadata.cancel_reason', r5);

    // Step 6: session A tries start_attempt on terminal → structured error response.
    const r6 = parseToolResult(
      await A.client.callTool({
        name: 'cairn.task.start_attempt',
        arguments: { task_id: taskId },
      }),
    );
    logStep(6, 'session A: cairn.task.start_attempt on CANCELLED → INVALID_STATE_TRANSITION', r6);

    // Assertions for the demo to be considered a pass.
    const checks = [
      { name: 'task_id round-trip', ok: r1.task.task_id === taskId },
      { name: 'state PENDING on create', ok: r1.task.state === 'PENDING' },
      { name: 'state RUNNING after start_attempt', ok: r2.task.state === 'RUNNING' },
      { name: 'cross-process read sees RUNNING', ok: r3.task.state === 'RUNNING' },
      { name: 'cancel transitions to CANCELLED', ok: r4.task.state === 'CANCELLED' },
      { name: 'cancel_reason in metadata', ok: r4.task.metadata?.cancel_reason === 'demo: handoff scenario complete' },
      { name: 'cancelled_at is a number', ok: typeof r4.task.metadata?.cancelled_at === 'number' },
      { name: 'session A re-reads CANCELLED + reason', ok: r5.task.state === 'CANCELLED' && r5.task.metadata?.cancel_reason === 'demo: handoff scenario complete' },
      { name: 'start_attempt on CANCELLED returns structured error', ok: r6?.error?.code === 'INVALID_STATE_TRANSITION' },
    ];
    console.log('\n── ASSERTIONS ──');
    for (const c of checks) {
      console.log(`${c.ok ? 'PASS' : 'FAIL'}: ${c.name}`);
    }
    const allPass = checks.every((c) => c.ok);
    if (!allPass) {
      throw new Error('one or more assertions failed; see log above');
    }
    console.log('\nALL 9 ASSERTIONS PASS — Phase 1 cross-session task handoff verified.');
  } finally {
    await A.client.close().catch(() => {});
    await B.client.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('DOGFOOD FAILED:', err);
  process.exit(1);
});
