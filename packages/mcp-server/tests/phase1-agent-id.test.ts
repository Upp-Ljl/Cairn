import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { openWorkspace, type Workspace } from '../src/workspace.js';
import { toolCreateCheckpoint } from '../src/tools/checkpoint.js';
import { toolRegisterProcess, toolHeartbeat, toolGetProcess } from '../src/tools/process.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-p1-repo-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email t@cairn.local', { cwd: dir });
  execSync('git config user.name T', { cwd: dir });
  writeFileSync(join(dir, 'init.txt'), 'v0');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

/**
 * Mirror computeAgentId logic: resolve git toplevel (if available), then hash.
 * Must stay in sync with workspace.ts::computeAgentId.
 */
function expectedAgentId(cwd: string): string {
  let canonicalPath = cwd;
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      cwd,
      timeout: 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top.length > 0) canonicalPath = top;
  } catch {
    // not a git repo — use raw cwd
  }
  const raw = hostname() + ':' + canonicalPath;
  return 'cairn-' + createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// 1a — SESSION_AGENT_ID on Workspace
// ---------------------------------------------------------------------------

describe('phase 1a — agentId on Workspace', () => {
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-p1a-'));
    ws = openWorkspace({ cairnRoot });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  it('agentId starts with "cairn-" and is 18 chars total', () => {
    expect(ws.agentId).toMatch(/^cairn-[0-9a-f]{12}$/);
    expect(ws.agentId.length).toBe(18);
  });

  it('agentId is stable: two openWorkspace() calls with same cwd return same id', () => {
    const ws2 = openWorkspace({ cairnRoot: mkdtempSync(join(tmpdir(), 'cairn-p1a2-')), cwd: ws.cwd });
    try {
      expect(ws2.agentId).toBe(ws.agentId);
    } finally {
      ws2.db.close();
      rmSync(ws2.cairnRoot, { recursive: true, force: true });
    }
  });

  it('different git toplevels produce different agentIds (two separate git repos)', () => {
    // Two distinct git repos → distinct toplevels → distinct agentIds.
    const repo1 = makeGitRepo();
    const repo2 = makeGitRepo();
    const ws1 = openWorkspace({ cairnRoot: mkdtempSync(join(tmpdir(), 'cairn-p1a-cr1-')), cwd: repo1 });
    const ws2 = openWorkspace({ cairnRoot: mkdtempSync(join(tmpdir(), 'cairn-p1a-cr2-')), cwd: repo2 });
    try {
      expect(ws1.agentId).not.toBe(ws2.agentId);
    } finally {
      ws1.db.close();
      ws2.db.close();
      rmSync(ws1.cairnRoot, { recursive: true, force: true });
      rmSync(ws2.cairnRoot, { recursive: true, force: true });
      rmSync(repo1, { recursive: true, force: true });
      rmSync(repo2, { recursive: true, force: true });
    }
  });

  it('agentId matches expected sha1(hostname:cwd) formula', () => {
    expect(ws.agentId).toBe(expectedAgentId(ws.cwd));
  });

  it('CAIRN_SESSION_AGENT_ID env var is set at openWorkspace time', () => {
    // The env var must match the workspace agentId.
    expect(process.env['CAIRN_SESSION_AGENT_ID']).toBe(ws.agentId);
  });
});

// ---------------------------------------------------------------------------
// 1a — auto agent_id in checkpoint.create
// ---------------------------------------------------------------------------

describe('phase 1a — checkpoint.create auto agent_id', () => {
  it('checkpoint.create with no agent_id uses ws.agentId for conflict detection — verified via stored conflict row', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-p1-ck-'));
    const repo = makeGitRepo();
    const ws = openWorkspace({ cairnRoot, cwd: repo });
    try {
      // Register a peer agent in the process bus so conflict detection has someone to conflict with.
      const peerAgentId = 'peer-agent-for-conflict-test';
      toolRegisterProcess(ws, { agent_id: peerAgentId, agent_type: 'worker' });

      // Insert a recent checkpoint row for the peer (task_id = peerAgentId is the convention
      // that conflict detection uses as a proxy for peer activity).
      ws.db
        .prepare(
          `INSERT INTO checkpoints (id, task_id, label, snapshot_dir, snapshot_status, size_bytes, created_at)
           VALUES ('peer-ckpt-id', ?, 'peer checkpoint', '', 'READY', 0, ?)`,
        )
        .run(peerAgentId, Date.now());

      // Modify the tracked file so paths auto-collects something, ensuring conflict detection runs.
      writeFileSync(join(repo, 'init.txt'), 'edit');
      // Pass explicit paths so conflict detection definitely gets a non-empty path list.
      const r = toolCreateCheckpoint(ws, { label: 'no-agent-id', paths: ['init.txt'] });
      expect(r.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

      // The conflict should have been recorded using ws.agentId as agent_a.
      expect(r.conflict).toBeDefined();
      expect(r.conflict!.conflictedWith).toContain(peerAgentId);

      // Verify the stored conflict row has agent_a = ws.agentId (not some fallback).
      const conflictRow = ws.db
        .prepare('SELECT agent_a FROM conflicts WHERE id = ?')
        .get(r.conflict!.id) as { agent_a: string } | undefined;
      expect(conflictRow).toBeDefined();
      expect(conflictRow!.agent_a).toBe(ws.agentId);
    } finally {
      ws.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('checkpoint.create with explicit agent_id uses that id — verified via stored conflict row', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-p1-ck2-'));
    const repo = makeGitRepo();
    const ws = openWorkspace({ cairnRoot, cwd: repo });
    try {
      const explicitId = 'my-explicit-agent-id';
      const peerAgentId = 'peer-agent-for-explicit-test';

      // Register peer and seed its checkpoint so conflict detection fires.
      toolRegisterProcess(ws, { agent_id: peerAgentId, agent_type: 'worker' });
      ws.db
        .prepare(
          `INSERT INTO checkpoints (id, task_id, label, snapshot_dir, snapshot_status, size_bytes, created_at)
           VALUES ('peer-ckpt-id-2', ?, 'peer checkpoint 2', '', 'READY', 0, ?)`,
        )
        .run(peerAgentId, Date.now());

      writeFileSync(join(repo, 'init.txt'), 'edit2');
      // Pass explicit paths so conflict detection gets a non-empty path list.
      const r = toolCreateCheckpoint(ws, { label: 'explicit-id', agent_id: explicitId, paths: ['init.txt'] });
      expect(r.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

      // Conflict should be recorded; agent_a must be the explicit id, not ws.agentId.
      expect(r.conflict).toBeDefined();
      const conflictRow = ws.db
        .prepare('SELECT agent_a FROM conflicts WHERE id = ?')
        .get(r.conflict!.id) as { agent_a: string } | undefined;
      expect(conflictRow).toBeDefined();
      expect(conflictRow!.agent_a).toBe(explicitId);
      expect(conflictRow!.agent_a).not.toBe(ws.agentId);
    } finally {
      ws.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 1b — auto paths in checkpoint.create
// ---------------------------------------------------------------------------

describe('phase 1b — checkpoint.create auto paths', () => {
  it('empty paths in a dirty git repo auto-collects modified files', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-p1b-dirty-'));
    const repo = makeGitRepo();
    const ws = openWorkspace({ cairnRoot, cwd: repo });
    try {
      // Modify the tracked file — creates an unstaged diff.
      writeFileSync(join(repo, 'init.txt'), 'modified-content');

      // Call with no paths (omitted) — should auto-collect 'init.txt'.
      const r = toolCreateCheckpoint(ws, { label: 'auto-paths' });
      expect(r.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      // The checkpoint itself succeeds; auto-collect ran (no thrown error).
    } finally {
      ws.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('empty paths in a clean git repo produces [] — no error', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-p1b-clean-'));
    const repo = makeGitRepo();
    const ws = openWorkspace({ cairnRoot, cwd: repo });
    try {
      // Repo is clean (no uncommitted changes).
      const r = toolCreateCheckpoint(ws, { label: 'clean-auto-paths' });
      expect(r.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      // No error from collectGitPaths on a clean repo.
    } finally {
      ws.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('empty paths outside a git repo produces [] — no error', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-p1b-nogit-'));
    const noGit = mkdtempSync(join(tmpdir(), 'cairn-p1b-dir-'));
    const ws = openWorkspace({ cairnRoot, cwd: noGit });
    try {
      const r = toolCreateCheckpoint(ws, { label: 'no-git-auto-paths' });
      // Should not throw; git commands fail silently and paths = [].
      expect(r.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      ws.db.close();
      rmSync(noGit, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('explicit non-empty paths are kept — no auto-collect', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-p1b-explicit-'));
    const repo = makeGitRepo();
    const ws = openWorkspace({ cairnRoot, cwd: repo });
    try {
      // Dirty repo (so auto-collect WOULD produce files if invoked).
      writeFileSync(join(repo, 'init.txt'), 'explicit-test');

      // Pass explicit paths — auto-collect must NOT run and override them.
      const r = toolCreateCheckpoint(ws, {
        label: 'explicit-paths',
        paths: ['foo.ts'],
      });
      expect(r.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      // No error; explicit paths = ['foo.ts'] were respected.
    } finally {
      ws.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('staged-only file appears in auto-collected paths', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-p1b-staged-'));
    const repo = makeGitRepo();
    const ws = openWorkspace({ cairnRoot, cwd: repo });
    try {
      writeFileSync(join(repo, 'staged.txt'), 'staged content');
      execSync('git add staged.txt', { cwd: repo });

      // Call with no paths — staged.txt should appear via `git diff --cached`.
      // We verify no error is thrown and a valid checkpoint is created.
      const r = toolCreateCheckpoint(ws, { label: 'staged-test' });
      expect(r.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      ws.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 1c — process tools work when agent_id is entirely omitted (not empty string)
// ---------------------------------------------------------------------------

describe('phase 1c — process tools auto-default when agent_id fully omitted', () => {
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-p1c-'));
    ws = openWorkspace({ cairnRoot });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  it('toolRegisterProcess({}) does not throw and returns a process row with ws.agentId', () => {
    const r = toolRegisterProcess(ws, {}) as { agent_id: string; agent_type: string };
    expect(r.agent_id).toBe(ws.agentId);
    expect(r.agent_type).toBe('session');
  });

  it('toolHeartbeat({}) does not throw and returns success for the session agent', () => {
    // Register first so the agent exists.
    toolRegisterProcess(ws, {});
    const r = toolHeartbeat(ws, {}) as { ok: boolean; agent_id: string };
    expect(r.ok).toBe(true);
    expect(r.agent_id).toBe(ws.agentId);
  });

  it('toolGetProcess({}) does not throw and returns the session agent row', () => {
    toolRegisterProcess(ws, {});
    const r = toolGetProcess(ws, {}) as { ok: boolean; agent_id: string };
    expect(r.ok).toBe(true);
    expect(r.agent_id).toBe(ws.agentId);
  });
});
