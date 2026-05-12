#!/usr/bin/env node
/**
 * FEATURE-VALIDATION 1+2+3 for the Multi-Agent Mentor demo.
 *
 * Per `docs/workflow/FEATURE-VALIDATION.md` Cairn adaptation:
 *   - Gate 1: claude --model haiku -p (fast LLM, JSON only)
 *   - Gate 2: a second independent claude invocation with fresh context
 *     (using the general-purpose subagent prompt verbatim — same task
 *     given to two engines / two contexts)
 *   - Gate 3: real-run via daemon storage handle in a single Node call.
 *
 * Hard-match all three canonicalized JSON outputs. Any divergence fails.
 *
 * Why this is Gate 1/2 done in Node instead of bash+jq+diff:
 *   - This Windows host has no `jq` on PATH (verified via `which jq`).
 *   - Canonicalization = JSON.stringify with sorted keys, no whitespace.
 *
 * Usage:
 *   node dogfood-multi-agent-mentor-validate.mjs
 *     → runs Gate 1 + Gate 3 (Gate 2 requires the Claude Code Agent
 *       tool which lives in the harness, not the script — the user
 *       runs Gate 2 by dispatching the same prompt from a fresh
 *       Agent context and pasting the JSON into /tmp/gate2.json).
 *
 *   node dogfood-multi-agent-mentor-validate.mjs --gate2-from=/tmp/gate2.json
 *     → adds Gate 2 to the comparison if the file exists.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const daemonDist = path.join(repoRoot, 'packages', 'daemon', 'dist');
const { openDatabase } = require(path.join(daemonDist, 'storage/db.js'));

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

// ---------------------------------------------------------------------------
// The canonical question. SAME wording for all gates.
// ---------------------------------------------------------------------------

// Built at runtime so the absolute DB path is baked in — avoids the
// haiku model having to guess a Windows-vs-POSIX path expansion of
// $HOME (review P2). The model still needs tool access (Read / Bash)
// to open the file; if Gate 1 ever returns a hallucinated answer, the
// scratchpad_subagent_keys_sorted check catches it (26-char random
// hex ids can't be predicted from prompt context).
const DB_ABS = path.join(os.homedir(), '.cairn', 'cairn.db');
const QUESTION_PROMPT = `Inspect the Cairn SQLite database at this absolute path (read-only):

  ${DB_ABS}

Use better-sqlite3 (already installed in this repo) or any SQLite CLI you can find. Answer with canonical JSON ONLY (no markdown, no prose):

{
  "demo_processes_count": <integer — rows in 'processes' table whose capabilities JSON contains the string "role:demo-mentor-worker">,
  "conflicts_count_pending_review": <integer — rows in 'conflicts' where status='PENDING_REVIEW'>,
  "scratchpad_subagent_keys_sorted": [<sorted array of all 'key' values in scratchpad table that match the SQL LIKE pattern 'subagent/%/result'>]
}

Do NOT include any other text. The first character of your output MUST be '{'.`;

// ---------------------------------------------------------------------------
// Gate 3: real run (source of truth)
// ---------------------------------------------------------------------------

function gate3RealRun() {
  const dbPath = path.join(os.homedir(), '.cairn', 'cairn.db');
  const db = openDatabase(dbPath, { readonly: true });
  const demoProcs = db.prepare(
    `SELECT COUNT(*) AS c FROM processes WHERE capabilities LIKE '%"role:demo-mentor-worker"%'`
  ).get().c;
  const pendingReview = db.prepare(
    `SELECT COUNT(*) AS c FROM conflicts WHERE status = 'PENDING_REVIEW'`
  ).get().c;
  const keys = db.prepare(
    `SELECT key FROM scratchpad WHERE key LIKE 'subagent/%/result' ORDER BY key`
  ).all().map(r => r.key);
  db.close();
  return {
    demo_processes_count: demoProcs,
    conflicts_count_pending_review: pendingReview,
    scratchpad_subagent_keys_sorted: keys,
  };
}

// ---------------------------------------------------------------------------
// Gate 1: claude haiku
// ---------------------------------------------------------------------------

function whichClaude() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, ['claude'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (process.platform === 'win32') {
    // On Windows, `where` returns the sh wrapper first (no extension)
    // which Node cannot spawn directly. Prefer .cmd (matches what the
    // worker-launcher uses for the real demo workers — invoked via
    // cmd.exe /c — same path proven by Phase 6) over .exe (WinGet
    // wrapper has stricter argv handling that swallowed our prompt).
    return (
      lines.find(l => /\.cmd$/i.test(l)) ||
      lines.find(l => /\.exe$/i.test(l)) ||
      lines[0]
    );
  }
  return lines[0];
}

function gate1Haiku() {
  const claudeBin = whichClaude();
  if (!claudeBin) {
    return { error: 'claude not on PATH' };
  }
  process.stdout.write(`  invoking claude (--model haiku -p) at ${claudeBin}…\n`);
  // Windows .cmd shims must be invoked via cmd.exe /C. The worker-launcher
  // does the same dance (see worker-launcher.cjs:694) — spawning a .cmd
  // directly with shell:false hits ENOENT on Node 16+ Windows.
  let exec = claudeBin;
  let execArgv = ['--model', 'haiku', '-p'];
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeBin)) {
    exec = process.env.ComSpec || 'cmd.exe';
    execArgv = ['/d', '/s', '/c', claudeBin, '--model', 'haiku', '-p'];
  }
  const res = spawnSync(exec, execArgv, {
    input: QUESTION_PROMPT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 4 * 60 * 1000,
    shell: false,
    windowsHide: true,
  });
  if (res.error) return { error: String(res.error) };
  const out = (res.stdout || '').trim();
  // The model may add trailing prose despite the rule; clip from first { to last }.
  const first = out.indexOf('{');
  const last = out.lastIndexOf('}');
  if (first < 0 || last <= first) {
    return { error: 'no JSON braces in output', raw: out.slice(0, 500) };
  }
  const raw = out.slice(first, last + 1);
  try {
    return { ok: true, parsed: JSON.parse(raw), raw };
  } catch (e) {
    return { error: 'JSON.parse failed: ' + e.message, raw };
  }
}

// ---------------------------------------------------------------------------
// Canonicalization + comparison
// ---------------------------------------------------------------------------

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    const out = {};
    for (const k of keys) out[k] = canon(v[k]);
    return out;
  }
  return v;
}

function deepEqual(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function pretty(v) { return JSON.stringify(canon(v), null, 2); }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const header = (s) => process.stdout.write(`\n=== ${s} ===\n`);

header('Gate 3 — real run (source of truth)');
const gate3 = gate3RealRun();
process.stdout.write(pretty(gate3) + '\n');
const gate3Path = path.join(os.tmpdir(), 'cairn-demo-gate3.json');
fs.writeFileSync(gate3Path, pretty(gate3) + '\n', 'utf8');
process.stdout.write(`  -> ${gate3Path}\n`);

header('Gate 1 — claude --model haiku -p');
const g1 = gate1Haiku();
let gate1 = null;
const gate1Path = path.join(os.tmpdir(), 'cairn-demo-gate1.json');
if (g1.error) {
  process.stdout.write(`  ERROR: ${g1.error}\n`);
  if (g1.raw) process.stdout.write(`  raw: ${g1.raw}\n`);
} else {
  gate1 = g1.parsed;
  process.stdout.write(pretty(gate1) + '\n');
  fs.writeFileSync(gate1Path, pretty(gate1) + '\n', 'utf8');
  process.stdout.write(`  -> ${gate1Path}\n`);
}

let gate2 = null;
if (args['gate2-from'] && typeof args['gate2-from'] === 'string') {
  header('Gate 2 — second engine (from file)');
  try {
    gate2 = JSON.parse(fs.readFileSync(args['gate2-from'], 'utf8'));
    process.stdout.write(pretty(gate2) + '\n');
  } catch (e) {
    process.stdout.write(`  ERROR reading ${args['gate2-from']}: ${e.message}\n`);
  }
} else {
  header('Gate 2 — second engine (skipped, no --gate2-from)');
  process.stdout.write(`  To add Gate 2, dispatch the prompt below to a fresh\n`);
  process.stdout.write(`  Agent context (general-purpose subagent), save JSON\n`);
  process.stdout.write(`  to /tmp/cairn-demo-gate2.json, re-run with\n`);
  process.stdout.write(`    --gate2-from=/tmp/cairn-demo-gate2.json\n`);
  process.stdout.write(`\n  Prompt:\n${QUESTION_PROMPT.split('\n').map(l => '    ' + l).join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Hard match
// ---------------------------------------------------------------------------

header('Hard match');
let fails = 0;
function check(name, a, b) {
  const equal = deepEqual(a, b);
  process.stdout.write(`  ${equal ? 'ok  ' : 'FAIL'} ${name}\n`);
  if (!equal) {
    fails++;
    process.stdout.write(`  --- a ---\n${pretty(a).split('\n').map(l => '    ' + l).join('\n')}\n`);
    process.stdout.write(`  --- b ---\n${pretty(b).split('\n').map(l => '    ' + l).join('\n')}\n`);
  }
}
if (gate1) check('Gate1 (haiku)    == Gate3 (real)', gate1, gate3);
if (gate2) check('Gate2 (2nd-eng)  == Gate3 (real)', gate2, gate3);
if (gate1 && gate2) check('Gate1 (haiku)    == Gate2 (2nd-eng)', gate1, gate2);

if (!gate1 && !gate2) {
  process.stdout.write('  Only Gate 3 ran; no cross-engine comparison available.\n');
  process.exit(2);
}

process.exit(fails === 0 ? 0 : 1);
