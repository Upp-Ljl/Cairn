import { describe, it, expect } from 'vitest';
import { newId } from '../../src/storage/ids.js';

describe('newId', () => {
  it('returns 26-char ULID', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is monotonically sortable across 100 rapid calls', () => {
    const ids = Array.from({ length: 100 }, () => newId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});
