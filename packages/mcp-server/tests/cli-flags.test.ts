import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, readSelfVersion } from '../src/cli/install.js';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli', 'install.js');

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

describe('cairn CLI — end-to-end flag behavior', () => {
  it('--help exits 0 and prints usage to stdout', () => {
    if (!existsSync(CLI)) return; // skip if not built
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('--dry-run');
  });

  it('--version exits 0 and prints "cairn <version>"', () => {
    if (!existsSync(CLI)) return;
    const r = run(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^cairn \d+\.\d+\.\d+/);
  });

  it('unknown flag exits 2 with usage hint on stderr', () => {
    if (!existsSync(CLI)) return;
    const r = run(['--made-up-flag']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument');
    expect(r.stderr).toContain('cairn --help');
  });

  it('--dry-run does NOT write any files', () => {
    if (!existsSync(CLI)) return;
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
    if (!existsSync(CLI)) return;
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
    if (!existsSync(CLI)) return;
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
