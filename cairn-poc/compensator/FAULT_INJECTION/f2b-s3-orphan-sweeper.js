// F2b — S3 multipart Complete fails. Cairn proxy should have written lane with state=UPLOADING_PARTS
// or lane with a failed complete. We verify: does a sweeper that scans lanes/*.json find the orphan
// upload and call AbortMultipartUpload?
//
// Setup:
//   1. run mock-server (4106)
//   2. run cairn-proxy with CRASH_AFTER_PART=2 (n=3) — proxy exits after 2/3 parts, lane.state=UPLOADING_PARTS
//   3. simulate a sweeper: list lanes, for each lane with state!=COMPLETED and has uploadId, issue abort
//   4. confirm listMultipartUploads on mock returns [] (orphan is gone)
//
// Part 2: test what happens if Complete FAILS (as opposed to proxy crash between parts)
//   run a modified flow: upload 3 parts, then call Complete with a bad ETag -> 400. lane stays UPLOADING_PARTS.
//   sweeper handles same way.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const POC = path.join(__dirname, '..', '06-s3-multipart');

function httpReq(method, u, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const b = body instanceof Buffer ? body : (body ? (typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body))) : null);
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search,
      method, headers: { 'Content-Type': 'application/json', ...headers, ...(b ? { 'Content-Length': b.length } : {}) },
    }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const buf = Buffer.concat(chunks).toString(); let parsed = null; try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = buf; } resolve({ status: res.statusCode, headers: res.headers, body: parsed }); }); });
    req.on('error', reject);
    if (b) req.write(b);
    req.end();
  });
}

async function waitPort(port) {
  for (let i = 0; i < 50; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/bk/any', method: 'GET' }, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', reject);
        req.end();
      });
      return;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('no mock on ' + port);
}

async function main() {
  // clean lanes dir
  const lanesDir = path.join(POC, 'lanes');
  for (const f of fs.readdirSync(lanesDir)) { try { fs.unlinkSync(path.join(lanesDir, f)); } catch {} }

  const mock = spawn('node', [path.join(POC, 'mock-server.js')], { stdio: 'pipe' });
  try {
    await waitPort(4106);

    // Part A: proxy crashes after 2 parts (CRASH_AFTER_PART=2, total n=3)
    const r = spawnSync('node', [path.join(POC, 'cairn-proxy.js'), 'bk', 'orphan-a.txt', '3'],
      { encoding: 'utf8', env: { ...process.env, CRASH_AFTER_PART: '2' } });
    console.log('proxy (crash after part 2) stdout:', r.stdout);

    // Part B: proxy runs fully, but we inject a 400 on complete by manually fudging the lane:
    //   easier: call the mock by hand — initiate, 3 parts, then complete with wrong ETag.
    const init = await httpReq('POST', 'http://127.0.0.1:4106/bk/orphan-b.txt?uploads');
    const uploadId = init.body.UploadId;
    const etags = [];
    for (let n = 1; n <= 3; n++) {
      const body = Buffer.from(`content-${n}`.repeat(100));
      const pr = await httpReq('PUT', `http://127.0.0.1:4106/bk/orphan-b.txt?partNumber=${n}&uploadId=${uploadId}`, body, { 'Content-Type': 'application/octet-stream' });
      etags.push(pr.body.ETag);
    }
    const completeBad = await httpReq('POST', `http://127.0.0.1:4106/bk/orphan-b.txt?uploadId=${uploadId}`,
      JSON.stringify({ Parts: etags.map((e, i) => ({ PartNumber: i + 1, ETag: 'WRONG_ETAG' })) }));
    console.log('complete with bad ETag ->', completeBad.status, completeBad.body);
    // manually persist a lane for this case, simulating proxy that captured state up to complete-pending
    const laneB = {
      laneId: 'lane-manual-orphan-b',
      endpoint: 's3.multipart', bucket: 'bk', key: 'orphan-b.txt',
      existedBefore: false, state: 'UPLOADING_PARTS', uploadId,
      partsUploaded: etags.map((e, i) => ({ partNumber: i + 1, etag: e })),
    };
    fs.writeFileSync(path.join(lanesDir, `${laneB.laneId}.json`), JSON.stringify(laneB, null, 2));

    // Check: list in-progress uploads BEFORE sweep
    const listBefore = await httpReq('GET', 'http://127.0.0.1:4106/bk/orphan-a.txt?uploads');
    const listBefore2 = await httpReq('GET', 'http://127.0.0.1:4106/bk/orphan-b.txt?uploads');
    console.log('in-progress uploads BEFORE sweep:',
      (listBefore.body.Uploads || []).length + (listBefore2.body.Uploads || []).length);

    // Sweeper — scan lanes dir, find state != COMPLETED with uploadId, abort
    const lanes = fs.readdirSync(lanesDir).map(f => JSON.parse(fs.readFileSync(path.join(lanesDir, f), 'utf8')));
    const orphans = lanes.filter(l => l.endpoint === 's3.multipart' && l.state !== 'COMPLETED' && l.uploadId);
    console.log(`sweeper found ${orphans.length} orphan lanes`);
    const sweepReport = [];
    for (const l of orphans) {
      const ab = await httpReq('DELETE', `http://127.0.0.1:4106/${l.bucket}/${l.key}?uploadId=${l.uploadId}`);
      sweepReport.push({ laneId: l.laneId, bucket: l.bucket, key: l.key, uploadId: l.uploadId, abortStatus: ab.status });
    }
    console.log('sweep report:', JSON.stringify(sweepReport, null, 2));

    // AFTER sweep: verify all orphans are cleaned up
    const listAfter1 = await httpReq('GET', 'http://127.0.0.1:4106/bk/orphan-a.txt?uploads');
    const listAfter2 = await httpReq('GET', 'http://127.0.0.1:4106/bk/orphan-b.txt?uploads');
    const remaining = (listAfter1.body.Uploads || []).length + (listAfter2.body.Uploads || []).length;
    console.log('remaining orphan uploads after sweep:', remaining);

    console.log(JSON.stringify({
      orphansFound: orphans.length,
      cleanedUp: sweepReport.length,
      remaining,
      verdict: remaining === 0 && orphans.length > 0
        ? 'OK: sweeper mechanism works with the existing lane format. Proxy already writes state=UPLOADING_PARTS with uploadId. Cairn just needs to run the sweeper on a schedule.'
        : 'GAP: lane format does not capture enough state, or sweeper cannot clean',
      notes: [
        'POC proxy persists lane before every state transition -> lane file robust to process crash',
        'No TTL on orphans → need a sweeper schedule (every N minutes)',
        'If uploadId is never written to lane (INIT_PENDING crash), the orphan is unreachable — needs a wider sweep via LIST in-progress uploads on each bucket',
      ],
    }, null, 2));
  } finally { mock.kill(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
