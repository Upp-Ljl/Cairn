import { describe, it } from 'vitest';

// 这些导入在 W1-T8/T9/T10 才会真正能 resolve；保留注释以让脚手架就位。
// import { openWorkspace } from '../src/workspace.js';

describe('wedge acceptance — §17.1 7 tools end to end', () => {
  it.todo('cairn.scratchpad.write 持久化 key/value 到 SQLite');
  it.todo('cairn.scratchpad.read 返回先前写入的 value');
  it.todo('cairn.scratchpad.list 列出本会话所有 key');
  it.todo('cairn.checkpoint.create 创建 git-stash 快照并返回 id');
  it.todo('cairn.checkpoint.list 列出已有 checkpoint，按 created_at DESC');
  it.todo('cairn.rewind.preview 返回会被覆盖的文件名清单');
  it.todo('cairn.rewind.to 还原文件到 checkpoint 时刻 + 不动 .git/HEAD（楔期约定）');
  it.todo('完整路径：write→checkpoint→修改文件→rewind→文件复原 + scratchpad 仍在');
});
