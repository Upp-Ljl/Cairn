// F1b — Notion "files TTL" analog: what happens when the before-image is stale?
// Real Notion files have signed URLs that expire in 1h. For our mock, we analog this by:
//   1. proxy runs, captures beforeImage (Tags = ['foo'])
//   2. between forward and revert, a DIFFERENT user adds 'bar' to Tags (third-party edit,
//      analogous to "something changed since before-image was recorded")
//   3. revert blindly restores Tags to ['foo'] — user's 'bar' is STOMPED.
// Additionally we test: if the seed had a read-only rollup whose VALUE changed between
// forward and revert, is that captured? (It cannot be — rollups recompute server-side.)

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const POC = path.join(__dirname, '..', '02-notion-page');

function httpReq(method, u, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const b = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search,
      method, headers: { 'Content-Type': 'application/json', ...(b ? { 'Content-Length': b.length } : {}) },
    }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const buf = Buffer.concat(chunks).toString(); let p = null; try { p = buf ? JSON.parse(buf) : null; } catch { p = buf; } resolve({ status: res.statusCode, body: p }); }); });
    req.on('error', reject);
    if (b) req.write(b);
    req.end();
  });
}
async function waitPort(port) {
  for (let i = 0; i < 50; i++) {
    try { await new Promise((res, rej) => { const r = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'GET' }, (x) => { x.resume(); x.on('end', res); }); r.on('error', rej); r.end(); }); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('no mock');
}

async function main() {
  const mock = spawn('node', [path.join(POC, 'mock-server.js')], { stdio: 'pipe' });
  try {
    await waitPort(4102);

    // 1. forward: change Status.select.name to 'Done'
    const patch = JSON.stringify({ properties: { Status: { select: { name: 'Done', color: 'green' } } } });
    const r = spawnSync('node', [path.join(POC, 'cairn-proxy.js'), 'p-123', patch], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim());
    console.log('forward ok, coverageGaps=', out.coverageGaps);

    // 2. third-party edit: add a tag (Notion multi_select)
    const third = await httpReq('PATCH', 'http://127.0.0.1:4102/v1/pages/p-123', {
      properties: { Tags: { multi_select: [{ name: 'foo' }, { name: 'bar' }, { name: 'baz' }] } },
    });
    console.log('third-party edit added bar+baz to Tags:', third.body.properties.Tags.multi_select.map(t => t.name));

    // 3. revert — compensator only covers Status (we forward-patched Status only).
    //    Tags not in patch -> compensator won't touch them. GOOD (we expect Tags preserved).
    const rev = spawnSync('node', [path.join(POC, 'revert.js'), out.lanePath], { encoding: 'utf8' });
    console.log('\n=== revert stdout ===\n' + rev.stdout);

    // Verify: Status reverted to 'Draft', Tags preserved (bar & baz still there)
    const final = await httpReq('GET', 'http://127.0.0.1:4102/v1/pages/p-123');
    const tags = final.body.properties.Tags.multi_select.map(t => t.name);
    const status = final.body.properties.Status.select.name;

    console.log(JSON.stringify({
      finalStatus: status,
      finalTags: tags,
      statusReverted: status === 'Draft',
      thirdPartyTagsPreserved: tags.includes('bar') && tags.includes('baz'),
      verdict: tags.includes('bar') && status === 'Draft'
        ? 'OK: narrow revert — only fields in forward patch are touched; third-party changes on OTHER fields are preserved. This is good design (touch=restore).'
        : 'BUG',
    }, null, 2));

    // --- PART 2: stale rollup value ---
    console.log('\n--- Part 2: rollup stale value ---');
    // Before-image captured ComputedCount.rollup.number = 42.
    // In real notion, rollup recomputes from linked pages. We cannot restore. Proxy correctly marks it as
    // coverage gap — but what if the user PATCHed a number and the proxy failed to mark as readonly?
    // Let's try forwarding a read-only-ish patch: explicitly target rollup. Mock rejects with 400.
    const badPatch = JSON.stringify({ properties: { ComputedCount: { number: 99 } } });
    const r2 = spawnSync('node', [path.join(POC, 'cairn-proxy.js'), 'p-123', badPatch], { encoding: 'utf8' });
    console.log('forward (patching rollup) stdout:', r2.stdout);
    console.log('forward stderr:', r2.stderr);

    // Check the lane's coverageGaps
    const lanes = fs.readdirSync(path.join(POC, 'lanes')).map(f => JSON.parse(fs.readFileSync(path.join(POC, 'lanes', f), 'utf8')));
    const lastLane = lanes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop();
    console.log('last lane coverageGaps:', lastLane.coverageGaps);
    console.log('last lane forwardResponse status:', lastLane.forwardResponse.status);
    console.log(JSON.stringify({
      coverageGapProperlyDeclared: lastLane.coverageGaps.some(g => g.prop === 'ComputedCount'),
      forwardResponseStatus: lastLane.forwardResponse.status,
      verdict: lastLane.coverageGaps.some(g => g.prop === 'ComputedCount')
        ? 'GOOD: proxy flags rollup as coverageGap. Revert will not attempt to restore it.'
        : 'GAP: proxy did not flag read-only type; revert would silently skip it without user notice',
    }, null, 2));
  } finally { mock.kill(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
