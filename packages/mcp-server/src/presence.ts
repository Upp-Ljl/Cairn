import { basename, join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Workspace } from './workspace.js';
import { registerProcess, heartbeat } from '../../daemon/dist/storage/repositories/processes.js';
import { putScratch, getScratch } from '../../daemon/dist/storage/repositories/scratchpad.js';
import { sessionNameKey } from './tools/session-name.js';

/**
 * Minimal mcp-server-side mirror of desktop-shell/cairn-log.cjs.
 * Writes to the same `~/.cairn/logs/cairn-<date>.jsonl` so the panel
 * "View log" surface can read events from both processes in one feed.
 * Fire-and-forget; never throws.
 */
function logEvent(component: string, event: string, details: Record<string, unknown>): void {
  try {
    const dir = join(homedir(), '.cairn', 'logs');
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = join(dir, `cairn-${day}.jsonl`);
    const entry = {
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      level: 'info',
      component,
      event,
      ...details,
    };
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_e) {
    /* never block presence */
  }
}

/**
 * Build the default `capabilities` tag set for a session's presence row.
 *
 * `processes.capabilities` is a JSON-encoded `string[]` (no schema
 * change in this batch — see Real Agent Presence v2 plan §6). We
 * encode session metadata as `key:value` strings inside that array so
 * the desktop panel can attribute the row to a registered project
 * without depending on agent_id alone.
 *
 * Tags emitted (production):
 *   client:mcp-server
 *   cwd:<process cwd>
 *   git_root:<git toplevel of cwd, or cwd if not in a git repo>
 *   pid:<process.pid>
 *   host:<hostname>
 *   session:<12-hex session suffix>
 *
 * The tags are descriptive only — they're never parsed by the daemon
 * and have no effect on the `agent_id` PK or status enum.
 */
export function defaultPresenceCapabilities(ws: Workspace): string[] {
  return [
    'client:mcp-server',
    `cwd:${ws.cwd}`,
    `git_root:${ws.gitRoot}`,
    `pid:${process.pid}`,
    `host:${ws.host}`,
    `session:${ws.sessionId}`,
  ];
}

/**
 * Merge two capability arrays preserving order (defaults first), with
 * de-duplication on exact-string equality. Shared by:
 *   - `startPresence` (boot-time + heartbeat re-registers)
 *   - `toolRegisterProcess` for self-registration (cairn.process.register
 *     called for ws.agentId — defaults must survive INSERT OR REPLACE)
 * Non-string entries in `extras` are silently dropped.
 */
export function mergeCapabilities(
  defaults: string[],
  extras: string[] | null | undefined,
): string[] {
  if (!extras || extras.length === 0) return defaults.slice();
  const seen = new Set<string>(defaults);
  const out = defaults.slice();
  for (const e of extras) {
    if (typeof e !== 'string') continue;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

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
  /**
   * Extra `capabilities` tags appended to the system-managed defaults
   * (client / cwd / git_root / pid / host / session — see
   * defaultPresenceCapabilities). Pass an array of feature strings
   * (e.g. `['scratch','rewind']`) and they'll be merged in alongside
   * the attribution tags. Default: no extras.
   */
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
  // System-managed attribution tags + caller-provided extras.
  // The system tags are how the desktop panel attributes a session to
  // a registered project (see desktop-shell/project-queries.cjs); they
  // are NOT optional in production. Tests that assert specific shapes
  // should use `arrayContaining` instead of strict equality.
  // Same merge helper is reused by toolRegisterProcess for the
  // self-registration path so the two paths can never disagree.
  const capabilities = mergeCapabilities(
    defaultPresenceCapabilities(ws),
    opts.capabilities,
  );

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

  // Mode A/B reframe (CEO 2026-05-14): "session 尽量在初期就有个比较
  // 清晰的命名，不要直接用用户不友好的 uuid 之类的". Write a default
  // session name derived from the cwd basename + HH:MM iff none exists
  // yet. Agents can override via `cairn.session.name` (set_by:'agent').
  // We tag set_by:'auto' so override paths know they can clobber freely.
  try {
    const existing = getScratch(ws.db, sessionNameKey(ws.agentId));
    const hasAgentName =
      existing &&
      typeof existing === 'object' &&
      typeof (existing as { name?: unknown }).name === 'string' &&
      (existing as { name?: unknown }).name !== '';
    if (!hasAgentName) {
      const project = basename(ws.gitRoot || ws.cwd) || 'cairn';
      // toISOString() is spec-guaranteed UTC; locale-stable across hosts.
      const hhmm = new Date().toISOString().slice(11, 16);
      const name = `${project} · ${hhmm}`;
      putScratch(ws.db, ws.blobRoot, {
        key: sessionNameKey(ws.agentId),
        value: {
          name,
          set_at: Date.now(),
          set_by: 'auto' as const,
        },
      });
      logEvent('session/naming', 'auto_named', {
        agent_id: ws.agentId,
        name,
        cwd: ws.cwd,
        git_root: ws.gitRoot,
      });
    }
  } catch (err) {
    // Auto-name is best-effort. Panel falls back to hex agent_id.
    // eslint-disable-next-line no-console
    console.error('[presence] auto-name failed:', err);
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
