import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readSelfVersion } from '../src/cli/install.js';

// Use fileURLToPath for ESM portability (P3 fix from PR #3 review).
const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname_, '..', 'dist', 'cli', 'install.js');

// E2E tests require the CLI to be built. Fail loudly instead of silently
// skipping (P3 fix from PR #3 review): a missing dist/ means `npm run build`
// was forgotten, and silent skip would let stale code merge.
const HAS_BUILD = existsSync(CLI);
const buildHint = () => `cli-flags e2e tests require a built CLI at ${CLI}. Run \`npm run build\` first.`;

function run(args: string[], cwd?: string) {
  return spawnSync('node', [CLI, ...args], {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf8',
    timeout: 20000,
  });
}

function freshGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cairn-cli-flags-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 's@e.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'S'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), '# x\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('cairn CLI — argument parsing (unit)', () => {
  it('parses --help', () => {
    expect(parseArgs(['--help'])).toEqual({ showHelp: true, showVersion: false, dryRun: false, unknown: [] });
  });
  it('parses -h short form', () => {
    expect(parseArgs(['-h']).showHelp).toBe(true);
  });
  it('parses --version', () => {
    expect(parseArgs(['--version']).showVersion).toBe(true);
  });
  it('parses -V short form', () => {
    expect(parseArgs(['-V']).showVersion).toBe(true);
  });
  it('parses --dry-run', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  });
  it('captures unknown flags into unknown[]', () => {
    expect(parseArgs(['--bogus']).unknown).toEqual(['--bogus']);
  });
  it('parses combined flags', () => {
    const p = parseArgs(['--help', '--version', '--dry-run']);
    expect(p.showHelp).toBe(true);
    expect(p.showVersion).toBe(true);
    expect(p.dryRun).toBe(true);
  });
});

describe('cairn CLI — version reader', () => {
  it('returns the version from mcp-server/package.json', () => {
    expect(readSelfVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// E2E block uses `describe.skipIf` so the missing-build case is visible
// in the test report rather than silently passing.
describe.skipIf(!HAS_BUILD)('cairn CLI — end-to-end flag behavior', () => {
  it('--help exits 0 and prints usage to stdout', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('--dry-run');
  });

  it('--version exits 0 and prints "cairn <version>"', () => {
    const r = run(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^cairn \d+\.\d+\.\d+/);
  });

  it('unknown flag exits 2 with usage hint on stderr', () => {
    const r = run(['--made-up-flag']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument');
    expect(r.stderr).toContain('cairn --help');
  });

  it('--help wins when combined with unknown flag (help short-circuits)', () => {
    const r = run(['--help', '--bogus']);
    // Help short-circuits before unknown-arg check — documented behavior.
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('--dry-run does NOT write any files', () => {
    const dir = freshGitRepo();
    try {
      const r = run(['--dry-run'], dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('No files were written');
      expect(existsSync(path.join(dir, '.mcp.json'))).toBe(false);
      expect(existsSync(path.join(dir, '.git', 'hooks', 'pre-commit'))).toBe(false);
      expect(existsSync(path.join(dir, 'start-cairn-pet.bat'))).toBe(false);
      expect(existsSync(path.join(dir, 'start-cairn-pet.sh'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without flags, install actually writes files in a git repo', () => {
    const dir = freshGitRepo();
    try {
      const r = run([], dir);
      expect(r.status).toBe(0);
      expect(existsSync(path.join(dir, '.mcp.json'))).toBe(true);
      expect(existsSync(path.join(dir, '.git', 'hooks', 'pre-commit'))).toBe(true);
      expect(existsSync(path.join(dir, 'start-cairn-pet.bat'))).toBe(true);
      expect(existsSync(path.join(dir, 'start-cairn-pet.sh'))).toBe(true);

      const mcp = JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
      expect(mcp.mcpServers['cairn-wedge'].command).toBe('node');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('idempotency — running twice produces equivalent state', () => {
    const dir = freshGitRepo();
    try {
      run([], dir);
      const before = readFileSync(path.join(dir, '.mcp.json'), 'utf8');
      run([], dir);
      const after = readFileSync(path.join(dir, '.mcp.json'), 'utf8');
      expect(after).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// One always-runs probe that fails loudly if dist/ is missing, so a forgotten
// `npm run build` cannot let the e2e suite silently no-op.
describe('cairn CLI — build presence guard', () => {
  it('dist/cli/install.js exists (run npm run build if this fails)', () => {
    if (!HAS_BUILD) {
      throw new Error(buildHint());
    }
    expect(HAS_BUILD).toBe(true);
  });
});
