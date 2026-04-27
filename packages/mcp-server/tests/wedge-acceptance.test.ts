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

describe('wedge — clean-tree checkpoint UX (bug #1+#2 fix)', () => {
  it('cairn.checkpoint.create on clean tree returns warning field', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      // do NOT modify any file — clean tree
      const r = toolCreateCheckpoint(wsLocal, { label: 'clean-test' });
      expect(r.stash_sha).toBeNull();
      expect((r as { warning?: string }).warning).toMatch(/Working tree was clean/);
      expect((r as { warning?: string }).warning).toMatch(/cannot restore/);
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('cairn.checkpoint.create on dirty tree does NOT include warning field', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'a.txt'), 'modified');
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      const r = toolCreateCheckpoint(wsLocal, { label: 'dirty-test' });
      expect(r.stash_sha).toMatch(/^[0-9a-f]{40}$/);
      // warning field should be absent (undefined when accessed)
      expect((r as { warning?: string }).warning).toBeUndefined();
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('cairn.rewind.preview on clean-tree checkpoint returns user-friendly error', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'x' });
      // user makes edits AFTER checkpoint
      writeFileSync(join(repo, 'a.txt'), 'changed-after-clean-checkpoint');
      const preview = toolRewindPreview(wsLocal, { checkpoint_id: ckpt.id });
      const err = (preview as { error?: string }).error ?? '';
      // No internal jargon
      expect(err).not.toMatch(/stash backend/);
      // User-actionable language
      expect(err).toMatch(/captured no changes/);
      expect(err).toMatch(/working tree was clean/);
      expect(err).toMatch(/Tip:/);
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('cairn.rewind.to on clean-tree checkpoint returns same friendly error', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'x' });
      writeFileSync(join(repo, 'a.txt'), 'oops');
      const r = toolRewindTo(wsLocal, { checkpoint_id: ckpt.id });
      expect(r.ok).toBe(false);
      const err = (r as { error?: string }).error ?? '';
      expect(err).not.toMatch(/stash backend/);
      expect(err).toMatch(/captured no changes/);
      expect(err).toMatch(/Tip:/);
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });
});

describe('wedge — scratchpad.list ISO timestamp (bug #3 fix)', () => {
  it('cairn.scratchpad.list returns updated_at_iso ISO string', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const ws2 = openWorkspace({ cairnRoot });
    try {
      toolWriteScratch(ws2, { key: 'k1', content: 'x' });
      const r = toolListScratch(ws2);
      expect(r.items).toHaveLength(1);
      const item = r.items[0]!;
      expect(item.updated_at).toBeGreaterThan(0);
      expect((item as { updated_at_iso?: string }).updated_at_iso).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
      // The ISO string should reflect the same instant as updated_at
      const parsed = new Date((item as { updated_at_iso: string }).updated_at_iso).getTime();
      expect(parsed).toBe(item.updated_at);
    } finally {
      ws2.db.close();
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });
});

describe('wedge — edge cases (T2.10)', () => {
  // Edge 1: 中文 key
  it('scratchpad accepts and round-trips Chinese-character keys', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const ws2 = openWorkspace({ cairnRoot });
    try {
      toolWriteScratch(ws2, { key: '笔记:重要', content: '中文内容测试' });
      const r = toolReadScratch(ws2, { key: '笔记:重要' });
      expect(r.found).toBe(true);
      expect(r.value).toBe('中文内容测试');
      const list = toolListScratch(ws2);
      expect(list.items.map((i) => i.key)).toContain('笔记:重要');
    } finally {
      ws2.db.close();
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  // Edge 2: large value (>128KB blob threshold)
  it('scratchpad blob-spills values exceeding 128KB and reads them back intact', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const ws2 = openWorkspace({ cairnRoot });
    try {
      const big = { data: 'x'.repeat(200_000) };
      toolWriteScratch(ws2, { key: 'huge', content: big });
      const r = toolReadScratch(ws2, { key: 'huge' });
      expect(r.found).toBe(true);
      expect(r.value).toEqual(big);
    } finally {
      ws2.db.close();
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  // Edge 3: non-git directory still works (checkpoint just returns null stash, with warning)
  it('checkpoint.create in non-git dir returns null stash_sha + warning, no throw', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const nonGit = mkdtempSync(join(tmpdir(), 'cairn-nongit-'));
    const wsLocal = openWorkspace({ cairnRoot, cwd: nonGit });
    try {
      const r = toolCreateCheckpoint(wsLocal, { label: 'no-git' });
      // gitStashSnapshot will throw inside try/catch → null
      // git rev-parse HEAD will throw inside try/catch → null
      expect(r.stash_sha).toBeNull();
      expect(r.git_head).toBeNull();
      // The clean-tree warning should still appear
      expect((r as { warning?: string }).warning).toBeDefined();
    } finally {
      wsLocal.db.close();
      rmSync(nonGit, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  // Edge 4: concurrent writes to same key (UPSERT semantics)
  it('scratchpad concurrent writes to same key — last write wins, no error', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const ws2 = openWorkspace({ cairnRoot });
    try {
      // Write 5 times in rapid succession (better-sqlite3 is sync, so this is serial-rapid not threaded-concurrent,
      // but exercises the UPSERT ON CONFLICT path)
      for (let i = 0; i < 5; i++) {
        toolWriteScratch(ws2, { key: 'race', content: `iteration-${i}` });
      }
      const r = toolReadScratch(ws2, { key: 'race' });
      expect(r.value).toBe('iteration-4');
      // List should have only 1 entry for this key (UPSERT, not INSERT)
      const list = toolListScratch(ws2);
      const raceEntries = list.items.filter((i) => i.key === 'race');
      expect(raceEntries).toHaveLength(1);
    } finally {
      ws2.db.close();
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });
});
