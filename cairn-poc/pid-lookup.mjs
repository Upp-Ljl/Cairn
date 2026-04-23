// Given remotePort from an incoming proxy connection, find the PID of the
// local client process via netstat. Measure the lookup latency.

import { execSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';

// Keep-alive HTTP client that makes a request through our proxy.
// We capture the client-side local port ourselves, then compare what the
// proxy saw AND what netstat reports for that port.

function lookupPidByLocalPort(port) {
    const start = Date.now();
    // On Windows (Git Bash), netstat -ano gives lines like:
    //   TCP    127.0.0.1:18080   127.0.0.1:63954   ESTABLISHED   <PID>
    // We look for lines where the foreign-side (from proxy's POV: local) port matches.
    let out;
    try {
        out = execSync('netstat -ano', { encoding: 'utf8' });
    } catch (e) {
        return { pid: null, latencyMs: Date.now() - start, error: String(e) };
    }
    const lines = out.split('\n').filter(l => l.includes(`:${port} `) || l.includes(`:${port}\r`));
    // Find the row that has 127.0.0.1:port as LOCAL addr and TCP, pick the pid.
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        // format: TCP  local  remote  state  pid
        if (parts[0] !== 'TCP') continue;
        if (parts[1].endsWith(`:${port}`)) {
            return { pid: parseInt(parts[parts.length - 1], 10), latencyMs: Date.now() - start, line: line.trim() };
        }
    }
    return { pid: null, latencyMs: Date.now() - start, error: 'not found' };
}

// Start a tiny proxy inline that, on every request, immediately resolves pid
// for the client-side remotePort and logs it.
const proxy = http.createServer((req, res) => {
    const port = req.socket.remotePort;
    const lookup = lookupPidByLocalPort(port);
    const logLine = {
        t: new Date().toISOString(),
        remotePort: port,
        lookup,
        ownPid: process.pid,
        xCairn: req.headers['x-cairn-lane-id'] ?? null,
    };
    console.log(JSON.stringify(logLine));

    // Respond immediately with the lookup result
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(logLine));
});

proxy.listen(18090, '127.0.0.1', () => {
    console.log('pid-lookup proxy listening on 18090');
});
