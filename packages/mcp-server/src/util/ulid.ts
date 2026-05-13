/**
 * Minimal monotonic ULID generator for kernel-internal use.
 *
 * 26-character Crockford base-32 string:
 *  - First 10 chars = millisecond timestamp (encoded high-to-low, base-32)
 *  - Last 16 chars  = random bytes via crypto.randomBytes
 *
 * Monotonic guarantee: if Date.now() == _lastTimeMs, the time component is
 * bumped by 1 ms so that two calls within the same millisecond still produce
 * lexicographically ordered ULIDs.
 */

import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let _lastTimeMs = 0;

export function newUlid(): string {
  // Monotonic: bump ms if same or behind last emission
  let now = Date.now();
  if (now <= _lastTimeMs) now = _lastTimeMs + 1;
  _lastTimeMs = now;

  // Encode 10-char timestamp (10 × 5-bit = 50 bits, covers ~35000 years)
  let ts = '';
  let n = now;
  for (let i = 9; i >= 0; i--) {
    ts = (CROCKFORD[n % 32] ?? '0') + ts;
    n = Math.floor(n / 32);
  }

  // Encode 16-char random part from 10 crypto-random bytes
  const rand = randomBytes(10);
  let randPart = '';
  for (let i = 0; i < 16; i++) {
    randPart += CROCKFORD[(rand[i % 10] ?? 0) % 32];
  }

  return ts + randPart;
}
