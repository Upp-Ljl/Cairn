// S3 multipart: we wrap the whole session.
// record: GET existing object (if any) as before-image
// forward: initiate -> upload N parts -> complete
// compensator: 3-state handling based on lane status
//   - partsOnly (init done, some parts uploaded, NOT completed): abort upload
//   - completed-new (object didn't exist before): DELETE object AND abort any orphan
//   - completed-overwrite (object existed): PUT back previous version metadata (simulating versioned bucket restore); if non-versioned, no revert possible
// We also honor an env CRASH_AFTER_PART=N to simulate partial failure.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:4106';
const LANES_DIR = path.join(__dirname, 'lanes');
fs.mkdirSync(LANES_DIR, { recursive: true });

function httpReq(method, u, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method, headers: { 'Content-Type': 'application/json', ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } },
      (res) => { let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf ? (res.headers['content-type']?.includes('json') ? JSON.parse(buf) : buf) : null })); }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  const [bucket, key, nPartsStr] = process.argv.slice(2);
  const nParts = parseInt(nPartsStr || '3', 10);
  const laneId = `lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // STEP 1: record — does the object exist?
  const t0 = Date.now();
  const before = await httpReq('GET', `${UPSTREAM}/${bucket}/${key}`);
  const recordMs = Date.now() - t0;
  const existed = before.status === 200;
  const beforeImage = existed ? before.body : null;

  // write a partial lane up front (so if we crash we still know there's an upload to clean up)
  let lane = {
    laneId,
    endpoint: 's3.multipart',
    createdAt: new Date().toISOString(),
    recordLatencyMs: recordMs,
    bucket, key, nParts,
    existedBefore: existed,
    beforeImage,
    state: 'INIT_PENDING',
  };
  const lanePath = path.join(LANES_DIR, `${laneId}.json`);
  const persist = () => fs.writeFileSync(lanePath, JSON.stringify(lane, null, 2));
  persist();

  // STEP 2a: initiate
  const init = await httpReq('POST', `${UPSTREAM}/${bucket}/${key}?uploads`);
  lane.uploadId = init.body.UploadId;
  lane.state = 'INITIATED';
  persist();

  // STEP 2b: upload parts
  lane.partsUploaded = [];
  const crashAfter = parseInt(process.env.CRASH_AFTER_PART || '0', 10);
  for (let n = 1; n <= nParts; n++) {
    const body = Buffer.from(`part-${n}-`.repeat(100) + crypto.randomBytes(8).toString('hex'));
    const r = await httpReq('PUT', `${UPSTREAM}/${bucket}/${key}?partNumber=${n}&uploadId=${lane.uploadId}`, body, { 'Content-Type': 'application/octet-stream' });
    lane.partsUploaded.push({ partNumber: n, etag: r.body.ETag, size: body.length });
    lane.state = 'UPLOADING_PARTS';
    persist();
    if (crashAfter && n === crashAfter) {
      console.log(`[cairn] simulated crash after part ${n}`);
      console.log(JSON.stringify({ laneId, lanePath, recordMs, state: lane.state, partsUploaded: lane.partsUploaded.length }, null, 2));
      return;
    }
  }

  // STEP 2c: complete
  const complete = await httpReq('POST', `${UPSTREAM}/${bucket}/${key}?uploadId=${lane.uploadId}`, JSON.stringify({ Parts: lane.partsUploaded.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) }));
  lane.completeResponse = complete.body;
  lane.state = 'COMPLETED';
  persist();

  console.log(JSON.stringify({ laneId, lanePath, recordMs, state: lane.state, uploadId: lane.uploadId, completedEtag: complete.body.ETag }, null, 2));
}
run().catch((e) => { console.error(e); process.exit(1); });
