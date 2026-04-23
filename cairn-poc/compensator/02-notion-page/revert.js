const http = require('http');
const fs = require('fs');
function httpReq(method, u, bodyObj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method, headers: { 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function run() {
  const lane = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  console.log(`[revert] lane=${lane.laneId}`);
  const c = lane.compensator;
  const res = await httpReq(c.method, c.url, c.body);
  console.log(`[revert] compensator status=${res.status}`);
  const now = await httpReq('GET', c.url);
  const b = lane.beforeImage;
  const checks = [];
  if ('archived' in c.body) checks.push({ f: 'archived', ok: now.body.archived === b.archived });
  if ('icon' in c.body) checks.push({ f: 'icon', ok: JSON.stringify(now.body.icon) === JSON.stringify(b.icon) });
  if (c.body.properties) {
    for (const pk of Object.keys(c.body.properties)) {
      const t = b.properties[pk].type;
      checks.push({ f: `prop.${pk}`, ok: JSON.stringify(now.body.properties[pk][t]) === JSON.stringify(b.properties[pk][t]) });
    }
  }
  const allOk = checks.every((c) => c.ok);
  console.log(JSON.stringify({ revertOk: allOk, checks, gaps: lane.coverageGaps }, null, 2));
  process.exit(allOk ? 0 : 3);
}
run().catch((e) => { console.error(e); process.exit(1); });
