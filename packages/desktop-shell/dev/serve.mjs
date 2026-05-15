#!/usr/bin/env node

/**
 * Cairn Panel — lightweight dev server.
 *
 * Serves the desktop-shell directory as static files, plus a
 * /panel-dev.html endpoint that injects mock-cairn.js before
 * panel.js so the panel renders without Electron.
 *
 * Usage:
 *   node packages/desktop-shell/dev/serve.mjs [port]
 *   # default port 3210
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SHELL_DIR = resolve(__dirname, '..');
const DEV_DIR   = __dirname;
const PORT      = parseInt(process.argv[2] || '3210', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.cjs':  'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
};

async function serveFile(res, filePath) {
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + filePath);
  }
}

async function servePanelDev(res) {
  // Read the real panel.html
  const panelPath = join(SHELL_DIR, 'panel.html');
  let html;
  try {
    html = await readFile(panelPath, 'utf-8');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Cannot read panel.html: ' + e.message);
    return;
  }

  // STRIP the entire inline <style>...</style> block from panel.html.
  // We replace it wholesale with the design-system CSS link below.
  // Once approved, the contents of panel-styles.css will be copied
  // back into panel.html replacing its original <style> block.
  html = html.replace(/<style>[\s\S]*?<\/style>/, '<!-- inline <style> stripped by dev server -->');

  // Inject mocks + scripts before panel.js (which expects window.cairn).
  html = html.replace(
    '<script src="panel.js"></script>',
    '<script src="dev/mock-cairn.js"></script>\n<script src="panel.js"></script>\n<script src="dev/dev-overlay.js"></script>',
  );

  // Inject the design system stylesheet at end of <head> + pre-set theme.
  html = html.replace(
    '</head>',
    '<link rel="stylesheet" href="dev/panel-styles.css">\n' +
    '<script>document.documentElement.setAttribute("data-cairn-theme", localStorage.getItem("cairn-dev-theme") || "dark");</script>\n' +
    '</head>',
  );

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);

  // Dev index
  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(res, join(DEV_DIR, 'index.html'));
  }

  // Injected panel
  if (pathname === '/panel-dev.html') {
    return servePanelDev(res);
  }

  // Dev directory files (mock-cairn.js etc.)
  if (pathname.startsWith('/dev/')) {
    return serveFile(res, join(DEV_DIR, pathname.slice(5)));
  }

  // Everything else from desktop-shell root (panel.js, images, etc.)
  // Security: block path traversal
  const safe = pathname.replace(/\.\./g, '');
  return serveFile(res, join(SHELL_DIR, safe.startsWith('/') ? safe.slice(1) : safe));
});

server.listen(PORT, () => {
  console.log(`\n  Cairn Panel Dev Server`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  http://localhost:${PORT}/panel-dev.html  (standalone panel)\n`);
  console.log(`  Serving: ${SHELL_DIR}`);
  console.log(`  Mock:    ${join(DEV_DIR, 'mock-cairn.js')}\n`);
});
