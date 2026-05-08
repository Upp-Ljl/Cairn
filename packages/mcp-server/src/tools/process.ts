import {
  registerProcess,
  heartbeat,
  listProcesses,
  getProcess,
} from '../../../daemon/dist/storage/repositories/processes.js';
import type { Workspace } from '../workspace.js';
import { defaultPresenceCapabilities, mergeCapabilities } from '../presence.js';

// ---------------------------------------------------------------------------
// Arg types
// ---------------------------------------------------------------------------

export interface RegisterProcessArgs {
  agent_id?: string;
  agent_type?: string;
  capabilities?: string[] | null;
  /** Override heartbeat TTL in ms. Defaults to 60000 (1 minute). */
  heartbeat_ttl?: number;
}

export interface HeartbeatArgs {
  agent_id?: string;
}

export interface ListProcessesArgs {
  /** Include DEAD agents in the result. Default: false. */
  include_dead?: boolean;
}

export interface GetProcessArgs {
  agent_id?: string;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export function toolRegisterProcess(ws: Workspace, args: RegisterProcessArgs) {
  const effectiveAgentId =
    args.agent_id != null && args.agent_id !== '' ? args.agent_id : ws.agentId;
  // When agent_id was auto-resolved (no explicit id) and no agent_type was provided,
  // default agent_type to "session" so the row is still well-formed.
  const effectiveAgentType =
    args.agent_type != null && args.agent_type !== ''
      ? args.agent_type
      : args.agent_id != null && args.agent_id !== ''
        ? args.agent_type ?? 'session'
        : 'session';

  // Capability resolution (Real Agent Presence v2):
  //   - When the call targets THIS session's agent_id (i.e. the
  //     mcp-server process registering itself, with or without an
  //     explicit id), merge the system attribution tags
  //     (defaultPresenceCapabilities) with whatever the caller passed.
  //     This keeps `git_root:` / `cwd:` / `session:` etc. stable across
  //     explicit `cairn.process.register` calls — without it, an agent
  //     prompt that calls register({}) after boot would INSERT OR REPLACE
  //     with capabilities=null and silently break desktop attribution.
  //   - When the call targets a different agent_id (peer registration),
  //     pass capabilities through as-is. This mcp-server doesn't speak
  //     for that other process; making up tags for it would be wrong.
  const isSelfRegistration = effectiveAgentId === ws.agentId;
  const callerCaps = args.capabilities;
  const effectiveCapabilities: string[] | null = isSelfRegistration
    ? mergeCapabilities(defaultPresenceCapabilities(ws), callerCaps)
    : (callerCaps ?? null);

  const input: Parameters<typeof registerProcess>[1] = {
    agentId: effectiveAgentId,
    agentType: effectiveAgentType,
    capabilities: effectiveCapabilities,
  };
  if (args.heartbeat_ttl !== undefined) {
    input.heartbeatTtl = args.heartbeat_ttl;
  }
  const process = registerProcess(ws.db, input);
  return {
    ok: true,
    agent_id: process.agent_id,
    agent_type: process.agent_type,
    status: process.status,
    registered_at_iso: new Date(process.registered_at).toISOString(),
    last_heartbeat_iso: new Date(process.last_heartbeat).toISOString(),
    capabilities: process.capabilities,
    heartbeat_ttl: process.heartbeat_ttl,
  };
}

export function toolHeartbeat(ws: Workspace, args: HeartbeatArgs) {
  const effectiveAgentId =
    args.agent_id != null && args.agent_id !== '' ? args.agent_id : ws.agentId;
  const process = heartbeat(ws.db, effectiveAgentId);
  if (process === null) {
    return {
      ok: false,
      error: `agent not registered: ${effectiveAgentId}`,
    };
  }
  return {
    ok: true,
    agent_id: process.agent_id,
    status: process.status,
    last_heartbeat: process.last_heartbeat,
    last_heartbeat_iso: new Date(process.last_heartbeat).toISOString(),
  };
}

export function toolListProcesses(ws: Workspace, args: ListProcessesArgs = {}) {
  const statuses = args.include_dead
    ? (['ACTIVE', 'IDLE', 'DEAD'] as const)
    : (['ACTIVE', 'IDLE'] as const);

  const processes = listProcesses(ws.db, { statuses: [...statuses] });
  return {
    items: processes.map((p) => ({
      agent_id: p.agent_id,
      agent_type: p.agent_type,
      status: p.status,
      capabilities: p.capabilities,
      last_heartbeat: p.last_heartbeat,
      last_heartbeat_iso: new Date(p.last_heartbeat).toISOString(),
      registered_at: p.registered_at,
      heartbeat_ttl: p.heartbeat_ttl,
    })),
  };
}

export function toolGetProcess(ws: Workspace, args: GetProcessArgs) {
  const effectiveAgentId =
    args.agent_id != null && args.agent_id !== '' ? args.agent_id : ws.agentId;
  const process = getProcess(ws.db, effectiveAgentId);
  if (process === null) {
    return {
      ok: false,
      error: `agent not registered: ${effectiveAgentId}`,
    };
  }
  return {
    ok: true,
    agent_id: process.agent_id,
    agent_type: process.agent_type,
    status: process.status,
    capabilities: process.capabilities,
    registered_at: process.registered_at,
    registered_at_iso: new Date(process.registered_at).toISOString(),
    last_heartbeat: process.last_heartbeat,
    last_heartbeat_iso: new Date(process.last_heartbeat).toISOString(),
    heartbeat_ttl: process.heartbeat_ttl,
  };
}
