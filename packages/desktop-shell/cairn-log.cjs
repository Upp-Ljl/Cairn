'use strict';

/**
 * cairn-log.cjs — structured event log for Cairn panel.
 *
 * Per CEO 鸭总 2026-05-14: "提前写好 log 的触发，尽量能够通过 log 就
 * 知道是哪一步有错，也方便你自己调试".
 *
 * One event per line, JSONL, daily-rotated. Stored at
 * `~/.cairn/logs/cairn-<YYYY-MM-DD>.jsonl`.
 *
 * Event shape:
 *   { ts, ts_iso, level, component, event, ...details }
 *
 * Logger is fire-and-forget — NEVER blocks the caller, NEVER throws,
 * NEVER touches the renderer DOM. Disk write failures are swallowed
 * silently (worst case: the user loses observability, not data).
 *
 * Secrets / tokens / api keys MUST NOT be passed in details. Callers
 * responsible. A future iteration may add automatic redaction.
 *
 * Reading:
 *   tail -f ~/.cairn/logs/cairn-2026-05-14.jsonl | jq .
 *   grep '"component":"mentor-tick"' ~/.cairn/logs/cairn-2026-05-14.jsonl
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LOG_DIR = path.join(os.homedir(), '.cairn', 'logs');

function _logFile() {
  // Rotate daily by date in ISO YYYY-MM-DD.
  const day = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `cairn-${day}.jsonl`);
}

let _ready = false;
function _ensure() {
  if (_ready) return true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    _ready = true;
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Write one structured event.
 *
 * @param {string} component  e.g. 'panel' | 'mentor-tick' | 'dispatch' | 'ipc' | 'registry'
 * @param {string} event      short event name (snake_case)
 * @param {object} [details]  event-specific fields (no secrets)
 * @param {string} [level]    'info' | 'warn' | 'error' (default 'info')
 */
function log(component, event, details, level) {
  try {
    if (!_ensure()) return;
    const entry = Object.assign(
      {
        ts: Date.now(),
        ts_iso: new Date().toISOString(),
        level: level || 'info',
        component: component || 'unknown',
        event: event || 'unspecified',
      },
      details && typeof details === 'object' ? details : {},
    );
    fs.appendFileSync(_logFile(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (_e) {
    // Logger NEVER blocks the caller. Silent failure is the contract.
    // BUT we DO need to forget our mkdir-success cache: if the directory
    // was deleted at runtime, every subsequent append will keep failing
    // unless _ensure() re-tries the mkdir. So invalidate on any throw —
    // worst case we mkdirSync an existing dir (recursive:true is a noop).
    _ready = false;
  }
}

/**
 * Convenience wrappers.
 */
function info(component, event, details)  { log(component, event, details, 'info'); }
function warn(component, event, details)  { log(component, event, details, 'warn'); }
function error(component, event, details) { log(component, event, details, 'error'); }

/**
 * For ad-hoc tests / inspection. Returns absolute path to today's log file
 * (file may not exist yet if no events written today).
 */
function currentLogPath() {
  _ensure();
  return _logFile();
}

/**
 * Returns the latest N events from today's log file (or all if fewer).
 * Used by smoke tests + future panel "View log" surface.
 */
function tail(n) {
  try {
    const fp = _logFile();
    if (!fs.existsSync(fp)) return [];
    const raw = fs.readFileSync(fp, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const last = lines.slice(-Math.max(1, n || 10));
    return last.map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
  } catch (_e) {
    return [];
  }
}

module.exports = {
  log,
  info,
  warn,
  error,
  currentLogPath,
  tail,
  LOG_DIR,
};
