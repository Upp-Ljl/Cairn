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
import { toolListConflicts, toolResolveConflict } from './tools/conflict.js';
import { toolInspectorQuery } from './tools/inspector.js';
import { toolDispatchRequest, toolDispatchConfirm } from './tools/dispatch.js';
import { toolCreateTask, toolGetTask, toolListTasks, toolStartAttempt, toolCancelTask, toolBlockTask, toolAnswerBlocker, toolResumePacket, toolSubmitForReview } from './tools/task.js';
import { toolEvaluateOutcome, toolTerminalFailOutcome } from './tools/outcomes.js';

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
    description: 'Register an agent on the process bus. Re-registering with the same agent_id resets the heartbeat timer. When omitted, agent_id defaults to the session id (sha1 of host+cwd) and agent_type defaults to "session".',
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
    },
  },
  {
    name: 'cairn.process.heartbeat',
    description: 'Update last_heartbeat for the agent. Keeps the agent ACTIVE; reactivates a DEAD agent. When agent_id is omitted, defaults to the session id (sha1 of host+cwd).',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Unique identifier for the agent' },
      },
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
    description: 'Get the current status of a specific agent by agent_id. When agent_id is omitted, defaults to the session id (sha1 of host+cwd).',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Unique identifier for the agent' },
      },
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
    name: 'cairn.conflict.resolve',
    description: '解决一个冲突（OPEN/PENDING_REVIEW → RESOLVED）。可选 resolution 文本记录解决理由。',
    inputSchema: {
      type: 'object',
      properties: {
        conflict_id: {
          type: 'string',
          description: 'The ULID id of the conflict to resolve.',
        },
        resolution: {
          type: 'string',
          description: 'Optional human-written explanation of how the conflict was resolved.',
        },
      },
      required: ['conflict_id'],
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
    name: 'cairn.outcomes.evaluate',
    description: '同步评估 outcome（阻塞直到所有 DSL 原语跑完）。只接受 PENDING 状态的 outcome。FAIL 状态须先调 cairn.task.submit_for_review 重置。',
    inputSchema: {
      type: 'object',
      properties: {
        outcome_id: {
          type: 'string',
          description: 'outcome 的 ULID id（来自 cairn.task.submit_for_review 返回值）',
        },
      },
      required: ['outcome_id'],
    },
  },
  {
    name: 'cairn.outcomes.terminal_fail',
    description: '终判一个 PENDING outcome 为 TERMINAL_FAIL，task 转 FAILED。用于用户主动放弃路径。FAIL 状态时应调 cairn.task.cancel 而非此工具。',
    inputSchema: {
      type: 'object',
      properties: {
        outcome_id: {
          type: 'string',
          description: 'outcome 的 ULID id',
        },
        reason: {
          type: 'string',
          description: '终判原因（写入 evaluation_summary）',
        },
      },
      required: ['outcome_id', 'reason'],
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
  {
    name: 'cairn.task.create',
    description: '创建一个新的 Task Capsule（初始状态 PENDING）。',
    inputSchema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: '任务意图描述（必填）',
        },
        parent_task_id: {
          type: 'string',
          description: '父任务 ID（可选，用于建立任务树）',
        },
        metadata: {
          type: 'object',
          description: '任意附加元数据（可选）',
        },
        created_by_agent_id: {
          type: 'string',
          description: '创建者 agent ID。省略时自动使用 SESSION_AGENT_ID。',
        },
      },
      required: ['intent'],
    },
  },
  {
    name: 'cairn.task.get',
    description: '按 task_id 获取 Task Capsule 详情。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cairn.task.list',
    description: '列出 Task Capsule，支持按 state / parent_task_id / limit 过滤。parent_task_id: null 表示只列根任务。',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          oneOf: [
            {
              type: 'string',
              enum: ['PENDING', 'RUNNING', 'BLOCKED', 'READY_TO_RESUME', 'WAITING_REVIEW', 'DONE', 'FAILED', 'CANCELLED'],
            },
            {
              type: 'array',
              items: {
                type: 'string',
                enum: ['PENDING', 'RUNNING', 'BLOCKED', 'READY_TO_RESUME', 'WAITING_REVIEW', 'DONE', 'FAILED', 'CANCELLED'],
              },
            },
          ],
          description: '按状态过滤（单个或数组）',
        },
        parent_task_id: {
          type: ['string', 'null'],
          description: '按父任务 ID 过滤。传 null 表示只列根任务（parent_task_id IS NULL）。省略表示不过滤。',
        },
        limit: {
          type: 'number',
          description: '最多返回条数',
        },
      },
    },
  },
  {
    name: 'cairn.task.start_attempt',
    description: '将任务从 PENDING（或 READY_TO_RESUME）转为 RUNNING，表示 agent 开始/接力执行。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cairn.task.submit_for_review',
    description: '提交 task 验收（RUNNING → WAITING_REVIEW）并声明验收标准。首次调用必须传 criteria；重复调用省略 criteria 或传相同 criteria 以重置为 PENDING（upsert 语义，LD-12）。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID',
        },
        criteria: {
          description: '验收标准 DSL 数组（JSON）。首次调用必传；重复调用省略或传相同值。',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cairn.task.cancel',
    description: '取消一个任务，原子写入 cancel_reason 和 cancelled_at 到 metadata。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
        reason: { type: 'string', description: '取消原因（可选）' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cairn.task.answer',
    description: '回答一个 blocker。当该 task 所有 blocker 均已回答时，task 自动升级到 READY_TO_RESUME。answered_by 省略时使用 SESSION_AGENT_ID。',
    inputSchema: {
      type: 'object',
      properties: {
        blocker_id: { type: 'string', description: 'Blocker ID（来自 cairn.task.block 或 resume_packet 返回值）' },
        answer: { type: 'string', description: '对 blocker 问题的回答' },
        answered_by: { type: 'string', description: '回答者 agent_id 或 "user"。省略时自动使用 SESSION_AGENT_ID。' },
      },
      required: ['blocker_id', 'answer'],
    },
  },
  {
    name: 'cairn.task.block',
    description: '将 RUNNING 任务转为 BLOCKED 并记录一个 blocker。raised_by 省略时使用 SESSION_AGENT_ID。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
        question: { type: 'string', description: 'blocker 的问题描述' },
        context_keys: {
          type: 'array',
          items: { type: 'string' },
          description: '相关 scratchpad key 列表（可选）',
        },
        raised_by: { type: 'string', description: '提出 blocker 的 agent_id。省略时自动使用 SESSION_AGENT_ID。' },
      },
      required: ['task_id', 'question'],
    },
  },
  {
    name: 'cairn.task.resume_packet',
    description: '生成结构化接力 packet（只读）。包含 task 状态、open/answered blockers、scratchpad keys、最近 checkpoint sha 和 audit trail。不修改任何状态。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
      },
      required: ['task_id'],
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
    case 'cairn.conflict.list':        result = toolListConflicts(ws, a); break;
    case 'cairn.conflict.resolve':     result = toolResolveConflict(ws, a); break;
    case 'cairn.inspector.query':     result = toolInspectorQuery(ws, a); break;
    case 'cairn.outcomes.evaluate':      result = await toolEvaluateOutcome(ws, a); break;
    case 'cairn.outcomes.terminal_fail': result = toolTerminalFailOutcome(ws, a); break;
    case 'cairn.dispatch.request':    result = await toolDispatchRequest(ws, a); break;
    case 'cairn.dispatch.confirm':    result = toolDispatchConfirm(ws, a); break;
    case 'cairn.task.create':         result = toolCreateTask(ws, a); break;
    case 'cairn.task.get':            result = toolGetTask(ws, a); break;
    case 'cairn.task.list':           result = toolListTasks(ws, a); break;
    case 'cairn.task.start_attempt':  result = toolStartAttempt(ws, a); break;
    case 'cairn.task.submit_for_review': result = toolSubmitForReview(ws, a); break;
    case 'cairn.task.cancel':         result = toolCancelTask(ws, a); break;
    case 'cairn.task.block':          result = toolBlockTask(ws, a); break;
    case 'cairn.task.answer':         result = toolAnswerBlocker(ws, a); break;
    case 'cairn.task.resume_packet':  result = toolResumePacket(ws, a); break;
    default: throw new Error(`unknown tool: ${name}`);
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());
