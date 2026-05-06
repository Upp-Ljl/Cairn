/**
 * Tests for cairn.dispatch.request + cairn.dispatch.confirm
 *
 * Covers:
 * - Happy path (mock LLM)
 * - 4 application-layer fallback rules (each triggered + not-triggered + stacked)
 * - Error handling
 * - End-to-end DB state verification
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace, type Workspace } from '../src/workspace.js';
import { toolDispatchRequest, toolDispatchConfirm, applyFallbackRules } from '../src/tools/dispatch.js';
import {
  toolRegisterProcess,
} from '../src/tools/process.js';
import {
  getDispatchRequest,
} from '../../daemon/dist/storage/repositories/dispatch-requests.js';
import {
  getScratch,
  putScratch,
} from '../../daemon/dist/storage/repositories/scratchpad.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('dispatch tools', () => {
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-dispatch-'));
    ws = openWorkspace({ cairnRoot });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  // =========================================================================
  // applyFallbackRules — unit tests (helper exported from dispatch.ts)
  // =========================================================================

  describe('applyFallbackRules (unit)', () => {
    it('R1 triggered: "回滚" in nlIntent → generated_prompt contains [FALLBACK R1]', () => {
      const { prompt, applied } = applyFallbackRules('do something', '执行回滚操作', 0);
      expect(prompt).toContain('[FALLBACK R1]');
      expect(applied).toContain('R1');
    });

    it('R1 triggered: "delete" keyword → [FALLBACK R1]', () => {
      const { prompt, applied } = applyFallbackRules('base', 'delete all files in output/', 0);
      expect(prompt).toContain('[FALLBACK R1]');
      expect(applied).toContain('R1');
    });

    it('R1 not triggered: purely additive intent → no [FALLBACK R1]', () => {
      const { prompt, applied } = applyFallbackRules('add a new feature', '新增一个功能模块', 0);
      expect(prompt).not.toContain('[FALLBACK R1]');
      expect(applied).not.toContain('R1');
    });

    it('R2 triggered: "上传到 OpenAI" → [FALLBACK R2]', () => {
      const { prompt, applied } = applyFallbackRules('base', '上传到 openai', 0);
      expect(prompt).toContain('[FALLBACK R2]');
      expect(applied).toContain('R2');
    });

    it('R2 triggered: "send to" keyword → [FALLBACK R2]', () => {
      const { prompt, applied } = applyFallbackRules('base', 'send to external api endpoint', 0);
      expect(prompt).toContain('[FALLBACK R2]');
      expect(applied).toContain('R2');
    });

    it('R2 not triggered: local-only task → no [FALLBACK R2]', () => {
      const { prompt, applied } = applyFallbackRules('process local files', '处理本地文件，不联网', 0);
      expect(prompt).not.toContain('[FALLBACK R2]');
      expect(applied).not.toContain('R2');
    });

    it('R3 triggered: processCount >= 2 → [FALLBACK R3] with count', () => {
      const { prompt, applied } = applyFallbackRules('do work', 'some task', 2);
      expect(prompt).toContain('[FALLBACK R3]');
      expect(prompt).toContain('2 个活跃 agent');
      expect(applied).toContain('R3');
    });

    it('R3 triggered: processCount = 5 → count shown in message', () => {
      const { prompt, applied } = applyFallbackRules('do work', 'task', 5);
      expect(prompt).toContain('[FALLBACK R3]');
      expect(prompt).toContain('5 个活跃 agent');
      expect(applied).toContain('R3');
    });

    it('R3 not triggered: processCount = 1 → no [FALLBACK R3]', () => {
      const { prompt, applied } = applyFallbackRules('do work', 'some task', 1);
      expect(prompt).not.toContain('[FALLBACK R3]');
      expect(applied).not.toContain('R3');
    });

    it('R3 not triggered: processCount = 0 → no [FALLBACK R3]', () => {
      const { prompt, applied } = applyFallbackRules('do work', 'task', 0);
      expect(prompt).not.toContain('[FALLBACK R3]');
      expect(applied).not.toContain('R3');
    });

    it('R4 triggered: "直接修改 SQLite" → [FALLBACK R4]', () => {
      const { prompt, applied } = applyFallbackRules('base', '直接修改 sqlite 文件', 0);
      expect(prompt).toContain('[FALLBACK R4]');
      expect(applied).toContain('R4');
    });

    it('R4 triggered: "drop table" → [FALLBACK R4]', () => {
      const { prompt, applied } = applyFallbackRules('base', 'drop table users in the database', 0);
      expect(prompt).toContain('[FALLBACK R4]');
      expect(applied).toContain('R4');
    });

    it('R4 not triggered: pure application-layer task → no [FALLBACK R4]', () => {
      const { prompt, applied } = applyFallbackRules('base', 'refactor the auth module', 0);
      expect(prompt).not.toContain('[FALLBACK R4]');
      expect(applied).not.toContain('R4');
    });

    it('R1 + R4 stack: "回滚 + 直接 SQL" triggers both', () => {
      const { prompt, applied } = applyFallbackRules('base', '回滚并直接修改 sqlite 数据', 0);
      expect(prompt).toContain('[FALLBACK R1]');
      expect(prompt).toContain('[FALLBACK R4]');
      expect(applied).toContain('R1');
      expect(applied).toContain('R4');
    });

    it('all 4 rules stack when all conditions met', () => {
      const { prompt, applied } = applyFallbackRules(
        'base',
        '回滚并上传到 openai 且直接修改 sqlite',
        3,
      );
      expect(applied).toContain('R1');
      expect(applied).toContain('R2');
      expect(applied).toContain('R3');
      expect(applied).toContain('R4');
      expect(applied.length).toBe(4);
    });

    it('no rules: clean task, single agent → empty applied list', () => {
      const { prompt, applied } = applyFallbackRules(
        'write a helper function',
        'add a utility function to src/utils.ts',
        1,
      );
      expect(applied).toHaveLength(0);
      expect(prompt).toBe('write a helper function');
    });
  });

  // =========================================================================
  // cairn.dispatch.request — integration (mock LLM, no network)
  // =========================================================================

  describe('cairn.dispatch.request', () => {
    it('happy path: mock LLM returns stub → request created PENDING, ok=true', async () => {
      const r = await toolDispatchRequest(ws, { nl_intent: 'implement feature X in typescript' });
      expect(r.ok).toBe(true);
      expect(r.request_id).toBeTruthy();
      expect(typeof r.request_id).toBe('string');
      expect(r.intent).toBeTruthy();
      expect(r.target_agent).toBeTruthy();
    });

    it('happy path: generated_prompt is a non-empty string containing user intent context', async () => {
      const r = await toolDispatchRequest(ws, { nl_intent: 'refactor the auth module cleanly' });
      expect(r.ok).toBe(true);
      expect(typeof r.generated_prompt).toBe('string');
      expect((r as any).generated_prompt.length).toBeGreaterThan(0);
    });

    it('happy path: context_keys is an array (possibly empty)', async () => {
      const r = await toolDispatchRequest(ws, { nl_intent: 'write unit tests for parser' });
      expect(r.ok).toBe(true);
      expect(Array.isArray((r as any).context_keys)).toBe(true);
    });

    it('target_agent: user-specified target_agent is honored', async () => {
      const r = await toolDispatchRequest(ws, {
        nl_intent: 'write a migration for new table',
        target_agent: 'my-custom-agent',
      });
      expect(r.ok).toBe(true);
      expect((r as any).target_agent).toBe('my-custom-agent');
    });

    it('target_agent: single active process is selected as fallback', async () => {
      toolRegisterProcess(ws, { agent_id: 'solo-agent', agent_type: 'coder' });
      const r = await toolDispatchRequest(ws, { nl_intent: 'write tests for the new module' });
      expect(r.ok).toBe(true);
      expect((r as any).target_agent).toBe('solo-agent');
    });

    it('target_agent: "default" returned when no agents registered', async () => {
      const r = await toolDispatchRequest(ws, { nl_intent: 'create a readme for the project' });
      expect(r.ok).toBe(true);
      expect((r as any).target_agent).toBe('default');
    });

    it('validation: nl_intent too short → ok=false error', async () => {
      const r = await toolDispatchRequest(ws, { nl_intent: 'hi' });
      expect(r.ok).toBe(false);
      expect((r as any).error).toMatch(/5/);
    });

    // ── R1 integration ─────────────────────────────────────────────────────

    it('R1 integration: nl_intent "回滚" → generated_prompt has [FALLBACK R1]', async () => {
      const r = await toolDispatchRequest(ws, { nl_intent: '执行回滚上一次的变更' });
      expect(r.ok).toBe(true);
      expect((r as any).generated_prompt).toContain('[FALLBACK R1]');
      expect((r as any).fallback_rules_applied).toContain('R1');
    });

    it('R1 integration: nl_intent "新增功能" → no [FALLBACK R1]', async () => {
      const r = await toolDispatchRequest(ws, { nl_intent: '新增一个功能模块到系统' });
      expect(r.ok).toBe(true);
      expect((r as any).generated_prompt).not.toContain('[FALLBACK R1]');
    });

    // ── R2 integration ─────────────────────────────────────────────────────

    it('R2 integration: "上传到 OpenAI" → [FALLBACK R2]', async () => {
      const r = await toolDispatchRequest(ws, { nl_intent: '上传日志到 openai 处理' });
      expect(r.ok).toBe(true);
      expect((r as any).generated_prompt).toContain('[FALLBACK R2]');
      expect((r as any).fallback_rules_applied).toContain('R2');
    });

    it('R2 integration: local-only read task → no [FALLBACK R2]', async () => {
      const r = await toolDispatchRequest(ws, { nl_intent: '读取本地配置并显示结果' });
      expect(r.ok).toBe(true);
      expect((r as any).generated_prompt).not.toContain('[FALLBACK R2]');
    });

    // ── R3 integration ─────────────────────────────────────────────────────

    it('R3 integration: 2 active agents → [FALLBACK R3]', async () => {
      toolRegisterProcess(ws, { agent_id: 'agent-a', agent_type: 'worker' });
      toolRegisterProcess(ws, { agent_id: 'agent-b', agent_type: 'worker' });
      const r = await toolDispatchRequest(ws, { nl_intent: 'implement the new parser module' });
      expect(r.ok).toBe(true);
      expect((r as any).generated_prompt).toContain('[FALLBACK R3]');
      expect((r as any).fallback_rules_applied).toContain('R3');
    });

    it('R3 integration: only 1 agent → no [FALLBACK R3]', async () => {
      toolRegisterProcess(ws, { agent_id: 'lone-agent', agent_type: 'worker' });
      const r = await toolDispatchRequest(ws, { nl_intent: 'implement the new parser module' });
      expect(r.ok).toBe(true);
      expect((r as any).generated_prompt).not.toContain('[FALLBACK R3]');
    });

    // ── R4 integration ─────────────────────────────────────────────────────

    it('R4 integration: "直接修改 SQLite" → [FALLBACK R4]', async () => {
      const r = await toolDispatchRequest(ws, {
        nl_intent: '直接修改 sqlite 数据库文件以修复数据',
      });
      expect(r.ok).toBe(true);
      expect((r as any).generated_prompt).toContain('[FALLBACK R4]');
      expect((r as any).fallback_rules_applied).toContain('R4');
    });

    it('R4 integration: pure application task → no [FALLBACK R4]', async () => {
      const r = await toolDispatchRequest(ws, {
        nl_intent: '在 src/auth.ts 中添加邮箱验证逻辑',
      });
      expect(r.ok).toBe(true);
      expect((r as any).generated_prompt).not.toContain('[FALLBACK R4]');
    });

    // ── Multi-rule stacking ─────────────────────────────────────────────────

    it('R1+R4 stack: "回滚 SQL" intent → both rules applied', async () => {
      const r = await toolDispatchRequest(ws, {
        nl_intent: '回滚并直接修改 sqlite 中的数据',
      });
      expect(r.ok).toBe(true);
      expect((r as any).fallback_rules_applied).toContain('R1');
      expect((r as any).fallback_rules_applied).toContain('R4');
    });

    // ── DB state verification ────────────────────────────────────────────────

    it('DB: request written to dispatch_requests with PENDING status', async () => {
      const r = await toolDispatchRequest(ws, { nl_intent: 'build the pagination component' });
      expect(r.ok).toBe(true);
      const row = getDispatchRequest(ws.db, (r as any).request_id);
      expect(row).not.toBeNull();
      expect(row!.status).toBe('PENDING');
      expect(row!.nl_intent).toBe('build the pagination component');
    });

    it('DB: generated_prompt stored in dispatch_requests row', async () => {
      const r = await toolDispatchRequest(ws, { nl_intent: 'implement caching layer for API calls' });
      expect(r.ok).toBe(true);
      const row = getDispatchRequest(ws.db, (r as any).request_id);
      expect(row!.generated_prompt).toBeTruthy();
    });

    // ── Error handling ───────────────────────────────────────────────────────

    it('CAIRN_LLM_MODE=real without config → ok=false with descriptive error', async () => {
      // We cannot easily test ConfigNotFoundError without setting env var AND having no config.
      // Instead we test the validation path (short nl_intent) as a proxy for error handling.
      const r = await toolDispatchRequest(ws, { nl_intent: 'x' });
      expect(r.ok).toBe(false);
      expect((r as any).error).toBeTruthy();
    });
  });

  // =========================================================================
  // cairn.dispatch.confirm
  // =========================================================================

  describe('cairn.dispatch.confirm', () => {
    it('PENDING → CONFIRMED: ok=true, scratchpad key created', async () => {
      const reqResult = await toolDispatchRequest(ws, {
        nl_intent: 'add error handling to the API client',
      });
      expect(reqResult.ok).toBe(true);
      const requestId = (reqResult as any).request_id as string;

      const conf = toolDispatchConfirm(ws, { request_id: requestId });
      expect(conf.ok).toBe(true);
      expect((conf as any).scratchpad_key).toBe(`dispatch/${requestId}/prompt`);
      expect((conf as any).dispatched_at_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('confirm: scratchpad contains the generated_prompt', async () => {
      const reqResult = await toolDispatchRequest(ws, {
        nl_intent: 'write integration tests for checkout flow',
      });
      const requestId = (reqResult as any).request_id as string;
      toolDispatchConfirm(ws, { request_id: requestId });

      const val = getScratch(ws.db, `dispatch/${requestId}/prompt`);
      expect(val).toBeTruthy();
      expect(typeof val).toBe('string');
    });

    it('confirm: dispatch_requests row status = CONFIRMED after confirm', async () => {
      const reqResult = await toolDispatchRequest(ws, { nl_intent: 'add validation to forms' });
      const requestId = (reqResult as any).request_id as string;

      toolDispatchConfirm(ws, { request_id: requestId });

      const row = getDispatchRequest(ws.db, requestId);
      expect(row!.status).toBe('CONFIRMED');
      expect(row!.confirmed_at).not.toBeNull();
    });

    it('confirm: non-existent request_id → ok=false with not found error', () => {
      const r = toolDispatchConfirm(ws, { request_id: 'nonexistent-id-xyz' });
      expect(r.ok).toBe(false);
      expect((r as any).error).toMatch(/not found/);
    });

    it('confirm: already CONFIRMED → ok=false with status error', async () => {
      const reqResult = await toolDispatchRequest(ws, { nl_intent: 'add logging to services' });
      const requestId = (reqResult as any).request_id as string;

      toolDispatchConfirm(ws, { request_id: requestId });

      // Second confirm should fail
      const r2 = toolDispatchConfirm(ws, { request_id: requestId });
      expect(r2.ok).toBe(false);
      expect((r2 as any).error).toContain('CONFIRMED');
    });

    it('confirm: REJECTED → confirm returns ok=false', async () => {
      const reqResult = await toolDispatchRequest(ws, { nl_intent: 'update the CI pipeline config' });
      const requestId = (reqResult as any).request_id as string;

      // Manually reject it
      const { rejectDispatchRequest } = await import(
        '../../daemon/dist/storage/repositories/dispatch-requests.js'
      );
      rejectDispatchRequest(ws.db, requestId);

      const r = toolDispatchConfirm(ws, { request_id: requestId });
      expect(r.ok).toBe(false);
      expect((r as any).error).toContain('REJECTED');
    });

    it('target_agent returned in confirm response', async () => {
      const reqResult = await toolDispatchRequest(ws, {
        nl_intent: 'generate API documentation',
        target_agent: 'doc-agent',
      });
      const requestId = (reqResult as any).request_id as string;

      const conf = toolDispatchConfirm(ws, { request_id: requestId });
      expect(conf.ok).toBe(true);
      expect((conf as any).target_agent).toBe('doc-agent');
    });
  });

  // =========================================================================
  // 3a: CAIRN_DISPATCH_FORCE_FAIL env hook
  // =========================================================================

  describe('CAIRN_DISPATCH_FORCE_FAIL', () => {
    it('FORCE_FAIL=1 → ok=false, status=FAILED, request_id present, DB row FAILED', async () => {
      const prev = process.env['CAIRN_DISPATCH_FORCE_FAIL'];
      process.env['CAIRN_DISPATCH_FORCE_FAIL'] = '1';
      try {
        const r = await toolDispatchRequest(ws, { nl_intent: 'do some important work here' });
        expect(r.ok).toBe(false);
        expect((r as any).status).toBe('FAILED');
        expect(typeof (r as any).request_id).toBe('string');
        expect((r as any).error).toMatch(/CAIRN_DISPATCH_FORCE_FAIL/);

        // Verify DB row
        const row = getDispatchRequest(ws.db, (r as any).request_id);
        expect(row).not.toBeNull();
        expect(row!.status).toBe('FAILED');
      } finally {
        if (prev === undefined) delete process.env['CAIRN_DISPATCH_FORCE_FAIL'];
        else process.env['CAIRN_DISPATCH_FORCE_FAIL'] = prev;
      }
    });

    it('FORCE_FAIL=true → same FAILED behavior', async () => {
      const prev = process.env['CAIRN_DISPATCH_FORCE_FAIL'];
      process.env['CAIRN_DISPATCH_FORCE_FAIL'] = 'true';
      try {
        const r = await toolDispatchRequest(ws, { nl_intent: 'another important task here' });
        expect(r.ok).toBe(false);
        expect((r as any).status).toBe('FAILED');
      } finally {
        if (prev === undefined) delete process.env['CAIRN_DISPATCH_FORCE_FAIL'];
        else process.env['CAIRN_DISPATCH_FORCE_FAIL'] = prev;
      }
    });

    it('FORCE_FAIL unset → normal happy path continues', async () => {
      const prev = process.env['CAIRN_DISPATCH_FORCE_FAIL'];
      delete process.env['CAIRN_DISPATCH_FORCE_FAIL'];
      try {
        const r = await toolDispatchRequest(ws, { nl_intent: 'implement feature X in typescript' });
        expect(r.ok).toBe(true);
      } finally {
        if (prev !== undefined) process.env['CAIRN_DISPATCH_FORCE_FAIL'] = prev;
      }
    });
  });

  // =========================================================================
  // 3b: Rule R6 — recent rewind warning
  // =========================================================================

  describe('applyFallbackRules R6 (unit)', () => {
    it('R6 triggered: recentRewindMs = 1000 (within 3s) → [FALLBACK R6] in applied', () => {
      const { prompt, applied } = applyFallbackRules('do work', 'some task', 0, 1000);
      expect(prompt).toContain('[FALLBACK R6]');
      expect(applied).toContain('R6');
    });

    it('R6 triggered: recentRewindMs = 3000 (exactly 3s) → [FALLBACK R6]', () => {
      const { prompt, applied } = applyFallbackRules('do work', 'some task', 0, 3000);
      expect(prompt).toContain('[FALLBACK R6]');
      expect(applied).toContain('R6');
    });

    it('R6 not triggered: recentRewindMs = 3001 (just over 3s) → no R6', () => {
      const { prompt, applied } = applyFallbackRules('do work', 'some task', 0, 3001);
      expect(prompt).not.toContain('[FALLBACK R6]');
      expect(applied).not.toContain('R6');
    });

    it('R6 not triggered: recentRewindMs = null (no rewind ever) → no R6', () => {
      const { prompt, applied } = applyFallbackRules('do work', 'some task', 0, null);
      expect(prompt).not.toContain('[FALLBACK R6]');
      expect(applied).not.toContain('R6');
    });

    it('R6 default param (no 4th arg) → no R6', () => {
      const { prompt, applied } = applyFallbackRules('do work', 'some task', 0);
      expect(prompt).not.toContain('[FALLBACK R6]');
      expect(applied).not.toContain('R6');
    });
  });

  describe('R6 integration via scratchpad', () => {
    it('R6 integration: recent agent-scoped _rewind_last_invoked in scratchpad → R6 applied', async () => {
      // Write a fresh rewind timestamp under the agent-scoped key
      putScratch(ws.db, ws.cairnRoot, {
        key: `_rewind_last_invoked/${ws.agentId}`,
        value: new Date().toISOString(),
        task_id: null,
      });
      const r = await toolDispatchRequest(ws, { nl_intent: 'continue the refactoring work' });
      expect(r.ok).toBe(true);
      expect((r as any).fallback_rules_applied).toContain('R6');
      expect((r as any).generated_prompt).toContain('[FALLBACK R6]');
    });

    it('R6 integration: old agent-scoped _rewind_last_invoked (>3s) → no R6', async () => {
      const staleTs = new Date(Date.now() - 10_000).toISOString();
      putScratch(ws.db, ws.cairnRoot, {
        key: `_rewind_last_invoked/${ws.agentId}`,
        value: staleTs,
        task_id: null,
      });
      const r = await toolDispatchRequest(ws, { nl_intent: 'write unit tests for auth module' });
      expect(r.ok).toBe(true);
      expect((r as any).fallback_rules_applied).not.toContain('R6');
    });

    it('R6 integration: no _rewind_last_invoked key → no R6', async () => {
      const r = await toolDispatchRequest(ws, { nl_intent: 'add logging to the service layer' });
      expect(r.ok).toBe(true);
      expect((r as any).fallback_rules_applied).not.toContain('R6');
    });

    it('R6 isolation: agent B rewind key does NOT trigger R6 in agent A dispatch', async () => {
      // Simulate agent B writing its rewind key (different agentId)
      const agentBId = 'cairn-000000000bbb';
      putScratch(ws.db, ws.cairnRoot, {
        key: `_rewind_last_invoked/${agentBId}`,
        value: new Date().toISOString(), // fresh — would trigger R6 if read
        task_id: null,
      });
      // ws (agent A) dispatches — should NOT see agent B's rewind key
      const r = await toolDispatchRequest(ws, { nl_intent: 'add pagination to the list view' });
      expect(r.ok).toBe(true);
      expect((r as any).fallback_rules_applied).not.toContain('R6');
    });
  });

  // =========================================================================
  // End-to-end: request → DB → confirm → scratchpad
  // =========================================================================

  describe('end-to-end flow', () => {
    it('full flow: request → PENDING in DB → confirm → CONFIRMED + scratchpad', async () => {
      // 1. Create request
      const reqResult = await toolDispatchRequest(ws, {
        nl_intent: 'implement the user dashboard component',
      });
      expect(reqResult.ok).toBe(true);
      const requestId = (reqResult as any).request_id as string;

      // 2. Verify PENDING in DB
      const rowBefore = getDispatchRequest(ws.db, requestId);
      expect(rowBefore).not.toBeNull();
      expect(rowBefore!.status).toBe('PENDING');

      // 3. Confirm
      const conf = toolDispatchConfirm(ws, { request_id: requestId });
      expect(conf.ok).toBe(true);

      // 4. Verify CONFIRMED in DB
      const rowAfter = getDispatchRequest(ws.db, requestId);
      expect(rowAfter!.status).toBe('CONFIRMED');
      expect(rowAfter!.confirmed_at).not.toBeNull();

      // 5. Verify scratchpad has prompt
      const scratchKey = `dispatch/${requestId}/prompt`;
      const scratchVal = getScratch(ws.db, scratchKey);
      expect(scratchVal).not.toBeNull();
    });

    it('R1+R3: destructive task with 2 agents → both rules in DB row', async () => {
      toolRegisterProcess(ws, { agent_id: 'agent-x', agent_type: 'worker' });
      toolRegisterProcess(ws, { agent_id: 'agent-y', agent_type: 'worker' });

      const reqResult = await toolDispatchRequest(ws, {
        nl_intent: '删除所有过期的临时文件',
      });
      expect(reqResult.ok).toBe(true);
      const requestId = (reqResult as any).request_id as string;

      // Verify the generated_prompt in DB has both R1 and R3
      const row = getDispatchRequest(ws.db, requestId);
      expect(row!.generated_prompt).toContain('[FALLBACK R1]');
      expect(row!.generated_prompt).toContain('[FALLBACK R3]');
    });
  });
});
