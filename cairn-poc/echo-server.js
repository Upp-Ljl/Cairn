// Minimal echo server that returns the request headers as JSON.
// Listens on localhost:18081. Used as the target of proxy experiments.

import http from 'node:http';

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
        const payload = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body,
            env_CAIRN_LANE_ID: process.env.CAIRN_LANE_ID ?? null,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload, null, 2));
    });
});

server.listen(18081, '127.0.0.1', () => {
    console.log('echo listening on 127.0.0.1:18081');
});
