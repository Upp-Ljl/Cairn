const http = require('http');
const fs = require('fs');
function httpPost(u, obj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
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
async function run() {
  const lane = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  console.log(`[revert] lane=${lane.laneId}`);
  const up = lane.compensator.upstream;
  for (const op of lane.compensator.ops) {
    const r = await httpPost(up, { sql: op.sql, params: op.params });
    console.log(`[revert] ${op.sql} -> changes=${r.body.changes}`);
  }
  // verify
  const ids = lane.beforeImage.map((r) => r.id);
  const verify = await httpPost(up, { sql: `SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, params: ids });
  const ok = JSON.stringify(verify.body.rows) === JSON.stringify(lane.beforeImage.sort((a, b) => a.id - b.id));
  console.log(JSON.stringify({ revertOk: ok, want: lane.beforeImage, got: verify.body.rows }, null, 2));
  process.exit(ok ? 0 : 3);
}
run().catch((e) => { console.error(e); process.exit(1); });
