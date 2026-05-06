#!/usr/bin/env node
/**
 * cairn CLI — install sub-command.
 *
 * Usage:
 *   cairn install             Install git pre-commit hook into .git/hooks/pre-commit
 *   cairn install --force     Overwrite an existing hook unconditionally
 *   cairn install --dry-run   Print what would be written; no file changes
 *   cairn --help              Print help
 *   cairn --version           Print package version
 *
 * Exit codes:
 *   0  Success (installed / skipped / dry-run)
 *   1  Not inside a git working tree
 *   2  Hook file I/O failure
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildHookContent, CAIRN_HOOK_MARKER } from './hook-template.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getVersion(): string {
  try {
    // Walk up from src/cli/ → src/ → package root to find package.json.
    const require = createRequire(import.meta.url);
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  console.log(`cairn — multi-agent coordination CLI

USAGE
  cairn install [OPTIONS]   Install git pre-commit hook
  cairn --help              Show this help message
  cairn --version           Show version

OPTIONS FOR INSTALL
  --force     Overwrite existing hook (default: append with warning)
  --dry-run   Print what would be written without making changes

EXIT CODES
  0  Success
  1  Not inside a git working tree
  2  Hook file I/O failure
`);
}

/** Attempt chmod +x; silently skip on Windows where it is a no-op. */
function makeExecutable(filePath: string): void {
  try {
    chmodSync(filePath, 0o755);
  } catch {
    // Windows: git for Windows handles the executable bit itself.
  }
}

// ---------------------------------------------------------------------------
// Install command
// ---------------------------------------------------------------------------

interface InstallOptions {
  force: boolean;
  dryRun: boolean;
}

function runInstall(cwd: string, opts: InstallOptions): never {
  const { force, dryRun } = opts;

  // 1. Verify we are inside a git working tree.
  const gitDir = join(cwd, '.git');
  if (!existsSync(gitDir)) {
    process.stderr.write(`cairn install: not a git working tree (no .git/ found in ${cwd})\n`);
    process.exit(1);
  }

  const hooksDir = join(gitDir, 'hooks');
  const hookFile = join(hooksDir, 'pre-commit');
  const newContent = buildHookContent(cwd);

  // 2. Read existing hook content (if any).
  let existing: string | null = null;
  if (existsSync(hookFile)) {
    try {
      existing = readFileSync(hookFile, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`cairn install: failed to read existing hook — ${msg}\n`);
      process.exit(2);
    }
  }

  // 3. Decide what to do.
  if (existing === null) {
    // No existing hook — write fresh.
    if (dryRun) {
      process.stdout.write(`[dry-run] Would create ${hookFile}:\n${newContent}\n`);
      process.exit(0);
    }
    try {
      writeFileSync(hookFile, newContent, { encoding: 'utf8' });
      makeExecutable(hookFile);
      process.stdout.write(`cairn install: hook installed at ${hookFile}\n`);
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`cairn install: failed to write hook — ${msg}\n`);
      process.exit(2);
    }
  }

  if (existing.includes(CAIRN_HOOK_MARKER)) {
    // Already installed — idempotent skip.
    process.stdout.write(`cairn install: already installed in ${hookFile} (use --force to update)\n`);
    process.exit(0);
  }

  // Existing hook without cairn marker.
  if (force) {
    if (dryRun) {
      process.stdout.write(`[dry-run] Would overwrite ${hookFile}:\n${newContent}\n`);
      process.exit(0);
    }
    try {
      writeFileSync(hookFile, newContent, { encoding: 'utf8' });
      makeExecutable(hookFile);
      process.stdout.write(`cairn install: hook overwritten at ${hookFile}\n`);
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`cairn install: failed to write hook — ${msg}\n`);
      process.exit(2);
    }
  }

  // Default: append cairn section after existing content.
  const separator = existing.endsWith('\n') ? '' : '\n';
  const combined = existing + separator + newContent;

  if (dryRun) {
    process.stdout.write(`[dry-run] Would append to ${hookFile}:\n${combined}\n`);
    process.exit(0);
  }

  process.stderr.write(
    `cairn install: WARNING — existing hook found at ${hookFile}; appending cairn section.\n` +
    `  Run \`cairn install --force\` to overwrite the entire file instead.\n`,
  );

  try {
    writeFileSync(hookFile, combined, { encoding: 'utf8' });
    makeExecutable(hookFile);
    process.stdout.write(`cairn install: hook section appended to ${hookFile}\n`);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cairn install: failed to write hook — ${msg}\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Argument parsing & dispatch
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

if (argv.includes('--version') || argv.includes('-v')) {
  console.log(getVersion());
  process.exit(0);
}

const subcommand = argv[0];

if (subcommand === 'install' || subcommand === undefined) {
  // Accept both `cairn install [opts]` and `cairn [opts]` (no subcommand).
  const rest = subcommand === 'install' ? argv.slice(1) : argv;
  const force = rest.includes('--force');
  const dryRun = rest.includes('--dry-run');
  runInstall(process.cwd(), { force, dryRun });
} else {
  process.stderr.write(`cairn: unknown subcommand '${subcommand}'. Run \`cairn --help\`.\n`);
  process.exit(1);
}
