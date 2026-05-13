#!/usr/bin/env node
/**
 * smoke-install-bridge.mjs — daemon-side spawn-the-CLI bridge.
 *
 * Validates:
 *   - resolveInstallCliPath finds the built CLI
 *   - runInstallInProject on a fresh git repo writes all 4 artifacts
 *     (.mcp.json + pre-commit hook + launchers + CAIRN.md) and returns
 *     a structured ok:true result
 *   - error paths: non-git dir, missing CLI, projectRoot omitted
 *   - idempotency: second run returns ok:true with action !== 'created'
 *
 * No network, no LLM. Runs against the worktree's built CLI.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');

const bridge = require(path.join(dsRoot, 'install-bridge.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

function freshGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-install-bridge-smoke-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 's@e.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'S'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

header('smoke-install-bridge');

// ---------------------------------------------------------------------------
// CLI presence
// ---------------------------------------------------------------------------
section('1 resolveInstallCliPath');
{
  const p = bridge.resolveInstallCliPath();
  ok(typeof p === 'string' && p.endsWith('install.js'), `resolves built CLI path: ${p}`);
  ok(fs.existsSync(p), 'CLI exists on disk');
  const ov = bridge.resolveInstallCliPath('/no/such/path/install.js');
  ok(ov === null, 'override path that does not exist → null');
}

// ---------------------------------------------------------------------------
// runInstallInProject — happy path
// ---------------------------------------------------------------------------
section('2 runInstallInProject — fresh git repo');
{
  const dir = freshGitRepo();
  try {
    const result = await bridge.runInstallInProject({ projectRoot: dir });
    ok(result.ok === true, 'ok: true');
    ok(result.targetDir === dir, 'targetDir round-trips');
    ok(result.mcpJsonAction === 'created', 'mcpJsonAction = created');
    ok(result.hookAction === 'created', 'hookAction = created');
    ok(result.petLauncherAction === 'created', 'petLauncherAction = created');
    ok(result.cairnMdAction === 'created', 'cairnMdAction = created');
    ok(typeof result._exit === 'number' && result._exit === 0, '_exit stamped to 0');

    // Actual files on disk
    ok(fs.existsSync(path.join(dir, '.mcp.json')), '.mcp.json on disk');
    ok(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')), 'pre-commit hook on disk');
    ok(fs.existsSync(path.join(dir, 'start-cairn-pet.bat')), 'start-cairn-pet.bat on disk');
    ok(fs.existsSync(path.join(dir, 'start-cairn-pet.sh')), 'start-cairn-pet.sh on disk');
    ok(fs.existsSync(path.join(dir, 'CAIRN.md')), 'CAIRN.md on disk');

    // CAIRN.md has the expected structure
    const cairnMd = fs.readFileSync(path.join(dir, 'CAIRN.md'), 'utf8');
    ok(cairnMd.includes('## Mentor authority'), 'CAIRN.md contains Mentor authority section');
    ok(cairnMd.includes('agent_brief'), 'CAIRN.md contains agent_brief protocol');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (_e) { /* Windows: killed child may briefly hold handle; tmp will GC */ }
  }
}

// ---------------------------------------------------------------------------
// runInstallInProject — idempotency (2nd run)
// ---------------------------------------------------------------------------
section('3 runInstallInProject — idempotent on rerun');
{
  const dir = freshGitRepo();
  try {
    const first = await bridge.runInstallInProject({ projectRoot: dir });
    ok(first.ok === true, '1st run ok');
    const before = fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8');
    const second = await bridge.runInstallInProject({ projectRoot: dir });
    ok(second.ok === true, '2nd run ok');
    ok(second.mcpJsonAction === 'merged', '2nd run mcpJsonAction = merged');
    ok(second.hookAction === 'replaced', '2nd run hookAction = replaced (cairn-marked)');
    ok(second.petLauncherAction === 'preserved', '2nd run launchers preserved');
    ok(second.cairnMdAction === 'preserved', '2nd run CAIRN.md preserved');
    const after = fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8');
    ok(after === before, '.mcp.json content unchanged');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (_e) { /* Windows: killed child may briefly hold handle; tmp will GC */ }
  }
}

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------
section('4 Error paths');
{
  const noOpts = await bridge.runInstallInProject({});
  ok(noOpts.ok === false && noOpts.error === 'projectRoot_required', 'missing projectRoot → projectRoot_required');

  const nullArg = await bridge.runInstallInProject(null);
  ok(nullArg.ok === false && nullArg.error === 'projectRoot_required', 'null arg → projectRoot_required');

  // CLI not found (override path that doesn't exist)
  const cliMissing = await bridge.runInstallInProject({
    projectRoot: os.tmpdir(),
    mcpServerCliPath: '/no/such/install.js',
  });
  ok(cliMissing.ok === false && cliMissing.error === 'cli_not_found', 'bad CLI path → cli_not_found');

  // Non-git dir → CLI returns ok:false with warnings
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-install-bridge-nogit-'));
  try {
    const r = await bridge.runInstallInProject({ projectRoot: nonGitDir });
    ok(r.ok === false, 'non-git dir → ok:false');
    ok(Array.isArray(r.warnings) && r.warnings[0] && r.warnings[0].includes('Not a git repository'),
       'warning mentions "Not a git repository"');
    ok(r._exit === 1, '_exit = 1');
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Timeout (kill after short timeout)
// ---------------------------------------------------------------------------
section('5 Timeout (short timeoutMs)');
{
  const dir = freshGitRepo();
  try {
    // 1ms timeout — the spawn itself takes longer than this in practice
    const r = await bridge.runInstallInProject({ projectRoot: dir, timeoutMs: 1 });
    // Race: with timeoutMs=1, the child should be killed before close fires.
    // But on very fast machines the CLI might complete first; accept either
    // path so the smoke is not flaky.
    if (r.error === 'timeout') {
      ok(true, 'short timeout → error=timeout');
      ok(r.timeoutMs === 1, 'timeoutMs round-trips');
    } else {
      ok(r.ok === true, 'race: CLI beat 1ms timeout (no determinism violation)');
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (_e) { /* Windows: killed child may briefly hold handle; tmp will GC */ }
  }
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
