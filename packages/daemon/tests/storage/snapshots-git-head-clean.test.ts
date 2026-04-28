import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  gitHeadCleanRestore,
  gitHeadCleanAffectedFiles,
} from '../../src/storage/snapshots/git-stash.js';

function makeRepo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-clean-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email test@cairn.local', { cwd: dir });
  execSync('git config user.name Test', { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'original');
  writeFileSync(join(dir, 'b.txt'), 'b-original');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, head };
}

describe('gitHeadCleanAffectedFiles', () => {
  it('lists tracked files that have been modified since git_head', () => {
    const { dir, head } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'changed');
      const files = gitHeadCleanAffectedFiles(dir, head);
      expect(files).toContain('a.txt');
      expect(files).not.toContain('b.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists untracked files created since git_head', () => {
    const { dir, head } = makeRepo();
    try {
      writeFileSync(join(dir, 'new.txt'), 'fresh');
      const files = gitHeadCleanAffectedFiles(dir, head);
      expect(files).toContain('new.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty list when tree is clean (matches git_head)', () => {
    const { dir, head } = makeRepo();
    try {
      const files = gitHeadCleanAffectedFiles(dir, head);
      expect(files).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitHeadCleanRestore', () => {
  it('reverts a tracked modification made after the clean checkpoint', () => {
    const { dir, head } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'user-edit');
      const restored = gitHeadCleanRestore(dir, head);
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('original');
      expect(restored).toContain('a.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes untracked files created after the clean checkpoint', () => {
    const { dir, head } = makeRepo();
    try {
      writeFileSync(join(dir, 'new.txt'), 'should be removed');
      const restored = gitHeadCleanRestore(dir, head);
      expect(existsSync(join(dir, 'new.txt'))).toBe(false);
      expect(restored).toContain('new.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not touch HEAD or commit history', () => {
    const { dir, head } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'changed');
      gitHeadCleanRestore(dir, head);
      const headAfter = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
      expect(headAfter).toBe(head);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a descriptive error when current HEAD differs from given git_head', () => {
    const { dir, head: oldHead } = makeRepo();
    try {
      // make a new commit so HEAD moves
      writeFileSync(join(dir, 'a.txt'), 'second-commit-content');
      execSync('git add . && git commit -q -m second', { cwd: dir });
      // now HEAD != oldHead
      expect(() => gitHeadCleanRestore(dir, oldHead)).toThrow(/HEAD has moved/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects .gitignore (does not delete ignored files)', () => {
    const { dir, head } = makeRepo();
    try {
      // add .gitignore tracking
      writeFileSync(join(dir, '.gitignore'), 'ignored.log\n');
      execSync('git add .gitignore && git commit -q -m gitignore', { cwd: dir });
      const headWithIgnore = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

      writeFileSync(join(dir, 'ignored.log'), 'should survive');
      writeFileSync(join(dir, 'untracked.txt'), 'should be removed');

      gitHeadCleanRestore(dir, headWithIgnore);

      expect(existsSync(join(dir, 'ignored.log'))).toBe(true);
      expect(existsSync(join(dir, 'untracked.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
