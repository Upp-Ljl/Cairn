// F1a — Corrupt the lane file: delete the before-image labels entry AFTER the proxy wrote it.
// Then call revert.js and observe: does the compensator detect the gap? Or does it silently
// restore a partial/incorrect state by skipping 'labels'?
//
// Expected (safe): revert refuses to run, exit code != 0, signals "beforeImage.labels missing".
// Observed: see FAULT_RESULTS.md.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const POC = path.join(__dirname, '..', '01-github-issue');

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
    try { await httpReq('GET', `http://127.0.0.1:${port}/repos/octo/demo/issues/1`); return; }
    catch { await new Promise((r) => setTimeout(r, 80)); }
  }
  throw new Error('mock server did not come up');
}

async function main() {
  const { spawn } = require('child_process');
  const mock = spawn('node', [path.join(POC, 'mock-server.js')], { stdio: 'pipe' });
  try {
    await waitPort(4101);

    // Step 1: PATCH via proxy (labels are changed from [bug,p1] to [urgent])
    const patch = JSON.stringify({ labels: ['urgent'], title: 'F1a title' });
    const r = spawnSync('node', [path.join(POC, 'cairn-proxy.js'), 'octo', 'demo', '1', patch], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim());
    console.log('proxy ok, lane=', out.laneId);

    // Step 2: CORRUPT lane — delete labels from beforeImage AND from compensator.body
    const lane = JSON.parse(fs.readFileSync(out.lanePath, 'utf8'));
    delete lane.beforeImage.labels;
    delete lane.compensator.body.labels;
    // keep the forwardRequest.body.labels intact so we know labels WERE changed
    fs.writeFileSync(out.lanePath, JSON.stringify(lane, null, 2));
    console.log('corrupted lane: removed beforeImage.labels and compensator.body.labels');

    // Step 3: run revert
    const rev = spawnSync('node', [path.join(POC, 'revert.js'), out.lanePath], { encoding: 'utf8' });
    console.log('revert stdout:\n' + rev.stdout);
    console.log('revert stderr:\n' + rev.stderr);
    console.log('revert exit:', rev.status);

    // Step 4: check actual state
    const finalState = await httpReq('GET', 'http://127.0.0.1:4101/repos/octo/demo/issues/1');
    const labelsNow = finalState.body.labels.map(l => l.name).sort().join(',');
    const titleNow = finalState.body.title;
    console.log('FINAL STATE: labels=', labelsNow, 'title=', titleNow);

    // Verdict
    const labelsWrong = labelsNow !== 'bug,p1'; // true original
    const silent = rev.status === 0;
    console.log(JSON.stringify({
      detectedMissing: rev.status !== 0,
      finalLabels: labelsNow,
      finalTitle: titleNow,
      silentlyLeftBadState: silent && labelsWrong,
      verdict: silent && labelsWrong
        ? 'BUG: compensator silently left labels=urgent (user-observable wrong state) and exited 0'
        : 'OK-ish: something surfaced — see output',
    }, null, 2));
  } finally {
    mock.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
