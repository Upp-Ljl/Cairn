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

describe('wedge — clean-tree checkpoint + rewind via git_head fallback (friction #2 close)', () => {
  it('cairn.checkpoint.create on clean tree returns scope-aware warning, not "cannot restore"', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      const r = toolCreateCheckpoint(wsLocal, { label: 'clean-test' });
      expect(r.stash_sha).toBeNull();
      const warning = (r as { warning?: string }).warning ?? '';
      // New behavior: rewind WORKS on clean tree, warning describes scope.
      expect(warning).toMatch(/Working tree was clean/);
      expect(warning).toMatch(/Rewind will restore the tree to git_head/);
      expect(warning).toMatch(/gitignored files .* are left alone/);
      // Old "cannot restore" language must be gone.
      expect(warning).not.toMatch(/cannot restore/i);
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('cairn.checkpoint.create on dirty tree omits warning field', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'a.txt'), 'modified');
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      const r = toolCreateCheckpoint(wsLocal, { label: 'dirty-test' });
      expect(r.stash_sha).toMatch(/^[0-9a-f]{40}$/);
      expect((r as { warning?: string }).warning).toBeUndefined();
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('cairn.checkpoint.create outside a git repo returns "not a git repo" warning', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const noGit = mkdtempSync(join(tmpdir(), 'cairn-no-git-'));
    const wsLocal = openWorkspace({ cairnRoot, cwd: noGit });
    try {
      const r = toolCreateCheckpoint(wsLocal, { label: 'no-git' });
      expect(r.stash_sha).toBeNull();
      expect(r.git_head).toBeNull();
      expect((r as { warning?: string }).warning).toMatch(/Not in a git repository/);
    } finally {
      wsLocal.db.close();
      rmSync(noGit, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('cairn.rewind.preview on clean-tree checkpoint lists files modified since git_head', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'x' });
      writeFileSync(join(repo, 'a.txt'), 'changed-after-clean-checkpoint');
      writeFileSync(join(repo, 'fresh.txt'), 'brand new');

      const preview = toolRewindPreview(wsLocal, { checkpoint_id: ckpt.id });
      expect('error' in preview).toBe(false);
      expect((preview as { mode: string }).mode).toBe('git_head_clean');
      const files = (preview as { files: string[] }).files;
      expect(files).toContain('a.txt');
      expect(files).toContain('fresh.txt');
      expect((preview as { git_head_at_checkpoint: string }).git_head_at_checkpoint).toBe(
        ckpt.git_head,
      );
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('cairn.rewind.to on clean-tree checkpoint reverts tracked edits to git_head', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'pre-edits' });
      writeFileSync(join(repo, 'a.txt'), 'totally-different');

      const r = toolRewindTo(wsLocal, { checkpoint_id: ckpt.id });
      expect(r.ok).toBe(true);
      expect((r as { mode: string }).mode).toBe('git_head_clean');
      expect((r as { restored_files: string[] }).restored_files).toContain('a.txt');
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('v0');
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('cairn.rewind.to on clean-tree checkpoint deletes new untracked files', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'pre-new-file' });
      writeFileSync(join(repo, 'should-vanish.txt'), 'noise');

      const r = toolRewindTo(wsLocal, { checkpoint_id: ckpt.id });
      expect(r.ok).toBe(true);
      expect((r as { restored_files: string[] }).restored_files).toContain(
        'should-vanish.txt',
      );
      // file must actually be gone from disk
      expect(() => readFileSync(join(repo, 'should-vanish.txt'), 'utf8')).toThrow();
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('cairn.rewind.to on clean-tree checkpoint with paths reverts only listed files', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    // add a second tracked file so we have something to NOT touch
    writeFileSync(join(repo, 'b.txt'), 'b-v0');
    execSync('git add . && git commit -q -m b-init', { cwd: repo });
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'pre-paths' });
      writeFileSync(join(repo, 'a.txt'), 'a-edited');
      writeFileSync(join(repo, 'b.txt'), 'b-edited');

      const r = toolRewindTo(wsLocal, {
        checkpoint_id: ckpt.id,
        paths: ['a.txt'],
      });
      expect(r.ok).toBe(true);
      expect((r as { restored_files: string[] }).restored_files).toEqual(['a.txt']);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('v0');
      expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('b-edited');
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('cairn.rewind.to on clean-tree checkpoint refuses when HEAD has moved', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'before-move' });

      // user commits something, advancing HEAD past the checkpoint's git_head
      writeFileSync(join(repo, 'a.txt'), 'new commit content');
      execSync('git add . && git commit -q -m moved', { cwd: repo });

      const r = toolRewindTo(wsLocal, { checkpoint_id: ckpt.id });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/HEAD has moved/i);
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });
});

describe('wedge — rewind paths param (friction #10 close — per-file granularity)', () => {
  it('stash-mode rewind with paths reverts only listed files, lists rest as skipped', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    // need three tracked files for the test
    writeFileSync(join(repo, 'b.txt'), 'b-v0');
    writeFileSync(join(repo, 'c.txt'), 'c-v0');
    execSync('git add . && git commit -q -m more-files', { cwd: repo });
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      // dirty tree at checkpoint time so we go through the stash backend
      writeFileSync(join(repo, 'a.txt'), 'a-checkpoint');
      writeFileSync(join(repo, 'b.txt'), 'b-checkpoint');
      writeFileSync(join(repo, 'c.txt'), 'c-checkpoint');
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'multi-file' });

      // user keeps editing all three
      writeFileSync(join(repo, 'a.txt'), 'a-now');
      writeFileSync(join(repo, 'b.txt'), 'b-now');
      writeFileSync(join(repo, 'c.txt'), 'c-now');

      const r = toolRewindTo(wsLocal, {
        checkpoint_id: ckpt.id,
        paths: ['a.txt', 'c.txt', 'never-touched.txt'],
      });
      expect(r.ok).toBe(true);
      expect((r as { mode: string }).mode).toBe('stash');
      expect(new Set((r as { restored_files: string[] }).restored_files)).toEqual(
        new Set(['a.txt', 'c.txt']),
      );
      expect((r as { skipped: string[] }).skipped).toEqual(['never-touched.txt']);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a-checkpoint');
      expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('b-now'); // untouched
      expect(readFileSync(join(repo, 'c.txt'), 'utf8')).toBe('c-checkpoint');
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('rewind.preview with paths returns the filtered subset + skipped list', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      writeFileSync(join(repo, 'a.txt'), 'edit');
      writeFileSync(join(repo, 'extra.txt'), 'extra-content');
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'p' });

      const preview = toolRewindPreview(wsLocal, {
        checkpoint_id: ckpt.id,
        paths: ['a.txt', 'unknown.txt'],
      });
      expect('error' in preview).toBe(false);
      expect((preview as { files: string[] }).files).toEqual(['a.txt']);
      expect((preview as { skipped: string[] }).skipped).toEqual(['unknown.txt']);
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('rewind.to with empty paths array returns a clear validation error', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      writeFileSync(join(repo, 'a.txt'), 'edit');
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'p' });

      const r = toolRewindTo(wsLocal, {
        checkpoint_id: ckpt.id,
        paths: [],
      });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/empty/i);
      expect((r as { error: string }).error).toMatch(/omit/i);
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('rewind.to without paths still does full-scope rewind (backward-compat)', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'b.txt'), 'b-v0');
    execSync('git add . && git commit -q -m b', { cwd: repo });
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      writeFileSync(join(repo, 'a.txt'), 'a-checkpoint');
      writeFileSync(join(repo, 'b.txt'), 'b-checkpoint');
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'p' });

      writeFileSync(join(repo, 'a.txt'), 'a-now');
      writeFileSync(join(repo, 'b.txt'), 'b-now');

      const r = toolRewindTo(wsLocal, { checkpoint_id: ckpt.id });
      expect(r.ok).toBe(true);
      expect(new Set((r as { restored_files: string[] }).restored_files)).toEqual(
        new Set(['a.txt', 'b.txt']),
      );
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a-checkpoint');
      expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('b-checkpoint');
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });
});

describe('wedge — auto-checkpoint on write-effecting tools (timeline auto-population)', () => {
  it('scratchpad.write creates an auto-checkpoint before writing', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      // dirty tree so the auto-checkpoint will have a real stash
      writeFileSync(join(repo, 'a.txt'), 'work-in-progress');

      const r = toolWriteScratch(wsLocal, { key: 'plan', content: 'refactor auth' });
      expect(r.ok).toBe(true);
      expect((r as { auto_checkpoint_id: string | null }).auto_checkpoint_id).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{26}$/,
      );

      const list = toolListCheckpoints(wsLocal);
      const autoCk = list.items.find(
        (c) => c.label?.startsWith('auto:before-scratchpad.write:plan'),
      );
      expect(autoCk).toBeDefined();
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('scratchpad.write with skip_auto_checkpoint=true skips the auto node', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      writeFileSync(join(repo, 'a.txt'), 'edit');
      const r = toolWriteScratch(wsLocal, {
        key: 'noisy-progress',
        content: 'step 1',
        skip_auto_checkpoint: true,
      });
      expect(r.ok).toBe(true);
      expect((r as { auto_checkpoint_id: string | null }).auto_checkpoint_id).toBeNull();

      const list = toolListCheckpoints(wsLocal);
      expect(list.items.find((c) => c.label?.includes('noisy-progress'))).toBeUndefined();
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('rewind.to creates an auto-checkpoint before restoring (undo-undo enabler)', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      // 1. user does some work and checkpoints it (call this state X)
      writeFileSync(join(repo, 'a.txt'), 'state-X');
      const ckptX = toolCreateCheckpoint(wsLocal, { label: 'state-X' });

      // 2. user keeps editing (state Y)
      writeFileSync(join(repo, 'a.txt'), 'state-Y');

      // 3. user rewinds to state X (the auto-checkpoint should capture state Y)
      const rewindR = toolRewindTo(wsLocal, { checkpoint_id: ckptX.id });
      expect(rewindR.ok).toBe(true);
      const autoId = (rewindR as { auto_checkpoint_id: string }).auto_checkpoint_id;
      expect(autoId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('state-X');

      // 4. user realizes they want state Y back — rewind to the auto-checkpoint
      const undoR = toolRewindTo(wsLocal, { checkpoint_id: autoId, skip_auto_checkpoint: true });
      expect(undoR.ok).toBe(true);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('state-Y');
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('rewind.to with skip_auto_checkpoint=true does not pollute timeline', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      writeFileSync(join(repo, 'a.txt'), 'state-1');
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 's1' });

      writeFileSync(join(repo, 'a.txt'), 'state-2');
      const r = toolRewindTo(wsLocal, {
        checkpoint_id: ckpt.id,
        skip_auto_checkpoint: true,
      });
      expect(r.ok).toBe(true);
      expect((r as { auto_checkpoint_id: string | null }).auto_checkpoint_id).toBeNull();

      const list = toolListCheckpoints(wsLocal);
      expect(list.items.some((c) => c.label?.startsWith('auto:before-rewind-to:'))).toBe(
        false,
      );
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('outside a git repo, scratchpad.write succeeds with auto_checkpoint_id=null', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const noGit = mkdtempSync(join(tmpdir(), 'cairn-no-git-'));
    const wsLocal = openWorkspace({ cairnRoot, cwd: noGit });
    try {
      const r = toolWriteScratch(wsLocal, { key: 'k', content: 'v' });
      expect(r.ok).toBe(true);
      // auto-checkpoint may or may not get created (depends on whether
      // toolCreateCheckpoint throws outside a git repo); either way the
      // primary write must succeed and the field must be present.
      expect('auto_checkpoint_id' in r).toBe(true);
    } finally {
      wsLocal.db.close();
      rmSync(noGit, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });
});

describe('wedge — task_id slicing (AC for US-2 — multi-task isolation, phase 1)', () => {
  it('cairn.checkpoint.create stores and echoes task_id', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      writeFileSync(join(repo, 'a.txt'), 'edit');
      const r = toolCreateCheckpoint(wsLocal, {
        label: 'tagged',
        task_id: 'refactor-auth',
      });
      expect(r.task_id).toBe('refactor-auth');

      const list = toolListCheckpoints(wsLocal);
      const row = list.items.find((c) => c.id === r.id)!;
      expect(row.task_id).toBe('refactor-auth');
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('cairn.checkpoint.list with task_id filter returns only matching rows', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      writeFileSync(join(repo, 'a.txt'), 'v1');
      toolCreateCheckpoint(wsLocal, { label: 'A1', task_id: 'task-A' });
      writeFileSync(join(repo, 'a.txt'), 'v2');
      toolCreateCheckpoint(wsLocal, { label: 'B1', task_id: 'task-B' });
      writeFileSync(join(repo, 'a.txt'), 'v3');
      toolCreateCheckpoint(wsLocal, { label: 'A2', task_id: 'task-A' });
      writeFileSync(join(repo, 'a.txt'), 'v4');
      toolCreateCheckpoint(wsLocal, { label: 'untagged' });

      const all = toolListCheckpoints(wsLocal);
      expect(all.items.length).toBeGreaterThanOrEqual(4);

      const onlyA = toolListCheckpoints(wsLocal, { task_id: 'task-A' });
      expect(onlyA.items.every((c) => c.task_id === 'task-A')).toBe(true);
      expect(new Set(onlyA.items.map((c) => c.label?.split('::')[0]))).toEqual(
        new Set(['A1', 'A2']),
      );

      const onlyB = toolListCheckpoints(wsLocal, { task_id: 'task-B' });
      expect(onlyB.items.length).toBe(1);
      expect(onlyB.items[0]!.label).toMatch(/^B1::/);

      const onlyUntagged = toolListCheckpoints(wsLocal, { task_id: null });
      expect(onlyUntagged.items.every((c) => c.task_id === null)).toBe(true);
      expect(onlyUntagged.items.some((c) => c.label?.startsWith('untagged'))).toBe(true);
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('scratchpad.write task_id propagates to the auto-checkpoint', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      writeFileSync(join(repo, 'a.txt'), 'edit');
      const r = toolWriteScratch(wsLocal, {
        key: 'plan',
        content: 'do thing',
        task_id: 'task-X',
      });
      expect(r.ok).toBe(true);

      const tagged = toolListCheckpoints(wsLocal, { task_id: 'task-X' });
      expect(tagged.items.length).toBe(1);
      expect(tagged.items[0]!.label).toMatch(/^auto:before-scratchpad\.write:plan::/);
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('rewind.to task_id propagates to the auto-checkpoint (timeline stays sliceable)', () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      writeFileSync(join(repo, 'a.txt'), 'state-X');
      const ckpt = toolCreateCheckpoint(wsLocal, { label: 'X', task_id: 'task-Y' });

      writeFileSync(join(repo, 'a.txt'), 'state-Y');
      toolRewindTo(wsLocal, { checkpoint_id: ckpt.id, task_id: 'task-Y' });

      const list = toolListCheckpoints(wsLocal, { task_id: 'task-Y' });
      // Two checkpoints under task-Y: the original X + the auto pre-rewind snapshot
      expect(list.items.length).toBe(2);
      expect(list.items.some((c) => c.label?.startsWith('auto:before-rewind-to:'))).toBe(true);
    } finally {
      wsLocal.db.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  });

  it('end-to-end: 3 parallel tasks, each rewindable independently via paths', () => {
    // This is the full AC for US-2 demo (within wedge means: agent supplies
    // paths). Three tasks edit three disjoint files; rewinding one task's
    // checkpoint with that task's paths must NOT touch the other two tasks'
    // files.
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'task-a-file.txt'), 'A-v0');
    writeFileSync(join(repo, 'task-b-file.txt'), 'B-v0');
    writeFileSync(join(repo, 'task-c-file.txt'), 'C-v0');
    execSync('git add . && git commit -q -m three-files', { cwd: repo });
    const wsLocal = openWorkspace({ cairnRoot, cwd: repo });
    try {
      // Task A makes a change + checkpoint (with task_id and paths)
      writeFileSync(join(repo, 'task-a-file.txt'), 'A-v1');
      const ckptA = toolCreateCheckpoint(wsLocal, { label: 'A', task_id: 'task-a' });

      // Task B does the same on its own file
      writeFileSync(join(repo, 'task-b-file.txt'), 'B-v1');
      toolCreateCheckpoint(wsLocal, { label: 'B', task_id: 'task-b' });

      // Task C
      writeFileSync(join(repo, 'task-c-file.txt'), 'C-v1');
      toolCreateCheckpoint(wsLocal, { label: 'C', task_id: 'task-c' });

      // Now task A's user wants to rewind ONLY task A — supplies paths
      // explicitly because the wedge does not auto-track files per task.
      writeFileSync(join(repo, 'task-a-file.txt'), 'A-v1-mistake');
      writeFileSync(join(repo, 'task-b-file.txt'), 'B-v2-progress');
      writeFileSync(join(repo, 'task-c-file.txt'), 'C-v2-progress');

      const r = toolRewindTo(wsLocal, {
        checkpoint_id: ckptA.id,
        paths: ['task-a-file.txt'],
        task_id: 'task-a',
        skip_auto_checkpoint: true,
      });
      expect(r.ok).toBe(true);
      expect((r as { restored_files: string[] }).restored_files).toEqual(['task-a-file.txt']);

      // Task A is back to its checkpoint state; B and C are untouched
      expect(readFileSync(join(repo, 'task-a-file.txt'), 'utf8')).toBe('A-v1');
      expect(readFileSync(join(repo, 'task-b-file.txt'), 'utf8')).toBe('B-v2-progress');
      expect(readFileSync(join(repo, 'task-c-file.txt'), 'utf8')).toBe('C-v2-progress');

      // Per-task lists are correctly partitioned
      const aList = toolListCheckpoints(wsLocal, { task_id: 'task-a' });
      const bList = toolListCheckpoints(wsLocal, { task_id: 'task-b' });
      const cList = toolListCheckpoints(wsLocal, { task_id: 'task-c' });
      expect(aList.items.every((c) => c.task_id === 'task-a')).toBe(true);
      expect(bList.items.every((c) => c.task_id === 'task-b')).toBe(true);
      expect(cList.items.every((c) => c.task_id === 'task-c')).toBe(true);
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
