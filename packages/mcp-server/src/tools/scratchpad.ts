import {
  putScratch, getScratch, listAllScratch,
} from '../../../daemon/dist/storage/repositories/scratchpad.js';
import { tryAutoCheckpoint } from './_auto-checkpoint.js';
import type { Workspace } from '../workspace.js';

export interface WriteScratchArgs {
  key: string;
  content: unknown;
  /**
   * Skip the implicit pre-write checkpoint. Default: false (auto-checkpoint runs).
   * Use this when the caller is doing high-frequency scratchpad writes that
   * should not pollute the timeline (e.g. progress notes inside a tight loop).
   */
  skip_auto_checkpoint?: boolean;
}
export interface ReadScratchArgs { key: string }

export function toolWriteScratch(ws: Workspace, args: WriteScratchArgs) {
  // Auto-checkpoint BEFORE the write so the user can rewind to the
  // file-system state at "the moment of intent" — typical agent flow is
  // to write a scratchpad note ("about to refactor X"), then start
  // editing files. The auto-checkpoint anchors a recoverable point
  // right before that work begins.
  const auto_checkpoint_id = args.skip_auto_checkpoint
    ? null
    : tryAutoCheckpoint(ws, `auto:before-scratchpad.write:${args.key}`);

  putScratch(ws.db, ws.blobRoot, { key: args.key, value: args.content });
  return { ok: true, key: args.key, auto_checkpoint_id };
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
      updated_at_iso: new Date(row.updated_at).toISOString(),
      has_value: row.value_json !== null || row.value_path !== null,
    })),
  };
}
