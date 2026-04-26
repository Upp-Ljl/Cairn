import {
  putScratch, getScratch, listAllScratch,
} from '../../../daemon/dist/storage/repositories/scratchpad.js';
import type { Workspace } from '../workspace.js';

export interface WriteScratchArgs { key: string; content: unknown }
export interface ReadScratchArgs { key: string }

export function toolWriteScratch(ws: Workspace, args: WriteScratchArgs) {
  putScratch(ws.db, ws.blobRoot, { key: args.key, value: args.content });
  return { ok: true, key: args.key };
}

export function toolReadScratch(ws: Workspace, args: ReadScratchArgs) {
  const value = getScratch(ws.db, args.key);
  return { key: args.key, found: value !== null, value };
}

export function toolListScratch(ws: Workspace) {
  return {
    items: listAllScratch(ws.db).map((row) => ({
      key: row.key,
      updated_at: row.updated_at,
      has_value: row.value_json !== null || row.value_path !== null,
    })),
  };
}
