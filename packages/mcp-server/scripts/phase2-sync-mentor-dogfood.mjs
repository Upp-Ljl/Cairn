#!/usr/bin/env node
/**
 * Phase 2 (sync mentor, 2026-05-14) — Live MCP-wire dogfood.
 *
 * Proves the `cairn.task.block` synchronous auto-resolve path through a
 * real MCP stdio session (no in-process shortcut). This is the
 * "improved tests, but more importantly real-protocol evidence" gate
 * per CLAUDE.md "改 MCP tool 行为时，单测绿不算完成。必须跑真实 dogfood".
 *
 * Setup:
 *   1. mkdtemp a project_root, `git init`, drop a CAIRN.md with a
 *      known_answer for "which test framework"
 *   2. mkdtemp a separate cairn-state root
 *   3. Spawn mcp-server binary (dist/index.js) as a child via MCP SDK
 *      stdio client, with cwd=project_root so ws.gitRoot resolves to it
 *
 * Flow:
 *   A. cairn.task.create({ intent }) → PENDING
 *   B. cairn.task.start_attempt    → RUNNING
 *   C. cairn.task.block({ question: "which test framework should I use here?" })
 *      → expect { auto_resolved: true, answer: includes 'vitest',
 *                 matched_pattern: 'which test framework',
 *                 task.state: 'READY_TO_RESUME',
 *                 blocker.status: 'ANSWERED' }
 *   D. cairn.scratchpad.list with prefix 'mentor/' → expect at least 1 row
 *      whose key matches `mentor/<agent_id>/auto_resolve/<ulid>`
 *   E. cairn.task.create + start_attempt + block on a NO-MATCH question
 *      → expect { auto_resolved: false, task.state: 'BLOCKED' }
 *   F. Exit, mkdtemp cleanup
 *
 * Output: prints `OK N/N assertions PASS` and exits 0 on success.
 *
 * Run from packages/mcp-server: `node scripts/phase2-sync-mentor-dogfood.mjs`
 * Requires dist/index.js built first (`npm run build` in mcp-server + daemon).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = resolve(here, '..');
const serverEntry = resolve(mcpServerRoot, 'dist/index.js');

let asserts = 0, fails = 0;
const failures = [];
function ok(c, label) {
  asserts++;
  if (c) {
    process.stdout.write(`  ok    ${label}\n`);
  } else {
    fails++;
    failures.push(label);
    process.stdout.write(`  FAIL  ${label}\n`);
  }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

function parseToolResult(res) {
  if (!res || !Array.isArray(res.content) || res.content.length === 0) return res;
  const first = res.content[0];
  if (first.type !== 'text') return res;
  try { return JSON.parse(first.text); } catch { return first.text; }
}

// Project_root must be a git repo so resolveGitRoot uses it.
const projectRoot = mkdtempSync(join(tmpdir(), 'cairn-phase2-sm-proj-'));
const cairnRoot   = mkdtempSync(join(tmpdir(), 'cairn-phase2-sm-state-'));

const CAIRN_MD = `# Dogfood Project

## Whole

A fixture project used by the Phase 2 sync-mentor dogfood.

## Goal

Pass the dogfood assertions.

## Known answers

- which test framework => vitest with real DB, not mocks
- prefer ts or js => prefer TypeScript
`;

function initRepo() {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.email', 's@e.com'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.name', 'S'], { cwd: projectRoot });
  writeFileSync(join(projectRoot, 'CAIRN.md'), CAIRN_MD);
  execFileSync('git', ['add', '.'], { cwd: projectRoot });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: projectRoot });
}
initRepo();
process.stdout.write(`project: ${projectRoot}\n`);
process.stdout.write(`state:   ${cairnRoot}\n`);

async function spawnSession() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectRoot,                          // → ws.gitRoot resolves to projectRoot
    env: {
      ...process.env,
      CAIRN_HOME: cairnRoot,                   // isolate DB from ~/.cairn (env var per workspace.ts)
    },
  });
  const client = new Client({ name: 'phase2-dogfood', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

header('phase2-sync-mentor — MCP stdio dogfood');

let exitCode = 0;
try {
  const { client, transport } = await spawnSession();

  // -------------------------------------------------------------------------
  section('1 create + start a task');
  const create1 = parseToolResult(await client.callTool({
    name: 'cairn.task.create',
    arguments: { intent: 'phase 2 auto-resolve demo' },
  }));
  ok(create1 && create1.task && create1.task.task_id, 'task.create returned task_id');
  const taskId1 = create1.task.task_id;

  const start1 = parseToolResult(await client.callTool({
    name: 'cairn.task.start_attempt',
    arguments: { task_id: taskId1 },
  }));
  ok(start1 && start1.task && start1.task.state === 'RUNNING', 'task.start_attempt → RUNNING');

  // -------------------------------------------------------------------------
  section('2 block with a known-answer question → SYNCHRONOUS auto-resolve');
  const block1 = parseToolResult(await client.callTool({
    name: 'cairn.task.block',
    arguments: { task_id: taskId1, question: 'which test framework should I use here?' },
  }));
  ok(block1 && block1.auto_resolved === true, 'auto_resolved=true in same MCP call');
  ok(block1.answer && block1.answer.includes('vitest'), 'answer contains "vitest"');
  ok(block1.matched_pattern === 'which test framework', 'matched_pattern surfaced');
  ok(block1.task && block1.task.state === 'READY_TO_RESUME', 'task immediately READY_TO_RESUME');
  ok(block1.blocker && block1.blocker.status === 'ANSWERED', 'blocker recorded as ANSWERED');
  ok(typeof block1.scratchpad_key === 'string' && block1.scratchpad_key.startsWith('mentor/'),
     'scratchpad_key returned (mentor/* prefix)');
  ok(block1.scratchpad_key.includes('/auto_resolve/'), 'scratchpad key includes /auto_resolve/');

  // -------------------------------------------------------------------------
  section('3 scratchpad event surfaced');
  const sp = parseToolResult(await client.callTool({
    name: 'cairn.scratchpad.list',
    arguments: {},
  }));
  ok(sp && Array.isArray(sp.items), 'scratchpad.list returned items array');
  const allItems = sp.items || [];
  const autoResolveRows = allItems.filter(e => e.key.includes('/auto_resolve/'));
  ok(autoResolveRows.length >= 1, 'at least one mentor/*/auto_resolve/* row exists');
  const matchRow = autoResolveRows.find(r => r.key === block1.scratchpad_key);
  ok(matchRow !== undefined, 'the dogfood scratchpad_key is in scratchpad.list');

  // -------------------------------------------------------------------------
  section('4 no-match question → PASSIVE block (auto_resolved:false)');
  const create2 = parseToolResult(await client.callTool({
    name: 'cairn.task.create',
    arguments: { intent: 'no-match demo' },
  }));
  const taskId2 = create2.task.task_id;
  await client.callTool({ name: 'cairn.task.start_attempt', arguments: { task_id: taskId2 } });
  const block2 = parseToolResult(await client.callTool({
    name: 'cairn.task.block',
    arguments: { task_id: taskId2, question: 'an unrelated question about purple monkeys' },
  }));
  ok(block2 && block2.auto_resolved === false, 'no-match → auto_resolved=false');
  ok(block2.task && block2.task.state === 'BLOCKED', 'no-match → task BLOCKED (passive)');
  ok(block2.blocker && block2.blocker.status === 'OPEN', 'no-match → blocker OPEN');

  // -------------------------------------------------------------------------
  section('5 sanity: scratchpad has the project_profile_kernel cache row');
  const cacheRows = allItems.filter(e => e.key.startsWith('project_profile_kernel/'));
  ok(cacheRows.length >= 1, 'at least one project_profile_kernel/* row (mtime cache)');
  if (cacheRows.length > 0) {
    const cacheKey = cacheRows[0].key;
    ok(cacheKey.length === 'project_profile_kernel/'.length + 16, 'cache key is sha1[:16]');
  } else {
    ok(false, 'cache key is sha1[:16] (no row to inspect)');
  }

  await transport.close();
} catch (e) {
  process.stdout.write(`\nFATAL: ${e && e.stack ? e.stack : String(e)}\n`);
  exitCode = 1;
} finally {
  try { rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (_e) { /* tmp gc */ }
  try { rmSync(cairnRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (_e) { /* tmp gc */ }
}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails || exitCode !== 0) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
