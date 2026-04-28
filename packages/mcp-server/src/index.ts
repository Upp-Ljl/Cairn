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
      properties: { label: { type: 'string' } },
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
    default: throw new Error(`unknown tool: ${name}`);
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());
