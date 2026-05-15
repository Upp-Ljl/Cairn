'use strict';

/**
 * claude-settings-config.cjs — Per-spawn `--settings <file>` builder for
 * Claude Code's hook system.
 *
 * Reference: https://github.com/smithersai/claude-p uses this same
 * technique to drive an interactive `claude` programmatically. Their
 * wrapper is macOS/Linux-only (forkpty); we use the headless
 * stream-json mode + hooks to get the same turn-completion signal on
 * Windows.
 *
 * Spike: `D:/lll/cairn/scripts/spike-claude-hooks.mjs` proved on
 * Windows 11 (9.9s) that:
 *   - `claude --settings <file> --include-hook-events --output-format stream-json`
 *     fires SessionStart + Stop hooks, command stdin gets the full
 *     payload (transcript_path, last_assistant_message, session_id, ...),
 *     and CC emits `{type:"system", subtype:"hook_started"|"hook_response",
 *     hook_name, hook_event, session_id, output, stdout, stderr,
 *     exit_code, outcome}` events into stdout NDJSON.
 *
 * Hook-command design (dual-channel, Q2 decision = strategy (c)):
 *   1. read stdin → payload JSON from CC
 *   2. append to disk: `~/.cairn/worker-runs/<runId>/hook-events.jsonl`
 *      (durable audit trail; survives CC crash mid-flush)
 *   3. echo payload back on stdout → CC captures into
 *      hook_response.stdout → arrives in NDJSON event in real time
 *      (zero-disk-hop path for the launcher)
 *
 * Windows portability (R1): the inner command is `node -e "<inline>"`.
 * Path escaping uses JSON.stringify() so back-slashes survive both
 * shell parsing and JSON parsing. Spike-verified.
 *
 * No new npm deps. Mirrors the lifecycle of
 * `claude-mcp-config.cjs::buildMcpConfigFile` so the launcher can
 * treat them symmetrically (build → spawn → cleanup on exit).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** Where the hook-events audit file goes. Mirrors worker-runs layout. */
function hookEventsFile(runId, home) {
  const base = home || os.homedir();
  return path.join(base, '.cairn', 'worker-runs', runId, 'hook-events.jsonl');
}

/**
 * Build the `node -e` command string the hook will execute. Three steps:
 *   1. Slurp stdin to s
 *   2. Best-effort appendFileSync to hookEventsFile (audit trail)
 *   3. Best-effort process.stdout.write(s) so CC's hook_response NDJSON
 *      gets the payload in `stdout` (realtime fast-path)
 *
 * Path escaping: JSON.stringify(filePath) emits a JSON string literal
 * with all backslashes doubled, valid inside a double-quoted shell
 * argument. Single-quoted JS strings inside guarantee no further
 * escaping needed. See R1 in plan + spike line 38.
 *
 * Defensive: both writes are wrapped in try/catch so a disk-full or
 * permission error doesn't fail the hook (and therefore doesn't make
 * CC think its turn failed).
 */
function _hookCommand(hookPayloadFile) {
  // Embed the path as a JS *single-quoted* string. The outer command
  // is `node -e "..."` (double-quoted shell argument); on Windows
  // cmd.exe parses inner `"` as the close of the outer quote, so any
  // double-quoted JS string inside truncates the eval mid-statement.
  // 2026-05-15: this exact bug fired on every Mode A spawn — the eval
  // truncated at `dirname(` and the hook produced a SyntaxError.
  // Single-quoted JS strings are accepted by V8 and contain no `"`,
  // so the outer shell wrapper stays balanced. Backslashes in
  // Windows paths must still be doubled so the JS source parses them
  // as literal `\` (not start-of-escape-sequence).
  const escapedPath = "'" + hookPayloadFile.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  return [
    `node -e "`,
    `let s='';`,
    `process.stdin.on('data',d=>s+=d);`,
    `process.stdin.on('end',()=>{`,
      `try{require('fs').mkdirSync(require('path').dirname(${escapedPath}),{recursive:true})}catch(_e){}`,
      `try{require('fs').appendFileSync(${escapedPath},s+'\\n')}catch(_e){}`,
      `try{process.stdout.write(s)}catch(_e){}`,
    `});`,
    `"`,
  ].join('');
}

/**
 * Build the settings.json contents. Exposed for tests.
 *
 * Schema mirrors what Claude Code expects: `hooks.<EventName>` is an
 * array of `{ hooks: [{ type: "command", command: "<shell>" }] }`
 * entries. Spike + smithersai/claude-p both use this shape.
 *
 * We register two hooks:
 *   - SessionStart  — fires once on CC startup. Useful for capturing
 *                     session_id ASAP (before any turn) — but the
 *                     launcher's primary signal is Stop.
 *   - Stop          — fires when CC finishes generating a turn. THIS
 *                     is the turn-done signal. Payload contains
 *                     transcript_path + last_assistant_message +
 *                     session_id + stop_hook_active.
 */
function _buildSettingsObject(hookPayloadFile) {
  const cmd = _hookCommand(hookPayloadFile);
  return {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: cmd }] },
      ],
      Stop: [
        { hooks: [{ type: 'command', command: cmd }] },
      ],
    },
  };
}

/**
 * Build a per-spawn settings.json file in tmpDir (default: os.tmpdir()).
 * Returns { ok, tempPath, hookPayloadFile, cleanup } or { ok: false, error }.
 *
 * Lifecycle: caller passes tempPath as `--settings <tempPath>` argv,
 * then invokes cleanup() when the child exits. Mirrors
 * claude-mcp-config.cjs::buildMcpConfigFile.
 *
 * `runId` is required so the audit file is named per-run and doesn't
 * collide across concurrent spawns (which Mode A / Architecture B will
 * have).
 *
 * @param {{ runId: string, home?: string, tmpDir?: string }} input
 * @returns {{ ok: true, tempPath: string, hookPayloadFile: string, cleanup: () => void }
 *          | { ok: false, error: string }}
 */
function buildSettingsConfigFile(input) {
  const o = input || {};
  if (!o.runId || typeof o.runId !== 'string') {
    return { ok: false, error: 'runId_required' };
  }
  const tmpDir = o.tmpDir || os.tmpdir();
  const tempPath = path.join(tmpDir, `cairn-claude-settings-${o.runId}.json`);
  const hookPayloadFile = hookEventsFile(o.runId, o.home);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.unlinkSync(tempPath); } catch (_e) {}
  };

  try {
    fs.writeFileSync(tempPath, JSON.stringify(_buildSettingsObject(hookPayloadFile), null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: 'write_failed: ' + ((e && e.message) || String(e)) };
  }

  return { ok: true, tempPath, hookPayloadFile, cleanup };
}

module.exports = {
  buildSettingsConfigFile,
  // Exposed for tests:
  _hookCommand,
  _buildSettingsObject,
  _hookEventsFile: hookEventsFile,
};
