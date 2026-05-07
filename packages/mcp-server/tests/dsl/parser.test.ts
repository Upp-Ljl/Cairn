import { describe, it, expect } from 'vitest';
import { parseCriteriaJSON } from '../../src/dsl/parser.js';

describe('parseCriteriaJSON', () => {
  // -------------------------------------------------------------------------
  // Happy paths — one minimum-args valid input per primitive (7 primitives)
  // -------------------------------------------------------------------------

  it('happy: tests_pass — no args required', () => {
    const result = parseCriteriaJSON([{ primitive: 'tests_pass', args: {} }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.criteria[0]?.primitive).toBe('tests_pass');
    expect(result.criteria[0]?.args).toEqual({});
  });

  it('happy: tests_pass — with optional target', () => {
    const result = parseCriteriaJSON([{ primitive: 'tests_pass', args: { target: 'packages/mcp-server' } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.criteria[0]?.primitive).toBe('tests_pass');
    expect((result.criteria[0]?.args as { target?: string }).target).toBe('packages/mcp-server');
  });

  it('happy: command_exits_0 — required cmd only', () => {
    const result = parseCriteriaJSON([{ primitive: 'command_exits_0', args: { cmd: 'echo hello' } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.criteria[0]?.primitive).toBe('command_exits_0');
  });

  it('happy: file_exists — required path', () => {
    const result = parseCriteriaJSON([{ primitive: 'file_exists', args: { path: 'package.json' } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.criteria[0]?.primitive).toBe('file_exists');
  });

  it('happy: regex_matches — required file + pattern', () => {
    const result = parseCriteriaJSON([
      { primitive: 'regex_matches', args: { file: 'src/index.ts', pattern: 'export' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.criteria[0]?.primitive).toBe('regex_matches');
  });

  it('happy: scratchpad_key_exists — required key', () => {
    const result = parseCriteriaJSON([{ primitive: 'scratchpad_key_exists', args: { key: 'my-key' } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.criteria[0]?.primitive).toBe('scratchpad_key_exists');
  });

  it('happy: no_open_conflicts — no args required', () => {
    const result = parseCriteriaJSON([{ primitive: 'no_open_conflicts', args: {} }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.criteria[0]?.primitive).toBe('no_open_conflicts');
  });

  it('happy: checkpoint_created_after — required timestamp', () => {
    const result = parseCriteriaJSON([{ primitive: 'checkpoint_created_after', args: { timestamp: 1716000000000 } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.criteria[0]?.primitive).toBe('checkpoint_created_after');
  });

  // -------------------------------------------------------------------------
  // Bonus: JSON string input vs JS array — both must work
  // -------------------------------------------------------------------------

  it('bonus: raw JSON string is parsed before validation', () => {
    const json = JSON.stringify([{ primitive: 'file_exists', args: { path: 'README.md' } }]);
    const result = parseCriteriaJSON(json);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.criteria[0]?.primitive).toBe('file_exists');
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it('error: raw string that is not JSON → INVALID_JSON', () => {
    const result = parseCriteriaJSON('not json');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some(e => e.includes('INVALID_JSON'))).toBe(true);
  });

  it('error: raw = 42 (not an array) → NOT_AN_ARRAY', () => {
    const result = parseCriteriaJSON(42);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some(e => e.includes('NOT_AN_ARRAY'))).toBe(true);
  });

  it('error: raw = [] (empty array) → EMPTY_CRITERIA', () => {
    const result = parseCriteriaJSON([]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some(e => e.includes('EMPTY_CRITERIA'))).toBe(true);
  });

  it('error: unknown primitive "foo_bar"', () => {
    const result = parseCriteriaJSON([{ primitive: 'foo_bar', args: {} }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some(e => e.includes('UNKNOWN_PRIMITIVE'))).toBe(true);
  });

  it('error: command_exits_0 without required cmd → missing required arg', () => {
    const result = parseCriteriaJSON([{ primitive: 'command_exits_0', args: {} }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some(e => e.includes('command_exits_0') && e.includes('cmd'))).toBe(true);
  });

  it('error: extra top-level key rejected', () => {
    const result = parseCriteriaJSON([{ primitive: 'tests_pass', args: {}, extra: 1 }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some(e => e.includes('UNEXPECTED_KEYS_AT_INDEX_0'))).toBe(true);
    expect(result.errors.some(e => e.includes('extra'))).toBe(true);
  });

  it('error: extra args key rejected', () => {
    const result = parseCriteriaJSON([{ primitive: 'tests_pass', args: { target: '.', evil: true } }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some(e => e.includes('UNEXPECTED_ARGS_KEYS_tests_pass_AT_INDEX_0'))).toBe(true);
    expect(result.errors.some(e => e.includes('evil'))).toBe(true);
  });

  it('error: wrong arg type — tests_pass.target must be string, not number', () => {
    const result = parseCriteriaJSON([{ primitive: 'tests_pass', args: { target: 123 } }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some(e => e.includes('WRONG_TYPE_tests_pass.target_AT_INDEX_0'))).toBe(true);
  });

  it('error: wrong arg type — checkpoint_created_after.timestamp must be number, not string', () => {
    const result = parseCriteriaJSON([{ primitive: 'checkpoint_created_after', args: { timestamp: 'not-a-number' } }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some(e => e.includes('WRONG_TYPE_checkpoint_created_after.timestamp_AT_INDEX_0'))).toBe(true);
  });

  it('error: no_open_conflicts.scope_paths must be array of strings', () => {
    const result = parseCriteriaJSON([{ primitive: 'no_open_conflicts', args: { scope_paths: [1, 2, 3] } }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some(e => e.includes('no_open_conflicts'))).toBe(true);
  });

  it('error: multiple elements — errors accumulated across all elements', () => {
    const result = parseCriteriaJSON([
      { primitive: 'file_exists', args: { path: 'ok.txt' } },    // valid
      { primitive: 'command_exits_0', args: {} },                 // missing cmd
      { primitive: 'foo', args: {} },                             // unknown primitive
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // Should have errors from both element 1 and element 2
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('error: element is null → not an object', () => {
    const result = parseCriteriaJSON([null]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some(e => e.includes('NOT_AN_OBJECT_AT_INDEX_0'))).toBe(true);
  });
});
