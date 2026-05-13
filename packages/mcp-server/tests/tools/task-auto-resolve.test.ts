/**
 * Phase 2 (sync mentor, 2026-05-14) — auto-resolve inside cairn.task.block.
 *
 * Plan: docs/superpowers/plans/2026-05-14-phase2-sync-mentor.md
 *
 * Scope of this test file: only the new auto-resolve path. The existing
 * `task.test.ts` keeps covering the passive-block + answer + cancel paths.
 *
 * Hermetic fixture: cwd === cairnRoot (a fresh tmp dir per test), so
 * `openWorkspace` resolves gitRoot to that tmpdir and `loadProfile` reads
 * CAIRN.md from there — never from the surrounding repo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openWorkspace, type Workspace } from '../../src/workspace.js';
import {
  toolCreateTask,
  toolStartAttempt,
  toolBlockTask,
} from '../../src/tools/task.js';

function initGitRepo(dir: string): void {
  // Make the dir a real git repo so resolveGitRoot uses it (not its parent).
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 's@e.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'S'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, '.placeholder'), 'x');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

const SAMPLE_CAIRN_MD = `# Auto-resolve Test Project

## Whole

A fixture project for the kernel-side known_answer auto-resolve smoke.

## Goal

Pass the test.

## Known answers

- which test framework => vitest with real DB, not mocks
- prefer ts or js => prefer TypeScript
`;

describe('cairn.task.block — auto-resolve via CAIRN.md known_answers (Phase 2)', () => {
  let projectRoot: string;
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    // projectRoot = the git repo whose CAIRN.md gets scanned
    projectRoot = mkdtempSync(join(tmpdir(), 'cairn-auto-resolve-proj-'));
    initGitRepo(projectRoot);
    // cairnRoot = where ~/.cairn/cairn.db (test version) lives — separate dir
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-auto-resolve-state-'));
    ws = openWorkspace({ cairnRoot, cwd: projectRoot });
  });

  afterEach(() => {
    ws.db.close();
    try { rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (_e) { /* tmp gc */ }
    try { rmSync(cairnRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (_e) { /* tmp gc */ }
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it('happy path: known_answer match → auto_resolved=true + READY_TO_RESUME + answer in response', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), SAMPLE_CAIRN_MD);

    const created = toolCreateTask(ws, { intent: 'demo' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });

    const r = toolBlockTask(ws, { task_id: taskId, question: 'Should I use which test framework here?' });
    expect('error' in r).toBe(false);
    if ('error' in r) return;

    expect(r.auto_resolved).toBe(true);
    if (!r.auto_resolved) return;
    expect(r.answer).toContain('vitest');
    expect(r.matched_pattern).toBe('which test framework');
    expect(r.task.state).toBe('READY_TO_RESUME');
    expect(r.blocker.status).toBe('ANSWERED');
    expect(r.blocker.answer).toContain('vitest');
    expect(typeof r.scratchpad_key).toBe('string');
    expect(r.scratchpad_key.startsWith('mentor/')).toBe(true);
    expect(r.scratchpad_key.includes('/auto_resolve/')).toBe(true);
  });

  it('writes a scratchpad event with the canonical key shape + body fields', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), SAMPLE_CAIRN_MD);
    const created = toolCreateTask(ws, { intent: 'demo' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'prefer ts or js?' });
    if ('error' in r || !r.auto_resolved) throw new Error('expected auto_resolved');

    const row = ws.db.prepare('SELECT value_json, task_id FROM scratchpad WHERE key = ?').get(r.scratchpad_key) as
      | { value_json: string; task_id: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.task_id).toBe(taskId);
    const body = JSON.parse(row!.value_json);
    expect(body.task_id).toBe(taskId);
    expect(body.blocker_id).toBe(r.blocker.blocker_id);
    expect(body.matched_pattern).toBe('prefer ts or js');
    expect(body.answer).toContain('TypeScript');
    // Phase 3 schema: `source` carries the bucket name (known_answers /
    // auto_decide / decide_and_announce); the `kernel: 'sync'` marker
    // identifies the kernel-side synchronous path. The old field
    // `source: 'kernel_sync'` collapsed both — Phase 3 splits them.
    expect(body.source).toBe('known_answers');
    expect(body.kernel).toBe('sync');
    expect(typeof body.resolved_at).toBe('number');
    expect(body.raised_by).toBe(ws.agentId);
  });

  // ---------------------------------------------------------------------------
  // No-match paths (passive block preserved)
  // ---------------------------------------------------------------------------

  it('no CAIRN.md → passive block, auto_resolved:false', () => {
    // No CAIRN.md written. loadProfile returns exists:false → no match.
    const created = toolCreateTask(ws, { intent: 'no-cairn-md' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'which test framework?' });
    if ('error' in r) throw new Error('unexpected error: ' + JSON.stringify(r));

    expect(r.auto_resolved).toBe(false);
    expect(r.task.state).toBe('BLOCKED');
    expect(r.blocker.status).toBe('OPEN');
  });

  it('CAIRN.md present but no matching pattern → passive block', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), SAMPLE_CAIRN_MD);
    const created = toolCreateTask(ws, { intent: 'no-match' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'an unrelated question about purple monkeys' });
    if ('error' in r) throw new Error('unexpected error');

    expect(r.auto_resolved).toBe(false);
    expect(r.task.state).toBe('BLOCKED');
  });

  it('CAIRN.md with empty known_answers section → passive block', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), `# X\n\n## Known answers\n\n<!-- nothing -->\n`);
    const created = toolCreateTask(ws, { intent: 'empty-known' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'which test framework?' });
    if ('error' in r) throw new Error('unexpected error');
    expect(r.auto_resolved).toBe(false);
  });

  it('CAIRN.md is malformed (no H1) → passive block, no crash', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), 'not a valid markdown document with H1');
    const created = toolCreateTask(ws, { intent: 'malformed' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'which test framework?' });
    if ('error' in r) throw new Error('unexpected error');
    expect(r.auto_resolved).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Match semantics
  // ---------------------------------------------------------------------------

  it('first-match-wins when multiple patterns are substring-eligible', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), `# X

## Known answers

- foo bar => answer-foo
- bar baz => answer-bar
`);
    const created = toolCreateTask(ws, { intent: 'multi' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'Question mentioning foo bar and bar baz' });
    if ('error' in r || !r.auto_resolved) throw new Error('expected auto_resolved');
    expect(r.matched_pattern).toBe('foo bar');
    expect(r.answer).toBe('answer-foo');
  });

  it('match is case-insensitive on both sides', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), `# X

## Known answers

- WHICH TEST framework => vitest answer
`);
    const created = toolCreateTask(ws, { intent: 'case' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'tell me Which Test Framework I should use' });
    if ('error' in r || !r.auto_resolved) throw new Error('expected auto_resolved');
    expect(r.answer).toBe('vitest answer');
  });

  // ---------------------------------------------------------------------------
  // Atomicity + caching
  // ---------------------------------------------------------------------------

  it('repeated block on different tasks each get their own auto-resolve', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), SAMPLE_CAIRN_MD);

    const t1 = toolCreateTask(ws, { intent: 't1' }).task.task_id;
    toolStartAttempt(ws, { task_id: t1 });
    const r1 = toolBlockTask(ws, { task_id: t1, question: 'which test framework?' });
    if ('error' in r1 || !r1.auto_resolved) throw new Error('t1 expected auto_resolved');

    const t2 = toolCreateTask(ws, { intent: 't2' }).task.task_id;
    toolStartAttempt(ws, { task_id: t2 });
    const r2 = toolBlockTask(ws, { task_id: t2, question: 'prefer ts or js?' });
    if ('error' in r2 || !r2.auto_resolved) throw new Error('t2 expected auto_resolved');

    expect(r1.blocker.blocker_id).not.toBe(r2.blocker.blocker_id);
    expect(r1.scratchpad_key).not.toBe(r2.scratchpad_key);
    expect(r1.answer).toContain('vitest');
    expect(r2.answer).toContain('TypeScript');
  });

  it('mtime-bumping CAIRN.md between calls picks up new known_answers', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), `# X

## Known answers

- pattern-a => answer-a
`);
    const t1 = toolCreateTask(ws, { intent: 'pre' }).task.task_id;
    toolStartAttempt(ws, { task_id: t1 });
    const r1 = toolBlockTask(ws, { task_id: t1, question: 'mention pattern-a' });
    if ('error' in r1 || !r1.auto_resolved) throw new Error('expected auto on pre');
    expect(r1.answer).toBe('answer-a');

    // Rewrite CAIRN.md with new content + bump mtime
    writeFileSync(join(projectRoot, 'CAIRN.md'), `# X

## Known answers

- pattern-b => answer-b
`);
    const future = Date.now() + 10_000;
    // utimesSync is best-effort on Windows but writeFileSync above already advanced mtime
    try {
      const { utimesSync } = require('node:fs');
      utimesSync(join(projectRoot, 'CAIRN.md'), future / 1000, future / 1000);
    } catch (_e) { /* ok */ }

    const t2 = toolCreateTask(ws, { intent: 'post' }).task.task_id;
    toolStartAttempt(ws, { task_id: t2 });
    const r2 = toolBlockTask(ws, { task_id: t2, question: 'mention pattern-b' });
    if ('error' in r2 || !r2.auto_resolved) throw new Error('expected auto on post');
    expect(r2.answer).toBe('answer-b');
  });

  // ---------------------------------------------------------------------------
  // Backward compat
  // ---------------------------------------------------------------------------

  it('passive block path retains existing { blocker, task } fields (now plus auto_resolved:false)', () => {
    const created = toolCreateTask(ws, { intent: 'compat' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'unmatched question for compat check' });
    if ('error' in r) throw new Error('unexpected error');
    // Pre-Phase-2 shape preserved
    expect(r.blocker).toBeDefined();
    expect(r.task).toBeDefined();
    expect(r.blocker.blocker_id).toBeTypeOf('string');
    expect(r.blocker.task_id).toBe(taskId);
    expect(r.task.state).toBe('BLOCKED');
    // New additive field
    expect(r.auto_resolved).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Failure modes — exceptions inside auto-resolve must NOT corrupt task
  // ---------------------------------------------------------------------------

  it('TASK_NOT_FOUND on auto-resolve path returns the standard error envelope', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), SAMPLE_CAIRN_MD);
    const r = toolBlockTask(ws, { task_id: 'ghost', question: 'which test framework?' });
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error.code).toBe('TASK_NOT_FOUND');
    }
  });

  // ---------------------------------------------------------------------------
  // Sanity: scratchpad cache key is per-project (sha1 of gitRoot prefix)
  // ---------------------------------------------------------------------------

  it('profile cache writes a project_profile_kernel/* row on first scan', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), SAMPLE_CAIRN_MD);
    const created = toolCreateTask(ws, { intent: 'cache' });
    toolStartAttempt(ws, { task_id: created.task.task_id });
    toolBlockTask(ws, { task_id: created.task.task_id, question: 'which test framework?' });

    const rows = ws.db.prepare("SELECT key FROM scratchpad WHERE key LIKE 'project_profile_kernel/%'")
      .all() as { key: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.key.startsWith('project_profile_kernel/')).toBe(true);
    expect(rows[0]!.key.length).toBe('project_profile_kernel/'.length + 16);
  });

  // ---------------------------------------------------------------------------
  // CAIRN.md exists assertion (sanity)
  // ---------------------------------------------------------------------------

  it('fixture sanity: CAIRN.md actually written before each test that needs it', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), SAMPLE_CAIRN_MD);
    expect(existsSync(join(projectRoot, 'CAIRN.md'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Phase 3 — Authority bucket routing (✅ / ⚠️ / 🛑)
  // Plan: docs/superpowers/plans/2026-05-14-phase3-authority-routing.md
  // ---------------------------------------------------------------------------

  const AUTHORITY_FIXTURE = `# Authority Test Project

## Whole

Validate Phase 3 authority routing end to end.

## Mentor authority (decision delegation)

- ✅ retry transient test failures up to 2x
- ⚠️ reduce a task time budget when 80% elapsed
- 🛑 npm publish
- 🛑 force-push to main

## Known answers

- exact pattern xyz => answer-xyz
`;

  it('✅ auto_decide match → auto_resolved=true with route=auto + synthesized answer', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), AUTHORITY_FIXTURE);
    const created = toolCreateTask(ws, { intent: 'auto-decide' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'Should I retry transient test failures here?' });
    if ('error' in r) throw new Error('unexpected error');
    expect(r.auto_resolved).toBe(true);
    if (!r.auto_resolved) return;
    expect(r.route).toBe('auto');
    expect(r.source).toBe('auto_decide');
    expect(r.answer).toContain('Mentor proceeded per CAIRN.md rule');
    expect(r.answer).toContain('retry transient test failures');
    expect(r.matched_pattern).toBe('retry transient test failures up to 2x');
    expect(r.task.state).toBe('READY_TO_RESUME');
    expect(r.scratchpad_key.includes('/auto_decide/')).toBe(true);
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r.scratchpad_key) as
      | { value_json: string } | undefined;
    const body = JSON.parse(row!.value_json);
    expect(body.source).toBe('auto_decide');
    expect(body.route).toBe('auto');
    expect(body.announce).toBe(false);
  });

  it('⚠️ decide_and_announce match → auto_resolved=true with route=announce + announce flag', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), AUTHORITY_FIXTURE);
    const created = toolCreateTask(ws, { intent: 'announce' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'Can I reduce the task time budget when most of it elapsed already?' });
    if ('error' in r) throw new Error('unexpected error');
    expect(r.auto_resolved).toBe(true);
    if (!r.auto_resolved) return;
    expect(r.route).toBe('announce');
    expect(r.source).toBe('decide_and_announce');
    expect(r.scratchpad_key.includes('/announce/')).toBe(true);
    expect(r.task.state).toBe('READY_TO_RESUME');
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r.scratchpad_key) as
      | { value_json: string } | undefined;
    const body = JSON.parse(row!.value_json);
    expect(body.announce).toBe(true);
  });

  it('🛑 escalate match → auto_resolved=false WITH mentor_recommendation (task stays BLOCKED)', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), AUTHORITY_FIXTURE);
    const created = toolCreateTask(ws, { intent: 'escalate' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'Should I run npm publish to ship this fix?' });
    if ('error' in r) throw new Error('unexpected error');
    expect(r.auto_resolved).toBe(false);
    if (r.auto_resolved) return;
    expect(r.task.state).toBe('BLOCKED');
    expect(r.blocker.status).toBe('OPEN');
    expect(r.mentor_recommendation).toBeDefined();
    expect(r.mentor_recommendation!.route).toBe('escalate');
    expect(r.mentor_recommendation!.matched_pattern).toBe('npm publish');
    expect(r.mentor_recommendation!.body).toContain('CAIRN.md 🛑 rule: npm publish');
    expect(r.mentor_recommendation!.scratchpad_key.includes('/escalate/')).toBe(true);
    const row = ws.db.prepare('SELECT value_json FROM scratchpad WHERE key = ?')
      .get(r.mentor_recommendation!.scratchpad_key) as { value_json: string } | undefined;
    expect(row).toBeDefined();
    const body = JSON.parse(row!.value_json);
    expect(body.source).toBe('escalate');
    expect(body.matched_pattern).toBe('npm publish');
  });

  it('priority: 🛑 escalate wins over ✅ auto_decide when both match', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), `# X

## Mentor authority (decision delegation)

- ✅ npm publish workflow needs review
- 🛑 npm publish
`);
    const created = toolCreateTask(ws, { intent: 'priority' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'thinking about doing npm publish later' });
    if ('error' in r) throw new Error('unexpected error');
    expect(r.auto_resolved).toBe(false);
    if (r.auto_resolved) return;
    expect(r.mentor_recommendation!.route).toBe('escalate');
  });

  it('priority: known_answers wins over authority buckets (Phase 2 cheapest path)', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), `# X

## Mentor authority (decision delegation)

- 🛑 vitest

## Known answers

- vitest => use vitest with real DB, not mocks
`);
    const created = toolCreateTask(ws, { intent: 'known-wins' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, { task_id: taskId, question: 'should I use vitest?' });
    if ('error' in r) throw new Error('unexpected error');
    expect(r.auto_resolved).toBe(true);
    if (!r.auto_resolved) return;
    expect(r.source).toBe('known_answers');
    expect(r.answer).toContain('vitest with real DB');
    expect(r.scratchpad_key.includes('/auto_resolve/')).toBe(true);
  });

  it('passive path (no match anywhere) still has no route or mentor_recommendation', () => {
    writeFileSync(join(projectRoot, 'CAIRN.md'), AUTHORITY_FIXTURE);
    const created = toolCreateTask(ws, { intent: 'passive' });
    const taskId = created.task.task_id;
    toolStartAttempt(ws, { task_id: taskId });
    const r = toolBlockTask(ws, {
      task_id: taskId,
      question: 'a totally unrelated question about purple submarines and tea',
    });
    if ('error' in r) throw new Error('unexpected error');
    expect(r.auto_resolved).toBe(false);
    if (r.auto_resolved) return;
    expect(r.mentor_recommendation).toBeUndefined();
    expect(r.task.state).toBe('BLOCKED');
  });
});
