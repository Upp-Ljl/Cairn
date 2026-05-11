/**
 * CDP client for Electron integration smoke tests.
 * Uses Node 24 native WebSocket (globalThis.WebSocket) — zero npm deps.
 *
 * Exports:
 *   CDPSession                  — class
 *   listTargets(port)           → page target list from /json
 *   waitForTarget(port, sub)    → waits for a page whose URL includes `sub`
 *   connectToTarget(target)     → opens WS, enables Runtime, returns CDPSession
 *
 * Error codes attached to thrown errors:
 *   cdp_timeout       evaluate / waitFor / connect timed out
 *   cdp_disconnect    WebSocket closed unexpectedly
 *   target_not_found  waitForTarget gave up
 *   eval_threw        JS exception inside evaluate / no element for click
 */

const DEFAULT_TIMEOUT_MS = 8000;

export class CDPSession {
  #ws;
  #msgId = 0;
  #pending = new Map(); // id → { resolve, reject }
  #consoleErrors = [];

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('close',   ()   => this.#onClose());
    ws.addEventListener('error',   (e)  => this.#onError(e));
  }

  #onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id != null) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) {
        p.reject(Object.assign(
          new Error(msg.error.message || 'CDP protocol error'),
          { code: 'eval_threw', cdpError: msg.error }
        ));
      } else {
        p.resolve(msg.result);
      }
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const { type } = msg.params || {};
      if (type === 'error' || type === 'assert') {
        this.#consoleErrors.push(msg.params);
      }
    }
  }

  #onClose() {
    const err = Object.assign(new Error('CDP connection closed'), { code: 'cdp_disconnect' });
    for (const [, p] of this.#pending) p.reject(err);
    this.#pending.clear();
  }

  #onError(e) {
    const err = Object.assign(
      new Error(`CDP WebSocket error: ${e.message || String(e)}`),
      { code: 'cdp_disconnect' }
    );
    for (const [, p] of this.#pending) p.reject(err);
    this.#pending.clear();
  }

  #send(method, params = {}) {
    const id = ++this.#msgId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate a JS expression in the page context.
   * @param {string}  expr
   * @param {object}  opts
   * @param {number}  opts.timeoutMs   default 8000
   * @param {boolean} opts.awaitPromise  default true
   */
  async evaluate(expr, { timeoutMs = DEFAULT_TIMEOUT_MS, awaitPromise = true } = {}) {
    const timerP = new Promise((_, reject) =>
      setTimeout(() =>
        reject(Object.assign(
          new Error(`evaluate timeout (${timeoutMs}ms): ${expr.slice(0, 80)}`),
          { code: 'cdp_timeout' }
        )), timeoutMs)
    );
    const evalP = this.#send('Runtime.evaluate', {
      expression: expr,
      awaitPromise,
      returnByValue: true,
    }).then(result => {
      if (result.exceptionDetails) {
        const msg = result.exceptionDetails.text
          || result.exceptionDetails.exception?.description
          || 'eval_threw';
        throw Object.assign(new Error(msg), {
          code: 'eval_threw',
          details: result.exceptionDetails,
        });
      }
      return result.result?.value;
    });
    return Promise.race([evalP, timerP]);
  }

  /**
   * Poll predicateExpr (sync JS, no await) until truthy.
   */
  async waitFor(predicateExpr, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const v = await this.evaluate(predicateExpr, { awaitPromise: false, timeoutMs: 2000 });
        if (v) return v;
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw Object.assign(
      new Error(`waitFor timeout (${timeoutMs}ms): ${predicateExpr.slice(0, 100)}`),
      { code: 'cdp_timeout' }
    );
  }

  /** Returns textContent of first matching element, or null. */
  async querySelectorText(sel) {
    return this.evaluate(
      `(document.querySelector(${JSON.stringify(sel)}) || {}).textContent ?? null`,
      { awaitPromise: false }
    );
  }

  /** Returns a plain-object array describing all matching elements. */
  async querySelectorAll(sel) {
    return this.evaluate(
      `Array.from(document.querySelectorAll(${JSON.stringify(sel)})).map(el => ({
        id: el.id,
        className: el.className,
        textContent: el.textContent.trim().slice(0, 200),
        hidden: el.hidden,
        disabled: !!el.disabled,
        dataset: Object.fromEntries(Object.entries(el.dataset)),
      }))`,
      { awaitPromise: false }
    );
  }

  /** Click the first element matching sel. Throws eval_threw if no match. */
  async clickSelector(sel) {
    const found = await this.evaluate(
      `!!document.querySelector(${JSON.stringify(sel)})`,
      { awaitPromise: false }
    );
    if (!found) {
      throw Object.assign(
        new Error(`clickSelector: no element matching ${JSON.stringify(sel)}`),
        { code: 'eval_threw' }
      );
    }
    await this.evaluate(
      `document.querySelector(${JSON.stringify(sel)}).click()`,
      { awaitPromise: false }
    );
  }

  /** Set textarea value and dispatch input + change events. */
  async fillTextarea(sel, text) {
    await this.evaluate(
      `(function() {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) throw new Error('fillTextarea: no element for ' + ${JSON.stringify(sel)});
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }())`,
      { awaitPromise: false }
    );
  }

  /** Accumulated console.error / assert calls from this session. */
  get consoleErrors() { return [...this.#consoleErrors]; }

  /** Enable Runtime domain so consoleAPICalled events fire. */
  async enableRuntime() {
    await this.#send('Runtime.enable', {});
  }

  disconnect() {
    try { this.#ws.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Target discovery helpers
// ---------------------------------------------------------------------------

/** Fetch /json from the CDP HTTP endpoint; returns array of targets. */
export async function listTargets(httpPort) {
  const res = await fetch(`http://127.0.0.1:${httpPort}/json`);
  if (!res.ok) throw new Error(`listTargets: HTTP ${res.status}`);
  return res.json();
}

/**
 * Poll /json until a page-type target whose URL includes urlSubstring appears.
 * @returns {object} The matching target descriptor.
 */
export async function waitForTarget(httpPort, urlSubstring, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(httpPort);
      const t = targets.find(t => t.type === 'page' && t.url?.includes(urlSubstring));
      if (t) return t;
    } catch { /* port not ready yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw Object.assign(
    new Error(`waitForTarget timeout (${timeoutMs}ms): "${urlSubstring}" not found on port ${httpPort}`),
    { code: 'target_not_found' }
  );
}

/**
 * Open a WebSocket to `target.webSocketDebuggerUrl`, enable Runtime domain,
 * and return a ready CDPSession.
 */
export async function connectToTarget(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() =>
      reject(Object.assign(
        new Error('CDP WebSocket connect timeout'),
        { code: 'cdp_timeout' }
      )), 8000);
    ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); });
    ws.addEventListener('error', (e) => {
      clearTimeout(timeout);
      reject(Object.assign(
        new Error(`WebSocket error: ${e.message || String(e)}`),
        { code: 'cdp_disconnect' }
      ));
    });
  });
  const session = new CDPSession(ws);
  await session.enableRuntime();
  return session;
}
