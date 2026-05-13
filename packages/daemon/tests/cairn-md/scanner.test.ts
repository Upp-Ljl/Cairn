import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeTmpDb } from '../storage/helpers.js';
import { runMigrations } from '../../src/storage/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/storage/migrations/index.js';
import {
  scanCairnMd,
  emptyProfile,
  loadProfile,
  matchKnownAnswer,
  matchBucket,
  profileCacheKey,
  resolveCairnMdPath,
  PROFILE_VERSION,
  splitSections,
  extractBullets,
  classifyAuthorityBullet,
  classifyIsBullet,
  parseKnownAnswers,
} from '../../src/cairn-md/scanner.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
let blobRoot: string;
let tmpDir: string;

const SAMPLE_CAIRN_MD = `# Test Project

## Whole

A test project that validates the schema-v2 scanner end to end.

## Goal

Ship the unit tests.

## What this project IS / IS NOT

- IS: a daemon-side parser
- IS NOT: a desktop renderer

## Mentor authority (decision delegation)

- ✅ retry transient test failures up to 2x
- ⚠️ reduce a task time budget when 80% elapsed
- 🛑 npm publish

## Project constraints

- no new npm deps

## Known answers

- which test framework => vitest with real DB, not mocks
- prefer ts or js => prefer TypeScript
`;

beforeEach(() => {
  ({ db, dir: blobRoot } = makeTmpDb());
  runMigrations(db, ALL_MIGRATIONS);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-md-scanner-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (_e) { /* tmp gc */ }
});

function writeFixture(filename: string, content: string): string {
  const p = path.join(tmpDir, filename);
  fs.writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// Pure parser
// ---------------------------------------------------------------------------

describe('scanCairnMd — schema v2 shape', () => {
  it('parses all sections from a complete fixture', () => {
    const p = scanCairnMd(writeFixture('CAIRN.md', SAMPLE_CAIRN_MD));
    expect(p.exists).toBe(true);
    expect(p.version).toBe(PROFILE_VERSION);
    expect(p.project_name).toBe('Test Project');
    expect(p.whole_sentence).toContain('schema-v2 scanner end to end');
    expect(p.goal).toBe('Ship the unit tests.');
    expect(p.is_list).toContain('a daemon-side parser');
    expect(p.is_not_list).toContain('a desktop renderer');
    expect(p.authority.auto_decide).toHaveLength(1);
    expect(p.authority.decide_and_announce).toHaveLength(1);
    expect(p.authority.escalate).toHaveLength(1);
    expect(p.authority.escalate[0]).toBe('npm publish');
    expect(p.constraints).toEqual(['no new npm deps']);
    expect(p.known_answers).toEqual([
      { pattern: 'which test framework', answer: 'vitest with real DB, not mocks' },
      { pattern: 'prefer ts or js', answer: 'prefer TypeScript' },
    ]);
  });

  it('produces sha1 + mtime metadata', () => {
    const p = scanCairnMd(writeFixture('CAIRN.md', SAMPLE_CAIRN_MD));
    expect(typeof p.source_sha1).toBe('string');
    expect(p.source_sha1!.length).toBe(16);
    expect(typeof p.source_mtime_ms).toBe('number');
    expect(p.source_mtime_ms!).toBeGreaterThan(0);
  });

  it('missing file → exists:false with default fields', () => {
    const p = scanCairnMd('/no/such/path/CAIRN.md');
    expect(p.exists).toBe(false);
    expect(p.whole_sentence).toBeNull();
    expect(p.authority.escalate).toEqual([]);
    expect(p.known_answers).toEqual([]);
    expect(p.version).toBe(PROFILE_VERSION);
  });

  it('malformed file (no H1) returns exists:true with null project_name', () => {
    const p = scanCairnMd(writeFixture('CAIRN.md', '## just an H2\n\nbody'));
    expect(p.exists).toBe(true);
    expect(p.project_name).toBeNull();
  });

  it('null filePath returns empty profile', () => {
    const p = scanCairnMd(null);
    expect(p.exists).toBe(false);
    expect(p.source_path).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchKnownAnswer
// ---------------------------------------------------------------------------

describe('matchKnownAnswer — substring + first-match-wins', () => {
  it('matches case-insensitively and returns pattern + answer', () => {
    const p = scanCairnMd(writeFixture('case.md', SAMPLE_CAIRN_MD));
    const hit = matchKnownAnswer(p, 'Should I use which test framework here?');
    expect(hit).not.toBeNull();
    expect(hit!.pattern).toBe('which test framework');
    expect(hit!.answer).toContain('vitest');
  });

  it('first-match-wins (top-down bullet order)', () => {
    // Both "which test framework" and "prefer ts or js" could match a
    // synthetic question; first listed in the file wins.
    const text = `# X
## Known answers
- foo bar => answer-foo
- bar baz => answer-bar
`;
    const p = scanCairnMd(writeFixture('first.md', text));
    // "bar" is in both bullets' patterns. First match (foo bar) wins.
    const hit = matchKnownAnswer(p, 'the question mentions foo bar and bar baz');
    expect(hit!.pattern).toBe('foo bar');
    expect(hit!.answer).toBe('answer-foo');
  });

  it('returns null for no-match question', () => {
    const p = scanCairnMd(writeFixture('nm.md', SAMPLE_CAIRN_MD));
    expect(matchKnownAnswer(p, 'unrelated question about purple monkeys')).toBeNull();
  });

  it('returns null for absent profile', () => {
    expect(matchKnownAnswer(null, 'anything')).toBeNull();
  });

  it('returns null for non-existent CAIRN.md', () => {
    const p = scanCairnMd('/no/such/path/CAIRN.md');
    expect(matchKnownAnswer(p, 'which test framework')).toBeNull();
  });

  it('returns null on empty question', () => {
    const p = scanCairnMd(writeFixture('eq.md', SAMPLE_CAIRN_MD));
    expect(matchKnownAnswer(p, '')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchBucket — substring + token-overlap fallback (parity with .cjs)
// ---------------------------------------------------------------------------

describe('matchBucket — substring + token-overlap', () => {
  it('matches via substring fast-path', () => {
    expect(matchBucket(['npm publish'], 'I want to npm publish')).toBe('npm publish');
  });

  it('matches via token-overlap fallback (≥2 content tokens)', () => {
    expect(matchBucket(['retry transient test failures up to 2x'], 'Should we retry transient test failures here?'))
      .toBe('retry transient test failures up to 2x');
  });

  it('returns null when neither matches', () => {
    expect(matchBucket(['npm publish', 'force-push to main'], 'unrelated chatter')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache layer (loadProfile)
// ---------------------------------------------------------------------------

describe('loadProfile — mtime-gated cache via scratchpad', () => {
  it('first call scans + writes cache', () => {
    fs.writeFileSync(path.join(tmpDir, 'CAIRN.md'), SAMPLE_CAIRN_MD);
    const p = loadProfile(db, blobRoot, tmpDir);
    expect(p.exists).toBe(true);
    expect(p.whole_sentence).toContain('schema-v2 scanner');
    const cached = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?')
      .get(profileCacheKey(tmpDir)) as { value_json: string } | undefined;
    expect(cached).toBeDefined();
    const cachedProfile = JSON.parse(cached!.value_json);
    expect(cachedProfile.source_mtime_ms).toBe(p.source_mtime_ms);
  });

  it('second call with unchanged file returns cache (scanned_at matches)', () => {
    fs.writeFileSync(path.join(tmpDir, 'CAIRN.md'), SAMPLE_CAIRN_MD);
    const first = loadProfile(db, blobRoot, tmpDir);
    const second = loadProfile(db, blobRoot, tmpDir);
    expect(second.scanned_at).toBe(first.scanned_at);  // cache hit reuses scanned_at
  });

  it('mtime advance triggers re-scan', () => {
    fs.writeFileSync(path.join(tmpDir, 'CAIRN.md'), SAMPLE_CAIRN_MD);
    const first = loadProfile(db, blobRoot, tmpDir);
    // Bump mtime
    const future = Date.now() + 10_000;
    fs.utimesSync(path.join(tmpDir, 'CAIRN.md'), future / 1000, future / 1000);
    const second = loadProfile(db, blobRoot, tmpDir);
    expect(second.scanned_at).toBeGreaterThanOrEqual(first.scanned_at);
    expect(second.source_mtime_ms).not.toBe(first.source_mtime_ms);
  });

  it('missing CAIRN.md → exists:false profile, cached', () => {
    const p = loadProfile(db, blobRoot, tmpDir);
    expect(p.exists).toBe(false);
    const cached = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?')
      .get(profileCacheKey(tmpDir)) as { value_json: string } | undefined;
    expect(cached).toBeDefined();
  });

  it('forceRescan bypasses cache', () => {
    fs.writeFileSync(path.join(tmpDir, 'CAIRN.md'), SAMPLE_CAIRN_MD);
    const first = loadProfile(db, blobRoot, tmpDir);
    // Wait a ms so a new scanned_at differs measurably
    const before = Date.now();
    while (Date.now() === before) { /* tight spin to roll the clock */ }
    const second = loadProfile(db, blobRoot, tmpDir, { forceRescan: true });
    expect(second.scanned_at).toBeGreaterThan(first.scanned_at);
  });

  it('returns empty profile for null gitRoot', () => {
    const p = loadProfile(db, blobRoot, '');
    expect(p.exists).toBe(false);
  });

  it('cache key uses sha1(gitRoot).slice(0,16) prefix', () => {
    const k = profileCacheKey('/some/path');
    expect(k.startsWith('project_profile_kernel/')).toBe(true);
    expect(k.length).toBe('project_profile_kernel/'.length + 16);
  });

  it('resolveCairnMdPath joins to CAIRN.md', () => {
    expect(resolveCairnMdPath('/x/y')).toBe(path.join('/x/y', 'CAIRN.md'));
    expect(resolveCairnMdPath('')).toBeNull();
    expect(resolveCairnMdPath(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Internal helpers — sanity (parity with .cjs)
// ---------------------------------------------------------------------------

describe('helpers parity', () => {
  it('splitSections keys by lowercased header', () => {
    const sections = splitSections('# H1\n\n## Foo Bar\n\nbody1\n\n## baz\n\nbody2');
    expect(sections['foo bar']).toContain('body1');
    expect(sections['baz']).toContain('body2');
  });

  it('extractBullets handles -, *, + markers + sub-bullet folding', () => {
    const bs = extractBullets('- a\n* b\n+ c\n  continuation\n- d');
    expect(bs).toEqual(['a', 'b', 'c continuation', 'd']);
  });

  it('classifyAuthorityBullet emoji + ASCII variants', () => {
    expect(classifyAuthorityBullet('✅ retry').bucket).toBe('auto_decide');
    expect(classifyAuthorityBullet('⚠️ reduce').bucket).toBe('decide_and_announce');
    expect(classifyAuthorityBullet('🛑 publish').bucket).toBe('escalate');
    expect(classifyAuthorityBullet('auto: thing').bucket).toBe('auto_decide');
    expect(classifyAuthorityBullet('escalate: thing').bucket).toBe('escalate');
    expect(classifyAuthorityBullet('random text').bucket).toBeNull();
  });

  it('classifyIsBullet IS/IS NOT', () => {
    expect(classifyIsBullet('IS: kernel').bucket).toBe('is');
    expect(classifyIsBullet('IS NOT: agent').bucket).toBe('is_not');
    expect(classifyIsBullet('something else').bucket).toBeNull();
  });

  it('parseKnownAnswers extracts pattern => answer', () => {
    const ans = parseKnownAnswers('- a => b\n- c=>d\n- not a pair');
    expect(ans).toHaveLength(2);
    expect(ans[0]).toEqual({ pattern: 'a', answer: 'b' });
    expect(ans[1]).toEqual({ pattern: 'c', answer: 'd' });
  });

  it('emptyProfile matches PROFILE_VERSION', () => {
    expect(emptyProfile(null).version).toBe(PROFILE_VERSION);
  });
});
