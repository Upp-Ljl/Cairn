import {
  registerProcess,
  heartbeat,
  listProcesses,
  getProcess,
} from '../../../daemon/dist/storage/repositories/processes.js';
import type { Workspace } from '../workspace.js';

// ---------------------------------------------------------------------------
// Arg types
// ---------------------------------------------------------------------------

export interface RegisterProcessArgs {
  agent_id: string;
  agent_type: string;
  capabilities?: string[] | null;
  /** Override heartbeat TTL in ms. Defaults to 60000 (1 minute). */
  heartbeat_ttl?: number;
}

export interface HeartbeatArgs {
  agent_id: string;
}

export interface ListProcessesArgs {
  /** Include DEAD agents in the result. Default: false. */
  include_dead?: boolean;
}

export interface GetProcessArgs {
  agent_id: string;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export function toolRegisterProcess(ws: Workspace, args: RegisterProcessArgs) {
  const input: Parameters<typeof registerProcess>[1] = {
    agentId: args.agent_id,
    agentType: args.agent_type,
    capabilities: args.capabilities ?? null,
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
  const process = heartbeat(ws.db, args.agent_id);
  if (process === null) {
    return {
      ok: false,
      error: `agent not registered: ${args.agent_id}`,
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
  const process = getProcess(ws.db, args.agent_id);
  if (process === null) {
    return {
      ok: false,
      error: `agent not registered: ${args.agent_id}`,
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
