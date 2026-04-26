import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspace, type Workspace } from '../src/workspace.js';
import {
  toolWriteScratch, toolReadScratch, toolListScratch,
} from '../src/tools/scratchpad.js';

describe('wedge acceptance — §17.1 7 tools end to end', () => {
  let cairnRoot: string;
  let ws: Workspace;

  beforeEach(() => {
    cairnRoot = mkdtempSync(join(tmpdir(), 'cairn-acc-'));
    ws = openWorkspace({ cairnRoot });
  });

  afterEach(() => {
    ws.db.close();
    rmSync(cairnRoot, { recursive: true, force: true });
  });

  // --- scratchpad (3) ---

  it('cairn.scratchpad.write 持久化 key/value 到 SQLite', () => {
    const r = toolWriteScratch(ws, { key: 'note:1', content: { hi: 'there' } });
    expect(r.ok).toBe(true);
    expect(r.key).toBe('note:1');
    // verify by direct DB read
    const row = ws.db.prepare(
      'SELECT key, value_json FROM scratchpad WHERE key = ?'
    ).get('note:1') as { key: string; value_json: string };
    expect(row.key).toBe('note:1');
    expect(JSON.parse(row.value_json)).toEqual({ hi: 'there' });
  });

  it('cairn.scratchpad.read 返回先前写入的 value', () => {
    toolWriteScratch(ws, { key: 'note:1', content: { hi: 'there' } });
    const r = toolReadScratch(ws, { key: 'note:1' });
    expect(r.found).toBe(true);
    expect(r.value).toEqual({ hi: 'there' });

    const missing = toolReadScratch(ws, { key: 'does-not-exist' });
    expect(missing.found).toBe(false);
    expect(missing.value).toBeNull();
  });

  it('cairn.scratchpad.list 列出本会话所有 key', () => {
    toolWriteScratch(ws, { key: 'a', content: 1 });
    toolWriteScratch(ws, { key: 'b', content: 2 });
    toolWriteScratch(ws, { key: 'c', content: 'three' });
    const r = toolListScratch(ws);
    expect(new Set(r.items.map((i) => i.key))).toEqual(new Set(['a', 'b', 'c']));
    // every item should report has_value=true since we wrote real values
    expect(r.items.every((i) => i.has_value)).toBe(true);
  });

  // --- checkpoint + rewind (5 — T10 will fill these in) ---

  it.todo('cairn.checkpoint.create 创建 git-stash 快照并返回 id');
  it.todo('cairn.checkpoint.list 列出已有 checkpoint，按 created_at DESC');
  it.todo('cairn.rewind.preview 返回会被覆盖的文件名清单');
  it.todo('cairn.rewind.to 还原文件到 checkpoint 时刻 + 不动 .git/HEAD（楔期约定）');
  it.todo('完整路径：write→checkpoint→修改文件→rewind→文件复原 + scratchpad 仍在');
});
