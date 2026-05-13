/**
 * cli-install.test.ts — unit tests for packages/mcp-server/src/cli/install.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runInstall, resolveSelf, type InstallOptions, type InstallResult } from '../src/cli/install.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeFakeRepo(opts: { initGit?: boolean; initHooksDir?: boolean } = {}) {
  const { initGit = true, initHooksDir = true } = opts;
  if (initGit) {
    const gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    if (initHooksDir) {
      fs.mkdirSync(path.join(gitDir, 'hooks'), { recursive: true });
    }
  }
}

function baseOpts(overrides: Partial<InstallOptions> = {}): InstallOptions {
  return {
    targetDir: tmpDir,
    mcpServerEntry: path.join(tmpDir, 'fake-mcp-server', 'dist', 'index.js'),
    precommitScript: path.join(tmpDir, 'fake-daemon', 'scripts', 'cairn-precommit-check.mjs'),
    petLauncherTarget: path.join(tmpDir, 'fake-desktop-shell'),
    skipExistenceCheck: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-install-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: Fresh target repo — all three artifacts created
// ---------------------------------------------------------------------------

describe('fresh repo', () => {
  it('creates .mcp.json, hook, launchers, and CAIRN.md', () => {
    makeFakeRepo();

    const result = runInstall(baseOpts());

    expect(result.ok).toBe(true);
    expect(result.mcpJsonAction).toBe('created');
    expect(result.hookAction).toBe('created');
    expect(result.petLauncherAction).toBe('created');
    expect(result.cairnMdAction).toBe('created');
    expect(result.warnings).toHaveLength(0);

    // CAIRN.md scaffold
    const cairnMd = fs.readFileSync(path.join(tmpDir, 'CAIRN.md'), 'utf8');
    expect(cairnMd).toContain('## Mentor authority (decision delegation)');
    expect(cairnMd).toContain('## For Cairn-aware coding agents');
    expect(cairnMd).toContain('agent_brief/<your-agent-id>');

    // .mcp.json
    const mcpJson = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'));
    expect(mcpJson).toHaveProperty('mcpServers.cairn-wedge');
    expect(mcpJson.mcpServers['cairn-wedge'].command).toBe('node');
    expect(mcpJson.mcpServers['cairn-wedge'].args[0]).toBe(baseOpts().mcpServerEntry);

    // hook
    const hookContent = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hookContent).toContain('# cairn-pre-commit-v1');
    expect(hookContent).toContain('cairn-precommit-check.mjs');

    // launchers
    expect(fs.existsSync(path.join(tmpDir, 'start-cairn-pet.bat'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'start-cairn-pet.sh'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Existing .mcp.json with OTHER servers — cairn-wedge merged, others preserved
// ---------------------------------------------------------------------------

describe('existing .mcp.json with other servers', () => {
  it('merges cairn-wedge without removing other entries', () => {
    makeFakeRepo();

    const existing = {
      mcpServers: {
        'other-tool': {
          command: 'python',
          args: ['-m', 'other'],
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(existing, null, 2), 'utf8');

    const result = runInstall(baseOpts());

    expect(result.ok).toBe(true);
    expect(result.mcpJsonAction).toBe('merged');

    const mcpJson = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'));
    expect(mcpJson.mcpServers).toHaveProperty('other-tool');
    expect(mcpJson.mcpServers['other-tool'].command).toBe('python');
    expect(mcpJson.mcpServers).toHaveProperty('cairn-wedge');
    expect(mcpJson.mcpServers['cairn-wedge'].command).toBe('node');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Existing user-owned pre-commit hook — writes .cairn sidecar
// ---------------------------------------------------------------------------

describe('existing user-owned hook', () => {
  it('writes sidecar and returns sidecarred action with warning', () => {
    makeFakeRepo();

    const userHook = '#!/bin/sh\necho "my custom hook"\n';
    fs.writeFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), userHook, 'utf8');

    const result = runInstall(baseOpts());

    expect(result.ok).toBe(true);
    expect(result.hookAction).toBe('sidecarred');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('sidecar');

    // Original hook untouched
    const origHook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(origHook).toBe(userHook);

    // Sidecar written
    const sidecarContent = fs.readFileSync(
      path.join(tmpDir, '.git', 'hooks', 'pre-commit.cairn'), 'utf8'
    );
    expect(sidecarContent).toContain('# cairn-pre-commit-v1');
  });
});

// ---------------------------------------------------------------------------
// Test 4: Existing cairn-marked hook — replaced
// ---------------------------------------------------------------------------

describe('existing cairn hook', () => {
  it('replaces the hook without warning', () => {
    makeFakeRepo();

    const cairnHook = '#!/bin/sh\n# cairn-pre-commit-v1\necho "old version"\n';
    fs.writeFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), cairnHook, 'utf8');

    const result = runInstall(baseOpts());

    expect(result.ok).toBe(true);
    expect(result.hookAction).toBe('replaced');

    const newHook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(newHook).toContain('# cairn-pre-commit-v1');
    expect(newHook).toContain('cairn-precommit-check.mjs');
    expect(newHook).not.toContain('old version');
  });
});

// ---------------------------------------------------------------------------
// Test 5: Not a git repo — returns error result
// ---------------------------------------------------------------------------

describe('non-git directory', () => {
  it('returns ok=false when .git is absent', () => {
    // Don't call makeFakeRepo — no .git dir

    const result = runInstall(baseOpts());

    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toContain('Not a git repository');
  });
});

// ---------------------------------------------------------------------------
// Test 6: Existing start-cairn-pet.bat — not overwritten
// ---------------------------------------------------------------------------

describe('existing launcher', () => {
  it('preserves existing start-cairn-pet.bat', () => {
    makeFakeRepo();

    const original = '@echo off\necho custom launcher\n';
    fs.writeFileSync(path.join(tmpDir, 'start-cairn-pet.bat'), original, 'utf8');

    const result = runInstall(baseOpts());

    expect(result.ok).toBe(true);
    expect(result.petLauncherAction).toBe('preserved');

    const content = fs.readFileSync(path.join(tmpDir, 'start-cairn-pet.bat'), 'utf8');
    expect(content).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Path resolution correctness (skip existence check)
// ---------------------------------------------------------------------------

describe('path in .mcp.json', () => {
  it('records the exact mcpServerEntry path in .mcp.json args', () => {
    makeFakeRepo();

    const customEntry = path.join(tmpDir, 'custom', 'dist', 'index.js');
    const result = runInstall(baseOpts({ mcpServerEntry: customEntry }));

    expect(result.ok).toBe(true);

    const mcpJson = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'));
    expect(mcpJson.mcpServers['cairn-wedge'].args[0]).toBe(customEntry);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Existing CAIRN.md — preserved
// ---------------------------------------------------------------------------

describe('existing CAIRN.md', () => {
  it('preserves an existing CAIRN.md (does not overwrite)', () => {
    makeFakeRepo();

    const userContent = '# my project\n\n## Goal\n\nthe owner wrote this.\n';
    fs.writeFileSync(path.join(tmpDir, 'CAIRN.md'), userContent, 'utf8');

    const result = runInstall(baseOpts());

    expect(result.ok).toBe(true);
    expect(result.cairnMdAction).toBe('preserved');

    const after = fs.readFileSync(path.join(tmpDir, 'CAIRN.md'), 'utf8');
    expect(after).toBe(userContent);
  });
});

describe('resolveSelf — path structure', () => {
  // Regression: install CLI was emitting paths without the `packages/` segment,
  // making the installed pre-commit hook and pet launcher point at non-existent
  // locations. These assertions verify the path structure even when running
  // against TS sources (where the .js files don't actually exist on disk).
  it('precommitScript path contains packages/daemon/scripts/cairn-precommit-check.mjs', () => {
    const { precommitScript } = resolveSelf();
    const norm = precommitScript.replace(/\\/g, '/');
    expect(norm).toContain('/packages/daemon/scripts/cairn-precommit-check.mjs');
  });

  it('shellDir path contains packages/desktop-shell', () => {
    const { shellDir } = resolveSelf();
    const norm = shellDir.replace(/\\/g, '/');
    expect(norm).toContain('/packages/desktop-shell');
    expect(norm.endsWith('/packages/desktop-shell')).toBe(true);
  });

  it('mcpEntry path contains packages/mcp-server', () => {
    const { mcpEntry } = resolveSelf();
    const norm = mcpEntry.replace(/\\/g, '/');
    expect(norm).toContain('/packages/mcp-server/');
    expect(norm.endsWith('index.js')).toBe(true);
  });
});
