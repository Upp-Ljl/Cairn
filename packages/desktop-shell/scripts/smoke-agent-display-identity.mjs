#!/usr/bin/env node
/**
 * Smoke for the Agent Display Identity layer (UI hardening).
 *
 * Exercises:
 *   - APP_LABEL / APP_SOURCE_SENTENCE / HUMAN_STATE_LABEL /
 *     ATTRIBUTION_LABEL: every documented value mapped
 *   - decorateActivity: display_label / short_label / source_label /
 *     state_explanation / confidence_label / attribution_label all
 *     populated
 *   - numberActivitiesByApp: stable per-app numbering, sorted by
 *     started_at then session_id
 *   - decorateActivities (called inside buildProjectActivities):
 *     end-to-end on a project with mixed MCP / Claude / Codex
 *   - Privacy: primary display labels never contain raw session_id
 *     / pid / agent_id (those stay in detail)
 *
 * Read-only invariants: source-level grep on agent-activity.cjs.
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

const activity = require(path.join(root, 'agent-activity.cjs'));
const claudeAdapter = require(path.join(root, 'agent-adapters', 'claude-code-session-scan.cjs'));
const codexAdapter  = require(path.join(root, 'agent-adapters', 'codex-session-log-scan.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(cond, label) {
  asserts++;
  if (cond) console.log(`  ok    ${label}`);
  else { fails++; failures.push(label); console.log(`  FAIL  ${label}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn = safeMtime(realCairnDb);

// ---------------------------------------------------------------------------
// Part A — label dictionaries cover every state value
// ---------------------------------------------------------------------------

console.log('==> Part A: label dictionaries');

eq(activity.APP_LABEL.mcp,           'Cairn MCP',  'app label: mcp');
eq(activity.APP_LABEL['claude-code'], 'Claude Code', 'app label: claude-code');
eq(activity.APP_LABEL.codex,         'Codex',       'app label: codex');

eq(activity.APP_SOURCE_KIND.mcp,           'mcp',     'source_kind: mcp');
eq(activity.APP_SOURCE_KIND['claude-code'], 'native', 'source_kind: claude-code');
eq(activity.APP_SOURCE_KIND.codex,         'adapter', 'source_kind: codex');

ok(activity.APP_SOURCE_SENTENCE.mcp.indexOf('Cairn MCP') >= 0,
   'source sentence: mcp mentions Cairn MCP');
ok(activity.APP_SOURCE_SENTENCE['claude-code'].indexOf('session file') >= 0,
   'source sentence: claude mentions session file');
ok(activity.APP_SOURCE_SENTENCE.codex.indexOf('session log') >= 0,
   'source sentence: codex mentions session log');

eq(activity.HUMAN_STATE_LABEL.active, 'Working',   'human state: active → Working');
eq(activity.HUMAN_STATE_LABEL.busy,   'Working',   'human state: busy → Working');
eq(activity.HUMAN_STATE_LABEL.idle,   'Ready',     'human state: idle → Ready');
eq(activity.HUMAN_STATE_LABEL.recent, 'Recent',    'human state: recent → Recent');
eq(activity.HUMAN_STATE_LABEL.inactive, 'Inactive', 'human state: inactive → Inactive');
eq(activity.HUMAN_STATE_LABEL.stale,  'Stale',     'human state: stale → Stale');
eq(activity.HUMAN_STATE_LABEL.dead,   'Dead',      'human state: dead → Dead');
eq(activity.HUMAN_STATE_LABEL.unknown, 'Unknown',  'human state: unknown → Unknown');

eq(activity.ATTRIBUTION_LABEL.capability, 'reported by Cairn MCP',
   'attribution label: capability');
eq(activity.ATTRIBUTION_LABEL.hint,       'manually assigned',
   'attribution label: hint');
eq(activity.ATTRIBUTION_LABEL.cwd,        'matched by project folder',
   'attribution label: cwd');

// ---------------------------------------------------------------------------
// Part B — decorateActivity on hand-crafted rows
// ---------------------------------------------------------------------------

console.log('\n==> Part B: decorateActivity');

const mcpRow = {
  id: 'mcp:cairn-session-aaaa12345678',
  app: 'mcp',
  state: 'active',
  state_family: 'live',
  display_name: 'cairn-session-aaaa12345678',
  session_id: 'aaaa12345678',
  agent_id: 'cairn-session-aaaa12345678',
  pid: 12345,
  attribution: 'capability',
  confidence: 'high',
  source: 'mcp/processes',
  detail: { registered_at: 1700000000000, agent_type: 'mcp-server' },
};
activity.decorateActivity(mcpRow, 1);
eq(mcpRow.display_label, 'Cairn MCP · Runner', 'mcp #1: display_label');
eq(mcpRow.short_label, 'MCP 1', 'mcp #1: short_label');
eq(mcpRow.app_label, 'Cairn MCP', 'mcp: app_label');
eq(mcpRow.seat_label, 'Runner', 'mcp #1: seat_label');
eq(mcpRow.source_kind, 'mcp', 'mcp: source_kind');
ok(mcpRow.source_label.indexOf('Cairn MCP heartbeat') >= 0,
   'mcp: source_label mentions heartbeat');
eq(mcpRow.confidence_label, 'high', 'mcp: confidence_label');
eq(mcpRow.human_state_label, 'Working', 'mcp ACTIVE: human_state_label = Working');
eq(mcpRow.attribution_label, 'reported by Cairn MCP', 'mcp: attribution_label');
ok(mcpRow.state_explanation.indexOf('heartbeat') >= 0,
   'mcp ACTIVE: state_explanation mentions heartbeat');
// Privacy: display surface must not contain raw agent_id / session_id.
ok(mcpRow.display_label.indexOf('aaaa12345678') === -1,
   'mcp display_label has no session_id substring');
ok(mcpRow.short_label.indexOf('aaaa') === -1,
   'mcp short_label has no session_id substring');

// MCP #2 → Runner 2
const mcpRow2 = Object.assign({}, mcpRow, { id: 'mcp:other' });
activity.decorateActivity(mcpRow2, 2);
eq(mcpRow2.display_label, 'Cairn MCP · Runner 2', 'mcp #2: Runner 2');
eq(mcpRow2.short_label, 'MCP 2', 'mcp #2: short_label = MCP 2');

// Claude row.
const claudeRow = {
  id: 'claude:7f5bf59f-busy',
  app: 'claude-code',
  state: 'busy',
  state_family: 'live',
  display_name: 'claude:7f5bf59f',
  session_id: '7f5bf59f-aaaa-bbbb',
  pid: 11224,
  attribution: 'cwd',
  confidence: 'medium-high',
  source: 'claude-code/session-file',
  detail: { started_at: 1700000010000, raw_status: 'busy' },
};
activity.decorateActivity(claudeRow, 1);
eq(claudeRow.display_label, 'Claude Code · Terminal 1', 'claude #1: display_label');
eq(claudeRow.short_label,   'Claude 1', 'claude #1: short_label');
eq(claudeRow.human_state_label, 'Working', 'claude busy → Working');
eq(claudeRow.attribution_label, 'matched by project folder', 'claude cwd attribution');
ok(claudeRow.source_label.indexOf('session file') >= 0,
   'claude source_label mentions session file');
ok(claudeRow.display_label.indexOf('7f5bf59f') === -1,
   'claude display_label has no session_id');

// Claude idle = Ready (NOT Working).
const claudeIdle = Object.assign({}, claudeRow, { id: 'claude:idle', state: 'idle' });
activity.decorateActivity(claudeIdle, 2);
eq(claudeIdle.human_state_label, 'Ready', 'claude idle → Ready (NOT Working)');
eq(claudeIdle.short_label, 'Claude 2', 'claude #2 numbering');
eq(claudeIdle.display_label, 'Claude Code · Terminal 2', 'claude #2: Terminal 2');

// Codex row.
const codexRow = {
  id: 'codex:019e0a97',
  app: 'codex',
  state: 'recent',
  state_family: 'recent',
  display_name: 'codex:019e0a97',
  session_id: '019e0a97-aaaa',
  pid: null,
  attribution: 'cwd',
  confidence: 'medium',
  source: 'codex/session-log',
  detail: { originator: 'Codex Desktop', started_at: 1700000020000 },
};
activity.decorateActivity(codexRow, 1);
eq(codexRow.display_label, 'Codex · Terminal 1', 'codex #1: display_label');
eq(codexRow.short_label,   'Codex 1', 'codex #1: short_label');
eq(codexRow.human_state_label, 'Recent', 'codex recent → Recent');
ok(codexRow.source_label.indexOf('session log') >= 0,
   'codex source_label mentions session log');
ok(codexRow.display_label.indexOf('019e') === -1,
   'codex display_label has no session_id');

// Unassigned (attribution = null) → "unassigned" label.
const orphanRow = Object.assign({}, claudeRow,
  { id: 'claude:orphan', attribution: null });
activity.decorateActivity(orphanRow, 1);
eq(orphanRow.attribution_label, 'unassigned', 'no attribution → "unassigned"');

// Stale heartbeat MCP.
const staleMcp = Object.assign({}, mcpRow,
  { id: 'mcp:stale', state: 'stale' });
activity.decorateActivity(staleMcp, 1);
eq(staleMcp.human_state_label, 'Stale', 'mcp stale → Stale');
ok(staleMcp.state_explanation.indexOf('heartbeat is older') >= 0,
   'stale state_explanation mentions heartbeat TTL');

// ---------------------------------------------------------------------------
// Part C — numberActivitiesByApp stable sort
// ---------------------------------------------------------------------------

console.log('\n==> Part C: stable per-app numbering');

const list = [
  { id: 'a3', app: 'claude-code', session_id: 'sid-c', detail: { started_at: 30 } },
  { id: 'a1', app: 'claude-code', session_id: 'sid-a', detail: { started_at: 10 } },
  { id: 'a2', app: 'claude-code', session_id: 'sid-b', detail: { started_at: 20 } },
  { id: 'b1', app: 'codex',       session_id: 'cdx-a', detail: { started_at: 5  } },
  { id: 'b2', app: 'codex',       session_id: 'cdx-b', detail: { started_at: 15 } },
  { id: 'm1', app: 'mcp',         session_id: 'mcp-a', detail: { registered_at: 100 } },
];
const numbers = activity.numberActivitiesByApp(list);
eq(numbers.get('a1'), 1, 'claude oldest → 1');
eq(numbers.get('a2'), 2, 'claude middle → 2');
eq(numbers.get('a3'), 3, 'claude newest → 3');
eq(numbers.get('b1'), 1, 'codex oldest → 1');
eq(numbers.get('b2'), 2, 'codex newest → 2');
eq(numbers.get('m1'), 1, 'mcp solo → 1');

// Stability: same input twice → same numbering.
const numbers2 = activity.numberActivitiesByApp(list.slice().reverse());
for (const id of ['a1', 'a2', 'a3', 'b1', 'b2', 'm1']) {
  eq(numbers2.get(id), numbers.get(id),
     `numbering stable across input order — ${id}`);
}

// Tied timestamps fall back to session_id ASCII order.
const tied = [
  { id: 't1', app: 'codex', session_id: 'zzz', detail: { started_at: 100 } },
  { id: 't2', app: 'codex', session_id: 'aaa', detail: { started_at: 100 } },
];
const tn = activity.numberActivitiesByApp(tied);
eq(tn.get('t2'), 1, 'tied timestamps → ASCII order: aaa first');
eq(tn.get('t1'), 2, 'tied timestamps → ASCII order: zzz second');

// ---------------------------------------------------------------------------
// Part D — buildProjectActivities decorates end-to-end
// ---------------------------------------------------------------------------

console.log('\n==> Part D: end-to-end decoration via buildProjectActivities');

const isWin = process.platform === 'win32';
const projInside = isWin ? 'C:\\fake\\projects\\alpha' : '/fake/projects/alpha';
const project = { id: 'p_aaaa', project_root: projInside, agent_id_hints: [] };

const FRESH = Date.now() - 5_000;
const claudeRows = [
  { source: 'claude-code/session-file', confidence: 'medium-high',
    pid: 100, session_id: 'cl-1', cwd: projInside, status: 'busy',
    started_at: FRESH - 60_000, updated_at: FRESH, age_ms: 5000 },
  { source: 'claude-code/session-file', confidence: 'medium-high',
    pid: 200, session_id: 'cl-2', cwd: projInside, status: 'idle',
    started_at: FRESH - 30_000, updated_at: FRESH, age_ms: 5000 },
];
const codexRows = [
  { source: 'codex/session-log', confidence: 'medium',
    pid: null, session_id: 'cx-1', cwd: projInside, status: 'recent',
    originator: 'Codex Desktop', version: '0.129.0',
    started_at: FRESH - 90_000, updated_at: FRESH, age_ms: 5000 },
];
const mcpRows = [
  { agent_id: 'cairn-session-aaaa', agent_type: 'mcp-server', status: 'ACTIVE',
    computed_state: 'ACTIVE', last_heartbeat: FRESH, heartbeat_ttl: 60_000,
    registered_at: FRESH - 120_000,
    capabilities: [`cwd:${projInside}`, `git_root:${projInside}`, 'pid:99', 'session:aaaa'],
    owns_tasks: { RUNNING: 1, BLOCKED: 0, WAITING_REVIEW: 0, DONE: 0, FAILED: 0 },
    _attribution: 'capability' },
];

const built = activity.buildProjectActivities(
  project, mcpRows, claudeRows, codexRows,
  { claude: claudeAdapter, codex: codexAdapter },
);

// Every activity must carry display fields after build.
ok(built.activities.every(a => a.display_label && a.short_label && a.source_label),
   'every activity has display_label / short_label / source_label');
ok(built.activities.every(a => a.human_state_label && a.attribution_label),
   'every activity has human_state_label + attribution_label');
ok(built.activities.every(a => a.confidence_label),
   'every activity has confidence_label');

// MCP gets "Runner", claude/codex get "Terminal".
const builtMcp = built.activities.find(a => a.app === 'mcp');
const builtClaude1 = built.activities.find(a => a.app === 'claude-code' && a.short_label === 'Claude 1');
const builtClaude2 = built.activities.find(a => a.app === 'claude-code' && a.short_label === 'Claude 2');
const builtCodex   = built.activities.find(a => a.app === 'codex');
ok(builtMcp && builtMcp.display_label === 'Cairn MCP · Runner', 'built mcp: Runner');
ok(builtClaude1 && /Terminal 1/.test(builtClaude1.display_label),
   'built claude #1: Terminal 1');
ok(builtClaude2 && /Terminal 2/.test(builtClaude2.display_label),
   'built claude #2: Terminal 2');
ok(builtCodex && builtCodex.display_label === 'Codex · Terminal 1',
   'built codex: Terminal 1');

// Privacy: no raw session id appears in any display surface.
for (const a of built.activities) {
  const surface = a.display_label + ' ' + a.short_label + ' ' + a.app_label
                + ' ' + a.seat_label + ' ' + a.source_label
                + ' ' + a.human_state_label + ' ' + a.state_explanation
                + ' ' + a.attribution_label;
  ok(surface.indexOf('cairn-session-aaaa') === -1,
     `${a.short_label}: display surface has no MCP agent_id`);
  ok(surface.indexOf('cl-1') === -1 && surface.indexOf('cl-2') === -1,
     `${a.short_label}: display surface has no Claude session id`);
  ok(surface.indexOf('cx-1') === -1,
     `${a.short_label}: display surface has no Codex session id`);
}

// Idle Claude → Ready (per the rule that pid-alive idle ≠ Working).
ok(builtClaude2 && builtClaude2.human_state_label === 'Ready',
   'claude idle session → human_state_label = Ready');

// ---------------------------------------------------------------------------
// Part F — session-name scratchpad lookup (A3 session-naming)
// ---------------------------------------------------------------------------
//
// When scratchpad has session_name/<agent_id>, activityFromMcpRow should
// use that name instead of the hex-truncated agent_id fallback.
// We stub the db lookup by passing a minimal fake `db` in opts.

console.log('\n==> Part F: session-name scratchpad lookup');

// Build a minimal fake db that answers a single scratchpad SELECT.
const NAMED_AGENT_ID = 'cairn-session-named0001';
const NAMED_SESSION_NAME = 'ship Phase 8 §8 Rule C';
const namedScratchKey = `session_name/${NAMED_AGENT_ID}`;
const namedScratchValue = JSON.stringify({ name: NAMED_SESSION_NAME, set_at: Date.now(), set_by: 'agent' });

function makeFakeDb(keyToReturn, valueJson) {
  return {
    prepare(sql) {
      return {
        get(key) {
          if (key === keyToReturn) return { value_json: valueJson };
          return undefined;
        }
      };
    }
  };
}

const fakeDb = makeFakeDb(namedScratchKey, namedScratchValue);

// Construct a minimal MCP row for the named agent.
const namedMcpRow = {
  agent_id: NAMED_AGENT_ID,
  agent_type: 'mcp-server',
  status: 'ACTIVE',
  computed_state: 'ACTIVE',
  last_heartbeat: Date.now() - 1000,
  heartbeat_ttl: 60000,
  registered_at: Date.now() - 5000,
  capabilities: [`cwd:/fake/project`, `git_root:/fake/project`, `pid:9999`, `session:named0001`],
  owns_tasks: null,
};

const namedActivity = activity.activityFromMcpRow(namedMcpRow, null, { attribution: null, db: fakeDb });

// display_name must be the human name, not the hex id.
eq(namedActivity.display_name, NAMED_SESSION_NAME,
   'session-name: display_name uses scratchpad name when set');
ok(namedActivity.display_name.indexOf('named0001') === -1,
   'session-name: display_name has no hex agent_id fragment');

// Fallback: no db passed → hex truncation as before.
const fallbackActivity = activity.activityFromMcpRow(namedMcpRow, null, { attribution: null });
ok(fallbackActivity.display_name !== NAMED_SESSION_NAME,
   'session-name fallback: display_name is NOT human name when no db passed');
// NAMED_AGENT_ID = 'cairn-session-named0001' (23 chars) → truncated to 18: 'cairn-session-name'
ok(fallbackActivity.display_name.startsWith('cairn-session-name'),
   'session-name fallback: display_name is hex-based (backward compat)');

// Also verify: when db has no matching key, fallback applies.
const emptyDb = makeFakeDb('__no_match__', null);
const noKeyActivity = activity.activityFromMcpRow(namedMcpRow, null, { attribution: null, db: emptyDb });
ok(noKeyActivity.display_name !== NAMED_SESSION_NAME,
   'session-name: display_name falls back when key absent in db');

// deriveDisplayName exported function.
ok(typeof activity.deriveDisplayName === 'function',
   'deriveDisplayName is exported');
eq(activity.deriveDisplayName(fakeDb, NAMED_AGENT_ID), NAMED_SESSION_NAME,
   'deriveDisplayName returns name from scratchpad');
eq(activity.deriveDisplayName(null, NAMED_AGENT_ID), null,
   'deriveDisplayName returns null when db is null');
eq(activity.deriveDisplayName(fakeDb, 'unknown-agent'), null,
   'deriveDisplayName returns null when key absent');

// SESSION_NAME_KEY_PREFIX exported.
ok(typeof activity.SESSION_NAME_KEY_PREFIX === 'string' &&
   activity.SESSION_NAME_KEY_PREFIX === 'session_name/',
   'SESSION_NAME_KEY_PREFIX exported and correct');

// ---------------------------------------------------------------------------
// Part E — read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part E: read-only invariants');

const afterCairn = safeMtime(realCairnDb);
if (beforeCairn != null) eq(afterCairn, beforeCairn, 'cairn.db mtime unchanged');

const src = fs.readFileSync(path.join(root, 'agent-activity.cjs'), 'utf8');
ok(!/\.run\s*\(/.test(src),     'agent-activity.cjs: no .run(');
ok(!/\.exec\s*\(/.test(src),    'agent-activity.cjs: no .exec(');
ok(!/writeFileSync|writeFile\b|appendFile/.test(src),
   'agent-activity.cjs: no file writes');
ok(!/['"]\.claude['"]/.test(src), 'agent-activity.cjs: no ".claude" literal');
ok(!/['"]\.codex['"]/.test(src),  'agent-activity.cjs: no ".codex" literal');

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
