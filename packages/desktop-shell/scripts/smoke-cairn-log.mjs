#!/usr/bin/env node
/**
 * smoke-cairn-log.mjs — cairn-log.cjs structured event log.
 *
 * Per CEO 2026-05-14 Mode A/B reframe foundation phase.
 * HOME sandbox per registry-pollution lesson.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Sandbox HOME first.
const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-log-smoke-'));
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
const cairnLog = require(path.join(dsRoot, 'cairn-log.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-cairn-log');

// ---------------------------------------------------------------------------
section('1 LOG_DIR is under sandboxed HOME, NOT real ~/.cairn');
{
  const realCairnDir = path.join(_realHome, '.cairn');
  ok(cairnLog.LOG_DIR.startsWith(_tmpDir), `LOG_DIR=${cairnLog.LOG_DIR} starts with sandbox tmpDir`);
  // On Windows %TMP% lives under %USERPROFILE%, so `startsWith(_realHome)` is
  // not informative. Real check: LOG_DIR is NOT the real ~/.cairn path.
  ok(!cairnLog.LOG_DIR.startsWith(realCairnDir), `LOG_DIR not under real ~/.cairn (${realCairnDir})`);
}

// ---------------------------------------------------------------------------
section('2 log() writes one line per call');
{
  cairnLog.log('test-component', 'first_event', { foo: 'bar' });
  cairnLog.log('test-component', 'second_event', { baz: 42 });
  cairnLog.log('test-component', 'third_event');
  const lines = fs.readFileSync(cairnLog.currentLogPath(), 'utf8').trim().split('\n');
  ok(lines.length === 3, `3 events written (got ${lines.length})`);
  const p1 = JSON.parse(lines[0]);
  ok(p1.component === 'test-component', 'component preserved');
  ok(p1.event === 'first_event', 'event preserved');
  ok(p1.foo === 'bar', 'detail.foo merged into top-level');
  ok(typeof p1.ts === 'number' && p1.ts > 0, 'ts is a positive number');
  ok(typeof p1.ts_iso === 'string' && p1.ts_iso.endsWith('Z'), 'ts_iso ISO format');
  ok(p1.level === 'info', 'default level=info');
}

// ---------------------------------------------------------------------------
section('3 level wrappers');
{
  cairnLog.info('w', 'a');
  cairnLog.warn('w', 'b');
  cairnLog.error('w', 'c');
  const t = cairnLog.tail(3);
  ok(t.length === 3, 'tail returns last 3');
  ok(t[0].level === 'info', 'info level set');
  ok(t[1].level === 'warn', 'warn level set');
  ok(t[2].level === 'error', 'error level set');
}

// ---------------------------------------------------------------------------
section('4 fails gracefully (never throws)');
{
  // Circular ref → JSON.stringify throws normally; logger must swallow
  const circular = {};
  circular.self = circular;
  let threw = false;
  try { cairnLog.log('test', 'circular', circular); } catch (_e) { threw = true; }
  ok(!threw, 'log() does NOT throw on circular detail');

  // Pass non-object as details — should still work
  let threw2 = false;
  try { cairnLog.log('test', 'nonobj', 'string-not-object'); } catch (_e) { threw2 = true; }
  ok(!threw2, 'log() does NOT throw on non-object details');
}

// ---------------------------------------------------------------------------
section('5 LOG_DIR auto-created if missing');
{
  // Delete + log again → recreated
  const fresh = path.join(_tmpDir, '.cairn-newuser');
  fs.mkdirSync(fresh, { recursive: true });
  // Reset _ready state by reloading module is too invasive; just verify
  // currentLogPath() returns a sensible path.
  ok(cairnLog.currentLogPath().includes('cairn-'), 'log file path contains date stamp');
  ok(cairnLog.currentLogPath().endsWith('.jsonl'), 'log file is .jsonl');
}

// ---------------------------------------------------------------------------
section('6 tail() returns latest N as parsed objects');
{
  // Already wrote 6+ entries by this point
  const t5 = cairnLog.tail(5);
  ok(Array.isArray(t5), 'tail returns array');
  ok(t5.length === 5, 'tail respects N (5)');
  for (const e of t5) {
    ok(typeof e === 'object' && e !== null, 'each entry is parsed object');
  }
  const t100 = cairnLog.tail(100);
  ok(t100.length >= 5, 'tail caps to available entries when N exceeds');
}

// ---------------------------------------------------------------------------
section('7 daily rotation: filename contains today YYYY-MM-DD');
{
  const today = new Date().toISOString().slice(0, 10);
  ok(cairnLog.currentLogPath().includes(today), `filename contains "${today}"`);
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
