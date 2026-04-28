/**
 * @cairn/daemon — public API barrel.
 *
 * Workspace consumers (e.g. @cairn/mcp-server) should import from this
 * entry point. Anything not re-exported here is internal and may change
 * without notice. Adding to this list is the explicit way to widen the
 * public API surface.
 */

// storage core
export { openDatabase } from './storage/db.js';
export { newId } from './storage/ids.js';
export {
  BLOB_THRESHOLD,
  writeBlobIfLarge,
  readBlob,
  type BlobRef,
} from './storage/blobs.js';

// migrations
export { runMigrations } from './storage/migrations/runner.js';
export { ALL_MIGRATIONS } from './storage/migrations/index.js';

// repositories
export {
  putScratch,
  getScratch,
  listAllScratch,
  deleteScratch,
  type PutScratchInput,
} from './storage/repositories/scratchpad.js';
export {
  createPendingCheckpoint,
  markCheckpointReady,
  getCheckpointById,
  listCheckpoints,
  type NewCheckpoint,
} from './storage/repositories/checkpoints.js';

// snapshot backend
export {
  gitStashSnapshot,
  gitStashRestore,
  gitStashRestoreFiltered,
  gitStashAffectedFiles,
  gitHeadCleanRestore,
  gitHeadCleanRestoreFiltered,
  gitHeadCleanAffectedFiles,
} from './storage/snapshots/git-stash.js';

// shared types + status enums
export * from './storage/types.js';
