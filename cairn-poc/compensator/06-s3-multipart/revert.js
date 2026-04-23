// Revert reads lane state and dispatches:
//  - INIT_PENDING / INITIATED / UPLOADING_PARTS: abort upload
//  - COMPLETED + !existedBefore: DELETE the object
//  - COMPLETED + existedBefore: attempt PUT back beforeImage metadata (simulates versioned-bucket restore)
const http = require('http');
const fs = require('fs');
const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:4106';
function httpReq(method, u, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method, headers: { 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } },
      (res) => { let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => resolve({ status: res.statusCode, body: buf ? (res.headers['content-type']?.includes('json') ? JSON.parse(buf) : buf) : null })); }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function run() {
  const lane = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  console.log(`[revert] lane=${lane.laneId} state=${lane.state} existedBefore=${lane.existedBefore}`);
  const { bucket, key, uploadId } = lane;
  if (['INIT_PENDING', 'INITIATED', 'UPLOADING_PARTS'].includes(lane.state)) {
    if (uploadId) {
      const a = await httpReq('DELETE', `${UPSTREAM}/${bucket}/${key}?uploadId=${uploadId}`);
      console.log(`[revert] abort upload -> ${a.status}`);
    }
    const finalObj = await httpReq('GET', `${UPSTREAM}/${bucket}/${key}`);
    const ok = lane.existedBefore ? finalObj.status === 200 : finalObj.status === 404;
    console.log(JSON.stringify({ revertOk: ok, finalObjectStatus: finalObj.status }, null, 2));
    process.exit(ok ? 0 : 3);
  }
  if (lane.state === 'COMPLETED') {
    if (!lane.existedBefore) {
      const d = await httpReq('DELETE', `${UPSTREAM}/${bucket}/${key}`);
      console.log(`[revert] DELETE object -> ${d.status}`);
      const now = await httpReq('GET', `${UPSTREAM}/${bucket}/${key}`);
      const ok = now.status === 404;
      console.log(JSON.stringify({ revertOk: ok }, null, 2));
      process.exit(ok ? 0 : 3);
    } else {
      // Attempt version restore
      const put = await httpReq('PUT', `${UPSTREAM}/${bucket}/${key}`, JSON.stringify(lane.beforeImage));
      console.log(`[revert] PUT previous version -> ${put.status}`);
      const now = await httpReq('GET', `${UPSTREAM}/${bucket}/${key}`);
      const ok = now.body.etag === lane.beforeImage.etag && now.body.size === lane.beforeImage.size;
      console.log(JSON.stringify({ revertOk: ok, want: lane.beforeImage, got: now.body, note: 'requires versioned bucket; on non-versioned S3 this recovery is impossible' }, null, 2));
      process.exit(ok ? 0 : 3);
    }
  }
  console.log('[revert] unknown state');
  process.exit(3);
}
run().catch((e) => { console.error(e); process.exit(1); });
