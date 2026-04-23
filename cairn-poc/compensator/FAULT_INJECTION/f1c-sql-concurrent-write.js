// F1c — Between forward UPDATE and revert, a "third party" writes the same row.
// Revert in POC #3 uses WHERE id=? (no optimistic lock). We check whether
// the revert STOMPS the concurrent write (lost-update) — that's a data-loss bug.
//
// Then we propose a corrected compensator that adds `AND <touched_col>=?` (the forward-applied value)
// so revert is a no-op when someone else already moved the row.
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const POC = path.join(__dirname, '..', '03-postgres-update');

function httpReq(method, u, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const b = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
      method, headers: { 'Content-Type': 'application/json', ...(b ? { 'Content-Length': Buffer.byteLength(b) } : {}) },
    }, (res) => { let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null })); });
    req.on('error', reject);
    if (b) req.write(b);
    req.end();
  });
}
async function waitPort(port) {
  for (let i = 0; i < 50; i++) {
    try { const r = await httpReq('POST', `http://127.0.0.1:${port}/query`, { sql: 'SELECT 1' }); if (r.status === 200) return; }
    catch { await new Promise((r) => setTimeout(r, 80)); }
  }
  throw new Error('no mock');
}

async function main() {
  const mock = spawn('node', [path.join(POC, 'mock-server.js')], { stdio: 'pipe' });
  try {
    await waitPort(4103);

    // Step 1: forward UPDATE users SET email='new@x.com' WHERE id=1 (original: alice@example.com)
    const r = spawnSync('node', [path.join(POC, 'cairn-proxy.js'), 'users', '{"email":"new@x.com"}', '{"id":1}'], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim());
    console.log('proxy ok, lane=', out.laneId);

    // Step 2: a third-party concurrent write STOMPS email AGAIN
    const concurrent = await httpReq('POST', 'http://127.0.0.1:4103/query', {
      sql: 'UPDATE users SET email=?, name=? WHERE id=?',
      params: ['concurrent@x.com', 'ConcurrentName', 1],
    });
    console.log('concurrent write ok:', concurrent.body);

    // Check state
    const mid = await httpReq('POST', 'http://127.0.0.1:4103/query', { sql: 'SELECT * FROM users WHERE id=1', params: [] });
    console.log('state before revert:', mid.body.rows);

    // Step 3: run revert. The compensator will UPDATE ... WHERE id=1 — blindly. This is LOST UPDATE.
    const rev = spawnSync('node', [path.join(POC, 'revert.js'), out.lanePath], { encoding: 'utf8' });
    console.log('revert stdout:\n' + rev.stdout);
    console.log('revert exit:', rev.status);

    // Step 4: final state. Expected SAFE behavior: concurrent value preserved + revert reports conflict.
    // Actual: revert stomped the concurrent write.
    const end = await httpReq('POST', 'http://127.0.0.1:4103/query', { sql: 'SELECT * FROM users WHERE id=1', params: [] });
    const row = end.body.rows[0];
    console.log('FINAL ROW:', row);
    const stomped = row.email === 'alice@example.com' && row.name === 'ConcurrentName';
    //                                                  name was NOT part of the forward SET, so revert left it alone
    const revertedBlindly = row.email === 'alice@example.com';
    const concurrentPreserved = row.email === 'concurrent@x.com';

    console.log(JSON.stringify({
      finalRow: row,
      revertExit: rev.status,
      lostUpdate_concurrentEmailDestroyed: revertedBlindly,
      verdict: revertedBlindly
        ? 'BUG: revert did UPDATE WHERE id=1 blindly; concurrent writer email was silently overwritten. Lost-update. Fix: compensator must add optimistic-lock predicate AND <col>=?forwardValue.'
        : 'concurrent-write preserved (no bug)',
    }, null, 2));

    // --- PART 2: demonstrate a safer compensator with optimistic lock ---
    console.log('\n--- Part 2: safer compensator with optimistic lock ---');
    // rewind seed via direct SQL: make row back to alice@example.com,Alice so we can rerun
    await httpReq('POST', 'http://127.0.0.1:4103/query', { sql: 'UPDATE users SET email=?, name=? WHERE id=?', params: ['alice@example.com', 'Alice', 1] });

    // forward again
    const r2 = spawnSync('node', [path.join(POC, 'cairn-proxy.js'), 'users', '{"email":"new2@x.com"}', '{"id":1}'], { encoding: 'utf8' });
    const out2 = JSON.parse(r2.stdout.trim());
    const lane2 = JSON.parse(fs.readFileSync(out2.lanePath, 'utf8'));

    // concurrent write again
    await httpReq('POST', 'http://127.0.0.1:4103/query', { sql: 'UPDATE users SET email=? WHERE id=?', params: ['rival@x.com', 1] });

    // SAFE compensator: UPDATE users SET email=? WHERE id=? AND email=?forwardValue
    // forwardValue = the value we set in the forward call (new2@x.com)
    const forwardApplied = JSON.parse(lane2.forwardRequest.params[0]
      ? null /*unused*/ : null) // not available; just read from setObj we know
    const forwardEmail = 'new2@x.com'; // matches the forward SET
    const safe = await httpReq('POST', 'http://127.0.0.1:4103/query', {
      sql: 'UPDATE users SET email=? WHERE id=? AND email=?',
      params: ['alice@example.com', 1, forwardEmail],
    });
    console.log('safe compensator changes=', safe.body.changes, '(should be 0 — conflict detected, no stomp)');

    const final2 = await httpReq('POST', 'http://127.0.0.1:4103/query', { sql: 'SELECT * FROM users WHERE id=1', params: [] });
    console.log('FINAL ROW w/ safe compensator:', final2.body.rows[0]);
    const safeOk = safe.body.changes === 0 && final2.body.rows[0].email === 'rival@x.com';
    console.log(JSON.stringify({
      safeCompensatorChanges: safe.body.changes,
      rivalPreserved: safeOk,
      recommendation: 'Cairn MUST emit compensators with an optimistic-lock predicate (WHERE pk=? AND touched_col=?forwardValue). When changes=0, lane moves to state=conflict, surface to user.',
    }, null, 2));
  } finally {
    mock.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
