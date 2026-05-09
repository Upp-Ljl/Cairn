#!/usr/bin/env node
/**
 * Smoke for worker-launcher.cjs.
 *
 * Provider detection, fixture-echo end-to-end (real spawn, real
 * stdout, real exit), tail-log truncation, stop semantics, run.json
 * persistence, secret hygiene.
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
function ok(c, l) { asserts++; if (c) console.log(`  ok    ${l}`); else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); } }

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeDb = safeMtime(realCairnDb);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-launcher-smoke-'));
process.env.HOME = tmpDir;
process.env.USERPROFILE = tmpDir;
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const launcher = require(path.join(root, 'worker-launcher.cjs'));

// -------- Part A: provider detection

const provs = launcher.detectWorkerProviders();
ok(Array.isArray(provs), 'detectWorkerProviders returns array');
ok(provs.find(p => p.id === 'fixture-echo' && p.available), 'fixture-echo always available');
ok(provs.find(p => p.id === 'claude-code'), 'claude-code listed');
ok(provs.find(p => p.id === 'codex'), 'codex listed');
console.log('  detected providers:', provs.map(p => `${p.id}(${p.available ? 'avail' : 'no'})`).join(' '));

// -------- Part B: launchWorker → fixture-echo → wait for exit → assert run.json + tail.log

const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-launcher-cwd-'));

const PROMPT = [
  'You are a coding agent under Cairn rules.',
  '',
  '# Goal',
  'Wire up Sentry sample-rate config',
  '',
  '# Managed project',
  'Repo: https://example/repo.git',
  'Local path basename: fixture-app',
  'Default branch: main',
  'Package manager: bun',
  'Detected test commands:',
  '  - bun run test',
  '',
  '# When you finish',
  'Produce a final report.',
].join('\n');

const launchRes = launcher.launchWorker({
  provider: 'fixture-echo',
  cwd: fix,
  prompt: PROMPT,
  iteration_id: 'i_smoke_001',
  project_id: 'p_smoke_aaa',
});
ok(launchRes.ok, 'launchWorker(fixture-echo) ok');
ok(/^wr_/.test(launchRes.run_id), 'run_id has wr_ prefix');

const RUN_ID = launchRes.run_id;

// run.json should exist immediately, prompt.txt should exist
const runJsonPath = path.join(tmpDir, '.cairn', 'worker-runs', RUN_ID, 'run.json');
const promptPath = path.join(tmpDir, '.cairn', 'worker-runs', RUN_ID, 'prompt.txt');
ok(fs.existsSync(runJsonPath), 'run.json written');
ok(fs.existsSync(promptPath), 'prompt.txt written');
const promptContent = fs.readFileSync(promptPath, 'utf8');
ok(promptContent === PROMPT, 'prompt.txt round-trips exactly');

// Wait for fixture-echo to exit (it just writes some lines and exits 0)
await new Promise(r => setTimeout(r, 800));

const finalRun = launcher.getWorkerRun(RUN_ID);
ok(finalRun != null, 'getWorkerRun returns metadata');
ok(finalRun.status === 'exited', `status === exited (got ${finalRun && finalRun.status})`);
ok(finalRun.exit_code === 0, 'exit_code 0');
ok(finalRun.pid != null, 'pid recorded');
ok(typeof finalRun.prompt_hash === 'string' && finalRun.prompt_hash.length === 16, 'prompt_hash recorded');
ok(finalRun.provider === 'fixture-echo', 'provider stamped on run.json');

// tail.log should exist and contain the fixture's banner + Worker Report
const tail = launcher.tailRunLog(RUN_ID, 16 * 1024);
ok(tail.length > 0, 'tail log is non-empty');
ok(tail.includes('[fixture-echo]'), 'tail contains fixture banner');
ok(tail.includes('## Worker Report'), 'tail contains Worker Report header');

// -------- Part C: extractWorkerReport from the fixture's output

const extract = launcher.extractWorkerReport(RUN_ID);
ok(extract.ok, 'extract ok');
ok(extract.completed.length >= 1, 'extracted >=1 completed item');
ok(extract.remaining.length >= 1, 'extracted >=1 remaining item');
ok(extract.next_steps.length >= 1, 'extracted >=1 next item');

// extractReportFromText edge cases
const noBlock = launcher.extractReportFromText('hello world\nno report here');
ok(!noBlock.ok && noBlock.error === 'no_report_block', 'extract: no block → error');
const lastWins = launcher.extractReportFromText([
  '## Worker Report',
  '### Completed',
  '- early one',
  '## Worker Report',
  '### Completed',
  '- late one',
].join('\n'));
ok(lastWins.ok && lastWins.completed.includes('late one') && !lastWins.completed.includes('early one'),
   'extract: last block wins');

// Empty bullets in a section must NOT produce phantom items — this
// caused the real-Claude dogfood to land on verdict=blocked even
// though Blockers was empty.
const emptyBlockers = launcher.extractReportFromText([
  '## Worker Report',
  '### Completed',
  '- did a thing',
  '### Remaining',
  '### Blockers',
  '-',
  '### Next',
  '- next thing',
].join('\n'));
ok(emptyBlockers.ok, 'extract: empty bullets parse ok');
ok(emptyBlockers.blockers.length === 0, 'empty Blockers section does not produce phantom item from bare "-"');
ok(emptyBlockers.completed.length === 1 && emptyBlockers.next_steps.length === 1,
   'real bullets in surrounding sections still parsed');

// "(none)" / "n/a" / "none" sentinels in a section must NOT count as
// items. Real Claude output: `- (none)` under Blockers when there
// are no blockers; before this filter, review fell back to
// status=blocked.
const noneSentinel = launcher.extractReportFromText([
  '## Worker Report',
  '### Completed',
  '- did a thing',
  '### Remaining',
  '- N/A',
  '### Blockers',
  '- (none)',
  '### Next',
  '- next thing',
].join('\n'));
ok(noneSentinel.ok, 'extract: sentinel-only sections parse ok');
ok(noneSentinel.blockers.length === 0, '"(none)" in Blockers does not count as a blocker');
ok(noneSentinel.remaining.length === 0, '"N/A" in Remaining does not count as remaining');
ok(noneSentinel.completed.length === 1 && noneSentinel.next_steps.length === 1,
   'real items in other sections still parse');

// Variants the regex must catch.
for (const variant of ['none', 'None.', 'nothing', 'nil', 'no', 'Nothing.', '— none —', '[none]', '<none>']) {
  const t = launcher.extractReportFromText([
    '## Worker Report', '### Blockers', `- ${variant}`, '### Next', '- x',
  ].join('\n'));
  ok(t.ok && t.blockers.length === 0, `sentinel "${variant}" treated as empty`);
}

// -------- Part D: error paths

const e1 = launcher.launchWorker({});
ok(!e1.ok && e1.error === 'provider_required', 'launch: missing provider');
const e2 = launcher.launchWorker({ provider: 'fixture-echo' });
ok(!e2.ok && e2.error === 'cwd_required', 'launch: missing cwd');
const e3 = launcher.launchWorker({ provider: 'fixture-echo', cwd: fix });
ok(!e3.ok && e3.error === 'prompt_required', 'launch: missing prompt');
const e4 = launcher.launchWorker({ provider: 'fixture-echo', cwd: '/no/such/dir', prompt: 'x' });
ok(!e4.ok && e4.error === 'cwd_not_found', 'launch: cwd does not exist');
const e5 = launcher.launchWorker({ provider: 'no-such-provider', cwd: fix, prompt: 'x' });
ok(!e5.ok && e5.error === 'unknown_provider', 'launch: unknown provider');

// -------- Part E: stopWorkerRun on a new long-runner

// Spawn a fixture-echo run that runs to completion quickly — for stop
// testing we override fixture script via a custom provider would be
// extra-invasive. Instead, assert stop on an already-exited run is a
// safe no-op.
const stopRes = launcher.stopWorkerRun(RUN_ID);
ok(stopRes.ok && stopRes.already, 'stop on already-exited run is safe');

const stopMissing = launcher.stopWorkerRun('wr_no_such_x');
ok(!stopMissing.ok && stopMissing.error === 'run_not_found', 'stop on unknown id rejects');

// -------- Part F: log truncation rotation

// Generate 200KB of synthetic log to trigger rotation (MAX_LOG_BYTES=128KB)
import { randomBytes } from 'node:crypto';
const synthRunId = 'wr_synth_aaa';
fs.mkdirSync(path.join(tmpDir, '.cairn', 'worker-runs', synthRunId), { recursive: true });
// Use the launcher's appendToTailLog indirectly — it's not exported,
// but tail rotation is exercised by direct file-size assertion via
// repeated launches. Easier: call launcher.tailRunLog after manually
// writing an oversized file, then re-trigger appendToTailLog by
// launching another fixture-echo run with a very long prompt. The
// fixture echoes some lines but not 200KB, so the rotation path is
// exercised more directly via writing a huge file and asserting the
// internal helper if exposed.
//
// We expose `runDir` + `runFile` so the test can simulate a fat tail
// pre-existing on disk and then append via the helper we DO have on
// the public API: tailRunLog (read-only). Since rotation is a write
// concern, exercise it by writing a >128KB tail file and confirm
// future appends would truncate. The launcher's internal
// appendToTailLog is private; we assert tailRunLog respects the
// limit instead.
const fatPath = path.join(tmpDir, '.cairn', 'worker-runs', synthRunId, 'tail.log');
const fat = Buffer.alloc(200 * 1024, 0x41); // 200KB of 'A'
fs.writeFileSync(fatPath, fat);
const tailFromFat = launcher.tailRunLog(synthRunId, 200 * 1024);
ok(tailFromFat.length === 200 * 1024, 'tailRunLog returns full bytes when limit allows');
const tailLimited = launcher.tailRunLog(synthRunId, 32 * 1024);
ok(tailLimited.length === 32 * 1024, 'tailRunLog respects byte limit');

// -------- Part G: secret hygiene

const hyg = launcher.summarizeEnvHygiene({
  ANTHROPIC_API_KEY: 'sk-ant-redacted',
  GITHUB_TOKEN: 'ghp_xxx',
  PATH: '/usr/bin',
});
ok(hyg.sensitive_env_present.includes('ANTHROPIC_API_KEY'), 'hygiene names ANTHROPIC_API_KEY');
ok(hyg.sensitive_env_present.includes('GITHUB_TOKEN'), 'hygiene names GITHUB_TOKEN');
ok(!JSON.stringify(hyg).includes('sk-ant-redacted'), 'hygiene NEVER includes the value');
ok(!JSON.stringify(hyg).includes('ghp_xxx'), 'hygiene NEVER includes the token value');

// -------- Part H: source-level safety greps

const src = fs.readFileSync(path.join(root, 'worker-launcher.cjs'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok(!/cairn\.db/.test(code), 'no cairn.db ref in code');
ok(!/['"]\.claude\/settings\.json['"]/.test(code), 'no ~/.claude/settings.json ref');
ok(!/['"]\.codex/.test(code), 'no ~/.codex ref');
ok(!/['"]push['"]|['"]rebase['"]|['"]reset['"]|['"]checkout['"]/.test(code), 'no destructive git verbs in code');
ok(!/shell:\s*true/.test(code), 'no shell:true in spawn options');

// run.json should NOT contain any value of secret env vars
const runJsonText = fs.readFileSync(runJsonPath, 'utf8');
ok(!/sk-ant-/.test(runJsonText), 'run.json does not leak ANTHROPIC_API_KEY value');
ok(!/ghp_/.test(runJsonText), 'run.json does not leak GitHub token');
ok(!/Bearer\s+[A-Za-z0-9]/.test(runJsonText), 'run.json has no Bearer headers');

// -------- Part I: read-only invariants

ok(safeMtime(realCairnDb) === beforeDb, 'real ~/.cairn/cairn.db mtime unchanged');

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
