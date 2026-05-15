#!/usr/bin/env node
/**
 * smoke-skills-loader.mjs — coverage for skills-loader.cjs (Phase 1
 * skill externalisation, analysis 2026-05-15-mentor-pattern-from-plugin).
 *
 * Verifies:
 *   1. _listKnownSkills returns the 3 defaults
 *   2. loadSkill falls back to embedded default when no user override
 *   3. loadSkill prefers user override under HOME
 *   4. loadSkill returns ok:false for unknown skill
 *   5. bootstrapSkillsDir copies all defaults on a fresh HOME
 *   6. bootstrapSkillsDir is idempotent — second call copies 0
 *   7. bootstrapSkillsDir does NOT overwrite user-edited files
 *   8. mtime change invalidates the loader cache
 *
 * HOME-sandboxed throughout (registry-pollution lesson).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const skillsLoader = require(path.join(dsRoot, 'skills-loader.cjs'));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-skill-smk-'));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else      { fail++; console.log('  FAIL  ' + label); }
}
function section(title) { console.log('\n==> ' + title); }

// ---------------------------------------------------------------------------
// 1. _listKnownSkills returns 3 defaults
// ---------------------------------------------------------------------------
section('1 _listKnownSkills returns the 3 expected defaults');
{
  const list = skillsLoader._listKnownSkills();
  ok(Array.isArray(list), 'returns an array');
  ok(list.includes('plan-shape'), 'plan-shape present');
  ok(list.includes('mentor-recommendation'), 'mentor-recommendation present');
  ok(list.includes('handoff-protocol'), 'handoff-protocol present');
}

// ---------------------------------------------------------------------------
// 2. loadSkill falls back to embedded default when no user override
// ---------------------------------------------------------------------------
section('2 loadSkill: default fallback when no user file exists');
{
  const home = path.join(tmpRoot, 'home-fresh');
  fs.mkdirSync(home, { recursive: true });
  skillsLoader._clearCache();
  const res = skillsLoader.loadSkill('plan-shape', { home });
  ok(res && res.ok === true, 'ok:true with no user override');
  ok(res.source === 'default', 'source = "default"');
  ok(typeof res.text === 'string' && res.text.includes('milestone'), 'text contains "milestone"');
  ok(typeof res.path === 'string' && res.path.endsWith('plan-shape.md'), 'path ends with plan-shape.md');
}

// ---------------------------------------------------------------------------
// 3. loadSkill prefers user override under HOME
// ---------------------------------------------------------------------------
section('3 loadSkill: user override wins over default');
{
  const home = path.join(tmpRoot, 'home-override');
  const userSkillsDir = path.join(home, '.cairn', 'skills');
  fs.mkdirSync(userSkillsDir, { recursive: true });
  const overrideText = '## CUSTOM PLAN SHAPE\n- only 2 steps allowed\n';
  fs.writeFileSync(path.join(userSkillsDir, 'plan-shape.md'), overrideText, 'utf8');
  skillsLoader._clearCache();
  const res = skillsLoader.loadSkill('plan-shape', { home });
  ok(res && res.ok === true && res.source === 'user', 'source = "user"');
  ok(res.text.includes('CUSTOM PLAN SHAPE'), 'returns the override content verbatim');
}

// ---------------------------------------------------------------------------
// 4. loadSkill returns ok:false for unknown skill
// ---------------------------------------------------------------------------
section('4 loadSkill: unknown skill returns ok:false');
{
  const home = path.join(tmpRoot, 'home-unknown');
  fs.mkdirSync(home, { recursive: true });
  skillsLoader._clearCache();
  const res = skillsLoader.loadSkill('totally-not-a-skill', { home });
  ok(res && res.ok === false, 'ok:false');
  ok(typeof res.error === 'string' && res.error.length > 0, 'has error string');
}

// ---------------------------------------------------------------------------
// 5. bootstrapSkillsDir copies all defaults on fresh HOME
// ---------------------------------------------------------------------------
section('5 bootstrapSkillsDir copies all defaults on a fresh HOME');
let bootstrapHome;
{
  bootstrapHome = path.join(tmpRoot, 'home-bootstrap');
  const out = skillsLoader.bootstrapSkillsDir({ home: bootstrapHome });
  ok(Array.isArray(out.copied) && out.copied.length >= 3, 'copied ≥ 3 default files (got ' + out.copied.length + ')');
  ok(out.errors.length === 0, 'no errors');
  const userDir = path.join(bootstrapHome, '.cairn', 'skills');
  ok(fs.existsSync(path.join(userDir, 'plan-shape.md')), 'plan-shape.md exists in HOME after bootstrap');
  ok(fs.existsSync(path.join(userDir, 'mentor-recommendation.md')), 'mentor-recommendation.md exists');
  ok(fs.existsSync(path.join(userDir, 'handoff-protocol.md')), 'handoff-protocol.md exists');
}

// ---------------------------------------------------------------------------
// 6. bootstrapSkillsDir is idempotent
// ---------------------------------------------------------------------------
section('6 bootstrapSkillsDir is idempotent on re-run');
{
  const out = skillsLoader.bootstrapSkillsDir({ home: bootstrapHome });
  ok(out.copied.length === 0, 'second call copies 0 (got ' + out.copied.length + ')');
  ok(out.skipped.length >= 3, 'second call reports ≥ 3 skipped');
}

// ---------------------------------------------------------------------------
// 7. bootstrapSkillsDir preserves user edits
// ---------------------------------------------------------------------------
section('7 bootstrapSkillsDir preserves user edits (no overwrite)');
{
  const home = path.join(tmpRoot, 'home-userdits');
  const userSkillsDir = path.join(home, '.cairn', 'skills');
  fs.mkdirSync(userSkillsDir, { recursive: true });
  const userText = '# MY HAND-EDITED PLAN SHAPE\nnothing else.\n';
  fs.writeFileSync(path.join(userSkillsDir, 'plan-shape.md'), userText, 'utf8');
  const out = skillsLoader.bootstrapSkillsDir({ home });
  ok(!out.copied.includes('plan-shape.md'), 'plan-shape.md NOT copied (user edit preserved)');
  const still = fs.readFileSync(path.join(userSkillsDir, 'plan-shape.md'), 'utf8');
  ok(still === userText, 'user file content unchanged after bootstrap');
}

// ---------------------------------------------------------------------------
// 8. mtime change invalidates the loader cache
// ---------------------------------------------------------------------------
section('8 loadSkill cache invalidates on mtime change');
{
  const home = path.join(tmpRoot, 'home-mtime');
  const userSkillsDir = path.join(home, '.cairn', 'skills');
  fs.mkdirSync(userSkillsDir, { recursive: true });
  const userFile = path.join(userSkillsDir, 'plan-shape.md');
  fs.writeFileSync(userFile, '## v1\n- first version\n', 'utf8');
  skillsLoader._clearCache();

  const res1 = skillsLoader.loadSkill('plan-shape', { home });
  ok(res1.ok && res1.text.includes('first version'), 'first read returns v1');

  // Bump mtime forward by 2s so the cache notices the change. Pure
  // time-advance via utimesSync — no sleep needed.
  const future = new Date(Date.now() + 2000);
  fs.writeFileSync(userFile, '## v2\n- second version\n', 'utf8');
  fs.utimesSync(userFile, future, future);

  const res2 = skillsLoader.loadSkill('plan-shape', { home });
  ok(res2.ok && res2.text.includes('second version'), 'second read after mtime bump returns v2');
  ok(!res2.text.includes('first version'), 'v1 content no longer returned');
}

// ---------------------------------------------------------------------------
// Final report
// ---------------------------------------------------------------------------
console.log('\n=================================');
console.log(`smoke-skills-loader: ${pass} pass / ${fail} fail`);
console.log('=================================');
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
process.exit(fail === 0 ? 0 : 1);
