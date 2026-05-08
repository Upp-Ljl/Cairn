import type { Workspace } from './workspace.js';
import { registerProcess, heartbeat } from '../../daemon/dist/storage/repositories/processes.js';

/**
 * Boot-time presence integration.
 *
 * When mcp-server starts, register the SESSION_AGENT_ID into the
 * `processes` table and emit a heartbeat every `intervalMs`. This
 * exists so that any panel / inspector reader can answer "which
 * agents are alive on this machine right now?" without depending on
 * the user's prompt-template discipline (which is what the
 * `cairn.process.register` and `cairn.process.heartbeat` MCP tools
 * already provide for explicit calls).
 *
 * Strict scope (Project-Aware Live Panel plan §3.4):
 *   - presence-only; no orchestration, no decision-making, no new MCP tool
 *   - reuses existing daemon repository functions (registerProcess +
 *     heartbeat); no schema change
 *   - graceful exit: best-effort tear-down, fall back to the daemon's
 *     staleness sweeper (heartbeat_ttl 60s) if the process dies hard
 *
 * The MCP tools `cairn.process.register` and `cairn.process.heartbeat`
 * remain unchanged — agents may still call them explicitly. Boot-time
 * presence and explicit calls coexist (registerProcess uses
 * INSERT OR REPLACE, so the latest call wins; this is intentional).
 */

export interface PresenceOptions {
  /** Heartbeat tick interval in ms. Default 30000 (30s). */
  intervalMs?: number;
  /**
   * Whether to install a `beforeExit` handler that tears presence down
   * on graceful Node exit. Default true. Tests that emit beforeExit
   * synthetically may want false to avoid the synthetic emit calling
   * stop() out from under them. Note: presence does NOT install
   * SIGINT/SIGTERM handlers — registering those would override Node's
   * default behavior of exiting on Ctrl+C, swallowing the user's
   * shutdown intent. The 30s interval is already `.unref()`'d so it
   * never keeps the process alive on its own; relying on Node's
   * default signal handling is the correct shape for a long-running
   * stdio server.
   */
  installBeforeExitHandler?: boolean;
  /** Override agent_type. Default 'mcp-server'. */
  agentType?: string;
  /** Override capabilities. Default empty array. */
  capabilities?: string[];
  /** Override heartbeat_ttl in ms. Default left to daemon repo (60_000). */
  heartbeatTtlMs?: number;
}

export interface PresenceHandle {
  /** Cancels the heartbeat interval and removes signal handlers. */
  stop: () => void;
  /** Forces an immediate heartbeat tick. Useful for tests. */
  tick: () => void;
}

const DEFAULT_INTERVAL_MS = 30_000;

export function startPresence(
  ws: Workspace,
  opts: PresenceOptions = {},
): PresenceHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const installBeforeExitHandler = opts.installBeforeExitHandler ?? true;
  const agentType = opts.agentType ?? 'mcp-server';
  const capabilities = opts.capabilities ?? [];

  // Boot-time register. INSERT OR REPLACE semantics on the daemon side
  // make this idempotent across mcp-server restarts: re-registering the
  // same agent_id resets last_heartbeat to now() and status to ACTIVE.
  try {
    registerProcess(ws.db, {
      agentId: ws.agentId,
      agentType,
      capabilities,
      ...(opts.heartbeatTtlMs != null ? { heartbeatTtl: opts.heartbeatTtlMs } : {}),
    });
  } catch (err) {
    // Don't crash mcp-server boot just because presence failed — the
    // panel will simply not see this session, but tools still work.
    // eslint-disable-next-line no-console
    console.error('[presence] boot register failed:', err);
  }

  let stopped = false;

  const tick = () => {
    if (stopped) return;
    try {
      heartbeat(ws.db, ws.agentId);
    } catch (err) {
      // Heartbeat failures are non-fatal; the staleness sweeper will
      // eventually mark the row DEAD.
      // eslint-disable-next-line no-console
      console.error('[presence] heartbeat failed:', err);
    }
  };

  const interval = setInterval(tick, intervalMs);
  // Don't keep the event loop alive purely for the heartbeat —
  // mcp-server's stdio transport is the real "stay alive" signal.
  if (typeof interval === 'object' && interval !== null && 'unref' in interval) {
    (interval as { unref: () => void }).unref();
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    if (installBeforeExitHandler) {
      process.removeListener('beforeExit', onBeforeExit);
    }
  };

  function onBeforeExit() {
    stop();
  }

  if (installBeforeExitHandler) {
    process.once('beforeExit', onBeforeExit);
  }

  return { stop, tick };
}
