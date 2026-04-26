import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BLOB_THRESHOLD = 128 * 1024; // bytes

export interface BlobRef {
  json?: string;
  path?: string;
}

export function writeBlobIfLarge(value: unknown, root: string): BlobRef {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') < BLOB_THRESHOLD) {
    return { json };
  }
  const hash = createHash('sha256').update(json).digest('hex');
  const path = join(root, 'blobs', hash.slice(0, 2), hash);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, json, 'utf8');
  }
  return { path };
}

export function readBlob(ref: BlobRef): unknown | null {
  if (ref.json != null) return JSON.parse(ref.json);
  if (ref.path != null) return JSON.parse(readFileSync(ref.path, 'utf8'));
  return null;
}
