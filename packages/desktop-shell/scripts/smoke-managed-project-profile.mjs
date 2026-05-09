#!/usr/bin/env node
/**
 * Smoke for managed-project.cjs — profile detection, register flow,
 * read-only invariants.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let asserts = 0, fails = 0;
const failures = [];
function ok(cond, label) {
  asserts++;
  if (cond) console.log(`  ok    ${label}`);
  else { fails++; failures.push(label); console.log(`  FAIL  ${label}`); }
}

// Snapshot off-limits paths.
const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
const realClaude = path.join(os.homedir(), '.claude');
const realCodex = path.join(os.homedir(), '.codex');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn = safeMtime(realCairnDb);
const beforeClaude = safeMtime(realClaude);
const beforeCodex = safeMtime(realCodex);

// HOME shim before requiring.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-managed-smoke-'));
process.env.HOME = tmpDir;
process.env.USERPROFILE = tmpDir;
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const mp = require(path.join(root, 'managed-project.cjs'));

// -------- Part A: detectProjectProfile fixture (Next.js + bun-like)

const fixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-managed-fixture-'));
fs.writeFileSync(path.join(fixDir, 'package.json'), JSON.stringify({
  name: 'fix-app',
  scripts: {
    dev: 'next dev',
    build: 'next build',
    test: 'bun test',
    'test:watch': 'bun test --watch',
    lint: 'next lint',
  },
  bin: { 'fix-cli': './dist/cli.js' },
  main: 'dist/index.js',
}));
fs.writeFileSync(path.join(fixDir, 'bun.lock'), '');
fs.writeFileSync(path.join(fixDir, 'tsconfig.json'), '{}');
fs.writeFileSync(path.join(fixDir, 'README.md'), '# Fixture App\n\nThis is the fixture used by Cairn smoke tests.\nIt validates package manager + script detection.\n');
fs.writeFileSync(path.join(fixDir, 'src.ts'), '// stub\n'); // language hint
fs.writeFileSync(path.join(fixDir, 'app.py'), '# py stub\n');
fs.mkdirSync(path.join(fixDir, '.git'));
fs.writeFileSync(path.join(fixDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

const detect = mp.detectProjectProfile(fixDir);
ok(detect.ok, 'detectProjectProfile ok');
ok(detect.profile.package_manager === 'bun', 'package manager detected as bun');
ok(detect.profile.languages.includes('javascript') && detect.profile.languages.includes('typescript') && detect.profile.languages.includes('python'),
   'languages include javascript+typescript+python');
ok(detect.profile.test_commands.some(c => c === 'bun run test'), 'test command rendered as `bun run test`');
ok(detect.profile.build_commands.some(c => c === 'bun run build'), 'build command rendered');
ok(detect.profile.lint_commands.some(c => c === 'bun run lint'), 'lint command rendered');
ok(detect.profile.entry_points.some(e => e.includes('dist/index.js')), 'entry_points include main');
ok(detect.profile.docs.includes('README.md'), 'docs include README.md');
ok(detect.profile.readme_excerpt.length > 0 && detect.profile.readme_excerpt.length <= 500, 'readme excerpt bounded');

// Missing local_path → graceful
const miss = mp.detectProjectProfile(path.join(fixDir, 'no-such-dir'));
ok(!miss.ok && miss.error === 'local_path_not_found', 'missing local_path returns error code');

// File argument that is not a directory.
const fileLikePath = path.join(fixDir, 'package.json');
const notDir = mp.detectProjectProfile(fileLikePath);
ok(!notDir.ok && notDir.error === 'local_path_not_directory', 'non-directory rejected');

// -------- Part B: package manager fallback

const pmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-pm-'));
fs.writeFileSync(path.join(pmDir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'jest' } }));
fs.writeFileSync(path.join(pmDir, 'pnpm-lock.yaml'), '');
const pmRes = mp.detectProjectProfile(pmDir);
ok(pmRes.ok && pmRes.profile.package_manager === 'pnpm', 'pnpm-lock.yaml → pnpm');

// -------- Part C: registerManagedProject persists to ~/.cairn

const reg = mp.registerManagedProject({
  project_id: 'p_smoke_test_aaa',
  repo_url: 'https://example.com/x.git',
  local_path: fixDir,
  clone: false,
});
ok(reg.ok, 'register ok');
ok(reg.record.project_id === 'p_smoke_test_aaa', 'record project_id propagated');
ok(reg.record.profile && reg.record.profile.package_manager === 'bun', 'record carries profile');
ok(reg.record.git_root === fixDir, 'git_root detected');
ok(reg.record.default_branch === 'main', 'default branch detected from .git/HEAD');

// File should exist at managed projects dir.
const managedFile = path.join(tmpDir, '.cairn', 'managed-projects', 'p_smoke_test_aaa.json');
ok(fs.existsSync(managedFile), 'managed-project file persisted');

// Re-read.
const re = mp.readManagedProject('p_smoke_test_aaa');
ok(re && re.local_path === fixDir, 'readManagedProject round-trips');

// -------- Part D: clone graceful when local_path missing AND clone:false

const reg2 = mp.registerManagedProject({
  project_id: 'p_smoke_test_bbb',
  repo_url: 'https://example.com/x.git',
  local_path: path.join(tmpDir, 'no-such'),
  clone: false,
});
ok(reg2.ok === true, 'register persists even without local_path');
ok(reg2.profile_error === 'local_path_not_found', 'profile_error surfaced');
ok(reg2.record.profile === null, 'record.profile null when local missing');

// -------- Part E: cloneRepo refuses non-empty target

const dirty = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-clone-target-'));
fs.writeFileSync(path.join(dirty, 'x.txt'), 'taken');
const c = mp.cloneRepo('https://example.com/x.git', dirty);
ok(!c.ok && c.error === 'target_not_empty', 'cloneRepo rejects non-empty target');

// -------- Part F: source-level greps

const src = fs.readFileSync(path.join(root, 'managed-project.cjs'), 'utf8');
// Strip block comments before grepping for I/O patterns — boundary
// docs intentionally mention these paths to declare what we don't
// touch; only real code paths matter.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok(!/cairn\.db/.test(code), 'no code reference to cairn.db');
ok(!/['"]\.claude['"]|['"]\.codex['"]/.test(code), 'no code reference to .claude / .codex');
ok(!/\bnpm install\b|\bpip install\b/.test(code), 'no install commands');

// -------- Part G: read-only invariants

ok(safeMtime(realCairnDb) === beforeCairn, 'real ~/.cairn/cairn.db mtime unchanged');
ok(safeMtime(realClaude) === beforeClaude, '~/.claude mtime unchanged');
ok(safeMtime(realCodex) === beforeCodex, '~/.codex mtime unchanged');

console.log(`\n${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
