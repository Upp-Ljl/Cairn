#!/usr/bin/env node
/**
 * smoke-signal-categories.mjs — unit smoke for the CATEGORY_ALIASES
 * map + signalKeyToCategory / categoryToSignalKey helpers added to
 * mentor-collect.cjs (2026-05-15).
 *
 * HOME sandbox (registry-pollution lesson — feedback_smoke_real_registry_pollution).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-sig-cat-smk-'));
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
const collect = require(path.join(dsRoot, 'mentor-collect.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-signal-categories (mentor-collect.cjs vocabulary)');

section('1 CATEGORY_ALIASES has all 6 known internal signal keys');
{
  const expectedKeys = ['docs', 'git', 'candidates', 'iterations', 'reports', 'kernel'];
  for (const k of expectedKeys) {
    ok(typeof collect.CATEGORY_ALIASES[k] === 'string' && collect.CATEGORY_ALIASES[k].length > 0,
       `CATEGORY_ALIASES.${k} is a non-empty string (got ${JSON.stringify(collect.CATEGORY_ALIASES[k])})`);
  }
  ok(Object.keys(collect.CATEGORY_ALIASES).length === 6, '6 entries total');
}

section('2 CATEGORY_ALIASES + KNOWN_SIGNAL_KEYS frozen (no mutation)');
{
  let threw = false;
  try { collect.CATEGORY_ALIASES.foo = 'bar'; } catch (_e) { threw = true; }
  ok(threw || collect.CATEGORY_ALIASES.foo === undefined, 'CATEGORY_ALIASES is frozen');
  ok(Object.isFrozen(collect.KNOWN_SIGNAL_KEYS), 'KNOWN_SIGNAL_KEYS is frozen');
  ok(Array.isArray(collect.KNOWN_SIGNAL_KEYS) && collect.KNOWN_SIGNAL_KEYS.length === 6, 'KNOWN_SIGNAL_KEYS has 6 entries');
}

section('3 signalKeyToCategory — round-trip semantics');
{
  ok(collect.signalKeyToCategory('git') === '~~vcs-signal', `git → ~~vcs-signal (got ${collect.signalKeyToCategory('git')})`);
  ok(collect.signalKeyToCategory('docs') === '~~project-narrative', 'docs → ~~project-narrative');
  ok(collect.signalKeyToCategory('candidates') === '~~candidate-pipeline', 'candidates → ~~candidate-pipeline');
  ok(collect.signalKeyToCategory('iterations') === '~~iteration-history', 'iterations → ~~iteration-history');
  ok(collect.signalKeyToCategory('reports') === '~~worker-reports', 'reports → ~~worker-reports');
  ok(collect.signalKeyToCategory('kernel') === '~~kernel-state', 'kernel → ~~kernel-state');
}

section('4 signalKeyToCategory — defensive returns');
{
  ok(collect.signalKeyToCategory('unknown_key') === null, 'unknown key → null');
  ok(collect.signalKeyToCategory('') === null, 'empty string → null');
  ok(collect.signalKeyToCategory(null) === null, 'null → null');
  ok(collect.signalKeyToCategory(undefined) === null, 'undefined → null');
  ok(collect.signalKeyToCategory(42) === null, 'non-string → null');
}

section('5 categoryToSignalKey — inverse mapping');
{
  ok(collect.categoryToSignalKey('~~vcs-signal') === 'git', '~~vcs-signal → git');
  ok(collect.categoryToSignalKey('~~project-narrative') === 'docs', '~~project-narrative → docs');
  ok(collect.categoryToSignalKey('~~kernel-state') === 'kernel', '~~kernel-state → kernel');
}

section('6 categoryToSignalKey — accepts both ~~ and bare forms');
{
  // The map literally stores 'vcs-signal' (no ~~). Both prefixed and bare lookups work.
  ok(collect.categoryToSignalKey('vcs-signal') === 'git', 'bare vcs-signal → git');
  ok(collect.categoryToSignalKey('project-narrative') === 'docs', 'bare project-narrative → docs');
}

section('7 categoryToSignalKey — defensive returns');
{
  ok(collect.categoryToSignalKey('~~unknown') === null, '~~unknown → null');
  ok(collect.categoryToSignalKey('') === null, 'empty → null');
  ok(collect.categoryToSignalKey(null) === null, 'null → null');
}

section('8 round-trip stability: signal → category → signal');
{
  for (const k of collect.KNOWN_SIGNAL_KEYS) {
    const cat = collect.signalKeyToCategory(k);
    const back = collect.categoryToSignalKey(cat);
    ok(back === k, `${k} → ${cat} → ${back} (round-trip preserves)`);
  }
}

section('9 backwards compat — original exports still present');
{
  ok(Array.isArray(collect.WHITELIST_DOC_FILES) && collect.WHITELIST_DOC_FILES.includes('PRODUCT.md'),
     'WHITELIST_DOC_FILES still exported + includes PRODUCT.md');
  ok(typeof collect.DOC_READ_BYTES_CAP === 'number' && collect.DOC_READ_BYTES_CAP > 0,
     'DOC_READ_BYTES_CAP still exported');
  ok(typeof collect.DEFAULT_SOURCE_TIMEOUT_MS === 'number' && collect.DEFAULT_SOURCE_TIMEOUT_MS > 0,
     'DEFAULT_SOURCE_TIMEOUT_MS still exported');
  ok(typeof collect.collectMentorSignals === 'function', 'collectMentorSignals still exported');
}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
