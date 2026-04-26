import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeBlobIfLarge, readBlob, BLOB_THRESHOLD } from '../../src/storage/blobs.js';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'cairn-blobs-'));
}

describe('writeBlobIfLarge', () => {
  it('inlines payloads smaller than threshold', () => {
    const root = tmpRoot();
    try {
      const result = writeBlobIfLarge({ hello: 'world' }, root);
      expect(result.json).toBe(JSON.stringify({ hello: 'world' }));
      expect(result.path).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('spills payloads >= threshold to disk under blobs/{ab}/{sha256}', () => {
    const root = tmpRoot();
    try {
      const big = { data: 'x'.repeat(BLOB_THRESHOLD + 1) };
      const result = writeBlobIfLarge(big, root);
      expect(result.json).toBeUndefined();
      expect(result.path).toMatch(/blobs[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}$/);
      expect(existsSync(result.path!)).toBe(true);
      expect(readFileSync(result.path!, 'utf8')).toBe(JSON.stringify(big));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('content-addressed dedup: same content yields same path', () => {
    const root = tmpRoot();
    try {
      const big = { data: 'y'.repeat(BLOB_THRESHOLD + 10) };
      const a = writeBlobIfLarge(big, root);
      const b = writeBlobIfLarge(big, root);
      expect(a.path).toBe(b.path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readBlob', () => {
  it('returns parsed JSON from inline', () => {
    expect(readBlob({ json: '{"a":1}' })).toEqual({ a: 1 });
  });

  it('returns parsed JSON from file', () => {
    const root = tmpRoot();
    try {
      const big = { b: 'z'.repeat(BLOB_THRESHOLD + 1) };
      const r = writeBlobIfLarge(big, root);
      expect(readBlob(r)).toEqual(big);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when both fields are empty', () => {
    expect(readBlob({})).toBeNull();
  });
});
