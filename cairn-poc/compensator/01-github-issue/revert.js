// Revert: read lane file, execute compensator. Verify state == before-image.
const http = require('http');
const fs = require('fs');

function httpReq(method, u, bodyObj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
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
  const lanePath = process.argv[2];
  if (!lanePath) {
    console.error('usage: revert.js <lane.json>');
    process.exit(2);
  }
  const lane = JSON.parse(fs.readFileSync(lanePath, 'utf8'));
  console.log(`[revert] lane=${lane.laneId} endpoint=${lane.endpoint}`);

  const c = lane.compensator;
  const res = await httpReq(c.method, c.url, c.body);
  console.log(`[revert] compensator status=${res.status}`);

  // verify
  const now = await httpReq('GET', c.url);
  const b = lane.beforeImage;
  const checks = [];
  for (const k of Object.keys(c.body)) {
    if (k === 'labels') {
      const want = b.labels.map((l) => l.name).sort().join(',');
      const got = now.body.labels.map((l) => l.name).sort().join(',');
      checks.push({ field: k, ok: want === got, want, got });
    } else if (k === 'assignees') {
      const want = b.assignees.map((a) => a.login).sort().join(',');
      const got = now.body.assignees.map((a) => a.login).sort().join(',');
      checks.push({ field: k, ok: want === got, want, got });
    } else {
      checks.push({ field: k, ok: JSON.stringify(now.body[k]) === JSON.stringify(b[k]), want: b[k], got: now.body[k] });
    }
  }
  const allOk = checks.every((c) => c.ok);
  console.log(JSON.stringify({ revertOk: allOk, checks }, null, 2));
  process.exit(allOk ? 0 : 3);
}
run().catch((e) => {
  console.error('[revert] error', e);
  process.exit(1);
});
