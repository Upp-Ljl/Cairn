import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  gitStashSnapshot,
  gitStashRestore,
  gitStashAffectedFiles,
} from '../../src/storage/snapshots/git-stash.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-git-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email test@cairn.local', { cwd: dir });
  execSync('git config user.name Test', { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'original');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

describe('gitStashSnapshot', () => {
  it('captures dirty modifications and returns 40-char SHA', () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'modified');
      const sha = gitStashSnapshot(repo);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('captures untracked files', () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, 'new.txt'), 'brand new');
      const sha = gitStashSnapshot(repo);
      expect(sha).not.toBeNull();
      const files = gitStashAffectedFiles(repo, sha!);
      expect(files).toContain('new.txt');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns null when working tree is clean', () => {
    const repo = makeRepo();
    try {
      expect(gitStashSnapshot(repo)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT push the stash onto the stash stack', () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'modified');
      gitStashSnapshot(repo);
      const stashList = execSync('git stash list', { cwd: repo, encoding: 'utf8' }).trim();
      expect(stashList).toBe('');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('gitStashRestore', () => {
  it('restores tracked file modifications without touching HEAD', () => {
    const repo = makeRepo();
    try {
      const headBefore = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
      writeFileSync(join(repo, 'a.txt'), 'checkpoint-state');
      const sha = gitStashSnapshot(repo)!;

      // simulate further user edits
      writeFileSync(join(repo, 'a.txt'), 'further-changes');

      gitStashRestore(repo, sha);

      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('checkpoint-state');
      const headAfter = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
      expect(headAfter).toBe(headBefore); // HEAD untouched
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('restores untracked files captured at snapshot time', () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, 'b.txt'), 'snap-1');
      const sha = gitStashSnapshot(repo)!;

      // user deletes the file after the snapshot
      rmSync(join(repo, 'b.txt'));

      gitStashRestore(repo, sha);

      expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('snap-1');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not pollute stash stack on restore', () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'm1');
      const sha = gitStashSnapshot(repo)!;
      gitStashRestore(repo, sha);
      const stashList = execSync('git stash list', { cwd: repo, encoding: 'utf8' }).trim();
      expect(stashList).toBe('');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('gitStashAffectedFiles', () => {
  it('returns the list of changed file names in the stash', () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'changed');
      writeFileSync(join(repo, 'c.txt'), 'new');
      const sha = gitStashSnapshot(repo)!;
      const files = gitStashAffectedFiles(repo, sha);
      expect(new Set(files)).toEqual(new Set(['a.txt', 'c.txt']));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
