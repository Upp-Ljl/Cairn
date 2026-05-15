#!/usr/bin/env node
/**
 * cdp-snap-panel.mjs — connect to the running Electron panel via
 * Chrome DevTools Protocol, screenshot current state, optionally
 * toggle theme + re-screenshot.
 *
 * Usage:
 *   node scripts/cdp-snap-panel.mjs                   # 1 snap of current state
 *   node scripts/cdp-snap-panel.mjs both              # dark + light side-by-side
 *   node scripts/cdp-snap-panel.mjs theme dark        # force dark
 *   node scripts/cdp-snap-panel.mjs theme light       # force light
 *   node scripts/cdp-snap-panel.mjs eval "<js>"       # run JS in panel context
 *   node scripts/cdp-snap-panel.mjs click <selector>  # click an element
 *
 * Prereq: Electron started with --remote-debugging-port=9222
 *
 * Outputs to D:/lll/cairn/.cdp-snaps/<timestamp>-<label>.png
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
// WebSocket is a global in Node 22+. No import needed.

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const OUT_DIR  = 'D:/lll/cairn/.cdp-snaps';

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: CDP_HOST, port: CDP_PORT, path: p }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function findPanelTarget() {
  const targets = await httpGet('/json/list');
  const panel = targets.find(t =>
    t.type === 'page' &&
    (t.title.includes('Project Control Surface') || t.url.includes('panel.html'))
  );
  if (!panel) {
    console.error('FATAL: panel.html target not found. Open the panel window first.');
    process.exit(2);
  }
  return panel;
}

let _msgId = 0;
function sendCmd(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++_msgId;
    const handler = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        if (msg.error) reject(new Error(method + ': ' + msg.error.message));
        else resolve(msg.result || {});
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function captureScreenshot(ws, label) {
  await sendCmd(ws, 'Page.enable');
  // fromSurface:true + captureBeyondViewport:true bypasses the GPU
  // compositor cache that Electron 32 hits when only the renderer
  // repaints (e.g. theme switch via data-attribute). Without these,
  // captureScreenshot returns a stale frame even though the DOM has
  // already repainted on the user's actual screen. CDP debug 2026-05-15.
  const { data } = await sendCmd(ws, 'Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fp = path.join(OUT_DIR, `${ts}-${label}.png`);
  fs.writeFileSync(fp, Buffer.from(data, 'base64'));
  return fp;
}

async function setTheme(ws, theme) {
  if (!['dark', 'light'].includes(theme)) throw new Error('theme must be dark|light');
  await sendCmd(ws, 'Runtime.enable');
  await sendCmd(ws, 'Runtime.evaluate', {
    expression: `document.documentElement.setAttribute('data-cairn-theme', '${theme}'); '${theme}'`,
    returnByValue: true,
  });
  // give browser a tick to repaint
  await new Promise(r => setTimeout(r, 200));
}

async function evalJs(ws, jsExpr) {
  await sendCmd(ws, 'Runtime.enable');
  const r = await sendCmd(ws, 'Runtime.evaluate', { expression: jsExpr, returnByValue: true, awaitPromise: true });
  return r.result && r.result.value !== undefined ? r.result.value : r;
}

async function clickSelector(ws, selector) {
  return evalJs(ws, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { ok:false, error:'not_found' }; el.click(); return { ok:true, tag: el.tagName, text: (el.textContent||'').trim().slice(0,60) }; })()`);
}

async function main() {
  const cmd = process.argv[2] || 'snap';
  const arg = process.argv[3];
  const panel = await findPanelTarget();
  console.log('panel target:', panel.webSocketDebuggerUrl);
  const ws = new WebSocket(panel.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true });
    ws.addEventListener('error', (e) => rej(new Error('ws_error')), { once: true });
  });

  try {
    if (cmd === 'snap') {
      const fp = await captureScreenshot(ws, 'current');
      console.log('snap →', fp);
    } else if (cmd === 'both') {
      const cur = await evalJs(ws, "document.documentElement.dataset.cairnTheme || 'dark'");
      console.log('current theme:', cur);
      await setTheme(ws, 'dark');
      const fpDark = await captureScreenshot(ws, 'dark');
      console.log('dark →', fpDark);
      await setTheme(ws, 'light');
      const fpLight = await captureScreenshot(ws, 'light');
      console.log('light →', fpLight);
      // restore
      await setTheme(ws, cur);
    } else if (cmd === 'theme') {
      await setTheme(ws, arg);
      const fp = await captureScreenshot(ws, arg);
      console.log('theme set →', arg, '→', fp);
    } else if (cmd === 'eval') {
      const r = await evalJs(ws, arg);
      console.log('result:', JSON.stringify(r, null, 2));
    } else if (cmd === 'click') {
      const r = await clickSelector(ws, arg);
      console.log('click:', JSON.stringify(r, null, 2));
    } else {
      console.error('unknown cmd:', cmd);
      process.exit(1);
    }
  } finally {
    ws.close();
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
