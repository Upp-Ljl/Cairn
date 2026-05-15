#!/usr/bin/env node
/**
 * smoke-claude-settings-config.mjs — unit smoke for the new per-spawn
 * settings.json builder. 12 assertions per plan §4.2.
 *
 * HOME sandbox (registry-pollution lesson — see CLAUDE.md memory
 * feedback_smoke_real_registry_pollution).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-settings-cfg-smk-'));
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
const cfg = require(path.join(dsRoot, 'claude-settings-config.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-claude-settings-config (Cairn hooks turn protocol — commit 1)');

section('1 missing runId → ok:false, error="runId_required"');
{
  const r = cfg.buildSettingsConfigFile({});
  ok(r.ok === false, 'returns ok:false');
  ok(r.error === 'runId_required', `error = runId_required (got ${r.error})`);
}

section('2 valid call returns tempPath + cleanup + hookPayloadFile');
{
  const runId = 'wr_test_' + Date.now().toString(36);
  const r = cfg.buildSettingsConfigFile({ runId, home: _tmpDir, tmpDir: _tmpDir });
  ok(r.ok === true, 'ok = true');
  ok(typeof r.tempPath === 'string' && r.tempPath.length > 0, 'tempPath is a non-empty string');
  ok(typeof r.cleanup === 'function', 'cleanup is a function');
  ok(typeof r.hookPayloadFile === 'string' && r.hookPayloadFile.includes(runId), 'hookPayloadFile path includes runId');
  // (l) audit file lives under the run dir
  ok(r.hookPayloadFile.includes('worker-runs'), 'hookPayloadFile under worker-runs/');

  section('3 settings.json on disk parses + has Stop & SessionStart');
  ok(fs.existsSync(r.tempPath), 'tempPath file exists');
  const parsed = JSON.parse(fs.readFileSync(r.tempPath, 'utf8'));
  ok(parsed.hooks && parsed.hooks.Stop && Array.isArray(parsed.hooks.Stop), 'hooks.Stop is an array');
  ok(parsed.hooks.SessionStart && Array.isArray(parsed.hooks.SessionStart), 'hooks.SessionStart is an array');

  section('4 Stop hook has a non-empty command embedding the audit path quote-safe');
  const stopCmd = parsed.hooks.Stop[0].hooks[0].command;
  ok(typeof stopCmd === 'string' && stopCmd.length > 0, 'Stop command is a non-empty string');
  // R1 mitigation assertion: the path is embedded as a JSON string
  // literal. We can verify by extracting between JSON.stringify-style
  // delimiters and reparsing.
  const reEmbedded = new RegExp(JSON.stringify(r.hookPayloadFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  ok(reEmbedded.test(stopCmd), 'Stop command embeds hookPayloadFile path quote-safe');

  section('5 cleanup removes the temp file + is idempotent');
  r.cleanup();
  ok(!fs.existsSync(r.tempPath), 'cleanup removes the temp file');
  // Second call must not throw
  let threw = false;
  try { r.cleanup(); } catch (_e) { threw = true; }
  ok(!threw, 'cleanup is idempotent (no throw on second call)');
}

section('6 write_failed when tmpDir does not exist');
{
  const missing = path.join(_tmpDir, 'does', 'not', 'exist', 'nested');
  const r = cfg.buildSettingsConfigFile({ runId: 'wr_x', tmpDir: missing });
  ok(r.ok === false && /write_failed/.test(r.error), `write_failed (got ${r.error})`);
}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
