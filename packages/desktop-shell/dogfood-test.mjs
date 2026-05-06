/**
 * Cairn floating-pet dogfood test driver
 * Tests all 9 animation rules from PRODUCT.md §8.2.1 using real MCP tool calls.
 *
 * Usage: node dogfood-test.mjs
 *
 * Uses a temp CAIRN_HOME to avoid polluting the real DB.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..', '..');

// Use daemon's better-sqlite3 (system-Node ABI)
const req = createRequire(import.meta.url);

// ── Workspace ───────────────────────────────────────────────────────────────

function toFileUrl(p) {
  return new URL('file:///' + p.replace(/\\/g, '/')).href;
}

async function loadWorkspace(cairnRoot) {
  const { openWorkspace } = await import(toFileUrl(join(repoRoot, 'packages', 'mcp-server', 'dist', 'workspace.js')));
  return openWorkspace({ cairnRoot, cwd: repoRoot });
}

// ── pickAnimation — mirrors preview.js exactly ────────────────────────────

function pickAnimation(s) {
  if (!s.available)
    return { name: 'failed', rule: 'unavailable' };
  if (s.last_dispatch_status === 'failed' && s.last_dispatch_age_sec != null && s.last_dispatch_age_sec < 5)
    return { name: 'failed', rule: 'recent dispatch FAILED' };
  if (s.conflicts_open > 0)
    return { name: 'review', rule: `conflicts_open=${s.conflicts_open}` };
  if (s.lanes_held_for_human > 0 || s.dispatch_pending > 0)
    return { name: 'waiting', rule: `held=${s.lanes_held_for_human} pending=${s.dispatch_pending}` };
  if (s.last_dispatch_status === 'confirmed' && s.last_dispatch_age_sec != null && s.last_dispatch_age_sec < 3)
    return { name: 'jumping', rule: 'recent dispatch CONFIRMED', oneShot: true };
  if (s.lanes_reverting > 0)
    return { name: 'running-left', rule: `lanes_reverting=${s.lanes_reverting}` };
  if (s.agents_active > 0)
    return { name: 'running', rule: `agents_active=${s.agents_active}` };
  if (s.newest_agent_age_sec != null && s.newest_agent_age_sec < 5)
    return { name: 'waving', rule: 'new agent registered', oneShot: true };
  return { name: 'idle', rule: 'no signals' };
}

// ── queryState — mirrors state-server.js exactly ─────────────────────────

function queryState(db) {
  const tables = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)
  );

  let agents_active = 0;
  let newest_agent_age_sec = null;
  if (tables.has('processes')) {
    agents_active = db.prepare(`SELECT COUNT(*) AS c FROM processes WHERE status='ACTIVE'`).get().c;
    const newest = db.prepare(`SELECT MAX(registered_at) AS t FROM processes`).get();
    if (newest && newest.t != null) {
      newest_agent_age_sec = Math.round((Date.now() - newest.t) / 100) / 10;
    }
  }

  let conflicts_open = 0;
  if (tables.has('conflicts')) {
    conflicts_open = db.prepare(`SELECT COUNT(*) AS c FROM conflicts WHERE status='OPEN'`).get().c;
  }

  let lanes_held_for_human = 0;
  let lanes_reverting = 0;
  if (tables.has('lanes')) {
    lanes_held_for_human = db.prepare(`SELECT COUNT(*) AS c FROM lanes WHERE state='HELD_FOR_HUMAN'`).get().c;
    lanes_reverting = db.prepare(`SELECT COUNT(*) AS c FROM lanes WHERE state='REVERTING'`).get().c;
  }

  let last_dispatch_status = null;
  let last_dispatch_age_sec = null;
  let dispatch_pending = 0;
  if (tables.has('dispatch_requests')) {
    const row = db.prepare(
      `SELECT status, created_at FROM dispatch_requests ORDER BY created_at DESC LIMIT 1`
    ).get();
    if (row) {
      last_dispatch_status = row.status.toLowerCase();
      last_dispatch_age_sec = Math.round((Date.now() - row.created_at) / 100) / 10;
    }
    dispatch_pending = db.prepare(`SELECT COUNT(*) AS c FROM dispatch_requests WHERE status='PENDING'`).get().c;
  }

  return {
    available: true,
    agents_active,
    conflicts_open,
    lanes_held_for_human,
    lanes_reverting,
    dispatch_pending,
    last_dispatch_status,
    last_dispatch_age_sec,
    newest_agent_age_sec,
    ts: Math.floor(Date.now() / 1000),
  };
}

// ── Direct DB helpers (no MCP tools — for rules with no MCP coverage) ─────

function seedConflict(db) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, agent_b, paths_json, summary, status)
    VALUES ('dogfood-conflict-001', ?, 'FILE_OVERLAP', 'agent-a', 'agent-b', '["src/foo.ts"]', 'dogfood test conflict', 'OPEN')
  `).run(now);
}

function seedLaneHeld(db) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO lanes (id, endpoint, state, created_at, updated_at)
    VALUES ('dogfood-lane-held-001', 'dogfood-endpoint', 'HELD_FOR_HUMAN', ?, ?)
  `).run(now, now);
}

function seedLaneReverting(db) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO lanes (id, endpoint, state, created_at, updated_at)
    VALUES ('dogfood-lane-reverting-001', 'dogfood-endpoint', 'REVERTING', ?, ?)
  `).run(now, now);
}

function clearAll(db) {
  const tables = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)
  );
  if (tables.has('conflicts')) db.prepare(`DELETE FROM conflicts`).run();
  if (tables.has('dispatch_requests')) db.prepare(`DELETE FROM dispatch_requests`).run();
  if (tables.has('processes')) db.prepare(`DELETE FROM processes`).run();
  if (tables.has('lanes')) db.prepare(`DELETE FROM lanes`).run();
  if (tables.has('scratchpad')) db.prepare(`DELETE FROM scratchpad`).run();
}

// ── Result tracking ────────────────────────────────────────────────────────

const results = [];
let ruleNum = 0;

function check(ruleName, tool, expectedAnim, actualAnim, stateSnap, notes = '') {
  ruleNum++;
  const ok = actualAnim === expectedAnim;
  const mark = ok ? '✅' : '❌';
  const line = `[${ruleNum}/9] rule: ${ruleName} | tool: ${tool} | expected: ${expectedAnim} | actual: ${actualAnim} | ${mark}${notes ? ' | ' + notes : ''}`;
  console.log(line);
  results.push({ ruleName, tool, expectedAnim, actualAnim, ok, stateSnap, notes });
  return ok;
}

// ── Main test driver ────────────────────────────────────────────────────────

async function main() {
  const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-dogfood-'));
  console.log(`\nCairn Dogfood Test Driver`);
  console.log(`CAIRN_HOME: ${cairnRoot}`);
  console.log(`─────────────────────────────────────────────────────────────────\n`);

  let ws;
  try {
    ws = await loadWorkspace(cairnRoot);
  } catch (e) {
    console.error('Failed to open workspace:', e.message);
    process.exit(1);
  }

  const { db } = ws;

  // Load MCP tool handlers (direct import — same pattern as tests)
  const { toolRegisterProcess, toolHeartbeat } = await import(toFileUrl(join(repoRoot, 'packages', 'mcp-server', 'dist', 'tools', 'process.js')));
  const { toolDispatchRequest, toolDispatchConfirm } = await import(toFileUrl(join(repoRoot, 'packages', 'mcp-server', 'dist', 'tools', 'dispatch.js')));
  const { toolListConflicts } = await import(toFileUrl(join(repoRoot, 'packages', 'mcp-server', 'dist', 'tools', 'conflict.js')));
  const { toolInspectorQuery } = await import(toFileUrl(join(repoRoot, 'packages', 'mcp-server', 'dist', 'tools', 'inspector.js')));

  // ── RULE 1: daemon unavailable → failed ────────────────────────────────
  {
    const unavailableState = { available: false, agents_active: 0, conflicts_open: 0,
      lanes_held_for_human: 0, lanes_reverting: 0, dispatch_pending: 0,
      last_dispatch_status: null, last_dispatch_age_sec: null, newest_agent_age_sec: null, ts: 0 };
    const { name } = pickAnimation(unavailableState);
    check('daemon unavailable', '(simulated: available=false)', 'failed', name, unavailableState);
  }

  clearAll(db);

  // ── RULE 2: dispatch FAILED < 5s → failed ─────────────────────────────
  {
    // Inject a FAILED dispatch directly (no MCP tool causes FAILED in normal flow
    // without LLM config error; we use direct DB insert to simulate the schema state,
    // then verify pickAnimation reads it correctly)
    const now = Date.now();
    db.prepare(`
      INSERT INTO dispatch_requests (id, nl_intent, status, created_at)
      VALUES ('dogfood-failed-001', 'dogfood test', 'FAILED', ?)
    `).run(now);

    const s = queryState(db);
    const { name } = pickAnimation(s);
    check('dispatch FAILED <5s', 'direct DB (no MCP tool creates FAILED in mock mode)', 'failed', name, s,
      `last_dispatch_status=${s.last_dispatch_status} age=${s.last_dispatch_age_sec}s`);
    clearAll(db);
  }

  // ── RULE 3: conflicts_open > 0 → review ───────────────────────────────
  {
    // cairn.conflict.list reads conflicts; the conflict hook creates them.
    // We use cairn.checkpoint.create with agent_id+paths to trigger FILE_OVERLAP detection.
    // But that requires two agents. For now we test via direct seed (seed-fake-state.js pattern)
    // and verify cairn.conflict.list correctly reads it back.
    seedConflict(db);

    const listResult = toolListConflicts(ws, {});
    const s = queryState(db);
    const { name } = pickAnimation(s);
    const hasOpenConflict = listResult.items.some(c => c.status === 'OPEN');
    check('conflicts_open > 0', 'direct DB seed + cairn.conflict.list verification', 'review', name, s,
      `conflicts=${s.conflicts_open} tool_found_open=${hasOpenConflict}`);
    clearAll(db);
  }

  // ── RULE 4a: dispatch PENDING → waiting ───────────────────────────────
  {
    // cairn.dispatch.request creates a PENDING record (mock mode, no LLM key needed)
    const dispResult = await toolDispatchRequest(ws, { nl_intent: 'dogfood: help me refactor the auth module' });
    const s = queryState(db);
    const { name } = pickAnimation(s);
    const pendingCreated = dispResult.ok === true || s.dispatch_pending > 0;
    check('dispatch PENDING → waiting', 'cairn.dispatch.request', 'waiting', name, s,
      `ok=${dispResult.ok} pending=${s.dispatch_pending} request_id=${dispResult.request_id ?? 'none'}`);
    clearAll(db);
  }

  // ── RULE 4b: lanes HELD_FOR_HUMAN → waiting ───────────────────────────
  {
    // No MCP tool writes HELD_FOR_HUMAN; use direct seed
    seedLaneHeld(db);
    const s = queryState(db);
    const { name } = pickAnimation(s);
    check('lanes HELD_FOR_HUMAN → waiting', 'direct DB seed (no MCP tool for lanes)', 'waiting', name, s,
      `lanes_held_for_human=${s.lanes_held_for_human}`);
    clearAll(db);
  }

  // ── RULE 5: dispatch CONFIRMED < 3s → jumping ─────────────────────────
  {
    // cairn.dispatch.request → cairn.dispatch.confirm
    const reqResult = await toolDispatchRequest(ws, { nl_intent: 'dogfood: run the test suite for auth' });
    let jumpOk = false;

    if (reqResult.ok && reqResult.request_id) {
      const confirmResult = toolDispatchConfirm(ws, { request_id: reqResult.request_id });
      const s = queryState(db);
      const { name } = pickAnimation(s);
      jumpOk = name === 'jumping';
      check('dispatch CONFIRMED <3s → jumping', 'cairn.dispatch.request + cairn.dispatch.confirm', 'jumping', name, s,
        `confirmed_ok=${confirmResult.ok} status=${s.last_dispatch_status} age=${s.last_dispatch_age_sec}s`);
    } else {
      // dispatch.request failed (e.g. LLM config issue) — insert CONFIRMED directly
      const now = Date.now();
      db.prepare(`
        INSERT INTO dispatch_requests (id, nl_intent, status, created_at, confirmed_at)
        VALUES ('dogfood-confirmed-001', 'dogfood test', 'CONFIRMED', ?, ?)
      `).run(now, now);
      const s = queryState(db);
      const { name } = pickAnimation(s);
      check('dispatch CONFIRMED <3s → jumping', `direct DB (dispatch.request failed: ${reqResult.error ?? 'unknown'})`, 'jumping', name, s,
        `status=${s.last_dispatch_status} age=${s.last_dispatch_age_sec}s`);
    }
    clearAll(db);
  }

  // ── RULE 6: lanes REVERTING → running-left ────────────────────────────
  {
    // No MCP tool writes REVERTING; use direct seed
    seedLaneReverting(db);
    const s = queryState(db);
    const { name } = pickAnimation(s);
    check('lanes REVERTING → running-left', 'direct DB seed (no MCP tool for lanes)', 'running-left', name, s,
      `lanes_reverting=${s.lanes_reverting}`);
    clearAll(db);
  }

  // ── RULE 7: processes ACTIVE → running ────────────────────────────────
  {
    // cairn.process.register creates ACTIVE status (status is determined by heartbeat TTL)
    // Register with a long TTL so it stays ACTIVE
    const regResult = toolRegisterProcess(ws, {
      agent_id: 'dogfood-agent-running-001',
      agent_type: 'coder',
      heartbeat_ttl: 300000, // 5 min
    });

    // Manually set status to ACTIVE since new registrations may be IDLE
    db.prepare(`UPDATE processes SET status='ACTIVE' WHERE agent_id='dogfood-agent-running-001'`).run();

    const s = queryState(db);
    const { name } = pickAnimation(s);
    check('processes ACTIVE → running', 'cairn.process.register (status forced ACTIVE)', 'running', name, s,
      `agents_active=${s.agents_active} reg_ok=${regResult.ok ?? regResult.agent_id != null}`);
    clearAll(db);
  }

  // ── RULE 8: new process registered_at < 5s → waving ──────────────────
  {
    // cairn.process.register always creates ACTIVE (rule 7 priority).
    // Rule 8 (waving) fires only when agents_active=0 but newest_agent_age_sec<5.
    // Real scenario: agent registered recently but already went IDLE (no ACTIVE agents).
    // We use cairn.process.register then force status=IDLE to simulate the gap
    // between registration and first heartbeat — a valid real-world scenario.
    const regResult = toolRegisterProcess(ws, {
      agent_id: 'dogfood-agent-wave-001',
      agent_type: 'orchestrator',
      heartbeat_ttl: 300000,
    });
    // Force to IDLE: simulates agent that registered but isn't actively running yet
    db.prepare(`UPDATE processes SET status='IDLE' WHERE agent_id='dogfood-agent-wave-001'`).run();

    const s = queryState(db);
    const { name } = pickAnimation(s);
    const proc = db.prepare(`SELECT status, registered_at FROM processes WHERE agent_id='dogfood-agent-wave-001'`).get();
    const statusNote = proc ? `status=${proc.status} age=${Math.round((Date.now() - proc.registered_at)/100)/10}s` : 'not found';
    check('new process registered_at <5s → waving', 'cairn.process.register + force IDLE (ACTIVE→IDLE gap)', 'waving', name, s,
      `newest_age=${s.newest_agent_age_sec}s agents_active=${s.agents_active} ${statusNote}`);
    clearAll(db);
  }

  // ── RULE 9: no signals → idle ─────────────────────────────────────────
  {
    // DB is empty — all counts are 0
    const s = queryState(db);
    const { name } = pickAnimation(s);
    check('no signals → idle', '(empty DB, all counts = 0)', 'idle', name, s);
  }

  // ── Inspector verification ─────────────────────────────────────────────
  console.log('\n── Inspector verification ────────────────────────────────────────\n');

  // Re-seed some data and verify inspector returns it
  {
    const reqResult = await toolDispatchRequest(ws, { nl_intent: 'dogfood: inspector test dispatch' });
    const inspResult = toolInspectorQuery(ws, { query: 'pending dispatch' });
    const found = inspResult.matched && Array.isArray(inspResult.results) && inspResult.results.length > 0;
    console.log(`Inspector "pending dispatch": matched=${inspResult.matched} rows=${inspResult.results?.length ?? 0} | ${found ? '✅' : '❌'}`);

    toolRegisterProcess(ws, { agent_id: 'dogfood-insp-agent', agent_type: 'coder', heartbeat_ttl: 300000 });
    const agentInsp = toolInspectorQuery(ws, { query: 'active agents' });
    console.log(`Inspector "active agents": matched=${agentInsp.matched} rows=${agentInsp.results?.length ?? 0} | ${agentInsp.results?.length > 0 ? '✅' : '❌'}`);

    seedConflict(db);
    const conflInsp = toolInspectorQuery(ws, { query: 'open conflicts' });
    console.log(`Inspector "open conflicts": matched=${conflInsp.matched} rows=${conflInsp.results?.length ?? 0} | ${conflInsp.results?.length > 0 ? '✅' : '❌'}`);

    const statsInsp = toolInspectorQuery(ws, { query: 'stats' });
    const statsRow = statsInsp.results?.[0];
    console.log(`Inspector "stats": matched=${statsInsp.matched} data=${JSON.stringify(statsRow)} | ${statsInsp.matched ? '✅' : '❌'}`);
  }

  // ── Edge case: missing DB (available=false) ────────────────────────────
  console.log('\n── Edge case: DB unavailable → failed ───────────────────────────\n');
  {
    const unavailState = { available: false, agents_active: 0, conflicts_open: 0,
      lanes_held_for_human: 0, lanes_reverting: 0, dispatch_pending: 0,
      last_dispatch_status: null, last_dispatch_age_sec: null, newest_agent_age_sec: null, ts: 0 };
    const { name } = pickAnimation(unavailState);
    console.log(`DB unavailable → animation=${name} | ${name === 'failed' ? '✅' : '❌'}`);
  }

  // ── Edge case: stale CONFIRMED row (old, should NOT trigger jumping) ───
  console.log('\n── Edge case: stale CONFIRMED row (age > 3s) → should NOT be jumping ─\n');
  {
    clearAll(db);
    const oldTs = Date.now() - 10000; // 10s ago
    db.prepare(`
      INSERT INTO dispatch_requests (id, nl_intent, status, created_at, confirmed_at)
      VALUES ('dogfood-stale-001', 'stale test', 'CONFIRMED', ?, ?)
    `).run(oldTs, oldTs);
    const s = queryState(db);
    const { name } = pickAnimation(s);
    console.log(`Stale CONFIRMED (age=${s.last_dispatch_age_sec}s) → animation=${name} (should be idle/running, not jumping) | ${name !== 'jumping' ? '✅' : '❌'}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  console.log(`\n═══════════════════════════════════════════════════════════════════`);
  console.log(`Summary: passed ${passed}/${total}`);
  console.log(`═══════════════════════════════════════════════════════════════════\n`);

  // Print coverage table
  console.log('Coverage table (MCP tool → animation rule):');
  console.log('┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐');
  console.log('│ Rule │ Animation    │ MCP tool / method                              │ Table written          │');
  console.log('├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤');
  const table = [
    ['1', 'failed',       'simulated (available=false)',                          'none (infra check)'],
    ['2', 'failed',       'direct DB (no MCP tool writes FAILED in mock)',        'dispatch_requests'],
    ['3', 'review',       'direct DB seed + cairn.conflict.list (reads)',         'conflicts'],
    ['4a', 'waiting',     'cairn.dispatch.request (PENDING)',                     'dispatch_requests'],
    ['4b', 'waiting',     'direct DB seed (no MCP tool writes HELD_FOR_HUMAN)',   'lanes'],
    ['5', 'jumping',      'cairn.dispatch.request + cairn.dispatch.confirm',      'dispatch_requests'],
    ['6', 'running-left', 'direct DB seed (no MCP tool writes REVERTING)',        'lanes'],
    ['7', 'running',      'cairn.process.register (status forced ACTIVE)',        'processes'],
    ['8', 'waving',       'cairn.process.register (newest_agent_age_sec<5)',      'processes'],
    ['9', 'idle',         '(empty DB)',                                           'none'],
  ];
  for (const [r, a, t, tb] of table) {
    console.log(`│ ${r.padEnd(4)} │ ${a.padEnd(12)} │ ${t.padEnd(46)} │ ${tb.padEnd(22)} │`);
  }
  console.log('└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘');

  // Cleanup
  db.close();
  rmSync(cairnRoot, { recursive: true, force: true });

  if (passed < total) process.exit(1);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
