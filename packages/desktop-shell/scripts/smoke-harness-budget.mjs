#!/usr/bin/env node
/**
 * smoke-harness-budget.mjs — Smoke test for harness-budget.cjs (Module 1).
 *
 * HOME sandbox mandatory: no real ~/.cairn pollution.
 * Pattern: follows smoke-mode-a-loop.mjs structure.
 *
 * Run:
 *   node packages/desktop-shell/scripts/smoke-harness-budget.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// HOME sandbox (mandatory — prevents real ~/.cairn pollution)
// ---------------------------------------------------------------------------
const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-harness-budget-'));
fs.mkdirSync(path.join(_tmpDir, '.cairn'), { recursive: true });
process.env.HOME = _tmpDir;
process.env.USERPROFILE = _tmpDir;

const _mtimeBefore = fs.existsSync(_realProjectsJson)
  ? fs.statSync(_realProjectsJson).mtimeMs
  : null;

process.on('exit', () => {
  const _mtimeAfter = fs.existsSync(_realProjectsJson)
    ? fs.statSync(_realProjectsJson).mtimeMs
    : null;
  if (_mtimeBefore !== _mtimeAfter) {
    console.error('FATAL: smoke polluted REAL ~/.cairn/projects.json');
    process.exitCode = 3;
  }
});

// ---------------------------------------------------------------------------
// Load module under test
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { createBudget, DEFAULT_LIMITS, ZONES } = require(path.join(dsRoot, 'harness-budget.cjs'));

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------
let asserts = 0, fails = 0;
const failures = [];

function ok(cond, label) {
  asserts++;
  if (cond) {
    process.stdout.write(`  ok    ${label}\n`);
  } else {
    fails++;
    failures.push(label);
    process.stdout.write(`  FAIL  ${label}\n`);
  }
}

function header(t) {
  process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`);
}

function section(t) {
  process.stdout.write(`\n[${t}]\n`);
}

// ---------------------------------------------------------------------------
// Event factory helpers
// ---------------------------------------------------------------------------
function assistantEvent(text) {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  };
}

function toolUseEvent(toolName) {
  return {
    type: 'tool_use',
    name: toolName,
  };
}

function assistantWithToolUse(text, toolName) {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text },
        { type: 'tool_use', name: toolName, id: 'tu_001', input: {} },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
header('smoke-harness-budget (Module 1 Budget Controller)');

// ---------------------------------------------------------------------------
section('1. exports and defaults');
{
  ok(typeof createBudget === 'function', 'createBudget is a function');
  ok(typeof DEFAULT_LIMITS === 'object', 'DEFAULT_LIMITS exported');
  ok(DEFAULT_LIMITS.max_duration_ms === 600000, 'DEFAULT_LIMITS.max_duration_ms = 600000');
  ok(DEFAULT_LIMITS.max_tool_calls === 80, 'DEFAULT_LIMITS.max_tool_calls = 80');
  ok(DEFAULT_LIMITS.max_output_tokens === 50000, 'DEFAULT_LIMITS.max_output_tokens = 50000');
  ok(typeof ZONES === 'object', 'ZONES exported');
  ok(ZONES.GREEN === 'GREEN', 'ZONES.GREEN');
  ok(ZONES.YELLOW === 'YELLOW', 'ZONES.YELLOW');
  ok(ZONES.RED === 'RED', 'ZONES.RED');
  ok(ZONES.FUSE === 'FUSE', 'ZONES.FUSE');
}

// ---------------------------------------------------------------------------
section('2. createBudget with defaults → zone=GREEN, metrics zeroed');
{
  let fakeNow = 1000;
  const b = createBudget({}, { nowFn: () => fakeNow });
  const m = b.getMetrics();
  ok(m.zone === 'GREEN', 'initial zone is GREEN');
  ok(m.tool_calls === 0, 'initial tool_calls = 0');
  ok(m.estimated_tokens === 0, 'initial estimated_tokens = 0');
  ok(m.pct_duration >= 0 && m.pct_duration <= 1, 'pct_duration in [0,1]');
  ok(m.pct_tools === 0, 'pct_tools = 0');
  ok(m.pct_tokens === 0, 'pct_tokens = 0');
  ok(typeof m.elapsed_ms === 'number', 'elapsed_ms is a number');
}

// ---------------------------------------------------------------------------
section('3. check() with assistant event → tokens increment');
{
  let fakeNow = 1000;
  const b = createBudget({}, { nowFn: () => fakeNow });

  // Feed an assistant event with known word count
  const r = b.check(assistantEvent('hello world foo bar baz'));
  ok(r.zone === 'GREEN', 'zone still GREEN after small assistant event');
  ok(r.metrics.estimated_tokens > 0, 'estimated_tokens incremented after assistant event');
  ok(r.action === null, 'action=null in GREEN zone');

  // getMetrics() reflects same state
  const m = b.getMetrics();
  ok(m.estimated_tokens > 0, 'getMetrics reflects token increment');
}

// ---------------------------------------------------------------------------
section('4. check() with tool_use event → tool_calls increment');
{
  let fakeNow = 1000;
  const b = createBudget({}, { nowFn: () => fakeNow });

  b.check(toolUseEvent('Read'));
  b.check(toolUseEvent('Write'));
  const m = b.getMetrics();
  ok(m.tool_calls === 2, `tool_calls = 2 after 2 tool events (got ${m.tool_calls})`);

  // tool_use block nested inside assistant event
  b.check(assistantWithToolUse('some text', 'Bash'));
  const m2 = b.getMetrics();
  ok(m2.tool_calls === 3, `tool_calls = 3 after nested tool_use block (got ${m2.tool_calls})`);
}

// ---------------------------------------------------------------------------
section('5. GREEN → YELLOW transition at 75% duration');
{
  let fakeNow = 0;
  const b = createBudget({ max_duration_ms: 1000 }, { nowFn: () => fakeNow });

  // 74% — still GREEN
  fakeNow = 740;
  const r74 = b.check({});
  ok(r74.zone === 'GREEN', 'zone=GREEN at 74%');
  ok(r74.action === null, 'action=null at 74%');

  // 76% — should cross YELLOW threshold
  fakeNow = 760;
  const r76 = b.check({});
  ok(r76.zone === 'YELLOW', `zone=YELLOW at 76% (got ${r76.zone})`);
  // YELLOW transition itself has no action (action is only on RED/FUSE)
  ok(r76.action === null, 'action=null on YELLOW transition');
}

// ---------------------------------------------------------------------------
section('6. YELLOW → RED transition at 90% → action=wrap_up returned ONCE');
{
  let fakeNow = 0;
  const b = createBudget({ max_duration_ms: 1000 }, { nowFn: () => fakeNow });

  // Advance to YELLOW first
  fakeNow = 800;
  b.check({});

  // Cross 90% → RED
  fakeNow = 910;
  const r = b.check({});
  ok(r.zone === 'RED', `zone=RED at 91% (got ${r.zone})`);
  ok(r.action === 'wrap_up', `action=wrap_up on RED entry (got ${r.action})`);

  // Second check in RED → action=null (transition action emitted only once)
  fakeNow = 950;
  const r2 = b.check({});
  ok(r2.zone === 'RED', 'zone stays RED');
  ok(r2.action === null, 'action=null on subsequent RED check (transition once)');
}

// ---------------------------------------------------------------------------
section('7. RED → FUSE at 100% → action=fuse returned ONCE');
{
  let fakeNow = 0;
  const b = createBudget({ max_duration_ms: 1000 }, { nowFn: () => fakeNow });

  fakeNow = 800; b.check({});  // YELLOW
  fakeNow = 910; b.check({});  // RED (wrap_up)

  // Cross 100% → FUSE
  fakeNow = 1010;
  const r = b.check({});
  ok(r.zone === 'FUSE', `zone=FUSE at 101% (got ${r.zone})`);
  ok(r.action === 'fuse', `action=fuse on FUSE entry (got ${r.action})`);

  // Subsequent checks after FUSE → zone stays FUSE, action=null
  fakeNow = 1500;
  const r2 = b.check({});
  ok(r2.zone === 'FUSE', 'zone stays FUSE after entry');
  ok(r2.action === null, 'action=null on subsequent FUSE check');

  fakeNow = 9999;
  const r3 = b.check(assistantEvent('more text'));
  ok(r3.zone === 'FUSE', 'zone still FUSE with more events');
  ok(r3.action === null, 'action=null for all events after FUSE');
}

// ---------------------------------------------------------------------------
section('8. Tool call limit: 80 tool events → FUSE (via pct_tools)');
{
  let fakeNow = 0;
  // Short duration so only tool dimension triggers
  const b = createBudget(
    { max_duration_ms: 99999999, max_tool_calls: 80, max_output_tokens: 99999999 },
    { nowFn: () => fakeNow }
  );

  // 59 calls → GREEN
  for (let i = 0; i < 59; i++) b.check(toolUseEvent('Read'));
  ok(b.getMetrics().zone === 'GREEN', '59 tool calls → GREEN');

  // 60+ calls (75%) → YELLOW
  for (let i = 0; i < 2; i++) b.check(toolUseEvent('Read')); // 61 total
  ok(b.getMetrics().zone === 'YELLOW', '61 tool calls → YELLOW (75%+ of 80)');

  // 72+ calls (90%) → RED
  for (let i = 0; i < 12; i++) b.check(toolUseEvent('Read')); // 73 total
  ok(b.getMetrics().zone === 'RED', '73 tool calls → RED (90%+ of 80)');

  // 80+ calls (100%) → FUSE
  for (let i = 0; i < 8; i++) b.check(toolUseEvent('Read')); // 81 total
  const m = b.getMetrics();
  ok(m.zone === 'FUSE', `80+ tool calls → FUSE (got ${m.zone})`);
  ok(m.tool_calls >= 80, `tool_calls >= 80 (got ${m.tool_calls})`);
}

// ---------------------------------------------------------------------------
section('9. Token limit: large assistant content → transitions');
{
  let fakeNow = 0;
  // Tight token limit so we can trigger it without huge strings
  const b = createBudget(
    { max_duration_ms: 99999999, max_tool_calls: 99999, max_output_tokens: 100 },
    { nowFn: () => fakeNow }
  );

  // Feed ~75 estimated tokens (57 words * 1.3 ≈ 74) → should hit YELLOW
  // 57 words to get ~74 estimated tokens
  const words57 = Array.from({ length: 57 }, (_, i) => `word${i}`).join(' ');
  b.check(assistantEvent(words57));
  const m1 = b.getMetrics();
  ok(m1.zone === 'YELLOW' || m1.zone === 'RED' || m1.zone === 'FUSE',
    `large token event crosses YELLOW threshold (zone=${m1.zone})`);

  // Feed more to reach RED (90 tokens of 100)
  const words100 = Array.from({ length: 20 }, (_, i) => `extra${i}`).join(' ');
  b.check(assistantEvent(words100));
  const m2 = b.getMetrics();
  ok(m2.zone === 'RED' || m2.zone === 'FUSE',
    `additional tokens cross RED threshold (zone=${m2.zone})`);
}

// ---------------------------------------------------------------------------
section('10. reset() clears all counters, zone back to GREEN');
{
  let fakeNow = 0;
  const b = createBudget({ max_duration_ms: 1000 }, { nowFn: () => fakeNow });

  // Drive to FUSE
  fakeNow = 1200;
  b.check(toolUseEvent('Read'));
  ok(b.getMetrics().zone === 'FUSE', 'pre-reset: zone=FUSE');

  // Reset with new limits
  fakeNow = 2000;
  b.reset({ max_duration_ms: 5000, max_tool_calls: 50 });
  const m = b.getMetrics();
  ok(m.zone === 'GREEN', 'post-reset: zone=GREEN');
  ok(m.tool_calls === 0, 'post-reset: tool_calls=0');
  ok(m.estimated_tokens === 0, 'post-reset: estimated_tokens=0');
  ok(m.pct_tools === 0, 'post-reset: pct_tools=0');

  // Verify new limits are active: 50 tool calls = 100% of new limit → FUSE
  for (let i = 0; i < 51; i++) b.check(toolUseEvent('Write'));
  ok(b.getMetrics().zone === 'FUSE', 'post-reset with new limits: 51 tools → FUSE at limit=50');
}

// ---------------------------------------------------------------------------
section('11. wrapUpMessage() and fuseMessage() return non-empty strings');
{
  const b = createBudget();
  const wm = b.wrapUpMessage();
  ok(typeof wm === 'string' && wm.length > 10, `wrapUpMessage is non-empty string (len=${wm.length})`);
  ok(wm.includes('90%') || wm.toLowerCase().includes('budget'),
    'wrapUpMessage mentions budget or 90%');

  const fm = b.fuseMessage();
  ok(typeof fm === 'string' && fm.length > 10, `fuseMessage is non-empty string (len=${fm.length})`);
  ok(fm.toLowerCase().includes('budget') || fm.toLowerCase().includes('save'),
    'fuseMessage mentions budget or save');
}

// ---------------------------------------------------------------------------
section('12. getMetrics() returns all expected fields');
{
  const b = createBudget();
  const m = b.getMetrics();
  const requiredFields = [
    'zone', 'elapsed_ms', 'tool_calls', 'estimated_tokens',
    'pct_duration', 'pct_tools', 'pct_tokens',
  ];
  for (const field of requiredFields) {
    ok(field in m, `getMetrics() has field: ${field}`);
  }
}

// ---------------------------------------------------------------------------
section('13. check() return value has zone, action, metrics fields');
{
  const b = createBudget();
  const r = b.check(assistantEvent('test'));
  ok('zone' in r, 'check() result has .zone');
  ok('action' in r, 'check() result has .action');
  ok('metrics' in r, 'check() result has .metrics');
  ok(typeof r.metrics === 'object', '.metrics is an object');
}

// ---------------------------------------------------------------------------
section('14. Zone one-way: never goes backward');
{
  let fakeNow = 0;
  const b = createBudget({ max_duration_ms: 1000 }, { nowFn: () => fakeNow });

  // Advance to RED
  fakeNow = 910;
  b.check({});
  ok(b.getMetrics().zone === 'RED', 'zone=RED at 91%');

  // Go back in time (shouldn't happen in prod, but zone must not go back)
  fakeNow = 100;
  const r = b.check({});
  ok(r.zone === 'RED', 'zone stays RED even if clock appears to go back');
}

// ---------------------------------------------------------------------------
section('15. No side effects: pure module (smoke check)');
{
  // Verify harness-budget.cjs doesn't import fs / child_process / cairn-log
  // by checking the module loaded without any file writes and HOME is still sandbox
  ok(process.env.HOME === _tmpDir, 'HOME is still the sandbox dir');
  ok(!fs.existsSync(path.join(_tmpDir, '.cairn', 'cairn.db')),
    'no DB file created by budget module');
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------
process.stdout.write(`\n${'='.repeat(64)}\n`);
process.stdout.write(`Total: ${asserts} assertions, ${fails} failures\n`);

if (failures.length > 0) {
  process.stdout.write('\nFailed assertions:\n');
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
}

process.stdout.write('='.repeat(64) + '\n');

if (fails > 0) {
  process.exitCode = 1;
} else {
  process.stdout.write('ALL PASS\n');
}
