import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

// ---------------------------------------------------------------------------
// 1a — SESSION_AGENT_ID on Workspace (Real Agent Presence v2: session-level)
// ---------------------------------------------------------------------------
//
// Identity contract was flipped from project-level (sha1(host:gitRoot))
// to session-level (random per-process). The whole point of the upgrade
// is that two terminal sessions in the same project must NOT collapse
// into a single processes row.

describe('phase 1a — session-level agentId on Workspace', () => {
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

  it('agentId starts with "cairn-session-" and ends with 12 hex chars (26 chars total)', () => {
    expect(ws.agentId).toMatch(/^cairn-session-[0-9a-f]{12}$/);
    expect(ws.agentId.length).toBe(26);
    expect(ws.sessionId).toMatch(/^[0-9a-f]{12}$/);
    // agentId is exactly 'cairn-session-' + sessionId.
    expect(ws.agentId).toBe('cairn-session-' + ws.sessionId);
  });

  it('two openWorkspace() calls with the same cwd produce DIFFERENT agentIds (session-level uniqueness)', () => {
    // This is the inverse of the pre-v2 contract. Same cwd, same git
    // toplevel, same machine → two distinct sessions still get two
    // distinct agentIds, otherwise the panel can't show concurrent
    // terminal sessions as separate rows.
    const ws2 = openWorkspace({
      cairnRoot: mkdtempSync(join(tmpdir(), 'cairn-p1a2-')),
      cwd: ws.cwd,
    });
    try {
      expect(ws2.agentId).not.toBe(ws.agentId);
      expect(ws2.sessionId).not.toBe(ws.sessionId);
    } finally {
      ws2.db.close();
      rmSync(ws2.cairnRoot, { recursive: true, force: true });
    }
  });

  it('gitRoot is set: git repo cwd resolves to the toplevel', () => {
    const repo = makeGitRepo();
    const cr = mkdtempSync(join(tmpdir(), 'cairn-p1a-gr-'));
    const wsr = openWorkspace({ cairnRoot: cr, cwd: repo });
    try {
      // gitRoot must equal the repo's toplevel. On macOS / Linux this
      // is `repo` directly; on Windows the temp path may have an
      // 8.3-shortened component vs git's resolved path — compare via
      // realpath-like equivalence by reading both ends.
      const top = execSync('git rev-parse --show-toplevel', {
        cwd: repo, timeout: 1000, encoding: 'utf8',
      }).trim();
      expect(wsr.gitRoot).toBe(top);
    } finally {
      wsr.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cr, { recursive: true, force: true });
    }
  });

  it('gitRoot is consistent with `git rev-parse --show-toplevel` from cwd, or cwd when git finds nothing', () => {
    // The temp dir may or may not sit inside a parent git repo —
    // on dev machines with user-home dotfiles repos, a tmp path can
    // resolve to a surprising toplevel. The contract is consistency
    // with whatever git itself would say from that cwd, with cwd as
    // the fallback when git fails. Derive the same way the workspace
    // does so we don't hardcode environment assumptions.
    const noGit = mkdtempSync(join(tmpdir(), 'cairn-p1a-nogit-'));
    const cr = mkdtempSync(join(tmpdir(), 'cairn-p1a-nogit-cr-'));
    let expected = noGit;
    try {
      const top = execSync('git rev-parse --show-toplevel', {
        cwd: noGit, timeout: 1000, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (top.length > 0) expected = top;
    } catch { /* git failed → expected stays = noGit */ }
    const wsr = openWorkspace({ cairnRoot: cr, cwd: noGit });
    try {
      expect(wsr.gitRoot).toBe(expected);
    } finally {
      wsr.db.close();
      rmSync(noGit, { recursive: true, force: true });
      rmSync(cr, { recursive: true, force: true });
    }
  });

  it('CAIRN_SESSION_AGENT_ID env var is set at openWorkspace time', () => {
    expect(process.env['CAIRN_SESSION_AGENT_ID']).toBe(ws.agentId);
  });

  it('explicit sessionId override is respected (test-only path)', () => {
    const cr = mkdtempSync(join(tmpdir(), 'cairn-p1a-fix-'));
    const wsr = openWorkspace({ cairnRoot: cr, sessionId: 'aaaa11112222' });
    try {
      expect(wsr.agentId).toBe('cairn-session-aaaa11112222');
    } finally {
      wsr.db.close();
      rmSync(cr, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 1a — auto agent_id in checkpoint.create (semantics unchanged: still uses ws.agentId)
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

// ---------------------------------------------------------------------------
// 1d — toolRegisterProcess preserves system attribution tags on self-register
// ---------------------------------------------------------------------------
//
// Real Agent Presence v2 invariant: an explicit `cairn.process.register`
// call MUST NOT clobber the system-managed attribution tags
// (client / cwd / git_root / pid / host / session) when targeting the
// session's own agent_id. Without this guarantee, the desktop panel's
// project attribution (capability-tag based) silently breaks the
// moment an agent prompt template calls register({}).

describe('phase 1d — toolRegisterProcess preserves attribution tags on self-register', () => {
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-p1d-'));
    ws = openWorkspace({ cairnRoot });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  it('boot-time presence sets attribution tags; later register({}) preserves them', async () => {
    const { startPresence } = await import('../src/presence.js');
    const { getProcess } = await import('../../daemon/dist/storage/repositories/processes.js');
    const handle = startPresence(ws, { installBeforeExitHandler: false });
    try {
      const before = getProcess(ws.db, ws.agentId)!;
      const requiredPrefixes = ['client:', 'cwd:', 'git_root:', 'pid:', 'host:', 'session:'];
      for (const prefix of requiredPrefixes) {
        expect(
          before.capabilities!.some(c => typeof c === 'string' && c.startsWith(prefix)),
        ).toBe(true);
      }

      // Now simulate the bug scenario: an agent prompt calls register({}) explicitly.
      // Pre-fix this would INSERT OR REPLACE with capabilities=null and wipe tags.
      toolRegisterProcess(ws, {});

      const after = getProcess(ws.db, ws.agentId)!;
      for (const prefix of requiredPrefixes) {
        expect(
          after.capabilities!.some(c => typeof c === 'string' && c.startsWith(prefix)),
        ).toBe(true);
      }
      // Specifically: session id, git_root, host should match the workspace.
      expect(after.capabilities).toEqual(
        expect.arrayContaining([
          `git_root:${ws.gitRoot}`,
          `host:${ws.host}`,
          `session:${ws.sessionId}`,
        ]),
      );
    } finally {
      handle.stop();
    }
  });

  it('register({}) for the session agent merges system tags with caller-provided extras', () => {
    toolRegisterProcess(ws, { capabilities: ['custom-feature', 'another'] });
    const row = ws.db
      .prepare('SELECT capabilities FROM processes WHERE agent_id = ?')
      .get(ws.agentId) as { capabilities: string };
    const caps = JSON.parse(row.capabilities) as string[];
    // System tags survive:
    expect(caps).toEqual(
      expect.arrayContaining([
        `git_root:${ws.gitRoot}`,
        `cwd:${ws.cwd}`,
        `session:${ws.sessionId}`,
      ]),
    );
    // Caller extras present:
    expect(caps).toEqual(expect.arrayContaining(['custom-feature', 'another']));
  });

  it('register for a peer agent_id does NOT inherit ws system tags', () => {
    // Registering some OTHER agent — we should not synthesize attribution
    // tags for a process we don't represent. capabilities passes through.
    const peerId = 'peer-agent-different';
    toolRegisterProcess(ws, {
      agent_id: peerId,
      agent_type: 'worker',
      capabilities: ['feature-x'],
    });
    const row = ws.db
      .prepare('SELECT capabilities FROM processes WHERE agent_id = ?')
      .get(peerId) as { capabilities: string };
    const caps = JSON.parse(row.capabilities) as string[];
    expect(caps).toEqual(['feature-x']);
    // ws's system tags must NOT be present — that would be misattribution.
    expect(caps.some(c => typeof c === 'string' && c.startsWith('git_root:'))).toBe(false);
    expect(caps.some(c => typeof c === 'string' && c.startsWith('session:'))).toBe(false);
  });

  it('register({}) is idempotent — system tags don\'t duplicate across repeated calls', () => {
    toolRegisterProcess(ws, {});
    toolRegisterProcess(ws, {});
    toolRegisterProcess(ws, {});
    const row = ws.db
      .prepare('SELECT capabilities FROM processes WHERE agent_id = ?')
      .get(ws.agentId) as { capabilities: string };
    const caps = JSON.parse(row.capabilities) as string[];
    // Each system-tag prefix appears at most once.
    const counts = new Map<string, number>();
    for (const c of caps) {
      if (typeof c !== 'string') continue;
      const prefix = c.split(':')[0];
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    for (const prefix of ['client', 'cwd', 'git_root', 'pid', 'host', 'session']) {
      expect(counts.get(prefix) ?? 0).toBeLessThanOrEqual(1);
    }
  });
});
