import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  gitStashSnapshot,
  gitStashRestoreFiltered,
  gitHeadCleanRestoreFiltered,
} from '../../src/storage/snapshots/git-stash.js';

function makeRepo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-paths-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email t@cairn.local', { cwd: dir });
  execSync('git config user.name T', { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'a-v0');
  writeFileSync(join(dir, 'b.txt'), 'b-v0');
  writeFileSync(join(dir, 'c.txt'), 'c-v0');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, head };
}

describe('gitStashRestoreFiltered (per-file rewind in stash mode)', () => {
  it('restores only the listed paths, leaves the others alone', () => {
    const { dir } = makeRepo();
    try {
      // user changes a + b + c at checkpoint time
      writeFileSync(join(dir, 'a.txt'), 'a-checkpoint');
      writeFileSync(join(dir, 'b.txt'), 'b-checkpoint');
      writeFileSync(join(dir, 'c.txt'), 'c-checkpoint');
      const sha = gitStashSnapshot(dir)!;

      // user keeps editing all three
      writeFileSync(join(dir, 'a.txt'), 'a-now');
      writeFileSync(join(dir, 'b.txt'), 'b-now');
      writeFileSync(join(dir, 'c.txt'), 'c-now');

      // rewind only a.txt and c.txt; b.txt should remain at "b-now"
      const result = gitStashRestoreFiltered(dir, sha, ['a.txt', 'c.txt']);

      expect(new Set(result.restored)).toEqual(new Set(['a.txt', 'c.txt']));
      expect(result.skipped).toEqual([]);
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a-checkpoint');
      expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('b-now'); // untouched
      expect(readFileSync(join(dir, 'c.txt'), 'utf8')).toBe('c-checkpoint');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports paths that were not captured in the stash as "skipped", does not error', () => {
    const { dir } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'a-checkpoint');
      const sha = gitStashSnapshot(dir)!;
      writeFileSync(join(dir, 'a.txt'), 'a-now');

      // ask to restore one file that IS in the stash + one that ISN'T
      const result = gitStashRestoreFiltered(dir, sha, ['a.txt', 'never-touched.txt']);

      expect(result.restored).toEqual(['a.txt']);
      expect(result.skipped).toEqual(['never-touched.txt']);
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a-checkpoint');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when paths is empty (refuses ambiguous full-vs-filtered intent)', () => {
    const { dir } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'a-checkpoint');
      const sha = gitStashSnapshot(dir)!;
      expect(() => gitStashRestoreFiltered(dir, sha, [])).toThrow(/paths must not be empty/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitHeadCleanRestoreFiltered (per-file rewind in clean-tree mode)', () => {
  it('reverts only the listed tracked paths, leaves the others alone', () => {
    const { dir, head } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'a-changed');
      writeFileSync(join(dir, 'b.txt'), 'b-changed');
      writeFileSync(join(dir, 'c.txt'), 'c-changed');

      const result = gitHeadCleanRestoreFiltered(dir, head, ['a.txt', 'c.txt']);

      expect(new Set(result.restored)).toEqual(new Set(['a.txt', 'c.txt']));
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a-v0');
      expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('b-changed'); // untouched
      expect(readFileSync(join(dir, 'c.txt'), 'utf8')).toBe('c-v0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes only listed untracked paths, leaves other untracked files alive', () => {
    const { dir, head } = makeRepo();
    try {
      writeFileSync(join(dir, 'kill-me.txt'), 'doomed');
      writeFileSync(join(dir, 'spare-me.txt'), 'survivor');

      const result = gitHeadCleanRestoreFiltered(dir, head, ['kill-me.txt']);

      expect(result.restored).toEqual(['kill-me.txt']);
      expect(existsSync(join(dir, 'kill-me.txt'))).toBe(false);
      expect(existsSync(join(dir, 'spare-me.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mixed tracked-edit + untracked-new in one call', () => {
    const { dir, head } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'a-edited');
      writeFileSync(join(dir, 'new.txt'), 'spawn');

      const result = gitHeadCleanRestoreFiltered(dir, head, ['a.txt', 'new.txt']);

      expect(new Set(result.restored)).toEqual(new Set(['a.txt', 'new.txt']));
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a-v0');
      expect(existsSync(join(dir, 'new.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports paths that did not differ from git_head as "skipped"', () => {
    const { dir, head } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'a-edited');
      // b.txt and c.txt are unchanged

      const result = gitHeadCleanRestoreFiltered(dir, head, ['a.txt', 'b.txt']);

      expect(result.restored).toEqual(['a.txt']);
      expect(result.skipped).toEqual(['b.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when HEAD has moved since the recorded git_head', () => {
    const { dir, head: oldHead } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'committed-change');
      execSync('git add . && git commit -q -m moved', { cwd: dir });

      writeFileSync(join(dir, 'a.txt'), 'further-edit');

      expect(() => gitHeadCleanRestoreFiltered(dir, oldHead, ['a.txt'])).toThrow(
        /HEAD has moved/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when paths is empty', () => {
    const { dir, head } = makeRepo();
    try {
      expect(() => gitHeadCleanRestoreFiltered(dir, head, [])).toThrow(
        /paths must not be empty/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
