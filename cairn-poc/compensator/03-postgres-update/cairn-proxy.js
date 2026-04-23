// Cairn proxy for SQL UPDATE. Records before-image rows by running a matching SELECT with same WHERE.
// Limitation: we need to parse the UPDATE to derive the SELECT. For POC we accept a structured input:
//   node cairn-proxy.js <table> <set-json> <where-json>
// e.g.  node cairn-proxy.js users '{"email":"new@x.com"}' '{"id":1}'
const http = require('http');
const fs = require('fs');
const path = require('path');

const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:4103';
const LANES_DIR = path.join(__dirname, 'lanes');
fs.mkdirSync(LANES_DIR, { recursive: true });

function httpPost(endpoint, obj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(UPSTREAM + endpoint);
    const body = JSON.stringify(obj);
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildWhereSQL(where) {
  const keys = Object.keys(where);
  return {
    clause: keys.map((k) => `${k}=?`).join(' AND '),
    values: keys.map((k) => where[k]),
  };
}
function buildSetSQL(set) {
  const keys = Object.keys(set);
  return { clause: keys.map((k) => `${k}=?`).join(','), values: keys.map((k) => set[k]) };
}

async function run() {
  const [table, setJson, whereJson] = process.argv.slice(2);
  if (!table || !setJson || !whereJson) {
    console.error('usage: cairn-proxy.js <table> <setJson> <whereJson>');
    process.exit(2);
  }
  const setObj = JSON.parse(setJson);
  const whereObj = JSON.parse(whereJson);
  const laneId = `lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // STEP 1: record — SELECT matching rows
  const w = buildWhereSQL(whereObj);
  const selCols = ['*'];
  const t0 = Date.now();
  const before = await httpPost('/query', { sql: `SELECT ${selCols.join(',')} FROM ${table} WHERE ${w.clause}`, params: w.values });
  const recordMs = Date.now() - t0;
  if (before.status !== 200) { console.error('[cairn] select failed', before); process.exit(1); }
  const beforeRows = before.body.rows;
  if (beforeRows.length === 0) { console.error('[cairn] no matching rows — refusing to proxy'); process.exit(1); }

  // STEP 2: forward UPDATE
  const s = buildSetSQL(setObj);
  const updSql = `UPDATE ${table} SET ${s.clause} WHERE ${w.clause}`;
  const updResp = await httpPost('/query', { sql: updSql, params: [...s.values, ...w.values] });

  // STEP 3: compensator plan — one UPDATE per row keyed by PK (id)
  const touchedCols = Object.keys(setObj);
  const compensatorOps = beforeRows.map((row) => {
    const setBack = {};
    for (const c of touchedCols) setBack[c] = row[c];
    return {
      sql: `UPDATE ${table} SET ${touchedCols.map((c) => `${c}=?`).join(',')} WHERE id=?`,
      params: [...touchedCols.map((c) => row[c]), row.id],
    };
  });

  const lane = {
    laneId,
    endpoint: 'sql.update',
    createdAt: new Date().toISOString(),
    recordLatencyMs: recordMs,
    forwardRequest: { sql: updSql, params: [...s.values, ...w.values] },
    forwardResponse: updResp.body,
    beforeImage: beforeRows,
    compensator: { ops: compensatorOps, upstream: `${UPSTREAM}/query` },
  };
  const lanePath = path.join(LANES_DIR, `${laneId}.json`);
  fs.writeFileSync(lanePath, JSON.stringify(lane, null, 2));
  console.log(JSON.stringify({ laneId, lanePath, recordMs, rowsAffected: updResp.body.changes, beforeRowCount: beforeRows.length }, null, 2));
}
run().catch((e) => { console.error(e); process.exit(1); });
