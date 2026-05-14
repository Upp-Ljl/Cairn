'use strict';

/**
 * claude-mcp-config.cjs — build a per-spawn MCP config file for Mode A.
 *
 * Phase 3 of the stream-json switch (subagent B reorder 2026-05-14: 1→3→2).
 * --resume (Phase 2) needs stable MCP attachment across resumes, so the
 * MCP config has to be deterministic per (project, plan) — that's what
 * this module gives us.
 *
 * What we do:
 *   1. Read `<project_root>/.mcp.json` if it exists (passes through any
 *      project-specific MCP servers the user wired up — notion, github,
 *      etc).
 *   2. Inject a canonical `cairn-wedge` entry pointing at THIS install's
 *      `packages/mcp-server/dist/index.js` (computed from __dirname).
 *      Override-on-conflict: even if the project's .mcp.json has a
 *      cairn-wedge entry, we replace it with our canonical path so a
 *      stale config can't strand the spawn.
 *   3. Write the merged config to `os.tmpdir()/cairn-mcp-<runId>.json`.
 *   4. Return `{ tempPath, cleanup }`. Caller invokes cleanup() on
 *      child exit.
 *
 * Spawn argv then carries `--mcp-config <tempPath> --strict-mcp-config`.
 * `--strict-mcp-config` makes CC fail loud if the file is malformed
 * (vs silently ignoring it) — we want a loud failure during Mode A so
 * the panel can surface it.
 *
 * Non-goals (Phase 3):
 *   - Validation of MCP server entries (CC validates at boot)
 *   - GC of stale temp files (Phase 3.5; for now we rely on OS tmp
 *     cleanup + per-spawn cleanup() on child exit)
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cairnLog = require('./cairn-log.cjs');

/**
 * Canonical cairn-wedge MCP server entry. Computed from this module's
 * location so it's correct across dev (D:/lll/cairn/...) and any
 * future production layout that keeps the desktop-shell + mcp-server
 * sibling relationship inside packages/.
 */
function _canonicalCairnWedgeEntry() {
  // __dirname = .../packages/desktop-shell
  const mcpServerDist = path.resolve(__dirname, '..', 'mcp-server', 'dist', 'index.js');
  return {
    command: 'node',
    args: [mcpServerDist],
  };
}

/**
 * Read project-local .mcp.json if it exists. Returns the parsed
 * `mcpServers` map or {} on any failure (missing, malformed, etc).
 * We swallow errors here — a broken project .mcp.json should not
 * abort Mode A spawning. Cairn's own entry is the only one that
 * matters for kernel state work.
 */
function _readProjectMcpConfig(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') return {};
  const p = path.join(projectRoot, '.mcp.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (_e) {
    return {}; // missing file is the common case — silent.
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      return parsed.mcpServers;
    }
    cairnLog.warn('claude-mcp-config', 'project_mcp_json_no_servers', {
      path: p,
      reason: 'parsed but missing or malformed mcpServers',
    });
  } catch (e) {
    // Malformed JSON exists — warn so users debugging "where did my
    // notion/github MCP go?" find the cause in the log.
    cairnLog.warn('claude-mcp-config', 'project_mcp_json_parse_failed', {
      path: p,
      message: (e && e.message) || String(e),
    });
  }
  return {};
}

/**
 * @param {{ projectRoot: string, runId: string, tmpDir?: string }} input
 * @returns {{ ok: true, tempPath: string, cleanup: ()=>void, serverCount: number, projectHadCairnWedge: boolean }
 *           | { ok: false, error: string }}
 */
function buildMcpConfigFile(input) {
  const o = input || {};
  if (!o.runId || typeof o.runId !== 'string') {
    return { ok: false, error: 'runId_required' };
  }
  const tmpRoot = o.tmpDir || os.tmpdir();
  const tempPath = path.join(tmpRoot, 'cairn-mcp-' + o.runId + '.json');

  const projectServers = _readProjectMcpConfig(o.projectRoot);
  const projectHadCairnWedge = Object.prototype.hasOwnProperty.call(projectServers, 'cairn-wedge');

  // Merge: project entries first, cairn-wedge override LAST so it wins.
  const merged = Object.assign({}, projectServers, {
    'cairn-wedge': _canonicalCairnWedgeEntry(),
  });

  const config = { mcpServers: merged };

  try {
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    cairnLog.error('claude-mcp-config', 'write_failed', {
      run_id: o.runId,
      temp_path: tempPath,
      message: (e && e.message) || String(e),
    });
    return { ok: false, error: 'write_failed' };
  }

  const cleanup = () => {
    try { fs.unlinkSync(tempPath); } catch (_e) { /* already gone or locked */ }
  };

  return {
    ok: true,
    tempPath,
    cleanup,
    serverCount: Object.keys(merged).length,
    projectHadCairnWedge,
  };
}

module.exports = {
  buildMcpConfigFile,
  // Exposed for tests
  _readProjectMcpConfig,
  _canonicalCairnWedgeEntry,
};
