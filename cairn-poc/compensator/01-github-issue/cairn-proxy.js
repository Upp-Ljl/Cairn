// Cairn proxy for GitHub Issue PATCH. Wraps: record (GET before-image) -> forward -> persist lane.
// CLI: node cairn-proxy.js <owner> <repo> <issueNum> '<json-patch>'
const http = require('http');
const fs = require('fs');
const path = require('path');

const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:4101';
const LANES_DIR = path.join(__dirname, 'lanes');
fs.mkdirSync(LANES_DIR, { recursive: true });

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
  const [owner, repo, num, patchJson] = process.argv.slice(2);
  if (!owner || !repo || !num || !patchJson) {
    console.error('usage: cairn-proxy.js <owner> <repo> <num> <jsonPatch>');
    process.exit(2);
  }
  const patch = JSON.parse(patchJson);
  const laneId = `lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const target = `${UPSTREAM}/repos/${owner}/${repo}/issues/${num}`;

  // STEP 1: record before-image
  const t0 = Date.now();
  const before = await httpReq('GET', target);
  const recordMs = Date.now() - t0;
  if (before.status !== 200) {
    console.error('[cairn] pre-GET failed', before);
    process.exit(1);
  }

  // STEP 2: forward
  const fwd = await httpReq('PATCH', target, patch);

  // STEP 3: persist lane (compensator plan)
  const lane = {
    laneId,
    endpoint: 'github.issue.patch',
    target,
    createdAt: new Date().toISOString(),
    recordLatencyMs: recordMs,
    // compensator: PATCH the fields that were touched, back to their before-image values.
    compensator: {
      method: 'PATCH',
      url: target,
      // reversible fields we saw in the forward patch; we restore ONLY the keys that were modified
      body: (() => {
        const b = {};
        for (const k of Object.keys(patch)) {
          if (k === 'labels') b.labels = before.body.labels.map((l) => l.name);
          else if (k === 'assignees') b.assignees = before.body.assignees.map((a) => a.login);
          else b[k] = before.body[k];
        }
        return b;
      })(),
    },
    forwardRequest: { method: 'PATCH', body: patch },
    forwardResponse: { status: fwd.status, body: fwd.body },
    beforeImage: before.body,
  };
  const lanePath = path.join(LANES_DIR, `${laneId}.json`);
  fs.writeFileSync(lanePath, JSON.stringify(lane, null, 2));
  console.log(JSON.stringify({ laneId, lanePath, recordMs, forwardStatus: fwd.status }, null, 2));
}
run().catch((e) => {
  console.error('[cairn] error', e);
  process.exit(1);
});
