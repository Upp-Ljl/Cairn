#!/usr/bin/env node
/**
 * smoke-signal-pills.mjs — Signal-cat refactor commit A (2026-05-15).
 *
 * Verifies cockpit-state.deriveMentorSignalsSummary correctly splits
 * mentor-collect.collectMentorSignals output into {available, missing}
 * arrays of ~~category placeholder names for the panel STATUS pill row.
 *
 * Style mirrors smoke-autopilot-status.mjs: HOME sandbox, pure helper
 * call, no DB / electron / spawn.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// HOME sandbox (mirrors smoke-autopilot-status.mjs guard).
const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-signal-pills-smk-'));
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
const cs = require(path.join(dsRoot, 'cockpit-state.cjs'));
const mc = require(path.join(dsRoot, 'mentor-collect.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-signal-pills (cockpit-state.deriveMentorSignalsSummary)');

section('1 null / undefined / empty input → both arrays empty');
{
  const s = cs.deriveMentorSignalsSummary(null);
  ok(Array.isArray(s.available) && s.available.length === 0, 'null input → available=[]');
  ok(Array.isArray(s.missing) && s.missing.length === 0,   'null input → missing=[]');
}
{
  const s = cs.deriveMentorSignalsSummary(undefined);
  ok(s.available.length === 0 && s.missing.length === 0, 'undefined input → both empty');
}
{
  const s = cs.deriveMentorSignalsSummary({});
  // No signals object + no failed_signals: every body is undefined, so
  // every category lands in `missing`.
  ok(s.available.length === 0, 'empty {} → available=[]');
  ok(s.missing.length === mc.KNOWN_SIGNAL_KEYS.length, 'empty {} → all categories missing');
}

section('2 all-failed input → all categories in missing');
{
  const failed_signals = mc.KNOWN_SIGNAL_KEYS.map(k => ({ source: k, error: 'timeout' }));
  const s = cs.deriveMentorSignalsSummary({ signals: {}, meta: { failed_signals } });
  ok(s.available.length === 0, 'all failed → available=[]');
  ok(s.missing.length === mc.KNOWN_SIGNAL_KEYS.length, 'all failed → missing has every category');
  ok(s.missing.includes('project-narrative'), 'docs alias surfaced in missing');
  ok(s.missing.includes('vcs-signal'), 'git alias surfaced in missing');
  ok(s.missing.includes('kernel-state'), 'kernel alias surfaced in missing when failed');
}

section('3 mixed — some signals have data, some fail, some scaffold');
{
  const result = {
    signals: {
      docs: { files: [{ path: 'README.md', byte_count: 100, text_clipped: 'x' }], total_bytes: 100 },
      git:  { head: 'abc1234', branch: 'main', status_short: '', commits: [] },
      candidates: [],
      iterations: [{ id: 'it1' }],
      reports: [],
      kernel: { tasks_running: 0, tasks_blocked: 0 },
    },
    meta: { failed_signals: [{ source: 'reports', error: 'timeout' }] },
  };
  const s = cs.deriveMentorSignalsSummary(result);
  ok(s.available.includes('project-narrative'), 'docs with files → project-narrative available');
  ok(s.available.includes('vcs-signal'),        'git with head → vcs-signal available');
  ok(s.available.includes('iteration-history'), 'iterations non-empty → iteration-history available');
  ok(s.available.includes('kernel-state'),      'kernel scaffold object → kernel-state available');
  ok(s.missing.includes('candidate-pipeline'),  'candidates empty array → candidate-pipeline missing');
  ok(s.missing.includes('worker-reports'),      'reports in failed_signals → worker-reports missing');
  // Union check — every category lands in exactly one bucket
  const allCats = mc.KNOWN_SIGNAL_KEYS.map(k => mc.CATEGORY_ALIASES[k]);
  for (const cat of allCats) {
    const inA = s.available.includes(cat);
    const inM = s.missing.includes(cat);
    ok(inA !== inM, `category "${cat}" in exactly one bucket (avail=${inA} missing=${inM})`);
  }
}

section('4 git head empty string → missing (not available)');
{
  const result = {
    signals: { git: { head: '', branch: '', status_short: '', commits: [] } },
    meta: { failed_signals: [] },
  };
  const s = cs.deriveMentorSignalsSummary(result);
  ok(s.missing.includes('vcs-signal'),    'git empty head → vcs-signal missing');
  ok(!s.available.includes('vcs-signal'), 'git empty head → NOT in available');
}

section('5 docs files=[] → missing');
{
  const result = {
    signals: { docs: { files: [], total_bytes: 0 } },
    meta: { failed_signals: [] },
  };
  const s = cs.deriveMentorSignalsSummary(result);
  ok(s.missing.includes('project-narrative'), 'docs files=[] → project-narrative missing');
}

section('6 buildCockpitState surfaces mentor_signals from opts');
{
  // No DB / no project — exercise emptyCockpitState path
  const empty = cs.emptyCockpitState(null, null, 'no_project');
  ok(empty.mentor_signals && Array.isArray(empty.mentor_signals.available), 'empty payload has mentor_signals.available');
  ok(empty.mentor_signals.available.length === 0 && empty.mentor_signals.missing.length === 0,
     'empty payload mentor_signals is { available: [], missing: [] }');
}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
