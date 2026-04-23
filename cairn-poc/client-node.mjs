// Node.js client experiments.
// Tests: native fetch (undici), with/without HTTP_PROXY env,
// with/without explicit dispatcher, with/without custom header.
//
// Usage: node client-node.mjs <scenario>
//   scenarios:
//     envproxy-explicit-header  -> HTTP_PROXY set, x-cairn-lane-id header added
//     envproxy-no-header        -> HTTP_PROXY set, no custom header (tests auto-injection)
//     no-proxy-explicit-header  -> no HTTP_PROXY, direct to echo (tests bypass)
//     dispatcher-explicit-header -> use undici ProxyAgent, header added
//
// We ALSO read CAIRN_LANE_ID env var and show whether we attach it automatically.

import { ProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from 'undici';

const scenario = process.argv[2] || 'envproxy-explicit-header';
const ECHO = 'http://127.0.0.1:18081/test';
const LANE = process.env.CAIRN_LANE_ID ?? null;

async function run() {
    const tag = `[node scenario=${scenario} pid=${process.pid} CAIRN_LANE_ID=${LANE}]`;
    console.log(tag, 'HTTP_PROXY env =', process.env.HTTP_PROXY ?? '(unset)');
    console.log(tag, 'http_proxy env =', process.env.http_proxy ?? '(unset)');

    let headers = {};
    let dispatcher;

    if (scenario.includes('explicit-header')) {
        headers['x-cairn-lane-id'] = 'test-123';
    }

    // CRITICAL observation: Node native fetch (undici) does NOT automatically
    // read HTTP_PROXY env. We demonstrate this by NOT passing a dispatcher in
    // the "envproxy-*" scenarios and observing that the request bypasses proxy.
    if (scenario === 'dispatcher-explicit-header') {
        dispatcher = new ProxyAgent('http://localhost:18080');
    }

    try {
        const res = await undiciFetch(ECHO, { headers, dispatcher });
        const body = await res.json();
        console.log(tag, 'echo seen headers.x-cairn-lane-id =', body.headers['x-cairn-lane-id'] ?? '(absent)');
        console.log(tag, 'echo seen via =', body.headers['via'] ?? '(absent)');
        console.log(tag, 'echo req url =', body.url);
    } catch (e) {
        console.log(tag, 'ERROR', e.message);
    }
}

run();
