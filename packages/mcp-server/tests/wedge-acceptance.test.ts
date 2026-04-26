import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace, type Workspace } from '../src/workspace.js';
import {
  toolWriteScratch, toolReadScratch, toolListScratch,
} from '../src/tools/scratchpad.js';
import {
  toolCreateCheckpoint, toolListCheckpoints,
} from '../src/tools/checkpoint.js';
import {
  toolRewindPreview, toolRewindTo,
} from '../src/tools/rewind.js';

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-acc-repo-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email t@cairn.local', { cwd: dir });
  execSync('git config user.name T', { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'v0');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

describe('wedge acceptance — §17.1 7 tools end to end', () => {
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    ws = openWorkspace({ cairnRoot });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  // --- scratchpad (3) ---

  it('cairn.scratchpad.write 持久化 key/value 到 SQLite', () => {
    const r = toolWriteScratch(ws, { key: 'note:1', content: { hi: 'there' } });
    expect(r.ok).toBe(true);
    expect(r.key).toBe('note:1');
    const row = ws.db.prepare(
      'SELECT key, value_json FROM scratchpad WHERE key = ?'
    ).get('note:1') as { key: string; value_json: string };
    expect(row.key).toBe('note:1');
    expect(JSON.parse(row.value_json)).toEqual({ hi: 'there' });
  });

  it('cairn.scratchpad.read 返回先前写入的 value', () => {
    toolWriteScratch(ws, { key: 'note:1', content: { hi: 'there' } });
    const r = toolReadScratch(ws, { key: 'note:1' });
    expect(r.found).toBe(true);
    expect(r.value).toEqual({ hi: 'there' });

    const missing = toolReadScratch(ws, { key: 'does-not-exist' });
    expect(missing.found).toBe(false);
    expect(missing.value).toBeNull();
  });

  it('cairn.scratchpad.list 列出本会话所有 key', () => {
    toolWriteScratch(ws, { key: 'a', content: 1 });
    toolWriteScratch(ws, { key: 'b', content: 2 });
    toolWriteScratch(ws, { key: 'c', content: 'three' });
    const r = toolListScratch(ws);
    expect(new Set(r.items.map((i) => i.key))).toEqual(new Set(['a', 'b', 'c']));
    expect(r.items.every((i) => i.has_value)).toBe(true);
  });

  // --- checkpoint + rewind (5) ---

  it('cairn.checkpoint.create 创建 git-stash 快照并返回 id', () => {
    const repo = makeGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'v1-uncommitted');
      const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
      const r = toolCreateCheckpoint(wsLocal, { label: 'before-edit' });
      expect(r.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(r.stash_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(r.git_head).toMatch(/^[0-9a-f]{40}$/);
      wsLocal.db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('cairn.checkpoint.list 列出已有 checkpoint，按 created_at DESC', async () => {
    const repo = makeGitRepo();
    try {
      const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
      writeFileSync(join(repo, 'a.txt'), 'v1');
      const c1 = toolCreateCheckpoint(wsLocal, { label: 'first' });
      // small delay to guarantee distinct created_at
      await new Promise((r) => setTimeout(r, 5));
      writeFileSync(join(repo, 'a.txt'), 'v2');
      const c2 = toolCreateCheckpoint(wsLocal, { label: 'second' });

      const r = toolListCheckpoints(wsLocal);
      expect(r.items[0]!.id).toBe(c2.id);
      expect(r.items[1]!.id).toBe(c1.id);
      // labels include the stash SHA suffix per W1 implementation
      expect(r.items[0]!.label).toMatch(/^second::stash:[0-9a-f]{40}$/);
      wsLocal.db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('cairn.rewind.preview 返回会被覆盖的文件名清单', () => {
    const repo = makeGitRepo();
    try {
      const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
      writeFileSync(join(repo, 'a.txt'), 'changed');
      writeFileSync(join(repo, 'b.txt'), 'new');
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'p' });

      // simulate user making more edits AFTER the checkpoint
      writeFileSync(join(repo, 'a.txt'), 'changed-again');

      const preview = toolRewindPreview(wsLocal, { checkpoint_id: ckpt.id });
      expect('error' in preview).toBe(false);
      expect((preview as { files: string[] }).files).toEqual(
        expect.arrayContaining(['a.txt', 'b.txt'])
      );
      wsLocal.db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('cairn.rewind.to 还原文件到 checkpoint 时刻 + 不动 .git/HEAD（楔期约定）', () => {
    const repo = makeGitRepo();
    try {
      const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
      const headBefore = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();

      writeFileSync(join(repo, 'a.txt'), 'checkpoint-state');
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'r' });

      // user mucks around
      writeFileSync(join(repo, 'a.txt'), 'mucked-up');

      const r = toolRewindTo(wsLocal, { checkpoint_id: ckpt.id });
      expect(r.ok).toBe(true);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('checkpoint-state');

      // HEAD must be unchanged (楔期 rewind 约定)
      const headAfter = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
      expect(headAfter).toBe(headBefore);
      wsLocal.db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('完整路径：write→checkpoint→修改文件→rewind→文件复原 + scratchpad 仍在', () => {
    const repo = makeGitRepo();
    try {
      const wsLocal = openWorkspace({ cairnRoot, cwd: repo });

      // 1. write a scratchpad note
      toolWriteScratch(wsLocal, { key: 'todo', content: 'finish refactor' });

      // 2. setup file state, create checkpoint
      writeFileSync(join(repo, 'a.txt'), 'v1');
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'milestone' });

      // 3. break things
      writeFileSync(join(repo, 'a.txt'), 'v2-broken');

      // 4. preview
      const preview = toolRewindPreview(wsLocal, { checkpoint_id: ckpt.id });
      expect((preview as { files: string[] }).files).toContain('a.txt');

      // 5. rewind
      const rw = toolRewindTo(wsLocal, { checkpoint_id: ckpt.id });
      expect(rw.ok).toBe(true);

      // 6. verify file restored to v1
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('v1');

      // 7. verify HEAD unchanged
      const headAfter = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
      expect(headAfter).toBe(ckpt.git_head);

      // 8. verify scratchpad still has the note (rewind only touches files, not DB rows)
      const note = toolReadScratch(wsLocal, { key: 'todo' });
      expect(note.found).toBe(true);
      expect(note.value).toBe('finish refactor');

      wsLocal.db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
