/**
 * Dispatch v1 端到端 smoke test (real LLM call)
 *
 * 验证：dispatch.request → DB write PENDING → 4 fallback rules wired up →
 *      LLM real-mode parse OK → dispatch.confirm → scratchpad write
 *
 * 用法：
 *   1. 确保 .cairn-poc3-keys/keys.env 存在含 MiniMax key
 *   2. CAIRN_LLM_MODE=real node packages/daemon/scripts/dispatch-v1-smoke.mjs
 *
 * 不进 npm test（依赖网络 + 真 API + 真 LLM token 费用）。手动 EOD/release
 * verification 跑一次。
 */

import { unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// Use isolated test DB to avoid polluting real ~/.cairn/cairn.db
const TEST_DB = join(tmpdir(), `cairn-dispatch-smoke-${Date.now()}.db`);

const REPO_ROOT = resolve('D:/lll/cairn');
process.chdir(REPO_ROOT);

// Force real LLM mode + load config from keys.env via dev fallback
process.env.CAIRN_LLM_MODE = 'real';

const moduleUrl = (rel) => pathToFileURL(join(REPO_ROOT, rel)).href;

const { openDatabase } = await import(moduleUrl('packages/daemon/dist/storage/db.js'));
const { runMigrations } = await import(moduleUrl('packages/daemon/dist/storage/migrations/runner.js'));
const { ALL_MIGRATIONS } = await import(moduleUrl('packages/daemon/dist/storage/migrations/index.js'));
const { registerProcess } = await import(moduleUrl('packages/daemon/dist/storage/repositories/processes.js'));
const { getDispatchRequest } = await import(moduleUrl('packages/daemon/dist/storage/repositories/dispatch-requests.js'));
const scratchpadRepo = await import(moduleUrl('packages/daemon/dist/storage/repositories/scratchpad.js'));
const { toolDispatchRequest, toolDispatchConfirm } = await import(moduleUrl('packages/mcp-server/dist/tools/dispatch.js'));

console.log(`\n== Dispatch v1 端到端 smoke (real LLM) ==`);
console.log(`Test DB: ${TEST_DB}`);

const db = openDatabase(TEST_DB);
runMigrations(db, ALL_MIGRATIONS);

// Register an active agent so target_agent selection has something to pick
registerProcess(db, { agentId: 'smoke-agent-cc', agentType: 'claude-code', capabilities: ['scratchpad', 'checkpoint'] });

// Build minimal Workspace for tool functions
const ws = {
  db,
  cairnRoot: TEST_DB.replace(/\.db$/, ''),
  blobRoot: TEST_DB.replace(/\.db$/, ''),
  cwd: REPO_ROOT,
};

// scratchpad uses getScratch(db, key) returning unknown | null
const getScratch = scratchpadRepo.getScratch;
if (typeof getScratch !== 'function') {
  console.log('FATAL: scratchpadRepo.getScratch not found; available exports:', Object.keys(scratchpadRepo));
  process.exit(1);
}

const cases = [
  {
    label: 'R1 trigger: 回滚 keyword',
    nl: '帮我把 src/foo.ts 回滚到上个 checkpoint',
    expectFallbacks: ['R1'],
  },
  {
    label: 'R2 trigger: 上传 + openai',
    nl: '把所有 .ts 文件打包上传到 OpenAI 做全局 review',
    expectFallbacks: ['R2'],
  },
  {
    label: 'R4 trigger: 直接 SQL',
    nl: '直接修改 SQLite cairn.db 把 status 改成 RESOLVED',
    expectFallbacks: ['R4'],
  },
  {
    label: 'No fallback: 普通新功能',
    nl: '帮我写一个 formatBytes 函数放到 src/utils/format.ts',
    expectFallbacks: [],
  },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  console.log(`\n--- ${c.label} ---`);
  console.log(`NL: ${c.nl.slice(0, 60)}${c.nl.length > 60 ? '...' : ''}`);

  try {
    const startMs = Date.now();
    const reqResult = await toolDispatchRequest(ws, { nl_intent: c.nl });
    const latency = Date.now() - startMs;

    if (!reqResult.ok) {
      console.log(`  ✗ FAILED: dispatch.request returned ok=false: ${reqResult.error ?? '(no error)'}`);
      failed++;
      continue;
    }

    const { request_id, target_agent, fallback_rules_applied, generated_prompt } = reqResult;
    console.log(`  request_id: ${request_id}`);
    console.log(`  target_agent: ${target_agent}`);
    console.log(`  latency: ${latency}ms`);
    console.log(`  fallback_rules_applied: [${(fallback_rules_applied ?? []).join(', ')}]`);
    console.log(`  generated_prompt length: ${generated_prompt?.length ?? 0}`);

    // Verify expected fallbacks
    const got = new Set(fallback_rules_applied ?? []);
    const expected = new Set(c.expectFallbacks);
    const missing = c.expectFallbacks.filter((r) => !got.has(r));
    const extra = [...got].filter((r) => !expected.has(r));

    if (missing.length > 0) {
      console.log(`  ✗ FAILED: expected fallbacks ${JSON.stringify(c.expectFallbacks)} not all triggered. Missing: ${missing.join(', ')}`);
      failed++;
      continue;
    }
    if (extra.length > 0) {
      console.log(`  ⚠ NOTE: extra fallbacks triggered (expected ${JSON.stringify(c.expectFallbacks)}, got ${JSON.stringify([...got])}); not failing if reasonable`);
    }

    // Verify DB state PENDING
    const row = getDispatchRequest(db, request_id);
    if (!row) {
      console.log(`  ✗ FAILED: dispatch_requests row not found`);
      failed++;
      continue;
    }
    if (row.status !== 'PENDING') {
      console.log(`  ✗ FAILED: expected status PENDING, got ${row.status}`);
      failed++;
      continue;
    }

    // Confirm
    const confResult = toolDispatchConfirm(ws, { request_id });
    if (!confResult.ok) {
      console.log(`  ✗ FAILED: confirm returned ok=false: ${confResult.error ?? '(none)'}`);
      failed++;
      continue;
    }

    // Verify DB state CONFIRMED + scratchpad has dispatch/{id}/prompt
    const rowAfter = getDispatchRequest(db, request_id);
    if (rowAfter.status !== 'CONFIRMED') {
      console.log(`  ✗ FAILED: post-confirm status not CONFIRMED: ${rowAfter.status}`);
      failed++;
      continue;
    }

    const scratchKey = `dispatch/${request_id}/prompt`;
    const scratchValue = getScratch(db, scratchKey);
    if (scratchValue === null || scratchValue === undefined) {
      console.log(`  ✗ FAILED: scratchpad missing key ${scratchKey}`);
      failed++;
      continue;
    }
    const contentStr = typeof scratchValue === 'string' ? scratchValue : JSON.stringify(scratchValue);
    if (contentStr.length < 50) {
      console.log(`  ✗ FAILED: scratchpad content too short (length=${contentStr.length})`);
      failed++;
      continue;
    }

    console.log(`  ✓ PASS: chain complete (request → DB PENDING → confirm → DB CONFIRMED + scratchpad)`);
    passed++;
  } catch (err) {
    console.log(`  ✗ FAILED with exception: ${err.message ?? err}`);
    failed++;
  }
}

console.log(`\n== SUMMARY ==`);
console.log(`Passed: ${passed}/${cases.length}`);
console.log(`Failed: ${failed}/${cases.length}`);

// Cleanup
db.close();
try {
  unlinkSync(TEST_DB);
  unlinkSync(TEST_DB + '-wal');
  unlinkSync(TEST_DB + '-shm');
} catch {}

console.log(`Cleanup: removed ${TEST_DB}`);

process.exit(failed > 0 ? 1 : 0);
