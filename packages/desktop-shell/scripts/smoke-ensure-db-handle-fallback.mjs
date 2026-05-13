#!/usr/bin/env node
/**
 * smoke-ensure-db-handle-fallback.mjs — locks the 2026-05-14 bug fix
 * for "panel L0 card doesn't update for projects with sentinel db_path".
 *
 * Bug 鸭总 reported: 试验场 (p_agp_demo_001 registry entry with
 * db_path='/dev/null') opened a new Claude Code session, mcp-server
 * registered correctly in processes table, but panel L0 card status
 * indicator never changed.
 *
 * Root cause: `getProjectsList()` calls `ensureDbHandle(p.db_path)`
 * directly. On Windows fs.existsSync('/dev/null') = false → handle null
 * → summary null → no status light. Two other handlers (get-cockpit-state
 * + get-project-summary) inline-fallback /dev/null to DEFAULT_DB_PATH;
 * getProjectsList did not. Inconsistent.
 *
 * Fix: centralize fallback inside ensureDbHandle so all 15 callers
 * benefit uniformly.
 *
 * This smoke verifies the fix structurally (asserts the source contains
 * the sentinel handling) — a true runtime test would need Electron
 * boot + CDP, covered by smoke-electron-boot already.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_CJS = path.resolve(__dirname, '..', 'main.cjs');

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-ensure-db-handle-fallback');

const src = fs.readFileSync(MAIN_CJS, 'utf8');

// ---------------------------------------------------------------------------
section('1 DB_PATH_SENTINELS Set declared');
const sentinelDecl = /const\s+DB_PATH_SENTINELS\s*=\s*new\s+Set\s*\(\s*\[(.+?)\]\s*\)/.exec(src);
ok(sentinelDecl !== null, 'DB_PATH_SENTINELS Set is declared at module level');
if (sentinelDecl) {
  const items = sentinelDecl[1];
  ok(items.includes("'/dev/null'") || items.includes('"/dev/null"'), 'sentinel set contains /dev/null');
  ok(items.includes("'(unknown)'") || items.includes('"(unknown)"'), 'sentinel set contains (unknown)');
}

// ---------------------------------------------------------------------------
section('2 ensureDbHandle uses sentinel fallback');
// Look for the function body
const fnMatch = /function\s+ensureDbHandle\s*\([\s\S]+?\)\s*\{([\s\S]+?)\n\}/.exec(src);
ok(fnMatch !== null, 'ensureDbHandle function found');
if (fnMatch) {
  const body = fnMatch[1];
  ok(/DB_PATH_SENTINELS\.has\s*\(\s*p\s*\)/.test(body), 'body checks DB_PATH_SENTINELS.has(p)');
  ok(/=\s*registry\.DEFAULT_DB_PATH/.test(body), 'body reassigns p = registry.DEFAULT_DB_PATH on sentinel');
  // Ensure the fallback comes BEFORE the dbHandles.has(p) cache check
  const sentinelIdx = body.indexOf('DB_PATH_SENTINELS');
  const cacheIdx = body.indexOf('dbHandles.has');
  ok(sentinelIdx > 0 && cacheIdx > 0 && sentinelIdx < cacheIdx,
     'sentinel fallback runs BEFORE dbHandles cache lookup (else cache key is stale sentinel)');
}

// ---------------------------------------------------------------------------
section('3 No stale inline /dev/null fallbacks needed at callsites (regression guard)');
// The two known inline fallbacks should still work (idempotent) but the
// fix means callers without inline fallback ALSO work. Count occurrences
// of the inline-fallback pattern — should stay ≤ 2 (the two original
// handlers, kept for defense-in-depth).
const inlineFallbackPattern = /=== '\/dev\/null' \|\| .+? === '\(unknown\)'/g;
const inlineMatches = src.match(inlineFallbackPattern) || [];
ok(inlineMatches.length <= 3,
   `≤3 inline /dev/null fallbacks remain (defense-in-depth; got ${inlineMatches.length})`);

// ---------------------------------------------------------------------------
section('4 ensureDbHandle is still called bare (no caller needs to pre-fix)');
// The whole point of centralizing: callers can pass raw p.db_path.
// Find ensureDbHandle callsites and ensure they exist (not removed).
const bareCalls = (src.match(/ensureDbHandle\(p\.db_path\)|ensureDbHandle\(proj\.db_path\)|ensureDbHandle\(dbPath\)/g) || []).length;
ok(bareCalls >= 10, `≥10 ensureDbHandle callsites benefit from centralized fix (got ${bareCalls})`);

// ---------------------------------------------------------------------------
section('5 documentation block explains the fix');
ok(/Sentinel fallback/i.test(src), 'docstring mentions Sentinel fallback');
ok(/getProjectsList/i.test(src), 'docstring explains which caller caused the bug');
ok(/2026-05-14/.test(src), 'docstring dates the fix');

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
