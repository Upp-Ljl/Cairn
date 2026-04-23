// Cairn proxy for Notion page PATCH.
// record = GET page; compensator = PATCH back the touched top-level keys + each touched property.
const http = require('http');
const fs = require('fs');
const path = require('path');

const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:4102';
const LANES_DIR = path.join(__dirname, 'lanes');
fs.mkdirSync(LANES_DIR, { recursive: true });

const READ_ONLY_PROP_TYPES = ['rollup', 'created_time', 'last_edited_time', 'formula'];

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
  const [pageId, patchJson] = process.argv.slice(2);
  if (!pageId || !patchJson) {
    console.error('usage: cairn-proxy.js <pageId> <jsonPatch>');
    process.exit(2);
  }
  const patch = JSON.parse(patchJson);
  const laneId = `lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const target = `${UPSTREAM}/v1/pages/${pageId}`;

  const t0 = Date.now();
  const before = await httpReq('GET', target);
  const recordMs = Date.now() - t0;
  if (before.status !== 200) {
    console.error('[cairn] pre-GET failed', before);
    process.exit(1);
  }

  // Build compensator body BEFORE forward so we can detect uncoverable fields
  const compensatorBody = {};
  const coverageGaps = [];
  for (const k of Object.keys(patch)) {
    if (k === 'properties') {
      compensatorBody.properties = {};
      for (const pk of Object.keys(patch.properties)) {
        const beforeProp = before.body.properties[pk];
        if (!beforeProp) {
          coverageGaps.push({ prop: pk, reason: 'not in before-image' });
          continue;
        }
        if (READ_ONLY_PROP_TYPES.includes(beforeProp.type)) {
          coverageGaps.push({ prop: pk, reason: `read-only type ${beforeProp.type}` });
          continue;
        }
        // only send the typed sub-value — which is what Notion wants to "set"
        compensatorBody.properties[pk] = { [beforeProp.type]: beforeProp[beforeProp.type] };
      }
    } else if (['archived', 'icon', 'cover'].includes(k)) {
      compensatorBody[k] = before.body[k];
    } else {
      coverageGaps.push({ topKey: k, reason: 'not handled by compensator' });
    }
  }

  const fwd = await httpReq('PATCH', target, patch);

  const lane = {
    laneId,
    endpoint: 'notion.page.patch',
    target,
    createdAt: new Date().toISOString(),
    recordLatencyMs: recordMs,
    compensator: { method: 'PATCH', url: target, body: compensatorBody },
    forwardRequest: { method: 'PATCH', body: patch },
    forwardResponse: { status: fwd.status, body: fwd.body },
    beforeImage: before.body,
    coverageGaps,
  };
  const lanePath = path.join(LANES_DIR, `${laneId}.json`);
  fs.writeFileSync(lanePath, JSON.stringify(lane, null, 2));
  console.log(JSON.stringify({ laneId, lanePath, recordMs, forwardStatus: fwd.status, coverageGaps }, null, 2));
}
run().catch((e) => {
  console.error('[cairn] error', e);
  process.exit(1);
});
