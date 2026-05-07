import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const BINARY = resolve(here, '..', 'dist', 'index.js');

interface JsonRpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class MCPClient {
  private proc: ChildProcess;
  private buf = '';
  private pending = new Map<number | string, (msg: JsonRpc) => void>();
  private nextId = 1;

  constructor(env: NodeJS.ProcessEnv) {
    this.proc = spawn(process.execPath, [BINARY], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpc;
          if (msg.id != null && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          }
        } catch {
          // ignore non-JSON debug lines
        }
      }
    });
    // pipe stderr to test output for debugging
    this.proc.stderr!.on('data', (c: Buffer) => process.stderr.write(c));
  }

  request(method: string, params?: unknown): Promise<JsonRpc> {
    const id = this.nextId++;
    const msg: JsonRpc = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise((resolveFn, rejectFn) => {
      const t = setTimeout(() => rejectFn(new Error(`timeout on ${method}`)), 5000);
      this.pending.set(id, (resp) => {
        clearTimeout(t);
        resolveFn(resp);
      });
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: JsonRpc = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.proc.once('exit', () => resolve());
      this.proc.stdin!.end();
      // safety net
      setTimeout(() => {
        try { this.proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 2000);
    });
  }
}

describe('stdio smoke test — production binary speaks MCP', () => {
  it('initializes, lists 25 tools, write+read+delete roundtrip', async () => {
    const cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-smoke-'));
    const client = new MCPClient({ CAIRN_HOME: cairnRoot });
    try {
      // 1. initialize
      const init = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cairn-smoke', version: '0.0.1' },
      });
      expect(init.result).toBeDefined();
      expect((init.result as any).serverInfo.name).toBe('cairn-mcp');

      // The MCP spec requires the client to send `notifications/initialized` after init.
      client.notify('notifications/initialized');

      // 2. tools/list
      const list = await client.request('tools/list', {});
      const tools = (list.result as any).tools as Array<{ name: string }>;
      expect(tools.map((t) => t.name).sort()).toEqual([
        'cairn.checkpoint.create',
        'cairn.checkpoint.list',
        'cairn.conflict.list',
        'cairn.conflict.resolve',
        'cairn.dispatch.confirm',
        'cairn.dispatch.request',
        'cairn.inspector.query',
        'cairn.process.heartbeat',
        'cairn.process.list',
        'cairn.process.register',
        'cairn.process.status',
        'cairn.rewind.preview',
        'cairn.rewind.to',
        'cairn.scratchpad.delete',
        'cairn.scratchpad.list',
        'cairn.scratchpad.read',
        'cairn.scratchpad.write',
        'cairn.task.answer',
        'cairn.task.block',
        'cairn.task.cancel',
        'cairn.task.create',
        'cairn.task.get',
        'cairn.task.list',
        'cairn.task.resume_packet',
        'cairn.task.start_attempt',
      ]);

      // 3. tools/call cairn.scratchpad.write
      const writeRes = await client.request('tools/call', {
        name: 'cairn.scratchpad.write',
        arguments: { key: 'smoke', content: { ping: 'pong' }, skip_auto_checkpoint: true },
      });
      const writeText = (writeRes.result as any).content[0].text as string;
      expect(JSON.parse(writeText)).toMatchObject({ ok: true, key: 'smoke' });

      // 4. tools/call cairn.scratchpad.read
      const readRes = await client.request('tools/call', {
        name: 'cairn.scratchpad.read',
        arguments: { key: 'smoke' },
      });
      const readText = (readRes.result as any).content[0].text as string;
      expect(JSON.parse(readText)).toEqual({
        key: 'smoke', found: true, value: { ping: 'pong' },
      });

      // 5. tools/call cairn.scratchpad.delete
      const deleteRes = await client.request('tools/call', {
        name: 'cairn.scratchpad.delete',
        arguments: { key: 'smoke', skip_auto_checkpoint: true },
      });
      const deleteText = (deleteRes.result as any).content[0].text as string;
      expect(JSON.parse(deleteText)).toMatchObject({
        ok: true, key: 'smoke', deleted: true,
      });

      // 6. read after delete returns found=false
      const readAfterRes = await client.request('tools/call', {
        name: 'cairn.scratchpad.read',
        arguments: { key: 'smoke' },
      });
      const readAfterText = (readAfterRes.result as any).content[0].text as string;
      expect(JSON.parse(readAfterText)).toEqual({
        key: 'smoke', found: false, value: null,
      });
    } finally {
      await client.close();
      rmSync(cairnRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
