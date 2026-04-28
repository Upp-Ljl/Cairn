import { describe, it, expect } from 'vitest';
import * as daemon from '../src/index.js';

describe('@cairn/daemon public API barrel', () => {
  it('exports openDatabase + ULID + blob helpers', () => {
    expect(typeof daemon.openDatabase).toBe('function');
    expect(typeof daemon.newId).toBe('function');
    expect(typeof daemon.BLOB_THRESHOLD).toBe('number');
    expect(typeof daemon.writeBlobIfLarge).toBe('function');
    expect(typeof daemon.readBlob).toBe('function');
  });

  it('exports migration runner + registry', () => {
    expect(typeof daemon.runMigrations).toBe('function');
    expect(Array.isArray(daemon.ALL_MIGRATIONS)).toBe(true);
    expect(daemon.ALL_MIGRATIONS.length).toBeGreaterThan(0);
  });

  it('exports scratchpad repository', () => {
    expect(typeof daemon.putScratch).toBe('function');
    expect(typeof daemon.getScratch).toBe('function');
    expect(typeof daemon.listAllScratch).toBe('function');
    expect(typeof daemon.deleteScratch).toBe('function');
  });

  it('exports checkpoint repository', () => {
    expect(typeof daemon.createPendingCheckpoint).toBe('function');
    expect(typeof daemon.markCheckpointReady).toBe('function');
    expect(typeof daemon.getCheckpointById).toBe('function');
    expect(typeof daemon.listCheckpoints).toBe('function');
  });

  it('exports git-stash snapshot backend', () => {
    expect(typeof daemon.gitStashSnapshot).toBe('function');
    expect(typeof daemon.gitStashRestore).toBe('function');
    expect(typeof daemon.gitStashAffectedFiles).toBe('function');
    expect(typeof daemon.gitHeadCleanRestore).toBe('function');
    expect(typeof daemon.gitHeadCleanAffectedFiles).toBe('function');
  });

  it('exports type constants from storage/types', () => {
    expect(Array.isArray(daemon.LANE_STATES)).toBe(true);
    expect(Array.isArray(daemon.CHECKPOINT_STATUSES)).toBe(true);
    expect(Array.isArray(daemon.OP_CLASSIFICATIONS)).toBe(true);
    expect(Array.isArray(daemon.COMP_STATUSES)).toBe(true);
  });
});
