import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Use daemon's better-sqlite3 (system-Node ABI); desktop-shell's copy is rebuilt for Electron ABI
const Database = require('../daemon/node_modules/better-sqlite3');

const DB_PATH = join(homedir(), '.cairn', 'cairn.db');
const db = new Database(DB_PATH);
const now = Date.now();

const cmd = process.argv[2];

function requireTable(name) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  if (!row) {
    console.error(`${name} table doesn't exist — has the relevant migration run?`);
    process.exit(1);
  }
}

if (cmd === 'conflict') {
  db.prepare(`
    INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, agent_b, paths_json, summary, status)
    VALUES ('fake-conflict-001', ?, 'FILE_OVERLAP', 'fake-agent-a', 'fake-agent-b', '["README.md"]', '[FAKE-SEED]', 'OPEN')
  `).run(now);
  console.log('inserted fake conflict (id=fake-conflict-001)');

} else if (cmd === 'dispatch-confirmed') {
  db.prepare(`
    INSERT INTO dispatch_requests (id, nl_intent, status, created_at)
    VALUES ('fake-dispatch-confirmed-001', '[FAKE-SEED] confirmed dispatch', 'CONFIRMED', ?)
  `).run(now);
  console.log('inserted fake dispatch CONFIRMED (id=fake-dispatch-confirmed-001)');

} else if (cmd === 'dispatch-failed') {
  db.prepare(`
    INSERT INTO dispatch_requests (id, nl_intent, status, created_at)
    VALUES ('fake-dispatch-failed-001', '[FAKE-SEED] failed dispatch', 'FAILED', ?)
  `).run(now);
  console.log('inserted fake dispatch FAILED (id=fake-dispatch-failed-001)');

} else if (cmd === 'agent-active') {
  db.prepare(`
    INSERT INTO processes (agent_id, agent_type, status, registered_at, last_heartbeat, heartbeat_ttl)
    VALUES ('fake-agent-active-001', 'fake', 'ACTIVE', ?, ?, 60000)
  `).run(now, now);
  console.log('inserted fake process ACTIVE (agent_id=fake-agent-active-001)');

} else if (cmd === 'agent-idle') {
  db.prepare(`
    INSERT INTO processes (agent_id, agent_type, status, registered_at, last_heartbeat, heartbeat_ttl)
    VALUES ('fake-agent-idle-001', 'fake', 'IDLE', ?, ?, 60000)
  `).run(now, now);
  console.log('inserted fake process IDLE (agent_id=fake-agent-idle-001)');

} else if (cmd === 'lane-held') {
  requireTable('lanes');
  db.prepare(`
    INSERT INTO lanes (id, endpoint, state, created_at, updated_at)
    VALUES ('fake-lane-held-001', 'fake-endpoint', 'HELD_FOR_HUMAN', ?, ?)
  `).run(now, now);
  console.log('inserted fake lane HELD_FOR_HUMAN (id=fake-lane-held-001) — triggers: waiting');

} else if (cmd === 'lane-reverting') {
  requireTable('lanes');
  db.prepare(`
    INSERT INTO lanes (id, endpoint, state, created_at, updated_at)
    VALUES ('fake-lane-reverting-001', 'fake-endpoint', 'REVERTING', ?, ?)
  `).run(now, now);
  console.log('inserted fake lane REVERTING (id=fake-lane-reverting-001) — triggers: running-left');

} else if (cmd === 'dispatch-pending') {
  db.prepare(`
    INSERT INTO dispatch_requests (id, nl_intent, status, created_at)
    VALUES ('fake-dispatch-pending-001', '[FAKE-SEED] pending dispatch', 'PENDING', ?)
  `).run(now);
  console.log('inserted fake dispatch PENDING (id=fake-dispatch-pending-001) — triggers: waiting');

} else if (cmd === 'new-agent') {
  db.prepare(`
    INSERT INTO processes (agent_id, agent_type, status, registered_at, last_heartbeat, heartbeat_ttl)
    VALUES ('fake-agent-new-001', 'fake', 'ACTIVE', ?, ?, 60000)
  `).run(now, now);
  console.log('inserted fake process ACTIVE with now registered_at (agent_id=fake-agent-new-001) — triggers: waving ~5s then running');

} else if (cmd === 'clear') {
  db.prepare(`DELETE FROM conflicts`).run();
  db.prepare(`DELETE FROM dispatch_requests`).run();
  db.prepare(`DELETE FROM processes`).run();
  const lanesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='lanes'`).get();
  if (lanesExists) db.prepare(`DELETE FROM lanes`).run();
  console.log('cleared all fake rows from conflicts, dispatch_requests, processes' + (lanesExists ? ', lanes' : ''));

} else {
  console.error('usage: node seed-fake-state.js <conflict|dispatch-confirmed|dispatch-failed|agent-active|agent-idle|lane-held|lane-reverting|dispatch-pending|new-agent|clear>');
  process.exit(1);
}

db.close();
