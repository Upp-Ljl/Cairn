// Minimal HTTP forward proxy for Cairn header-attribution PoC.
// Listens on localhost:18080. Logs every incoming request's headers and the
// client-side remoteAddress:remotePort to stdout + proxy.log.
// Supports plain HTTP forwarding and HTTPS CONNECT tunneling.

import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const LOG_PATH = path.resolve('proxy.log');
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(obj) {
    const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
    console.log(line);
    logStream.write(line + '\n');
}

const server = http.createServer((clientReq, clientRes) => {
    const { remoteAddress, remotePort } = clientReq.socket;
    log({
        kind: 'http_request',
        method: clientReq.method,
        url: clientReq.url,
        remoteAddress,
        remotePort,
        headers: clientReq.headers,
    });

    // When a client uses us as an HTTP forward proxy, clientReq.url is absolute
    // e.g. "http://localhost:18081/foo". Otherwise it's relative.
    let targetUrl;
    try {
        targetUrl = new URL(clientReq.url.startsWith('http')
            ? clientReq.url
            : `http://${clientReq.headers.host}${clientReq.url}`);
    } catch (e) {
        clientRes.writeHead(400); clientRes.end('bad url'); return;
    }

    const upstream = http.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        method: clientReq.method,
        path: targetUrl.pathname + targetUrl.search,
        headers: clientReq.headers,
    }, (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
    });

    upstream.on('error', (err) => {
        log({ kind: 'upstream_error', error: String(err) });
        clientRes.writeHead(502); clientRes.end('upstream error: ' + err.message);
    });

    clientReq.pipe(upstream);
});

// HTTPS CONNECT tunneling — we cannot read headers of encrypted traffic, but
// we CAN log that a tunnel was requested and to where, plus the client port.
server.on('connect', (req, clientSocket, head) => {
    const { remoteAddress, remotePort } = clientSocket;
    log({
        kind: 'connect',
        url: req.url,
        remoteAddress,
        remotePort,
        headers: req.headers,
    });

    const [host, port] = req.url.split(':');
    const upstream = net.connect(parseInt(port, 10), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
    });
    upstream.on('error', (err) => {
        log({ kind: 'connect_upstream_error', error: String(err) });
        clientSocket.end();
    });
});

server.listen(18080, '127.0.0.1', () => {
    log({ kind: 'proxy_listening', port: 18080 });
});
