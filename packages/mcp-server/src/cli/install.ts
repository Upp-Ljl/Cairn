#!/usr/bin/env node
/**
 * cairn install — wire Cairn into any git-tracked repo.
 *
 * Exports runInstall() for testing; the CLI entry at bottom calls it
 * with paths derived from import.meta.url.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstallOptions {
  targetDir: string;
  mcpServerEntry: string;  // absolute path to mcp-server/dist/index.js
  precommitScript: string; // absolute path to daemon/scripts/cairn-precommit-check.mjs
  petLauncherTarget: string; // absolute path to packages/desktop-shell
  skipExistenceCheck?: boolean;
}

export interface InstallResult {
  ok: boolean;
  mcpJsonAction: 'created' | 'merged' | 'unchanged';
  hookAction: 'created' | 'replaced' | 'sidecarred' | 'skipped';
  petLauncherAction: 'created' | 'preserved';
  warnings: string[];
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function ok(msg: string) { return `${GREEN}[ok]${RESET}  ${msg}`; }
function warn(msg: string) { return `${YELLOW}[warn]${RESET} ${msg}`; }
function err(msg: string) { return `${RED}[err]${RESET}  ${msg}`; }

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

const HOOK_MARKER = '# cairn-pre-commit-v1';

export function runInstall(opts: InstallOptions): InstallResult {
  const warnings: string[] = [];

  // ------------------------------------------------------------------
  // 1. Verify git repo
  // ------------------------------------------------------------------
  const gitDir = path.join(opts.targetDir, '.git');
  if (!fs.existsSync(gitDir)) {
    return {
      ok: false,
      mcpJsonAction: 'unchanged',
      hookAction: 'skipped',
      petLauncherAction: 'preserved',
      warnings: [`Not a git repository: ${opts.targetDir}`],
    };
  }

  // ------------------------------------------------------------------
  // 2. Verify mcp-server entry exists (skip in tests)
  // ------------------------------------------------------------------
  if (!opts.skipExistenceCheck && !fs.existsSync(opts.mcpServerEntry)) {
    throw new Error(
      `mcp-server not built — run \`cd ${path.dirname(path.dirname(opts.mcpServerEntry))} && npm run build\``
    );
  }

  // ------------------------------------------------------------------
  // 3. Write/merge .mcp.json
  // ------------------------------------------------------------------
  const mcpJsonPath = path.join(opts.targetDir, '.mcp.json');
  let mcpJsonAction: InstallResult['mcpJsonAction'];
  let existing: Record<string, unknown> = {};

  if (fs.existsSync(mcpJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) as Record<string, unknown>;
    } catch {
      warnings.push('.mcp.json parse failed — overwriting');
    }
    mcpJsonAction = 'merged';
  } else {
    mcpJsonAction = 'created';
  }

  const mcpServers = (existing['mcpServers'] as Record<string, unknown> | undefined) ?? {};
  mcpServers['cairn-wedge'] = {
    command: 'node',
    args: [opts.mcpServerEntry],
  };
  existing['mcpServers'] = mcpServers;

  fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');

  // ------------------------------------------------------------------
  // 4. Install pre-commit hook
  // ------------------------------------------------------------------
  const hooksDir = path.join(opts.targetDir, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const hookPath = path.join(hooksDir, 'pre-commit');
  const hookContent = [
    '#!/bin/sh',
    HOOK_MARKER,
    'STAGED=$(git diff --cached --name-only)',
    '[ -z "$STAGED" ] && exit 0',
    `node "${opts.precommitScript}" --staged-files "$STAGED"`,
    'exit 0',
    '',
  ].join('\n');

  let hookAction: InstallResult['hookAction'];

  if (fs.existsSync(hookPath)) {
    const current = fs.readFileSync(hookPath, 'utf8');
    if (current.includes(HOOK_MARKER)) {
      // Our hook — replace
      fs.writeFileSync(hookPath, hookContent, 'utf8');
      tryChmod(hookPath);
      hookAction = 'replaced';
    } else {
      // User-owned hook — write sidecar
      const sidecarPath = hookPath + '.cairn';
      fs.writeFileSync(sidecarPath, hookContent, 'utf8');
      tryChmod(sidecarPath);
      warnings.push(
        `Existing pre-commit hook not ours — wrote sidecar at .git/hooks/pre-commit.cairn. ` +
        `Add \`. .git/hooks/pre-commit.cairn\` to your existing hook to chain it.`
      );
      hookAction = 'sidecarred';
    }
  } else {
    fs.writeFileSync(hookPath, hookContent, 'utf8');
    tryChmod(hookPath);
    hookAction = 'created';
  }

  // ------------------------------------------------------------------
  // 5. Generate start-cairn-pet launchers
  // ------------------------------------------------------------------
  const batPath = path.join(opts.targetDir, 'start-cairn-pet.bat');
  const shPath = path.join(opts.targetDir, 'start-cairn-pet.sh');
  let petLauncherAction: InstallResult['petLauncherAction'];

  if (fs.existsSync(batPath) || fs.existsSync(shPath)) {
    petLauncherAction = 'preserved';
  } else {
    const batContent = [
      '@echo off',
      `cd /d "${opts.petLauncherTarget}"`,
      'start "" cmd /c npm start',
      '',
    ].join('\r\n');

    const shContent = [
      '#!/bin/sh',
      `cd "${opts.petLauncherTarget}"`,
      'npm start',
      '',
    ].join('\n');

    fs.writeFileSync(batPath, batContent, 'utf8');
    fs.writeFileSync(shPath, shContent, 'utf8');
    tryChmod(shPath);
    petLauncherAction = 'created';
  }

  return {
    ok: true,
    mcpJsonAction,
    hookAction,
    petLauncherAction,
    warnings,
  };
}

function tryChmod(filePath: string) {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // No-op on Windows — expected
  }
}

// ---------------------------------------------------------------------------
// Verify Node version
// ---------------------------------------------------------------------------

function checkNodeVersion(): string | null {
  const match = process.version.match(/^v(\d+)/);
  const major = match ? parseInt(match[1] ?? '0', 10) : 0;
  if (major < 20) {
    return `Node ${process.version} detected — Cairn requires Node >= 20`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export function resolveSelf(): { mcpEntry: string; precommitScript: string; shellDir: string } {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  // selfDir = packages/mcp-server/dist/cli
  const mcpEntry = path.resolve(selfDir, '..', 'index.js');
  const precommitScript = path.resolve(selfDir, '..', '..', '..', '..', 'packages', 'daemon', 'scripts', 'cairn-precommit-check.mjs');
  const shellDir = path.resolve(selfDir, '..', '..', '..', '..', 'packages', 'desktop-shell');
  return { mcpEntry, precommitScript, shellDir };
}

function printReport(result: InstallResult, targetDir: string) {
  const lines: string[] = [];
  lines.push('');
  lines.push('cairn install');
  lines.push('-'.repeat(40));
  lines.push('');

  if (!result.ok) {
    lines.push(err(result.warnings[0] ?? 'unknown error'));
    lines.push('');
    process.stdout.write(lines.join('\n'));
    return;
  }

  const mcpLabel = result.mcpJsonAction === 'created'
    ? 'Created .mcp.json'
    : result.mcpJsonAction === 'merged'
      ? 'Merged cairn-wedge into existing .mcp.json'
      : 'Unchanged .mcp.json';
  lines.push(ok(mcpLabel));

  const hookLabel: Record<InstallResult['hookAction'], string> = {
    created: 'Installed .git/hooks/pre-commit',
    replaced: 'Updated existing cairn .git/hooks/pre-commit',
    sidecarred: 'Wrote .git/hooks/pre-commit.cairn (existing hook preserved)',
    skipped: 'Skipped hook install',
  };
  lines.push(ok(hookLabel[result.hookAction]));

  const petLabel = result.petLauncherAction === 'created'
    ? 'Created start-cairn-pet.bat and start-cairn-pet.sh'
    : 'Preserved existing start-cairn-pet launchers';
  lines.push(ok(petLabel));

  if (result.warnings.length > 0) {
    lines.push('');
    for (const w of result.warnings) {
      lines.push(warn(w));
    }
  }

  lines.push('');
  lines.push('Next steps:');
  lines.push('  1. Restart Claude Code to pick up the new .mcp.json');
  lines.push('  2. Launch the pet: double-click start-cairn-pet.bat (Windows)');
  lines.push('                     or ./start-cairn-pet.sh (macOS/Linux)');
  lines.push('');
  lines.push(`Installed in: ${targetDir}`);
  lines.push('');

  process.stdout.write(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Arg parsing — flags must be handled BEFORE any mutation
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  showHelp: boolean;
  showVersion: boolean;
  dryRun: boolean;
  unknown: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { showHelp: false, showVersion: false, dryRun: false, unknown: [] };
  for (const a of argv) {
    if (a === '--help' || a === '-h')        out.showHelp = true;
    else if (a === '--version' || a === '-V') out.showVersion = true;
    else if (a === '--dry-run')               out.dryRun = true;
    else                                       out.unknown.push(a);
  }
  return out;
}

const HELP_TEXT = `cairn — host-level multi-agent coordination kernel installer

Usage:
  cairn install [flags]
  cairn          [flags]    (alias)

Installs into the current git repo:
  - .mcp.json with the cairn-wedge MCP server entry (merged if exists)
  - .git/hooks/pre-commit (or .pre-commit.cairn sidecar if a hook exists)
  - start-cairn-pet.bat and start-cairn-pet.sh launchers

Flags:
  -h, --help      Show this message and exit
  -V, --version   Print version and exit
      --dry-run   Show what would change without writing any file

The installer is idempotent — running it twice produces the same state.
Run from inside the git repository you want Cairn to manage.

See https://github.com/Upp-Ljl/Cairn for full docs.
`;

export function readSelfVersion(): string {
  try {
    const selfDir = path.dirname(fileURLToPath(import.meta.url));
    // dist/cli → dist → mcp-server root
    const pkgPath = path.resolve(selfDir, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Run CLI only when executed directly
const isMain = process.argv[1] != null &&
  (fileURLToPath(import.meta.url).endsWith(process.argv[1]) ||
   process.argv[1].endsWith('install.js') ||
   process.argv[1].endsWith('cairn'));

if (isMain || process.env['CAIRN_INSTALL_RUN'] === '1') {
  const args = parseArgs(process.argv.slice(2));

  if (args.showHelp) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  if (args.showVersion) {
    process.stdout.write(`cairn ${readSelfVersion()}\n`);
    process.exit(0);
  }

  if (args.unknown.length > 0) {
    process.stderr.write(`cairn: unknown argument(s): ${args.unknown.join(' ')}\n`);
    process.stderr.write(`Run "cairn --help" for usage.\n`);
    process.exit(2);
  }

  const nodeError = checkNodeVersion();
  if (nodeError) {
    process.stderr.write(`cairn: ${nodeError}\n`);
    process.exit(1);
  }

  const targetDir = process.cwd();
  const { mcpEntry, precommitScript, shellDir } = resolveSelf();

  if (args.dryRun) {
    process.stdout.write('cairn install --dry-run\n');
    process.stdout.write('-'.repeat(40) + '\n\n');
    process.stdout.write(`Target dir:       ${targetDir}\n`);
    process.stdout.write(`mcp-server entry: ${mcpEntry}\n`);
    process.stdout.write(`pre-commit script: ${precommitScript}\n`);
    process.stdout.write(`pet launcher target: ${shellDir}\n\n`);
    process.stdout.write('Would write (or merge):\n');
    process.stdout.write(`  - ${path.join(targetDir, '.mcp.json')}\n`);
    process.stdout.write(`  - ${path.join(targetDir, '.git', 'hooks', 'pre-commit')}\n`);
    process.stdout.write(`  - ${path.join(targetDir, 'start-cairn-pet.bat')}\n`);
    process.stdout.write(`  - ${path.join(targetDir, 'start-cairn-pet.sh')}\n\n`);
    process.stdout.write('No files were written. Run without --dry-run to apply.\n');
    process.exit(0);
  }

  let result: InstallResult;
  try {
    result = runInstall({
      targetDir,
      mcpServerEntry: mcpEntry,
      precommitScript,
      petLauncherTarget: shellDir,
    });
  } catch (e) {
    process.stderr.write(`cairn install failed: ${(e as Error).message}\n`);
    process.exit(1);
  }

  printReport(result, targetDir);
  process.exit(result.ok ? 0 : 1);
}
