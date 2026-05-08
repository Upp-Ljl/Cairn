// Real Agent Presence v2 — live smoke.
//
// Asserts: opening two workspaces against the SAME cairnRoot/cwd
// produces TWO distinct session-level agent_ids in the processes
// table, with capability tags carrying enough metadata for the
// desktop panel to attribute them to a project.
//
// Pre-v2 the two workspaces would have collapsed into one row
// (deterministic sha1 of host:gitRoot). v2 says they MUST NOT.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Need built dist for both daemon and mcp-server.
const distMcp    = path.join(__dirname, '..', 'dist');
const distDaemon = path.join(__dirname, '..', '..', 'daemon', 'dist');
const { openWorkspace } = require(path.join(distMcp,    'workspace.js'));
const { startPresence } = require(path.join(distMcp,    'presence.js'));
const { listProcesses } = require(path.join(distDaemon, 'storage', 'repositories', 'processes.js'));

const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-v2-twosess-'));

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// Two workspaces sharing cwd + cairnRoot → must produce DIFFERENT
// agent_ids. We open against the same cairnRoot so they share the
// SAME sqlite DB (the realistic multi-terminal scenario).
const ws1 = openWorkspace({ cairnRoot });
const ws2 = openWorkspace({ cairnRoot, cwd: ws1.cwd });

check(ws1.agentId !== ws2.agentId,
  `1.distinct agentIds expected, got ws1=${ws1.agentId} ws2=${ws2.agentId}`);
check(/^cairn-session-[0-9a-f]{12}$/.test(ws1.agentId),
  `1.ws1 format: ${ws1.agentId}`);
check(/^cairn-session-[0-9a-f]{12}$/.test(ws2.agentId),
  `1.ws2 format: ${ws2.agentId}`);
check(ws1.gitRoot === ws2.gitRoot,
  `2.same cwd → same gitRoot, got ${ws1.gitRoot} vs ${ws2.gitRoot}`);

// Boot presence on both (same DB).
const h1 = startPresence(ws1, { installBeforeExitHandler: false });
const h2 = startPresence(ws2, { installBeforeExitHandler: false });

try {
  // Both rows must exist and be distinct.
  const rows = listProcesses(ws1.db, { statuses: ['ACTIVE','IDLE','DEAD'] });
  const ours = rows.filter(r =>
    r.agent_id === ws1.agentId || r.agent_id === ws2.agentId);
  check(ours.length === 2, `3.processes table has 2 rows for our two sessions, got ${ours.length}`);

  // Each row's capabilities should include the required attribution
  // tags. Tag set is unordered; check via includes().
  const need = (caps, prefix) =>
    Array.isArray(caps) && caps.some(c => typeof c === 'string' && c.startsWith(prefix + ':'));

  for (const r of ours) {
    check(need(r.capabilities, 'client'),    `4.row ${r.agent_id}: missing client tag`);
    check(need(r.capabilities, 'cwd'),       `4.row ${r.agent_id}: missing cwd tag`);
    check(need(r.capabilities, 'git_root'),  `4.row ${r.agent_id}: missing git_root tag`);
    check(need(r.capabilities, 'pid'),       `4.row ${r.agent_id}: missing pid tag`);
    check(need(r.capabilities, 'host'),      `4.row ${r.agent_id}: missing host tag`);
    check(need(r.capabilities, 'session'),   `4.row ${r.agent_id}: missing session tag`);

    const sess = r.capabilities.find(c => c.startsWith('session:'));
    const expectedAgent = r.agent_id;
    const expectedSuffix = expectedAgent.replace('cairn-session-', '');
    check(sess === `session:${expectedSuffix}`,
      `4.row ${r.agent_id}: session tag mismatch (got ${sess})`);

    const host = r.capabilities.find(c => c.startsWith('host:'));
    check(host === `host:${hostname()}`,
      `4.row ${r.agent_id}: host tag mismatch (got ${host})`);
  }

  // Both rows must point at the same git_root (same project) but with
  // distinct PIDs and session ids.
  const gitRoots = new Set(ours.map(r =>
    r.capabilities.find(c => c.startsWith('git_root:'))));
  check(gitRoots.size === 1,
    `5.both sessions should share git_root tag, got ${[...gitRoots].join(' / ')}`);

  const sessionTags = new Set(ours.map(r =>
    r.capabilities.find(c => c.startsWith('session:'))));
  check(sessionTags.size === 2,
    `5.session tags must differ between rows, got ${[...sessionTags].join(' / ')}`);
} finally {
  h1.stop();
  h2.stop();
  ws1.db.close();
  ws2.db.close();
  rmSync(cairnRoot, { recursive: true, force: true });
}

if (failures.length) {
  console.error('SMOKE FAIL:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('SMOKE OK — two-sessions presence v2:');
console.log(`  - 2 openWorkspace() in same cwd → 2 distinct agent_ids`);
console.log(`  - capability tags present: client / cwd / git_root / pid / host / session`);
console.log(`  - shared git_root, distinct session ids — exactly the multi-terminal shape`);
