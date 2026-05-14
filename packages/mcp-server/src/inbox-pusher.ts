/**
 * inbox-pusher.ts — server-initiated push for agent_inbox.
 *
 * Subagent verdict 2026-05-14: Cairn → CC channel was pull-only (CC
 * polls agent_inbox between turns). When CC is idle, push never lands.
 * CEO 鸭总 escalated: "一定是 cairn 能主动推送任务、消息才可以". MCP
 * protocol natively supports server-initiated `notifications/message`
 * over the same stdio pipe that already exists — this module finally
 * uses that capability.
 *
 * Design:
 *   - mcp-server starts a 1s poll of its own SQLite scratchpad
 *     (cheap; the file is already open and indexed).
 *   - Filters `key LIKE 'agent_inbox/<MY_SESSION_AGENT_ID>/%'` AND
 *     `created_at > lastSeenTs` so only fresh rows fire.
 *   - For each new row → `server.sendLoggingMessage(...)` with
 *     `data.type = 'cairn_steer'`, the inbox key, and a brief preview.
 *   - The MCP client (CC) receives a `notifications/message` JSON-RPC
 *     frame. CC's behavior is empirically tested; if CC surfaces it
 *     into the agent's context, Mode A's loop closes without
 *     between-turns polling.
 *
 * Idempotence: lastSeenTs starts at mcp-server boot time. Already-
 * present old inbox rows are NOT replayed on boot — those were either
 * already consumed in a previous session OR they're stale. mentor-tick
 * 端的 reconcileInbox 仍然负责重补孤儿 dispatch；这里只管"现在/未来"。
 *
 * Read-only on SQLite. No new schema. No new MCP tool. No new dep.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Workspace } from './workspace.js';

const POLL_INTERVAL_MS = 1000;

export interface InboxPusherHandle {
  /** Stop the polling loop. */
  stop: () => void;
}

interface InboxRow {
  key: string;
  value_json: string | null;
  created_at: number;
}

export function startInboxPusher(server: Server, ws: Workspace): InboxPusherHandle {
  const keyPrefix = `agent_inbox/${ws.agentId}/`;
  // Start cutoff at boot time so we don't replay historical inbox rows.
  // Use clock skew margin of 500ms so a row inserted "right at" boot
  // (timestamp == bootTs) IS replayed exactly once instead of being
  // lost to a strict-greater-than comparison.
  let lastSeenTs = Date.now() - 500;
  let stopped = false;

  // Track keys we've already pushed to handle the edge where two rows
  // share the same created_at (SQLite ms granularity). Without this,
  // we'd skip the second row whose ts equals the first's.
  const pushedKeys = new Set<string>();

  const select = ws.db.prepare(
    `SELECT key, value_json, created_at FROM scratchpad
     WHERE key LIKE ? AND created_at >= ?
     ORDER BY created_at ASC`,
  );

  const tick = () => {
    if (stopped) return;
    let rows: InboxRow[] = [];
    try {
      rows = select.all(keyPrefix + '%', lastSeenTs) as InboxRow[];
    } catch (_e) {
      // Tables might not exist yet at very-first boot. Try again later.
      return;
    }
    for (const r of rows) {
      if (pushedKeys.has(r.key)) continue;
      pushedKeys.add(r.key);
      if (r.created_at > lastSeenTs) lastSeenTs = r.created_at;
      let preview: unknown = null;
      try {
        preview = r.value_json ? JSON.parse(r.value_json) : null;
      } catch (_e) { preview = r.value_json; }
      // Fire MCP notification. The SDK swallows network errors silently
      // (stdio transport rarely throws). We add our own try/catch so a
      // misbehaving transport doesn't crash the tick loop.
      try {
        // sendLoggingMessage emits `notifications/message` per MCP spec.
        // data may be any JSON value — clients can pattern-match on
        // `type === 'cairn_steer'` to decide how to surface it.
        server.sendLoggingMessage({
          level: 'info',
          logger: 'cairn',
          data: {
            type: 'cairn_steer',
            inbox_key: r.key,
            agent_id: ws.agentId,
            ts: r.created_at,
            preview,
          },
        });
      } catch (e) {
        // Last resort: log to stderr so a dev tailing the mcp-server
        // stderr can see the push attempted + failed. CEO's panel won't.
        // eslint-disable-next-line no-console
        console.error(
          '[inbox-pusher] sendLoggingMessage threw',
          (e as Error)?.message || e,
        );
      }
    }
    // Trim pushedKeys to keep memory bounded if the user never restarts
    // mcp-server. We trim conservatively — only drop entries with
    // created_at much older than current lastSeenTs.
    if (pushedKeys.size > 1000) {
      // Clearing is fine: lastSeenTs has moved forward past them, so
      // they can't be re-fetched by future SELECTs anyway.
      pushedKeys.clear();
    }
  };

  const interval = setInterval(tick, POLL_INTERVAL_MS);
  // Don't block process exit on this timer; mcp-server's stdio pipe
  // is the real liveness signal.
  if (typeof (interval as { unref?: () => void }).unref === 'function') {
    (interval as { unref: () => void }).unref();
  }

  // Optional: drain once immediately so messages written between
  // workspace-open and setInterval-first-fire aren't delayed a second.
  tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}
