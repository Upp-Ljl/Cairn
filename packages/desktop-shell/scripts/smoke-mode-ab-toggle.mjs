#!/usr/bin/env node
/**
 * smoke-mode-ab-toggle.mjs — MA-1 Mode A/B toggle plumbing.
 *
 * HOME sandbox per registry-pollution lesson (memory:
 * feedback_smoke_real_registry_pollution).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Sandbox HOME first.
const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mode-ab-smoke-'));
fs.mkdirSync(path.join(_tmpDir, '.cairn'), { recursive: true });
process.env.HOME = _tmpDir;
process.env.USERPROFILE = _tmpDir;
const _mtimeBefore = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
process.on('exit', () => {
  const _mtimeAfter = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
  if (_mtimeBefore !== _mtimeAfter) {
    console.error('FATAL: smoke wrote to REAL ~/.cairn/projects.json');
    process.exit(3);
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const registry = require(path.join(dsRoot, 'registry.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-mode-ab-toggle (MA-1)');

// ---------------------------------------------------------------------------
section('1 default mode is B (safe default)');
{
  const def = registry.COCKPIT_SETTINGS_DEFAULT;
  ok(def.mode === 'B', `COCKPIT_SETTINGS_DEFAULT.mode === 'B' (got ${def.mode})`);
  ok(Array.isArray(registry.KNOWN_MODES), 'KNOWN_MODES exported as array');
  ok(registry.KNOWN_MODES.includes('A') && registry.KNOWN_MODES.includes('B'), 'KNOWN_MODES contains A + B');
  ok(registry.KNOWN_MODES.length === 2, 'KNOWN_MODES is exactly [A,B] — no leak');
}

// ---------------------------------------------------------------------------
section('2 getCockpitSettings returns mode for a fresh project');
{
  const reg0 = { version: 2, projects: [
    { id: 'p_a', label: 'A', project_root: '/x', db_path: '/x.db', agent_id_hints: [], added_at: 0, last_opened_at: 0 },
  ] };
  const s = registry.getCockpitSettings(reg0, 'p_a');
  ok(s.mode === 'B', `default project gets mode=B (got ${s.mode})`);
  ok(s.leader === 'claude-code', 'existing leader default preserved');
}

// ---------------------------------------------------------------------------
section('3 setCockpitSettings({mode: A}) flips mode + preserves other fields');
{
  const reg0 = { version: 2, projects: [
    { id: 'p_a', label: 'A', project_root: '/x', db_path: '/x.db', agent_id_hints: [], added_at: 0, last_opened_at: 0 },
  ] };
  const r1 = registry.setCockpitSettings(reg0, 'p_a', { mode: 'A' });
  ok(!r1.error, `no error (got ${r1.error || 'undefined'})`);
  ok(r1.settings.mode === 'A', `mode now A (got ${r1.settings.mode})`);
  ok(r1.settings.leader === 'claude-code', 'leader unchanged');
  ok(r1.settings.llm_helpers.tail_summary_enabled === true, 'llm_helpers preserved');

  // Round-trip
  const s2 = registry.getCockpitSettings(r1.reg, 'p_a');
  ok(s2.mode === 'A', 'getCockpitSettings round-trips mode=A');

  // Flip back to B
  const r2 = registry.setCockpitSettings(r1.reg, 'p_a', { mode: 'B' });
  ok(!r2.error && r2.settings.mode === 'B', 'flip back to B works');
}

// ---------------------------------------------------------------------------
section('4 unknown mode is rejected');
{
  const reg0 = { version: 2, projects: [
    { id: 'p_a', label: 'A', project_root: '/x', db_path: '/x.db', agent_id_hints: [], added_at: 0, last_opened_at: 0 },
  ] };
  const r = registry.setCockpitSettings(reg0, 'p_a', { mode: 'C' });
  ok(!!r.error, 'mode=C returns error');
  ok(r.error.includes('unknown_mode'), `error mentions unknown_mode (${r.error})`);

  const r2 = registry.setCockpitSettings(reg0, 'p_a', { mode: 42 });
  // typeof 42 !== 'string' so 'mode' falls back to cur (B), no error.
  ok(!r2.error, 'non-string mode silently falls back to current');
  ok(r2.settings.mode === 'B', 'non-string mode left current=B alone');
}

// ---------------------------------------------------------------------------
section('5 legacy project (no cockpit_settings) still gets mode default');
{
  const reg0 = { version: 2, projects: [
    // No cockpit_settings field at all.
    { id: 'p_old', label: 'old', project_root: '/y', db_path: '/y.db', agent_id_hints: [], added_at: 0, last_opened_at: 0 },
  ] };
  const s = registry.getCockpitSettings(reg0, 'p_old');
  ok(s.mode === 'B', `legacy project synthesizes mode=B (got ${s.mode})`);
}

// ---------------------------------------------------------------------------
section('6 partial set (leader only) leaves mode intact');
{
  const reg0 = { version: 2, projects: [
    { id: 'p_a', label: 'A', project_root: '/x', db_path: '/x.db', agent_id_hints: [],
      added_at: 0, last_opened_at: 0,
      cockpit_settings: { mode: 'A', leader: 'claude-code', llm_helpers: {}, escalation_thresholds: {} },
    },
  ] };
  const r = registry.setCockpitSettings(reg0, 'p_a', { leader: 'cursor' });
  ok(!r.error, 'no error');
  ok(r.settings.mode === 'A', `mode still A after leader-only update (got ${r.settings.mode})`);
  ok(r.settings.leader === 'cursor', 'leader actually changed to cursor');
}

// ---------------------------------------------------------------------------
section('7 saveRegistry persists mode to disk (catches writeRegistry typo class)');
{
  // Build a registry in memory, persist via saveRegistry, reload, verify mode A.
  const reg0 = { version: 2, projects: [
    { id: 'p_persist', label: 'P', project_root: path.join(_tmpDir, 'proj'), db_path: path.join(_tmpDir, 'p.db'),
      agent_id_hints: [], added_at: Date.now(), last_opened_at: Date.now() },
  ] };
  const r1 = registry.setCockpitSettings(reg0, 'p_persist', { mode: 'A' });
  ok(!r1.error && r1.settings.mode === 'A', 'in-memory set mode=A ok');
  // The IPC path: caller calls saveRegistry after setCockpitSettings.
  ok(typeof registry.saveRegistry === 'function', 'registry.saveRegistry is a function');
  ok(typeof registry.writeRegistry !== 'function', 'registry.writeRegistry is NOT a function (writeRegistry typo class)');
  registry.saveRegistry(r1.reg);
  // Re-load from disk via registry.loadRegistry equivalent.
  const reloaded = JSON.parse(fs.readFileSync(path.join(_tmpDir, '.cairn', 'projects.json'), 'utf8'));
  ok(reloaded.projects.length === 1, 'projects round-tripped');
  const persisted = reloaded.projects[0];
  ok(persisted.cockpit_settings && persisted.cockpit_settings.mode === 'A',
     `persisted mode === 'A' (got ${persisted.cockpit_settings && persisted.cockpit_settings.mode})`);
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
