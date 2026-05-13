#!/usr/bin/env node
/**
 * smoke-cairn-md-drafter.mjs — A4 hard-floor verification.
 *
 * Validates:
 *   - gatherSignals reads CLAUDE.md / README.md / package.json / git log /
 *     dir listing without throwing on missing inputs
 *   - buildPrompt embeds anti-framing + JSON-only contract
 *   - _validateDraft enforces the WHOLE_RE format (20-200 chars, capital
 *     start, terminal punctuation)
 *   - renderDraftToMarkdown produces v2 schema sections (Whole + Goal,
 *     no Current phase, ✅/⚠️/🛑 bullets, agent_brief protocol footer)
 *   - draftCairnMd with stubbed runHelper writes to disk and returns
 *     source='haiku'
 *   - draftCairnMd with provider-disabled stub falls back to scaffold
 *     and returns source='fallback' (the hard floor)
 *   - draftCairnMd with helper-throwing stub still produces a fallback,
 *     never raises to caller
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');

const drafter = require(path.join(dsRoot, 'cairn-md-drafter.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

function freshRepo(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-drafter-smoke-'));
  if (opts.git !== false) {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 's@e.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'S'], { cwd: dir });
  }
  if (opts.withReadme !== false) {
    fs.writeFileSync(path.join(dir, 'README.md'), '# my-thing\n\nA tiny CLI that converts thing A to thing B.\n');
  }
  if (opts.withPackageJson) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'my-thing',
      description: 'tiny CLI A→B',
      scripts: { build: 'tsc', test: 'vitest', publish: 'npm publish' },
      dependencies: { commander: '^11.0.0' },
    }, null, 2));
  }
  if (opts.withClaudeMd) {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# CLAUDE.md\n\n## conventions\n- TS for everything\n- vitest, no mocks\n');
  }
  if (opts.git !== false) {
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  }
  return dir;
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch (_e) { /* tmp will GC */ }
}

header('smoke-cairn-md-drafter');

// ---------------------------------------------------------------------------
section('1 gatherSignals');
{
  const dir = freshRepo({ withReadme: true, withPackageJson: true, withClaudeMd: true });
  try {
    const s = drafter.gatherSignals(dir);
    ok(typeof s.readme === 'string' && s.readme.includes('tiny CLI'), 'README.md read');
    ok(typeof s.claudeMd === 'string' && s.claudeMd.includes('conventions'), 'CLAUDE.md read');
    ok(s.packageJson && s.packageJson.name === 'my-thing', 'package.json parsed');
    ok(Array.isArray(s.packageJson.scripts) && s.packageJson.scripts.includes('publish'), 'scripts list includes publish');
    ok(typeof s.gitLog === 'string' && s.gitLog.includes('init'), 'git log captured');
    ok(typeof s.dirListing === 'string' && s.dirListing.includes('README.md'), 'dir listing captured');
  } finally { cleanup(dir); }

  // missing files don't throw
  const dir2 = freshRepo({ withReadme: false, withPackageJson: false, withClaudeMd: false });
  try {
    const s = drafter.gatherSignals(dir2);
    ok(s.readme === null, 'no README → null (no throw)');
    ok(s.claudeMd === null, 'no CLAUDE.md → null');
    ok(s.packageJson === null, 'no package.json → null');
  } finally { cleanup(dir2); }

  // bad input
  ok(Object.keys(drafter.gatherSignals(null)).length === 0, 'null projectRoot → empty signals');
  ok(Object.keys(drafter.gatherSignals('')).length === 0, 'empty projectRoot → empty signals');
}

// ---------------------------------------------------------------------------
section('2 buildPrompt');
{
  const prompt = drafter.buildPrompt({
    readme: '# Foo\nA library.',
    packageJson: { name: 'foo', description: 'a lib', scripts: ['publish'], dependencies: [] },
  });
  ok(typeof prompt.system === 'string' && prompt.system.length > 100, 'system prompt present');
  ok(/project director/i.test(prompt.system), 'anti-framing: Project Director');
  ok(/senior engineer/i.test(prompt.system), 'anti-framing: not Senior Engineer');
  ok(prompt.system.includes('plan-mode'), 'anti-framing: not plan-mode');
  ok(prompt.system.includes('## Whole') || prompt.system.includes('Whole'), 'mentions Whole');
  ok(prompt.system.includes('JSON'), 'JSON-only output contract');
  ok(prompt.user.includes('Foo'), 'user prompt embeds README');
  ok(prompt.user.includes('foo') && prompt.user.includes('publish'), 'user prompt embeds package.json');

  // empty signals
  const emptyPrompt = drafter.buildPrompt({});
  ok(emptyPrompt.user.includes('no project signals') || emptyPrompt.user.includes('(none)'),
     'empty signals → user prompt mentions missing data');
}

// ---------------------------------------------------------------------------
section('3 _validateDraft (WHOLE_RE)');
{
  const goodWhole = 'A tiny tool that does one specific thing very well indeed.';
  const tooShort = 'Too short.';
  const tooLong = 'A'.repeat(220) + '.';
  const noTerm = 'A reasonable length sentence without terminal punctuation though';
  const startsLower = 'a sentence starting lowercase which fails the pattern.';

  ok(drafter._validateDraft({
    whole: goodWhole, goal: 'Ship v1.', authority: {},
  }).ok === true, 'good whole + goal + authority → ok');

  ok(drafter._validateDraft({ whole: tooShort, goal: 'g', authority: {} }).reason === 'whole_format', 'too short → whole_format');
  ok(drafter._validateDraft({ whole: tooLong, goal: 'g', authority: {} }).reason === 'whole_format', 'too long → whole_format');
  ok(drafter._validateDraft({ whole: noTerm, goal: 'g', authority: {} }).reason === 'whole_format', 'no terminal punct → whole_format');
  ok(drafter._validateDraft({ whole: startsLower, goal: 'g', authority: {} }).reason === 'whole_format', 'starts lowercase → whole_format');
  ok(drafter._validateDraft({ whole: '', goal: 'g', authority: {} }).reason === 'whole_missing', 'empty whole → whole_missing');
  ok(drafter._validateDraft({ whole: goodWhole, authority: {} }).reason === 'goal_missing', 'no goal → goal_missing');
  ok(drafter._validateDraft({ whole: goodWhole, goal: 'g' }).reason === 'authority_missing', 'no authority → authority_missing');
  ok(drafter._validateDraft(null).reason === 'not_an_object', 'null → not_an_object');
}

// ---------------------------------------------------------------------------
section('4 renderDraftToMarkdown — v2 schema');
{
  const md = drafter.renderDraftToMarkdown({
    whole: 'A tiny widget that converts thingies into thongies for the user.',
    goal: 'Ship v1 by milestone X.',
    is: ['converter', 'CLI'],
    is_not: ['IDE', 'agent framework'],
    authority: {
      auto: ['retry transient test failures'],
      announce: ['reduce time budget'],
      escalate: ['npm publish', 'force-push to main'],
    },
    constraints: ['no new deps'],
    known_answers: [{ pattern: 'which lang', answer: 'TypeScript' }],
  }, 'my-thing');

  ok(md.startsWith('# my-thing\n'), 'H1 = project name');
  ok(md.includes('## Whole\n\nA tiny widget'), 'Whole section emitted with sentence');
  ok(md.includes('## Goal\n\nShip v1'), 'Goal section emitted');
  ok(md.includes('- IS: converter'), 'IS bullet rendered');
  ok(md.includes('- IS NOT: IDE'), 'IS NOT bullet rendered');
  ok(md.includes('- ✅ retry transient test failures'), '✅ bullet rendered');
  ok(md.includes('- ⚠️ reduce time budget'), '⚠️ bullet rendered');
  ok(md.includes('- 🛑 npm publish'), '🛑 bullet rendered');
  ok(md.includes('- which lang => TypeScript'), 'known answer rendered');
  ok(md.includes('## For Cairn-aware coding agents'), 'agent protocol footer included');
  ok(!md.includes('## Current phase'), 'no Current phase section (v2)');
  ok(!md.includes('**Last updated**'), 'no time-anchored fields');
}

// ---------------------------------------------------------------------------
section('5 draftCairnMd — happy path with stubbed runHelper');
{
  const dir = freshRepo({ withReadme: true, withPackageJson: true });
  try {
    const goodOutput = JSON.stringify({
      whole: 'A tiny widget that converts thingies into thongies for the user.',
      goal: 'Ship v1 of the converter.',
      is: ['CLI'],
      is_not: ['IDE'],
      authority: {
        auto: ['retry transient test failures'],
        announce: [],
        escalate: ['npm publish'],
      },
      constraints: ['no new deps'],
      known_answers: [],
    });
    const stubRun = async () => ({ ok: true, content: goodOutput, model: 'stub-haiku' });

    const r = await drafter.draftCairnMd({
      projectRoot: dir,
      projectName: 'my-thing',
      runHelper: stubRun,
    });

    ok(r.ok === true, 'ok: true');
    ok(r.source === 'haiku', 'source: haiku');
    ok(r.written === true, 'wrote file');
    ok(r.validation && r.validation.ok === true, 'validation passed');
    ok(fs.existsSync(path.join(dir, 'CAIRN.md')), 'CAIRN.md on disk');
    const onDisk = fs.readFileSync(path.join(dir, 'CAIRN.md'), 'utf8');
    ok(onDisk.includes('## Whole'), 'on-disk file has Whole');
  } finally { cleanup(dir); }
}

// ---------------------------------------------------------------------------
section('6 draftCairnMd — provider disabled → fallback');
{
  const dir = freshRepo();
  try {
    const stubNoProvider = async () => ({ ok: false, reason: 'no_provider' });
    const r = await drafter.draftCairnMd({ projectRoot: dir, runHelper: stubNoProvider });
    ok(r.ok === true, 'ok: true (still ships scaffold)');
    ok(r.source === 'fallback', 'source: fallback');
    ok(r.validation && r.validation.ok === false, 'validation captured the no_provider reason');
    ok(r.validation.reason === 'no_provider', 'validation.reason = no_provider');
    ok(r.written === true, 'fallback was still written');
    const md = fs.readFileSync(path.join(dir, 'CAIRN.md'), 'utf8');
    ok(md.includes('## Whole') && md.includes('## Goal'), 'fallback has v2 sections');
    ok(!md.includes('## Current phase'), 'fallback has no v1 Current phase');
  } finally { cleanup(dir); }
}

// ---------------------------------------------------------------------------
section('7 draftCairnMd — helper throws → still ships fallback');
{
  const dir = freshRepo();
  try {
    const stubThrows = async () => { throw new Error('boom'); };
    const r = await drafter.draftCairnMd({ projectRoot: dir, runHelper: stubThrows });
    ok(r.ok === true, 'ok: true (helper-throw absorbed)');
    ok(r.source === 'fallback', 'source: fallback');
    ok(r.validation && r.validation.reason === 'helper_threw', 'reason recorded');
    ok(fs.existsSync(path.join(dir, 'CAIRN.md')), 'fallback file exists on disk');
  } finally { cleanup(dir); }
}

// ---------------------------------------------------------------------------
section('8 draftCairnMd — write: false returns content without disk');
{
  const dir = freshRepo();
  try {
    const stub = async () => ({ ok: true, content: JSON.stringify({
      whole: 'A tool that does one thing very specifically and quite well overall.',
      goal: 'Ship.',
      authority: { auto: [], announce: [], escalate: [] },
    }) });
    const r = await drafter.draftCairnMd({ projectRoot: dir, runHelper: stub, write: false });
    ok(r.ok === true && r.source === 'haiku', 'ok + haiku');
    ok(r.written === false, 'write=false → written:false');
    ok(!fs.existsSync(path.join(dir, 'CAIRN.md')), 'CAIRN.md NOT on disk');
    ok(typeof r.content === 'string' && r.content.includes('## Whole'), 'content returned');
  } finally { cleanup(dir); }
}

// ---------------------------------------------------------------------------
section('9 draftCairnMd — bad input');
{
  const r1 = await drafter.draftCairnMd({});
  ok(r1.ok === false && r1.error === 'projectRoot_required', 'missing projectRoot');
  const r2 = await drafter.draftCairnMd({ projectRoot: 123 });
  ok(r2.ok === false && r2.error === 'projectRoot_required', 'non-string projectRoot');
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
