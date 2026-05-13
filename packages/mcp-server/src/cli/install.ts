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
  cairnMdAction: 'created' | 'preserved' | 'skipped';
  /**
   * Phase 4 (2026-05-14): writes `.claude/skills/cairn-aware.md` so any
   * Claude Code session opened in this project auto-loads the
   * Cairn-aware protocol (read CAIRN.md / write agent_brief before
   * blocking / poll agent_inbox between turns). Closes the Phase 1
   * chicken-and-egg (CC needs to be aware to poll inbox; awareness
   * lived in CAIRN.md which CC didn't read until told). 'preserved'
   * means a non-cairn skill of the same name was found and left alone.
   */
  cairnAwareSkillAction: 'created' | 'replaced' | 'preserved' | 'skipped';
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

// Marker line embedded in the Claude Code skill so we can recognize
// our own installs on re-run and replace them. A user-edited or third-
// party skill of the same name is left alone (action='preserved') —
// we never silently overwrite human or other-tool content.
// v2 (A3 session-naming): adds cairn.session.name startup instruction.
const CAIRN_AWARE_SKILL_MARKER = '<!-- cairn-aware-skill-v2 -->';

// Claude Code project-level skill that makes CC actually Cairn-aware
// without manual user setup. Loaded by `cairn install` into
// `<project>/.claude/skills/cairn-aware.md`. Phase 4 (2026-05-14)
// closes the Phase 1 chicken-and-egg: CC needs to poll agent_inbox to
// pick up Mentor's nudges, but the polling protocol used to live only
// inside CAIRN.md which CC didn't read until told.
const CAIRN_AWARE_SKILL = `---
name: cairn-aware
description: This project uses Cairn. At session start read CAIRN.md, call cairn.session.name to self-report what you are about to do, write an agent_brief to scratchpad before raising blockers via cairn.task.block, and poll scratchpad agent_inbox/<your-agent-id>/* between turns for Mentor instructions.
---

${CAIRN_AWARE_SKILL_MARKER}

# Cairn-aware coding agent protocol

This project uses Cairn (https://github.com/Upp-Ljl/Cairn) for host-level
multi-agent coordination. Cairn's Mentor watches your activity and may
auto-resolve blockers / nudge / escalate based on the project's CAIRN.md.
Cooperating with Mentor saves the user round-trips and keeps long-running
sessions productive.

## On session start

1. **Read CAIRN.md** at the repo root (if present). Treat the IS/IS NOT
   and Mentor authority sections as policy from the project owner — what
   you can decide reversibly vs what needs the user.
2. **Self-report your session name**: call \`cairn.session.name\` with a
   human-readable title of ≤ 50 characters that describes what this
   session is about to do. Example:

   \`\`\`
   cairn.session.name({ name: "ship Phase 8 §8 Rule C" })
   \`\`\`

   This lets the desktop-shell panel show your session's purpose instead
   of an opaque hex id. Do this as the **first** Cairn tool call so the
   panel is updated before any work begins.
3. **Check your inbox**: call \`cairn.scratchpad.list\` (or read keys
   directly) and look for entries with the prefix \`agent_inbox/<your-
   cairn-session-agent-id>/\`. Each entry is a steer message from Cairn
   (or another agent acting through Cairn). Handle items in order, then
   delete them via \`cairn.scratchpad.delete\` once consumed.

Your \`cairn-session-agent-id\` is set in the env var \`CAIRN_SESSION_AGENT_ID\`
by the mcp-server process; you can also obtain it via \`cairn.process.status\`.

## Before raising a blocker

\`cairn.task.block\` automatically resolves blockers whose questions match
the project's \`## Known answers\` section or \`## Mentor authority\` ✅/⚠️
bullets in CAIRN.md (Phase 2 + Phase 3 sync-mentor paths). So you don't
need to write a brief for every block — but for non-trivial blocks:

1. Write a \`scratchpad:agent_brief/<your-agent-id>\` entry with shape:

   \`\`\`json
   {
     "version": 1,
     "agent_id": "<your-cairn-session-agent-id>",
     "task_id": "<current task_id if any>",
     "summary": "what you're trying to do right now (≤ 150 words)",
     "stuck_on": "what's blocking you (≤ 80 words)",
     "options_considered": ["option A", "option B"],
     "lean": "your current preference + why",
     "written_at": <Date.now()>
   }
   \`\`\`

2. Then call \`cairn.task.block({ task_id, question })\`. The response
   may include \`auto_resolved: true\` + \`answer\` — if so, use the
   answer and continue without paging the user. If \`auto_resolved\` is
   false and a \`mentor_recommendation\` field is present, the kernel
   flagged your question as irreversible (e.g. \`npm publish\`) — wait
   for the user OR override per CAIRN.md.

## Subagent results

Subagent runs still write to \`subagent/{agent_id}/result\` per
\`docs/cairn-subagent-protocol.md\`. The agent_brief above is YOUR
self-summary, not your subagents'.

## Reserved keys

Do not write to:
- \`project_profile/<project_id>\` — desktop-shell's CAIRN.md cache
- \`project_profile_kernel/<sha1>\` — mcp-server's CAIRN.md cache
- \`mentor/*\` — Mentor's outbound (nudges / auto-resolves / escalates)
- \`escalation/*\` — Module 5 (Needs you) state

## Why this skill exists

This file is auto-installed by \`cairn install\`. Without it, CC would
not know to poll \`agent_inbox\` or write agent_briefs, which means
Mentor's decisions would never reach you and you'd ask the user the
questions Cairn could already answer.
`;


// CAIRN.md scaffold — written verbatim on first install (schema v2,
// 2026-05-14, per docs/superpowers/plans/2026-05-14-bootstrap-grill.md
// decision D-1). After install, edits are the user's. Cairn renders an
// "in flight" line in the panel from live state — do not put it here.
//
// Schema v2 vs v1:
//   - ADD `## Whole` (one sentence: the project's stable complete form,
//     the north star Mentor measures progress against)
//   - KEEP `## Goal` reframed as the current sub-Whole milestone
//   - DROP `## Current phase` (time-anchored sections rot at AI cadence)
const CAIRN_MD_TEMPLATE = `# <Project Name>

> Per-project policy file for Cairn Mentor. Edit this — the scaffold is
> intentionally sparse. Schema reference: docs/CAIRN-md-spec.md inside the
> Cairn repo, or https://github.com/Upp-Ljl/Cairn.
>
> Cairn renders a "what's in flight" line in the panel from live tasks +
> processes — do not edit progress / status here.

## Whole

<ONE sentence describing what this project becomes when "done" — the
project's complete form. The stable north star Mentor steers toward.
Cairn drafts this from your repo (CLAUDE.md / README / recent commits)
and asks you to confirm a single sentence; you don't write it cold.>

## Goal

<ONE sentence: the current sub-\`Whole\` milestone — what we are driving
toward right now. Can change as the project iterates; \`Whole\` stays.>

## What this project IS / IS NOT

- IS: <what this project is>
- IS NOT: <what it is not — anti-definitions matter>

## Mentor authority (decision delegation)

Mentor's default behaviour for each runtime event category. Add bullets
freely; lines starting with the emoji (or the ASCII tag) classify the
rule. See docs/CAIRN-md-spec.md for the routing semantics.

- ✅ <reversible / low-stakes thing Mentor can decide silently>
- ⚠️ <reversible but worth knowing; Mentor decides + announces in Activity feed>
- 🛑 <irreversible / strategic / business — always escalate to user>

Examples (uncomment + edit):

<!--
- ✅ retry transient test failures up to 2x
- ✅ pick TypeScript over JavaScript when blocker asks "which language"
- ⚠️ reduce a task's time budget when 80% elapsed and progress visible
- 🛑 npm publish
- 🛑 force-push to main
- 🛑 LICENSE edit
- 🛑 adding a new npm dependency
-->

## Project constraints

- <cross-cutting rule that both Mentor and coding agents must respect>

## Known answers

Cheapest decision path: Mentor matches a blocker's question against these
substrings (case-insensitive) and returns the answer directly. Format
"<substring> => <answer>".

<!--
- which language => prefer TypeScript
- test framework => vitest with real DB, not mocks
-->

---

## For Cairn-aware coding agents

If you are a coding agent (Claude Code / Cursor / Codex / Aider) working
inside this repo with Cairn attached, the following protocol applies:

1. **Read this file** at session start. Treat the IS/IS NOT and Mentor
   authority sections as policy from the project owner.
2. **Before raising a blocker** (calling \`cairn.task.block\`), first write
   a brief to scratchpad key \`agent_brief/<your-agent-id>\`. Format:

   \`\`\`json
   {
     "version": 1,
     "agent_id": "<your-cairn-session-agent-id>",
     "task_id": "<current task_id if any>",
     "summary": "what you're trying to do right now (≤ 150 words)",
     "stuck_on": "what's blocking you (≤ 80 words)",
     "options_considered": ["option A", "option B"],
     "lean": "your current preference + why",
     "written_at": <Date.now()>
   }
   \`\`\`

   Cairn Mentor reads this brief as L2 input to its decision and may
   resolve the blocker without paging the user.
3. **Subagent results** still write to \`subagent/{agent_id}/result\` per
   docs/cairn-subagent-protocol.md. The agent_brief is the *self-summary*
   from the main agent's perspective; it's about *you*, not your
   subagents.
4. The scratchpad key \`project_profile/<project_id>\` is Mentor's cache of
   this file — do not write to it from the agent side.
`;


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
      cairnMdAction: 'skipped',
      cairnAwareSkillAction: 'skipped',
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

  // ------------------------------------------------------------------
  // 6. Scaffold CAIRN.md (per-project policy file for Mentor)
  // ------------------------------------------------------------------
  const cairnMdPath = path.join(opts.targetDir, 'CAIRN.md');
  let cairnMdAction: InstallResult['cairnMdAction'];
  if (fs.existsSync(cairnMdPath)) {
    cairnMdAction = 'preserved';
  } else {
    try {
      fs.writeFileSync(cairnMdPath, CAIRN_MD_TEMPLATE, 'utf8');
      cairnMdAction = 'created';
    } catch (e) {
      cairnMdAction = 'skipped';
      warnings.push(`Failed to scaffold CAIRN.md: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------
  // 7. Install .claude/skills/cairn-aware.md (Phase 4, 2026-05-14)
  //
  // Project-level Claude Code skill that makes CC auto-aware of Cairn
  // protocol (read CAIRN.md, write agent_brief, poll agent_inbox).
  // Identified by the CAIRN_AWARE_SKILL_MARKER so re-installs replace
  // our own skill but never overwrite a foreign (or user-edited) file
  // of the same name.
  // ------------------------------------------------------------------
  const skillDir = path.join(opts.targetDir, '.claude', 'skills');
  const skillPath = path.join(skillDir, 'cairn-aware.md');
  let cairnAwareSkillAction: InstallResult['cairnAwareSkillAction'];
  try {
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }
    if (fs.existsSync(skillPath)) {
      const cur = fs.readFileSync(skillPath, 'utf8');
      // Accept both the current marker AND the legacy v1 marker so
      // existing installs are upgraded to v2 rather than left as-is.
      const isOurSkill = cur.includes(CAIRN_AWARE_SKILL_MARKER) ||
                         cur.includes('<!-- cairn-aware-skill-v1 -->');
      if (isOurSkill) {
        fs.writeFileSync(skillPath, CAIRN_AWARE_SKILL, 'utf8');
        cairnAwareSkillAction = 'replaced';
      } else {
        cairnAwareSkillAction = 'preserved';
        warnings.push(
          'Existing .claude/skills/cairn-aware.md is NOT cairn-marked — left as-is. ' +
          'If you want the Cairn-aware protocol active, delete that file and re-run cairn install.'
        );
      }
    } else {
      fs.writeFileSync(skillPath, CAIRN_AWARE_SKILL, 'utf8');
      cairnAwareSkillAction = 'created';
    }
  } catch (e) {
    cairnAwareSkillAction = 'skipped';
    warnings.push(`Failed to install cairn-aware skill: ${(e as Error).message}`);
  }

  return {
    ok: true,
    mcpJsonAction,
    hookAction,
    petLauncherAction,
    cairnMdAction,
    cairnAwareSkillAction,
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

  const cairnMdLabel: Record<InstallResult['cairnMdAction'], string> = {
    created: 'Scaffolded CAIRN.md (edit it to give Mentor authority over this project)',
    preserved: 'Preserved existing CAIRN.md',
    skipped: 'Skipped CAIRN.md scaffold',
  };
  lines.push(ok(cairnMdLabel[result.cairnMdAction]));

  const skillLabel: Record<InstallResult['cairnAwareSkillAction'], string> = {
    created: 'Installed .claude/skills/cairn-aware.md (CC will auto-load Cairn protocol)',
    replaced: 'Updated existing cairn-aware skill',
    preserved: 'Preserved existing .claude/skills/cairn-aware.md (not cairn-marked)',
    skipped: 'Skipped cairn-aware skill install',
  };
  lines.push(ok(skillLabel[result.cairnAwareSkillAction]));

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
  json: boolean;
  unknown: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { showHelp: false, showVersion: false, dryRun: false, json: false, unknown: [] };
  for (const a of argv) {
    if (a === '--help' || a === '-h')        out.showHelp = true;
    else if (a === '--version' || a === '-V') out.showVersion = true;
    else if (a === '--dry-run')               out.dryRun = true;
    else if (a === '--json')                  out.json = true;
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
      --json      Emit machine-readable JSON result on stdout (for daemon callers)

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
    process.stdout.write(`  - ${path.join(targetDir, 'start-cairn-pet.sh')}\n`);
    process.stdout.write(`  - ${path.join(targetDir, 'CAIRN.md')} (if absent)\n\n`);
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
    if (args.json) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: (e as Error).message,
        targetDir,
      }) + '\n');
    } else {
      process.stderr.write(`cairn install failed: ${(e as Error).message}\n`);
    }
    process.exit(1);
  }

  if (args.json) {
    // Machine-readable output for the desktop-shell install-bridge.
    // Daemon callers parse this; humans get the formatted report below.
    process.stdout.write(JSON.stringify({ ...result, targetDir }) + '\n');
  } else {
    printReport(result, targetDir);
  }
  process.exit(result.ok ? 0 : 1);
}
