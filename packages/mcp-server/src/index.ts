#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openWorkspace } from './workspace.js';
import { toolWriteScratch, toolReadScratch, toolListScratch, toolDeleteScratch } from './tools/scratchpad.js';
import { toolCreateCheckpoint, toolListCheckpoints } from './tools/checkpoint.js';
import { toolRewindPreview, toolRewindTo } from './tools/rewind.js';
import { toolRegisterProcess, toolHeartbeat, toolListProcesses, toolGetProcess } from './tools/process.js';
import { toolListConflicts } from './tools/conflict.js';
import { toolInspectorQuery } from './tools/inspector.js';
import { toolDispatchRequest, toolDispatchConfirm } from './tools/dispatch.js';

const ws = openWorkspace();

const server = new Server(
  { name: 'cairn-mcp', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: 'cairn.scratchpad.write',
    description: '写入命名草稿到 cairn 持久层',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, content: {} },
      required: ['key', 'content'],
    },
  },
  {
    name: 'cairn.scratchpad.read',
    description: '读取命名草稿',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'cairn.scratchpad.list',
    description: '列出当前会话的所有草稿键名',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cairn.scratchpad.delete',
    description: '删除一个命名草稿（幂等：键不存在也返回 ok）',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        skip_auto_checkpoint: { type: 'boolean' },
      },
      required: ['key'],
    },
  },
  {
    name: 'cairn.checkpoint.create',
    description: '为当前工作目录创建 git-stash checkpoint',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        task_id: { type: 'string', description: 'Optional task tag for filtering checkpoints' },
        agent_id: {
          type: 'string',
          description: 'Optional agent identifier. When supplied, enables FILE_OVERLAP conflict detection against other active agents.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths this checkpoint covers. Used with agent_id for conflict detection.',
        },
      },
    },
  },
  {
    name: 'cairn.checkpoint.list',
    description: '列出已创建的 checkpoints',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cairn.rewind.preview',
    description: '预览 rewind 会影响哪些文件',
    inputSchema: {
      type: 'object',
      properties: { checkpoint_id: { type: 'string' } },
      required: ['checkpoint_id'],
    },
  },
  {
    name: 'cairn.rewind.to',
    description: '回滚文件到指定 checkpoint（不动 .git/HEAD）',
    inputSchema: {
      type: 'object',
      properties: { checkpoint_id: { type: 'string' } },
      required: ['checkpoint_id'],
    },
  },
  {
    name: 'cairn.process.register',
    description: 'Register an agent on the process bus. Re-registering with the same agent_id resets the heartbeat timer.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Unique identifier for the agent' },
        agent_type: { type: 'string', description: 'Type/role of the agent (e.g. "orchestrator", "coder")' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of capability tags',
        },
        heartbeat_ttl: {
          type: 'number',
          description: 'Heartbeat TTL in ms. Defaults to 60000 (1 minute).',
        },
      },
      required: ['agent_id', 'agent_type'],
    },
  },
  {
    name: 'cairn.process.heartbeat',
    description: 'Update last_heartbeat for the agent. Keeps the agent ACTIVE; reactivates a DEAD agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Unique identifier for the agent' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'cairn.process.list',
    description: 'List agents on the process bus. By default returns only ACTIVE and IDLE agents (excludes DEAD).',
    inputSchema: {
      type: 'object',
      properties: {
        include_dead: {
          type: 'boolean',
          description: 'If true, include DEAD agents in the result. Default: false.',
        },
      },
    },
  },
  {
    name: 'cairn.process.status',
    description: 'Get the current status of a specific agent by agent_id.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Unique identifier for the agent' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'cairn.conflict.list',
    description: 'List detected FILE_OVERLAP and other conflicts. Defaults to last 24 hours.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO 8601 timestamp. Only conflicts detected at or after this time are returned.',
        },
      },
    },
  },
  {
    name: 'cairn.inspector.query',
    description: '自然语言查询 Cairn 状态（只读，走关键词 SQL 模板，不走 LLM）。支持 agents / conflicts / checkpoints / scratchpad / dispatch_requests / stats 等查询。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '自然语言查询，如 "active agents"、"open conflicts"、"stats"、"recent dispatch requests" 等。',
          minLength: 1,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'cairn.dispatch.request',
    description: '将自然语言意图路由给合适的 agent。调用 LLM 解析意图并生成执行指令，应用 4 条应用层兜底规则，写入 dispatch_requests（状态 PENDING）。',
    inputSchema: {
      type: 'object',
      properties: {
        nl_intent: {
          type: 'string',
          description: '自然语言任务意图描述（最少 5 个字符）',
          minLength: 5,
        },
        task_id: {
          type: 'string',
          description: '可选任务 ID，用于聚合相关请求',
        },
        target_agent: {
          type: 'string',
          description: '可选：直接指定目标 agent_id（跳过 LLM 选型）',
        },
      },
      required: ['nl_intent'],
    },
  },
  {
    name: 'cairn.dispatch.confirm',
    description: '确认一个 PENDING 派单请求（PENDING → CONFIRMED），并将 generated_prompt 写入 scratchpad。',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: {
          type: 'string',
          description: 'dispatch request 的 ULID id（来自 cairn.dispatch.request 返回值）',
        },
      },
      required: ['request_id'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = (args ?? {}) as any;
  let result: unknown;
  switch (name) {
    case 'cairn.scratchpad.write':  result = toolWriteScratch(ws, a); break;
    case 'cairn.scratchpad.read':   result = toolReadScratch(ws, a); break;
    case 'cairn.scratchpad.list':   result = toolListScratch(ws); break;
    case 'cairn.scratchpad.delete': result = toolDeleteScratch(ws, a); break;
    case 'cairn.checkpoint.create': result = toolCreateCheckpoint(ws, a); break;
    case 'cairn.checkpoint.list':   result = toolListCheckpoints(ws); break;
    case 'cairn.rewind.preview':    result = toolRewindPreview(ws, a); break;
    case 'cairn.rewind.to':         result = toolRewindTo(ws, a); break;
    case 'cairn.process.register':  result = toolRegisterProcess(ws, a); break;
    case 'cairn.process.heartbeat': result = toolHeartbeat(ws, a); break;
    case 'cairn.process.list':      result = toolListProcesses(ws, a); break;
    case 'cairn.process.status':    result = toolGetProcess(ws, a); break;
    case 'cairn.conflict.list':       result = toolListConflicts(ws, a); break;
    case 'cairn.inspector.query':     result = toolInspectorQuery(ws, a); break;
    case 'cairn.dispatch.request':    result = await toolDispatchRequest(ws, a); break;
    case 'cairn.dispatch.confirm':    result = toolDispatchConfirm(ws, a); break;
    default: throw new Error(`unknown tool: ${name}`);
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());
